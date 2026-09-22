import { GraphComputer } from '@origintrail-official/dkg-graph-computer';
import { fetchStatus } from '../../api.js';
import { get } from '../../http.js';

export interface ProgramAgent { address: string; name: string }
export const fetchProgramAgents = () => get<{ agents: ProgramAgent[]; defaultAddress: string }>('/api/programs/agents');

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
