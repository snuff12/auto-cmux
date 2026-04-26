import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TaskManager } from './task-manager.js';

describe('TaskManager', () => {
  let tm: TaskManager;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'task-manager-test-'));
    tm = new TaskManager(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── CRUD ──

  describe('create', () => {
    it('creates a task with auto-generated ID', () => {
      const task = tm.create({ title: 'Test task' });
      expect(task.id).toBe('TASK-001');
      expect(task.title).toBe('Test task');
      expect(task.status).toBe('ready'); // no deps → auto-promote
      expect(task.priority).toBe('medium');
    });

    it('increments IDs', () => {
      const t1 = tm.create({ title: 'First' });
      const t2 = tm.create({ title: 'Second' });
      expect(t1.id).toBe('TASK-001');
      expect(t2.id).toBe('TASK-002');
    });

    it('creates backlog task when deps are unresolved', () => {
      const dep = tm.create({ title: 'Dependency' });
      const task = tm.create({ title: 'Blocked', dependsOn: [dep.id] });
      expect(task.status).toBe('backlog');
    });

    it('throws on unknown dependency', () => {
      expect(() => tm.create({ title: 'Bad', dependsOn: ['TASK-999'] }))
        .toThrow('not found');
    });
  });

  describe('update', () => {
    it('updates task fields', () => {
      const task = tm.create({ title: 'Original' });
      const updated = tm.update(task.id, { title: 'Updated', priority: 'high' });
      expect(updated.title).toBe('Updated');
      expect(updated.priority).toBe('high');
    });
  });

  describe('delete', () => {
    it('removes task and cleans up dependencies', () => {
      const t1 = tm.create({ title: 'Dep' });
      const t2 = tm.create({ title: 'Main', dependsOn: [t1.id] });
      expect(t2.status).toBe('backlog');

      tm.delete(t1.id);
      expect(tm.get(t1.id)).toBeUndefined();
      // t2 should be unblocked (no more deps)
      expect(tm.get(t2.id)!.status).toBe('ready');
    });
  });

  describe('list', () => {
    it('filters by status', () => {
      tm.create({ title: 'A' });
      const dep = tm.create({ title: 'B' });
      tm.create({ title: 'C', dependsOn: [dep.id] });

      expect(tm.list({ status: 'ready' }).length).toBe(2); // A and B
      expect(tm.list({ status: 'backlog' }).length).toBe(1); // C
    });

    it('filters by priority', () => {
      tm.create({ title: 'High', priority: 'high' });
      tm.create({ title: 'Low', priority: 'low' });
      expect(tm.list({ priority: 'high' }).length).toBe(1);
    });
  });

  // ── State Machine ──

  describe('transitions', () => {
    it('allows ready → in-progress', () => {
      const task = tm.create({ title: 'T' });
      const t = tm.assign(task.id, 'agent-1');
      expect(t.status).toBe('in-progress');
    });

    it('allows in-progress → review', () => {
      const task = tm.create({ title: 'T' });
      tm.assign(task.id, 'agent-1');
      const t = tm.transition(task.id, 'review');
      expect(t.status).toBe('review');
    });

    it('allows review → done', () => {
      const task = tm.create({ title: 'T' });
      tm.assign(task.id, 'agent-1');
      tm.transition(task.id, 'review');
      const t = tm.transition(task.id, 'done');
      expect(t.status).toBe('done');
    });

    it('allows review → rejected → in-progress', () => {
      const task = tm.create({ title: 'T' });
      tm.assign(task.id, 'agent-1');
      tm.transition(task.id, 'review');
      tm.transition(task.id, 'rejected');
      const t = tm.transition(task.id, 'in-progress');
      expect(t.status).toBe('in-progress');
    });

    it('rejects invalid transitions', () => {
      const task = tm.create({ title: 'T' });
      expect(() => tm.transition(task.id, 'done')).toThrow('Invalid transition');
    });

    it('rejects ready transition when deps unresolved', () => {
      const dep = tm.create({ title: 'Dep' });
      const task = tm.create({ title: 'Main', dependsOn: [dep.id] });
      expect(task.status).toBe('backlog');
      expect(() => tm.transition(task.id, 'ready')).toThrow('unresolved dependencies');
    });
  });

  // ── Auto-unblock ──

  describe('auto-unblock', () => {
    it('unblocks dependent task when dependency completes', () => {
      const dep = tm.create({ title: 'Dep' });
      const task = tm.create({ title: 'Blocked', dependsOn: [dep.id] });
      expect(task.status).toBe('backlog');

      tm.assign(dep.id, 'agent-1');
      tm.complete(dep.id, 'done');

      expect(tm.get(task.id)!.status).toBe('ready');
    });

    it('unblocks only when all deps are done', () => {
      const dep1 = tm.create({ title: 'Dep1' });
      const dep2 = tm.create({ title: 'Dep2' });
      const task = tm.create({ title: 'Blocked', dependsOn: [dep1.id, dep2.id] });
      expect(task.status).toBe('backlog');

      tm.assign(dep1.id, 'agent-1');
      tm.complete(dep1.id, 'done');
      expect(tm.get(task.id)!.status).toBe('backlog');

      tm.assign(dep2.id, 'agent-2');
      tm.complete(dep2.id, 'done');
      expect(tm.get(task.id)!.status).toBe('ready');
    });
  });

  // ── Cycle Detection ──

  describe('cycle detection', () => {
    it('detects direct cycle', () => {
      const t1 = tm.create({ title: 'A' });
      const t2 = tm.create({ title: 'B', dependsOn: [t1.id] });
      expect(() => tm.addDependency(t1.id, t2.id)).toThrow('cycle');
    });

    it('detects indirect cycle', () => {
      const t1 = tm.create({ title: 'A' });
      const t2 = tm.create({ title: 'B', dependsOn: [t1.id] });
      const t3 = tm.create({ title: 'C', dependsOn: [t2.id] });
      expect(() => tm.addDependency(t1.id, t3.id)).toThrow('cycle');
    });

    it('allows non-cyclic dependency', () => {
      const t1 = tm.create({ title: 'A' });
      const t2 = tm.create({ title: 'B' });
      const t3 = tm.create({ title: 'C', dependsOn: [t1.id] });
      expect(() => tm.addDependency(t3.id, t2.id)).not.toThrow();
    });
  });

  // ── Auto-assign ──

  describe('autoAssign', () => {
    it('assigns ready tasks to idle agents by priority', () => {
      const low = tm.create({ title: 'Low', priority: 'low' });
      const high = tm.create({ title: 'High', priority: 'high' });
      const critical = tm.create({ title: 'Critical', priority: 'critical' });

      const agents = {
        list: () => [
          { id: 'a1', status: 'idle' },
          { id: 'a2', status: 'idle' },
        ],
      };

      const assigned = tm.autoAssign(agents);
      expect(assigned.length).toBe(2);
      expect(assigned[0].id).toBe(critical.id);
      expect(assigned[1].id).toBe(high.id);
      expect(tm.get(low.id)!.status).toBe('ready'); // not assigned
    });

    it('skips busy agents', () => {
      tm.create({ title: 'Task' });
      const agents = { list: () => [{ id: 'a1', status: 'working' }] };
      const assigned = tm.autoAssign(agents);
      expect(assigned.length).toBe(0);
    });
  });

  // ── Agent lifecycle ──

  describe('agent lifecycle hooks', () => {
    it('onAgentDone completes assigned tasks', () => {
      const task = tm.create({ title: 'T' });
      tm.assign(task.id, 'agent-1');
      tm.onAgentDone('agent-1', 'All done');
      expect(tm.get(task.id)!.status).toBe('done');
      expect(tm.get(task.id)!.result).toBe('All done');
    });

    it('review lifecycle moves assigned tasks through review and approval', () => {
      const task = tm.create({ title: 'T' });
      tm.assign(task.id, 'agent-1');

      tm.onAgentReviewStarted('agent-1');
      expect(tm.get(task.id)!.status).toBe('review');

      tm.onAgentReviewChangesRequested('agent-1');
      expect(tm.get(task.id)!.status).toBe('in-progress');

      tm.onAgentReviewStarted('agent-1');
      tm.onAgentReviewApproved('agent-1', 'LGTM');
      expect(tm.get(task.id)!.status).toBe('done');
      expect(tm.get(task.id)!.result).toBe('LGTM');
    });

    it('onAgentDied blocks assigned tasks', () => {
      const task = tm.create({ title: 'T' });
      tm.assign(task.id, 'agent-1');
      tm.onAgentDied('agent-1');
      expect(tm.get(task.id)!.status).toBe('blocked');
      expect(tm.get(task.id)!.assigneeId).toBeUndefined();
    });
  });

  // ── Persistence ──

  describe('persistence', () => {
    it('save and restore roundtrip', () => {
      const t1 = tm.create({ title: 'First' });
      tm.create({ title: 'Second', priority: 'high', dependsOn: [t1.id] });
      tm.save();

      const tm2 = new TaskManager(tempDir);
      tm2.restore();

      expect(tm2.list().length).toBe(2);
      expect(tm2.get('TASK-001')!.title).toBe('First');
      expect(tm2.get('TASK-002')!.priority).toBe('high');
    });

    it('restores sequence counter correctly', () => {
      tm.create({ title: 'A' });
      tm.create({ title: 'B' });
      tm.save();

      const tm2 = new TaskManager(tempDir);
      tm2.restore();
      const t3 = tm2.create({ title: 'C' });
      expect(t3.id).toBe('TASK-003');
    });
  });
});
