import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { atomicWriteJson } from './fs-utils.js';
import { EventEmitter } from 'events';
import type { Task, TaskStatus, TaskPriority } from './types.js';

// ── Valid state transitions ──

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  'backlog':     ['ready'],
  'ready':       ['in-progress'],
  'in-progress': ['review', 'blocked'],
  'review':      ['done', 'rejected'],
  'rejected':    ['in-progress'],
  'blocked':     ['ready'],
  'done':        [],
};

export interface TaskFilter {
  status?: TaskStatus;
  assigneeId?: string;
  priority?: TaskPriority;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  dependsOn?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  result?: string;
}

export interface AgentProvider {
  list(): Array<{ id: string; status: string }>;
}

export class TaskManager extends EventEmitter {
  private tasks = new Map<string, Task>();
  private nextSeq = 1;
  constructor(private basePath: string) {
    super();
    mkdirSync(basePath, { recursive: true });
  }

  // ── CRUD ──

  create(input: CreateTaskInput): Task {
    const id = `TASK-${String(this.nextSeq++).padStart(3, '0')}`;
    const now = Date.now();

    const task: Task = {
      id,
      title: input.title,
      description: input.description ?? '',
      status: 'backlog',
      priority: input.priority ?? 'medium',
      dependsOn: input.dependsOn ?? [],
      createdAt: now,
      updatedAt: now,
    };

    // Validate dependency references
    for (const depId of task.dependsOn) {
      if (!this.tasks.has(depId)) {
        throw new Error(`Dependency "${depId}" not found`);
      }
    }

    // Check for cycles before adding
    this.tasks.set(id, task);
    if (this.hasCycle(id)) {
      this.tasks.delete(id);
      throw new Error(`Adding dependencies would create a cycle`);
    }

    // Auto-promote to ready if no deps or all deps done
    if (this.areDepsResolved(task)) {
      task.status = 'ready';
    }

    this.save();
    this.emit('created', task);
    return task;
  }

  update(taskId: string, input: UpdateTaskInput): Task {
    const task = this.getOrThrow(taskId);

    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.result !== undefined) task.result = input.result;
    task.updatedAt = Date.now();

    this.save();
    this.emit('updated', task);
    return task;
  }

  delete(taskId: string): void {
    const task = this.getOrThrow(taskId);

    // Remove this task from others' dependsOn
    for (const t of this.tasks.values()) {
      const idx = t.dependsOn.indexOf(taskId);
      if (idx !== -1) {
        t.dependsOn.splice(idx, 1);
        this.tryUnblock(t);
      }
    }

    this.tasks.delete(taskId);
    this.save();
    this.emit('deleted', taskId);
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  list(filter?: TaskFilter): Task[] {
    let result = Array.from(this.tasks.values());

    if (filter?.status) {
      result = result.filter(t => t.status === filter.status);
    }
    if (filter?.assigneeId) {
      result = result.filter(t => t.assigneeId === filter.assigneeId);
    }
    if (filter?.priority) {
      result = result.filter(t => t.priority === filter.priority);
    }

    return result;
  }

  // ── State transitions ──

  transition(taskId: string, newStatus: TaskStatus): Task {
    const task = this.getOrThrow(taskId);
    const allowed = VALID_TRANSITIONS[task.status];

    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid transition: ${task.status} → ${newStatus} (allowed: ${allowed.join(', ') || 'none'})`,
      );
    }

    // Block transition to 'ready' if deps not resolved
    if (newStatus === 'ready' && !this.areDepsResolved(task)) {
      throw new Error(`Cannot move to ready: unresolved dependencies`);
    }

    const prev = task.status;
    task.status = newStatus;
    task.updatedAt = Date.now();

    this.save();
    this.emit('transition', task, prev);

    // If task is done, auto-unblock dependents
    if (newStatus === 'done') {
      this.unblockDependents(taskId);
    }

    return task;
  }

  // ── Assignment ──

  assign(taskId: string, agentId: string): Task {
    const task = this.getOrThrow(taskId);

    if (task.status !== 'ready') {
      throw new Error(`Can only assign tasks in "ready" status (current: ${task.status})`);
    }

    task.assigneeId = agentId;
    task.status = 'in-progress';
    task.updatedAt = Date.now();

    this.save();
    this.emit('assigned', task, agentId);
    return task;
  }

  unassign(taskId: string): Task {
    const task = this.getOrThrow(taskId);
    const prevAssignee = task.assigneeId;
    task.assigneeId = undefined;

    // Move back to ready if in-progress
    if (task.status === 'in-progress') {
      task.status = 'ready';
    }
    task.updatedAt = Date.now();

    this.save();
    this.emit('unassigned', task, prevAssignee);
    return task;
  }

  complete(taskId: string, result?: string): Task {
    const task = this.getOrThrow(taskId);

    if (task.status !== 'in-progress' && task.status !== 'review') {
      throw new Error(`Can only complete tasks in "in-progress" or "review" status (current: ${task.status})`);
    }

    const prev = task.status;
    task.result = result;
    task.status = 'done';
    task.updatedAt = Date.now();

    this.save();
    this.emit('transition', task, prev);
    this.unblockDependents(taskId);

    return task;
  }

  // ── Dependencies ──

  addDependency(taskId: string, dependsOnId: string): void {
    const task = this.getOrThrow(taskId);
    this.getOrThrow(dependsOnId); // validate exists

    if (task.dependsOn.includes(dependsOnId)) return;

    task.dependsOn.push(dependsOnId);

    // Check for cycles
    if (this.hasCycle(taskId)) {
      task.dependsOn.pop();
      throw new Error(`Adding dependency ${dependsOnId} would create a cycle`);
    }

    // If task was ready but now has unresolved deps, block it
    if (task.status === 'ready' && !this.areDepsResolved(task)) {
      task.status = 'backlog';
    }

    task.updatedAt = Date.now();
    this.save();
  }

  removeDependency(taskId: string, dependsOnId: string): void {
    const task = this.getOrThrow(taskId);
    const idx = task.dependsOn.indexOf(dependsOnId);
    if (idx === -1) return;

    task.dependsOn.splice(idx, 1);
    task.updatedAt = Date.now();

    this.tryUnblock(task);
    this.save();
  }

  // ── Auto-assign ──

  autoAssign(agentProvider: AgentProvider): Task[] {
    const idleAgents = agentProvider.list().filter(a => a.status === 'idle');
    const readyTasks = this.list({ status: 'ready' })
      .filter(t => !t.assigneeId)
      .sort((a, b) => {
        const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        return (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2);
      });

    const assigned: Task[] = [];
    for (const agent of idleAgents) {
      const task = readyTasks.shift();
      if (!task) break;
      this.assign(task.id, agent.id);
      assigned.push(task);
    }

    return assigned;
  }

  // ── Agent lifecycle hooks ──

  onAgentDone(agentId: string, summary?: string): void {
    const tasks = this.list({ assigneeId: agentId, status: 'in-progress' });
    for (const task of tasks) {
      this.complete(task.id, summary);
    }
  }

  onAgentReviewStarted(agentId: string): void {
    const tasks = this.list({ assigneeId: agentId, status: 'in-progress' });
    for (const task of tasks) {
      const prev = task.status;
      task.status = 'review';
      task.updatedAt = Date.now();
      this.save();
      this.emit('transition', task, prev);
    }
  }

  onAgentReviewChangesRequested(agentId: string): void {
    const tasks = this.list({ assigneeId: agentId, status: 'review' });
    for (const task of tasks) {
      const prev = task.status;
      task.status = 'in-progress';
      task.updatedAt = Date.now();
      this.save();
      this.emit('transition', task, prev);
    }
  }

  onAgentReviewApproved(agentId: string, summary?: string): void {
    const tasks = [
      ...this.list({ assigneeId: agentId, status: 'review' }),
      ...this.list({ assigneeId: agentId, status: 'in-progress' }),
    ];
    for (const task of tasks) {
      this.complete(task.id, summary);
    }
  }

  onAgentDied(agentId: string): void {
    const tasks = this.list({ assigneeId: agentId });
    for (const task of tasks) {
      if (task.status === 'in-progress') {
        task.status = 'blocked';
        task.assigneeId = undefined;
        task.updatedAt = Date.now();
        this.save();
        this.emit('transition', task, 'in-progress');
      }
    }
  }

  // ── Persistence ──

  save(): void {
    atomicWriteJson(join(this.basePath, 'tasks.json'), Array.from(this.tasks.values()));
  }

  restore(): void {
    const filePath = join(this.basePath, 'tasks.json');
    if (!existsSync(filePath)) return;

    try {
      const data: Task[] = JSON.parse(readFileSync(filePath, 'utf8'));
      for (const task of data) {
        this.tasks.set(task.id, task);
        // Track sequence number
        const match = task.id.match(/^TASK-(\d+)$/);
        if (match) {
          const seq = parseInt(match[1], 10);
          if (seq >= this.nextSeq) this.nextSeq = seq + 1;
        }
      }
    } catch {
      console.warn('[task-manager] Failed to parse tasks.json, starting fresh');
    }
  }

  // ── Helpers ──

  private getOrThrow(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);
    return task;
  }

  private areDepsResolved(task: Task): boolean {
    return task.dependsOn.every(depId => {
      const dep = this.tasks.get(depId);
      return dep && dep.status === 'done';
    });
  }

  private tryUnblock(task: Task): void {
    if ((task.status === 'blocked' || task.status === 'backlog') && this.areDepsResolved(task)) {
      const prev = task.status;
      task.status = 'ready';
      task.updatedAt = Date.now();
      this.emit('transition', task, prev);
    }
  }

  private unblockDependents(completedTaskId: string): void {
    for (const task of this.tasks.values()) {
      if (task.dependsOn.includes(completedTaskId)) {
        this.tryUnblock(task);
      }
    }
  }

  private hasCycle(startId: string): boolean {
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (id: string): boolean => {
      if (stack.has(id)) return true;
      if (visited.has(id)) return false;

      visited.add(id);
      stack.add(id);

      const task = this.tasks.get(id);
      if (task) {
        for (const depId of task.dependsOn) {
          if (dfs(depId)) return true;
        }
      }

      stack.delete(id);
      return false;
    };

    return dfs(startId);
  }

}
