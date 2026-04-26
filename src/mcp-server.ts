import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, resolve } from 'path';
import { statSync, readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { CmuxClient } from './cmux-client.js';
import { AgentManager } from './agent-manager.js';
import { FileProtocol } from './file-protocol.js';
import { FileWatcher } from './file-watcher.js';
import { PtyMonitor } from './pty-monitor.js';
import { StreamParser, parseStreamFile } from './stream-parser.js';
import { loadConfig, getAgentConfig } from './config.js';
import { TaskManager } from './task-manager.js';
import { ReactionsDispatcher } from './reactions.js';
import { TelemetryTracker } from './telemetry.js';
import {
  loadProjectConfig,
  getProjectConfig,
  startConfigWatch,
  stopConfigWatch,
  validateProjectConfigReferences,
} from './config-loader.js';
import { MemoryStore } from './memory-store.js';
import { WorktreeManager } from './worktree-manager.js';
import { ActionProcessor } from './action-processor.js';
import type { Agent, ReactionEvent, RigAgentSpec, RigEdge, Task } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

function buildTaskPrompt(task: Task): string {
  const deps = task.dependsOn.length > 0 ? `\nDepends on: ${task.dependsOn.join(', ')}` : '';
  return `## Task: ${task.title}\n\n${task.description}\n\nTask ID: ${task.id}\nPriority: ${task.priority}${deps}`;
}

/**
 * Topological sort for rig agents based on edges.
 * Edges define data flow: from → to means "from" should spawn before "to".
 * Returns agents in spawn order. Throws on cycles.
 */
export function topoSortRigAgents(agents: RigAgentSpec[], edges: RigEdge[]): RigAgentSpec[] {
  if (!edges || edges.length === 0) return agents;

  // Build name → agent mapping
  const nameToAgent = new Map<string, RigAgentSpec>();
  for (const a of agents) {
    nameToAgent.set(a.name ?? a.role, a);
  }

  // Build adjacency list and in-degree count (from → to means from must come first)
  const adj = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  for (const a of agents) {
    const name = a.name ?? a.role;
    adj.set(name, new Set());
    inDegree.set(name, 0);
  }

  for (const edge of edges) {
    const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
    const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
    for (const from of froms) {
      for (const to of tos) {
        // from must spawn before to
        if (adj.has(from) && adj.has(to) && !adj.get(from)!.has(to)) {
          adj.get(from)!.add(to);
          inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
        }
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const sorted: RigAgentSpec[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const agent = nameToAgent.get(name);
    if (agent) sorted.push(agent);
    for (const neighbor of adj.get(name) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length < agents.length) {
    const remaining = agents
      .filter(a => !sorted.includes(a))
      .map(a => a.name ?? a.role);
    throw new Error(`Cycle detected in rig edges involving: ${remaining.join(', ')}`);
  }

  return sorted;
}

/**
 * Build edge context string for an agent's prompt, describing upstream/downstream peers.
 */
export function buildEdgeContext(agentName: string, edges: RigEdge[]): string | null {
  if (!edges || edges.length === 0) return null;

  const upstream: string[] = [];
  const downstream: string[] = [];

  for (const edge of edges) {
    const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
    const tos = Array.isArray(edge.to) ? edge.to : [edge.to];

    if (tos.includes(agentName)) {
      upstream.push(...froms);
    }
    if (froms.includes(agentName)) {
      downstream.push(...tos);
    }
  }

  if (upstream.length === 0 && downstream.length === 0) return null;

  const parts: string[] = [];
  if (upstream.length > 0) {
    parts.push(`Upstream (you may receive input from): ${upstream.join(', ')}`);
  }
  if (downstream.length > 0) {
    parts.push(`Downstream (send results to): ${downstream.join(', ')}`);
  }
  return parts.join('\n');
}

function drainAgentActions(agentManager: AgentManager, fileProtocol: FileProtocol, agent: Agent): void {
  const { actions, errors } = fileProtocol.readNewActions(agent.id);
  if (actions.length > 0) {
    agentManager.handleActions(agent.id, actions);
  }
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`[${agent.name}] parse error in actions.md: ${err.error} (line: ${err.line})`);
      fileProtocol.writeInbox(agent.id, `\n[SYSTEM] Your last action could not be parsed: ${err.error}\nMalformed line: ${err.line}\n`);
    }
  }
}

function drainAllAgentActions(agentManager: AgentManager, fileProtocol: FileProtocol): void {
  for (const agent of agentManager.list()) {
    drainAgentActions(agentManager, fileProtocol, agent);
  }
}

interface WireRuntimeResult {
  reactionsDispatcher: ReactionsDispatcher;
  actionProcessor: ActionProcessor;
  destroy: () => void;
}

function wireRuntime(
  cmuxClient: CmuxClient,
  agentManager: AgentManager,
  fileProtocol: FileProtocol,
  basePath: string,
  telemetry: TelemetryTracker,
): WireRuntimeResult {
  const fileWatcher = new FileWatcher(basePath);
  const ptyMonitor = new PtyMonitor(cmuxClient);
  const streamParser = new StreamParser();
  const projectConfig = getProjectConfig();
  const reactions = new ReactionsDispatcher(agentManager, fileProtocol, cmuxClient, {
    rules: projectConfig.reactions as unknown as import('./types.js').ReactionRule[],
    stallTimeoutMs: projectConfig.agents.assignment.stallTimeoutSec * 1000,
  });

  const watchAgent = (agent: Agent) => {
    if (!agent.surfaceId || agent.status === 'dead') return;
    const config = getAgentConfig(agent.cli);
    if (config.supportsStreamJson) {
      // Structured monitoring via stream-json file
      streamParser.watch(agent.id, agentManager.getStreamPath(agent.id));
    } else {
      // Fallback: terminal output scraping
      ptyMonitor.watch(agent.id, agent.surfaceId, agent.status === 'working');
    }
  };

  for (const agent of agentManager.list()) {
    watchAgent(agent);
  }

  agentManager.on('spawned', (agent: Agent) => {
    watchAgent(agent);
  });

  agentManager.on('killed', (agentId: string) => {
    streamParser.unwatch(agentId);
    ptyMonitor.unwatch(agentId);
    reactions.resetAgent(agentId);
  });

  // Re-watch stream when an agent is resumed via assignTask
  agentManager.on('task_assigned', (agentId: string) => {
    const agent = agentManager.get(agentId);
    if (!agent) return;
    const config = getAgentConfig(agent.cli);
    if (config.supportsStreamJson) {
      const streamPath = agentManager.getStreamPath(agentId);
      // Start watching from current file end to avoid re-processing old data
      let startOffset = 0;
      try {
        startOffset = statSync(streamPath).size;
      } catch { /* file may not exist yet */ }
      streamParser.watch(agentId, streamPath, startOffset);
    } else {
      ptyMonitor.watch(agentId, agent.surfaceId, true);
    }
  });

  agentManager.on('status_changed', (agentId: string, status: string) => {
    if (status === 'dead') {
      streamParser.unwatch(agentId);
      ptyMonitor.unwatch(agentId);
    } else {
      ptyMonitor.setActive(agentId, status === 'working');
    }
  });

  // ── FileWatcher → actions.md changes ──
  fileWatcher.on('actions-changed', (agentId: string) => {
    const agent = agentManager.get(agentId);
    if (agent) drainAgentActions(agentManager, fileProtocol, agent);
  });

  fileWatcher.on('stream-changed', (agentId: string) => {
    const text = fileProtocol.readNewStreamText(agentId);
    if (text) agentManager.handleStreamText(agentId, text);
  });

  fileWatcher.on('error', (err) => {
    console.error(`[auto-cmux] file watcher error: ${err.message}`);
  });

  // ── StreamParser events (Claude Code / stream-json CLIs) ──
  streamParser.on('init', (agentId: string, event: { session_id: string }) => {
    const agent = agentManager.get(agentId);
    if (agent && !agent.sessionId) {
      agent.sessionId = event.session_id;
      agentManager.persistState();
      console.error(`[auto-cmux] ${agent.name} session: ${event.session_id}`);
    }
  });

  streamParser.on('tool_use', (agentId: string, toolName: string) => {
    const agent = agentManager.get(agentId);
    console.error(`[auto-cmux] ${agent?.name ?? agentId} → ${toolName}`);
    telemetry.recordToolCall(agentId, toolName);
  });

  streamParser.on('result', (agentId: string, event: {
    subtype: string; total_cost_usd?: number; session_id: string;
    num_turns?: number; usage?: { input_tokens: number; output_tokens: number };
  }) => {
    const agent = agentManager.get(agentId);
    if (agent) {
      agent.sessionId = event.session_id;
      // Only truly fatal errors → dead; everything else (success, max_turns, max_budget) → idle
      const fatalSubtypes = new Set(['error_during_execution']);
      const isFatal = fatalSubtypes.has(event.subtype);

      // Drain any pending actions first (the agent may have written done just before exiting)
      drainAgentActions(agentManager, fileProtocol, agent);

      // If the agent finished without writing a done/error action,
      // synthesize one so parent notification and status transition still happen.
      if (agent.status === 'working') {
        const syntheticAction = isFatal
          ? { action: 'error' as const, message: `CLI exited with: ${event.subtype}` }
          : { action: 'done' as const, summary: `Completed (auto-detected from stream result)` };
        agentManager.handleActions(agentId, [syntheticAction]);
        console.error(`[auto-cmux] ${agent.name}: synthesized ${syntheticAction.action} (no explicit action written)`);
      } else if (agent.status !== 'idle' && agent.status !== 'dead') {
        agentManager.setStatus(agentId, isFatal ? 'dead' : 'idle');
      }

      console.error(`[auto-cmux] ${agent.name} finished: ${event.subtype} ($${event.total_cost_usd?.toFixed(4) ?? '?'})`);
    }
    telemetry.recordResult(agentId, {
      costUsd: event.total_cost_usd,
      inputTokens: event.usage?.input_tokens,
      outputTokens: event.usage?.output_tokens,
      turnCount: event.num_turns,
    });
    streamParser.unwatch(agentId);
  });

  streamParser.on('context_percent', (agentId: string, percent: number) => {
    telemetry.updateContextPercent(agentId, percent);
  });

  streamParser.on('rate_limited', (agentId: string) => {
    const agent = agentManager.get(agentId);
    console.error(`[auto-cmux] ${agent?.name ?? agentId} rate limited`);
    agentManager.handleRateLimit(agentId, Date.now() + 60_000);
    reactions.dispatch('rate-limited', agentId, 'Stream-json rate limit detected');
    streamParser.unwatch(agentId);
  });

  streamParser.on('error', (agentId: string, error: string) => {
    const agent = agentManager.get(agentId);
    console.error(`[auto-cmux] ${agent?.name ?? agentId} error: ${error}`);
  });

  // ── PtyMonitor events (non-stream CLIs) ──
  ptyMonitor.on('rate_limited', (event: { agentId: string; resumeAt: number }) => {
    agentManager.handleRateLimit(event.agentId, event.resumeAt);
    reactions.dispatch('rate-limited', event.agentId, `Resume at ${new Date(event.resumeAt).toISOString()}`);
  });

  ptyMonitor.on('human_needed', async (event: { agentId: string; message: string }) => {
    await reactions.dispatch('hitl', event.agentId, event.message);
    const agent = agentManager.get(event.agentId);
    if (!agent) return;
    try {
      await cmuxClient.notify(`auto-cmux: ${agent.name}`, event.message);
    } catch {
      // Notifications are best-effort; MCP stdio must remain quiet on stdout.
    }
  });

  ptyMonitor.on('crashed', (event: { agentId: string }) => {
    agentManager.setStatus(event.agentId, 'dead');
    reactions.dispatch('agent-crashed', event.agentId, 'CLI process exited');
  });

  ptyMonitor.on('low_context', (event: { agentId: string; ctxPercent: number }) => {
    reactions.dispatch('low-context', event.agentId, `Context at ${event.ctxPercent}%`);
  });

  // ── Telemetry events ──
  telemetry.on('low_context', (agentId: string, percent: number) => {
    reactions.dispatch('low-context', agentId, `Context at ${percent}%`);
  });

  telemetry.on('budget_exceeded', (_agentId: string, totalCents: number, limitCents: number) => {
    console.error(`[auto-cmux] BUDGET EXCEEDED: $${(totalCents / 100).toFixed(2)} / $${(limitCents / 100).toFixed(2)}`);
    for (const agent of agentManager.list()) {
      if (agent.status === 'working') {
        agentManager.setStatus(agent.id, 'idle');
        fileProtocol.writeInbox(agent.id, '\n\n⚠️ Daily budget exceeded. Pausing work.\n');
      }
    }
  });

  telemetry.on('budget_warning', (_agentId: string, totalCents: number, limitCents: number) => {
    console.error(`[auto-cmux] Budget warning: $${(totalCents / 100).toFixed(2)} / $${(limitCents / 100).toFixed(2)} (${((totalCents / limitCents) * 100).toFixed(0)}%)`);
  });

  agentManager.on('killed', (agentId: string) => {
    telemetry.remove(agentId);
  });

  // ── Reactions logging ──
  reactions.on('escalated', (info: { agentId: string; event: string; details: string }) => {
    const agent = agentManager.get(info.agentId);
    console.error(`[auto-cmux] ESCALATED: ${agent?.name ?? info.agentId} — ${info.event}: ${info.details}`);
  });

  reactions.on('action_executed', (info: { action: string; agentId: string; event: string }) => {
    const agent = agentManager.get(info.agentId);
    console.error(`[auto-cmux] reaction: ${info.action} for ${agent?.name ?? info.agentId} (${info.event})`);
  });

  // ── ActionProcessor — routes spawn/delegate/ask/answer/report/message actions ──
  const actionProcessor = new ActionProcessor(agentManager, fileProtocol, cmuxClient, getProjectConfig, basePath);

  agentManager.on('actions', (agentId: string, actions: Array<{ action: string; [k: string]: unknown }>) => {
    for (const action of actions) {
      actionProcessor.processAction(agentId, action).catch(err => {
        console.error(`[auto-cmux] action processing error: ${(err as Error).message}`);
      });
    }
  });

  actionProcessor.on('spawn_processed', (info: { parentId: string; childName: string }) => {
    const parent = agentManager.get(info.parentId);
    console.error(`[auto-cmux] ${parent?.name ?? info.parentId} spawned sub-agent ${info.childName}`);
  });

  actionProcessor.on('action_error', (info: { action: string; agentId: string; error: string }) => {
    console.error(`[auto-cmux] action error: ${info.action} for ${info.agentId}: ${info.error}`);
  });

  // ── Start stall detection + file watcher ──
  reactions.startStallDetection();
  fileWatcher.start();

  // ── Periodic stale workspace cleanup (every 60s) ──
  const cleanupInterval = setInterval(() => {
    agentManager.cleanupStaleWorkspaces().catch(err => {
      console.error(`[auto-cmux] stale workspace cleanup error: ${(err as Error).message}`);
    });
  }, 60_000);
  cleanupInterval.unref();

  const destroy = () => {
    clearInterval(cleanupInterval);
    reactions.destroy();
    actionProcessor.destroy();
    fileWatcher.stop();
    streamParser.unwatchAll();
    ptyMonitor.unwatchAll();
  };

  return { reactionsDispatcher: reactions, actionProcessor, destroy };
}

export interface McpServerDeps {
  cmuxClient: CmuxClient;
  agentManager: AgentManager;
  fileProtocol: FileProtocol;
  taskManager: TaskManager;
  reactionsDispatcher: ReactionsDispatcher;
  memoryStore: MemoryStore;
  telemetryTracker: TelemetryTracker;
  worktreeManager?: WorktreeManager;
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const { cmuxClient, agentManager, fileProtocol, taskManager, reactionsDispatcher, memoryStore, telemetryTracker, worktreeManager } = deps;

  const server = new McpServer({
    name: 'auto-cmux',
    version: '0.1.0',
  });

  // ── cmux control tools ──

  server.tool(
    'create_workspace',
    'Create a new cmux workspace (tab)',
    {
      name: z.string().optional().describe('Workspace title'),
      title: z.string().optional().describe('Workspace title'),
      cwd: z.string().optional().describe('Working directory'),
      window_id: z.string().optional().describe('Window ID to create workspace in'),
    },
    async ({ name, title, cwd, window_id }) => {
      try {
        const result = await cmuxClient.createWorkspace({ title: title ?? name, cwd, windowId: window_id });
        return jsonResult(result);
      } catch (e: any) {
        return errorResult(`Failed to create workspace: ${e.message}`);
      }
    },
  );

  server.tool(
    'list_workspaces',
    'List all cmux workspaces',
    { window_id: z.string().optional().describe('Window ID to list workspaces for') },
    async ({ window_id }) => {
      try {
        const workspaces = await cmuxClient.listWorkspaces(window_id);
        return jsonResult(workspaces);
      } catch (e: any) {
        return errorResult(`Failed to list workspaces: ${e.message}`);
      }
    },
  );

  server.tool(
    'read_surface',
    'Read terminal output from a cmux surface',
    {
      surface_id: z.string().optional().describe('Surface ID to read from'),
      lines: z.number().optional().describe('Number of lines to read'),
    },
    async ({ surface_id, lines }) => {
      try {
        const text = await cmuxClient.readText(surface_id, lines);
        return textResult(text);
      } catch (e: any) {
        return errorResult(`Failed to read surface: ${e.message}`);
      }
    },
  );

  server.tool(
    'close_workspace',
    'Close a cmux workspace',
    { workspace_id: z.string().describe('Workspace ID to close') },
    async ({ workspace_id }) => {
      try {
        await cmuxClient.closeWorkspace(workspace_id);
        return textResult(`Workspace ${workspace_id} closed.`);
      } catch (e: any) {
        return errorResult(`Failed to close workspace: ${e.message}`);
      }
    },
  );

  server.tool(
    'rename_workspace',
    'Rename a cmux workspace',
    {
      workspace_id: z.string().describe('Workspace ID to rename'),
      title: z.string().describe('New workspace title'),
    },
    async ({ workspace_id, title }) => {
      try {
        await cmuxClient.renameWorkspace(workspace_id, title);
        return textResult(`Workspace ${workspace_id} renamed to "${title}".`);
      } catch (e: any) {
        return errorResult(`Failed to rename workspace: ${e.message}`);
      }
    },
  );

  // ── workspace management tools ──

  server.tool(
    'create_agent_workspace',
    'Create a managed workspace where multiple agents can work together',
    {
      name: z.string().describe('Workspace name (e.g. "FE", "BE", "UI/UX")'),
      cwd: z.string().optional().describe('Working directory'),
      use_worktree: z.boolean().optional().describe('Create a git worktree for this workspace'),
    },
    async ({ name, cwd, use_worktree }) => {
      try {
        let effectiveCwd = cwd;
        if (use_worktree && worktreeManager) {
          const wtPath = worktreeManager.create(name);
          if (wtPath) {
            effectiveCwd = wtPath;
            console.error(`[auto-cmux] worktree created for workspace ${name}: ${wtPath}`);
          }
        }
        const ws = await agentManager.createManagedWorkspace(name, effectiveCwd);
        return jsonResult({ id: ws.id, name: ws.name, workspaceId: ws.workspaceId, cwd: ws.cwd });
      } catch (e: any) {
        return errorResult(`Failed to create workspace: ${e.message}`);
      }
    },
  );

  server.tool(
    'spawn_in_workspace',
    'Spawn an agent inside an existing workspace (as a split pane)',
    {
      workspace: z.string().describe('Workspace name'),
      name: z.string().describe('Unique agent name'),
      cli: z.enum(['claude', 'codex']).default('claude').describe('CLI tool'),
      prompt: z.string().describe('Task prompt'),
      direction: z.enum(['right', 'down']).optional().describe('Split direction (auto if omitted: picks optimal direction for grid layout)'),
      parent: z.string().optional().describe('Parent agent name (creates hierarchy)'),
      role: z.string().optional().describe('Role ID from config'),
      model: z.string().optional().describe('Model override (e.g. "sonnet", "gpt-5.5")'),
    },
    async ({ workspace, name, cli, prompt, direction, parent, role, model }) => {
      try {
        const spawnOptions: { parentId?: string; roleId?: string; model?: string } = {};
        if (parent) {
          const parentAgent = agentManager.findByName(parent);
          if (!parentAgent) return errorResult(`Parent agent "${parent}" not found.`);
          spawnOptions.parentId = parentAgent.id;
        }
        if (role) spawnOptions.roleId = role;

        // Resolve model: explicit param > role config > none
        const roleConfig = role ? getProjectConfig().agents.roles.find(r => r.id === role) : undefined;
        spawnOptions.model = model ?? roleConfig?.model;

        const agent = await agentManager.spawnInWorkspace(workspace, name, cli, prompt, direction, spawnOptions);
        return jsonResult({
          id: agent.id, name: agent.name, cli: agent.cli,
          workspaceId: agent.workspaceId, surfaceId: agent.surfaceId,
          parentId: agent.parentId, roleId: agent.roleId,
        });
      } catch (e: any) {
        return errorResult(`Failed to spawn in workspace: ${e.message}`);
      }
    },
  );

  server.tool(
    'list_managed_workspaces',
    'List all managed workspaces and their agents',
    async () => {
      const workspaces = agentManager.listWorkspaces();
      return jsonResult(workspaces.map(ws => ({
        name: ws.name,
        workspaceId: ws.workspaceId,
        agents: agentManager.getWorkspaceAgents(ws.name).map(a => ({
          name: a.name, status: a.status, cli: a.cli,
        })),
      })));
    },
  );

  // ── agent management tools ──

  server.tool(
    'spawn_agent',
    'Spawn a new AI coding agent in its own cmux tab (1 agent = 1 tab)',
    {
      name: z.string().describe('Unique agent name'),
      cli: z.enum(['claude', 'codex']).default('claude').describe('CLI tool to use'),
      prompt: z.string().describe('Initial prompt for the agent'),
      cwd: z.string().optional().describe('Working directory'),
      parent: z.string().optional().describe('Parent agent name (creates parent-child hierarchy)'),
      role: z.string().optional().describe('Role ID from config'),
      model: z.string().optional().describe('Model override (e.g. "sonnet", "gpt-5.5")'),
      task_id: z.string().optional().describe('Task ID to auto-assign after spawn'),
    },
    async ({ name, cli, prompt, cwd, parent, role, model, task_id }) => {
      try {
        // Validate parent
        let parentId: string | undefined;
        if (parent) {
          const parentAgent = agentManager.findByName(parent);
          if (!parentAgent) return errorResult(`Parent agent "${parent}" not found.`);
          parentId = parentAgent.id;
        }

        // Validate task_id before spawn
        let taskForSpawn: Task | undefined;
        if (task_id) {
          const task = taskManager.get(task_id);
          if (!task) return errorResult(`Task "${task_id}" not found.`);
          if (task.status !== 'ready') {
            return errorResult(`Task "${task_id}" is "${task.status}", must be "ready" to assign.`);
          }
          taskForSpawn = task;
        }

        // Resolve model: explicit param > role config > none
        const roleConfig = role ? getProjectConfig().agents.roles.find(r => r.id === role) : undefined;
        const effectiveModel = model ?? roleConfig?.model;
        const effectivePrompt = taskForSpawn ? buildTaskPrompt(taskForSpawn) : prompt;

        let agent: Agent;
        let worktreePath: string | undefined;

        // Role-based workspace routing: if role has a workspace configured, auto-route there
        const roleWorkspace = roleConfig?.workspace;
        if (roleWorkspace) {
          let ws = agentManager.findWorkspaceByName(roleWorkspace);
          if (!ws) {
            let effectiveCwd = cwd;
            if (worktreeManager) {
              worktreePath = worktreeManager.create(roleWorkspace) ?? undefined;
              if (worktreePath) {
                effectiveCwd = worktreePath;
                console.error(`[auto-cmux] worktree created for workspace ${roleWorkspace}: ${worktreePath}`);
              }
            }
            ws = await agentManager.createManagedWorkspace(roleWorkspace, effectiveCwd);
          }
          agent = await agentManager.spawnInWorkspace(roleWorkspace, name, cli, effectivePrompt, undefined, {
            parentId,
            roleId: role,
            model: effectiveModel,
          });
        } else {
          let effectiveCwd = cwd;
          if (worktreeManager) {
            worktreePath = worktreeManager.create(name) ?? undefined;
            if (worktreePath) {
              effectiveCwd = worktreePath;
              console.error(`[auto-cmux] worktree created for ${name}: ${worktreePath}`);
            }
          }
          agent = await agentManager.spawn(name, cli, effectivePrompt, effectiveCwd, {
            parentId,
            roleId: role,
            model: effectiveModel,
          });
        }

        // Assign task after successful spawn
        if (task_id) {
          try {
            taskManager.assign(task_id, agent.id);
          } catch (e: any) {
            // Spawn succeeded but task assign failed — report but don't rollback spawn
            console.error(`[auto-cmux] task assign failed for ${agent.name}: ${e.message}`);
            return jsonResult({
              id: agent.id, name: agent.name, cli: agent.cli, status: agent.status,
              workspaceId: agent.workspaceId, surfaceId: agent.surfaceId,
              parentId: agent.parentId, depth: agent.depth, roleId: agent.roleId,
              worktreePath,
              warning: `Agent spawned but task assign failed: ${e.message}`,
            });
          }
        }

        return jsonResult({
          id: agent.id, name: agent.name, cli: agent.cli, status: agent.status,
          workspaceId: agent.workspaceId, surfaceId: agent.surfaceId,
          parentId: agent.parentId, depth: agent.depth, roleId: agent.roleId,
          worktreePath,
        });
      } catch (e: any) {
        return errorResult(`Failed to spawn agent: ${e.message}`);
      }
    },
  );

  server.tool(
    'list_agents',
    'List all managed agents and their status',
    async () => {
      drainAllAgentActions(agentManager, fileProtocol);
      const agents = agentManager.list();
      return jsonResult(agents.map((a: Agent) => ({
        id: a.id,
        name: a.name,
        cli: a.cli,
        status: a.status,
        cwd: a.cwd,
      })));
    },
  );

  server.tool(
    'agent_status',
    'Get detailed status of a specific agent',
    { name: z.string().describe('Agent name') },
    async ({ name }) => {
      const agent = agentManager.findByName(name);
        if (!agent) {
          return errorResult(`Agent "${name}" not found.`);
        }
        drainAgentActions(agentManager, fileProtocol, agent);
        return jsonResult(agent);
      },
  );

  server.tool(
    'kill_agent',
    'Kill a running agent and close its workspace',
    {
      name: z.string().describe('Agent name'),
      cascade: z.boolean().default(true).describe('Also kill all child agents'),
    },
    async ({ name, cascade }) => {
      try {
        const agent = agentManager.findByName(name);
        if (!agent) {
          return errorResult(`Agent "${name}" not found.`);
        }
        const childCount = agent.childIds.length;
        await agentManager.kill(agent.id, cascade);
        const msg = cascade && childCount > 0
          ? `Agent "${name}" and ${childCount} child agent(s) killed.`
          : `Agent "${name}" killed.`;
        return textResult(msg);
      } catch (e: any) {
        return errorResult(`Failed to kill agent: ${e.message}`);
      }
    },
  );

  server.tool(
    'get_result',
    'Get the latest result/actions from an agent',
    { name: z.string().describe('Agent name') },
    async ({ name }) => {
      try {
        const agent = agentManager.findByName(name);
        if (!agent) {
          return errorResult(`Agent "${name}" not found.`);
        }
        drainAgentActions(agentManager, fileProtocol, agent);
        const actions = fileProtocol.peekAll(agent.id);
        return jsonResult({ actions });
      } catch (e: any) {
        return errorResult(`Failed to get result: ${e.message}`);
      }
    },
  );

  server.tool(
    'get_agent_output',
    'Get the clean text output from an agent (parsed from stream-json, no raw JSON noise)',
    {
      name: z.string().describe('Agent name'),
      include_tool_calls: z.boolean().default(false).describe('Include tool call list separately'),
      verbose: z.boolean().default(false).describe('Show full interleaved timeline (text + tools + results)'),
    },
    async ({ name, include_tool_calls, verbose }) => {
      try {
        const agent = agentManager.findByName(name);
        if (!agent) {
          return errorResult(`Agent "${name}" not found.`);
        }
        const streamPath = agentManager.getStreamPath(agent.id);
        const output = parseStreamFile(streamPath);

        const parts: string[] = [];

        // Header
        parts.push(`Agent: ${agent.name} (${agent.cli})`);
        parts.push(`Status: ${output.status}`);
        if (output.model) parts.push(`Model: ${output.model}`);
        if (output.costUsd != null) parts.push(`Cost: $${output.costUsd.toFixed(4)}`);
        if (output.turns != null) parts.push(`Turns: ${output.turns}`);
        parts.push('');

        // Tool calls summary (optional)
        if (include_tool_calls && output.toolCalls.length > 0) {
          parts.push(`Tool calls (${output.toolCalls.length}):`);
          for (const tc of output.toolCalls) {
            parts.push(`  → ${tc.name} (${tc.id})`);
          }
          parts.push('');
        }

        // Timeline / Conversation Flow
        if (verbose && output.timeline.length > 0) {
          parts.push('--- Conversation Flow ---');
          for (const ev of output.timeline) {
            if (ev.type === 'text') {
              parts.push(ev.text!);
            } else if (ev.type === 'tool_use') {
              parts.push(`[Tool Use: ${ev.name}]`);
            } else if (ev.type === 'tool_result') {
              const prefix = ev.isError ? '[Tool Error]' : '[Tool Result]';
              parts.push(`${prefix}: ${ev.content}`);
            }
            parts.push('');
          }
        } else {
          // Default: Final result — prefer result field, fall back to text blocks
          const hasResult = output.result && output.result.trim().length > 0;
          if (hasResult) {
            parts.push('--- Result ---');
            parts.push(output.result!);
          } else if (output.textBlocks.length > 0) {
            parts.push('--- Output ---');
            for (const block of output.textBlocks) {
              if (block.trim()) parts.push(block.trim());
            }
          } else {
            // Fallback: read surface text directly
            try {
              const surfaceText = await cmuxClient.readText(agent.surfaceId);
              if (surfaceText && surfaceText.trim()) {
                parts.push('--- Surface Output ---');
                parts.push(surfaceText.trim());
              } else {
                parts.push('(no output yet)');
              }
            } catch {
              parts.push('(no output yet)');
            }
          }
        }

        // Also include actions.md results
        drainAgentActions(agentManager, fileProtocol, agent);
        const actions = fileProtocol.peekAll(agent.id);
        if (actions.length > 0) {
          parts.push('');
          parts.push('--- Actions ---');
          for (const a of actions) {
            parts.push(JSON.stringify(a));
          }
        }

        // Errors
        if (output.errors.length > 0) {
          parts.push('');
          parts.push('--- Errors ---');
          for (const e of output.errors) parts.push(e);
        }

        return textResult(parts.join('\n'));
      } catch (e: any) {
        return errorResult(`Failed to get agent output: ${e.message}`);
      }
    },
  );

  // ── messaging tools ──

  server.tool(
    'send_message',
    'Send a message to an agent via its inbox. Auto-resumes idle agents.',
    {
      to: z.string().describe('Target agent name'),
      content: z.string().describe('Message content'),
    },
    async ({ to, content }) => {
      try {
        const agent = agentManager.findByName(to);
        if (!agent) {
          return errorResult(`Agent "${to}" not found.`);
        }
        const resumed = await agentManager.resumeWithMessage(agent.id, content);
        const status = resumed ? 'resumed' : (agent.status === 'working' ? 'appended (agent is working)' : 'appended');
        return textResult(`Message sent to "${to}". Status: ${status}`);
      } catch (e: any) {
        return errorResult(`Failed to send message: ${e.message}`);
      }
    },
  );

  server.tool(
    'read_messages',
    'Read actions/messages from all agents',
    async () => {
      const agents = agentManager.list();
      const results: Record<string, unknown> = {};
      for (const agent of agents) {
        drainAgentActions(agentManager, fileProtocol, agent);
        const actions = fileProtocol.peekAll(agent.id);
        if (actions.length > 0) {
          results[agent.name] = { actions };
        }
      }
      return jsonResult(results);
    },
  );

  server.tool(
    'wait_for_result',
    'Block until an agent produces a done/error action, becomes idle, or timeout',
    {
      name: z.string().describe('Agent name'),
      timeout_ms: z.number().default(120000).describe('Timeout in milliseconds'),
    },
    async ({ name, timeout_ms }, extra) => {
      const agent = agentManager.findByName(name);
      if (!agent) {
        return errorResult(`Agent "${name}" not found.`);
      }

      const progressToken = `wait_for_result_${agent.id}`;
      const start = Date.now();
      while (Date.now() - start < timeout_ms) {
        drainAgentActions(agentManager, fileProtocol, agent);
        const actions = fileProtocol.peekAll(agent.id);
        const terminal = [...actions].reverse().find(
          (a) => a.action === 'done' || a.action === 'error',
        );
        if (terminal) {
          return jsonResult({ status: 'completed', result: terminal });
        }
        // Agent idle or dead without a terminal action (e.g. after delegate_to)
        if (agent.status === 'idle' || agent.status === 'dead') {
          const lastAction = actions.length > 0 ? actions[actions.length - 1] : null;
          return jsonResult({ status: agent.status, last_action: lastAction, actions });
        }
        await sleep(2000);
        // Progress notification to prevent MCP request timeout
        try {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: Date.now() - start, total: timeout_ms },
          });
        } catch { /* client may not support progress notifications */ }
      }

      return jsonResult({
        status: 'timeout',
        agent_status: agent.status,
        elapsed_ms: Date.now() - start,
      });
    },
  );

  // ── task management tools ──

  server.tool(
    'create_task',
    'Create a new task with optional dependencies',
    {
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Task priority'),
      depends_on: z.array(z.string()).optional().describe('Task IDs this task depends on'),
    },
    async ({ title, description, priority, depends_on }) => {
      try {
        const task = taskManager.create({ title, description, priority, dependsOn: depends_on });

        return jsonResult(task);
      } catch (e: any) {
        return errorResult(`Failed to create task: ${e.message}`);
      }
    },
  );

  server.tool(
    'update_task',
    'Update a task\'s title, description, priority, or result',
    {
      task_id: z.string().describe('Task ID (e.g. TASK-001)'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('New priority'),
      result: z.string().optional().describe('Result summary'),
    },
    async ({ task_id, title, description, priority, result }) => {
      try {
        const task = taskManager.update(task_id, { title, description, priority, result });

        return jsonResult(task);
      } catch (e: any) {
        return errorResult(`Failed to update task: ${e.message}`);
      }
    },
  );

  server.tool(
    'delete_task',
    'Delete a task',
    { task_id: z.string().describe('Task ID to delete') },
    async ({ task_id }) => {
      try {
        taskManager.delete(task_id);

        return textResult(`Task ${task_id} deleted.`);
      } catch (e: any) {
        return errorResult(`Failed to delete task: ${e.message}`);
      }
    },
  );

  server.tool(
    'list_tasks',
    'List tasks with optional filters',
    {
      status: z.enum(['backlog', 'ready', 'blocked', 'in-progress', 'review', 'rejected', 'done']).optional().describe('Filter by status'),
      assignee: z.string().optional().describe('Filter by assignee agent ID'),
      priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Filter by priority'),
    },
    async ({ status, assignee, priority }) => {
      const tasks = taskManager.list({ status, assigneeId: assignee, priority });
      return jsonResult(tasks);
    },
  );

  server.tool(
    'assign_task',
    'Assign a task to an agent and send the task prompt to its inbox',
    {
      task_id: z.string().describe('Task ID to assign'),
      agent_name: z.string().describe('Agent name to assign to'),
    },
    async ({ task_id, agent_name }) => {
      let assigned = false;
      try {
        const agent = agentManager.findByName(agent_name);
        if (!agent) return errorResult(`Agent "${agent_name}" not found.`);
        if (agent.status === 'working') {
          return errorResult(`Agent "${agent_name}" is already working. Wait for completion or kill it before assigning a new task.`);
        }
        if (agent.status === 'dead') {
          return errorResult(`Agent "${agent_name}" is dead. Spawn a new agent before assigning a task.`);
        }

        const task = taskManager.assign(task_id, agent.id);
        assigned = true;


        // Send task to agent and re-launch CLI (with --resume if supported)
        await agentManager.assignTask(agent.id, buildTaskPrompt(task));

        return jsonResult({ task, agent: { id: agent.id, name: agent.name } });
      } catch (e: any) {
        if (assigned) {
          try {
            taskManager.unassign(task_id);
          } catch { /* best-effort rollback */ }
        }
        return errorResult(`Failed to assign task: ${e.message}`);
      }
    },
  );

  server.tool(
    'complete_task',
    'Mark a task as done with an optional result summary. Auto-unblocks dependent tasks.',
    {
      task_id: z.string().describe('Task ID to complete'),
      result: z.string().optional().describe('Result summary'),
    },
    async ({ task_id, result }) => {
      try {
        const task = taskManager.complete(task_id, result);


        // List newly unblocked tasks
        const unblocked = taskManager.list({ status: 'ready' })
          .filter(t => t.id !== task_id);

        return jsonResult({ completed: task, unblocked_tasks: unblocked.map(t => t.id) });
      } catch (e: any) {
        return errorResult(`Failed to complete task: ${e.message}`);
      }
    },
  );

  // ── memory tools ──

  server.tool(
    'save_memory',
    'Save a learning memory entry (role-specific or project convention)',
    {
      type: z.enum(['role', 'convention']).describe('Memory type'),
      role_id: z.string().optional().describe('Role ID (required for role type)'),
      key: z.string().describe('Memory key (e.g. "test-pattern", "naming-convention")'),
      insight: z.string().describe('The learned insight'),
      confidence: z.number().min(0).max(1).default(0.8).describe('Confidence score (0-1)'),
    },
    async ({ type, role_id, key, insight, confidence }) => {
      try {
        if (type === 'role') {
          if (!role_id) return errorResult('role_id is required for role memory.');
          const entry = memoryStore.saveRoleMemory(role_id, key, insight, confidence);
          return jsonResult(entry);
        } else {
          const entry = memoryStore.saveConvention(key, insight, confidence);
          return jsonResult(entry);
        }
      } catch (e: any) {
        return errorResult(`Failed to save memory: ${e.message}`);
      }
    },
  );

  server.tool(
    'get_memory',
    'Retrieve learning memories (role-specific, conventions, or all)',
    {
      type: z.enum(['role', 'convention', 'all']).default('all').describe('Memory type filter'),
      role_id: z.string().optional().describe('Role ID (for role type filter)'),
    },
    async ({ type, role_id }) => {
      try {
        if (type === 'role' && role_id) {
          return jsonResult(memoryStore.getRoleMemoryDeduped(role_id));
        } else if (type === 'convention') {
          return jsonResult(memoryStore.getConventionsDeduped());
        } else {
          return jsonResult({
            roles: memoryStore.listRoles(),
            conventions: memoryStore.getConventionsDeduped(),
            all: memoryStore.getAll(),
          });
        }
      } catch (e: any) {
        return errorResult(`Failed to get memory: ${e.message}`);
      }
    },
  );

  // ── shared context tools ──

  server.tool(
    'read_shared',
    'Read shared context written by agents via the "share" action. Lists available keys or reads a specific key.',
    {
      key: z.string().optional().describe('Shared context key to read (omit to list all available keys)'),
    },
    async ({ key }) => {
      try {
        const sharedDir = join(resolve(getProjectConfig().project.root || '.', '.auto-cmux'), 'shared');
        if (key) {
          const safeKey = key.replace(/[^a-zA-Z0-9\-_]/g, '_');
          const filePath = join(sharedDir, `${safeKey}.md`);
          try {
            const content = readFileSync(filePath, 'utf-8');
            return textResult(content);
          } catch {
            return errorResult(`Shared key "${key}" not found.`);
          }
        }
        // List all available keys
        try {
          const files = readdirSync(sharedDir).filter(f => f.endsWith('.md'));
          const keys = files.map(f => f.replace(/\.md$/, ''));
          return jsonResult({ keys, count: keys.length });
        } catch {
          return jsonResult({ keys: [], count: 0 });
        }
      } catch (e: any) {
        return errorResult(`Failed to read shared context: ${e.message}`);
      }
    },
  );

  // ── reaction tools ──

  server.tool(
    'list_reactions',
    'List current reaction rules and active alerts',
    async () => {
      const rules = reactionsDispatcher.getRules();
      const alerts = reactionsDispatcher.getActiveAlerts();
      return jsonResult({ rules, active_alerts: alerts });
    },
  );

  server.tool(
    'resolve_alert',
    'Resolve a pending HITL or escalation alert',
    {
      alert_id: z.string().describe('Alert ID to resolve'),
      resolution: z.string().describe('Resolution action (e.g. "approved", "rejected", or custom response)'),
      send_to_agent: z.boolean().default(false).describe('Send resolution text to the agent\'s inbox'),
    },
    async ({ alert_id, resolution, send_to_agent }) => {
      try {
        const alert = reactionsDispatcher.resolveAlert(alert_id, resolution);
        if (!alert) {
          return errorResult(`Alert "${alert_id}" not found or already resolved.`);
        }

        if (send_to_agent) {
          const agent = agentManager.get(alert.agentId);
          if (agent) {
            fileProtocol.writeInbox(agent.id, resolution);
          }
        }

        return jsonResult({ resolved: alert });
      } catch (e: any) {
        return errorResult(`Failed to resolve alert: ${e.message}`);
      }
    },
  );

  // ── communication + telemetry tools ──

  server.tool(
    'broadcast',
    'Broadcast a message to multiple agents (all or filtered by role/status)',
    {
      content: z.string().describe('Message content to broadcast'),
      role: z.string().optional().describe('Filter: only send to agents with this role ID'),
      status: z.enum(['idle', 'working', 'rate-limited', 'dead']).optional().describe('Filter: only send to agents with this status'),
    },
    async ({ content, role, status }) => {
      try {
        let agents = agentManager.list();
        if (status) agents = agents.filter(a => a.status === status);
        if (role) agents = agents.filter(a => a.roleId === role);
        if (agents.length === 0) return errorResult('No agents matched the filter.');

        fileProtocol.broadcast(agents.map(a => a.id), content);
        return jsonResult({
          sent_to: agents.map(a => a.name),
          count: agents.length,
        });
      } catch (e: any) {
        return errorResult(`Failed to broadcast: ${e.message}`);
      }
    },
  );

  server.tool(
    'get_telemetry',
    'Get cost/token usage telemetry for agents',
    {
      agent_name: z.string().optional().describe('Specific agent name (omit for all agents)'),
    },
    async ({ agent_name }) => {
      if (agent_name) {
        const agent = agentManager.findByName(agent_name);
        if (!agent) return errorResult(`Agent "${agent_name}" not found.`);
        const t = telemetryTracker.get(agent.id);
        if (!t) return jsonResult({ agent: agent_name, message: 'No telemetry data yet.' });
        return jsonResult({
          agent: agent_name,
          totalCostUsd: t.totalCostCents / 100,
          totalTokens: t.totalTokens,
          turnCount: t.turnCount,
          toolCallCount: t.toolCallCount,
          contextPercent: t.contextPercent,
        });
      }

      const all = telemetryTracker.getAll();
      const dailyTotalCents = telemetryTracker.getDailyTotalCents();
      return jsonResult({
        dailyTotalCostUsd: dailyTotalCents / 100,
        budgetExceeded: telemetryTracker.isBudgetExceeded(),
        budgetWarning: telemetryTracker.isBudgetWarning(),
        agents: all.map(t => {
          const agent = agentManager.get(t.agentId);
          return {
            agent: agent?.name ?? t.agentId,
            totalCostUsd: t.totalCostCents / 100,
            totalTokens: t.totalTokens,
            turnCount: t.turnCount,
            toolCallCount: t.toolCallCount,
            contextPercent: t.contextPercent,
          };
        }),
      });
    },
  );

  server.tool(
    'get_team_status',
    'Get a comprehensive team status snapshot (agents + tasks + telemetry summary)',
    async () => {
      drainAllAgentActions(agentManager, fileProtocol);
      const agents = agentManager.list();
      const tasks = taskManager.list();
      const dailyCostCents = telemetryTracker.getDailyTotalCents();

      return jsonResult({
        agents: agents.map(a => {
          const t = telemetryTracker.get(a.id);
          const assignedTasks = tasks.filter(tk => tk.assigneeId === a.id);
          const parent = a.parentId ? agentManager.get(a.parentId) : undefined;
          return {
            name: a.name,
            cli: a.cli,
            status: a.status,
            parentName: parent?.name,
            childCount: a.childIds.length,
            depth: a.depth,
            roleId: a.roleId,
            costUsd: t ? t.totalCostCents / 100 : 0,
            contextPercent: t?.contextPercent,
            assignedTasks: assignedTasks.map(tk => ({ id: tk.id, title: tk.title, status: tk.status })),
          };
        }),
        taskSummary: {
          total: tasks.length,
          byStatus: {
            backlog: tasks.filter(t => t.status === 'backlog').length,
            ready: tasks.filter(t => t.status === 'ready').length,
            'in-progress': tasks.filter(t => t.status === 'in-progress').length,
            review: tasks.filter(t => t.status === 'review').length,
            done: tasks.filter(t => t.status === 'done').length,
            blocked: tasks.filter(t => t.status === 'blocked').length,
            rejected: tasks.filter(t => t.status === 'rejected').length,
          },
        },
        costSummary: {
          dailyTotalCostUsd: dailyCostCents / 100,
          budgetExceeded: telemetryTracker.isBudgetExceeded(),
          budgetWarning: telemetryTracker.isBudgetWarning(),
        },
      });
    },
  );

  // ── hierarchy tools ──

  server.tool(
    'get_agent_tree',
    'Get the hierarchical agent tree showing parent-child relationships',
    {
      root_agent: z.string().optional().describe('Agent name to use as root (omit for full forest)'),
    },
    async ({ root_agent }) => {
      try {
        if (root_agent) {
          const agent = agentManager.findByName(root_agent);
          if (!agent) return errorResult(`Agent "${root_agent}" not found.`);
          const tree = agentManager.getTree(agent.id);
          return jsonResult(tree);
        }
        const tree = agentManager.getTree();
        return jsonResult(tree);
      } catch (e: any) {
        return errorResult(`Failed to get agent tree: ${e.message}`);
      }
    },
  );

  server.tool(
    'get_agent_children',
    'List direct children of an agent',
    { name: z.string().describe('Parent agent name') },
    async ({ name }) => {
      const agent = agentManager.findByName(name);
      if (!agent) return errorResult(`Agent "${name}" not found.`);
      const children = agentManager.getChildren(agent.id);
      return jsonResult(children.map(c => ({
        id: c.id, name: c.name, cli: c.cli, status: c.status,
        roleId: c.roleId, depth: c.depth,
      })));
    },
  );

  // ── Rig (선언적 팀 구성) 도구 ──

  server.tool(
    'list_rigs',
    'List all available rigs defined in auto-cmux.yml with their agent specs',
    async () => {
      const config = getProjectConfig();
      const rigs = config.rigs ?? {};
      if (Object.keys(rigs).length === 0) {
        return textResult('No rigs defined. Add a "rigs" section to auto-cmux.yml.');
      }
      const result: Record<string, unknown> = {};
      for (const [name, rig] of Object.entries(rigs)) {
        const agents = rig.agents.map(a => {
          const role = config.agents.roles.find(r => r.id === a.role);
          return {
            name: a.name ?? a.role,
            role: a.role,
            cli: a.cli ?? role?.cli ?? 'claude',
            model: a.model ?? role?.model,
            workspace: a.workspace ?? role?.workspace,
          };
        });
        // Check which agents are currently alive
        const liveAgents = agents.filter(a => {
          const agent = agentManager.findByName(a.name);
          return agent && agent.status !== 'dead';
        });
        result[name] = {
          agents,
          edges: rig.edges ?? [],
          status: liveAgents.length === agents.length ? 'running'
            : liveAgents.length > 0 ? 'partial'
            : 'stopped',
          live: liveAgents.length,
          total: agents.length,
        };
      }
      return jsonResult(result);
    },
  );

  server.tool(
    'rig_up',
    'Boot a pre-defined team (rig) from auto-cmux.yml. Spawns all agents with their roles and workspaces.',
    {
      rig_name: z.string().describe('Rig name as defined in auto-cmux.yml rigs section'),
      prompt: z.string().optional().describe('Optional initial prompt/task to send to all agents'),
    },
    async ({ rig_name, prompt }) => {
      try {
        const config = getProjectConfig();
        const rigSpec = config.rigs?.[rig_name];
        if (!rigSpec) {
          const available = Object.keys(config.rigs ?? {});
          return errorResult(`Rig "${rig_name}" not found. Available rigs: ${available.length > 0 ? available.join(', ') : '(none defined)'}`);
        }

        // Pre-flight: validate roles, duplicate names, and name conflicts
        const resolvedNames = new Set<string>();
        for (const agentSpec of rigSpec.agents) {
          const role = config.agents.roles.find(r => r.id === agentSpec.role);
          if (!role) {
            return errorResult(`Role "${agentSpec.role}" referenced in rig "${rig_name}" is not defined in agents.roles`);
          }
          const agentName = agentSpec.name ?? agentSpec.role;
          if (resolvedNames.has(agentName)) {
            return errorResult(`Duplicate agent name "${agentName}" in rig "${rig_name}". Use the 'name' field to distinguish agents with the same role.`);
          }
          resolvedNames.add(agentName);
          const existing = agentManager.findByName(agentName);
          if (existing && existing.status !== 'dead') {
            return errorResult(`Agent "${agentName}" already exists (status: ${existing.status}). Run rig_down "${rig_name}" first.`);
          }
        }

        // Topological sort: respect edges for spawn ordering
        let sortedAgents: RigAgentSpec[];
        try {
          sortedAgents = topoSortRigAgents(rigSpec.agents, rigSpec.edges ?? []);
        } catch (e: any) {
          return errorResult(`Rig "${rig_name}" has invalid edges: ${e.message}`);
        }

        // Validate edge references
        if (rigSpec.edges) {
          for (const edge of rigSpec.edges) {
            const froms = Array.isArray(edge.from) ? edge.from : [edge.from];
            const tos = Array.isArray(edge.to) ? edge.to : [edge.to];
            for (const name of [...froms, ...tos]) {
              if (!resolvedNames.has(name)) {
                return errorResult(`Edge references unknown agent/role "${name}" in rig "${rig_name}". Available: ${[...resolvedNames].join(', ')}`);
              }
            }
          }
        }

        const spawned: Array<{ name: string; role: string; cli: string; workspace?: string }> = [];
        const errors: string[] = [];
        const createdWorktrees: string[] = [];

        for (const agentSpec of sortedAgents) {
          const role = config.agents.roles.find(r => r.id === agentSpec.role)!;
          const agentName = agentSpec.name ?? agentSpec.role;
          const cli = agentSpec.cli ?? role.cli ?? 'claude';
          const model = agentSpec.model ?? role.model;
          const workspaceName = agentSpec.workspace ?? role.workspace;

          // Build prompt with edge context (upstream/downstream peer awareness)
          let agentPrompt = prompt ?? `You are the **${agentSpec.role}** agent. Awaiting task assignment.`;
          const edgeCtx = buildEdgeContext(agentName, rigSpec.edges ?? []);
          if (edgeCtx) {
            agentPrompt += `\n\n## Data Flow\n\n${edgeCtx}`;
          }

          try {
            if (workspaceName) {
              // Ensure workspace exists
              let ws = agentManager.findWorkspaceByName(workspaceName);
              if (!ws) {
                let effectiveCwd: string | undefined;
                if (worktreeManager) {
                  const wtPath = worktreeManager.create(workspaceName);
                  if (wtPath) {
                    effectiveCwd = wtPath;
                    createdWorktrees.push(workspaceName);
                  }
                }
                ws = await agentManager.createManagedWorkspace(workspaceName, effectiveCwd);
              }
              await agentManager.spawnInWorkspace(workspaceName, agentName, cli, agentPrompt, undefined, {
                roleId: agentSpec.role,
                model,
              });
            } else {
              let effectiveCwd: string | undefined;
              if (worktreeManager) {
                const wtPath = worktreeManager.create(agentName);
                if (wtPath) {
                  effectiveCwd = wtPath;
                  createdWorktrees.push(agentName);
                }
              }
              await agentManager.spawn(agentName, cli, agentPrompt, effectiveCwd, {
                roleId: agentSpec.role,
                model,
              });
            }
            spawned.push({ name: agentName, role: agentSpec.role, cli, workspace: workspaceName });
          } catch (e: any) {
            errors.push(`${agentName}: ${e.message}`);
            // Rollback: kill already-spawned agents and clean up worktrees
            for (const s of spawned) {
              const a = agentManager.findByName(s.name);
              if (a) await agentManager.kill(a.id, true).catch(() => {});
            }
            if (worktreeManager) {
              for (const wt of createdWorktrees) {
                worktreeManager.remove(wt);
              }
            }
            return errorResult(`Rig "${rig_name}" failed at agent "${agentName}": ${e.message}. Rolled back ${spawned.length} already-spawned agent(s).`);
          }
        }

        return jsonResult({
          rig: rig_name,
          spawned,
          edges: rigSpec.edges ?? [],
          total: rigSpec.agents.length,
          success: spawned.length,
        });
      } catch (e: any) {
        return errorResult(`Failed to boot rig: ${e.message}`);
      }
    },
  );

  server.tool(
    'rig_down',
    'Shut down all agents belonging to a rig',
    {
      rig_name: z.string().describe('Rig name to shut down'),
    },
    async ({ rig_name }) => {
      try {
        const config = getProjectConfig();
        const rigSpec = config.rigs?.[rig_name];
        if (!rigSpec) {
          return errorResult(`Rig "${rig_name}" not found.`);
        }

        const killed: string[] = [];
        const errors: string[] = [];

        for (const agentSpec of rigSpec.agents) {
          const agentName = agentSpec.name ?? agentSpec.role;
          const agent = agentManager.findByName(agentName);
          if (!agent) continue;
          try {
            await agentManager.kill(agent.id, true);
            killed.push(agentName);
          } catch (e: any) {
            errors.push(`${agentName}: ${e.message}`);
          }
        }

        return jsonResult({ rig: rig_name, killed, errors: errors.length > 0 ? errors : undefined });
      } catch (e: any) {
        return errorResult(`Failed to shut down rig: ${e.message}`);
      }
    },
  );

  server.tool(
    'wait_for_children',
    'Check if all child agents of a parent are idle/done. Returns immediately with current status — poll again if children are still working.',
    {
      name: z.string().describe('Parent agent name'),
      timeout_ms: z.number().default(10000).describe('Max wait in ms (short poll). Kept low to avoid MCP request timeout.'),
    },
    async ({ name, timeout_ms }) => {
      const agent = agentManager.findByName(name);
      if (!agent) return errorResult(`Agent "${name}" not found.`);

      const effectiveTimeout = Math.min(timeout_ms, 15000);
      const start = Date.now();

      while (Date.now() - start < effectiveTimeout) {
        drainAllAgentActions(agentManager, fileProtocol);
        const children = agentManager.getChildren(agent.id);
        const allFinished = children.length === 0 || children.every(c => c.status === 'idle' || c.status === 'dead');
        if (allFinished) {
          const hadFailures = children.some(c => c.status === 'dead');
          return jsonResult({
            parent: name,
            children: children.map(c => ({ name: c.name, status: c.status })),
            all_completed: !hadFailures,
            had_failures: hadFailures,
          });
        }
        await sleep(2000);
      }

      const children = agentManager.getChildren(agent.id);
      return jsonResult({
        parent: name,
        children: children.map(c => ({ name: c.name, status: c.status })),
        all_completed: false,
        still_working: children.filter(c => c.status === 'working').map(c => c.name),
        elapsed_ms: Date.now() - start,
        hint: 'Some children are still working. Call wait_for_children again to poll.',
      });
    },
  );

  return server;
}

export async function startMcpServer(deps: McpServerDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function runStandaloneMcpServer(): Promise<void> {
  loadConfig();

  // Load project-level config (auto-cmux.yml) with hot-reload
  const projectConfig = loadProjectConfig();
  const configIssues = validateProjectConfigReferences(projectConfig);
  const configErrors = configIssues.filter(issue => issue.level === 'error');
  for (const issue of configIssues) {
    const prefix = issue.level === 'error' ? 'ERROR' : 'WARN';
    console.error(`[auto-cmux] config ${prefix} ${issue.path}: ${issue.message}${issue.hint ? ` Hint: ${issue.hint}` : ''}`);
  }
  if (configErrors.length > 0) {
    console.error(`[auto-cmux] ❌ Cannot start: auto-cmux.yml has ${configErrors.length} configuration error(s). Fix the errors above and retry.`);
    process.exit(1);
  }
  startConfigWatch();

  // Use project-local .auto-cmux/ so agent files (actions.md, inbox.md) live
  // inside the project directory — required for Codex sandbox compatibility.
  // resolve() ensures an absolute path even when project.root defaults to '.'
  const basePath = resolve(projectConfig.project.root || '.', '.auto-cmux');
  const cmuxClient = new CmuxClient();
  try {
    await cmuxClient.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[auto-cmux] ❌ Cannot start: ${message}`);
    console.error('[auto-cmux] Make sure cmux is installed and running. Install: https://github.com/cmux/cmux');
    process.exit(1);
  }

  const fileProtocol = new FileProtocol(basePath);
  const agentManager = new AgentManager(cmuxClient, fileProtocol, { basePath });
  const taskManager = new TaskManager(basePath);
  taskManager.restore();

  const memoryStore = new MemoryStore(basePath);
  const telemetry = new TelemetryTracker(basePath, projectConfig.costs);
  telemetry.loadToday();

  // Worktree manager — configured via auto-cmux.yml
  const worktreeManager = projectConfig.git.worktreeEnabled
    ? new WorktreeManager(projectConfig.project.root, projectConfig.git.branchPrefix, basePath)
    : null;
  if (worktreeManager) worktreeManager.restore();

  await agentManager.restoreState();
  const { reactionsDispatcher, actionProcessor, destroy: destroyRuntime } = wireRuntime(cmuxClient, agentManager, fileProtocol, basePath, telemetry);

  actionProcessor.on('review_started', (info: { developerAgentId: string }) => {
    taskManager.onAgentReviewStarted(info.developerAgentId);
  });
  actionProcessor.on('review_changes_requested', (info: { developerAgentId: string }) => {
    taskManager.onAgentReviewChangesRequested(info.developerAgentId);
  });
  actionProcessor.on('review_approved', (info: { developerAgentId: string; summary: string }) => {
    taskManager.onAgentReviewApproved(info.developerAgentId, info.summary);
  });
  actionProcessor.on('review_bypassed', (info: { developerAgentId: string; summary?: string }) => {
    taskManager.onAgentDone(info.developerAgentId, info.summary);
  });

  // Clean up on exit
  const cleanup = () => { destroyRuntime(); stopConfigWatch(); };
  process.on('beforeExit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // ── Agent ↔ Task lifecycle wiring ──
  agentManager.on('actions', (agentId: string, actions: Array<{ action: string; summary?: string; insight?: string }>) => {
    for (const action of actions) {
      if (action.action === 'done') {
        if (!actionProcessor.shouldDeferTaskCompletion(agentId)) {
          taskManager.onAgentDone(agentId, action.summary);
        }
      }
      // Handle remember_role action → save to memory store
      if (action.action === 'remember_role' && action.insight) {
        const agent = agentManager.get(agentId);
        if (agent) {
          memoryStore.saveRoleMemory(agent.roleId ?? agent.name, `auto-${Date.now()}`, action.insight);
        }
      }
    }
  });

  agentManager.on('status_changed', (agentId: string, status: string) => {
    if (status === 'dead') {
      taskManager.onAgentDied(agentId);
      taskManager.save();
    }
  });

  // ── Agent hierarchy logging ──
  agentManager.on('child_completed', (info: { parentId: string; childId: string; summary: string }) => {
    const parent = agentManager.get(info.parentId);
    const child = agentManager.get(info.childId);
    console.error(`[auto-cmux] ${child?.name ?? info.childId} completed → notified ${parent?.name ?? info.parentId}`);
  });

  // ── Agent ↔ Worktree lifecycle wiring (cleanup on kill) ──
  if (worktreeManager) {
    agentManager.on('killed', (_agentId: string, agentName: string) => {
      // Worktrees are keyed by agent name (known before spawn)
      worktreeManager.remove(agentName);
      console.error(`[auto-cmux] worktree removed for ${agentName}`);
    });
    agentManager.on('managed_workspace_removed', (ws: { name: string }) => {
      worktreeManager.remove(ws.name);
      console.error(`[auto-cmux] worktree removed for workspace ${ws.name}`);
    });
  }

  await startMcpServer({
    cmuxClient, agentManager, fileProtocol, taskManager, reactionsDispatcher,
    memoryStore, telemetryTracker: telemetry,
    worktreeManager: worktreeManager ?? undefined,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runStandaloneMcpServer().catch((err) => {
    console.error(`[auto-cmux] MCP server failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
