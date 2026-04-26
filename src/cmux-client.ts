import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export class CmuxError extends Error {
  constructor(message: string, public code?: string, public data?: unknown) {
    super(message)
    this.name = 'CmuxError'
  }
}

export interface Workspace {
  index: number
  id: string
  title: string
  selected: boolean
}

export interface Surface {
  index: number
  id: string
  focused: boolean
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RpcResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; data?: unknown }
}

const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library/Application Support/cmux')
const STABLE_SOCKET_PATH = path.join(APP_SUPPORT_DIR, 'cmux.sock')
const LEGACY_STABLE_SOCKET_PATH = '/tmp/cmux.sock'
const LAST_SOCKET_PATH_FILES = [
  path.join(APP_SUPPORT_DIR, 'last-socket-path'),
  '/tmp/cmux-last-socket-path',
]

function readLastSocketPath(): string | null {
  for (const markerPath of LAST_SOCKET_PATH_FILES) {
    try {
      const content = fs.readFileSync(markerPath, 'utf-8').trim()
      if (content) return content
    } catch {
      continue
    }
  }
  return null
}

function discoverSocketPath(): string {
  const override = process.env.CMUX_SOCKET_PATH || process.env.CMUX_SOCKET
  if (override) {
    if (fs.existsSync(override)) return override
    if (override !== STABLE_SOCKET_PATH && override !== LEGACY_STABLE_SOCKET_PATH) return override
  }

  const lastSocket = readLastSocketPath()
  if (lastSocket && fs.existsSync(lastSocket)) return lastSocket

  const candidates = ['/tmp/cmux-debug.sock', STABLE_SOCKET_PATH, LEGACY_STABLE_SOCKET_PATH]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }

  // Discover debug sockets
  const discovered: string[] = []
  try {
    const tmpFiles = fs.readdirSync('/tmp')
    for (const f of tmpFiles) {
      if (f.startsWith('cmux-debug') && f.endsWith('.sock')) {
        discovered.push(path.join('/tmp', f))
      }
    }
  } catch { /* ignore */ }
  try {
    const appFiles = fs.readdirSync(APP_SUPPORT_DIR)
    for (const f of appFiles) {
      if (f.startsWith('cmux') && f.endsWith('.sock')) {
        discovered.push(path.join(APP_SUPPORT_DIR, f))
      }
    }
  } catch { /* ignore */ }

  if (discovered.length > 0) {
    discovered.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
      } catch {
        return 0
      }
    })
    return discovered[0]
  }

  return candidates[0]
}

export interface CmuxClientOptions {
  socketPath?: string
  requestTimeout?: number
  reconnect?: boolean
  reconnectMaxDelay?: number
  pingInterval?: number
}

export interface CreateWorkspaceOptions {
  title?: string
  cwd?: string
  workingDirectory?: string
  windowId?: string
  initialCommand?: string
  initialEnv?: Record<string, string>
  description?: string
}

export class CmuxClient extends EventEmitter {
  private socketPath: string
  private socket: net.Socket | null = null
  private recvBuffer = ''
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private connected = false
  private requestTimeout: number
  private shouldReconnect: boolean
  private reconnectMaxDelay: number
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingInterval: number
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private disconnecting = false

  constructor(options: CmuxClientOptions = {}) {
    super()
    this.socketPath = options.socketPath || discoverSocketPath()
    this.requestTimeout = options.requestTimeout ?? 20_000
    this.shouldReconnect = options.reconnect ?? true
    this.reconnectMaxDelay = options.reconnectMaxDelay ?? 30_000
    this.pingInterval = options.pingInterval ?? 30_000
  }

  async connect(): Promise<void> {
    if (this.connected) return
    this.disconnecting = false

    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(this.socketPath)

      sock.on('connect', () => {
        this.socket = sock
        this.connected = true
        this.reconnectAttempt = 0
        this.recvBuffer = ''
        this.startPing()
        this.emit('connected')
        resolve()
      })

      sock.on('data', (chunk: Buffer) => {
        this.recvBuffer += chunk.toString('utf-8')
        this.processBuffer()
      })

      sock.on('error', (err: NodeJS.ErrnoException) => {
        if (!this.connected) {
          this.disconnecting = true
          sock.destroy()
          reject(new CmuxError(this.formatConnectionError(err), err.code))
        } else {
          this.emit('error', err)
        }
      })

      sock.on('close', () => {
        const wasConnected = this.connected
        this.handleDisconnect()
        if (wasConnected && !this.disconnecting) {
          this.emit('disconnected')
          this.scheduleReconnect()
        }
      })
    })
  }

  disconnect(): void {
    this.disconnecting = true
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this.handleDisconnect()
  }

  isConnected(): boolean {
    return this.connected
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.connected || !this.socket) {
      throw new CmuxError('Not connected')
    }

    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params }) + '\n'

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CmuxError(`Request timed out: ${method}`))
      }, this.requestTimeout)

      this.pending.set(id, { resolve, reject, timer })
      this.socket!.write(payload, 'utf-8')
    })
  }

  // -- Convenience methods --

  async ping(): Promise<boolean> {
    const res = await this.call('system.ping') as { pong?: boolean } | null
    return !!res?.pong
  }

  async identify(): Promise<Record<string, unknown>> {
    return (await this.call('system.identify') as Record<string, unknown>) ?? {}
  }

  async createWorkspace(options: CreateWorkspaceOptions = {}): Promise<{ workspace_id: string }> {
    const params: Record<string, unknown> = {}
    if (options.title) params.title = options.title
    if (options.cwd) params.cwd = options.cwd
    if (options.workingDirectory) params.working_directory = options.workingDirectory
    if (options.windowId) params.window_id = options.windowId
    if (options.initialCommand) params.initial_command = options.initialCommand
    if (options.initialEnv) params.initial_env = options.initialEnv
    if (options.description) params.description = options.description
    const res = await this.call('workspace.create', params) as { workspace_id: string }
    return res
  }

  async listWorkspaces(windowId?: string): Promise<Workspace[]> {
    const params: Record<string, unknown> = {}
    if (windowId) params.window_id = windowId
    const res = await this.call('workspace.list', params) as { workspaces: Array<Record<string, unknown>> } | null
    return (res?.workspaces ?? []).map(w => ({
      index: Number(w.index ?? 0),
      id: String(w.id),
      title: String(w.title ?? ''),
      selected: Boolean(w.selected),
    }))
  }

  async selectWorkspace(workspaceId: string): Promise<void> {
    await this.call('workspace.select', { workspace_id: workspaceId })
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<void> {
    await this.call('workspace.rename', { workspace_id: workspaceId, title })
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.call('workspace.close', { workspace_id: workspaceId })
  }

  async listSurfaces(workspaceId?: string): Promise<Surface[]> {
    const params: Record<string, unknown> = {}
    if (workspaceId) params.workspace_id = workspaceId
    const res = await this.call('surface.list', params) as { surfaces: Array<Record<string, unknown>> } | null
    return (res?.surfaces ?? []).map(s => ({
      index: Number(s.index ?? 0),
      id: String(s.id),
      focused: Boolean(s.focused),
    }))
  }

  async sendText(surfaceId: string, text: string): Promise<void> {
    await this.call('surface.send_text', { surface_id: surfaceId, text })
  }

  async sendKey(surfaceId: string, key: string): Promise<void> {
    await this.call('surface.send_key', { surface_id: surfaceId, key })
  }

  async readText(surfaceId?: string, lines?: number): Promise<string> {
    const params: Record<string, unknown> = {}
    if (surfaceId) params.surface_id = surfaceId
    if (lines != null) {
      params.lines = lines
      params.scrollback = true
    }
    const res = await this.call('surface.read_text', params) as { text?: string; base64?: string } | null
    if (res?.text != null) return res.text
    if (res?.base64) return Buffer.from(res.base64, 'base64').toString('utf-8')
    return ''
  }

  async setStatus(key: string, value: string): Promise<void> {
    throw new CmuxError(`setStatus is not supported by cmux v2 (${key}=${value})`, 'unsupported')
  }

  async notify(title: string, body?: string): Promise<void> {
    const params: Record<string, unknown> = { title }
    if (body) params.body = body
    await this.call('notification.create', params)
  }

  async getTree(): Promise<unknown> {
    return await this.call('system.tree')
  }

  // -- Internal --

  private formatConnectionError(err: NodeJS.ErrnoException): string {
    const socketInfo = `(socket: ${this.socketPath})`
    switch (err.code) {
      case 'ENOENT':
        return `cmux is not running. Start cmux first, then retry. ${socketInfo}`
      case 'ECONNREFUSED':
        return `cmux socket found but connection refused. Try restarting cmux. ${socketInfo}`
      case 'EACCES':
        return `Permission denied connecting to cmux socket. Check file permissions. ${socketInfo}`
      case 'ETIMEDOUT':
        return `Connection to cmux timed out. ${socketInfo}`
      case 'ECONNRESET':
        return `cmux closed the connection unexpectedly. It may be restarting — retry shortly. ${socketInfo}`
      default:
        return `Failed to connect to cmux: ${err.message} ${socketInfo}`
    }
  }

  private processBuffer(): void {
    while (true) {
      const newlineIdx = this.recvBuffer.indexOf('\n')
      if (newlineIdx === -1) break

      const line = this.recvBuffer.slice(0, newlineIdx)
      this.recvBuffer = this.recvBuffer.slice(newlineIdx + 1)

      if (!line.trim()) continue

      let resp: RpcResponse
      try {
        resp = JSON.parse(line)
      } catch {
        this.emit('error', new CmuxError(`Invalid JSON response: ${line.slice(0, 200)}`))
        continue
      }

      const pending = this.pending.get(resp.id)
      if (!pending) continue

      this.pending.delete(resp.id)
      clearTimeout(pending.timer)

      if (resp.ok) {
        pending.resolve(resp.result)
      } else {
        const err = resp.error ?? { code: 'error', message: 'Unknown error' }
        const cmuxErr = new CmuxError(
          err.data != null ? `${err.code}: ${err.message} (${err.data})` : `${err.code}: ${err.message}`,
          err.code,
          err.data,
        )
        pending.reject(cmuxErr)
      }
    }
  }

  private handleDisconnect(): void {
    this.connected = false
    this.stopPing()
    // Reject all pending requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new CmuxError('Socket closed'))
      this.pending.delete(id)
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect || this.disconnecting) return

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxDelay,
    )
    this.reconnectAttempt++

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
        this.emit('reconnected')
      } catch {
        this.scheduleReconnect()
      }
    }, delay)
  }

  private startPing(): void {
    if (this.pingInterval <= 0) return
    this.pingTimer = setInterval(async () => {
      try {
        await this.ping()
      } catch {
        // ping failure handled by socket close event
      }
    }, this.pingInterval)
    this.pingTimer.unref()
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}
