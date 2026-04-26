import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import type { AgentCli, AgentConfig } from './types.js';

const DEFAULT_CONFIGS: Record<AgentCli, AgentConfig> = {
  claude: {
    command: 'claude',
    printFlag: '--print',
    resumeFlag: '--resume',
    sessionFlag: '--session-id',
    skipPermissions: '--dangerously-skip-permissions',
    supportsResume: true,
    supportsStreamJson: true,
    streamJsonFlags: '--verbose --output-format stream-json',
    inputMode: 'stdin',
    modelFlag: '--model',
  },
  codex: {
    command: 'codex exec',
    printFlag: '',
    skipPermissions: '--full-auto --skip-git-repo-check',
    supportsResume: false,
    supportsStreamJson: false,
    inputMode: 'positional',
    modelFlag: '--model',
  },
};

interface ConfigFile {
  agents?: Record<string, Partial<AgentConfig>>;
}

let loadedOverrides: Record<string, Partial<AgentConfig>> | null = null;

export function loadConfig(basePath?: string): void {
  const configPath = basePath
    ? join(basePath, 'config.yml')
    : join(process.cwd(), 'config.yml');

  if (!existsSync(configPath)) {
    loadedOverrides = null;
    return;
  }

  const raw = readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as ConfigFile | null;
  loadedOverrides = parsed?.agents ?? null;
}

export function getAgentConfig(cli: string): AgentConfig {
  const base = DEFAULT_CONFIGS[cli as AgentCli];
  if (!base && !loadedOverrides?.[cli]) {
    throw new Error(`Unknown CLI: ${cli}. Available: ${Object.keys(DEFAULT_CONFIGS).join(', ')}`);
  }

  const override = loadedOverrides?.[cli];
  if (!override) return { ...base };

  return {
    command: override.command ?? base?.command ?? cli,
    printFlag: override.printFlag ?? base?.printFlag ?? '',
    resumeFlag: override.resumeFlag ?? base?.resumeFlag,
    sessionFlag: override.sessionFlag ?? base?.sessionFlag,
    skipPermissions: override.skipPermissions ?? base?.skipPermissions ?? '',
    supportsResume: override.supportsResume ?? base?.supportsResume ?? false,
    supportsStreamJson: override.supportsStreamJson ?? base?.supportsStreamJson ?? false,
    streamJsonFlags: override.streamJsonFlags ?? base?.streamJsonFlags,
    inputMode: override.inputMode ?? base?.inputMode ?? 'stdin',
    promptFlag: override.promptFlag ?? base?.promptFlag,
    modelFlag: override.modelFlag ?? base?.modelFlag,
  };
}
