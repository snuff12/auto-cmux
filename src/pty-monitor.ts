import { EventEmitter } from 'events';

// CmuxClient interface — minimal surface needed by PtyMonitor.
// The real implementation lives in cmux-client.ts (Work Stream 1).
export interface CmuxClientLike {
  readText(surfaceId: string, lines?: number): Promise<string>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Human-needed detection
// ──────────────────────────────────────────────────────────────────────────────

export type AlertType = 'permission' | 'question' | 'error' | 'blocked';

const HUMAN_NEEDED_PATTERNS: Array<{ pattern: RegExp; type: AlertType; message: string }> = [
  { pattern: /\(y\/n\)/i,          type: 'permission', message: 'Confirmation required (y/n)' },
  { pattern: /\[Y\/n\]/i,          type: 'permission', message: 'Confirmation required [Y/n]' },
  { pattern: /\[y\/N\]/i,          type: 'permission', message: 'Confirmation required [y/N]' },
  { pattern: /Continue\?/i,        type: 'permission', message: 'Continue? prompt detected' },
  { pattern: /proceed\?/i,         type: 'permission', message: 'Proceed? prompt detected' },
  { pattern: /confirm\s*\?/i,      type: 'permission', message: 'Confirmation prompt detected' },
  { pattern: /Delete.*\?/i,        type: 'permission', message: 'Delete confirmation required' },
  { pattern: /Overwrite.*\?/i,     type: 'permission', message: 'Overwrite confirmation required' },
  { pattern: /Enter\s+.*:/i,       type: 'question',   message: 'Input prompt detected' },
  { pattern: /Press Enter/i,       type: 'question',   message: 'Waiting for Enter key' },
  { pattern: /Press any key/i,     type: 'question',   message: 'Waiting for key press' },
  { pattern: /Enter to confirm/i,  type: 'permission', message: 'Confirmation needed' },
  { pattern: /Are you sure/i,      type: 'permission', message: 'Confirmation required' },
  { pattern: /Permission denied/i, type: 'error',      message: 'Permission error' },
  { pattern: /^\s*BLOCKED\s*$/im,  type: 'blocked',    message: 'Task is blocked' },
  { pattern: /needs-human/i,       type: 'question',   message: 'Human assistance requested' },
  // Catch-all: plain-language questions — short lines ending in `?` with no code-like characters
  { pattern: /^[^`{}[\]|;\\<>]{10,80}\?\s*$/m, type: 'question', message: 'Waiting for input' },
];

export interface HumanNeededEvent {
  agentId: string;
  type: AlertType;
  message: string;
  snapshot: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Rate-limit detection
// ──────────────────────────────────────────────────────────────────────────────

export interface RateLimitPattern {
  pattern: RegExp;
  reason: string;
  defaultWaitMs: number;
  extractResetTs?: boolean;
}

export const RATE_LIMIT_PATTERNS: RateLimitPattern[] = [
  { pattern: /Claude AI usage limit reached\|(\d+)/i, reason: 'Claude usage limit reached', defaultWaitMs: 60 * 60 * 1000, extractResetTs: true },
  { pattern: /5[-\s]?hour limit reached/i,            reason: '5-hour usage limit reached', defaultWaitMs: 60 * 60 * 1000 },
  { pattern: /weekly (?:usage )?limit reached/i,      reason: 'Weekly usage limit reached', defaultWaitMs: 60 * 60 * 1000 },
  { pattern: /API Error:\s*429/i,                      reason: 'API rate limit (429)',       defaultWaitMs: 60 * 1000 },
  { pattern: /quota exceeded/i,                        reason: 'Quota exceeded',             defaultWaitMs: 5 * 60 * 1000 },
];

export interface RateLimitedEvent {
  agentId: string;
  reason: string;
  resumeAt: number;
  snapshot: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Context / compaction detection
// ──────────────────────────────────────────────────────────────────────────────

export const CTX_PERCENT_RE = /context(?: left)?:\s*(?:~\s*)?(\d{1,3})\s*%/i;
export const COMPACTED_RE = /(?:context (?:compacted|summarized)|\/compact (?:completed|done))/i;
export const CHANGES_REQUESTED_RE = /changes[\s-]?requested|please (?:address|fix) (?:the )?(?:comments|review)/i;
export const REDACTED_THINKING_RE = /redacted[\s-]?thinking|redacted by safety/i;

export const LOW_CTX_ARM = 55;
export const LOW_CTX_FIRE = 20;
export const COMPACTION_PREV_CTX_MIN = 70;
export const COMPACTION_CUR_CTX_MAX = 30;

// ──────────────────────────────────────────────────────────────────────────────
// Crashed detection — shell prompt means CLI exited
// ──────────────────────────────────────────────────────────────────────────────

const CRASHED_PATTERN = /^\$\s*$/m;

// ──────────────────────────────────────────────────────────────────────────────
// Poll intervals
// ──────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_ACTIVE = 1000;
const POLL_INTERVAL_IDLE = 5000;

// ──────────────────────────────────────────────────────────────────────────────
// PtyMonitor
// ──────────────────────────────────────────────────────────────────────────────

export interface WatchedAgent {
  surfaceId: string;
  active: boolean;
}

export class PtyMonitor extends EventEmitter {
  private intervals = new Map<string, NodeJS.Timeout>();
  private agentIntervalMs = new Map<string, number>();
  private surfaces = new Map<string, string>(); // agentId → surfaceId
  private alertedFingerprints = new Map<string, Set<string>>();
  private lowCtxArmed = new Map<string, boolean>();
  private prevCtxPercent = new Map<string, number>();

  constructor(private cmuxClient: CmuxClientLike) {
    super();
  }

  watch(agentId: string, surfaceId: string, active = true): void {
    const desiredMs = active ? POLL_INTERVAL_ACTIVE : POLL_INTERVAL_IDLE;

    this.surfaces.set(agentId, surfaceId);

    // Already watching at the same rate — no-op
    if (this.intervals.has(agentId) && this.agentIntervalMs.get(agentId) === desiredMs) return;

    // Clear existing interval before setting new one (rate change)
    this.unwatchInterval(agentId);

    const interval = setInterval(async () => {
      try {
        const sid = this.surfaces.get(agentId);
        if (!sid) return;
        const snapshot = await this.cmuxClient.readText(sid, 30);
        await this.analyze(agentId, snapshot);
      } catch {
        // Agent may have been killed — interval will be cleaned up on unwatch
      }
    }, desiredMs);

    this.intervals.set(agentId, interval);
    this.agentIntervalMs.set(agentId, desiredMs);
  }

  setActive(agentId: string, active: boolean): void {
    const surfaceId = this.surfaces.get(agentId);
    if (!surfaceId || !this.intervals.has(agentId)) return;
    this.watch(agentId, surfaceId, active);
  }

  private unwatchInterval(agentId: string): void {
    const interval = this.intervals.get(agentId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(agentId);
      this.agentIntervalMs.delete(agentId);
    }
  }

  unwatch(agentId: string): void {
    this.unwatchInterval(agentId);
    this.surfaces.delete(agentId);
    this.clearAlert(agentId);
    this.lowCtxArmed.delete(agentId);
    this.prevCtxPercent.delete(agentId);
  }

  unwatchAll(): void {
    for (const agentId of [...this.intervals.keys()]) {
      this.unwatch(agentId);
    }
  }

  clearAlert(agentId: string): void {
    this.alertedFingerprints.delete(agentId);
  }

  /**
   * Returns true if this fingerprint hasn't been seen yet for the agent,
   * and records it so subsequent calls with the same fingerprint return false.
   */
  private shouldAlert(agentId: string, fingerprint: string): boolean {
    let agentSet = this.alertedFingerprints.get(agentId);
    if (agentSet?.has(fingerprint)) return false;
    if (!agentSet) { agentSet = new Set(); this.alertedFingerprints.set(agentId, agentSet); }
    agentSet.add(fingerprint);
    return true;
  }

  // ── Static classifiers (testable without polling loop) ──────────────────

  static classifyRateLimit(snapshot: string, now: number = Date.now()): { reason: string; resumeAt: number } | null {
    for (const { pattern, reason, defaultWaitMs, extractResetTs } of RATE_LIMIT_PATTERNS) {
      const m = snapshot.match(pattern);
      if (!m) continue;
      let resumeAt = now + defaultWaitMs;
      if (extractResetTs && m[1]) {
        const ts = Number(m[1]);
        if (Number.isFinite(ts) && ts > 0) {
          const candidate = ts * 1000;
          const maxFuture = now + 30 * 24 * 60 * 60 * 1000;
          if (candidate > now && candidate < maxFuture) resumeAt = candidate;
        }
      }
      return { reason, resumeAt };
    }
    return null;
  }

  static extractCtxPercent(snapshot: string): number | null {
    const m = snapshot.match(CTX_PERCENT_RE);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return n;
  }

  static detectCrashed(snapshot: string): boolean {
    return CRASHED_PATTERN.test(snapshot);
  }

  // ── Private analysis pipeline ──────────────────────────────────────────

  private async analyze(agentId: string, snapshot: string): Promise<void> {
    if (!snapshot.trim()) return;

    // 1. Context % tracking + hysteresis + compaction detection
    const ctx = PtyMonitor.extractCtxPercent(snapshot);
    if (ctx !== null) {
      this.emit('ctx_percent', { agentId, ctxPercent: ctx });

      const prev = this.prevCtxPercent.get(agentId);
      if (prev !== undefined && prev >= COMPACTION_PREV_CTX_MIN && ctx <= COMPACTION_CUR_CTX_MAX) {
        this.emit('context_compacted', { agentId, snapshot });
      }
      this.prevCtxPercent.set(agentId, ctx);

      const armed = this.lowCtxArmed.get(agentId) ?? true;
      if (!armed && ctx >= LOW_CTX_ARM) {
        this.lowCtxArmed.set(agentId, true);
      } else if (armed && ctx <= LOW_CTX_FIRE) {
        this.lowCtxArmed.set(agentId, false);
        this.emit('low_context', { agentId, ctxPercent: ctx, snapshot });
      }
    }

    // 2. Reaction events (changes-requested, redacted-thinking)
    for (const [re, event] of [
      [CHANGES_REQUESTED_RE, 'changes-requested'],
      [REDACTED_THINKING_RE, 'redacted-thinking'],
    ] as const) {
      if (re.test(snapshot)) {
        if (!this.shouldAlert(agentId, `re:${event}`)) continue;
        this.emit('reaction_event', { agentId, event, snapshot });
      }
    }

    // 3. Rate-limit detection (terminal state — pre-empts other alerts)
    const rl = PtyMonitor.classifyRateLimit(snapshot);
    if (rl) {
      if (!this.shouldAlert(agentId, `rate-limit:${Math.floor(rl.resumeAt / 1000)}`)) return;
      const event: RateLimitedEvent = { agentId, reason: rl.reason, resumeAt: rl.resumeAt, snapshot };
      this.emit('rate_limited', event);
      return;
    }

    // 4. Crashed detection (shell prompt visible = CLI exited)
    if (PtyMonitor.detectCrashed(snapshot)) {
      if (!this.shouldAlert(agentId, 'crashed')) return;
      this.emit('crashed', { agentId, snapshot });
      return;
    }

    // 5. Human-needed detection
    for (const { pattern, type, message } of HUMAN_NEEDED_PATTERNS) {
      if (!pattern.test(snapshot)) continue;

      if (!this.shouldAlert(agentId, snapshot.slice(-200))) return;

      const event: HumanNeededEvent = { agentId, type, message, snapshot };
      this.emit('human_needed', event);
      return;
    }
  }
}
