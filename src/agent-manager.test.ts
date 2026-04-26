import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentManager, MAX_CHILDREN, MAX_DEPTH, type CmuxClientLike } from './agent-manager.js';
import { FileProtocol } from './file-protocol.js';
import type { Action } from './types.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'auto-cmux-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeCmux implements CmuxClientLike {
  created: Array<{ title?: string; cwd?: string; initialCommand?: string }> = [];
  sent: Array<{ surfaceId: string; text: string }> = [];
  closed: string[] = [];
  private nextWorkspaceSeq = 1;
  private nextSurfaceSeq = 1;

  async call(_method: string, _params?: Record<string, unknown>) {
    return {};
  }

  async createWorkspace(options: { title?: string; cwd?: string; initialCommand?: string } = {}) {
    this.created.push(options);
    return { workspace_id: `workspace-${this.nextWorkspaceSeq++}` };
  }

  async listSurfaces(_workspaceId: string) {
    return [{ id: `surface-${this.nextSurfaceSeq++}`, index: 0, focused: true }];
  }

  async sendText(surfaceId: string, text: string) {
    this.sent.push({ surfaceId, text });
  }

  async sendKey(_surfaceId: string, _key: string) {}

  async readText(_surfaceId: string, _lines?: number) {
    return 'ready';
  }

  async closeWorkspace(workspaceId: string) {
    this.closed.push(workspaceId);
  }

  async renameWorkspace(_workspaceId: string, _title: string) {}
}

describe('AgentManager', () => {
  it('spawns an agent, waits for a surface, and sends the CLI command', async () => {
    const root = makeRoot();
    const cmux = new FakeCmux();
    const files = new FileProtocol(root);
    const manager = new AgentManager(cmux, files, { basePath: root });

    const agent = await manager.spawn('worker-a', 'claude', 'Do the task', '/tmp');

    expect(agent.workspaceId).toBe('workspace-1');
    expect(agent.surfaceId).toBe('surface-1');
    expect(cmux.sent).toHaveLength(1);
    expect(cmux.sent[0].surfaceId).toBe('surface-1');
    expect(cmux.sent[0].text).toContain("'claude' '--print'");
    expect(cmux.created).toHaveLength(1);
    expect(cmux.created[0].title).toBe('worker-a');
    expect(cmux.created[0].cwd).toBe('/tmp');
    expect(cmux.created[0].initialCommand).toBeUndefined();

    const inbox = readFileSync(join(root, 'agents', agent.id, 'inbox.md'), 'utf8');
    expect(inbox).toContain('Do the task');
    expect(inbox).toContain('"action":"done"');
  });

  it('updates status from terminal actions', async () => {
    const root = makeRoot();
    const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });
    const agent = await manager.spawn('worker-a', 'claude', 'Do the task', '/tmp');

    manager.handleActions(agent.id, [{ action: 'done', summary: 'ok' } satisfies Action]);
    expect(manager.get(agent.id)?.status).toBe('idle');

    manager.handleActions(agent.id, [{ action: 'error', message: 'failed' } satisfies Action]);
    expect(manager.get(agent.id)?.status).toBe('dead');
  });

  it('captures session ids from stream-json output', async () => {
    const root = makeRoot();
    const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });
    const agent = await manager.spawn('worker-a', 'claude', 'Do the task', '/tmp');

    manager.handleStreamText(agent.id, '{"session_id":"claude-session-123"}\n');

    expect(manager.get(agent.id)?.sessionId).toBe('claude-session-123');
  });

  // ── Hierarchy tests ──

  describe('hierarchy', () => {
    it('spawns child with parent-child relationship and depth tracking', async () => {
      const root = makeRoot();
      const cmux = new FakeCmux();
      const manager = new AgentManager(cmux, new FileProtocol(root), { basePath: root });

      const parent = await manager.spawn('parent', 'claude', 'Main task', '/tmp');
      expect(parent.depth).toBe(0);
      expect(parent.childIds).toEqual([]);
      expect(parent.parentId).toBeUndefined();

      const child = await manager.spawn('child', 'claude', 'Sub task', '/tmp', {
        parentId: parent.id,
      });
      expect(child.depth).toBe(1);
      expect(child.parentId).toBe(parent.id);
      expect(manager.get(parent.id)!.childIds).toContain(child.id);
    });

    it('tracks depth through 3 levels', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const a1 = await manager.spawn('a1', 'claude', 'L0', '/tmp');
      const a2 = await manager.spawn('a2', 'claude', 'L1', '/tmp', { parentId: a1.id });
      const a3 = await manager.spawn('a3', 'claude', 'L2', '/tmp', { parentId: a2.id });

      expect(a1.depth).toBe(0);
      expect(a2.depth).toBe(1);
      expect(a3.depth).toBe(2);
    });

    it('enforces MAX_DEPTH', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      let current = await manager.spawn('l0', 'claude', 'task', '/tmp');
      for (let i = 1; i <= MAX_DEPTH; i++) {
        current = await manager.spawn(`l${i}`, 'claude', 'task', '/tmp', { parentId: current.id });
      }
      expect(current.depth).toBe(MAX_DEPTH);

      await expect(
        manager.spawn('too-deep', 'claude', 'task', '/tmp', { parentId: current.id }),
      ).rejects.toThrow('Max agent depth');
    });

    it('enforces MAX_CHILDREN', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const parent = await manager.spawn('parent', 'claude', 'task', '/tmp');
      for (let i = 0; i < MAX_CHILDREN; i++) {
        await manager.spawn(`child-${i}`, 'claude', 'task', '/tmp', { parentId: parent.id });
      }

      await expect(
        manager.spawn('child-extra', 'claude', 'task', '/tmp', { parentId: parent.id }),
      ).rejects.toThrow('Max children');
    });

    it('notifies parent on child done action', async () => {
      const root = makeRoot();
      const files = new FileProtocol(root);
      const manager = new AgentManager(new FakeCmux(), files, { basePath: root });

      const parent = await manager.spawn('parent', 'claude', 'Main', '/tmp');
      const child = await manager.spawn('child', 'claude', 'Sub', '/tmp', { parentId: parent.id });

      const events: Array<{ parentId: string; childId: string; summary: string }> = [];
      manager.on('child_completed', (e) => events.push(e));

      manager.handleActions(child.id, [{ action: 'done', summary: 'Task completed successfully' }]);

      expect(events).toHaveLength(1);
      expect(events[0].parentId).toBe(parent.id);
      expect(events[0].childId).toBe(child.id);
      expect(events[0].summary).toBe('Task completed successfully');

      // Check inbox was written
      const inbox = readFileSync(join(root, 'agents', parent.id, 'inbox.md'), 'utf8');
      expect(inbox).toContain('Child Agent "child" Completed');
      expect(inbox).toContain('Task completed successfully');
    });

    it('cascading kill removes entire subtree', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const a1 = await manager.spawn('a1', 'claude', 'L0', '/tmp');
      const a2 = await manager.spawn('a2', 'claude', 'L1', '/tmp', { parentId: a1.id });
      const a3 = await manager.spawn('a3', 'claude', 'L2', '/tmp', { parentId: a2.id });

      await manager.kill(a1.id, true);

      expect(manager.get(a1.id)).toBeUndefined();
      expect(manager.get(a2.id)).toBeUndefined();
      expect(manager.get(a3.id)).toBeUndefined();
      expect(manager.list()).toHaveLength(0);
    });

    it('non-cascading kill only removes target and cleans parent', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const parent = await manager.spawn('parent', 'claude', 'Main', '/tmp');
      const child = await manager.spawn('child', 'claude', 'Sub', '/tmp', { parentId: parent.id });

      await manager.kill(child.id, false);

      expect(manager.get(child.id)).toBeUndefined();
      expect(manager.get(parent.id)!.childIds).toEqual([]);
    });

  it('sets roleId on spawn', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

    const agent = await manager.spawn('be', 'claude', 'API work', '/tmp', { roleId: 'backend' });
    expect(agent.roleId).toBe('backend');
  });

  it('removes managed workspace record when its last agent is killed', async () => {
    const root = makeRoot();
    const cmux = new FakeCmux();
    const manager = new AgentManager(cmux, new FileProtocol(root), { basePath: root });
    const removed: string[] = [];
    manager.on('managed_workspace_removed', (ws) => removed.push(ws.name));

    await manager.createManagedWorkspace('dev', '/tmp');
    const agent = await manager.spawnInWorkspace('dev', 'worker', 'claude', 'Task');

    await manager.kill(agent.id);

    expect(manager.listWorkspaces()).toHaveLength(0);
    expect(removed).toEqual(['dev']);
  });

    // ── Tree queries ──

    it('getRoots returns only root agents', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const a1 = await manager.spawn('a1', 'claude', 't', '/tmp');
      await manager.spawn('a2', 'claude', 't', '/tmp', { parentId: a1.id });
      const a3 = await manager.spawn('a3', 'claude', 't', '/tmp');

      const roots = manager.getRoots();
      expect(roots.map(a => a.name).sort()).toEqual(['a1', 'a3']);
    });

    it('getChildren returns direct children', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const parent = await manager.spawn('parent', 'claude', 't', '/tmp');
      const c1 = await manager.spawn('c1', 'claude', 't', '/tmp', { parentId: parent.id });
      const c2 = await manager.spawn('c2', 'claude', 't', '/tmp', { parentId: parent.id });
      await manager.spawn('gc', 'claude', 't', '/tmp', { parentId: c1.id });

      const children = manager.getChildren(parent.id);
      expect(children.map(a => a.name).sort()).toEqual(['c1', 'c2']);
    });

    it('getAncestors returns path to root', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const a1 = await manager.spawn('a1', 'claude', 't', '/tmp');
      const a2 = await manager.spawn('a2', 'claude', 't', '/tmp', { parentId: a1.id });
      const a3 = await manager.spawn('a3', 'claude', 't', '/tmp', { parentId: a2.id });

      const ancestors = manager.getAncestors(a3.id);
      expect(ancestors.map(a => a.name)).toEqual(['a2', 'a1']);
    });

    it('getAllDescendants returns all nested children', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const a1 = await manager.spawn('a1', 'claude', 't', '/tmp');
      await manager.spawn('a2', 'claude', 't', '/tmp', { parentId: a1.id });
      const a3 = await manager.spawn('a3', 'claude', 't', '/tmp', { parentId: a1.id });
      await manager.spawn('a4', 'claude', 't', '/tmp', { parentId: a3.id });

      const desc = manager.getAllDescendants(a1.id);
      expect(desc.map(a => a.name).sort()).toEqual(['a2', 'a3', 'a4']);
    });

    it('getTree builds correct tree structure', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const a1 = await manager.spawn('a1', 'claude', 't', '/tmp');
      await manager.spawn('a2', 'claude', 't', '/tmp', { parentId: a1.id });
      await manager.spawn('a3', 'claude', 't', '/tmp', { parentId: a1.id });

      const tree = manager.getTree();
      expect(tree).toHaveLength(1);
      expect(tree[0].agent.name).toBe('a1');
      expect(tree[0].children).toHaveLength(2);
      expect(tree[0].children.map(c => c.agent.name).sort()).toEqual(['a2', 'a3']);
    });

    it('getTree with specific agent returns subtree', async () => {
      const root = makeRoot();
      const manager = new AgentManager(new FakeCmux(), new FileProtocol(root), { basePath: root });

      const a1 = await manager.spawn('a1', 'claude', 't', '/tmp');
      const a2 = await manager.spawn('a2', 'claude', 't', '/tmp', { parentId: a1.id });
      await manager.spawn('a3', 'claude', 't', '/tmp', { parentId: a2.id });

      const tree = manager.getTree(a2.id);
      expect(tree).toHaveLength(1);
      expect(tree[0].agent.name).toBe('a2');
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].agent.name).toBe('a3');
    });

    // ── Orphan recovery ──

    it('restoreState promotes orphans to root when parent is gone', async () => {
      const root = makeRoot();
      const cmux = new FakeCmux();
      const files = new FileProtocol(root);

      // Create hierarchy
      const m1 = new AgentManager(cmux, files, { basePath: root });
      const parent = await m1.spawn('parent', 'claude', 't', '/tmp');
      const child = await m1.spawn('child', 'claude', 't', '/tmp', { parentId: parent.id });

      // Simulate parent workspace gone
      const failingCmux = new (class extends FakeCmux {
        private parentSurface = parent.surfaceId;
        override async readText(surfaceId: string, lines?: number) {
          if (surfaceId === this.parentSurface) throw new Error('gone');
          return super.readText(surfaceId, lines);
        }
      })();

      const m2 = new AgentManager(failingCmux, files, { basePath: root });
      await m2.restoreState();

      const restored = m2.get(child.id);
      expect(restored).toBeDefined();
      expect(restored!.parentId).toBeUndefined();
      expect(restored!.depth).toBe(0);
      expect(m2.get(parent.id)).toBeUndefined();
    });
  });
});
