import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { CmuxClient } from './cmux-client.js';
import { getAgentConfig, loadConfig } from './config.js';
import {
  loadProjectConfig,
  validateProjectConfigReferences,
} from './config-loader.js';
import { splitArgString } from './cli-adapter.js';
import type { AgentCli, ProjectConfig } from './types.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  status: CheckStatus;
  label: string;
  detail?: string;
  hint?: string;
}

function check(status: CheckStatus, label: string, detail?: string, hint?: string): DoctorCheck {
  return { status, label, detail, hint };
}

function formatStatus(status: CheckStatus): string {
  if (status === 'ok') return '[ok]';
  if (status === 'warn') return '[warn]';
  return '[fail]';
}

function selectedClis(config: ProjectConfig): AgentCli[] {
  const values = new Set<AgentCli>();
  for (const cli of config.project.clis) values.add(cli);
  for (const role of config.agents.roles) values.add(role.cli);
  if (values.size === 0) values.add('claude');
  return [...values];
}

function commandExists(command: string): boolean {
  const first = splitArgString(command, 'command')[0];
  if (!first) return false;
  const result = spawnSync(first, ['--version'], { stdio: 'ignore' });
  return !result.error || (result.error as NodeJS.ErrnoException).code !== 'ENOENT';
}

async function checkCmux(): Promise<DoctorCheck> {
  const client = new CmuxClient({ requestTimeout: 3000, reconnect: false, pingInterval: 0 });
  try {
    await client.connect();
    try {
      await client.ping();
    } catch {
      // Older cmux builds may not support ping; a socket connection is still useful.
    }
    return check('ok', 'cmux socket connection', 'connected');
  } catch (err) {
    return check(
      'fail',
      'cmux socket connection',
      err instanceof Error ? err.message : String(err),
      'Start cmux first or set CMUX_SOCKET_PATH to the active socket.',
    );
  } finally {
    client.disconnect();
  }
}

function checkGit(projectRoot: string): DoctorCheck {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: projectRoot, stdio: 'ignore' });
    return check('ok', 'git repository', 'available');
  } catch {
    return check('warn', 'git repository', 'not detected', 'Worktree isolation will be skipped outside a git repository.');
  }
}

export function checkMcpJson(projectRoot: string): DoctorCheck {
  const mcpPath = join(projectRoot, '.mcp.json');
  if (!existsSync(mcpPath)) {
    return check('warn', '.mcp.json', 'not found', 'Run auto-cmux init or add the auto-cmux MCP server manually.');
  }

  try {
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown }>;
    };
    const server = parsed.mcpServers?.['auto-cmux'];
    if (!server) {
      return check('fail', '.mcp.json', 'auto-cmux server entry is missing', 'Add mcpServers.auto-cmux or run auto-cmux init.');
    }
    if (typeof server.command !== 'string' || server.command.trim() === '') {
      return check('fail', '.mcp.json', 'auto-cmux server command is missing', 'Set mcpServers.auto-cmux.command to "npx" or "node".');
    }
    return check('ok', '.mcp.json', `auto-cmux server configured (${server.command})`);
  } catch (err) {
    return check('fail', '.mcp.json', err instanceof Error ? err.message : String(err), 'Fix the JSON syntax and run doctor again.');
  }
}

export async function runDoctor(projectRoot = process.cwd()): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  loadConfig(projectRoot);

  let config: ProjectConfig;
  try {
    config = loadProjectConfig(projectRoot);
    checks.push(check('ok', 'auto-cmux.yml', existsSync(join(projectRoot, 'auto-cmux.yml')) ? 'loaded' : 'not found; using defaults'));
  } catch (err) {
    checks.push(check(
      'fail',
      'auto-cmux.yml',
      err instanceof Error ? err.message : String(err),
      'Fix the YAML/schema error and run doctor again.',
    ));
    return checks;
  }

  for (const issue of validateProjectConfigReferences(config, projectRoot)) {
    checks.push(check(issue.level === 'error' ? 'fail' : 'warn', `config ${issue.path}`, issue.message, issue.hint));
  }

  const basePath = resolve(projectRoot, config.project.root || '.', '.auto-cmux');
  checks.push(existsSync(basePath)
    ? check('ok', 'runtime directory', basePath)
    : check('warn', 'runtime directory', `${basePath} does not exist yet`, 'It will be created when the MCP server starts.'));

  checks.push(checkMcpJson(projectRoot));

  for (const cli of selectedClis(config)) {
    try {
      const agentConfig = getAgentConfig(cli);
      checks.push(commandExists(agentConfig.command)
        ? check('ok', `${cli} CLI`, `command: ${agentConfig.command}`)
        : check('fail', `${cli} CLI`, `command not found: ${agentConfig.command}`, `Install ${cli} or remove it from auto-cmux.yml.`));
    } catch (err) {
      checks.push(check('fail', `${cli} CLI config`, err instanceof Error ? err.message : String(err)));
    }
  }

  checks.push(checkGit(resolve(projectRoot, config.project.root || '.')));
  checks.push(await checkCmux());

  return checks;
}

export async function runDoctorCommand(): Promise<void> {
  const checks = await runDoctor();
  const failed = checks.filter(c => c.status === 'fail').length;
  const warned = checks.filter(c => c.status === 'warn').length;

  console.log('auto-cmux doctor');
  for (const item of checks) {
    console.log(`${formatStatus(item.status)} ${item.label}${item.detail ? `: ${item.detail}` : ''}`);
    if (item.hint) console.log(`       ${item.hint}`);
  }
  console.log('');
  console.log(`Summary: ${failed} failed, ${warned} warning(s), ${checks.length - failed - warned} ok`);

  if (failed > 0) process.exitCode = 1;
}
