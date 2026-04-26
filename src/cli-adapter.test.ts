import { describe, expect, it } from 'vitest';
import { buildAgentCommand, extractSessionIdFromText, splitArgString } from './cli-adapter.js';
import type { Agent, AgentConfig } from './types.js';

const agent: Agent = {
  id: 'agent-1',
  name: 'worker',
  cli: 'claude',
  workspaceId: 'workspace-1',
  surfaceId: 'surface-1',
  status: 'working',
  cwd: "/tmp/project's",
};

const config: AgentConfig = {
  command: 'claude',
  printFlag: '--print',
  resumeFlag: '--resume',
  skipPermissions: '--dangerously-skip-permissions',
  supportsResume: true,
  supportsStreamJson: true,
  streamJsonFlags: '--output-format stream-json',
};

describe('cli-adapter', () => {
  it('builds a quoted command with stream-json tee output', () => {
    const command = buildAgentCommand({
      config,
      agent,
      inboxPath: '/tmp/inbox.md',
      streamPath: '/tmp/stream.jsonl',
    });

    expect(command).toContain("cd '/tmp/project'\\''s' &&");
    expect(command).toContain("'claude' '--print' '--output-format' 'stream-json'");
    expect(command).toContain("< '/tmp/inbox.md'");
    expect(command).toContain("stream-formatter.js' '/tmp/stream.jsonl'");
  });

  it('includes resume args when a session id is known', () => {
    const command = buildAgentCommand({
      config,
      agent: { ...agent, sessionId: 'claude-session-123' },
      inboxPath: '/tmp/inbox.md',
    });

    expect(command).toContain("'--resume' 'claude-session-123'");
  });

  it('builds a prompt-flag non-interactive command with stdin content', () => {
    const command = buildAgentCommand({
      config: {
        command: 'custom-cli',
        printFlag: '',
        resumeFlag: '--resume',
        skipPermissions: '--allow-all',
        supportsResume: true,
        supportsStreamJson: true,
        streamJsonFlags: '--output-format stream-json',
        inputMode: 'prompt-flag',
        promptFlag: '--prompt',
      },
      agent,
      inboxPath: '/tmp/inbox.md',
      streamPath: '/tmp/custom.jsonl',
    });

    expect(command).toContain("'custom-cli' '--output-format' 'stream-json' '--allow-all' '--prompt'");
    expect(command).toContain("$(cat '/tmp/inbox.md')");
    expect(command).not.toContain('< ');
    expect(command).toContain("stream-formatter.js' '/tmp/custom.jsonl'");
  });

  it('builds a Codex command with positional mode', () => {
    const command = buildAgentCommand({
      config: {
        command: 'codex exec',
        printFlag: '',
        skipPermissions: '--full-auto',
        supportsResume: false,
        supportsStreamJson: false,
        inputMode: 'positional',
      },
      agent: { ...agent, cli: 'codex' },
      inboxPath: '/tmp/inbox.md',
    });

    expect(command).toContain("'codex' 'exec'");
    expect(command).toContain("'--full-auto'");
    expect(command).toContain("$(cat '/tmp/inbox.md')");
    expect(command).not.toContain('< ');
    expect(command).not.toContain('--prompt');
  });

  it('requires promptFlag for prompt-flag input mode', () => {
    expect(() => buildAgentCommand({
      config: {
        command: 'custom-cli',
        printFlag: '',
        skipPermissions: '',
        supportsResume: false,
        supportsStreamJson: false,
        inputMode: 'prompt-flag',
      },
      agent,
      inboxPath: '/tmp/inbox.md',
    })).toThrow(/promptFlag is required/);
  });

  it('extracts session ids from common JSON and text shapes', () => {
    expect(extractSessionIdFromText('{"session_id":"abc123456"}\n')).toBe('abc123456');
    expect(extractSessionIdFromText('{"session":{"id":"nested-session-1"}}\n')).toBe('nested-session-1');
    expect(extractSessionIdFromText('session id: plain-session-1\n')).toBe('plain-session-1');
  });

  it('rejects shell metacharacters in configured argument strings', () => {
    expect(() => splitArgString('--print; rm -rf /', 'flag')).toThrow(/metacharacter/);
  });
});
