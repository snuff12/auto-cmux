import { EventEmitter } from 'events';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
  Action, Agent, SpawnAction, DelegateToAction,
  AskAction, AnswerAction, ReportToPmAction, MessageAction, ShareAction,
  DoneAction, ReviewConfig, ProjectConfig,
} from './types.js';
import { resolveConnections, isDelegationAllowed } from './edge-resolver.js';

// ──────────────────────────────────────────────────────────────────────────────
// Dependency interfaces (for testability)
// ──────────────────────────────────────────────────────────────────────────────

export interface AgentManagerLike {
  get(agentId: string): Agent | undefined;
  findByName(name: string): Agent | undefined;
  list(): Agent[];
  spawn(name: string, cli: string, prompt: string, cwd?: string, options?: { parentId?: string; roleId?: string; model?: string }): Promise<Agent>;
  spawnInWorkspace(workspaceName: string, agentName: string, cli: string, prompt: string, direction?: 'right' | 'down', options?: { parentId?: string; roleId?: string; model?: string }): Promise<Agent>;
  assignTask(agentId: string, prompt: string): Promise<void>;
  resumeWithMessage(agentId: string, message: string): Promise<boolean>;
  on(event: 'killed', listener: (agentId: string, agentName: string) => void): void;
  off(event: 'killed', listener: (agentId: string, agentName: string) => void): void;
}

export interface FileProtocolLike {
  writeInbox(agentId: string, content: string): void;
}

export interface CmuxClientLike {
  notify(title: string, body: string): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────────
// Safety constants
// ──────────────────────────────────────────────────────────────────────────────

/** Max times the same role+task hash can be delegated (prevents loops). */
const MAX_DELEGATE_REPEATS = 2;

/** Ask/answer timeout in ms (5 minutes). */
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────────────
// ActionProcessor
// ──────────────────────────────────────────────────────────────────────────────

export class ActionProcessor extends EventEmitter {
  private agentManager: AgentManagerLike;
  private fileProtocol: FileProtocolLike;
  private cmuxClient: CmuxClientLike;
  private getConfig: () => ProjectConfig;
  private basePath: string;

  /** Tracks delegate_to calls: "agentId:role:taskHash" → count */
  private delegateCounts = new Map<string, number>();

  /** Tracks pending ask questions: questionKey → { fromId, timer } */
  private pendingAsks = new Map<string, { fromId: string; timer: NodeJS.Timeout }>();

  /** Tracks review iteration counts: developerAgentId → iteration number */
  private reviewIterations = new Map<string, number>();

  /** Tracks pending reviews: reviewerAgentId → { developerAgentId, reviewConfig } */
  private pendingReviews = new Map<string, { developerAgentId: string; reviewConfig: ReviewConfig }>();

  private _onAgentKilled: (agentId: string) => void;

  constructor(
    agentManager: AgentManagerLike,
    fileProtocol: FileProtocolLike,
    cmuxClient: CmuxClientLike,
    getConfig: () => ProjectConfig,
    basePath: string = join(process.cwd(), '.auto-cmux'),
  ) {
    super();
    this.agentManager = agentManager;
    this.fileProtocol = fileProtocol;
    this.cmuxClient = cmuxClient;
    this.getConfig = getConfig;
    this.basePath = basePath;

    this._onAgentKilled = (agentId: string) => {
      for (const key of this.delegateCounts.keys()) {
        if (key.startsWith(`${agentId}:`)) {
          this.delegateCounts.delete(key);
        }
      }
      // Clean up workflow review state for killed agent
      this.reviewIterations.delete(agentId);
      this.pendingReviews.delete(agentId);
      for (const [reviewerId, pending] of this.pendingReviews.entries()) {
        if (pending.developerAgentId === agentId) {
          this.pendingReviews.delete(reviewerId);
        }
      }
    };
    agentManager.on('killed', this._onAgentKilled);
  }

  /**
   * Process an action from an agent's actions.md.
   * Returns true if the action was handled, false if it's not a routable action.
   */
  async processAction(agentId: string, action: Action): Promise<boolean> {
    switch (action.action) {
      case 'spawn':        await this.handleSpawn(agentId, action as SpawnAction); return true;
      case 'delegate_to':  await this.handleDelegate(agentId, action as DelegateToAction); return true;
      case 'ask':          this.handleAsk(agentId, action as AskAction); return true;
      case 'answer':       this.handleAnswer(agentId, action as AnswerAction); return true;
      case 'report_to_pm': await this.handleReport(agentId, action as ReportToPmAction); return true;
      case 'message':      this.handleMessage(agentId, action as MessageAction); return true;
      case 'share':        this.handleShare(agentId, action as ShareAction); return true;
      case 'done':         return this.handleDoneWithWorkflow(agentId, action as DoneAction);
      default:             return false; // error, status, remember_role handled elsewhere
    }
  }

  shouldDeferTaskCompletion(agentId: string): boolean {
    if (this.reviewIterations.has(agentId)) return true;
    for (const pending of this.pendingReviews.values()) {
      if (pending.developerAgentId === agentId) return true;
    }
    return false;
  }

  /**
   * Clean up timers.
   */
  destroy(): void {
    this.agentManager.off('killed', this._onAgentKilled);
    for (const { timer } of this.pendingAsks.values()) {
      clearTimeout(timer);
    }
    this.pendingAsks.clear();
    this.reviewIterations.clear();
    this.pendingReviews.clear();
    this.removeAllListeners();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Send a message to a target agent and auto-resume if idle.
   * Falls back to writeInbox if resume fails.
   */
  private resumeTarget(agentId: string, message: string): void {
    this.agentManager.resumeWithMessage(agentId, message).catch(err => {
      console.error(`[action-processor] Failed to resume agent ${agentId}: ${(err as Error).message}`);
    });
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  private async handleSpawn(parentId: string, action: SpawnAction): Promise<void> {
    const parent = this.agentManager.get(parentId);
    if (!parent) return;

    try {
      let child: Agent;
      if (action.workspace) {
        child = await this.agentManager.spawnInWorkspace(
          action.workspace,
          action.name,
          action.cli ?? 'claude',
          action.prompt,
          undefined,
          { parentId, model: action.model },
        );
      } else {
        child = await this.agentManager.spawn(
          action.name,
          action.cli ?? 'claude',
          action.prompt,
          parent.cwd,
          { parentId, model: action.model },
        );
      }

      this.fileProtocol.writeInbox(parentId,
        `\n\n## Sub-agent "${child.name}" Spawned\n\nCLI: ${child.cli}\nID: ${child.id}\nWorkspace: ${action.workspace ?? 'New tab'}\n\nResults will appear here when the agent completes.\n`,
      );

      this.emit('spawn_processed', { parentId, childId: child.id, childName: child.name });
    } catch (err) {
      const msg = (err as Error).message;
      this.fileProtocol.writeInbox(parentId,
        `\n\n## Spawn Failed\n\nFailed to spawn "${action.name}": ${msg}\n`,
      );
      this.emit('action_error', { action: 'spawn', agentId: parentId, error: msg });
    }
  }

  private async handleDelegate(agentId: string, action: DelegateToAction): Promise<void> {
    const agent = this.agentManager.get(agentId);
    if (!agent) return;

    // Loop prevention: hash role+task, check count
    const taskHash = simpleHash(action.task);
    const delegateKey = `${agentId}:${action.role}:${taskHash}`;
    const count = this.delegateCounts.get(delegateKey) ?? 0;
    if (count >= MAX_DELEGATE_REPEATS) {
      this.fileProtocol.writeInbox(agentId,
        `\n\n## Delegation Rejected\n\nSame task was already delegated to role "${action.role}" ${count} times. Handle it yourself or break into smaller sub-tasks.\n`,
      );
      this.emit('action_error', { action: 'delegate_to', agentId, error: 'delegation loop detected' });
      return;
    }
    this.delegateCounts.set(delegateKey, count + 1);

    // Edge validation: if rig edges define connections, restrict delegation targets
    const config = this.getConfig();
    const connections = resolveConnections(config, agent.name);
    if (connections.rigName && connections.downstream.length > 0) {
      // Agent has defined edges — check if target role matches any downstream agent
      const downstreamAgentNames = connections.downstream;
      const downstreamRoles = downstreamAgentNames
        .map(name => {
          const a = this.agentManager.findByName(name);
          return a?.roleId;
        })
        .filter((r): r is string => !!r);

      if (!downstreamRoles.includes(action.role)) {
        this.fileProtocol.writeInbox(agentId,
          `\n\n## Delegation Rejected\n\nRole "${action.role}" is not a valid downstream target for "${agent.name}".\nAllowed targets: ${downstreamAgentNames.join(', ')}\n`,
        );
        this.emit('action_error', { action: 'delegate_to', agentId, error: `edge validation failed: ${action.role} not in downstream` });
        return;
      }
    }

    // 1. Find idle agent with matching role
    const roleConfig = config.agents.roles.find(r => r.id === action.role);
    let target = this.agentManager.list().find(
      a => a.roleId === action.role && a.status === 'idle',
    );

    try {
      if (!target) {
        // 2. Spawn new agent for the role
        const cli = roleConfig?.cli ?? 'claude';
        const name = `${action.role}-${Date.now().toString(36)}`;
        if (action.workspace) {
          target = await this.agentManager.spawnInWorkspace(action.workspace, name, cli, action.task, undefined,
            { parentId: agentId, roleId: action.role, model: action.model ?? roleConfig?.model });
        } else {
          target = await this.agentManager.spawn(name, cli, action.task, agent.cwd,
            { parentId: agentId, roleId: action.role, model: action.model ?? roleConfig?.model });
        }
      } else {
        // 3. Assign task to existing idle agent
        await this.agentManager.assignTask(target.id, action.task);
      }

      this.fileProtocol.writeInbox(agentId,
        `\n\n## Delegated to ${target.name}\n\nRole: ${action.role}\nAgent ID: ${target.id}\nWorkspace: ${action.workspace ?? 'Auto'}\n`,
      );

      this.emit('delegate_processed', { fromId: agentId, toId: target.id, role: action.role });
    } catch (err) {
      const msg = (err as Error).message;
      this.fileProtocol.writeInbox(agentId,
        `\n\n## Delegation Failed\n\nFailed to delegate to role "${action.role}": ${msg}\n`,
      );
      this.emit('action_error', { action: 'delegate_to', agentId, error: msg });
    }
  }

  private handleAsk(agentId: string, action: AskAction): void {
    const from = this.agentManager.get(agentId);
    const to = this.agentManager.findByName(action.to);

    if (!from) return;

    if (!to) {
      this.fileProtocol.writeInbox(agentId,
        `\n\n## Ask Failed\n\nAgent "${action.to}" not found.\n`,
      );
      return;
    }

    // Warn if target is dead/rate-limited
    if (to.status === 'dead') {
      this.fileProtocol.writeInbox(agentId,
        `\n\n## Ask Warning\n\nAgent "${action.to}" is dead. Your question may not be answered.\n`,
      );
    }

    // Send question to target and auto-resume if idle
    const askMessage = `\n\n## Question from ${from.name}\n\n${action.question}\n\n` +
      `Reply with: {"action":"answer","to":"${from.name}","question":"${action.question}","answer":"your answer"}\n`;
    this.resumeTarget(to.id, askMessage);

    // Set up timeout
    const askKey = makeAskKey(agentId, to.id, action.question);
    const existing = this.pendingAsks.get(askKey);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pendingAsks.delete(askKey);
      const fromAgent = this.agentManager.get(agentId);
      if (fromAgent && fromAgent.status !== 'dead') {
        this.fileProtocol.writeInbox(agentId,
          `\n\n## Ask Timeout\n\nNo answer received from "${action.to}" for: ${action.question}\n`,
        );
      }
    }, ASK_TIMEOUT_MS);

    this.pendingAsks.set(askKey, { fromId: agentId, timer });

    this.emit('ask_processed', { fromId: agentId, toId: to.id, question: action.question });
  }

  private handleAnswer(agentId: string, action: AnswerAction): void {
    const from = this.agentManager.get(agentId);
    const to = this.agentManager.findByName(action.to);

    if (!from || !to) {
      if (from && !to) {
        this.fileProtocol.writeInbox(agentId,
          `\n\n## Answer Failed\n\nAgent "${action.to}" not found.\n`,
        );
      }
      return;
    }

    // Cancel pending ask timeout (key is direction-independent)
    const askKey = makeAskKey(to.id, agentId, action.question);
    const pending = this.pendingAsks.get(askKey);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAsks.delete(askKey);
    }

    const answerMessage = `\n\n## Answer from ${from.name}\n\nQ: ${action.question}\nA: ${action.answer}\n`;
    this.resumeTarget(to.id, answerMessage);

    this.emit('answer_processed', { fromId: agentId, toId: to.id });
  }

  private async handleReport(agentId: string, action: ReportToPmAction): Promise<void> {
    const agent = this.agentManager.get(agentId);
    if (!agent) return;

    // If agent has a parentId (from Stream A hierarchy), send to parent.
    // Otherwise, the report sits in actions.md for the orchestrator to poll.
    const parentId = agent.parentId;
    if (parentId) {
      const parent = this.agentManager.get(parentId);
      if (parent && parent.status !== 'dead') {
        const reportMessage = `\n\n## Report from ${agent.name} [${action.type}]\n\n${action.summary}\n`;
        this.resumeTarget(parent.id, reportMessage);
      }
    }

    // Also send cmux notification for blocked reports
    if (action.type === 'blocked') {
      try {
        await this.cmuxClient.notify(
          `${agent.name}: blocked`,
          action.summary,
        );
      } catch { /* best effort */ }
    }

    this.emit('report_processed', { agentId, type: action.type, summary: action.summary });
  }

  private handleShare(agentId: string, action: ShareAction): void {
    const agent = this.agentManager.get(agentId);
    if (!agent) return;

    // Sanitize key: allow only alphanumeric, hyphens, underscores
    const safeKey = action.key.replace(/[^a-zA-Z0-9\-_]/g, '_');
    const sharedDir = join(this.basePath, 'shared');
    try {
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(join(sharedDir, `${safeKey}.md`), action.content, 'utf-8');
      console.log(`[action-processor] ${agent.name} shared "${safeKey}"`);
      this.emit('share_processed', { agentId, key: safeKey });
    } catch (err) {
      console.error(`[action-processor] Failed to write share "${safeKey}": ${(err as Error).message}`);
    }
  }

  private handleMessage(agentId: string, action: MessageAction): void {
    const from = this.agentManager.get(agentId);
    const to = this.agentManager.findByName(action.to);

    if (!from) return;

    if (!to) {
      this.fileProtocol.writeInbox(agentId,
        `\n\n## Message Failed\n\nAgent "${action.to}" not found.\n`,
      );
      return;
    }

    if (to.status === 'dead') {
      this.fileProtocol.writeInbox(agentId,
        `\n\n## Message Warning\n\nAgent "${action.to}" is dead. Message delivered but may not be read.\n`,
      );
    }

    const message = `\n\n## Message from ${from.name}\n\n${action.content}\n`;
    this.resumeTarget(to.id, message);

    this.emit('message_processed', { fromId: agentId, toId: to.id });
  }

  // ── Workflow review handlers ───────────────────────────────────────────────

  private async handleDoneWithWorkflow(agentId: string, action: DoneAction): Promise<boolean> {
    const agent = this.agentManager.get(agentId);
    if (!agent) return false;

    // Check if this is a reviewer completing a pending review
    const pending = this.pendingReviews.get(agentId);
    if (pending) {
      return this.handleReviewerDone(agentId, action, pending);
    }

    // Auto-forward results to downstream agents (edge-based routing)
    this.forwardToDownstream(agent, action);

    // Check if agent's role has a workflow review step
    if (!agent.roleId) return false;

    const config = this.getConfig();
    const reviewConfig = this.findReviewConfigForRole(config, agent.roleId);
    if (!reviewConfig) return false;

    // Check iteration limit
    const iteration = this.reviewIterations.get(agentId) ?? 0;
    if (iteration >= reviewConfig.max_iterations) {
      this.reviewIterations.delete(agentId);
      return false;
    }

    this.reviewIterations.set(agentId, iteration + 1);

    // Spawn reviewer
    const roleConfig = config.agents.roles.find(r => r.id === reviewConfig.role);
    const cli = roleConfig?.cli ?? 'claude';
    const reviewerName = `${reviewConfig.role}-${Date.now().toString(36)}`;
    const task = `Review the following completed work and provide feedback.\n\nWork summary: ${action.summary}\n\nIf the work is acceptable, include "${reviewConfig.pass_on}" in your done summary. If changes are needed, include "${reviewConfig.retry_on}" in your done summary.`;

    try {
      const reviewer = await this.agentManager.spawn(
        reviewerName, cli, task, agent.cwd,
        { parentId: agentId, roleId: reviewConfig.role, model: roleConfig?.model },
      );

      this.pendingReviews.set(reviewer.id, { developerAgentId: agentId, reviewConfig });

      this.fileProtocol.writeInbox(agentId,
        `\n\n## Review Requested\n\nReviewer "${reviewer.name}" is reviewing your work (iteration ${iteration + 1}/${reviewConfig.max_iterations}).\n`,
      );

      this.emit('review_started', { developerAgentId: agentId, reviewerAgentId: reviewer.id, iteration: iteration + 1 });
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      this.fileProtocol.writeInbox(agentId,
        `\n\n## Review Spawn Failed\n\nFailed to spawn reviewer: ${msg}. Proceeding without review.\n`,
      );
      this.reviewIterations.delete(agentId);
      this.emit('review_bypassed', { developerAgentId: agentId, summary: action.summary, reason: msg });
      return false;
    }
  }

  private async handleReviewerDone(
    reviewerAgentId: string,
    action: DoneAction,
    pending: { developerAgentId: string; reviewConfig: ReviewConfig },
  ): Promise<boolean> {
    this.pendingReviews.delete(reviewerAgentId);

    const { developerAgentId, reviewConfig } = pending;
    const summary = action.summary ?? '';
    const summaryLower = summary.toLowerCase();
    const isPassing = summaryLower.includes(reviewConfig.pass_on.toLowerCase());

    if (isPassing) {
      this.reviewIterations.delete(developerAgentId);
      const developer = this.agentManager.get(developerAgentId);
      if (developer && developer.status !== 'dead') {
        this.resumeTarget(developerAgentId,
          `\n\n## Review Approved\n\nReviewer approved your work: ${summary}\n`,
        );
      }
      this.emit('review_approved', { developerAgentId, reviewerAgentId, summary });
    } else {
      const developer = this.agentManager.get(developerAgentId);
      if (developer && developer.status !== 'dead') {
        this.resumeTarget(developerAgentId,
          `\n\n## Review: Changes Requested\n\n${summary}\n\nPlease address the feedback and write a done action when complete.\n`,
        );
      }
      this.emit('review_changes_requested', { developerAgentId, reviewerAgentId, summary });
    }

    return false; // Let done propagate normally for the reviewer agent
  }

  private findReviewConfigForRole(config: ProjectConfig, roleId: string): ReviewConfig | undefined {
    for (const workflow of Object.values(config.workflows ?? {})) {
      for (const step of workflow.steps) {
        if (step.role === roleId && step.review) {
          return step.review;
        }
      }
    }
    return undefined;
  }

  // ── Edge-based auto-forwarding ────────────────────────────────────────────

  /**
   * Forward done results to downstream agents defined in rig edges.
   * Resumes idle downstream agents automatically.
   */
  private forwardToDownstream(agent: Agent, action: DoneAction): void {
    const config = this.getConfig();
    const connections = resolveConnections(config, agent.name);

    if (connections.downstream.length === 0) return;

    const forwardMessage = `\n\n## Upstream Result from ${agent.name}\n\n${action.summary}\n\nThis work was automatically forwarded to you based on team edges.\n`;

    for (const downstreamName of connections.downstream) {
      const target = this.agentManager.findByName(downstreamName);
      if (!target || target.status === 'dead') continue;

      this.resumeTarget(target.id, forwardMessage);
      this.emit('edge_forwarded', {
        fromId: agent.id,
        fromName: agent.name,
        toId: target.id,
        toName: target.name,
        summary: action.summary,
      });
    }
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Direction-independent ask key: sorted IDs ensure ask and answer produce the same key. */
function makeAskKey(id1: string, id2: string, question: string): string {
  const sorted = [id1, id2].sort();
  return `${sorted[0]}:${sorted[1]}:${simpleHash(question)}`;
}

/** Simple string hash for deduplication keys. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}
