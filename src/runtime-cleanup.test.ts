import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { cleanupRuntimeState, resolveRuntimeBasePath } from './runtime-cleanup.js';
import type { Agent, ManagedWorkspace, Task } from './types.js';

describe('cleanupRuntimeState', () => {
  let root: string;
  let basePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runtime-cleanup-'));
    basePath = join(root, '.auto-cmux');
    mkdirSync(join(basePath, 'agents', 'live-1'), { recursive: true });
    mkdirSync(join(basePath, 'agents', 'dead-1'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes dead and missing agents without pruning empty workspaces by default', async () => {
    const agents: Agent[] = [
      {
        id: 'live-1',
        name: 'live',
        cli: 'claude',
        workspaceId: 'ws-live',
        surfaceId: 'surface-live',
        status: 'idle',
        cwd: root,
        childIds: ['dead-1'],
        depth: 0,
      },
      {
        id: 'dead-1',
        name: 'dead',
        cli: 'claude',
        workspaceId: 'ws-live',
        surfaceId: 'surface-dead',
        status: 'dead',
        cwd: root,
        parentId: 'live-1',
        childIds: [],
        depth: 1,
      },
      {
        id: 'missing-1',
        name: 'missing',
        cli: 'claude',
        workspaceId: 'ws-missing',
        surfaceId: 'surface-missing',
        status: 'idle',
        cwd: root,
        childIds: [],
        depth: 0,
      },
    ];
    const workspaces: ManagedWorkspace[] = [
      { id: 'managed-live', name: 'live-ws', workspaceId: 'ws-live', agentIds: ['live-1', 'dead-1'], cwd: root },
      { id: 'managed-empty', name: 'empty-ws', workspaceId: 'ws-empty', agentIds: ['missing-1'], cwd: root },
    ];
    const tasks: Task[] = [
      {
        id: 'TASK-001',
        title: 'orphaned',
        description: '',
        status: 'in-progress',
        priority: 'medium',
        assigneeId: 'missing-1',
        dependsOn: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];

    writeFileSync(join(basePath, 'agents.json'), JSON.stringify(agents), 'utf8');
    writeFileSync(join(basePath, 'workspaces.json'), JSON.stringify(workspaces), 'utf8');
    writeFileSync(join(basePath, 'tasks.json'), JSON.stringify(tasks), 'utf8');

    const summary = await cleanupRuntimeState({ basePath, checkCmux: false });

    expect(summary.removedAgents.map(a => a.id).sort()).toEqual(['dead-1', 'missing-1']);
    expect(summary.removedWorkspaces.map(w => w.id)).toEqual([]);
    expect(summary.updatedTasks.map(t => t.id)).toEqual(['TASK-001']);

    const cleanedAgents = JSON.parse(readFileSync(join(basePath, 'agents.json'), 'utf8')) as Agent[];
    expect(cleanedAgents).toHaveLength(1);
    expect(cleanedAgents[0].childIds).toEqual([]);

    const cleanedWorkspaces = JSON.parse(readFileSync(join(basePath, 'workspaces.json'), 'utf8')) as ManagedWorkspace[];
    expect(cleanedWorkspaces.map(w => w.id).sort()).toEqual(['managed-empty', 'managed-live']);
    expect(cleanedWorkspaces.find(w => w.id === 'managed-empty')?.agentIds).toEqual([]);

    const cleanedTasks = JSON.parse(readFileSync(join(basePath, 'tasks.json'), 'utf8')) as Task[];
    expect(cleanedTasks[0].status).toBe('blocked');
    expect(cleanedTasks[0].assigneeId).toBeUndefined();
  });

  it('prunes empty workspaces when requested', async () => {
    const agents: Agent[] = [
      {
        id: 'dead-1',
        name: 'dead',
        cli: 'claude',
        workspaceId: 'ws-empty',
        surfaceId: 'surface-dead',
        status: 'dead',
        cwd: root,
        childIds: [],
        depth: 0,
      },
    ];
    const workspaces: ManagedWorkspace[] = [
      { id: 'managed-empty', name: 'empty-ws', workspaceId: 'ws-empty', agentIds: ['dead-1'], cwd: root },
    ];
    writeFileSync(join(basePath, 'agents.json'), JSON.stringify(agents), 'utf8');
    writeFileSync(join(basePath, 'workspaces.json'), JSON.stringify(workspaces), 'utf8');

    const summary = await cleanupRuntimeState({ basePath, checkCmux: false, pruneEmptyWorkspaces: true });

    expect(summary.removedWorkspaces.map(w => w.id)).toEqual(['managed-empty']);
    const cleanedWorkspaces = JSON.parse(readFileSync(join(basePath, 'workspaces.json'), 'utf8')) as ManagedWorkspace[];
    expect(cleanedWorkspaces).toEqual([]);
  });

  it('resolves runtime base path from project.root', () => {
    writeFileSync(join(root, 'auto-cmux.yml'), 'project:\n  root: packages/app\n', 'utf8');
    expect(resolveRuntimeBasePath(root)).toBe(join(root, 'packages', 'app', '.auto-cmux'));
  });
});
