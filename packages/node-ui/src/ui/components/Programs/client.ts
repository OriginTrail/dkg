import { GraphComputer } from '@origintrail-official/dkg-graph-computer';
import { fetchStatus, fetchContextGraphs, readProfileQueryCatalog } from '../../api.js';
import { get } from '../../http.js';

export interface ProgramAgent { address: string; name: string }
export const fetchProgramAgents = () => get<{ agents: ProgramAgent[]; defaultAddress: string }>('/api/programs/agents');
export type ToolKind = 'sparqlRead' | 'query' | 'assetCreation';
export interface ProgramTool { kind: ToolKind; toolIri: string; label: string; description: string }
export interface ProgramGraph { id: string; name: string }
export const fetchProgramTools = () => get<{ enabled: boolean; tools: ProgramTool[] }>('/api/programs/tools');
export async function fetchProgramGraphs(): Promise<ProgramGraph[]> {
  const { contextGraphs } = await fetchContextGraphs();
  return contextGraphs.map(graph => ({ id: graph.id, name: graph.name || graph.id }));
}
export const fetchProgramQueries = readProfileQueryCatalog;

/** Use the existing authenticated node session; custody and graph rights are checked on the node. */
export async function programClient(address: string): Promise<GraphComputer> {
  const token = (window as any).__DKG_TOKEN__;
  if (typeof token !== 'string' || !token) throw new Error('An authenticated node session is required.');
  const status = await fetchStatus();
  if ((window as any).__DKG_TOKEN__ !== token) throw new Error('Node session changed. Reopen the Program editor.');
  if (typeof status.peerId !== 'string') throw new Error('Node identity is unavailable.');
  return new GraphComputer({ nodeUrl: window.location.origin, peerId: status.peerId,
    localAgent: { address, authToken: token }, retries: 0, timeoutMs: 150_000 });
}
