import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseStreamFile, StreamParser } from './stream-parser.js';
import type { StreamInitEvent, StreamAssistantEvent, StreamResultEvent, StreamUserEvent, StreamRetryEvent } from './stream-parser.js';

// ── parseStreamFile ─────────────────────────────────────────────────────────

describe('parseStreamFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stream-parser-'));
  });

  it('returns default output for non-existent file', () => {
    const out = parseStreamFile('/nonexistent/stream.jsonl');
    expect(out.status).toBe('unknown');
    expect(out.textBlocks).toEqual([]);
    expect(out.toolCalls).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it('returns default output for empty file', () => {
    const f = join(tmpDir, 'empty.jsonl');
    writeFileSync(f, '', 'utf8');
    const out = parseStreamFile(f);
    expect(out.status).toBe('unknown');
  });

  it('parses init event to extract session and model', () => {
    const f = join(tmpDir, 'init.jsonl');
    const init: StreamInitEvent = {
      type: 'system',
      subtype: 'init',
      session_id: 'sess-123',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Write'],
      cwd: '/tmp',
    };
    writeFileSync(f, JSON.stringify(init) + '\n', 'utf8');

    const out = parseStreamFile(f);
    expect(out.sessionId).toBe('sess-123');
    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.status).toBe('running');
  });

  it('extracts text blocks and tool calls from assistant events', () => {
    const f = join(tmpDir, 'assistant.jsonl');
    const lines = [
      JSON.stringify({
        type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: [], cwd: '/',
      }),
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        error: null,
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'Hello world' },
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
          ],
        },
      }),
    ];
    writeFileSync(f, lines.join('\n') + '\n', 'utf8');

    const out = parseStreamFile(f);
    expect(out.textBlocks).toEqual(['Hello world']);
    expect(out.toolCalls).toEqual([{ name: 'Read', id: 'tu-1' }]);
  });

  it('captures errors from assistant events', () => {
    const f = join(tmpDir, 'error.jsonl');
    writeFileSync(f, JSON.stringify({
      type: 'assistant',
      session_id: 's1',
      error: 'rate_limit',
      parent_tool_use_id: null,
      message: { content: [] },
    }) + '\n', 'utf8');

    const out = parseStreamFile(f);
    expect(out.errors).toContain('rate_limit');
  });

  it('parses result event for cost, turns, and status', () => {
    const f = join(tmpDir, 'result.jsonl');
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: [], cwd: '/' }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 's1',
        duration_ms: 5000,
        is_error: false,
        num_turns: 3,
        result: 'Done!',
        total_cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    ];
    writeFileSync(f, lines.join('\n') + '\n', 'utf8');

    const out = parseStreamFile(f);
    expect(out.status).toBe('success');
    expect(out.result).toBe('Done!');
    expect(out.costUsd).toBe(0.05);
    expect(out.turns).toBe(3);
    expect(out.usage).toEqual({ input_tokens: 1000, output_tokens: 500 });
  });

  it('marks status as error for non-success result subtypes', () => {
    const f = join(tmpDir, 'err-result.jsonl');
    writeFileSync(f, JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      session_id: 's1',
      duration_ms: 1000,
      is_error: true,
      num_turns: 10,
      total_cost_usd: 0.1,
      errors: ['max turns reached'],
      usage: { input_tokens: 500, output_tokens: 200 },
    }) + '\n', 'utf8');

    const out = parseStreamFile(f);
    expect(out.status).toBe('error');
    expect(out.errors).toContain('max turns reached');
  });

  it('skips malformed JSON lines gracefully', () => {
    const f = join(tmpDir, 'mixed.jsonl');
    const lines = [
      'not json',
      '{ broken',
      '',
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', tools: [], cwd: '/' }),
    ];
    writeFileSync(f, lines.join('\n') + '\n', 'utf8');

    const out = parseStreamFile(f);
    expect(out.sessionId).toBe('s1');
    expect(out.status).toBe('running');
  });
});

// ── StreamParser.processEvent (via emit) ────────────────────────────────────

describe('StreamParser.processEvent', () => {
  let parser: StreamParser;

  beforeEach(() => {
    parser = new StreamParser();
  });

  afterEach(() => {
    parser.unwatchAll();
  });

  // Helper to trigger processEvent indirectly through a temp file
  async function feedEvents(agentId: string, events: object[]): Promise<void> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sp-'));
    const filePath = join(tmpDir, 'stream.jsonl');
    writeFileSync(filePath, '', 'utf8');
    parser.watch(agentId, filePath);

    // Write events and wait for poll
    writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    // Wait for at least one poll cycle (200ms interval)
    await new Promise(r => setTimeout(r, 350));
  }

  it('emits init event for system init', async () => {
    const initSpy = vi.fn();
    parser.on('init', initSpy);

    await feedEvents('a1', [{
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'claude-sonnet-4-6',
      tools: [],
      cwd: '/tmp',
    }]);

    expect(initSpy).toHaveBeenCalledWith('a1', expect.objectContaining({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
    }));
  });

  it('emits tool_use for assistant tool calls', async () => {
    const toolSpy = vi.fn();
    parser.on('tool_use', toolSpy);

    await feedEvents('a1', [{
      type: 'assistant',
      session_id: 's1',
      error: null,
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
        ],
      },
    }]);

    expect(toolSpy).toHaveBeenCalledWith('a1', 'Read', 'tu-1');
  });

  it('emits text for assistant text blocks', async () => {
    const textSpy = vi.fn();
    parser.on('text', textSpy);

    await feedEvents('a1', [{
      type: 'assistant',
      session_id: 's1',
      error: null,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }]);

    expect(textSpy).toHaveBeenCalledWith('a1', 'Hello');
  });

  it('emits rate_limited for 429 retry events', async () => {
    const rateSpy = vi.fn();
    parser.on('rate_limited', rateSpy);

    await feedEvents('a1', [{
      type: 'system',
      subtype: 'api_retry',
      session_id: 's1',
      attempt: 1,
      error: 'rate_limit',
      error_status: 429,
    }]);

    expect(rateSpy).toHaveBeenCalledWith('a1', 'rate_limit');
  });

  it('emits rate_limited for assistant rate_limit error', async () => {
    const rateSpy = vi.fn();
    parser.on('rate_limited', rateSpy);

    await feedEvents('a1', [{
      type: 'assistant',
      session_id: 's1',
      error: 'rate_limit',
      parent_tool_use_id: null,
      message: { content: [] },
    }]);

    expect(rateSpy).toHaveBeenCalledWith('a1', 'rate_limit');
  });

  it('emits error for non-rate-limit assistant errors', async () => {
    const errorSpy = vi.fn();
    parser.on('error', errorSpy);

    await feedEvents('a1', [{
      type: 'assistant',
      session_id: 's1',
      error: 'internal_error',
      parent_tool_use_id: null,
      message: { content: [] },
    }]);

    expect(errorSpy).toHaveBeenCalledWith('a1', 'internal_error');
  });

  it('emits tool_result for user tool_result blocks', async () => {
    const resultSpy = vi.fn();
    parser.on('tool_result', resultSpy);

    await feedEvents('a1', [{
      type: 'user',
      session_id: 's1',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok', is_error: false },
        ],
      },
    }]);

    expect(resultSpy).toHaveBeenCalledWith('a1', 'tu-1', false);
  });

  it('emits result for result events', async () => {
    const resSpy = vi.fn();
    parser.on('result', resSpy);

    await feedEvents('a1', [{
      type: 'result',
      subtype: 'success',
      session_id: 's1',
      duration_ms: 1000,
      is_error: false,
      num_turns: 2,
      result: 'All done',
      total_cost_usd: 0.03,
      usage: { input_tokens: 100, output_tokens: 50 },
    }]);

    expect(resSpy).toHaveBeenCalledWith('a1', expect.objectContaining({
      type: 'result',
      subtype: 'success',
    }));
  });

  it('emits context_percent when present on events', async () => {
    const ctxSpy = vi.fn();
    parser.on('context_percent', ctxSpy);

    await feedEvents('a1', [{
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      model: 'm',
      tools: [],
      cwd: '/',
      context_percent: 42,
    }]);

    expect(ctxSpy).toHaveBeenCalledWith('a1', 42);
  });
});

// ── StreamParser watch/unwatch lifecycle ────────────────────────────────────

describe('StreamParser lifecycle', () => {
  let parser: StreamParser;

  beforeEach(() => {
    parser = new StreamParser();
  });

  afterEach(() => {
    parser.unwatchAll();
  });

  it('watch replaces existing watcher for same agentId', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sp-'));
    const f1 = join(tmpDir, 'a.jsonl');
    const f2 = join(tmpDir, 'b.jsonl');
    writeFileSync(f1, '', 'utf8');
    writeFileSync(f2, '', 'utf8');

    parser.watch('a1', f1);
    parser.watch('a1', f2); // should replace, not duplicate

    // unwatch should clean up without error
    parser.unwatch('a1');
  });

  it('unwatch is safe to call for non-watched agent', () => {
    expect(() => parser.unwatch('nonexistent')).not.toThrow();
  });

  it('unwatchAll clears all watchers', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sp-'));
    const f1 = join(tmpDir, 'a.jsonl');
    const f2 = join(tmpDir, 'b.jsonl');
    writeFileSync(f1, '', 'utf8');
    writeFileSync(f2, '', 'utf8');

    parser.watch('a1', f1);
    parser.watch('a2', f2);

    expect(() => parser.unwatchAll()).not.toThrow();
  });
});
