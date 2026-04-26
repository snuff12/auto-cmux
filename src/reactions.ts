import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { ReactionRule, ReactionEvent, ReactionAction, ReactionAlert, Agent } from './types.js';

// ──────────────────────────────────────────────────────────────────────────────
// Default reaction rules
// ──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RULES: ReactionRule[] = [
  { event: 'stall',          action: 'diagnose', auto: true,  retries: 3, cooldownMs: 30_000, escalateAfter: 3 },
  { event: 'hitl',           action: 'alert',    auto: false, retries: 0, cooldownMs: 0,      escalateAfter: 0 },
  { event: 'rate-limited',   action: 'resume',   auto: true,  retries: 5, cooldownMs: 60_000, escalateAfter: 5 },
  { event: 'agent-crashed',  action: 'retry',    auto: true,  retries: 2, cooldownMs: 5_000,  escalateAfter: 2 },
  { event: 'low-context',    action: 'compact',  auto: true,  retries: 1, cooldownMs: 60_000, escalateAfter: 1 },
  { event: 'ci-failed',      action: 'retry',    auto: true,  retries: 2, cooldownMs: 10_000, escalateAfter: 2 },
];

// ──────────────────────────────────────────────────────────────────────────────
// Stall detection constants
// ──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_STALL_TIMEOUT_MS = 120_000; // 120 seconds
export const STALL_CHECK_INTERVAL_MS = 10_000;   // check every 10s

// ──────────────────────────────────────────────────────────────────────────────
// Diagnose prompts sent to stalled agents
// ──────────────────────────────────────────────────────────────────────────────

const DIAGNOSE_PROMPTS = [
  'You seem stuck. What is blocking you? If you need help, use the available actions: ask, delegate_to, or report_to_pm.',
  'Still no progress. Please report your current status and what you need to continue.',
  'Final check before escalation. Summarize what you have done and what is blocking completion.',
];

// ──────────────────────────────────────────────────────────────────────────────
// Interfaces for dependency injection
// ──────────────────────────────────────────────────────────────────────────────

export interface AgentManagerLike {
  list(): Agent[];
  get(agentId: string): Agent | undefined;
  retryTask(agentId: string): Promise<void>;
  kill(agentId: string): Promise<void>;
  setStatus(agentId: string, status: string): void;
}

export interface FileProtocolLike {
  writeInbox(agentId: string, content: string): void;
}

export interface CmuxClientLike {
  sendText(surfaceId: string, text: string): Promise<void>;
  readText(surfaceId: string): Promise<string>;
  notify?(title: string, body: string): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────────
// ReactionsDispatcher
// ──────────────────────────────────────────────────────────────────────────────

export class ReactionsDispatcher extends EventEmitter {
  private rules: ReactionRule[];
  private cooldowns = new Map<string, number>();   // "agentId:event" → lastFiredAt
  private retryCounts = new Map<string, number>();  // "agentId:event" → count
  private alerts = new Map<string, ReactionAlert>(); // alertId → alert
  private stallTimer: NodeJS.Timeout | null = null;
  private stallTimeoutMs: number;

  private agentManager: AgentManagerLike;
  private fileProtocol: FileProtocolLike;
  private cmuxClient: CmuxClientLike;

  constructor(
    agentManager: AgentManagerLike,
    fileProtocol: FileProtocolLike,
    cmuxClient: CmuxClientLike,
    options?: { rules?: Partial<ReactionRule>[]; stallTimeoutMs?: number },
  ) {
    super();
    this.agentManager = agentManager;
    this.fileProtocol = fileProtocol;
    this.cmuxClient = cmuxClient;
    this.stallTimeoutMs = options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

    // Merge user overrides with defaults
    this.rules = this.mergeRules(options?.rules);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Dispatch a reaction event for an agent.
   * Returns the action taken (or 'none' if cooldown/exhausted).
   */
  async dispatch(event: ReactionEvent, agentId: string, details: string = ''): Promise<ReactionAction | 'escalate' | 'none'> {
    const rule = this.rules.find(r => r.event === event);
    if (!rule) return 'none';

    const key = `${agentId}:${event}`;

    // Check cooldown
    const lastFired = this.cooldowns.get(key) ?? 0;
    const now = Date.now();
    if (rule.cooldownMs > 0 && (now - lastFired) < rule.cooldownMs) {
      return 'none';
    }

    // Check retry count → escalate if exhausted
    const retryCount = this.retryCounts.get(key) ?? 0;
    if (rule.escalateAfter > 0 && retryCount >= rule.escalateAfter) {
      this.cooldowns.set(key, now);
      this.retryCounts.set(key, retryCount + 1); // prevent repeated escalation when cooldownMs=0
      await this.executeAction('escalate', agentId, event, '', retryCount);
      return 'escalate';
    }

    // Track cooldown and retries
    this.cooldowns.set(key, now);
    this.retryCounts.set(key, retryCount + 1);

    if (!rule.auto) {
      // Non-auto: create alert and notify
      this.createAlert(agentId, event, details);
      this.emit('alert', { agentId, event, details });
      return 'alert';
    }

    await this.executeAction(rule.action, agentId, event, details, retryCount);
    return rule.action;
  }

  /**
   * Resolve a pending alert (HITL response).
   */
  resolveAlert(alertId: string, resolution: string): ReactionAlert | null {
    const alert = this.alerts.get(alertId);
    if (!alert || alert.resolved) return null;

    alert.resolved = true;
    alert.resolution = resolution;
    this.emit('alert_resolved', alert);
    return alert;
  }

  /**
   * Get all active (unresolved) alerts.
   */
  getActiveAlerts(): ReactionAlert[] {
    return Array.from(this.alerts.values()).filter(a => !a.resolved);
  }

  /**
   * Get all alerts (including resolved).
   */
  getAllAlerts(): ReactionAlert[] {
    return Array.from(this.alerts.values());
  }

  /**
   * Get current reaction rules.
   */
  getRules(): ReactionRule[] {
    return [...this.rules];
  }

  /**
   * Get retry count for an agent:event pair.
   */
  getRetryCount(agentId: string, event: ReactionEvent): number {
    return this.retryCounts.get(`${agentId}:${event}`) ?? 0;
  }

  /**
   * Reset retry/cooldown state for an agent (e.g., after task reassignment).
   */
  resetAgent(agentId: string): void {
    for (const key of [...this.cooldowns.keys()]) {
      if (key.startsWith(`${agentId}:`)) {
        this.cooldowns.delete(key);
        this.retryCounts.delete(key);
      }
    }
  }

  // ── Stall Detection ─────────────────────────────────────────────────────

  /**
   * Start periodic stall detection.
   */
  startStallDetection(): void {
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => this.checkStalls(), STALL_CHECK_INTERVAL_MS);
  }

  /**
   * Stop periodic stall detection.
   */
  stopStallDetection(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * Check all working agents for stall condition.
   * Exposed for testing.
   */
  async checkStalls(): Promise<void> {
    const now = Date.now();
    for (const agent of this.agentManager.list()) {
      if (agent.status !== 'working') continue;

      // Verify the surface is still alive before checking for stalls
      try {
        await this.cmuxClient.readText(agent.surfaceId);
      } catch {
        console.error(`[reactions] Agent ${agent.id} surface gone, marking as dead`);
        this.agentManager.setStatus(agent.id, 'dead');
        continue;
      }

      const lastActivity = agent.lastActionAt ?? agent.taskSentAt ?? 0;
      if (lastActivity === 0) continue;

      const elapsed = now - lastActivity;
      if (elapsed >= this.stallTimeoutMs) {
        await this.dispatch('stall', agent.id, `No activity for ${Math.round(elapsed / 1000)}s`);
      }
    }
  }

  /**
   * Clean up timers.
   */
  destroy(): void {
    this.stopStallDetection();
    this.removeAllListeners();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async executeAction(
    action: ReactionAction | 'escalate',
    agentId: string,
    event: ReactionEvent,
    details: string,
    retryIndex: number = 0,
  ): Promise<void> {
    const agent = this.agentManager.get(agentId);
    if (!agent) return;

    switch (action) {
      case 'diagnose': {
        const prompt = DIAGNOSE_PROMPTS[Math.min(retryIndex, DIAGNOSE_PROMPTS.length - 1)];
        this.fileProtocol.writeInbox(agentId, prompt);
        this.emit('action_executed', { action, agentId, event, details: prompt });
        break;
      }

      case 'retry': {
        try {
          await this.agentManager.retryTask(agentId);
          this.emit('action_executed', { action, agentId, event });
        } catch (err) {
          this.emit('action_error', { action, agentId, event, error: (err as Error).message });
        }
        break;
      }

      case 'alert': {
        this.createAlert(agentId, event, details);
        this.emit('alert', { agentId, event, details });
        break;
      }

      case 'resume': {
        // Resume is handled by AgentManager.handleRateLimit; we just log it
        this.emit('action_executed', { action, agentId, event });
        break;
      }

      case 'compact': {
        try {
          await this.cmuxClient.sendText(agent.surfaceId, '/compact\n');
          this.emit('action_executed', { action, agentId, event });
        } catch (err) {
          this.emit('action_error', { action, agentId, event, error: (err as Error).message });
        }
        break;
      }

      case 'escalate': {
        this.createAlert(agentId, event, `Escalated after max retries: ${details}`);
        this.emit('escalated', { agentId, event, details });
        break;
      }

      case 'kill': {
        try {
          await this.agentManager.kill(agentId);
          this.emit('action_executed', { action, agentId, event });
        } catch (err) {
          this.emit('action_error', { action, agentId, event, error: (err as Error).message });
        }
        break;
      }
    }
  }

  private pruneResolvedAlerts(): void {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour
    for (const [id, alert] of this.alerts) {
      if (alert.resolved && alert.createdAt < cutoff) {
        this.alerts.delete(id);
      }
    }
  }

  private createAlert(agentId: string, event: ReactionEvent, details: string): ReactionAlert {
    this.pruneResolvedAlerts();
    const alert: ReactionAlert = {
      id: randomUUID(),
      agentId,
      event,
      details,
      createdAt: Date.now(),
      resolved: false,
    };
    this.alerts.set(alert.id, alert);
    return alert;
  }

  private mergeRules(overrides?: Partial<ReactionRule>[]): ReactionRule[] {
    if (!overrides || overrides.length === 0) return [...DEFAULT_RULES];

    const merged = [...DEFAULT_RULES];
    for (const override of overrides) {
      if (!override.event) continue;
      const idx = merged.findIndex(r => r.event === override.event);
      if (idx >= 0) {
        merged[idx] = { ...merged[idx], ...override } as ReactionRule;
      }
      // Ignore overrides for unknown events
    }
    return merged;
  }
}
