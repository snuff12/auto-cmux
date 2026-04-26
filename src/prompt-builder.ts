import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';
import type { Agent, Task, RoleConfig } from './types.js';
import type { MemoryStore } from './memory-store.js';

export const DEFAULT_BASE_PATH = join(process.cwd(), '.auto-cmux');

// ── Context types for enhanced prompts ──

export interface TeamContext {
  agents: Array<{ name: string; status: string; cli: string; role?: string }>;
}

export interface TaskContext {
  task: Task;
}

export interface MemoryContext {
  roleMemory?: string;
  conventions?: string;
}

export interface HandoffContext {
  fromAgent: string;
  notes: string;
}

export interface HierarchyContext {
  parentName?: string;
  siblings: string[];
  childNames: string[];
  depth: number;
  maxDepth: number;
}

export interface AgentFeedback {
  status: string;
  context: string;
  nextAction?: string;
}

export interface ConnectionsContext {
  upstream: string[];    // Agent names that send work to this agent
  downstream: string[];  // Agent names that receive work from this agent
}

export interface PromptOptions {
  basePath?: string;
  role?: RoleConfig;
  team?: TeamContext;
  taskCtx?: TaskContext;
  memory?: MemoryContext;
  handoff?: HandoffContext;
  hierarchy?: HierarchyContext;
  feedback?: AgentFeedback;
  connections?: ConnectionsContext;
  cultureContent?: string;
}

/**
 * Build the prompt injected into an agent's inbox.md.
 *
 * The prompt wraps the user's task with protocol instructions so the agent
 * knows how to report results back via actions.md.
 */
export function buildPrompt(agent: Agent, task: string, basePath = DEFAULT_BASE_PATH): string {
  return buildEnhancedPrompt(agent, task, { basePath });
}

/**
 * Build an enhanced prompt with optional context sections:
 * role description, team status, task context, memory, communication protocol, handoff.
 */
/**
 * Load CULTURE.md content from .auto-cmux/CULTURE.md or project root CULTURE.md.
 * Returns null if no culture file exists.
 */
export function loadCulture(basePath = DEFAULT_BASE_PATH): string | null {
  // Priority: .auto-cmux/CULTURE.md > project root CULTURE.md
  const candidates = [
    join(basePath, 'CULTURE.md'),
    join(process.cwd(), 'CULTURE.md'),
  ];
  for (const path of candidates) {
    const content = safeReadFile(path);
    if (content) return content;
  }
  return null;
}

export function buildEnhancedPrompt(agent: Agent, task: string, options: PromptOptions = {}): string {
  const basePath = options.basePath ?? DEFAULT_BASE_PATH;
  const actionsPath = join(basePath, 'agents', agent.id, 'actions.md');

  const sections: string[] = [];

  // ── Culture (team-wide collaboration rules) ──
  const cultureContent = options.cultureContent ?? loadCulture(basePath);
  if (cultureContent) {
    sections.push(`## Team Culture\n\n${cultureContent}`);
  }

  // ── Role description ──
  if (options.role) {
    const roleParts: string[] = [];
    roleParts.push(`You are **${options.role.id}** agent using \`${options.role.cli}\`${options.role.model ? ` (model: ${options.role.model})` : ''}.`);

    if (options.role.description) {
      roleParts.push(`\n**Description:** ${options.role.description}`);
    }

    if (options.role.skills && options.role.skills.length > 0) {
      roleParts.push(`\n**Available Skills:** ${options.role.skills.map(s => `\`${s}\``).join(', ')}`);
    }

    // Load role-specific instructions file
    if (options.role.instructions) {
      const instructionsContent = safeReadFile(options.role.instructions);
      if (instructionsContent) {
        roleParts.push(`\n### Role Instructions\n\n${instructionsContent}`);
      }
    }

    sections.push(`## Your Role\n\n${roleParts.join('\n')}`);
  }

  // ── Team status snapshot ──
  if (options.team && options.team.agents.length > 0) {
    const lines = options.team.agents.map(a =>
      `- **${a.name}** [${a.status}] (${a.cli}${a.role ? `, role: ${a.role}` : ''})`,
    );
    sections.push(`## Team Status

${lines.join('\n')}`);
  }

  // ── Task context ──
  if (options.taskCtx) {
    const t = options.taskCtx.task;
    sections.push(`## Assigned Task

- **ID:** ${t.id}
- **Title:** ${t.title}
- **Priority:** ${t.priority}
- **Description:** ${t.description}${t.dependsOn.length > 0 ? `\n- **Depends on:** ${t.dependsOn.join(', ')}` : ''}`);
  }

  // ── Memory injection ──
  if (options.memory) {
    const memParts: string[] = [];
    if (options.memory.roleMemory) {
      memParts.push(`### Role Learnings\n${options.memory.roleMemory}`);
    }
    if (options.memory.conventions) {
      memParts.push(`### Project Conventions\n${options.memory.conventions}`);
    }
    if (memParts.length > 0) {
      sections.push(`## Memory\n\n${memParts.join('\n\n')}`);
    }
  }

  // ── Shared context ──
  const sharedDir = join(basePath, 'shared');
  const sharedFiles = safeListDir(sharedDir);
  if (sharedFiles.length > 0) {
    const lines = sharedFiles.map(f => `- **${f.replace(/\.md$/, '')}**: [available]`);
    sections.push(`## Shared Context\n\n${lines.join('\n')}\nRead these files if relevant to your task.`);
  }

  // ── Handoff context ──
  if (options.handoff) {
    sections.push(`## Handoff from ${options.handoff.fromAgent}

${options.handoff.notes}`);
  }

  // ── Hierarchy context ──
  if (options.hierarchy) {
    const h = options.hierarchy;
    const lines: string[] = [];
    if (h.parentName) {
      lines.push(`- **Parent:** ${h.parentName} (your reports go here automatically)`);
    } else {
      lines.push('- **Parent:** none (you are a root agent)');
    }
    if (h.siblings.length > 0) {
      lines.push(`- **Siblings:** ${h.siblings.join(', ')}`);
    }
    if (h.childNames.length > 0) {
      lines.push(`- **Children:** ${h.childNames.join(', ')}`);
    }
    lines.push(`- **Depth:** ${h.depth}/${h.maxDepth}`);
    if (h.depth < h.maxDepth) {
      lines.push('');
      lines.push('You can spawn sub-agents:');
      lines.push('```json');
      lines.push('{"action":"spawn","name":"sub-name","cli":"claude|codex","prompt":"task description","model":"sonnet"}');
      lines.push('```');
      lines.push('Results from sub-agents will appear in your inbox automatically.');
    }
    sections.push(`## Your Position in the Agent Hierarchy\n\n${lines.join('\n')}`);
  }

  // ── Connections (edge-based routing) ──
  if (options.connections && (options.connections.upstream.length > 0 || options.connections.downstream.length > 0)) {
    const connLines: string[] = [];
    if (options.connections.upstream.length > 0) {
      connLines.push(`- **Receives work from:** ${options.connections.upstream.join(', ')}`);
    }
    if (options.connections.downstream.length > 0) {
      connLines.push(`- **Sends results to:** ${options.connections.downstream.join(', ')}`);
      connLines.push('');
      connLines.push('When you complete your task, your results will be automatically forwarded to your downstream agents.');
    }
    sections.push(`## Your Connections\n\n${connLines.join('\n')}`);
  }

  // ── Agent Feedback (structured context for efficient agent comprehension) ──
  if (options.feedback) {
    const fb = options.feedback;
    const feedbackParts = [
      `[STATUS] ${fb.status}`,
      `[CONTEXT] ${fb.context}`,
    ];
    if (fb.nextAction) {
      feedbackParts.push(`[NEXT_ACTION_SUGGESTION] ${fb.nextAction}`);
    }
    sections.push(`## Situation Awareness\n\n${feedbackParts.join('\n')}`);
  }

  // ── User task ──
  sections.push(task);

  // ── Communication Protocol ──
  sections.push(`---

## Communication Protocol

When you finish your task, you MUST append exactly one JSON line to the file below.
Use the Write or Edit file tool — do NOT use bash echo or shell redirection.

**File:** \`${actionsPath}\`

### On success:
\`\`\`json
{"action":"done","summary":"<one sentence: what you did and how to verify>"}
\`\`\`

### On error:
\`\`\`json
{"action":"error","message":"<what went wrong>"}
\`\`\`

### To send a message to another agent:
\`\`\`json
{"action":"message","to":"<agent-name>","content":"<your message>"}
\`\`\`

### To report progress:
\`\`\`json
{"action":"status","text":"<what you are doing now>"}
\`\`\`

### To report to the orchestrator:
\`\`\`json
{"action":"report_to_pm","type":"progress|done|blocked","summary":"<status update>"}
\`\`\`

### To ask another agent a question:
\`\`\`json
{"action":"ask","to":"<agent-name>","question":"<your question>"}
\`\`\`

### To answer a question from another agent:
\`\`\`json
{"action":"answer","to":"<agent-name>","question":"<original question>","answer":"<your answer>"}
\`\`\`

### To save a role learning:
\`\`\`json
{"action":"remember_role","insight":"<what you learned that future agents in this role should know>"}
\`\`\`

### To delegate work to another role:
\`\`\`json
{"action":"delegate_to","role":"<target role id>","task":"<task description>","model":"sonnet"}
\`\`\`

### To share notes or results with other agents:
\`\`\`json
{"action":"share","key":"key-name","content":"content to share"}
\`\`\`

Rules:
- Each action is ONE JSON object on ONE line. No multi-line JSON.
- Append to the file — do not overwrite existing content.
- You must write a "done" or "error" action when finished.
`);

  return sections.join('\n\n');
}

/**
 * Build a MemoryContext from a MemoryStore for use with buildEnhancedPrompt.
 * Returns undefined if no memory entries exist (avoids injecting empty sections).
 */
export function buildMemoryContext(store: MemoryStore, roleId?: string): MemoryContext | undefined {
  const conventions = store.getConventionsDeduped();
  const roleEntries = roleId ? store.getRoleMemoryDeduped(roleId) : [];

  if (conventions.length === 0 && roleEntries.length === 0) return undefined;

  return {
    conventions: conventions.length > 0
      ? conventions.map(c => `- **${c.key}**: ${c.insight}`).join('\n')
      : undefined,
    roleMemory: roleEntries.length > 0
      ? roleEntries.map(m => `- **${m.key}**: ${m.insight}`).join('\n')
      : undefined,
  };
}

function safeReadFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function safeListDir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
}
