import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAgentConfig, loadConfig } from './config.js';

describe('config', () => {
  afterEach(() => {
    loadConfig(mkdtempSync(join(tmpdir(), 'auto-cmux-config-')));
  });

  it('uses CLI defaults that match non-interactive modes', () => {
    loadConfig(mkdtempSync(join(tmpdir(), 'auto-cmux-config-')));

    expect(getAgentConfig('claude')).toMatchObject({
      command: 'claude',
      printFlag: '--print',
      inputMode: 'stdin',
      supportsResume: true,
    });
    expect(getAgentConfig('codex')).toMatchObject({
      command: 'codex exec',
      skipPermissions: '--full-auto --skip-git-repo-check',
      inputMode: 'positional',
      supportsStreamJson: false,
    });
  });

  it('allows config.yml overrides for custom CLIs', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-cmux-config-'));
    writeFileSync(join(root, 'config.yml'), `
agents:
  local-agent:
    command: local-agent run
    inputMode: prompt-flag
    promptFlag: --prompt
    supportsResume: false
    supportsStreamJson: false
`, 'utf8');

    loadConfig(root);
    expect(getAgentConfig('local-agent')).toMatchObject({
      command: 'local-agent run',
      inputMode: 'prompt-flag',
      promptFlag: '--prompt',
    });
  });
});
