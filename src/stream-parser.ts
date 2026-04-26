import { open, stat } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { EventEmitter } from 'events';

/**
 * Tails a JSONL file (Claude Code --output-format stream-json) and emits
 * typed events as new lines are appended.
 *
 * This replaces most of what pty-monitor does for Claude Code agents:
 * - session_id capture (from init event)
 * - tool use tracking (from assistant events)
 * - rate limit detection (from assistant error field)
 * - cost/token tracking (from result event)
 * - completion detection (from result event)
 */

// ── Event types from Claude Code stream-json ──────────────────

export interface StreamInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  tools: string[];
  cwd: string;
  [key: string]: unknown;
}

export interface StreamAssistantEvent {
  type: 'assistant';
  session_id: string;
  message: {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
    };
  };
  error: string | null;
  parent_tool_use_id: string | null;
}

export interface StreamUserEvent {
  type: 'user';
  session_id: string;
  message: {
    content: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error: boolean;
    }>;
  };
}

export interface StreamResultEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd';
  session_id: string;
  duration_ms: number;
  is_error: boolean;
  num_turns: number;
  result?: string;
  errors?: string[];
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface StreamRetryEvent {
  type: 'system';
  subtype: 'api_retry';
  session_id: string;
  attempt: number;
  error: string;
  error_status: number;
}

export type StreamEvent =
  | StreamInitEvent
  | StreamAssistantEvent
  | StreamUserEvent
  | StreamResultEvent
  | StreamRetryEvent
  | { type: string; [key: string]: unknown };

// ── StreamParser ──────────────────────────────────────────────

export interface StreamParserEvents {
  'init': (agentId: string, event: StreamInitEvent) => void;
  'tool_use': (agentId: string, toolName: string, toolId: string) => void;
  'tool_result': (agentId: string, toolId: string, isError: boolean) => void;
  'text': (agentId: string, text: string) => void;
  'result': (agentId: string, event: StreamResultEvent) => void;
  'error': (agentId: string, error: string) => void;
  'rate_limited': (agentId: string, error: string) => void;
  'context_percent': (agentId: string, percent: number) => void;
  'event': (agentId: string, event: StreamEvent) => void;
}

/** Extract a human-readable summary from a completed stream.jsonl file */
export interface AgentOutput {
  sessionId?: string;
  model?: string;
  /** Final text result from the agent */
  result?: string;
  /** All text blocks from assistant messages (conversation flow) */
  textBlocks: string[];
  /** Sequence of events for conversation flow */
  timeline: TimelineEvent[];
  /** Tool calls made: [{name, id}] */
  toolCalls: Array<{ name: string; id: string }>;
  /** Completion status */
  status: 'success' | 'error' | 'running' | 'unknown';
  /** Error messages if any */
  errors: string[];
  /** Cost in USD */
  costUsd?: number;
  /** Number of turns */
  turns?: number;
  /** Token usage */
  usage?: { input_tokens: number; output_tokens: number };
}

export interface TimelineEvent {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  id?: string;
  content?: string;
  isError?: boolean;
}

export function parseStreamFile(filePath: string): AgentOutput {
  const output: AgentOutput = {
    textBlocks: [],
    timeline: [],
    toolCalls: [],
    status: 'unknown',
    errors: [],
  };

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return output;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;

    let event: Record<string, any>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          output.sessionId = event.session_id;
          output.model = event.model;
          output.status = 'running';
        }
        break;

      case 'assistant':
        if (event.error) {
          output.errors.push(event.error);
          break;
        }
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            output.textBlocks.push(block.text);
            output.timeline.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            output.toolCalls.push({ name: block.name, id: block.id });
            output.timeline.push({ type: 'tool_use', name: block.name, id: block.id });
          }
        }
        break;

      case 'user':
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_result') {
            const summary = summarizeToolResult(event.tool_use_result || block.content);
            output.timeline.push({
              type: 'tool_result',
              id: block.tool_use_id,
              content: summary,
              isError: block.is_error
            });
          }
        }
        break;

      case 'result':
        output.status = event.subtype === 'success' ? 'success' : 'error';
        output.result = event.result;
        output.costUsd = event.total_cost_usd;
        output.turns = event.num_turns;
        output.usage = event.usage;
        output.sessionId = event.session_id;
        if (event.errors) output.errors.push(...event.errors);
        break;
    }
  }

  return output;
}

function summarizeToolResult(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') {
    if (result.length > 1000) return result.slice(0, 1000) + '... (truncated)';
    return result;
  }

  // Handle Claude Code structured patches
  if (result.structuredPatch) {
    const patches = Array.isArray(result.structuredPatch) ? result.structuredPatch : [result.structuredPatch];
    const summary = patches.map((p: any) => `  [Patch] ${p.file_path || p.filePath || 'file'}: L${p.oldStart || '?'}-${(p.oldStart || 0) + (p.oldLines || 0)} -> L${p.newStart || '?'}-${(p.newStart || 0) + (p.newLines || 0)}`).join('\n');
    return summary || '[Patch applied]';
  }

  // Handle tool results that have a large 'content' field
  if (result.content && typeof result.content === 'string' && result.content.length > 500) {
    return result.content.slice(0, 500) + `... (${result.content.length} chars total)`;
  }

  // Handle read_file / view_file results where content is nested under 'file'
  if (result.file && result.file.content && typeof result.file.content === 'string') {
    const filePath = result.file.filePath || result.file.path || 'file';
    const content = result.file.content;
    if (content.length > 500) {
      return `[Read ${filePath}]\n${content.slice(0, 500)}... (${content.length} chars total)`;
    }
    return `[Read ${filePath}]\n${content}`;
  }

  // Fallback: if it's a large object, just summarize keys
  const keys = Object.keys(result);
  if (keys.length > 10) {
    return `{ ${keys.slice(0, 5).join(', ')}, ... (${keys.length} keys total) }`;
  }

  try {
    const str = JSON.stringify(result, null, 2);
    if (str.length > 1000) return str.slice(0, 1000) + '... (JSON truncated)';
    return str;
  } catch {
    return '[Complex object]';
  }
}

const POLL_INTERVAL = 200;

export class StreamParser extends EventEmitter {
  private watchers = new Map<string, { filePath: string; offset: number; timer: NodeJS.Timeout; polling: boolean }>();

  watch(agentId: string, streamFilePath: string, startOffset?: number): void {
    if (this.watchers.has(agentId)) {
      this.unwatch(agentId);
    }

    const state = {
      filePath: streamFilePath,
      offset: startOffset ?? 0,
      timer: setInterval(() => this.poll(agentId), POLL_INTERVAL),
      polling: false,
    };
    this.watchers.set(agentId, state);
  }

  unwatch(agentId: string): void {
    const state = this.watchers.get(agentId);
    if (state) {
      clearInterval(state.timer);
      this.watchers.delete(agentId);
    }
  }

  unwatchAll(): void {
    for (const agentId of [...this.watchers.keys()]) {
      this.unwatch(agentId);
    }
  }

  private async poll(agentId: string): Promise<void> {
    const state = this.watchers.get(agentId);
    if (!state) return;

    // Guard against overlapping polls (async poll may exceed POLL_INTERVAL)
    if (state.polling) return;
    state.polling = true;
    try {
      await this.doPoll(agentId, state);
    } finally {
      state.polling = false;
    }
  }

  private async doPoll(agentId: string, state: { filePath: string; offset: number }): Promise<void> {
    if (!existsSync(state.filePath)) return;

    let fileSize: number;
    try {
      const s = await stat(state.filePath);
      fileSize = s.size;
    } catch {
      return;
    }

    if (fileSize <= state.offset) return;

    let fh;
    try {
      fh = await open(state.filePath, 'r');
      const len = fileSize - state.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, state.offset);

      const text = buf.toString('utf-8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) return;

      const complete = text.slice(0, lastNewline + 1);
      state.offset += Buffer.byteLength(complete, 'utf-8');

      for (const line of complete.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: StreamEvent;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue;
        }

        this.emit('event', agentId, event);
        this.processEvent(agentId, event);
      }
    } catch {
      // File may be temporarily unavailable
    } finally {
      await fh?.close();
    }
  }

  private processEvent(agentId: string, event: StreamEvent): void {
    switch (event.type) {
      case 'system': {
        const sysEvent = event as StreamInitEvent | StreamRetryEvent;
        if (sysEvent.subtype === 'init') {
          this.emit('init', agentId, sysEvent as StreamInitEvent);
        } else if (sysEvent.subtype === 'api_retry') {
          const retry = sysEvent as StreamRetryEvent;
          if (retry.error === 'rate_limit' || retry.error_status === 429) {
            this.emit('rate_limited', agentId, retry.error);
          }
        }
        // Detect context_percent from system events (if emitted by the runtime)
        const raw = event as Record<string, unknown>;
        if (typeof raw.context_percent === 'number') {
          this.emit('context_percent', agentId, raw.context_percent);
        }
        break;
      }

      case 'assistant': {
        const assistant = event as StreamAssistantEvent;
        if (assistant.error === 'rate_limit') {
          this.emit('rate_limited', agentId, 'rate_limit');
          break;
        }
        if (assistant.error) {
          this.emit('error', agentId, assistant.error);
          break;
        }
        for (const block of assistant.message?.content ?? []) {
          if (block.type === 'tool_use') {
            this.emit('tool_use', agentId, block.name, block.id);
          } else if (block.type === 'text') {
            this.emit('text', agentId, block.text);
          }
        }
        // Check for context_percent in usage data
        const rawAssistant = event as Record<string, unknown>;
        if (typeof rawAssistant.context_percent === 'number') {
          this.emit('context_percent', agentId, rawAssistant.context_percent);
        }
        break;
      }

      case 'user': {
        const user = event as StreamUserEvent;
        for (const block of user.message?.content ?? []) {
          if (block.type === 'tool_result') {
            this.emit('tool_result', agentId, block.tool_use_id, block.is_error);
          }
        }
        break;
      }

      case 'result': {
        this.emit('result', agentId, event as StreamResultEvent);
        const rawResult = event as Record<string, unknown>;
        if (typeof rawResult.context_percent === 'number') {
          this.emit('context_percent', agentId, rawResult.context_percent);
        }
        break;
      }
    }
  }
}
