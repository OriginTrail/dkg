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
// no row. This is the rule #2752 applies to name hashes on unsubscribe.
// Whichever of the two changes merges second folds this helper into that
// PR's readContextGraphSubscriptionAdmission.

import type { DKGAgent } from '@origintrail-official/dkg-agent';

export interface OnChainIdCaller {
  /** The request carries node-operator authority. */
  readonly isNodeAdmin: boolean;
  /** The request's agent, if any; the node's default agent stands in otherwise. */
  readonly agentAddress: string | undefined;
}

export async function mayFollowOnChainIdToRow(
  agent: DKGAgent,
  row: { readonly contextGraphId: string; readonly nameHash: string },
  caller: OnChainIdCaller,
): Promise<boolean> {
  if (row.contextGraphId === row.nameHash || caller.isNodeAdmin) return true;
  try {
    const authority = await agent.resolveContextGraphSubscriptionBootstrapAuthority(row.contextGraphId, {
      callerAgentAddress: caller.agentAddress ?? agent.getDefaultAgentAddress(),
      allowSubscriptionFallback: false,
    });
    return authority.outcome === 'allowed';
  } catch {
    return false;
  }
}
