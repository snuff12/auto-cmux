import { describe, it, expect } from 'vitest';
import { topoSortRigAgents, buildEdgeContext } from './mcp-server.js';
import type { RigAgentSpec, RigEdge } from './types.js';

// ── topoSortRigAgents ──────────────────────────────────────────────────────

describe('topoSortRigAgents', () => {
  const makeAgent = (name: string, role?: string): RigAgentSpec => ({
    role: role ?? name,
    name,
  });

  it('returns agents unchanged when no edges', () => {
    const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')];
    const result = topoSortRigAgents(agents, []);
    expect(result).toEqual(agents);
  });

  it('returns agents unchanged when edges is empty array', () => {
    const agents = [makeAgent('x')];
    const result = topoSortRigAgents(agents, []);
    expect(result).toBe(agents);
  });

  it('sorts a simple linear chain: a → b → c', () => {
    const agents = [makeAgent('c'), makeAgent('a'), makeAgent('b')];
    const edges: RigEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    const result = topoSortRigAgents(agents, edges);
    const names = result.map(a => a.name);
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('b'));
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('c'));
  });

  it('sorts a diamond: a → b, a → c, b → d, c → d', () => {
    const agents = [makeAgent('d'), makeAgent('b'), makeAgent('c'), makeAgent('a')];
    const edges: RigEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ];
    const result = topoSortRigAgents(agents, edges);
    const names = result.map(a => a.name);
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('b'));
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('c'));
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('d'));
    expect(names.indexOf('c')).toBeLessThan(names.indexOf('d'));
  });

  it('handles array-form edges: from: [a, b] to: [c]', () => {
    const agents = [makeAgent('c'), makeAgent('a'), makeAgent('b')];
    const edges: RigEdge[] = [
      { from: ['a', 'b'], to: 'c' },
    ];
    const result = topoSortRigAgents(agents, edges);
    const names = result.map(a => a.name);
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('c'));
    expect(names.indexOf('b')).toBeLessThan(names.indexOf('c'));
  });

  it('throws on cycle: a → b → c → a', () => {
    const agents = [makeAgent('a'), makeAgent('b'), makeAgent('c')];
    const edges: RigEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
    ];
    expect(() => topoSortRigAgents(agents, edges)).toThrow(/[Cc]ycle/);
  });

  it('throws on self-loop', () => {
    const agents = [makeAgent('a'), makeAgent('b')];
    const edges: RigEdge[] = [
      { from: 'a', to: 'a' },
    ];
    expect(() => topoSortRigAgents(agents, edges)).toThrow(/[Cc]ycle/);
  });

  it('uses role as fallback name when name is undefined', () => {
    const agents: RigAgentSpec[] = [
      { role: 'backend' },
      { role: 'frontend' },
    ];
    const edges: RigEdge[] = [
      { from: 'backend', to: 'frontend' },
    ];
    const result = topoSortRigAgents(agents, edges);
    expect(result[0].role).toBe('backend');
    expect(result[1].role).toBe('frontend');
  });

  it('ignores edges referencing unknown agent names', () => {
    const agents = [makeAgent('a'), makeAgent('b')];
    const edges: RigEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'unknown', to: 'b' },
    ];
    // Should not throw; unknown refs are silently ignored
    const result = topoSortRigAgents(agents, edges);
    const names = result.map(a => a.name);
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('b'));
  });
});

// ── buildEdgeContext ────────────────────────────────────────────────────────

describe('buildEdgeContext', () => {
  it('returns null when edges is empty', () => {
    expect(buildEdgeContext('a', [])).toBeNull();
  });

  it('returns null when agent has no edges', () => {
    const edges: RigEdge[] = [{ from: 'x', to: 'y' }];
    expect(buildEdgeContext('z', edges)).toBeNull();
  });

  it('shows upstream agents', () => {
    const edges: RigEdge[] = [{ from: 'planner', to: 'worker' }];
    const ctx = buildEdgeContext('worker', edges);
    expect(ctx).toContain('Upstream');
    expect(ctx).toContain('planner');
  });

  it('shows downstream agents', () => {
    const edges: RigEdge[] = [{ from: 'planner', to: 'worker' }];
    const ctx = buildEdgeContext('planner', edges);
    expect(ctx).toContain('Downstream');
    expect(ctx).toContain('worker');
  });

  it('shows both upstream and downstream', () => {
    const edges: RigEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    const ctx = buildEdgeContext('b', edges);
    expect(ctx).toContain('Upstream');
    expect(ctx).toContain('a');
    expect(ctx).toContain('Downstream');
    expect(ctx).toContain('c');
  });

  it('handles array-form edges', () => {
    const edges: RigEdge[] = [{ from: ['a', 'b'], to: ['c', 'd'] }];
    const ctx = buildEdgeContext('c', edges);
    expect(ctx).toContain('a');
    expect(ctx).toContain('b');
  });
});
