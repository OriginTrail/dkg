// SPDX-License-Identifier: Apache-2.0
import { createOperationContext } from '@origintrail-official/dkg-core';
import { CONTEXT_GRAPH_AUTHORITY_RPC_SITES, withRpcUsageSite } from '@origintrail-official/dkg-chain';
import { QueryHandler, type QueryAccessConfig } from '@origintrail-official/dkg-query';
import type { DKGAgent } from './dkg-agent.js';
import { assertPublicSnapshotQueryTrust } from './public-snapshot-evidence.js';

/** Keep authorization, serving readiness and local evidence policy on every remote lookup. */
export function createRemoteQueryHandler(agent: DKGAgent, config: QueryAccessConfig): QueryHandler {
  return new QueryHandler(agent.queryEngine, config, {
    // This protocol has no evidence acceptance/label fields. Refuse marked
    // data until a caller can explicitly accept the weaker chain trust model.
    assertReadEvidence: id => assertPublicSnapshotQueryTrust(agent.store, id),
    // Explicit query ACLs still override this public-chain fallback; failed
    // authority reads retain the existing deny-by-default behavior.
    isContextGraphPublic: id => withRpcUsageSite(CONTEXT_GRAPH_AUTHORITY_RPC_SITES.remoteQuery,
      () => agent.isContextGraphPublicOnChain(id, createOperationContext('query'))),
    servingWithheld: id => agent.contextGraphServingWithheld(id),
  });
}
