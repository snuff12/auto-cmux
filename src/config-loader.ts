import { readFileSync, existsSync, watchFile, unwatchFile } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import yaml from 'js-yaml';
import type { ProjectConfig } from './types.js';

// ── Zod Schema ──

const RoleSchema = z.object({
  id: z.string(),
  cli: z.enum(['claude', 'codex']).default('claude'),
  model: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  skills: z.array(z.string()).default([]),
  workspace: z.string().optional(),
});

const AssignmentSchema = z.object({
  mode: z.enum(['manual', 'auto', 'orchestrator']).default('manual'),
  stallTimeoutSec: z.number().positive().default(120),
});

const ReactionEntrySchema = z.object({
  event: z.string(),
  action: z.string().optional(),
  auto: z.boolean().optional(),
  retries: z.number().int().nonnegative().optional(),
  cooldownMs: z.number().nonnegative().optional(),
  escalateAfter: z.number().int().nonnegative().optional(),
});

const GitSchema = z.object({
  worktreeEnabled: z.boolean().default(true),
  branchPrefix: z.string().default('agent/'),
});

const CostsSchema = z.object({
  dailyLimitCents: z.number().nonnegative().default(2500),
  warnAt: z.number().min(0).max(1).default(0.8),
});

const ReviewSchema = z.object({
  role: z.string(),
  max_iterations: z.number().int().positive().default(3),
  retry_on: z.string().default('changes_requested'),
  pass_on: z.string().default('LGTM'),
});

const WorkflowStepSchema = z.object({
  role: z.string(),
  parallel: z.boolean().default(false),
  review: ReviewSchema.optional(),
});

const WorkflowSchema = z.object({
  steps: z.array(WorkflowStepSchema),
});

const RigAgentSpecSchema = z.object({
  name: z.string().optional(),
  role: z.string(),
  model: z.string().optional(),
  cli: z.enum(['claude', 'codex']).optional(),
  workspace: z.string().optional(),
});

const RigEdgeSchema = z.object({
  from: z.union([z.string(), z.array(z.string())]),
  to: z.union([z.string(), z.array(z.string())]),
});

const RigSpecSchema = z.object({
  agents: z.array(RigAgentSpecSchema),
  edges: z.array(RigEdgeSchema).optional(),
});

const ProjectConfigSchema = z.object({
  version: z.string().default('0.1'),
  project: z.object({
    name: z.string().default('unnamed'),
    root: z.string().default('.'),
    clis: z.array(z.enum(['claude', 'codex'])).default([]),
  }).default({}),
  agents: z.object({
    roles: z.array(RoleSchema).default([]),
    assignment: AssignmentSchema.default({}),
  }).default({}),
  reactions: z.array(ReactionEntrySchema).default([]),
  git: GitSchema.default({}),
  costs: CostsSchema.default({}),
  workflows: z.record(WorkflowSchema).default({}),
  rigs: z.record(RigSpecSchema).default({}),
});

// ── Default Config ──

const DEFAULT_CONFIG: ProjectConfig = ProjectConfigSchema.parse({});

// ── Loader ──

let currentConfig: ProjectConfig = DEFAULT_CONFIG;

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
}

function parseProjectConfig(raw: string): ProjectConfig {
  const parsed = yaml.load(raw);

  // Empty YAML file
  if (parsed == null || typeof parsed !== 'object') {
    console.error(`[auto-cmux] auto-cmux.yml is empty, using defaults.`);
    return DEFAULT_CONFIG;
  }

  const result = ProjectConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`auto-cmux.yml has validation errors:\n${formatZodIssues(result.error)}`);
  }

  return result.data;
}

/**
 * Load auto-cmux.yml from the given directory (or cwd).
 * Returns defaults only when the file is missing or empty. Invalid YAML/schema
 * errors are thrown so doctor/server startup can report the real problem.
 */
export function loadProjectConfig(dir?: string): ProjectConfig {
  const searchDir = dir ?? process.cwd();
  const configPath = join(searchDir, 'auto-cmux.yml');

  if (!existsSync(configPath)) {
    console.error(`[auto-cmux] No auto-cmux.yml found in ${searchDir}, using defaults. Create one to configure roles, budgets, and workflows.`);
    currentConfig = DEFAULT_CONFIG;
    return currentConfig;
  }

  const raw = readFileSync(configPath, 'utf8');
  currentConfig = parseProjectConfig(raw);
  return currentConfig;
}

/**
 * Get the current project config (loaded or default).
 * If hot-reload is active, this always returns the latest version.
 */
export function getProjectConfig(): ProjectConfig {
  return currentConfig;
}

// ── Hot-reload ──

let watchedPath: string | null = null;

/**
 * Start watching auto-cmux.yml for changes and auto-reload.
 * Call after loadProjectConfig() to enable hot-reload.
 */
export function startConfigWatch(dir?: string): void {
  const searchDir = dir ?? process.cwd();
  const configPath = join(searchDir, 'auto-cmux.yml');

  // Stop any existing watch
  stopConfigWatch();

  if (!existsSync(configPath)) return;

  watchedPath = configPath;
  watchFile(configPath, { interval: 2000 }, () => {
    try {
      if (!existsSync(configPath)) {
        currentConfig = DEFAULT_CONFIG;
        console.error('[auto-cmux] auto-cmux.yml removed, using defaults');
        return;
      }
      const nextConfig = parseProjectConfig(readFileSync(configPath, 'utf8'));
      const refIssues = validateProjectConfigReferences(nextConfig, searchDir);
      const refErrors = refIssues.filter(issue => issue.level === 'error');
      if (refErrors.length > 0) {
        console.error(`[auto-cmux] auto-cmux.yml has reference errors, keeping previous config: ${refErrors.map(i => `${i.path}: ${i.message}`).join('; ')}`);
        return;
      }
      for (const issue of refIssues.filter(i => i.level === 'warning')) {
        console.error(`[auto-cmux] config WARN ${issue.path}: ${issue.message}${issue.hint ? ` Hint: ${issue.hint}` : ''}`);
      }
      currentConfig = nextConfig;
      console.error('[auto-cmux] auto-cmux.yml reloaded');
    } catch (err) {
      console.error(`[auto-cmux] Failed to reload auto-cmux.yml: ${(err as Error).message}`);
    }
  });
}

/**
 * Stop watching auto-cmux.yml.
 */
export function stopConfigWatch(): void {
  if (watchedPath) {
    unwatchFile(watchedPath);
    watchedPath = null;
  }
}

/**
 * Validate a raw object against the config schema.
 * Returns { success: true, data } or { success: false, error }.
 */
export function validateConfig(raw: unknown): { success: true; data: ProjectConfig } | { success: false; error: string } {
  const result = ProjectConfigSchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

export interface ConfigIssue {
  level: 'error' | 'warning';
  path: string;
  message: string;
  hint?: string;
}

const SAFE_WORKSPACE_NAME = /^[a-zA-Z0-9_.-]+$/;
const SAFE_BRANCH_PREFIX = /^[a-zA-Z0-9_./-]+$/;

/**
 * Validate cross-references that the Zod schema cannot check by itself.
 * This is intentionally non-throwing so CLI doctor can report all issues at once.
 */
export function validateProjectConfigReferences(
  config: ProjectConfig,
  projectRoot: string = process.cwd(),
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const roleIds = new Set<string>();
  const duplicateRoleIds = new Set<string>();
  const configuredClis = new Set(config.project.clis);

  const resolvedRoot = resolve(projectRoot, config.project.root);
  if (!existsSync(resolvedRoot)) {
    issues.push({
      level: 'error',
      path: 'project.root',
      message: `Project root does not exist: ${resolvedRoot}`,
      hint: 'Update project.root or run auto-cmux from the project root.',
    });
  }

  for (const [index, role] of config.agents.roles.entries()) {
    const rolePath = `agents.roles[${index}]`;
    if (roleIds.has(role.id)) {
      duplicateRoleIds.add(role.id);
      issues.push({
        level: 'error',
        path: `${rolePath}.id`,
        message: `Duplicate role id "${role.id}".`,
        hint: 'Role ids must be unique because agents reference them by id.',
      });
    }
    roleIds.add(role.id);

    if (configuredClis.size > 0 && !configuredClis.has(role.cli)) {
      issues.push({
        level: 'error',
        path: `${rolePath}.cli`,
        message: `Role "${role.id}" uses CLI "${role.cli}" but project.clis does not include it.`,
        hint: `Add "${role.cli}" to project.clis or change the role CLI.`,
      });
    }

    if (role.instructions) {
      const instructionsPath = resolve(projectRoot, role.instructions);
      if (!existsSync(instructionsPath)) {
        issues.push({
          level: 'warning',
          path: `${rolePath}.instructions`,
          message: `Role "${role.id}" instructions file is missing: ${role.instructions}`,
          hint: 'Create the file or remove the instructions entry.',
        });
      }
    }

    if (role.workspace && !SAFE_WORKSPACE_NAME.test(role.workspace)) {
      issues.push({
        level: 'warning',
        path: `${rolePath}.workspace`,
        message: `Role "${role.id}" workspace "${role.workspace}" contains characters that may break worktree names.`,
        hint: 'Prefer letters, numbers, dot, underscore, and dash.',
      });
    }
  }

  for (const [workflowName, workflow] of Object.entries(config.workflows ?? {})) {
    for (const [index, step] of workflow.steps.entries()) {
      const stepPath = `workflows.${workflowName}.steps[${index}]`;
      if (!roleIds.has(step.role) && !duplicateRoleIds.has(step.role)) {
        issues.push({
          level: 'error',
          path: `${stepPath}.role`,
          message: `Workflow step references unknown role "${step.role}".`,
          hint: 'Add the role under agents.roles or update the workflow step.',
        });
      }
      if (step.review && !roleIds.has(step.review.role)) {
        issues.push({
          level: 'error',
          path: `${stepPath}.review.role`,
          message: `Workflow review references unknown role "${step.review.role}".`,
          hint: 'Add the reviewer role under agents.roles or update review.role.',
        });
      }
    }
  }

  for (const [rigName, rig] of Object.entries(config.rigs ?? {})) {
    // Check for duplicate agent names within the rig
    const rigNames = new Set<string>();
    for (const agent of rig.agents) {
      const resolvedName = agent.name ?? agent.role;
      if (rigNames.has(resolvedName)) {
        issues.push({
          level: 'error',
          path: `rigs.${rigName}`,
          message: `Duplicate agent name "${resolvedName}" in rig. Use the 'name' field to distinguish agents with the same role.`,
        });
      }
      rigNames.add(resolvedName);
    }

    for (const [index, agent] of rig.agents.entries()) {
      const agentPath = `rigs.${rigName}.agents[${index}]`;
      if (!roleIds.has(agent.role)) {
        issues.push({
          level: 'error',
          path: `${agentPath}.role`,
          message: `Rig agent references unknown role "${agent.role}".`,
          hint: 'Add the role under agents.roles or update the rig agent.',
        });
      }
      if (agent.cli && configuredClis.size > 0 && !configuredClis.has(agent.cli)) {
        issues.push({
          level: 'error',
          path: `${agentPath}.cli`,
          message: `Rig agent uses CLI "${agent.cli}" but project.clis does not include it.`,
          hint: `Add "${agent.cli}" to project.clis or change the rig CLI.`,
        });
      }
      if (agent.workspace && !SAFE_WORKSPACE_NAME.test(agent.workspace)) {
        issues.push({
          level: 'warning',
          path: `${agentPath}.workspace`,
          message: `Rig agent workspace "${agent.workspace}" contains characters that may break worktree names.`,
          hint: 'Prefer letters, numbers, dot, underscore, and dash.',
        });
      }
    }
  }

  if (config.git.branchPrefix && !SAFE_BRANCH_PREFIX.test(config.git.branchPrefix)) {
    issues.push({
      level: 'error',
      path: 'git.branchPrefix',
      message: `Branch prefix contains unsafe characters: ${config.git.branchPrefix}`,
      hint: 'Use a simple prefix like "agent/" or "auto-cmux/".',
    });
  }

  return issues;
}

/**
 * Reset to default config (useful for testing).
 */
export function resetProjectConfig(): void {
  currentConfig = DEFAULT_CONFIG;
}

export { ProjectConfigSchema };
