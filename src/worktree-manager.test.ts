import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorktreeManager } from './worktree-manager.js';

describe('WorktreeManager', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'worktree-mgr-'));
    // Initialize a git repo with an initial commit
    execSync('git init', { cwd: root, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: root, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: root, stdio: 'pipe' });
    execSync('touch README.md', { cwd: root, stdio: 'pipe' });
    execSync('git add .', { cwd: root, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: root, stdio: 'pipe' });
  });

  afterEach(() => {
    // Prune worktrees before removing temp dir
    try { execSync('git worktree prune', { cwd: root, stdio: 'pipe' }); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a worktree for an agent', () => {
    const mgr = new WorktreeManager(root);
    const path = mgr.create('agent-1');

    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(mgr.has('agent-1')).toBe(true);
    expect(mgr.getCwd('agent-1')).toBe(path);
  });

  it('uses custom branch name', () => {
    const mgr = new WorktreeManager(root);
    mgr.create('agent-1', 'feature/my-branch');

    const info = mgr.list();
    expect(info).toHaveLength(1);
    expect(info[0].branch).toBe('feature/my-branch');
  });

  it('uses branchPrefix for default branch name', () => {
    const mgr = new WorktreeManager(root, 'wt/');
    mgr.create('agent-1');

    const info = mgr.list();
    expect(info[0].branch).toBe('wt/agent-1');
  });

  it('removes a worktree and branch', () => {
    const mgr = new WorktreeManager(root);
    const path = mgr.create('agent-1')!;

    expect(existsSync(path)).toBe(true);
    mgr.remove('agent-1');

    expect(mgr.has('agent-1')).toBe(false);
    expect(mgr.getCwd('agent-1')).toBeNull();
    // Worktree directory should be cleaned up
    expect(existsSync(path)).toBe(false);
  });

  it('lists all worktrees', () => {
    const mgr = new WorktreeManager(root);
    mgr.create('agent-1');
    mgr.create('agent-2');

    const list = mgr.list();
    expect(list).toHaveLength(2);
    expect(list.map(w => w.agentId).sort()).toEqual(['agent-1', 'agent-2']);
  });

  it('removeAll cleans up everything', () => {
    const mgr = new WorktreeManager(root);
    mgr.create('agent-1');
    mgr.create('agent-2');

    mgr.removeAll();
    expect(mgr.list()).toHaveLength(0);
  });

  it('returns null for non-git directory', () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'no-git-'));
    try {
      const mgr = new WorktreeManager(nonGitDir);
      const result = mgr.create('agent-1');
      expect(result).toBeNull();
      expect(mgr.list()).toHaveLength(0);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('handles idempotent create (already exists)', () => {
    const mgr = new WorktreeManager(root);
    const path1 = mgr.create('agent-1');
    const path2 = mgr.create('agent-1');

    expect(path1).toBe(path2);
    expect(mgr.list()).toHaveLength(1);
  });

  it('remove is safe for non-existent agent', () => {
    const mgr = new WorktreeManager(root);
    // Should not throw
    mgr.remove('non-existent');
    expect(mgr.has('non-existent')).toBe(false);
  });
});
