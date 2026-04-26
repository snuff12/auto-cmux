import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryStore } from './memory-store.js';

describe('MemoryStore', () => {
  let root: string;
  let store: MemoryStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memory-store-'));
    store = new MemoryStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── Role Memory ──

  it('saves and retrieves role memory', () => {
    store.saveRoleMemory('backend', 'test-pattern', 'Use vitest for all tests');
    const entries = store.getRoleMemory('backend');
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('role');
    expect(entries[0].key).toBe('test-pattern');
    expect(entries[0].insight).toBe('Use vitest for all tests');
    expect(entries[0].confidence).toBe(0.8);
    expect(entries[0].timestamp).toBeGreaterThan(0);
  });

  it('appends multiple entries', () => {
    store.saveRoleMemory('backend', 'db', 'Use postgres');
    store.saveRoleMemory('backend', 'api', 'REST only');
    expect(store.getRoleMemory('backend')).toHaveLength(2);
  });

  it('dedupes by key (latest wins)', () => {
    store.saveRoleMemory('backend', 'db', 'Use postgres');
    store.saveRoleMemory('backend', 'db', 'Use sqlite for dev');
    const deduped = store.getRoleMemoryDeduped('backend');
    expect(deduped).toHaveLength(1);
    expect(deduped[0].insight).toBe('Use sqlite for dev');
  });

  it('returns empty for unknown role', () => {
    expect(store.getRoleMemory('unknown')).toEqual([]);
  });

  it('clamps confidence to [0, 1]', () => {
    const e1 = store.saveRoleMemory('r', 'k1', 'i', 1.5);
    const e2 = store.saveRoleMemory('r', 'k2', 'i', -0.5);
    expect(e1.confidence).toBe(1);
    expect(e2.confidence).toBe(0);
  });

  // ── Convention Memory ──

  it('saves and retrieves conventions', () => {
    store.saveConvention('style', 'Use 2-space indent');
    const entries = store.getConventions();
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('convention');
    expect(entries[0].key).toBe('style');
    expect(entries[0].confidence).toBe(0.9);
  });

  it('dedupes conventions by key', () => {
    store.saveConvention('style', 'tabs');
    store.saveConvention('style', '2-space');
    const deduped = store.getConventionsDeduped();
    expect(deduped).toHaveLength(1);
    expect(deduped[0].insight).toBe('2-space');
  });

  // ── getAll ──

  it('returns all memory sorted by timestamp', () => {
    store.saveConvention('conv1', 'insight-a');
    store.saveRoleMemory('backend', 'role1', 'insight-b');
    store.saveConvention('conv2', 'insight-c');

    const all = store.getAll();
    expect(all.length).toBeGreaterThanOrEqual(3);
    // Sorted by timestamp
    for (let i = 1; i < all.length; i++) {
      expect(all[i].timestamp).toBeGreaterThanOrEqual(all[i - 1].timestamp);
    }
  });

  it('filters by type', () => {
    store.saveConvention('c', 'convention');
    store.saveRoleMemory('r', 'k', 'role');

    const conventions = store.getAll('convention');
    expect(conventions.every(e => e.type === 'convention')).toBe(true);

    const roles = store.getAll('role');
    expect(roles.every(e => e.type === 'role')).toBe(true);
  });

  // ── listRoles ──

  it('lists all roles with memory', () => {
    store.saveRoleMemory('backend', 'k', 'v');
    store.saveRoleMemory('frontend', 'k', 'v');
    const roles = store.listRoles();
    expect(roles.sort()).toEqual(['backend', 'frontend']);
  });

  // ── Prompt Section ──

  it('builds prompt section with conventions and role memory', () => {
    store.saveConvention('style', '2-space indent');
    store.saveRoleMemory('backend', 'db', 'Use postgres');

    const section = store.buildPromptSection('backend');
    expect(section).toContain('## Project Conventions');
    expect(section).toContain('2-space indent');
    expect(section).toContain('## Role Memory (backend)');
    expect(section).toContain('Use postgres');
  });

  it('builds prompt section without role when not specified', () => {
    store.saveConvention('style', 'tabs');
    store.saveRoleMemory('backend', 'k', 'v');

    const section = store.buildPromptSection();
    expect(section).toContain('## Project Conventions');
    expect(section).not.toContain('## Role Memory');
  });

  it('returns empty string when no memory', () => {
    expect(store.buildPromptSection('nonexistent')).toBe('');
  });

  // ── Compact ──

  it('compacts file by deduplicating', () => {
    store.saveRoleMemory('backend', 'k1', 'v1');
    store.saveRoleMemory('backend', 'k1', 'v2');
    store.saveRoleMemory('backend', 'k2', 'v3');

    const filePath = join(root, 'memory', 'backend.jsonl');
    const linesBefore = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(linesBefore).toHaveLength(3);

    store.compact(filePath);

    const linesAfter = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(linesAfter).toHaveLength(2);
  });

  it('compactAll processes all files', () => {
    store.saveRoleMemory('a', 'k', 'v1');
    store.saveRoleMemory('a', 'k', 'v2');
    store.saveConvention('c', 'old');
    store.saveConvention('c', 'new');

    store.compactAll();

    expect(store.getRoleMemory('a')).toHaveLength(1);
    expect(store.getConventions()).toHaveLength(1);
    expect(store.getConventionsDeduped()[0].insight).toBe('new');
  });
});
