import {
  openSync, fstatSync, readSync, closeSync,
  readFileSync, writeFileSync, renameSync, unlinkSync,
  mkdirSync, rmSync,
} from 'fs';
import { join } from 'path';
import type { Action, ActionEnvelope, DeltaResult, ParseError } from './types.js';

// ──────────────────────────────────────────────
// File-based communication protocol.
//
// Each agent has a directory under basePath/agents/{id}/ containing:
//   - inbox.md    : prompt written by orchestrator, read by agent
//   - actions.md  : JSON-line results appended by agent
//   - actions.offset : byte offset tracking (orchestrator internal)
//
// The orchestrator reads delta bytes from actions.md via byte-offset
// tracking — only new, complete lines are processed on each call.
// ──────────────────────────────────────────────

export class FileProtocol {
  private offsets = new Map<string, number>();
  private streamOffsets = new Map<string, number>();

  constructor(private basePath: string) {}

  // ── Path helpers ──────────────────────────────

  private agentDir(agentId: string): string {
    return join(this.basePath, 'agents', agentId);
  }
  private actionsPath(agentId: string): string {
    return join(this.agentDir(agentId), 'actions.md');
  }
  private offsetPath(agentId: string): string {
    return join(this.agentDir(agentId), 'actions.offset');
  }
  private inboxPath(agentId: string): string {
    return join(this.agentDir(agentId), 'inbox.md');
  }
  private streamPath(agentId: string): string {
    return join(this.agentDir(agentId), 'stream.jsonl');
  }
  private streamOffsetPath(agentId: string): string {
    return join(this.agentDir(agentId), 'stream.offset');
  }

  // ── Offset management ────────────────────────

  private getOffset(agentId: string): number {
    const cached = this.offsets.get(agentId);
    if (cached !== undefined) return cached;
    let value = 0;
    try {
      const raw = readFileSync(this.offsetPath(agentId), 'utf8').trim();
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) value = n;
    } catch { /* no prior offset — start at 0 */ }
    this.offsets.set(agentId, value);
    return value;
  }

  private setOffset(agentId: string, n: number): void {
    this.offsets.set(agentId, n);
    const dest = this.offsetPath(agentId);
    const tmp = `${dest}.tmp`;
    try {
      writeFileSync(tmp, String(n), 'utf8');
      renameSync(tmp, dest);
    } catch {
      try { unlinkSync(tmp); } catch { /* best-effort */ }
    }
  }

  private getStreamOffset(agentId: string): number {
    const cached = this.streamOffsets.get(agentId);
    if (cached !== undefined) return cached;
    let value = 0;
    try {
      const raw = readFileSync(this.streamOffsetPath(agentId), 'utf8').trim();
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) value = n;
    } catch { /* no prior offset */ }
    this.streamOffsets.set(agentId, value);
    return value;
  }

  private setStreamOffset(agentId: string, n: number): void {
    this.streamOffsets.set(agentId, n);
    const dest = this.streamOffsetPath(agentId);
    const tmp = `${dest}.tmp`;
    try {
      writeFileSync(tmp, String(n), 'utf8');
      renameSync(tmp, dest);
    } catch {
      try { unlinkSync(tmp); } catch { /* best-effort */ }
    }
  }

  // ── Actions reading ──────────────────────────

  /**
   * Read new JSON-line actions since last offset, advance the offset.
   * Only processes complete lines (ending in \n) — partial writes are
   * left for the next call. Handles file truncation/rotation gracefully.
   */
  readNewActions(agentId: string): DeltaResult {
    const p = this.actionsPath(agentId);
    let fd: number;
    try {
      fd = openSync(p, 'r');
    } catch {
      return { actions: [], errors: [] };
    }
    try {
      const size = fstatSync(fd).size;
      let offset = this.getOffset(agentId);
      if (size < offset) offset = 0; // file was truncated/rotated
      if (size === offset) return { actions: [], errors: [] };

      const len = size - offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);

      const lastNewline = buf.lastIndexOf(0x0a /* \n */);
      if (lastNewline === -1) {
        return { actions: [], errors: [] };
      }
      const complete = buf.subarray(0, lastNewline + 1).toString('utf8');
      const result = parseActionsWithErrors(complete);
      this.setOffset(agentId, offset + lastNewline + 1);
      return result;
    } finally {
      closeSync(fd);
    }
  }

  readNewStreamText(agentId: string): string {
    const p = this.streamPath(agentId);
    let fd: number;
    try {
      fd = openSync(p, 'r');
    } catch {
      return '';
    }
    try {
      const size = fstatSync(fd).size;
      let offset = this.getStreamOffset(agentId);
      if (size < offset) offset = 0;
      if (size === offset) return '';

      const len = size - offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);

      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline === -1) return '';

      const complete = buf.subarray(0, lastNewline + 1).toString('utf8');
      this.setStreamOffset(agentId, offset + lastNewline + 1);
      return complete;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Peek all actions without advancing offset. For UI / debugging.
   */
  peekAll(agentId: string): Action[] {
    try {
      const content = readFileSync(this.actionsPath(agentId), 'utf8');
      return parseActionsWithErrors(content).actions;
    } catch { return []; }
  }

  // ── Inbox writing ────────────────────────────

  /** Append content to inbox.md */
  writeInbox(agentId: string, content: string): void {
    const p = this.inboxPath(agentId);
    const existing = safeRead(p);
    writeFileSync(p, existing + content, 'utf8');
  }

  /** Overwrite inbox.md with fresh content */
  writeInboxFresh(agentId: string, content: string): void {
    writeFileSync(this.inboxPath(agentId), content, 'utf8');
  }

  // ── Directory lifecycle ──────────────────────

  /** Create agent directory and empty files */
  initAgentDir(agentId: string): void {
    const dir = this.agentDir(agentId);
    mkdirSync(dir, { recursive: true });
    for (const file of ['inbox.md', 'actions.md']) {
      const p = join(dir, file);
      try { readFileSync(p); } catch { writeFileSync(p, '', 'utf8'); }
    }
  }

  /** Remove agent directory and clear cached offset */
  cleanupAgentDir(agentId: string): void {
    this.offsets.delete(agentId);
    this.streamOffsets.delete(agentId);
    try {
      rmSync(this.agentDir(agentId), { recursive: true, force: true });
    } catch { /* already gone */ }
  }

  /** Reset offset (e.g. on agent rehire) */
  resetOffset(agentId: string): void {
    this.offsets.delete(agentId);
    this.streamOffsets.delete(agentId);
    try { unlinkSync(this.offsetPath(agentId)); } catch { /* none to remove */ }
    try { unlinkSync(this.streamOffsetPath(agentId)); } catch { /* none to remove */ }
  }

  // ── Envelope conversion ──────────────────────

  /**
   * Convert a raw Action into a standardized ActionEnvelope.
   * Separates the action type from data fields for uniform processing.
   */
  toEnvelope(agentId: string, action: Action): ActionEnvelope {
    const { action: actionType, ...rest } = action;
    const isError = actionType === 'error';
    return {
      ok: !isError,
      action: actionType,
      agentId,
      timestamp: Date.now(),
      data: Object.keys(rest).length > 0 ? rest as Record<string, unknown> : undefined,
      error: isError ? (rest as { message?: string }).message : undefined,
    };
  }

  /**
   * Read new actions and return them as ActionEnvelopes.
   */
  readNewEnvelopes(agentId: string): { envelopes: ActionEnvelope[]; errors: ParseError[] } {
    const { actions, errors } = this.readNewActions(agentId);
    return {
      envelopes: actions.map(a => this.toEnvelope(agentId, a)),
      errors,
    };
  }

  // ── Broadcast ───────────────────────────────

  /**
   * Send a message to multiple agents' inboxes.
   * @param agentIds - target agent IDs
   * @param content - message content
   */
  broadcast(agentIds: string[], content: string): void {
    for (const agentId of agentIds) {
      this.writeInbox(agentId, content);
    }
  }

  // ── Utilities ────────────────────────────────

  /** Atomic JSON write via tmp+rename */
  atomicWriteJson(dest: string, data: unknown): void {
    const tmp = `${dest}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, dest);
    } catch (err) {
      console.error(`[file-protocol] atomic write to ${dest} failed:`, err);
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

// ── JSON-line parser ─────────────────────────

function parseActionsWithErrors(content: string): DeltaResult {
  const actions: Action[] = [];
  const errors: ParseError[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      actions.push(JSON.parse(trimmed) as Action);
    } catch (err) {
      errors.push({
        line: trimmed.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { actions, errors };
}

function safeRead(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
