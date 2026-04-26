import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelemetryTracker } from './telemetry.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'auto-cmux-telemetry-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('TelemetryTracker', () => {
  it('records result and accumulates cost/tokens', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root);

    tracker.recordResult('agent-1', {
      costUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
      turnCount: 3,
    });

    const t = tracker.get('agent-1');
    expect(t).toBeDefined();
    expect(t!.totalCostCents).toBeCloseTo(5, 1);
    expect(t!.totalTokens).toBe(1500);
    expect(t!.turnCount).toBe(3);
  });

  it('accumulates across multiple recordResult calls', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root);

    tracker.recordResult('agent-1', { costUsd: 0.10, inputTokens: 2000, outputTokens: 1000 });
    tracker.recordResult('agent-1', { costUsd: 0.05, inputTokens: 500, outputTokens: 250 });

    const t = tracker.get('agent-1')!;
    expect(t.totalCostCents).toBeCloseTo(15, 1);
    expect(t.totalTokens).toBe(3750);
  });

  it('records tool calls', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root);

    tracker.recordToolCall('agent-1', 'Read');
    tracker.recordToolCall('agent-1', 'Edit');
    tracker.recordToolCall('agent-1', 'Read');

    const t = tracker.get('agent-1')!;
    expect(t.toolCallCount).toBe(3);
    expect(t.lastToolCalls).toEqual(['Read', 'Edit', 'Read']);
  });

  it('tracks context percent and emits low_context', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root);
    const handler = vi.fn();
    tracker.on('low_context', handler);

    tracker.updateContextPercent('agent-1', 50);
    expect(handler).not.toHaveBeenCalled();
    expect(tracker.get('agent-1')!.contextPercent).toBe(50);

    tracker.updateContextPercent('agent-1', 15);
    expect(handler).toHaveBeenCalledWith('agent-1', 15);
  });

  it('getDailyTotalCents sums across agents', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root);

    tracker.recordResult('agent-1', { costUsd: 0.10 });
    tracker.recordResult('agent-2', { costUsd: 0.20 });

    expect(tracker.getDailyTotalCents()).toBeCloseTo(30, 1);
  });

  it('detects budget exceeded', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root, { dailyLimitCents: 10, warnAt: 0.8 });
    const handler = vi.fn();
    tracker.on('budget_exceeded', handler);

    tracker.recordResult('agent-1', { costUsd: 0.05 }); // 5 cents
    expect(handler).not.toHaveBeenCalled();
    expect(tracker.isBudgetExceeded()).toBe(false);

    tracker.recordResult('agent-1', { costUsd: 0.06 }); // 6 more = 11 cents
    expect(handler).toHaveBeenCalledOnce();
    expect(tracker.isBudgetExceeded()).toBe(true);

    // Ensure budget_exceeded only fires once even with additional recordings
    tracker.recordResult('agent-1', { costUsd: 0.10 }); // 21 cents total
    tracker.recordResult('agent-2', { costUsd: 0.05 });
    expect(handler).toHaveBeenCalledOnce(); // still only 1 call
  });

  it('detects budget warning', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root, { dailyLimitCents: 100, warnAt: 0.8 });
    const handler = vi.fn();
    tracker.on('budget_warning', handler);

    tracker.recordResult('agent-1', { costUsd: 0.50 }); // 50 cents
    expect(handler).not.toHaveBeenCalled();

    tracker.recordResult('agent-1', { costUsd: 0.35 }); // 85 cents total
    expect(handler).toHaveBeenCalledOnce();
    expect(tracker.isBudgetWarning()).toBe(true);
  });

  it('isBudgetExceeded returns false when no limit set', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root, { dailyLimitCents: 0, warnAt: 0.8 });

    tracker.recordResult('agent-1', { costUsd: 999 });
    expect(tracker.isBudgetExceeded()).toBe(false);
  });

  it('removes agent telemetry', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root);

    tracker.recordResult('agent-1', { costUsd: 0.10 });
    expect(tracker.get('agent-1')).toBeDefined();

    tracker.remove('agent-1');
    expect(tracker.get('agent-1')).toBeUndefined();
  });

  it('persists daily telemetry to JSONL', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root);

    tracker.recordResult('agent-1', { costUsd: 0.10, inputTokens: 500, outputTokens: 200 });

    const date = new Date().toISOString().slice(0, 10);
    const filePath = join(root, 'telemetry', `${date}.jsonl`);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);

    const record = JSON.parse(lines[0]);
    expect(record.agentId).toBe('agent-1');
    expect(record.type).toBe('result');
    expect(record.costCents).toBeCloseTo(10, 1);
  });

  it('loads today data on restart', () => {
    const root = makeRoot();
    const tracker1 = new TelemetryTracker(root);
    tracker1.recordResult('agent-1', { costUsd: 0.10 });
    tracker1.recordResult('agent-2', { costUsd: 0.20 });

    // New tracker loading from disk
    const tracker2 = new TelemetryTracker(root);
    tracker2.loadToday();

    expect(tracker2.getDailyTotalCents()).toBeCloseTo(30, 1);
    expect(tracker2.get('agent-1')!.totalCostCents).toBeCloseTo(10, 1);
    expect(tracker2.get('agent-2')!.totalCostCents).toBeCloseTo(20, 1);
  });

  it('getAll returns all tracked agents', () => {
    const root = makeRoot();
    const tracker = new TelemetryTracker(root);

    tracker.recordResult('agent-1', { costUsd: 0.10 });
    tracker.recordResult('agent-2', { costUsd: 0.20 });

    const all = tracker.getAll();
    expect(all.length).toBe(2);
    expect(all.map(a => a.agentId).sort()).toEqual(['agent-1', 'agent-2']);
  });
});
