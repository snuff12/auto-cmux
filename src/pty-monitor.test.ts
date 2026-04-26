import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PtyMonitor,
  CTX_PERCENT_RE,
  COMPACTED_RE,
  CHANGES_REQUESTED_RE,
  REDACTED_THINKING_RE,
  RATE_LIMIT_PATTERNS,
  LOW_CTX_ARM,
  LOW_CTX_FIRE,
  COMPACTION_PREV_CTX_MIN,
  COMPACTION_CUR_CTX_MAX,
} from './pty-monitor.js';
import type { CmuxClientLike } from './pty-monitor.js';

// ── Static classifiers ─────────────────────────────────────────────────────

describe('PtyMonitor.classifyRateLimit', () => {
  const NOW = 1_700_000_000_000;

  it('returns null for normal text', () => {
    expect(PtyMonitor.classifyRateLimit('Everything is fine', NOW)).toBeNull();
  });

  it('detects Claude usage limit with extracted timestamp', () => {
    const snapshot = 'Claude AI usage limit reached|1700003600';
    const result = PtyMonitor.classifyRateLimit(snapshot, NOW);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('Claude usage limit');
    // extracted ts = 1700003600 * 1000 = 1.7000036e+15
    expect(result!.resumeAt).toBe(1700003600 * 1000);
  });

  it('detects 5-hour limit', () => {
    const result = PtyMonitor.classifyRateLimit('5-hour limit reached', NOW);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('5-hour');
    expect(result!.resumeAt).toBe(NOW + 60 * 60 * 1000);
  });

  it('detects weekly usage limit', () => {
    const result = PtyMonitor.classifyRateLimit('weekly usage limit reached', NOW);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('Weekly');
  });

  it('detects API 429 error', () => {
    const result = PtyMonitor.classifyRateLimit('API Error: 429', NOW);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('429');
    expect(result!.resumeAt).toBe(NOW + 60 * 1000);
  });

  it('detects quota exceeded', () => {
    const result = PtyMonitor.classifyRateLimit('quota exceeded', NOW);
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('Quota');
  });

  it('ignores invalid extracted timestamp (in the past)', () => {
    // Timestamp 100 → 100_000ms, which is in the past
    const snapshot = 'Claude AI usage limit reached|100';
    const result = PtyMonitor.classifyRateLimit(snapshot, NOW);
    expect(result).not.toBeNull();
    // Should fall back to default wait
    expect(result!.resumeAt).toBe(NOW + 60 * 60 * 1000);
  });

  it('ignores extracted timestamp too far in the future', () => {
    // 31 days from now in seconds
    const farFuture = Math.floor((NOW + 31 * 24 * 60 * 60 * 1000) / 1000);
    const snapshot = `Claude AI usage limit reached|${farFuture}`;
    const result = PtyMonitor.classifyRateLimit(snapshot, NOW);
    expect(result).not.toBeNull();
    expect(result!.resumeAt).toBe(NOW + 60 * 60 * 1000);
  });
});

describe('PtyMonitor.extractCtxPercent', () => {
  it('returns null for text without context percent', () => {
    expect(PtyMonitor.extractCtxPercent('no context info here')).toBeNull();
  });

  it('extracts "context: 42%"', () => {
    expect(PtyMonitor.extractCtxPercent('context: 42%')).toBe(42);
  });

  it('extracts "context left: ~75 %"', () => {
    expect(PtyMonitor.extractCtxPercent('context left: ~75 %')).toBe(75);
  });

  it('extracts "Context: 0%"', () => {
    expect(PtyMonitor.extractCtxPercent('Context: 0%')).toBe(0);
  });

  it('extracts "Context: 100%"', () => {
    expect(PtyMonitor.extractCtxPercent('Context: 100%')).toBe(100);
  });

  it('returns null for out-of-range values (>100)', () => {
    expect(PtyMonitor.extractCtxPercent('context: 150%')).toBeNull();
  });
});

describe('PtyMonitor.detectCrashed', () => {
  it('returns false for normal output', () => {
    expect(PtyMonitor.detectCrashed('Running tests...')).toBe(false);
  });

  it('detects bare shell prompt', () => {
    expect(PtyMonitor.detectCrashed('some output\n$ \nmore')).toBe(true);
  });

  it('detects shell prompt at end of snapshot', () => {
    expect(PtyMonitor.detectCrashed('output\n$ ')).toBe(true);
  });
});

// ── Regex constants ────────────────────────────────────────────────────────

describe('detection regexes', () => {
  it('CTX_PERCENT_RE matches context percentage formats', () => {
    expect(CTX_PERCENT_RE.test('context: 42%')).toBe(true);
    expect(CTX_PERCENT_RE.test('context left: ~75 %')).toBe(true);
    expect(CTX_PERCENT_RE.test('no match')).toBe(false);
  });

  it('COMPACTED_RE matches compaction phrases', () => {
    expect(COMPACTED_RE.test('context compacted')).toBe(true);
    expect(COMPACTED_RE.test('context summarized')).toBe(true);
    expect(COMPACTED_RE.test('/compact completed')).toBe(true);
    expect(COMPACTED_RE.test('/compact done')).toBe(true);
    expect(COMPACTED_RE.test('no match')).toBe(false);
  });

  it('CHANGES_REQUESTED_RE matches review phrases', () => {
    expect(CHANGES_REQUESTED_RE.test('changes requested')).toBe(true);
    expect(CHANGES_REQUESTED_RE.test('changes-requested')).toBe(true);
    expect(CHANGES_REQUESTED_RE.test('please address the comments')).toBe(true);
    expect(CHANGES_REQUESTED_RE.test('please fix the review')).toBe(true);
  });

  it('REDACTED_THINKING_RE matches redaction phrases', () => {
    expect(REDACTED_THINKING_RE.test('redacted thinking')).toBe(true);
    expect(REDACTED_THINKING_RE.test('redacted-thinking')).toBe(true);
    expect(REDACTED_THINKING_RE.test('redacted by safety')).toBe(true);
  });
});

// ── analyze pipeline (via event emission) ──────────────────────────────────

describe('PtyMonitor analyze pipeline', () => {
  let monitor: PtyMonitor;
  let mockClient: CmuxClientLike;

  beforeEach(() => {
    mockClient = { readText: vi.fn() };
    monitor = new PtyMonitor(mockClient);
  });

  // Helper to invoke the private analyze method via watch + manual trigger
  async function triggerAnalyze(agentId: string, snapshot: string) {
    // Access the private analyze method directly for unit testing
    await (monitor as any).analyze(agentId, snapshot);
  }

  it('emits ctx_percent when context is detected', async () => {
    const spy = vi.fn();
    monitor.on('ctx_percent', spy);
    await triggerAnalyze('a1', 'context: 50%');
    expect(spy).toHaveBeenCalledWith({ agentId: 'a1', ctxPercent: 50 });
  });

  it('emits low_context when context drops below threshold', async () => {
    const spy = vi.fn();
    monitor.on('low_context', spy);

    // First call sets context high (arms the trigger)
    await triggerAnalyze('a1', `context: ${LOW_CTX_ARM + 10}%`);
    expect(spy).not.toHaveBeenCalled();

    // Second call drops below fire threshold
    await triggerAnalyze('a1', `context: ${LOW_CTX_FIRE - 1}%`);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'a1',
      ctxPercent: LOW_CTX_FIRE - 1,
    }));
  });

  it('does not fire low_context twice without re-arming', async () => {
    const spy = vi.fn();
    monitor.on('low_context', spy);

    await triggerAnalyze('a1', `context: ${LOW_CTX_ARM + 10}%`);
    await triggerAnalyze('a1', `context: ${LOW_CTX_FIRE - 1}%`);
    expect(spy).toHaveBeenCalledTimes(1);

    // Still below threshold — should NOT fire again
    await triggerAnalyze('a1', `context: ${LOW_CTX_FIRE - 5}%`);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-arms low_context after context rises above arm threshold', async () => {
    const spy = vi.fn();
    monitor.on('low_context', spy);

    await triggerAnalyze('a1', `context: ${LOW_CTX_ARM + 10}%`);
    await triggerAnalyze('a1', `context: ${LOW_CTX_FIRE - 1}%`);
    expect(spy).toHaveBeenCalledTimes(1);

    // Re-arm
    await triggerAnalyze('a1', `context: ${LOW_CTX_ARM + 5}%`);
    // Fire again
    await triggerAnalyze('a1', `context: ${LOW_CTX_FIRE - 1}%`);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('emits context_compacted when context drops sharply', async () => {
    const spy = vi.fn();
    monitor.on('context_compacted', spy);

    // Set previous context high
    await triggerAnalyze('a1', `context: ${COMPACTION_PREV_CTX_MIN}%`);
    expect(spy).not.toHaveBeenCalled();

    // Drop to low
    await triggerAnalyze('a1', `context: ${COMPACTION_CUR_CTX_MAX}%`);
    expect(spy).toHaveBeenCalledWith({ agentId: 'a1', snapshot: `context: ${COMPACTION_CUR_CTX_MAX}%` });
  });

  it('emits reaction_event for changes-requested', async () => {
    const spy = vi.fn();
    monitor.on('reaction_event', spy);
    await triggerAnalyze('a1', 'please address the comments');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'a1',
      event: 'changes-requested',
    }));
  });

  it('emits reaction_event for redacted-thinking', async () => {
    const spy = vi.fn();
    monitor.on('reaction_event', spy);
    await triggerAnalyze('a1', 'redacted thinking detected');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'a1',
      event: 'redacted-thinking',
    }));
  });

  it('deduplicates reaction events for the same agent', async () => {
    const spy = vi.fn();
    monitor.on('reaction_event', spy);
    await triggerAnalyze('a1', 'changes requested');
    await triggerAnalyze('a1', 'changes requested again');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits rate_limited for rate limit patterns', async () => {
    const spy = vi.fn();
    monitor.on('rate_limited', spy);
    await triggerAnalyze('a1', 'API Error: 429');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'a1',
      reason: 'API rate limit (429)',
    }));
  });

  it('emits crashed for shell prompt', async () => {
    const spy = vi.fn();
    monitor.on('crashed', spy);
    await triggerAnalyze('a1', 'output\n$ ');
    expect(spy).toHaveBeenCalledWith({ agentId: 'a1', snapshot: 'output\n$ ' });
  });

  it('deduplicates crashed events', async () => {
    const spy = vi.fn();
    monitor.on('crashed', spy);
    await triggerAnalyze('a1', '$ ');
    await triggerAnalyze('a1', '$ ');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits human_needed for confirmation prompts', async () => {
    const spy = vi.fn();
    monitor.on('human_needed', spy);
    await triggerAnalyze('a1', 'Are you sure you want to continue? (y/n)');
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'a1',
      type: 'permission',
    }));
  });

  it('does not emit for empty snapshots', async () => {
    const spy = vi.fn();
    monitor.on('ctx_percent', spy);
    monitor.on('human_needed', spy);
    monitor.on('crashed', spy);
    await triggerAnalyze('a1', '   ');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rate_limited pre-empts human_needed', async () => {
    const humanSpy = vi.fn();
    const rateSpy = vi.fn();
    monitor.on('human_needed', humanSpy);
    monitor.on('rate_limited', rateSpy);

    // Snapshot that matches both rate limit AND question pattern
    await triggerAnalyze('a1', 'API Error: 429\nDo you want to retry?');
    expect(rateSpy).toHaveBeenCalledTimes(1);
    expect(humanSpy).not.toHaveBeenCalled();
  });
});

// ── watch/unwatch lifecycle ────────────────────────────────────────────────

describe('PtyMonitor lifecycle', () => {
  let monitor: PtyMonitor;
  let mockClient: CmuxClientLike;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = { readText: vi.fn().mockResolvedValue('') };
    monitor = new PtyMonitor(mockClient);
  });

  afterEach(() => {
    monitor.unwatchAll();
    vi.useRealTimers();
  });

  it('watch starts polling the cmux client', async () => {
    monitor.watch('a1', 'surface-1');
    vi.advanceTimersByTime(1100);
    expect(mockClient.readText).toHaveBeenCalledWith('surface-1', 30);
  });

  it('unwatch stops polling', () => {
    monitor.watch('a1', 'surface-1');
    monitor.unwatch('a1');
    vi.advanceTimersByTime(5000);
    expect(mockClient.readText).not.toHaveBeenCalled();
  });

  it('unwatchAll clears all agents', () => {
    monitor.watch('a1', 's1');
    monitor.watch('a2', 's2');
    monitor.unwatchAll();
    vi.advanceTimersByTime(5000);
    expect(mockClient.readText).not.toHaveBeenCalled();
  });

  it('clearAlert resets deduplication for an agent', async () => {
    vi.useRealTimers();
    const spy = vi.fn();
    monitor.on('crashed', spy);

    await (monitor as any).analyze('a1', '$ ');
    expect(spy).toHaveBeenCalledTimes(1);

    monitor.clearAlert('a1');
    await (monitor as any).analyze('a1', '$ ');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('setActive is a no-op for unwatched agents', () => {
    expect(() => monitor.setActive('nonexistent', true)).not.toThrow();
  });

  it('unwatch is safe for non-watched agents', () => {
    expect(() => monitor.unwatch('nonexistent')).not.toThrow();
  });
});
