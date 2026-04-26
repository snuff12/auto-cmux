import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { atomicWriteJson } from './fs-utils.js';

const UNSAFE_CHARS = /[;&|`$(){}[\]<>!#*?\n\r\\'"]/;

function assertSafeArg(value: string, label: string): void {
  if (UNSAFE_CHARS.test(value)) {
    throw new Error(`${label} contains unsafe characters: ${value}`);
  }
}

export interface WorktreeInfo {
  agentId: string;
  branch: string;
  path: string;
}

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeInfo>();
  private gitAvailable: boolean | null = null;
  private statePath: string;

  constructor(
    private projectRoot: string,
    private branchPrefix: string = 'agent/',
    basePath: string = join(projectRoot, '.auto-cmux'),
  ) {
    this.statePath = join(basePath, 'worktrees-state.json');
  }

  /**
   * Check if git is available and project is a git repo.
   */
  private isGitRepo(): boolean {
    if (this.gitAvailable !== null) return this.gitAvailable;
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: this.projectRoot,
        stdio: 'pipe',
      });
      this.gitAvailable = true;
    } catch {
      this.gitAvailable = false;
    }
    return this.gitAvailable;
  }

  private worktreeDir(): string {
    return join(this.projectRoot, '.auto-cmux', 'worktrees');
  }

  /**
   * Create a git worktree for the given agent.
   * Returns the worktree path, or null if git is not available.
   */
  create(agentId: string, branchName?: string): string | null {
    if (!this.isGitRepo()) return null;

    assertSafeArg(agentId, 'agentId');
    const branch = branchName ?? `${this.branchPrefix}${agentId}`;
    assertSafeArg(branch, 'branchName');

    const wtPath = resolve(this.worktreeDir(), agentId);

    if (existsSync(wtPath)) {
      // Already exists — just track it
      this.worktrees.set(agentId, { agentId, branch, path: wtPath });
      return wtPath;
    }

    const opts = { cwd: this.projectRoot, stdio: 'pipe' as const };

    try {
      execFileSync('git', ['worktree', 'add', wtPath, '-b', branch], opts);
    } catch {
      // Branch may already exist — try without -b
      try {
        execFileSync('git', ['worktree', 'add', wtPath, branch], opts);
      } catch {
        // If branch exists and is checked out elsewhere, create from HEAD
        try {
          execFileSync('git', ['worktree', 'add', wtPath], opts);
        } catch (finalErr) {
          console.error(`[auto-cmux] worktree create failed for ${agentId}: ${finalErr}`);
          return null;
        }
      }
    }

    this.worktrees.set(agentId, { agentId, branch, path: wtPath });
    this.persistState();
    return wtPath;
  }

  /**
   * Remove the worktree and optionally delete the branch.
   */
  remove(agentId: string, deleteBranch = true): void {
    if (!this.isGitRepo()) return;

    const info = this.worktrees.get(agentId);
    const wtPath = info?.path ?? resolve(this.worktreeDir(), agentId);
    const opts = { cwd: this.projectRoot, stdio: 'pipe' as const };

    try {
      execFileSync('git', ['worktree', 'remove', wtPath, '--force'], opts);
    } catch {
      // Worktree may already be gone — try manual cleanup
      if (existsSync(wtPath)) {
        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      try {
        execFileSync('git', ['worktree', 'prune'], opts);
      } catch { /* ignore */ }
    }

    if (deleteBranch && info?.branch) {
      try {
        execFileSync('git', ['branch', '-D', info.branch], opts);
      } catch { /* branch may not exist */ }
    }

    this.worktrees.delete(agentId);
    this.persistState();
  }

  /**
   * List all tracked worktrees.
   */
  list(): WorktreeInfo[] {
    return [...this.worktrees.values()];
  }

  /**
   * Get the working directory for an agent's worktree.
   * Returns null if no worktree exists.
   */
  getCwd(agentId: string): string | null {
    return this.worktrees.get(agentId)?.path ?? null;
  }

  /**
   * Check if a worktree exists for the given agent.
   */
  has(agentId: string): boolean {
    return this.worktrees.has(agentId);
  }

  private persistState(): void {
    try {
      atomicWriteJson(this.statePath, Object.fromEntries(this.worktrees));
    } catch (err) {
      console.error(`[auto-cmux] failed to persist worktree state: ${err}`);
    }
  }

  restore(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, 'utf8');
      const data = JSON.parse(raw) as Record<string, WorktreeInfo>;
      for (const [agentId, info] of Object.entries(data)) {
        this.worktrees.set(agentId, info);
      }
    } catch (err) {
      console.error(`[auto-cmux] failed to restore worktree state: ${err}`);
    }
  }

  /**
   * Remove all worktrees (cleanup on shutdown).
   */
  removeAll(): void {
    for (const agentId of [...this.worktrees.keys()]) {
      this.remove(agentId);
    }
  }
}
