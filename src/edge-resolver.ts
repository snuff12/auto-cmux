import type { ProjectConfig, RigEdge } from './types.js';

/**
 * Resolved edge connections for a specific agent.
 */
export interface ResolvedConnections {
  upstream: string[];    // Agent names that send work to this agent
  downstream: string[];  // Agent names that receive work from this agent
  rigName?: string;      // Which rig this agent belongs to
}

/**
 * Normalize an edge endpoint (string or string[]) to a flat array.
 */
function normalizeEndpoint(endpoint: string | string[]): string[] {
  return Array.isArray(endpoint) ? endpoint : [endpoint];
}

/**
 * Resolve upstream and downstream connections for a given agent name
 * by scanning all rig definitions in the config.
 */
export function resolveConnections(config: ProjectConfig, agentName: string): ResolvedConnections {
  const upstream = new Set<string>();
  const downstream = new Set<string>();
  let rigName: string | undefined;

  for (const [name, rig] of Object.entries(config.rigs ?? {})) {
    // Check if this agent belongs to this rig
    const resolvedNames = rig.agents.map(a => a.name ?? a.role);
    if (!resolvedNames.includes(agentName)) continue;

    rigName = name;

    for (const edge of rig.edges ?? []) {
      const fromNames = normalizeEndpoint(edge.from);
      const toNames = normalizeEndpoint(edge.to);

      // agentName is a source → toNames are downstream
      if (fromNames.includes(agentName)) {
        for (const t of toNames) downstream.add(t);
      }

      // agentName is a target → fromNames are upstream
      if (toNames.includes(agentName)) {
        for (const f of fromNames) upstream.add(f);
      }
    }
  }

  return {
    upstream: [...upstream],
    downstream: [...downstream],
    rigName,
  };
}

/**
 * Check if a delegation from sourceAgent to targetName is allowed by edges.
 * Returns true if:
 * - No edges are defined (permissive mode)
 * - An edge exists from source to target
 */
export function isDelegationAllowed(config: ProjectConfig, sourceAgentName: string, targetAgentName: string): boolean {
  const connections = resolveConnections(config, sourceAgentName);
  // If agent has no rig or no edges defined, allow all delegations (permissive)
  if (!connections.rigName) return true;
  if (connections.downstream.length === 0 && connections.upstream.length === 0) return true;
  return connections.downstream.includes(targetAgentName);
}
