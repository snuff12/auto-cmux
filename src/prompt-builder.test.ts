import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildPrompt, buildEnhancedPrompt, loadCulture } from './prompt-builder.js';
import type { Agent } from './types.js';

const baseAgent: Agent = {
  id: 'test-id-123',
  name: 'backend',
  cli: 'claude',
  workspaceId: 'ws-1',
  surfaceId: 'sf-1',
  status: 'working',
  cwd: '/tmp/test',
  childIds: [],
  depth: 0,
};

describe('buildPrompt', () => {
  it('includes task and completion protocol', () => {
    const result = buildPrompt(baseAgent, 'Fix the login bug', '/tmp/base');
    expect(result).toContain('Fix the login bug');
    expect(result).toContain('Communication Protocol');
    expect(result).toContain('/tmp/base/agents/test-id-123/actions.md');
    expect(result).toContain('"action":"done"');
    expect(result).toContain('"action":"error"');
  });
});

describe('buildEnhancedPrompt', () => {
  it('includes role description', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      role: { id: 'backend', cli: 'claude', model: 'claude-sonnet-4-6', color: '#6366f1' },
    });
    expect(result).toContain('## Your Role');
    expect(result).toContain('**backend** agent');
    expect(result).toContain('model: claude-sonnet-4-6');
  });

  it('includes team status', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      team: {
        agents: [
          { name: 'backend', status: 'working', cli: 'claude', role: 'backend' },
          { name: 'frontend', status: 'idle', cli: 'claude' },
        ],
      },
    });
    expect(result).toContain('## Team Status');
    expect(result).toContain('**backend** [working]');
    expect(result).toContain('**frontend** [idle]');
  });

  it('includes task context', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      taskCtx: {
        task: {
          id: 'TASK-001',
          title: 'Fix auth',
          description: 'The auth middleware is broken',
          status: 'in-progress',
          priority: 'high',
          dependsOn: ['TASK-000'],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    expect(result).toContain('## Assigned Task');
    expect(result).toContain('TASK-001');
    expect(result).toContain('Fix auth');
    expect(result).toContain('Depends on:** TASK-000');
  });

  it('includes memory injection', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      memory: {
        roleMemory: 'Always use ESLint before commit.',
        conventions: 'Use kebab-case for file names.',
      },
    });
    expect(result).toContain('## Memory');
    expect(result).toContain('### Role Learnings');
    expect(result).toContain('Always use ESLint');
    expect(result).toContain('### Project Conventions');
    expect(result).toContain('kebab-case');
  });

  it('includes handoff context', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      handoff: {
        fromAgent: 'frontend',
        notes: 'The API endpoint changed to /v2',
      },
    });
    expect(result).toContain('## Handoff from frontend');
    expect(result).toContain('API endpoint changed');
  });

  it('includes new action types in protocol', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', { basePath: '/tmp/base' });
    expect(result).toContain('"action":"report_to_pm"');
    expect(result).toContain('"action":"ask"');
    expect(result).toContain('"action":"answer"');
    expect(result).toContain('"action":"remember_role"');
    expect(result).toContain('"action":"delegate_to"');
  });

  it('omits sections when options not provided', () => {
    const result = buildEnhancedPrompt(baseAgent, 'simple task', { basePath: '/tmp/base' });
    expect(result).not.toContain('## Your Role');
    expect(result).not.toContain('## Team Status');
    expect(result).not.toContain('## Assigned Task');
    expect(result).not.toContain('## Memory');
    expect(result).not.toContain('## Handoff');
    expect(result).toContain('simple task');
    expect(result).toContain('Communication Protocol');
  });

  it('includes hierarchy context with parent', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      hierarchy: {
        parentName: 'orchestrator',
        siblings: ['frontend'],
        childNames: ['researcher'],
        depth: 1,
        maxDepth: 3,
      },
    });
    expect(result).toContain('## Your Position in the Agent Hierarchy');
    expect(result).toContain('**Parent:** orchestrator');
    expect(result).toContain('**Siblings:** frontend');
    expect(result).toContain('**Children:** researcher');
    expect(result).toContain('**Depth:** 1/3');
    expect(result).toContain('"action":"spawn"');
  });

  it('shows root agent hierarchy without spawn hint at max depth', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      hierarchy: {
        parentName: undefined,
        siblings: [],
        childNames: [],
        depth: 3,
        maxDepth: 3,
      },
    });
    expect(result).toContain('you are a root agent');
    expect(result).not.toContain('"action":"spawn"');
  });

  it('includes culture content when provided via options', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      cultureContent: 'Always be concise. Review critically.',
    });
    expect(result).toContain('## Team Culture');
    expect(result).toContain('Always be concise');
    expect(result).toContain('Review critically');
  });

  it('omits culture section when no culture content', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/nonexistent-base',
      cultureContent: undefined,
    });
    expect(result).not.toContain('## Team Culture');
  });

  it('includes feedback section before task', () => {
    const result = buildEnhancedPrompt(baseAgent, 'my actual task', {
      basePath: '/tmp/base',
      feedback: {
        status: 'Agent "backend" (claude). Team: 3 agents.',
        context: 'Role: backend. API development.',
        nextAction: 'Execute the task and report done.',
      },
    });
    expect(result).toContain('## Situation Awareness');
    expect(result).toContain('[STATUS] Agent "backend"');
    expect(result).toContain('[CONTEXT] Role: backend');
    expect(result).toContain('[NEXT_ACTION_SUGGESTION] Execute the task');

    // Feedback should appear BEFORE the task
    const feedbackIdx = result.indexOf('## Situation Awareness');
    const taskIdx = result.indexOf('my actual task');
    expect(feedbackIdx).toBeLessThan(taskIdx);
  });

  it('omits NEXT_ACTION_SUGGESTION when not provided', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', {
      basePath: '/tmp/base',
      feedback: {
        status: 'status text',
        context: 'context text',
      },
    });
    expect(result).toContain('[STATUS]');
    expect(result).toContain('[CONTEXT]');
    expect(result).not.toContain('[NEXT_ACTION_SUGGESTION]');
  });

  it('omits feedback section when not provided', () => {
    const result = buildEnhancedPrompt(baseAgent, 'task', { basePath: '/tmp/base' });
    expect(result).not.toContain('## Situation Awareness');
    expect(result).not.toContain('[STATUS]');
  });
});

describe('loadCulture', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'culture-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads from basePath CULTURE.md', () => {
    writeFileSync(join(tmpDir, 'CULTURE.md'), 'Be concise and direct.', 'utf8');
    const result = loadCulture(tmpDir);
    expect(result).toBe('Be concise and direct.');
  });

  it('returns null when no culture file exists', () => {
    const result = loadCulture(tmpDir);
    expect(result).toBeNull();
  });

  it('ignores empty culture files', () => {
    writeFileSync(join(tmpDir, 'CULTURE.md'), '', 'utf8');
    const result = loadCulture(tmpDir);
    expect(result).toBeNull();
  });
});
