import { assertPublicSnapshotQueryTrust } from '../public-snapshot-evidence.js';
import { sharedMemoryAdmissionError, sharedMemoryAdmissionFailsClosed } from '../swm-read-admission.js';
import { resolveCallerDraftAccess } from '../working-memory-identity.js';
// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '../dkg-agent.js';
import { DKGAgentBase } from '../dkg-agent-base.js';
import { ContextGraphReadAuthorityUnavailableError } from '../context-graph-read-authority.js';

export interface ContextGraphPartitionInventoryOptions {
  callerAgentAddress?: string;
  signal?: AbortSignal;
  priority?: import('@origintrail-official/dkg-storage').StoreWorkPriority;
  source?: string;
  chainEvidenceMode?: import('../public-snapshot-evidence.js').PublicSnapshotMode;
}
export class ContextGraphPartitionQueryMethods extends DKGAgentBase {
  /** Enumerate the authorized partitions with their required admission. */
  async listContextGraphQueryPartitionReads(this: DKGAgent, contextGraphId: string,
    options: ContextGraphPartitionInventoryOptions = {},
  ): Promise<import('@origintrail-official/dkg-query').ContextGraphPartitionRead[]> {
    // Inventory is part of a scoped read, so consume the same finalized
    // evidence as query execution. Cached subscription intent cannot admit it.
    const authority = await this.resolveContextGraphReadAuthority(contextGraphId, {
      ...options, authorityReadMode: 'finalized-index', allowSubscriptionFallback: false,
    });
    if (authority.outcome === 'unavailable') throw new ContextGraphReadAuthorityUnavailableError(contextGraphId, authority);
    if (authority.outcome !== 'allowed') return [];
    return this.queryEngine.listContextGraphQueryPartitionReads(contextGraphId, { ...options,
      draftAccess: resolveCallerDraftAccess({ defaultAgentAddress: this.defaultAgentAddress, peerId: this.peerId }, options.callerAgentAddress) });
  }

  /** Caller-authorized statistics; the query layer owns inventory and aggregates. */
  async readContextGraphNamedGraphStats(this: DKGAgent, contextGraphId: string,
    options: ContextGraphPartitionInventoryOptions = {},
  ): Promise<import('@origintrail-official/dkg-query').ContextGraphNamedGraphStats[]> {
    const authorityFor = () => this.resolveContextGraphReadAuthority(contextGraphId, {
      ...options, authorityReadMode: 'finalized-index', allowSubscriptionFallback: false,
    });
    const initial = await authorityFor();
    if (initial.outcome === 'unavailable') throw new ContextGraphReadAuthorityUnavailableError(contextGraphId, initial);
    if (initial.outcome !== 'allowed') return [];
    return this.queryEngine.readContextGraphNamedGraphStats(contextGraphId, { ...options,
      draftAccess: resolveCallerDraftAccess({ defaultAgentAddress: this.defaultAgentAddress, peerId: this.peerId }, options.callerAgentAddress) }, async (admission, read) => {
      options.signal?.throwIfAborted();
      const authority = await authorityFor();
      if (authority.outcome === 'unavailable') throw new ContextGraphReadAuthorityUnavailableError(contextGraphId, authority);
      if (authority.outcome !== 'allowed') return [];
      if (admission === 'shared-memory') {
        const shared = await this.resolveSharedMemoryReadAdmission(contextGraphId, {
          callerAgentAddress: options.callerAgentAddress, readAuthority: authority, signal: options.signal,
        });
        if (shared.outcome === 'unavailable' && !sharedMemoryAdmissionFailsClosed(shared)) throw sharedMemoryAdmissionError(contextGraphId, shared);
        if (shared.outcome !== 'allowed') return [];
      }
      await assertPublicSnapshotQueryTrust(this.store, contextGraphId, options.chainEvidenceMode, options);
      const result = await read();
      await assertPublicSnapshotQueryTrust(this.store, contextGraphId, options.chainEvidenceMode, options);
      options.signal?.throwIfAborted();
      return result;
    });
  }

}
