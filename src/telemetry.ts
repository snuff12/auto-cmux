import { EventEmitter } from 'events';
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { AgentTelemetry, CostsConfig } from './types.js';

/**
 * Tracks per-agent token usage, cost, and context percent.
 * Persists daily aggregates to ~/.auto-cmux/telemetry/{date}.jsonl.
 * Emits 'budget_exceeded' and 'low_context' events.
 */
export class TelemetryTracker extends EventEmitter {
  private agents = new Map<string, AgentTelemetry>();
  private telemetryDir: string;
  private costsConfig: CostsConfig;
  private budgetExceededEmitted = false;
  private budgetWarningEmitted = false;

  constructor(basePath: string, costsConfig?: CostsConfig) {
    super();
    this.telemetryDir = join(basePath, 'telemetry');
    mkdirSync(this.telemetryDir, { recursive: true });
    this.costsConfig = costsConfig ?? { dailyLimitCents: 0, warnAt: 0.8 };
  }

  setCostsConfig(config: CostsConfig): void {
    this.costsConfig = config;
  }

  /** Record a completed turn with cost/token data from a StreamResultEvent. */
  recordResult(agentId: string, data: {
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    turnCount?: number;
  }): void {
    const entry = this.getOrCreate(agentId);
    const costCents = (data.costUsd ?? 0) * 100;
    const tokens = (data.inputTokens ?? 0) + (data.outputTokens ?? 0);

    entry.totalCostCents += costCents;
    entry.totalTokens += tokens;
    if (data.turnCount != null) entry.turnCount = data.turnCount;

    this.appendDaily(agentId, {
      type: 'result',
      costCents,
      tokens,
      turnCount: data.turnCount,
    });

    this.checkBudget(agentId);
  }

  /** Record a tool call. */
  recordToolCall(agentId: string, toolName: string): void {
    const entry = this.getOrCreate(agentId);
    entry.toolCallCount++;
    entry.lastToolCalls.push(toolName);
    if (entry.lastToolCalls.length > 100) {
      entry.lastToolCalls.splice(0, entry.lastToolCalls.length - 100);
    }
  }

  /** Update context percent for an agent. Emits 'low_context' if below threshold. */
  updateContextPercent(agentId: string, percent: number): void {
    const entry = this.getOrCreate(agentId);
    entry.contextPercent = percent;

    if (percent <= 20) {
      this.emit('low_context', agentId, percent);
    }
  }

  /** Get telemetry for a single agent. */
  get(agentId: string): AgentTelemetry | undefined {
    return this.agents.get(agentId);
  }

  /** Get telemetry for all agents. */
  getAll(): AgentTelemetry[] {
    return Array.from(this.agents.values());
  }

  /** Get daily total cost in cents across all agents. */
  getDailyTotalCents(): number {
    let total = 0;
    for (const entry of this.agents.values()) {
      total += entry.totalCostCents;
    }
    return total;
  }

  /** Check if daily budget is exceeded. Returns true if over limit. */
  isBudgetExceeded(): boolean {
    if (this.costsConfig.dailyLimitCents <= 0) return false;
    return this.getDailyTotalCents() >= this.costsConfig.dailyLimitCents;
  }

  /** Check if daily budget is at warning threshold. */
  isBudgetWarning(): boolean {
    if (this.costsConfig.dailyLimitCents <= 0) return false;
    const ratio = this.getDailyTotalCents() / this.costsConfig.dailyLimitCents;
    return ratio >= this.costsConfig.warnAt && ratio < 1.0;
  }

  /** Remove tracking for an agent (on kill). */
  remove(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** Load today's telemetry from disk (for server restart recovery). */
  loadToday(): void {
    const filePath = this.dailyFilePath();
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const record = JSON.parse(trimmed);
          if (record.agentId && record.type === 'result') {
            const entry = this.getOrCreate(record.agentId);
            entry.totalCostCents += record.costCents ?? 0;
            entry.totalTokens += record.tokens ?? 0;
            if (record.turnCount != null) entry.turnCount = record.turnCount;
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* no file yet */ }
  }

  // ── Internal ──

  private getOrCreate(agentId: string): AgentTelemetry {
    let entry = this.agents.get(agentId);
    if (!entry) {
      entry = {
        agentId,
        totalTokens: 0,
        totalCostCents: 0,
        turnCount: 0,
        toolCallCount: 0,
        lastToolCalls: [],
      };
      this.agents.set(agentId, entry);
    }
    return entry;
  }

  private checkBudget(agentId: string): void {
    if (this.costsConfig.dailyLimitCents <= 0) return;

    const total = this.getDailyTotalCents();
    if (total >= this.costsConfig.dailyLimitCents) {
      if (!this.budgetExceededEmitted) {
        this.budgetExceededEmitted = true;
        this.emit('budget_exceeded', agentId, total, this.costsConfig.dailyLimitCents);
      }
    } else {
      const ratio = total / this.costsConfig.dailyLimitCents;
      if (ratio >= this.costsConfig.warnAt && !this.budgetWarningEmitted) {
        this.budgetWarningEmitted = true;
        this.emit('budget_warning', agentId, total, this.costsConfig.dailyLimitCents);
      }
    }
  }

  private dailyFilePath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(this.telemetryDir, `${date}.jsonl`);
  }

  private appendDaily(agentId: string, data: Record<string, unknown>): void {
    const record = { agentId, timestamp: Date.now(), ...data };
    try {
      appendFileSync(this.dailyFilePath(), JSON.stringify(record) + '\n', 'utf8');
    } catch { /* best-effort persistence */ }
  }
}
