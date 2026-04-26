import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkMcpJson } from './doctor.js';

describe('doctor', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doctor-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fails when .mcp.json exists without auto-cmux server entry', () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf8');
    const result = checkMcpJson(root);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('auto-cmux server entry is missing');
  });

  it('accepts .mcp.json with auto-cmux server entry', () => {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'auto-cmux': { command: 'node', args: ['./dist/mcp-server.js'] },
      },
    }), 'utf8');
    const result = checkMcpJson(root);
    expect(result.status).toBe('ok');
  });
});
