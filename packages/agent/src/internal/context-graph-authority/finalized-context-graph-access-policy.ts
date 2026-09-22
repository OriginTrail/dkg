// SPDX-License-Identifier: Apache-2.0

import {
  assertContextGraphAuthorityIndexId,
  type ContextGraphAuthorityIndexRevisionReader,
  type ContextGraphAuthorityProjectionServedEvidence,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';

import { runBoundedOperation } from '../../bounded-operation.js';
import { CHAIN_POLICY_READ_TIMEOUT_MS } from '../../dkg-agent-constants.js';
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

/** Policy evidence a scoped read bound from the finalized authority index. */
export type FinalizedOnChainAccessPolicyState =
  | Extract<LiveOnChainAccessPolicyState, { kind: 'available' }>
  | RegisteredContextGraphAuthorityUnavailable;

export interface FinalizedOnChainAccessPolicyDependencies {
  /** The adapter's finalized authority index; a legacy adapter has none. */
  readonly indexReader: ContextGraphAuthorityIndexRevisionReader | undefined;
  /** The shared RFC-64 authority circuit; this read takes its foreground lane. */
  readonly authorityReads: Pick<Rfc64AuthorityReadCoordinatorV1, 'runForeground'>;
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
 * Scoped-read policy evidence from the complete finalized authority index.
 *
 * The read runs on the shared RFC-64 authority circuit's foreground lane: it
 * observes an open circuit instead of walking an exhausted pool, a real
 * provider read here counts as recovery evidence for every other consumer,
 * and it never queues behind a cold whole-contract scan on the bulk lane.
 * `undefined` sends the caller to the bounded current-state read, which
 * fails closed on its own. That happens when the adapter has no finalized
 * capability; when the lane faulted, timed out, or is cooling down; when the
 * index holds no snapshot for a slot whose registration is already proven
 * (the projection's anchor has not reached the registration block — the
 * registration lane never treats finalized absence as evidence either); and
 * when a PRIVATE roster would come from a projection the reader served as
 * `stale-cache`, meaning a refresh failed and the projection is at least one
 * index tick old. The reader owns the age bound: it never serves a
 * projection older than its stale window, `min(max(3T, 15s), 5m)` for
 * `chain.indexTickMs` T (18s at the default 6s tick), so a roster removal
 * takes effect within finality depth plus one tick while RPC is healthy and
 * within that window at worst. A numeric bound here would only fight the
 * configured tick. Finalized EVIDENCE — an inactive, malformed, or
 * name-mismatched snapshot — fails closed and never falls back. The public
 * policy bit is immutable on chain, so a public snapshot is served at any
 * provenance.
 */
export async function resolveFinalizedOnChainAccessPolicyState(
  dependencies: FinalizedOnChainAccessPolicyDependencies,
  onChainId: bigint,
  options: { signal?: AbortSignal } = {},
): Promise<FinalizedOnChainAccessPolicyState | undefined> {
  const { indexReader } = dependencies;
  const readSnapshots = indexReader?.readContextGraphAuthorityIndexSnapshots;
  if (indexReader === undefined || readSnapshots === undefined) return undefined;

  let read: Readonly<{
    snapshot: ContextGraphAuthoritySnapshot | undefined;
    served: ContextGraphAuthorityProjectionServedEvidence | undefined;
  }>;
  try {
    const authorityIndexId = onChainId.toString(10);
    assertContextGraphAuthorityIndexId(
      authorityIndexId,
      'scoped read finalized authority index id',
    );
    read = await runBoundedOperation(
      (signal) => dependencies.authorityReads.runForeground(
        signal,
        async (readSignal, evidence) => {
          // The circuit observes the served report first (pool liveness). The
          // provenance also travels back with the snapshot: a private roster
          // decision must stay off a projection the reader could not refresh.
          let served: ContextGraphAuthorityProjectionServedEvidence | undefined;
          const snapshots = await readSnapshots.call(
            indexReader,
            [authorityIndexId],
            evidence.chainReadOptions(readSignal, (report) => { served = report; }),
          );
          return { snapshot: snapshots.get(authorityIndexId), served };
        },
      ),
      {
        label: `readFinalizedContextGraphAuthority(${onChainId})`,
        timeoutMs: CHAIN_POLICY_READ_TIMEOUT_MS,
        signal: options.signal,
      },
    );
  } catch {
    return undefined;
  }
  if (read.snapshot === undefined) return undefined;
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
  if (read.served === undefined || read.served.source === 'stale-cache') return undefined;
  return {
    kind: 'available',
    accessPolicy: 1,
    participantAgents: snapshot.participantAgents,
  };
}
