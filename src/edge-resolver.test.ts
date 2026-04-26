import { describe, it, expect } from 'vitest';
import { resolveConnections, isDelegationAllowed } from './edge-resolver.js';
import type { ProjectConfig } from './types.js';

function makeConfig(rigs: ProjectConfig['rigs'] = {}): ProjectConfig {
  return {
    version: '0.1',
    project: { name: 'test', root: '.' },
    agents: {
      roles: [
        { id: 'planner', cli: 'claude' },
        { id: 'developer', cli: 'claude' },
        { id: 'reviewer', cli: 'claude' },
      ],
      assignment: { mode: 'manual', stallTimeoutSec: 120 },
    },
    reactions: [],
    git: { worktreeEnabled: false, branchPrefix: 'agent/' },
    costs: { dailyLimitCents: 2500, warnAt: 0.8 },
    rigs,
  };
}

describe('resolveConnections', () => {
  it('resolves upstream and downstream for a simple chain', () => {
    const config = makeConfig({
      team: {
        agents: [
          { role: 'planner' },
          { role: 'developer' },
          { role: 'reviewer' },
        ],
        edges: [
          { from: 'planner', to: 'developer' },
          { from: 'developer', to: 'reviewer' },
        ],
      },
    });

    const planner = resolveConnections(config, 'planner');
    expect(planner.upstream).toEqual([]);
    expect(planner.downstream).toEqual(['developer']);
    expect(planner.rigName).toBe('team');

    const dev = resolveConnections(config, 'developer');
    expect(dev.upstream).toEqual(['planner']);
    expect(dev.downstream).toEqual(['reviewer']);

    const reviewer = resolveConnections(config, 'reviewer');
    expect(reviewer.upstream).toEqual(['developer']);
    expect(reviewer.downstream).toEqual([]);
  });

  it('handles array endpoints (fan-out / fan-in)', () => {
    const config = makeConfig({
      team: {
        agents: [
          { role: 'planner' },
          { role: 'developer', name: 'fe-dev' },
          { role: 'developer', name: 'be-dev' },
          { role: 'reviewer' },
        ],
        edges: [
          { from: 'planner', to: ['fe-dev', 'be-dev'] },
          { from: ['fe-dev', 'be-dev'], to: 'reviewer' },
        ],
      },
    });

    const planner = resolveConnections(config, 'planner');
    expect(planner.downstream).toEqual(['fe-dev', 'be-dev']);

    const feDev = resolveConnections(config, 'fe-dev');
    expect(feDev.upstream).toEqual(['planner']);
    expect(feDev.downstream).toEqual(['reviewer']);

    const reviewer = resolveConnections(config, 'reviewer');
    expect(reviewer.upstream).toEqual(expect.arrayContaining(['fe-dev', 'be-dev']));
    expect(reviewer.upstream).toHaveLength(2);
  });

  it('returns empty for agent not in any rig', () => {
    const config = makeConfig({
      team: {
        agents: [{ role: 'planner' }],
        edges: [],
      },
    });

    const result = resolveConnections(config, 'unknown-agent');
    expect(result.upstream).toEqual([]);
    expect(result.downstream).toEqual([]);
    expect(result.rigName).toBeUndefined();
  });

  it('returns empty connections for agent in rig with no edges', () => {
    const config = makeConfig({
      team: {
        agents: [{ role: 'planner' }, { role: 'developer' }],
      },
    });

    const result = resolveConnections(config, 'planner');
    expect(result.upstream).toEqual([]);
    expect(result.downstream).toEqual([]);
    expect(result.rigName).toBe('team');
  });
});

describe('isDelegationAllowed', () => {
  it('allows delegation when no rig is defined', () => {
    const config = makeConfig();
    expect(isDelegationAllowed(config, 'planner', 'developer')).toBe(true);
  });

  it('allows delegation when rig has no edges', () => {
    const config = makeConfig({
      team: {
        agents: [{ role: 'planner' }, { role: 'developer' }],
      },
    });
    expect(isDelegationAllowed(config, 'planner', 'developer')).toBe(true);
  });

  it('allows delegation along defined edges', () => {
    const config = makeConfig({
      team: {
        agents: [{ role: 'planner' }, { role: 'developer' }, { role: 'reviewer' }],
        edges: [
          { from: 'planner', to: 'developer' },
          { from: 'developer', to: 'reviewer' },
        ],
      },
    });
    expect(isDelegationAllowed(config, 'planner', 'developer')).toBe(true);
    expect(isDelegationAllowed(config, 'developer', 'reviewer')).toBe(true);
  });

  it('rejects delegation against edge direction', () => {
    const config = makeConfig({
      team: {
        agents: [{ role: 'planner' }, { role: 'developer' }, { role: 'reviewer' }],
        edges: [
          { from: 'planner', to: 'developer' },
          { from: 'developer', to: 'reviewer' },
        ],
      },
    });
    expect(isDelegationAllowed(config, 'developer', 'planner')).toBe(false);
    expect(isDelegationAllowed(config, 'reviewer', 'developer')).toBe(false);
  });
});
