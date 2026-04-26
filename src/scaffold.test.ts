import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  upsertMarkerBlock,
  removeMarkerBlock,
  generateProtocol,
  generateCulture,
  scaffoldInstructionFiles,
  scaffoldRoleInstructions,
  generateConfigYml,
  generateMcpJson,
  ensureGitignore,
  cleanupInstructionFiles,
} from './scaffold.js';

const MARKER_START = '<!-- auto-cmux:start (do not edit this block manually) -->';
const MARKER_END = '<!-- auto-cmux:end -->';

// ── upsertMarkerBlock ───────────────────────────────────────────────────────

describe('upsertMarkerBlock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  });

  it('creates file with block when file does not exist', () => {
    const f = join(tmpDir, 'sub', 'NEW.md');
    upsertMarkerBlock(f, 'hello');

    const content = readFileSync(f, 'utf8');
    expect(content).toContain(MARKER_START);
    expect(content).toContain('hello');
    expect(content).toContain(MARKER_END);
  });

  it('appends block when file exists without markers', () => {
    const f = join(tmpDir, 'EXISTING.md');
    writeFileSync(f, '# My Doc\n\nSome content.\n', 'utf8');

    upsertMarkerBlock(f, 'injected');

    const content = readFileSync(f, 'utf8');
    expect(content).toContain('# My Doc');
    expect(content).toContain('Some content.');
    expect(content).toContain(MARKER_START);
    expect(content).toContain('injected');
  });

  it('replaces existing block when markers already present', () => {
    const f = join(tmpDir, 'REPLACE.md');
    writeFileSync(f, `before\n${MARKER_START}\nold content\n${MARKER_END}\nafter\n`, 'utf8');

    upsertMarkerBlock(f, 'new content');

    const content = readFileSync(f, 'utf8');
    expect(content).not.toContain('old content');
    expect(content).toContain('new content');
    expect(content).toContain('before');
    expect(content).toContain('after');
  });
});

// ── removeMarkerBlock ───────────────────────────────────────────────────────

describe('removeMarkerBlock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  });

  it('returns false for non-existent file', () => {
    expect(removeMarkerBlock(join(tmpDir, 'nope.md'))).toBe(false);
  });

  it('returns false when no markers present', () => {
    const f = join(tmpDir, 'no-markers.md');
    writeFileSync(f, '# Clean doc\n', 'utf8');
    expect(removeMarkerBlock(f)).toBe(false);
  });

  it('removes marker block and returns true', () => {
    const f = join(tmpDir, 'with-markers.md');
    writeFileSync(f, `before\n\n${MARKER_START}\nblock\n${MARKER_END}\n\nafter\n`, 'utf8');

    expect(removeMarkerBlock(f)).toBe(true);

    const content = readFileSync(f, 'utf8');
    expect(content).not.toContain(MARKER_START);
    expect(content).not.toContain('block');
    expect(content).toContain('before');
    expect(content).toContain('after');
  });
});

// ── generateProtocol ────────────────────────────────────────────────────────

describe('generateProtocol', () => {
  it('returns non-empty string with action format documentation', () => {
    const protocol = generateProtocol();
    expect(protocol.length).toBeGreaterThan(100);
    expect(protocol).toContain('action');
    expect(protocol).toContain('done');
    expect(protocol).toContain('error');
    expect(protocol).toContain('spawn');
  });
});

// ── scaffoldInstructionFiles ────────────────────────────────────────────────

describe('scaffoldInstructionFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  });

  it('creates protocol.md for any CLI set', () => {
    const files = scaffoldInstructionFiles({ projectRoot: tmpDir, clis: ['claude'] });
    expect(files).toContain('.auto-cmux/protocol.md');
    expect(existsSync(join(tmpDir, '.auto-cmux', 'protocol.md'))).toBe(true);
  });

  it('creates CULTURE.md with default template', () => {
    const files = scaffoldInstructionFiles({ projectRoot: tmpDir, clis: ['claude'] });
    expect(files).toContain('.auto-cmux/CULTURE.md');
    const content = readFileSync(join(tmpDir, '.auto-cmux', 'CULTURE.md'), 'utf8');
    expect(content).toContain('# Team Culture');
    expect(content).toContain('Communication');
    expect(content).toContain('Code Quality');
    expect(content).toContain('Collaboration');
  });

  it('does not overwrite existing CULTURE.md', () => {
    mkdirSync(join(tmpDir, '.auto-cmux'), { recursive: true });
    writeFileSync(join(tmpDir, '.auto-cmux', 'CULTURE.md'), 'Custom culture', 'utf8');
    const files = scaffoldInstructionFiles({ projectRoot: tmpDir, clis: ['claude'] });
    expect(files).not.toContain('.auto-cmux/CULTURE.md');
    const content = readFileSync(join(tmpDir, '.auto-cmux', 'CULTURE.md'), 'utf8');
    expect(content).toBe('Custom culture');
  });

  it('creates .claude/auto-cmux.md for claude CLI', () => {
    const files = scaffoldInstructionFiles({ projectRoot: tmpDir, clis: ['claude'] });
    expect(files).toContain('.claude/auto-cmux.md');
    const content = readFileSync(join(tmpDir, '.claude', 'auto-cmux.md'), 'utf8');
    expect(content).toContain('Auto-cmux Agent Protocol');
  });

  it('creates AGENTS.md marker block for codex CLI', () => {
    const files = scaffoldInstructionFiles({ projectRoot: tmpDir, clis: ['codex'] });
    expect(files).toContain('AGENTS.md');
    const content = readFileSync(join(tmpDir, 'AGENTS.md'), 'utf8');
    expect(content).toContain(MARKER_START);
  });

  it('handles supported CLIs at once', () => {
    const files = scaffoldInstructionFiles({ projectRoot: tmpDir, clis: ['claude', 'codex'] });
    expect(files).toContain('.auto-cmux/protocol.md');
    expect(files).toContain('.claude/auto-cmux.md');
    expect(files).toContain('AGENTS.md');
  });
});

// ── scaffoldRoleInstructions ────────────────────────────────────────────────

describe('scaffoldRoleInstructions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  });

  it('creates role instruction file with preset content for known roles', () => {
    const path = scaffoldRoleInstructions(tmpDir, 'developer');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('Developer Role');
    expect(content).toContain('Review Loop');
  });

  it('creates generic role file for unknown roles', () => {
    const path = scaffoldRoleInstructions(tmpDir, 'custom-role', 'Does custom things');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('custom-role');
    expect(content).toContain('Does custom things');
  });

  it('does not overwrite existing role file', () => {
    const rolesDir = join(tmpDir, '.auto-cmux', 'roles');
    mkdirSync(rolesDir, { recursive: true });
    const rolePath = join(rolesDir, 'developer.md');
    writeFileSync(rolePath, 'custom content', 'utf8');

    const path = scaffoldRoleInstructions(tmpDir, 'developer');
    expect(readFileSync(path, 'utf8')).toBe('custom content');
  });
});

// ── cleanupInstructionFiles ─────────────────────────────────────────────────

describe('cleanupInstructionFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  });

  it('cleans up claude instruction file', () => {
    // First scaffold, then cleanup
    scaffoldInstructionFiles({ projectRoot: tmpDir, clis: ['claude'] });
    const removed = cleanupInstructionFiles(tmpDir, ['claude']);
    expect(removed).toContain('.claude/auto-cmux.md');

    const content = readFileSync(join(tmpDir, '.claude', 'auto-cmux.md'), 'utf8');
    expect(content).toBe('');
  });

  it('removes marker block from AGENTS.md', () => {
    scaffoldInstructionFiles({ projectRoot: tmpDir, clis: ['codex'] });
    const removed = cleanupInstructionFiles(tmpDir, ['codex']);
    expect(removed).toContain('AGENTS.md (block removed)');
  });

  it('returns empty array when nothing to clean', () => {
    const removed = cleanupInstructionFiles(tmpDir, ['claude']);
    expect(removed).toEqual([]);
  });
});

// ── generateConfigYml ───────────────────────────────────────────────────────

describe('generateConfigYml', () => {
  it('generates valid YAML with project name and roles', () => {
    const yml = generateConfigYml('my-project', ['claude', 'codex'], [
      { id: 'backend', cli: 'claude', model: 'sonnet', description: 'API dev' },
      { id: 'reviewer', cli: 'codex' },
    ]);

    expect(yml).toContain('name: my-project');
    expect(yml).toContain('clis: [claude, codex]');
    expect(yml).toContain('id: backend');
    expect(yml).toContain('cli: claude');
    expect(yml).toContain('model: sonnet');
    expect(yml).toContain('description: "API dev"');
    expect(yml).toContain('id: reviewer');
    expect(yml).toContain('cli: codex');
    expect(yml).toContain('worktreeEnabled: true');
    expect(yml).toContain('dailyLimitCents: 2500');
  });

  it('includes skills when provided', () => {
    const yml = generateConfigYml('proj', ['claude'], [
      { id: 'dev', cli: 'claude', skills: ['code', 'test'] },
    ]);
    expect(yml).toContain('skills: [code, test]');
  });
});

// ── generateMcpJson ─────────────────────────────────────────────────────────

describe('generateMcpJson', () => {
  it('returns valid JSON with auto-cmux server config', () => {
    const json = generateMcpJson();
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers['auto-cmux']).toEqual({
      command: 'npx',
      args: ['auto-cmux'],
    });
  });
});

// ── ensureGitignore ─────────────────────────────────────────────────────────

describe('ensureGitignore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scaffold-'));
  });

  it('creates .gitignore with entry when file does not exist', () => {
    const added = ensureGitignore(tmpDir);
    expect(added).toBe(true);
    const content = readFileSync(join(tmpDir, '.gitignore'), 'utf8');
    expect(content).toContain('.auto-cmux/');
  });

  it('appends entry to existing .gitignore without it', () => {
    writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\n', 'utf8');
    const added = ensureGitignore(tmpDir);
    expect(added).toBe(true);
    const content = readFileSync(join(tmpDir, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.auto-cmux/');
  });

  it('does not duplicate entry if already present', () => {
    writeFileSync(join(tmpDir, '.gitignore'), '.auto-cmux/\n', 'utf8');
    const added = ensureGitignore(tmpDir);
    expect(added).toBe(false);
  });
});
