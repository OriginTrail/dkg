import { withScopedPublicSnapshotTrust } from '../public-snapshot-evidence.js';
import { sharedMemoryAdmissionError, sharedMemoryAdmissionFailsClosed } from '../swm-read-admission.js';
import { resolveCallerDraftAccess } from '../working-memory-identity.js';
// SPDX-License-Identifier: Apache-2.0

import {
  applyReadGraphModes,
  type ReadGraphModeChange,
  type ReadGraphModes,
  type ViewSemanticsSettings,
} from '@origintrail-official/dkg-storage';
import type { DKGAgent } from '../dkg-agent.js';
import { DKGAgentBase } from '../dkg-agent-base.js';
import { admitContextGraphReadCaller, ContextGraphReadAuthorityUnavailableError } from '../context-graph-read-authority.js';
import {
  ReadGraphWorkloadOwnerV1,
  readGraphWorkloadOf,
  type ReadGraphCheckReportV1,
  type ReadGraphStatusV1,
} from '../read-graph-runtime.js';

export interface ContextGraphPartitionInventoryOptions {
  callerAgentAddress?: string;
  signal?: AbortSignal;
  priority?: import('@origintrail-official/dkg-storage').StoreWorkPriority;
  source?: string;
  chainEvidenceMode?: import('../public-snapshot-evidence.js').PublicSnapshotMode;
}
export class ContextGraphPartitionQueryMethods extends DKGAgentBase {
  /**
   * The builder of the read-graph partitions that reads are served from, which the
   * catalog runtime starts and stops with the agent's other background workloads.
   */
  createReadGraphWorkloadV1(this: DKGAgent): ReadGraphWorkloadOwnerV1 {
    return new ReadGraphWorkloadOwnerV1(this, { dataDir: this.config.dataDir, logger: this.log });
  }

  /** Check the node's ready read graphs now, full unless asked otherwise: for `dkg store read-graphs check`. */
  async checkReadGraphsV1(this: DKGAgent, options: { mode?: 'sampled' | 'full'; signal?: AbortSignal } = {}): Promise<ReadGraphCheckReportV1> {
    const owner = readGraphWorkloadOf(this);
    return owner ? owner.checkNow(options) : { mode: options.mode ?? 'full', at: Date.now(), results: [] };
  }

  /** The node's read graphs and what the builder and the checks do: for `dkg store read-graphs status`. */
  readGraphStatusV1(this: DKGAgent): ReadGraphStatusV1 | undefined {
    return readGraphWorkloadOf(this)?.readGraphStatus();
  }

  /**
   * Switch the node's read graphs to `next`, the whole settings, while it runs, and with them the view-semantics
   * defaults when given: for the node-admin settings API. Storage's `applyReadGraphModes` says what each switch does;
   * the agent's builder backfills and removes.
   */
  async applyReadGraphModesV1(
    this: DKGAgent,
    next: ReadGraphModes,
    options: { signal?: AbortSignal; viewSemantics?: ViewSemanticsSettings; beforeCommit?: () => void } = {},
  ): Promise<readonly ReadGraphModeChange[]> {
    const owner = readGraphWorkloadOf(this);
    if (owner) return owner.applyReadGraphModes(next, options);
    return applyReadGraphModes(this.store, next, { ...options, ...(this.config.dataDir !== undefined ? { dataDir: this.config.dataDir } : {}) });
  }


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
    if (admitContextGraphReadCaller(authority, options.callerAgentAddress).outcome !== 'admitted') return [];
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
    if (admitContextGraphReadCaller(initial, options.callerAgentAddress).outcome !== 'admitted') return [];
    return this.queryEngine.readContextGraphNamedGraphStats(contextGraphId, { ...options,
      draftAccess: resolveCallerDraftAccess({ defaultAgentAddress: this.defaultAgentAddress, peerId: this.peerId }, options.callerAgentAddress) }, async (admission, read) => {
      options.signal?.throwIfAborted();
      const authority = await authorityFor();
      if (authority.outcome === 'unavailable') throw new ContextGraphReadAuthorityUnavailableError(contextGraphId, authority);
      if (admitContextGraphReadCaller(authority, options.callerAgentAddress).outcome !== 'admitted') return [];
      if (admission === 'shared-memory') {
        const shared = await this.resolveSharedMemoryReadAdmission(contextGraphId, {
          callerAgentAddress: options.callerAgentAddress, readAuthority: authority, signal: options.signal,
        });
        if (shared.outcome === 'unavailable' && !sharedMemoryAdmissionFailsClosed(shared)) throw sharedMemoryAdmissionError(contextGraphId, shared);
        if (shared.outcome !== 'allowed') return [];
      }
      return withScopedPublicSnapshotTrust(this.store, contextGraphId, options.chainEvidenceMode, read, options);
    });
  }

}
