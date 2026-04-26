import { mkdtempSync, appendFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileProtocol } from './file-protocol.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'auto-cmux-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('FileProtocol', () => {
  it('reads only complete new JSON lines and advances the offset', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);
    protocol.initAgentDir('agent-1');

    const actionsPath = join(root, 'agents', 'agent-1', 'actions.md');
    appendFileSync(actionsPath, '{"action":"status","text":"working"}\n{"action":"done"', 'utf8');

    expect(protocol.readNewActions('agent-1')).toEqual({
      actions: [{ action: 'status', text: 'working' }],
      errors: [],
    });

    appendFileSync(actionsPath, ',"summary":"ok"}\n', 'utf8');
    expect(protocol.readNewActions('agent-1')).toEqual({
      actions: [{ action: 'done', summary: 'ok' }],
      errors: [],
    });

    expect(protocol.readNewActions('agent-1')).toEqual({ actions: [], errors: [] });
    expect(readFileSync(join(root, 'agents', 'agent-1', 'actions.offset'), 'utf8')).toMatch(/^\d+$/);
  });

  it('peekAll does not consume actions', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);
    protocol.initAgentDir('agent-1');

    appendFileSync(
      join(root, 'agents', 'agent-1', 'actions.md'),
      '{"action":"done","summary":"ok"}\n',
      'utf8',
    );

    expect(protocol.peekAll('agent-1')).toEqual([{ action: 'done', summary: 'ok' }]);
    expect(protocol.peekAll('agent-1')).toEqual([{ action: 'done', summary: 'ok' }]);
    expect(protocol.readNewActions('agent-1').actions).toEqual([{ action: 'done', summary: 'ok' }]);
  });

  it('reads complete stream output lines with an independent offset', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);
    protocol.initAgentDir('agent-1');

    const streamPath = join(root, 'agents', 'agent-1', 'stream.jsonl');
    appendFileSync(streamPath, '{"session_id":"abc123"}\n{"partial"', 'utf8');

    expect(protocol.readNewStreamText('agent-1')).toBe('{"session_id":"abc123"}\n');

    appendFileSync(streamPath, ':"held"}\n', 'utf8');
    expect(protocol.readNewStreamText('agent-1')).toBe('{"partial":"held"}\n');
    expect(protocol.readNewStreamText('agent-1')).toBe('');
  });

  // ── Envelope conversion ──

  it('toEnvelope converts a done action to envelope', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);

    const envelope = protocol.toEnvelope('agent-1', { action: 'done', summary: 'task completed' });
    expect(envelope.ok).toBe(true);
    expect(envelope.action).toBe('done');
    expect(envelope.agentId).toBe('agent-1');
    expect(envelope.data).toEqual({ summary: 'task completed' });
    expect(envelope.error).toBeUndefined();
    expect(typeof envelope.timestamp).toBe('number');
  });

  it('toEnvelope converts an error action to envelope', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);

    const envelope = protocol.toEnvelope('agent-1', { action: 'error', message: 'something broke' });
    expect(envelope.ok).toBe(false);
    expect(envelope.action).toBe('error');
    expect(envelope.error).toBe('something broke');
  });

  it('toEnvelope handles action with no extra fields', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);

    const envelope = protocol.toEnvelope('agent-1', { action: 'done' });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeUndefined();
  });

  it('readNewEnvelopes returns envelopes', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);
    protocol.initAgentDir('agent-1');

    const actionsPath = join(root, 'agents', 'agent-1', 'actions.md');
    appendFileSync(actionsPath, '{"action":"status","text":"working"}\n{"action":"done","summary":"ok"}\n', 'utf8');

    const { envelopes, errors } = protocol.readNewEnvelopes('agent-1');
    expect(errors).toHaveLength(0);
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0].action).toBe('status');
    expect(envelopes[0].ok).toBe(true);
    expect(envelopes[1].action).toBe('done');
    expect(envelopes[1].data).toEqual({ summary: 'ok' });
  });

  // ── Broadcast ──

  it('broadcast sends to multiple agents', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);
    protocol.initAgentDir('agent-1');
    protocol.initAgentDir('agent-2');
    protocol.initAgentDir('agent-3');

    protocol.broadcast(['agent-1', 'agent-3'], 'Hello all!');

    const inbox1 = readFileSync(join(root, 'agents', 'agent-1', 'inbox.md'), 'utf8');
    const inbox2 = readFileSync(join(root, 'agents', 'agent-2', 'inbox.md'), 'utf8');
    const inbox3 = readFileSync(join(root, 'agents', 'agent-3', 'inbox.md'), 'utf8');

    expect(inbox1).toBe('Hello all!');
    expect(inbox2).toBe('');
    expect(inbox3).toBe('Hello all!');
  });

  // ── New action types parsing ──

  it('parses new action types (report_to_pm, ask, answer, remember_role, delegate_to)', () => {
    const root = makeRoot();
    const protocol = new FileProtocol(root);
    protocol.initAgentDir('agent-1');

    const actionsPath = join(root, 'agents', 'agent-1', 'actions.md');
    const lines = [
      '{"action":"report_to_pm","type":"progress","summary":"50% done"}',
      '{"action":"ask","to":"backend","question":"what API?"}',
      '{"action":"answer","to":"frontend","question":"what API?","answer":"/api/v2"}',
      '{"action":"remember_role","insight":"always run lint before commit"}',
      '{"action":"delegate_to","role":"qa","task":"test the login flow"}',
    ];
    appendFileSync(actionsPath, lines.join('\n') + '\n', 'utf8');

    const { actions, errors } = protocol.readNewActions('agent-1');
    expect(errors).toHaveLength(0);
    expect(actions).toHaveLength(5);
    expect(actions[0].action).toBe('report_to_pm');
    expect(actions[1].action).toBe('ask');
    expect(actions[2].action).toBe('answer');
    expect(actions[3].action).toBe('remember_role');
    expect(actions[4].action).toBe('delegate_to');
  });
});
