export type AgentCli = 'claude' | 'codex';
export type AgentStatus = 'idle' | 'working' | 'rate-limited' | 'dead';

export interface Agent {
  id: string;
  name: string;
  cli: AgentCli;
  sessionId?: string;
  workspaceId: string;
  surfaceId: string;
  status: AgentStatus;
  taskSentAt?: number;
  lastActionAt?: number;
  cwd: string;
  lastPrompt?: string;
  parentId?: string;        // ID of the agent that spawned this one
  childIds: string[];       // IDs of agents spawned by this one
  depth: number;            // tree depth (root=0)
  roleId?: string;          // role ID (references roles in config)
  model?: string;            // model override (e.g. 'sonnet', 'gpt-5.5')
}

export interface AgentTreeNode {
  agent: Agent;
  children: AgentTreeNode[];
}

export interface AgentConfig {
  command: string;
  printFlag: string;
  resumeFlag?: string;
  sessionFlag?: string;
  skipPermissions: string;
  supportsResume: boolean;
  supportsStreamJson: boolean;
  streamJsonFlags?: string;
  inputMode?: 'stdin' | 'prompt-flag' | 'positional';
  promptFlag?: string;
  modelFlag?: string;
}

export interface Action {
  action: string;
  [key: string]: unknown;
}

export interface DoneAction extends Action {
  action: 'done';
  summary: string;
}

export interface ErrorAction extends Action {
  action: 'error';
  message: string;
}

export interface MessageAction extends Action {
  action: 'message';
  to: string;
  content: string;
}

export interface SpawnAction extends Action {
  action: 'spawn';
  name: string;
  cli: AgentCli;
  prompt: string;
  workspace?: string; // Optional workspace name
  model?: string;
}

export interface StatusAction extends Action {
  action: 'status';
  text: string;
}

export interface ReportToPmAction extends Action {
  action: 'report_to_pm';
  type: 'progress' | 'done' | 'blocked';
  summary: string;
}

export interface AskAction extends Action {
  action: 'ask';
  to: string;
  question: string;
}

export interface AnswerAction extends Action {
  action: 'answer';
  to: string;
  question: string;
  answer: string;
}

export interface RememberRoleAction extends Action {
  action: 'remember_role';
  insight: string;
}

export interface DelegateToAction extends Action {
  action: 'delegate_to';
  role: string;
  task: string;
  workspace?: string; // Optional workspace name
  model?: string;
}

export interface ShareAction extends Action {
  action: 'share';
  key: string;      // e.g. "research-results", "architecture-decisions"
  content: string;
}

// ── Action Envelope ──

export interface ActionEnvelope {
  ok: boolean;
  action: string;
  agentId: string;
  timestamp: number;
  data?: Record<string, unknown>;
  error?: string;
}

// ── Telemetry ──

export interface AgentTelemetry {
  agentId: string;
  totalTokens: number;
  totalCostCents: number;
  turnCount: number;
  toolCallCount: number;
  lastToolCalls: string[];  // rolling window, max 100
  contextPercent?: number;
}

export interface ManagedWorkspace {
  id: string;
  name: string;
  workspaceId: string;   // cmux workspace UUID
  agentIds: string[];     // agents in this workspace
  cwd: string;
}

export interface ParseError {
  line: string;
  error: string;
}

export interface DeltaResult {
  actions: Action[];
  errors: ParseError[];
}

// ── Reactions System ──

export type ReactionEvent = 'stall' | 'hitl' | 'rate-limited' | 'ci-failed' | 'low-context' | 'agent-crashed';
export type ReactionAction = 'retry' | 'diagnose' | 'alert' | 'resume' | 'compact' | 'escalate' | 'kill';

export interface ReactionRule {
  event: ReactionEvent;
  action: ReactionAction;
  auto: boolean;           // true=auto execute, false=alert only
  retries: number;         // max retry count
  cooldownMs: number;      // retry interval
  escalateAfter: number;   // escalate after N failures
}

export interface ReactionAlert {
  id: string;
  agentId: string;
  event: ReactionEvent;
  details: string;
  createdAt: number;
  resolved: boolean;
  resolution?: string;
}

// ── Workflow Configuration ──

export interface ReviewConfig {
  role: string;
  max_iterations: number;
  retry_on: string;
  pass_on: string;
}

export interface WorkflowStep {
  role: string;
  parallel: boolean;
  review?: ReviewConfig;
}

export interface WorkflowConfig {
  steps: WorkflowStep[];
}

// ── Project Configuration ──

export interface RoleConfig {
  id: string;
  cli: AgentCli;
  model?: string;
  color?: string;
  description?: string;
  instructions?: string;
  skills?: string[];
  workspace?: string;
}

export interface AssignmentConfig {
  mode: 'manual' | 'auto' | 'orchestrator';
  stallTimeoutSec: number;
}

export interface ReactionConfigEntry {
  event: string;
  action?: string;
  auto?: boolean;
  retries?: number;
  cooldownMs?: number;
  escalateAfter?: number;
}

export interface GitConfig {
  worktreeEnabled: boolean;
  branchPrefix: string;
}

export interface CostsConfig {
  dailyLimitCents: number;
  warnAt: number;
}

export interface ProjectConfig {
  version: string;
  project: {
    name: string;
    root: string;
    clis: AgentCli[];
  };
  agents: {
    roles: RoleConfig[];
    assignment: AssignmentConfig;
  };
  reactions: ReactionConfigEntry[];
  git: GitConfig;
  costs: CostsConfig;
  workflows?: Record<string, WorkflowConfig>;
  rigs?: Record<string, RigSpec>;
}

// ── Rig (Declarative Team Composition) ──

export interface RigAgentSpec {
  name?: string;           // Agent name (defaults to role id)
  role: string;            // Role ID from config
  model?: string;          // Model override
  cli?: AgentCli;          // CLI override (defaults to role config)
  workspace?: string;      // Workspace override
}

export interface RigEdge {
  from: string | string[];  // Source role(s)
  to: string | string[];    // Target role(s)
}

export interface RigSpec {
  agents: RigAgentSpec[];
  edges?: RigEdge[];
}

// ── Memory ──

export interface MemoryEntry {
  type: 'role' | 'convention';
  key: string;
  insight: string;
  confidence: number;
  timestamp: number;
}

// ── Task System ──

export type TaskStatus = 'backlog' | 'ready' | 'blocked' | 'in-progress' | 'review' | 'rejected' | 'done';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export interface Task {
  id: string;              // TASK-001
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId?: string;     // agent ID
  dependsOn: string[];     // task IDs
  createdAt: number;
  updatedAt: number;
  result?: string;         // summary on completion
}
