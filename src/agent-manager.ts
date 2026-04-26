import { randomUUID } from 'crypto';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from './fs-utils.js';
import { EventEmitter } from 'events';
import type { Action, Agent, AgentCli, AgentStatus, AgentTreeNode, ManagedWorkspace } from './types.js';
import { LayoutTracker } from './layout-tracker.js';

export const MAX_DEPTH = 3;
export const MAX_CHILDREN = 5;
import { getAgentConfig } from './config.js';
import { DEFAULT_BASE_PATH, buildEnhancedPrompt, loadCulture } from './prompt-builder.js';
import type { HierarchyContext } from './prompt-builder.js';
import { buildAgentCommand, extractSessionIdFromText, splitArgString } from './cli-adapter.js';
import { getProjectConfig } from './config-loader.js';
import { resolveConnections } from './edge-resolver.js';

export interface AgentManagerOptions {
  basePath?: string;
}

export interface SpawnOptions {
  parentId?: string;
  roleId?: string;
  model?: string;
  taskId?: string;
}

export interface CmuxClientLike {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  createWorkspace(options?: { title?: string; cwd?: string; initialCommand?: string }): Promise<{ workspace_id: string }>;
  listSurfaces(workspaceId: string): Promise<Array<{ id: string; index: number; focused: boolean }>>;
  sendText(surfaceId: string, text: string): Promise<void>;
  sendKey?(surfaceId: string, key: string): Promise<void>;
  readText(surfaceId: string, lines?: number): Promise<string>;
  closeWorkspace(workspaceId: string): Promise<void>;
  renameWorkspace(workspaceId: string, title: string): Promise<void>;
}

export interface FileProtocolLike {
  initAgentDir(agentId: string): void;
  writeInbox(agentId: string, content: string): void;
  writeInboxFresh(agentId: string, content: string): void;
  cleanupAgentDir(agentId: string): void;
}

export class AgentManager extends EventEmitter {
  private agents = new Map<string, Agent>();
  private workspaces = new Map<string, ManagedWorkspace>();
  private rateLimitTimers = new Map<string, NodeJS.Timeout>();
  private cmux: CmuxClientLike;
  private files: FileProtocolLike;
  private basePath: string;
  private agentsFile: string;
  private workspacesFile: string;
  private agentsDir: string;
  private layout = new LayoutTracker();

  constructor(cmux: CmuxClientLike, files: FileProtocolLike, options: AgentManagerOptions = {}) {
    super();
    this.cmux = cmux;
    this.files = files;
    this.basePath = options.basePath ?? DEFAULT_BASE_PATH;
    this.agentsFile = join(this.basePath, 'agents.json');
    this.workspacesFile = join(this.basePath, 'workspaces.json');
    this.agentsDir = join(this.basePath, 'agents');
    mkdirSync(this.basePath, { recursive: true });
    mkdirSync(this.agentsDir, { recursive: true });
  }

  // ── Workspace management ────────────────────────────

  async createManagedWorkspace(name: string, cwd?: string): Promise<ManagedWorkspace> {
    const existing = this.findWorkspaceByName(name);
    if (existing) {
      throw new Error(`Workspace "${name}" already exists`);
    }

    const effectiveCwd = cwd ?? process.cwd();
    const { workspace_id } = await this.cmux.createWorkspace({
      title: name,
      cwd: effectiveCwd,
    });

    const ws: ManagedWorkspace = {
      id: randomUUID(),
      name,
      workspaceId: workspace_id,
      agentIds: [],
      cwd: effectiveCwd,
    };

    this.workspaces.set(ws.id, ws);
    this.persistWorkspaces();
    this.emit('workspace_created', ws);
    return ws;
  }

  async spawnInWorkspace(
    workspaceName: string,
    agentName: string,
    cli: string,
    prompt: string,
    direction?: 'right' | 'down',
    options: SpawnOptions = {},
  ): Promise<Agent> {
    const ws = this.findWorkspaceByName(workspaceName);
    if (!ws) throw new Error(`Workspace "${workspaceName}" not found`);

    this.reclaimNameOrThrow(agentName);

    const config = getAgentConfig(cli);
    this.validateConfig(config);

    const depth = this.resolveParentDepth(options.parentId);

    const id = randomUUID();
    const agent: Agent = {
      id,
      name: agentName,
      cli: cli as AgentCli,
      workspaceId: ws.workspaceId,
      surfaceId: '',
      status: 'working',
      taskSentAt: Date.now(),
      cwd: ws.cwd,
      lastPrompt: prompt,
      parentId: options.parentId,
      childIds: [],
      depth,
      roleId: options.roleId,
      model: options.model,
    };

    this.files.initAgentDir(id);
    this.files.writeInboxFresh(id, this.buildAgentPrompt(agent, prompt));

    // Split a new pane in the workspace using layout-aware logic
    let surfaceId: string;
    if (ws.agentIds.length === 0) {
      // First agent — use the existing surface and init layout tracking
      const surfaces = await this.cmux.listSurfaces(ws.workspaceId);
      if (surfaces.length === 0) throw new Error(`No surfaces in workspace ${ws.workspaceId}`);
      surfaceId = surfaces[0].id;
      this.layout.initWorkspace(ws.workspaceId, surfaceId);
    } else {
      // Additional agent — use layout tracker to find optimal split
      const computed = this.layout.computeSplit(ws.workspaceId);
      const splitFrom = computed.surfaceId;
      const effectiveDirection = direction ?? computed.direction;

      const splitResult = await this.cmux.call(
        'surface.split',
        { surface_id: splitFrom, direction: effectiveDirection },
      ) as { surface_id: string };
      surfaceId = splitResult.surface_id;

      // Record the split in the layout tracker
      this.layout.recordSplit(ws.workspaceId, splitFrom, surfaceId, effectiveDirection);
    }

    agent.surfaceId = surfaceId;

    // Send CLI command
    const inboxPath = join(this.agentsDir, id, 'inbox.md');
    const cmd = this.buildCommand(config, agent, inboxPath);
    try {
      await this.cmux.sendText(surfaceId, cmd + '\n');
    } catch (err) {
      this.files.cleanupAgentDir(id);
      throw new Error(`Failed to send command: ${(err as Error).message}`);
    }

    // Register
    this.agents.set(id, agent);
    ws.agentIds.push(id);

    // Link to parent
    if (options.parentId) {
      const parent = this.agents.get(options.parentId);
      if (parent) parent.childIds.push(id);
    }

    this.persistState();
    this.persistWorkspaces();
    this.emit('spawned', agent);

    return agent;
  }

  listWorkspaces(): ManagedWorkspace[] {
    return Array.from(this.workspaces.values());
  }

  findWorkspaceByName(name: string): ManagedWorkspace | undefined {
    for (const ws of this.workspaces.values()) {
      if (ws.name === name) return ws;
    }
    return undefined;
  }

  getWorkspaceAgents(workspaceName: string): Agent[] {
    const ws = this.findWorkspaceByName(workspaceName);
    if (!ws) return [];
    return ws.agentIds.map(id => this.agents.get(id)).filter((a): a is Agent => a !== undefined);
  }

  async cleanupStaleWorkspaces(): Promise<void> {
    let changed = false;
    for (const ws of [...this.workspaces.values()]) {
      try {
        await this.cmux.listSurfaces(ws.workspaceId);
      } catch {
        console.warn(`[agent-manager] Managed workspace "${ws.name}" (${ws.workspaceId}) gone, removing`);
        for (const agentId of ws.agentIds) {
          this.agents.delete(agentId);
        }
        for (const [id, agent] of this.agents) {
          if (agent.workspaceId === ws.workspaceId) {
            this.agents.delete(id);
          }
        }
        this.workspaces.delete(ws.id);
        changed = true;
      }
    }
    if (changed) {
      this.persistState();
      this.persistWorkspaces();
    }
  }

  private persistWorkspaces(): void {
    atomicWriteJson(this.workspacesFile, Array.from(this.workspaces.values()));
  }

  async spawn(name: string, cli: string, prompt: string, cwd?: string, options: SpawnOptions = {}): Promise<Agent> {
    this.reclaimNameOrThrow(name);

    const config = getAgentConfig(cli);
    this.validateConfig(config);

    const effectiveCwd = cwd ?? process.cwd();

    const depth = this.resolveParentDepth(options.parentId);

    // 1. Create agent record and files first, so workspace.create can launch
    // the initial command with a prompt file that already exists.
    const id = randomUUID();
    const agent: Agent = {
      id,
      name,
      cli: cli as AgentCli,
      workspaceId: '',
      surfaceId: '',
      status: 'working',
      taskSentAt: Date.now(),
      cwd: effectiveCwd,
      lastPrompt: prompt,
      parentId: options.parentId,
      childIds: [],
      depth,
      roleId: options.roleId,
      model: options.model,
    };

    this.files.initAgentDir(id);
    this.files.writeInboxFresh(id, this.buildAgentPrompt(agent, prompt));

    // 2. Create cmux workspace (without initial command to avoid timing issues)
    const { workspace_id } = await this.cmux.createWorkspace({
      title: name,
      cwd: effectiveCwd,
    });

    // 3. Get surface with a readiness wait
    const surfaceId = await this.waitForFirstSurface(workspace_id);
    agent.workspaceId = workspace_id;
    agent.surfaceId = surfaceId;

    // 4. Send CLI command to the surface
    const inboxPath = join(this.agentsDir, id, 'inbox.md');
    const cmd = this.buildCommand(config, agent, inboxPath);
    try {
      await this.cmux.sendText(surfaceId, cmd + '\n');
    } catch (err) {
      // Workspace may have died between creation and sendText
      this.files.cleanupAgentDir(id);
      throw new Error(`Failed to send command to surface ${surfaceId}: ${(err as Error).message}`);
    }

    // 5. Verify workspace is still alive after command injection
    try {
      await this.cmux.readText(surfaceId, 1);
    } catch {
      this.files.cleanupAgentDir(id);
      throw new Error(`Workspace died immediately after command send for agent "${name}"`);
    }

    // 6. Register
    this.agents.set(id, agent);

    // Link to parent
    if (options.parentId) {
      const parent = this.agents.get(options.parentId);
      if (parent) parent.childIds.push(id);
    }

    this.persistState();
    this.emit('spawned', agent);

    return agent;
  }

  async kill(agentId: string, cascade: boolean = true): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    // Cascade: kill children first (deepest first via recursion)
    if (cascade && agent.childIds.length > 0) {
      for (const childId of [...agent.childIds]) {
        await this.kill(childId, true);
      }
    }

    // Clear any pending rate-limit resume timer
    const rateLimitTimer = this.rateLimitTimers.get(agentId);
    if (rateLimitTimer) {
      clearTimeout(rateLimitTimer);
      this.rateLimitTimers.delete(agentId);
    }

    // Remove from parent's childIds
    if (agent.parentId) {
      const parent = this.agents.get(agent.parentId);
      if (parent) {
        parent.childIds = parent.childIds.filter(id => id !== agentId);
      }
    }

    // Send Ctrl-C to stop the CLI process
    try {
      if (this.cmux.sendKey) {
        await this.cmux.sendKey(agent.surfaceId, 'ctrl-c');
      } else {
        await this.cmux.sendText(agent.surfaceId, '\x03');
      }
    } catch { /* surface may already be gone */ }

    // Remove agent from managed workspace if applicable
    const ws = this.findWorkspaceForAgent(agentId);
    if (ws) {
      ws.agentIds = ws.agentIds.filter(id => id !== agentId);
      if (ws.agentIds.length === 0) {
        this.workspaces.delete(ws.id);
        this.emit('managed_workspace_removed', ws);
      }
      this.persistWorkspaces();
    }

    // Only close workspace if this agent owns it exclusively (1:1 spawn mode)
    // or if it's the last agent in a managed workspace
    const othersInWorkspace = this.getAgentsInCmuxWorkspace(agent.workspaceId)
      .filter(a => a.id !== agentId);

    if (othersInWorkspace.length === 0) {
      // No other agents — close the workspace and remove layout
      this.layout.removeWorkspace(agent.workspaceId);
      try {
        await this.cmux.closeWorkspace(agent.workspaceId);
      } catch { /* workspace may already be gone */ }
    } else {
      // Other agents share this workspace — close pane and update layout
      this.layout.removeSurface(agent.workspaceId, agent.surfaceId);
      try {
        await this.cmux.call('surface.close', { surface_id: agent.surfaceId });
      } catch { /* surface may already be gone */ }
    }

    this.files.cleanupAgentDir(agentId);
    const agentName = agent.name;
    agent.status = 'dead';
    this.agents.delete(agentId);
    this.persistState();
    this.emit('killed', agentId, agentName);
  }

  private findWorkspaceForAgent(agentId: string): ManagedWorkspace | undefined {
    for (const ws of this.workspaces.values()) {
      if (ws.agentIds.includes(agentId)) return ws;
    }
    return undefined;
  }

  private getAgentsInCmuxWorkspace(workspaceId: string): Agent[] {
    return Array.from(this.agents.values()).filter(a => a.workspaceId === workspaceId);
  }

  async assignTask(agentId: string, prompt: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    if (agent.status === 'working') {
      throw new Error(`Agent ${agentId} is already working. Wait for completion or kill first.`);
    }
    if (agent.status === 'dead') {
      throw new Error(`Agent ${agentId} is dead. Spawn a new agent.`);
    }

    const config = getAgentConfig(agent.cli);

    this.files.writeInboxFresh(agentId, this.buildAgentPrompt(agent, prompt));
    const inboxPath = join(this.agentsDir, agentId, 'inbox.md');
    const cmd = this.buildCommand(config, agent, inboxPath);
    await this.cmux.sendText(agent.surfaceId, cmd + '\n');

    agent.status = 'working';
    agent.taskSentAt = Date.now();
    agent.lastPrompt = prompt;
    this.persistState();
    this.emit('task_assigned', agentId, prompt);
  }

  /**
   * Resume an idle agent with a new message.
   * If the agent is idle, re-launches the CLI (with --resume if supported).
   * If the agent is working, appends to inbox (best-effort).
   * Returns true if the agent was resumed (re-launched).
   */
  async resumeWithMessage(agentId: string, message: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    if (agent.status === 'dead') return false;

    if (agent.status === 'working') {
      // Agent is running — just append to inbox, it may pick it up
      this.files.writeInbox(agentId, message);
      return false;
    }

    // Agent is idle (or rate-limited) — re-launch with the message
    try {
      await this.assignTask(agentId, message);
      return true;
    } catch (err) {
      console.error(`[agent-manager] Failed to resume ${agent.name}: ${(err as Error).message}`);
      // Fallback: just append to inbox
      this.files.writeInbox(agentId, message);
      return false;
    }
  }

  list(): Agent[] {
    return Array.from(this.agents.values());
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  findByName(name: string): Agent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.name === name) return agent;
    }
    return undefined;
  }

  setStatus(agentId: string, status: AgentStatus): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const prev = agent.status;
    agent.status = status;
    if (status !== prev) {
      this.persistState();
      this.emit('status_changed', agentId, status, prev);
    }
  }

  handleRateLimit(agentId: string, resumeAt: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.setStatus(agentId, 'rate-limited');

    // Clear any existing timer for this agent
    const existing = this.rateLimitTimers.get(agentId);
    if (existing) {
      clearTimeout(existing);
    }

    const delay = Math.max(0, resumeAt - Date.now());
    const timer = setTimeout(() => {
      this.rateLimitTimers.delete(agentId);
      const current = this.agents.get(agentId);
      if (!current || current.status !== 'rate-limited') return;

      if (current.lastPrompt) {
        this.assignTask(agentId, current.lastPrompt).catch((err) => {
          console.error(`[agent-manager] Failed to auto-resume ${agentId}:`, err);
          this.setStatus(agentId, 'dead');
        });
      } else {
        this.setStatus(agentId, 'idle');
      }
    }, delay);
    this.rateLimitTimers.set(agentId, timer);
  }

  async retryTask(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    if (!agent.lastPrompt) {
      throw new Error(`No previous prompt to retry for agent ${agentId}`);
    }

    // Reset status so assignTask doesn't reject
    agent.status = 'idle';
    await this.assignTask(agentId, agent.lastPrompt);
  }

  markLastAction(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastActionAt = Date.now();
    }
  }

  handleStreamText(agentId: string, text: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || !text.trim()) return;

    const sessionId = extractSessionIdFromText(text);
    if (sessionId && sessionId !== agent.sessionId) {
      const previous = agent.sessionId;
      agent.sessionId = sessionId;
      this.persistState();
      this.emit('session_changed', agentId, sessionId, previous);
    }
  }

  handleActions(agentId: string, actions: Action[]): void {
    const agent = this.agents.get(agentId);
    if (!agent || actions.length === 0) return;

    agent.lastActionAt = Date.now();
    let changed = false;
    let previousStatus: AgentStatus | null = null;

    for (const action of actions) {
      switch (action.action) {
        case 'done':
          if (agent.status !== 'idle') {
            previousStatus ??= agent.status;
            agent.status = 'idle';
            changed = true;
            // Notify parent of child completion and auto-resume if idle
            if (agent.parentId) {
              const parent = this.agents.get(agent.parentId);
              if (parent && parent.status !== 'dead') {
                const summary = (action as { summary?: string }).summary ?? '';
                const message = `\n\n## Child Agent "${agent.name}" Completed\n\n${summary}\n`;
                // Auto-resume parent if idle, otherwise just append to inbox
                this.resumeWithMessage(parent.id, message).catch(err => {
                  console.error(`[agent-manager] Failed to auto-resume parent ${parent.name}: ${(err as Error).message}`);
                });
                this.emit('child_completed', { parentId: parent.id, childId: agent.id, summary });
              }
            }
          }
          break;
        case 'error':
          if (agent.status !== 'dead') {
            previousStatus ??= agent.status;
            agent.status = 'dead';
            changed = true;
          }
          break;
        case 'status':
        case 'message':
        case 'spawn':
          changed = true;
          break;
        default:
          changed = true;
          break;
      }
    }

    if (changed) {
      this.persistState();
      this.emit('actions', agentId, actions);
      if (previousStatus && previousStatus !== agent.status) {
        this.emit('status_changed', agentId, agent.status, previousStatus);
      }
    }
  }

  // ── Shared spawn helpers ──

  /**
   * If an agent with the given name exists and is dead, clean it up to allow name reuse.
   * Throws if the name is taken by a non-dead agent.
   */
  /** Validate agent name for safety (used in file paths and workspace titles). */
  private validateAgentName(name: string): void {
    if (!name || name.trim().length === 0) {
      throw new Error('Agent name cannot be empty');
    }
    if (name.length > 100) {
      throw new Error('Agent name cannot exceed 100 characters');
    }
    // Reject path traversal and filesystem-unsafe characters
    if (/[\/\\:\x00]/.test(name) || name === '.' || name === '..') {
      throw new Error(`Agent name "${name}" contains invalid characters`);
    }
  }

  private reclaimNameOrThrow(name: string): void {
    this.validateAgentName(name);
    const existing = this.findByName(name);
    if (!existing) return;
    if (existing.status === 'dead') {
      this.agents.delete(existing.id);
      this.files.cleanupAgentDir(existing.id);
      this.persistState();
    } else {
      throw new Error(`Agent "${name}" already exists (id: ${existing.id})`);
    }
  }

  /**
   * Validate parent hierarchy constraints and return the computed depth.
   */
  private resolveParentDepth(parentId?: string): number {
    if (!parentId) return 0;
    const parent = this.agents.get(parentId);
    if (!parent) throw new Error(`Parent agent "${parentId}" not found`);
    const depth = parent.depth + 1;
    if (depth > MAX_DEPTH) throw new Error(`Max agent depth (${MAX_DEPTH}) exceeded`);
    if (parent.childIds.length >= MAX_CHILDREN) throw new Error(`Max children (${MAX_CHILDREN}) for agent "${parent.name}" exceeded`);
    return depth;
  }

  // ── Tree queries ──

  getRoots(): Agent[] {
    return Array.from(this.agents.values()).filter(a => !a.parentId);
  }

  getChildren(agentId: string): Agent[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    return agent.childIds
      .map(id => this.agents.get(id))
      .filter((a): a is Agent => a !== undefined);
  }

  getAncestors(agentId: string): Agent[] {
    const result: Agent[] = [];
    let current = this.agents.get(agentId);
    while (current?.parentId) {
      const parent = this.agents.get(current.parentId);
      if (!parent) break;
      result.push(parent);
      current = parent;
    }
    return result;
  }

  getAllDescendants(agentId: string): Agent[] {
    const result: Agent[] = [];
    const collect = (id: string) => {
      const agent = this.agents.get(id);
      if (!agent) return;
      for (const childId of agent.childIds) {
        const child = this.agents.get(childId);
        if (child) {
          result.push(child);
          collect(childId);
        }
      }
    };
    collect(agentId);
    return result;
  }

  getTree(agentId?: string): AgentTreeNode[] {
    const buildNode = (agent: Agent): AgentTreeNode => ({
      agent,
      children: agent.childIds
        .map(id => this.agents.get(id))
        .filter((a): a is Agent => a !== undefined)
        .map(buildNode),
    });

    if (agentId) {
      const agent = this.agents.get(agentId);
      if (!agent) return [];
      return [buildNode(agent)];
    }

    return this.getRoots().map(buildNode);
  }

  persistState(): void {
    atomicWriteJson(this.agentsFile, Array.from(this.agents.values()));
  }

  async restoreState(): Promise<void> {
    // Restore workspaces
    if (existsSync(this.workspacesFile)) {
      try {
        const wsData: ManagedWorkspace[] = JSON.parse(readFileSync(this.workspacesFile, 'utf8'));
        for (const ws of wsData) {
          this.workspaces.set(ws.id, ws);
        }
      } catch {
        console.warn('[agent-manager] Failed to parse workspaces.json');
      }
    }

    // Restore agents
    if (!existsSync(this.agentsFile)) return;

    let data: Agent[];
    try {
      data = JSON.parse(readFileSync(this.agentsFile, 'utf8'));
    } catch {
      console.warn('[agent-manager] Failed to parse agents.json, starting fresh');
      return;
    }

    const deadIds = new Set<string>();
    for (const agent of data) {
      // Ensure hierarchy fields exist (backward compat)
      agent.childIds ??= [];
      agent.depth ??= 0;

      try {
        await this.cmux.readText(agent.surfaceId, 1);
        this.agents.set(agent.id, agent);
      } catch {
        console.warn(`[agent-manager] Agent ${agent.name} (${agent.id}) workspace gone, skipping`);
        agent.status = 'dead';
        deadIds.add(agent.id);
        // Remove from managed workspace
        for (const ws of this.workspaces.values()) {
          ws.agentIds = ws.agentIds.filter(id => id !== agent.id);
        }
      }
    }

    // Orphan recovery: if parent is dead/missing, promote children to root
    if (deadIds.size > 0) {
      for (const agent of this.agents.values()) {
        if (agent.parentId && (deadIds.has(agent.parentId) || !this.agents.has(agent.parentId))) {
          console.warn(`[agent-manager] Orphan "${agent.name}" promoted to root (parent gone)`);
          agent.parentId = undefined;
          agent.depth = 0;
        }
        // Clean up childIds referencing dead agents
        agent.childIds = agent.childIds.filter(id => this.agents.has(id));
      }
      this.persistState();
      this.persistWorkspaces();
    }

    await this.cleanupStaleWorkspaces();

    this.emit('restored', this.list());
  }

  /** Get the stream.jsonl path for an agent (if stream-json is supported) */
  getStreamPath(agentId: string): string {
    return join(this.agentsDir, agentId, 'stream.jsonl');
  }

  private buildHierarchyContext(agent: Agent): HierarchyContext {
    const siblings: string[] = [];
    if (agent.parentId) {
      const parent = this.agents.get(agent.parentId);
      if (parent) {
        siblings.push(...parent.childIds
          .filter(id => id !== agent.id)
          .map(id => this.agents.get(id)?.name)
          .filter((n): n is string => !!n));
      }
    }
    return {
      parentName: agent.parentId ? this.agents.get(agent.parentId)?.name : undefined,
      siblings,
      childNames: agent.childIds.map(id => this.agents.get(id)?.name).filter((n): n is string => !!n),
      depth: agent.depth,
      maxDepth: MAX_DEPTH,
    };
  }

  private buildAgentPrompt(agent: Agent, task: string): string {
    // Look up role config if agent has a roleId
    const roleConfig = agent.roleId
      ? getProjectConfig().agents.roles.find(r => r.id === agent.roleId)
      : undefined;

    // Pre-load culture once (avoid repeated file I/O per agent)
    const cultureContent = loadCulture(this.basePath) ?? undefined;

    // Build feedback context
    const config = getProjectConfig();
    const teamAgents = this.list();
    const workingCount = teamAgents.filter(a => a.status === 'working').length;
    const idleCount = teamAgents.filter(a => a.status === 'idle').length;

    // Resolve edge-based connections
    const resolved = resolveConnections(config, agent.name);
    const connections = (resolved.upstream.length > 0 || resolved.downstream.length > 0)
      ? { upstream: resolved.upstream, downstream: resolved.downstream }
      : undefined;

    return buildEnhancedPrompt(agent, task, {
      basePath: this.basePath,
      hierarchy: this.buildHierarchyContext(agent),
      role: roleConfig,
      cultureContent,
      connections,
      feedback: {
        status: `You are agent "${agent.name}" (${agent.cli}). Team: ${teamAgents.length} agents (${workingCount} working, ${idleCount} idle).`,
        context: agent.roleId
          ? `Role: ${agent.roleId}. ${roleConfig?.description ?? ''}`
          : `General-purpose agent.`,
        nextAction: 'Read the task below, execute it, then write a done/error action.',
      },
    });
  }

  private buildCommand(config: ReturnType<typeof getAgentConfig>, agent: Agent, inboxPath: string): string {
    return buildAgentCommand({
      config,
      agent,
      inboxPath,
      streamPath: config.supportsStreamJson ? this.getStreamPath(agent.id) : undefined,
    });
  }

  private validateConfig(config: ReturnType<typeof getAgentConfig>): void {
    splitArgString(config.command, 'command');
    splitArgString(config.printFlag, 'printFlag');
    splitArgString(config.resumeFlag, 'resumeFlag');
    splitArgString(config.skipPermissions, 'skipPermissions');
    splitArgString(config.streamJsonFlags, 'streamJsonFlags');
    splitArgString(config.promptFlag, 'promptFlag');
  }

  private async waitForFirstSurface(workspaceId: string): Promise<string> {
    const startedAt = Date.now();
    let lastCount = 0;
    while (Date.now() - startedAt < 5000) {
      const surfaces = await this.cmux.listSurfaces(workspaceId);
      lastCount = surfaces.length;
      const first = surfaces[0]?.id;
      if (first) return first;
      await sleep(100);
    }
    throw new Error(`No surfaces found in workspace ${workspaceId} after wait (last count: ${lastCount})`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
