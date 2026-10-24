// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphAuthorityIndexRevisionReader,
  ContextGraphAuthorityProjectionServedEvidence,
  ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';

import { runBoundedOperation } from '../../bounded-operation.js';
import type { FinalizedContextGraphAuthoritySnapshotReadV1 } from '../../dkg-agent-cg-resolve.js';
import type { RegisteredContextGraphAuthorityUnavailable } from
  '../../registered-context-graph-authority.js';
import type { Rfc64AuthorityReadCoordinatorV1 } from
  '../../rfc64/authority-rpc-circuit-breaker-v1.js';
import { parseRfc64AuthoritySnapshotV1 } from
  '../../rfc64/release-native-catalog-authority-v1.js';
import type { LiveOnChainAccessPolicyState } from './context-graph-access-policy.js';
import {
  finalizedContextGraphSnapshotMismatchV1,
  type FinalizedContextGraphSnapshotMismatchV1,
} from './finalized-context-graph-binding.js';

/** Policy evidence a finalized read mode bound from the finalized authority index. */
export type FinalizedOnChainAccessPolicyState =
  | Extract<LiveOnChainAccessPolicyState, { kind: 'available' }>
  | RegisteredContextGraphAuthorityUnavailable;

export interface FinalizedOnChainAccessPolicyDependencies {
  /** The adapter's finalized authority index; a legacy adapter has none. */
  readonly indexReader: ContextGraphAuthorityIndexRevisionReader | undefined;
  /** Atomic snapshot from this request's name resolution; no cached grant. */
  readonly registrationSnapshot?: ContextGraphAuthoritySnapshot;
  /** The shared RFC-64 authority circuit for legacy scoped index reads. */
  readonly authorityReads: Pick<Rfc64AuthorityReadCoordinatorV1, 'runForeground'>;
  /**
   * The agent's one finalized snapshot read: a detached cold resolution that
   * keeps running past a caller's deadline, so the retry is answered from the
   * retained projection, and that reports how the reader served the projection.
   */
  readSnapshot(
    onChainId: bigint,
    options: { signal?: AbortSignal; label: string },
  ): Promise<FinalizedContextGraphAuthoritySnapshotReadV1>;
  /** The configured request-scoped authority read deadline (`chain.authorityReadTimeoutMs`). */
  readonly requestTimeoutMs: number;
  /**
   * The finalized name commitment the snapshot must carry, or `undefined` when
   * the caller requested the numeric slot itself and there is no name to bind.
   */
  expectedNameHash(): string | undefined;
}

const SNAPSHOT_MISMATCH_DETAIL = Object.freeze({
  inactive: 'finalized authority snapshot is inactive',
  // The snapshot parser already rejects a snapshot for another slot.
  'context-graph-id': 'finalized authority snapshot belongs to another Context Graph slot',
  'name-hash':
    'finalized authority snapshot name commitment does not match the registered Context Graph',
} as const satisfies Record<FinalizedContextGraphSnapshotMismatchV1, string>);

/**
 * A named scoped query may reuse the atomic snapshot its registration lookup
 * just returned. It still passes every id/name/liveness/policy check below.
 * Without private-roster freshness provenance, private reads fall back to the
 * current-state read. Other scoped queries use the retained-only capability. That
 * capability proves the same scope, lineage and freshness without RPC. A miss
 * leaves the caller on its existing bounded current-state authority read;
 * refreshing a whole-contract index first can spend the entire query deadline
 * before either the point read or the local store gets a chance to run.
 *
 * Host/sync reads and older adapters retain the detached index resolution and
 * its foreground circuit lane. No grant is cached here. Inactive, malformed or
 * name-mismatched evidence always fails closed; a missing or stale private
 * roster still requires the existing current-state read.
 */
export async function resolveFinalizedOnChainAccessPolicyState(
  dependencies: FinalizedOnChainAccessPolicyDependencies,
  onChainId: bigint,
  options: {
    readMode: 'finalized-index' | 'finalized-index-or-live';
    signal?: AbortSignal;
    requireLiveRosterForPrivate?: boolean;
  },
): Promise<FinalizedOnChainAccessPolicyState | undefined> {
  // Checked before the lane, so a host without the capability never marks an
  // RPC attempt on the shared circuit.
  if (dependencies.indexReader?.readContextGraphAuthorityIndexSnapshots === undefined) {
    return undefined;
  }
  const label = `readFinalizedContextGraphAuthority(${onChainId})`;
  let read: FinalizedContextGraphAuthoritySnapshotReadV1;
  try {
    const retained = dependencies.indexReader.peekFinalizedContextGraphAuthoritySnapshotsByNameHashes;
    if (options.readMode === 'finalized-index' && dependencies.registrationSnapshot !== undefined) {
      options.signal?.throwIfAborted();
      read = { kind: 'snapshot', snapshot: dependencies.registrationSnapshot };
    } else if (options.readMode === 'finalized-index' && retained !== undefined) {
      const nameHash = dependencies.expectedNameHash();
      options.signal?.throwIfAborted();
      if (nameHash === undefined) return undefined;
      let served: ContextGraphAuthorityProjectionServedEvidence | undefined;
      const snapshots = await runBoundedOperation(
        (signal) => retained.call(dependencies.indexReader, [nameHash], {
          signal,
          onContextGraphAuthorityProjectionServed: (report) => { served = report; },
        }),
        { label, timeoutMs: dependencies.requestTimeoutMs, signal: options.signal },
      );
      options.signal?.throwIfAborted();
      const snapshot = snapshots?.get(nameHash);
      if (snapshot === undefined) return undefined;
      read = { kind: 'snapshot', snapshot, ...(served === undefined ? {} : { served }) };
    } else {
      read = options.readMode === 'finalized-index'
        ? await runBoundedOperation(
            (signal) => dependencies.authorityReads.runForeground(
              signal,
              async (readSignal, evidence) => {
                // The detached resolution is shared and never sees a caller's
                // evidence hooks, so the circuit is told here how the consumed
                // answer was served (pool liveness). The provenance also stays on
                // the read: a private roster decision must stay off a projection
                // the reader could not refresh.
                const chainReadOptions = evidence.chainReadOptions(readSignal);
                const snapshotRead = await dependencies.readSnapshot(
                  onChainId,
                  { signal: readSignal, label },
                );
                if (snapshotRead.kind !== 'unsupported' && snapshotRead.served !== undefined) {
                  chainReadOptions.onContextGraphAuthorityProjectionServed?.(snapshotRead.served);
                }
                return snapshotRead;
              },
              { admitWhileOpen: true },
            ),
            {
              label,
              timeoutMs: dependencies.requestTimeoutMs,
              signal: options.signal,
            },
          )
        : await dependencies.readSnapshot(onChainId, { signal: options.signal, label });
    }
  } catch {
    return undefined;
  }
  if (read.kind !== 'snapshot') return undefined;
  let snapshot: ReturnType<typeof parseRfc64AuthoritySnapshotV1>;
  try {
    snapshot = parseRfc64AuthoritySnapshotV1(read.snapshot, onChainId);
  } catch (err) {
    return {
      kind: 'unavailable',
      onChainId,
      reason: 'chain-access-policy-unavailable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const mismatch = finalizedContextGraphSnapshotMismatchV1(snapshot, {
    onChainId,
    nameHash: dependencies.expectedNameHash(),
  });
  if (mismatch !== undefined) {
    return {
      kind: 'unavailable',
      onChainId,
      reason: 'chain-access-policy-unknown',
      detail: SNAPSHOT_MISMATCH_DETAIL[mismatch],
    };
  }
  if (snapshot.accessPolicy === 0) return { kind: 'available', accessPolicy: 0 };
  // The immutable policy bit proved PRIVATE; a caller that needs the CURRENT
  // roster takes it from the live read.
  if (options.requireLiveRosterForPrivate === true) return undefined;
  if (read.served === undefined || read.served.source === 'stale-cache') return undefined;
  return {
    kind: 'available',
    accessPolicy: 1,
    participantAgents: snapshot.participantAgents,
  };
}
