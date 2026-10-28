import { resolveWorkingMemoryIdentityAliases } from '../working-memory-identity.js';
// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '../dkg-agent.js';
import { DKGAgentBase } from '../dkg-agent-base.js';
import { ContextGraphReadAuthorityUnavailableError } from '../context-graph-read-authority.js';

export class ContextGraphPartitionQueryMethods extends DKGAgentBase {
  /** Enumerate the same public count dataset used by scoped query execution. */
  async listContextGraphQueryPartitions(this: DKGAgent, contextGraphId: string,
    options: { callerAgentAddress?: string; signal?: AbortSignal; priority?: import('@origintrail-official/dkg-storage').StoreWorkPriority; source?: string } = {},
  ): Promise<string[]> {
    // Inventory is part of a scoped read, so consume the same finalized
    // evidence as query execution. Cached subscription intent cannot admit it.
    const authority = await this.resolveContextGraphReadAuthority(contextGraphId, {
      ...options, authorityReadMode: 'finalized-index', allowSubscriptionFallback: false,
    });
    if (authority.outcome === 'unavailable') throw new ContextGraphReadAuthorityUnavailableError(contextGraphId, authority);
    if (authority.outcome !== 'allowed') return [];
    const owner = options.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId;
    const aliases = resolveWorkingMemoryIdentityAliases({ defaultAgentAddress: this.defaultAgentAddress, peerId: this.peerId }, owner, address => address.toLowerCase()).aliases ?? [];
    return this.queryEngine.listContextGraphQueryPartitions(contextGraphId, { ...options,
      draftAccess: owner ? { kind: 'owners', owners: [owner, ...aliases] } : { kind: 'none' } });
  }

}
