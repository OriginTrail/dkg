// daemon/context-graph-on-chain-id-gate.ts
//
// Who may follow an on-chain Context Graph id (`32`, `#32`) to the row this
// node keeps for it, on the routes that only look it up: unsubscribe and
// catch-up status.
//
// A row keyed by the graph's name hash reveals nothing the chain does not.
// A row keyed by the cleartext id names the graph, and a private graph's
// name must not reach a caller who may not read it. So only the node
// operator, or an agent that the subscribe route would admit to that row,
// follows the id there. Everyone else must be answered as if the node held
// no row. This is the rule name hashes follow on the same routes, and the
// same admission check decides it (context-graph-subscription-admission.ts).

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  admitContextGraphFollow,
  type ContextGraphFollowCaller,
} from './context-graph-subscription-admission.js';

export async function mayFollowOnChainIdToRow(
  agent: DKGAgent,
  row: { readonly contextGraphId: string; readonly nameHash: string },
  caller: ContextGraphFollowCaller,
): Promise<boolean> {
  if (row.contextGraphId === row.nameHash) return true;
  return await admitContextGraphFollow(agent, row.contextGraphId, caller) === 'allowed';
}
