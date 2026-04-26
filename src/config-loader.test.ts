import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadProjectConfig,
  validateConfig,
  validateProjectConfigReferences,
  resetProjectConfig,
} from './config-loader.js';

describe('ConfigLoader', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'config-loader-'));
    resetProjectConfig();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const config = loadProjectConfig(root);
    expect(config.version).toBe('0.1');
    expect(config.project.name).toBe('unnamed');
    expect(config.agents.roles).toEqual([]);
    expect(config.agents.assignment.mode).toBe('manual');
    expect(config.agents.assignment.stallTimeoutSec).toBe(120);
    expect(config.git.worktreeEnabled).toBe(true);
    expect(config.git.branchPrefix).toBe('agent/');
    expect(config.costs.dailyLimitCents).toBe(2500);
    expect(config.costs.warnAt).toBe(0.8);
  });

  it('loads a full YAML config', () => {
    const yml = `
version: "0.2"
project:
  name: "my-project"
  root: "/src"
  clis: [claude]
agents:
  roles:
    - id: backend
      cli: claude
      model: claude-sonnet-4-6
      color: "#6366f1"
    - id: qa
      cli: claude
      model: claude-haiku-4-5
  assignment:
    mode: auto
    stallTimeoutSec: 60
reactions:
  - event: stall
    retries: 5
  - event: hitl
    auto: false
git:
  worktreeEnabled: false
  branchPrefix: "wt/"
costs:
  dailyLimitCents: 1000
  warnAt: 0.5
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);

    expect(config.version).toBe('0.2');
    expect(config.project.name).toBe('my-project');
    expect(config.project.root).toBe('/src');
    expect(config.project.clis).toEqual(['claude']);
    expect(config.agents.roles).toHaveLength(2);
    expect(config.agents.roles[0].id).toBe('backend');
    expect(config.agents.roles[0].color).toBe('#6366f1');
    expect(config.agents.roles[1].cli).toBe('claude');
    expect(config.agents.assignment.mode).toBe('auto');
    expect(config.agents.assignment.stallTimeoutSec).toBe(60);
    expect(config.reactions).toHaveLength(2);
    expect(config.reactions[0].event).toBe('stall');
    expect(config.reactions[0].retries).toBe(5);
    expect(config.git.worktreeEnabled).toBe(false);
    expect(config.git.branchPrefix).toBe('wt/');
    expect(config.costs.dailyLimitCents).toBe(1000);
    expect(config.costs.warnAt).toBe(0.5);
  });

  it('fills defaults for partial config', () => {
    const yml = `
project:
  name: "partial"
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);

    expect(config.project.name).toBe('partial');
    expect(config.project.root).toBe('.');
    expect(config.project.clis).toEqual([]);
    expect(config.agents.assignment.mode).toBe('manual');
    expect(config.git.worktreeEnabled).toBe(true);
    expect(config.costs.dailyLimitCents).toBe(2500);
  });

  it('handles empty YAML file', () => {
    writeFileSync(join(root, 'auto-cmux.yml'), '', 'utf8');
    const config = loadProjectConfig(root);
    expect(config.version).toBe('0.1');
  });

  it('validates correct config', () => {
    const result = validateConfig({
      version: '0.1',
      project: { name: 'test', root: '.' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project.name).toBe('test');
    }
  });

  it('validates invalid config with error message', () => {
    const result = validateConfig({
      agents: {
        assignment: { mode: 'invalid-mode' },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('mode');
    }
  });

  it('throws when loading schema-invalid config files', () => {
    const yml = `
agents:
  assignment:
    mode: invalid-mode
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    expect(() => loadProjectConfig(root)).toThrow(/validation errors/);
  });

  it('rejects negative stallTimeoutSec', () => {
    const result = validateConfig({
      agents: { assignment: { stallTimeoutSec: -1 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects warnAt > 1', () => {
    const result = validateConfig({
      costs: { warnAt: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it('cli defaults to claude in roles', () => {
    const yml = `
agents:
  roles:
    - id: dev
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);
    expect(config.agents.roles[0].cli).toBe('claude');
  });

  it('reports cross-reference validation issues', () => {
    const yml = `
project:
  name: "bad"
  clis: [claude]
agents:
  roles:
    - id: dev
      cli: codex
      instructions: .auto-cmux/roles/dev.md
    - id: dev
      cli: claude
workflows:
  dev-cycle:
    steps:
      - role: developer
        review:
          role: reviewer
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);
    const issues = validateProjectConfigReferences(config, root);
    expect(issues.map(i => i.path)).toContain('agents.roles[0].cli');
    expect(issues.map(i => i.path)).toContain('agents.roles[0].instructions');
    expect(issues.map(i => i.path)).toContain('agents.roles[1].id');
    expect(issues.map(i => i.path)).toContain('workflows.dev-cycle.steps[0].role');
    expect(issues.map(i => i.path)).toContain('workflows.dev-cycle.steps[0].review.role');
  });

  it('reports rig reference validation issues', () => {
    const yml = `
project:
  clis: [claude]
agents:
  roles:
    - id: dev
      cli: claude
rigs:
  team:
    agents:
      - role: missing
        cli: codex
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);
    const issues = validateProjectConfigReferences(config, root);
    expect(issues.map(i => i.path)).toContain('rigs.team.agents[0].role');
    expect(issues.map(i => i.path)).toContain('rigs.team.agents[0].cli');
  });

  it('reports duplicate agent names within a rig', () => {
    const yml = `
agents:
  roles:
    - id: dev
      cli: claude
rigs:
  team:
    agents:
      - role: dev
      - role: dev
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);
    const issues = validateProjectConfigReferences(config, root);
    const dupIssue = issues.find(i => i.message.includes('Duplicate agent name'));
    expect(dupIssue).toBeDefined();
    expect(dupIssue!.level).toBe('error');
  });

  it('allows same role with different names in a rig', () => {
    const yml = `
agents:
  roles:
    - id: dev
      cli: claude
rigs:
  team:
    agents:
      - role: dev
        name: fe-dev
      - role: dev
        name: be-dev
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);
    const issues = validateProjectConfigReferences(config, root);
    const dupIssue = issues.find(i => i.message.includes('Duplicate agent name'));
    expect(dupIssue).toBeUndefined();
  });

  it('loads rig config with edges', () => {
    const yml = `
agents:
  roles:
    - id: planner
      cli: claude
    - id: dev
      cli: claude
rigs:
  my-team:
    agents:
      - role: planner
      - role: dev
        name: worker
    edges:
      - from: planner
        to: worker
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);
    expect(config.rigs).toBeDefined();
    expect(config.rigs!['my-team']).toBeDefined();
    expect(config.rigs!['my-team'].agents).toHaveLength(2);
    expect(config.rigs!['my-team'].edges).toHaveLength(1);
    expect(config.rigs!['my-team'].edges![0].from).toBe('planner');
    expect(config.rigs!['my-team'].edges![0].to).toBe('worker');
  });

  it('accepts valid cross-references', () => {
    mkdirSync(join(root, '.auto-cmux', 'roles'), { recursive: true });
    writeFileSync(join(root, '.auto-cmux', 'roles', 'dev.md'), 'dev role', 'utf8');
    writeFileSync(join(root, '.auto-cmux', 'roles', 'reviewer.md'), 'reviewer role', 'utf8');
    const yml = `
project:
  name: "good"
  clis: [claude]
agents:
  roles:
    - id: dev
      cli: claude
      instructions: .auto-cmux/roles/dev.md
    - id: reviewer
      cli: claude
      instructions: .auto-cmux/roles/reviewer.md
workflows:
  dev-cycle:
    steps:
      - role: dev
        review:
          role: reviewer
`;
    writeFileSync(join(root, 'auto-cmux.yml'), yml, 'utf8');
    const config = loadProjectConfig(root);
    expect(validateProjectConfigReferences(config, root)).toEqual([]);
  });
});
