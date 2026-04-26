import { existsSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { atomicWriteJson } from './fs-utils.js';
import type { Agent, ManagedWorkspace, Task } from './types.js';
import { CmuxClient } from './cmux-client.js';
import { loadProjectConfig } from './config-loader.js';

interface CleanupOptions {
  basePath?: string;
  dryRun?: boolean;
  checkCmux?: boolean;
  pruneEmptyWorkspaces?: boolean;
}

export interface CleanupSummary {
  basePath: string;
  dryRun: boolean;
  cmuxChecked: boolean;
  cmuxError?: string;
  removedAgents: Array<{ id: string; name: string; reason: string }>;
  removedWorkspaces: Array<{ id: string; name: string; reason: string }>;
  updatedTasks: Array<{ id: string; title: string; previousAssigneeId: string }>;
}

export function resolveRuntimeBasePath(projectRoot = process.cwd()): string {
  const config = loadProjectConfig(projectRoot);
  return resolve(projectRoot, config.project.root || '.', '.auto-cmux');
}

function readJsonArray<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

async function collectMissingCmuxWorkspaceIds(workspaces: ManagedWorkspace[]): Promise<{
  checked: boolean;
  missing: Set<string>;
  error?: string;
}> {
  const client = new CmuxClient({ requestTimeout: 3000, reconnect: false, pingInterval: 0 });
  const missing = new Set<string>();
  try {
    await client.connect();
    for (const ws of workspaces) {
      try {
        await client.listSurfaces(ws.workspaceId);
      } catch {
        missing.add(ws.workspaceId);
      }
    }
    return { checked: true, missing };
  } catch (err) {
    return {
      checked: false,
      missing,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.disconnect();
  }
}

export async function cleanupRuntimeState(options: CleanupOptions = {}): Promise<CleanupSummary> {
  const basePath = resolve(options.basePath ?? join(process.cwd(), '.auto-cmux'));
  const dryRun = options.dryRun ?? false;
  const checkCmux = options.checkCmux ?? true;
  const pruneEmptyWorkspaces = options.pruneEmptyWorkspaces ?? false;
  const agentsPath = join(basePath, 'agents.json');
  const workspacesPath = join(basePath, 'workspaces.json');
  const tasksPath = join(basePath, 'tasks.json');

  const agents = readJsonArray<Agent>(agentsPath);
  const workspaces = readJsonArray<ManagedWorkspace>(workspacesPath);
  const tasks = readJsonArray<Task>(tasksPath);

  const cmuxResult = checkCmux
    ? await collectMissingCmuxWorkspaceIds(workspaces)
    : { checked: false, missing: new Set<string>() };

  const agentReasons = new Map<string, string>();
  for (const agent of agents) {
    const agentDir = join(basePath, 'agents', agent.id);
    if (agent.status === 'dead') {
      agentReasons.set(agent.id, 'status is dead');
    } else if (!existsSync(agentDir)) {
      agentReasons.set(agent.id, 'agent directory is missing');
    } else if (cmuxResult.missing.has(agent.workspaceId)) {
      agentReasons.set(agent.id, 'cmux workspace is missing');
    }
  }

  const removedAgents = agents
    .filter(agent => agentReasons.has(agent.id))
    .map(agent => ({ id: agent.id, name: agent.name, reason: agentReasons.get(agent.id)! }));
  const removedAgentIds = new Set(removedAgents.map(a => a.id));
  const remainingAgents = agents
    .filter(agent => !removedAgentIds.has(agent.id))
    .map(agent => ({
      ...agent,
      parentId: agent.parentId && removedAgentIds.has(agent.parentId) ? undefined : agent.parentId,
      childIds: agent.childIds.filter(id => !removedAgentIds.has(id)),
    }));

  const remainingAgentIds = new Set(remainingAgents.map(a => a.id));
  const removedWorkspaces: CleanupSummary['removedWorkspaces'] = [];
  const remainingWorkspaces = workspaces.flatMap(ws => {
    const keptAgentIds = ws.agentIds.filter(id => remainingAgentIds.has(id));
    if (cmuxResult.missing.has(ws.workspaceId)) {
      removedWorkspaces.push({ id: ws.id, name: ws.name, reason: 'cmux workspace is missing' });
      return [];
    }
    if (pruneEmptyWorkspaces && keptAgentIds.length === 0) {
      removedWorkspaces.push({ id: ws.id, name: ws.name, reason: 'no live agents remain' });
      return [];
    }
    return [{ ...ws, agentIds: keptAgentIds }];
  });

  const updatedTasks: CleanupSummary['updatedTasks'] = [];
  const cleanedTasks = tasks.map(task => {
    if (task.assigneeId && removedAgentIds.has(task.assigneeId)) {
      updatedTasks.push({ id: task.id, title: task.title, previousAssigneeId: task.assigneeId });
      return {
        ...task,
        assigneeId: undefined,
        status: task.status === 'done' ? task.status : 'blocked',
        updatedAt: Date.now(),
      } as Task;
    }
    return task;
  });

  if (!dryRun) {
    if (existsSync(agentsPath)) atomicWriteJson(agentsPath, remainingAgents);
    if (existsSync(workspacesPath)) atomicWriteJson(workspacesPath, remainingWorkspaces);
    if (existsSync(tasksPath)) atomicWriteJson(tasksPath, cleanedTasks);
    for (const agent of removedAgents) {
      rmSync(join(basePath, 'agents', agent.id), { recursive: true, force: true });
    }
  }

  return {
    basePath,
    dryRun,
    cmuxChecked: cmuxResult.checked,
    cmuxError: cmuxResult.error,
    removedAgents,
    removedWorkspaces,
    updatedTasks,
  };
}

export async function runCleanupCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const dryRun = args.includes('--dry-run');
  const noCmux = args.includes('--no-cmux');
  const pruneEmptyWorkspaces = args.includes('--prune-empty');
  const basePathArgIndex = args.indexOf('--base-path');
  const explicitBasePath = basePathArgIndex >= 0 ? args[basePathArgIndex + 1] : undefined;

  let basePath = explicitBasePath;
  if (!basePath) {
    basePath = resolveRuntimeBasePath();
  }

  const summary = await cleanupRuntimeState({
    basePath,
    dryRun,
    checkCmux: !noCmux,
    pruneEmptyWorkspaces,
  });

  console.log(`auto-cmux clean${dryRun ? ' (dry run)' : ''}`);
  console.log(`Runtime: ${summary.basePath}`);
  if (noCmux) {
    console.log('[info] cmux checks skipped by --no-cmux');
  }
  if (summary.cmuxChecked) {
    console.log('[ok] cmux state checked');
  } else if (summary.cmuxError) {
    console.log(`[warn] cmux unavailable; skipped live workspace checks: ${summary.cmuxError}`);
  }

  console.log(`[info] agents removed: ${summary.removedAgents.length}`);
  for (const agent of summary.removedAgents) {
    console.log(`  - ${agent.name} (${agent.id}): ${agent.reason}`);
  }
  console.log(`[info] workspaces removed: ${summary.removedWorkspaces.length}`);
  for (const ws of summary.removedWorkspaces) {
    console.log(`  - ${ws.name} (${ws.id}): ${ws.reason}`);
  }
  console.log(`[info] tasks updated: ${summary.updatedTasks.length}`);
  for (const task of summary.updatedTasks) {
    console.log(`  - ${task.id} ${task.title}: unassigned ${task.previousAssigneeId}`);
  }
}
