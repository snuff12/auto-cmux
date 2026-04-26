import { createWriteStream } from 'fs';
import { createInterface } from 'readline';

const streamPath = process.argv[2];
if (!streamPath) {
  console.error('Usage: node stream-formatter.js <stream.jsonl>');
  process.exit(1);
}

const fileStream = createWriteStream(streamPath, { flags: 'a' });

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function summarizeToolResult(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') {
    if (result.length > 500) return result.slice(0, 500) + '... (truncated)';
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
    if (str.length > 500) return str.slice(0, 500) + '... (JSON truncated)';
    return str;
  } catch {
    return '[Complex object]';
  }
}

rl.on('line', (line) => {
  // 1. Write raw line to file
  fileStream.write(line + '\n');

  // 2. Parse and format for terminal output
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    // Not JSON, just print it
    console.log(line);
    return;
  }

  try {
    const event = JSON.parse(trimmed);

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          console.log(`\n\x1b[36m[System]\x1b[0m Session started: ${event.session_id}`);
        } else if (event.subtype === 'api_retry') {
          console.log(`\x1b[33m[Retry]\x1b[0m Attempt ${event.attempt} due to ${event.error}`);
        } else if (event.subtype === 'context_percent' || typeof event.context_percent === 'number') {
          // ignore purely numeric updates to reduce noise
        }
        break;

      case 'assistant':
        if (event.error) {
          console.log(`\x1b[31m[Error]\x1b[0m ${event.error}`);
          break;
        }
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            console.log(block.text);
          } else if (block.type === 'tool_use') {
            console.log(`\n\x1b[35m[Tool Use: ${block.name}]\x1b[0m`);
          }
        }
        break;

      case 'user':
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_result') {
            const summary = summarizeToolResult(event.tool_use_result || block.content);
            if (block.is_error) {
              console.log(`\x1b[31m[Tool Error]\x1b[0m ${summary}`);
            } else {
              console.log(`\x1b[32m[Tool Result]\x1b[0m\n${summary}\n`);
            }
          }
        }
        break;

      case 'result':
        if (event.subtype === 'success') {
          console.log(`\n\x1b[32m[Success]\x1b[0m Turns: ${event.num_turns}, Cost: $${(event.total_cost_usd || 0).toFixed(4)}`);
        } else {
          console.log(`\n\x1b[31m[${event.subtype}]\x1b[0m Turns: ${event.num_turns}, Cost: $${(event.total_cost_usd || 0).toFixed(4)}`);
        }
        if (event.result) {
          console.log(event.result);
        }
        break;
      
      default:
        // Ignore other verbose events
        break;
    }
  } catch {
    // If it's malformed JSON somehow, just print it
    console.log(line);
  }
});
