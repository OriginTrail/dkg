import { contextGraphBelongsToAgent } from '@origintrail-official/dkg-core';
import type { DkgClient, ProjectRow } from '../client.js';

export function contextGraphBelongsToCaller(row: ProjectRow, agentDid?: string): boolean {
  return row.isSystem !== true && contextGraphBelongsToAgent({ callerInvolved: row.callerInvolved, curator: row.curator }, agentDid);
}

export function filterContextGraphsForScope(rows: ProjectRow[], scope: 'mine' | 'all', agentDid?: string): ProjectRow[] {
  return scope === 'all' ? rows : rows.filter((row) => contextGraphBelongsToCaller(row, agentDid));
}

/** Resolve legacy curator ownership once per read, using the same authenticated client. */
export async function listContextGraphsForScope(client: DkgClient, scope: 'mine' | 'all'): Promise<ProjectRow[]> {
  const rows = await client.listProjects();
  const needsIdentity = scope === 'mine' && rows.some((row) => row.isSystem !== true
    && typeof row.callerInvolved !== 'boolean' && typeof row.curator === 'string' && row.curator.trim());
  const identity = needsIdentity ? await client.getAgentIdentity() : undefined;
  return filterContextGraphsForScope(rows, scope, identity?.agentDid ?? identity?.agentAddress);
}
