import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Agent, AgentConfig } from './types.js';

export interface BuildCommandInput {
  config: AgentConfig;
  agent: Agent;
  inboxPath: string;
  streamPath?: string;
}

export function buildAgentCommand(input: BuildCommandInput): string {
  const { config, agent, inboxPath, streamPath } = input;
  const argv: string[] = [];

  argv.push(...splitArgString(config.command, 'command'));
  argv.push(...splitArgString(config.printFlag, 'printFlag'));

  if (config.supportsStreamJson && config.streamJsonFlags) {
    argv.push(...splitArgString(config.streamJsonFlags, 'streamJsonFlags'));
  }

  if (config.supportsResume && agent.sessionId && config.resumeFlag) {
    argv.push(...splitArgString(config.resumeFlag, 'resumeFlag'), agent.sessionId);
  }

  argv.push(...splitArgString(config.skipPermissions, 'skipPermissions'));

  // Model override
  if (agent.model && config.modelFlag) {
    argv.push(...splitArgString(config.modelFlag, 'modelFlag'), agent.model);
  }
  // Build the input portion based on inputMode
  const inputMode = config.inputMode ?? 'stdin';
  let command: string;
  if (inputMode === 'prompt-flag') {
    const flags = splitArgString(config.promptFlag, 'promptFlag');
    if (flags.length === 0) {
      throw new Error('promptFlag is required when inputMode is prompt-flag');
    }
    // Pass file content via $(cat ...) — needs shell expansion, not quoting
    const base = argv.map(shellQuote).join(' ');
    const flagStr = flags.map(shellQuote).join(' ');
    command = `${base} ${flagStr} "$(cat ${shellQuote(inboxPath)})"`;
  } else if (inputMode === 'positional') {
    // Pass file content as positional argument via $(cat ...)
    const base = argv.map(shellQuote).join(' ');
    command = `${base} "$(cat ${shellQuote(inboxPath)})"`;
  } else {
    // stdin mode: pipe inbox via redirect
    command = `${argv.map(shellQuote).join(' ')} < ${shellQuote(inboxPath)}`;
  }

  // Use the stream formatter to tee JSON to the streamPath while rendering pretty text to the terminal
  const formatterPath = join(dirname(fileURLToPath(import.meta.url)), 'stream-formatter.js');
  
  const visibleCommand = config.supportsStreamJson && streamPath
    ? `${command} 2>&1 | node ${shellQuote(formatterPath)} ${shellQuote(streamPath)}`
    : command;

  return `cd ${shellQuote(agent.cwd)} && ${visibleCommand}`;
}

export function extractSessionIdFromText(text: string): string | null {
  let found: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = tryParseJson(trimmed);
    if (parsed !== null) {
      const id = extractSessionIdFromValue(parsed);
      if (id) found = id;
      continue;
    }

    const match = trimmed.match(/(?:session[_ -]?id|sessionId)["':=\s]+([A-Za-z0-9._:-]{6,})/i);
    if (match?.[1]) found = match[1];
  }
  return found;
}

export function extractSessionIdFromValue(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== 'object' || depth > 5) return null;
  const record = value as Record<string, unknown>;

  for (const key of ['session_id', 'sessionId']) {
    const direct = record[key];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
  }

  const session = record.session;
  if (session && typeof session === 'object') {
    const nested = session as Record<string, unknown>;
    for (const key of ['id', 'session_id', 'sessionId']) {
      const direct = nested[key];
      if (typeof direct === 'string' && direct.trim()) return direct.trim();
    }
  }

  for (const child of Object.values(record)) {
    const nested = extractSessionIdFromValue(child, depth + 1);
    if (nested) return nested;
  }

  return null;
}

export function splitArgString(value: string | undefined, label: string): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];

  const out: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of trimmed) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    if (';&|`$(){}[]<>!#*?\n\r'.includes(ch)) {
      throw new Error(`${label} contains unsupported shell metacharacter: ${ch}`);
    }
    current += ch;
  }

  if (escaping) current += '\\';
  if (quote) throw new Error(`${label} has an unterminated quote`);
  if (current) out.push(current);
  return out;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function tryParseJson(line: string): unknown | null {
  if (!line.startsWith('{') && !line.startsWith('[')) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
