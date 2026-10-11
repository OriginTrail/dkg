// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphAuthorityIndexRevisionReader } from '@origintrail-official/dkg-chain';

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
  /** The shared RFC-64 authority circuit; the scoped lane takes its foreground lane. */
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
 * Registered-authority policy evidence from the complete finalized authority
 * index, shared by both finalized read modes (see
 * `ContextGraphAuthorityReadMode`). Both wait on the one detached snapshot
 * read under the configured request deadline; they differ only in the lane.
 *
 * `finalized-index` (scoped query authorization) waits on the shared RFC-64
 * authority circuit's foreground lane: it never queues behind a cold
 * whole-contract scan on the bulk lane, and the provenance of the answer it
 * consumes is reported to the circuit, so a real provider read counts as
 * recovery evidence for every other consumer while a log fold or a projection
 * fetched before the trip does not. It is admitted while the circuit cools
 * down, as one more probe behind that lane's single permit. Refused, it would
 * defer nothing: its caller would go straight to the live read of the same
 * pool, ungoverned and unserialized, and give up an answer the reader's
 * projection can serve without reaching a provider. Its exhaustion joins the
 * open round. A graph whose registration itself needs the index (name-hash
 * discovery) is still refused at registration during a cooldown and never
 * reaches this lane. `finalized-index-or-live` (read-only host/sync/share
 * gates and the encryption policy bit) reads without the circuit.
 *
 * No `whenIdle()` drain here, unlike the bulk lanes. The reader's drain is
 * global (the bulk catalog pass's scans included), so inside this budget it
 * would hold a projection hit behind unrelated work and, past the budget,
 * trade the hit for the live read. A scan this read stops waiting for keeps
 * running in the detached resolution; that physical work belongs to the
 * reader's lifecycle, which `agent.stop()` drains.
 *
 * `undefined` sends the caller to the bounded current-state read, which
 * fails closed on its own. That happens when the adapter has no finalized
 * capability; when the lane faulted (an exhaustion included) or timed out;
 * when the index holds no snapshot for a slot whose registration is already
 * proven (the projection's anchor has not reached the registration block — the
 * registration lane never treats finalized absence as evidence either); when
 * the caller needs the CURRENT private roster (`requireLiveRosterForPrivate`);
 * and when a PRIVATE roster would come from a projection whose provenance the
 * reader did not report, or that it served as `stale-cache`, meaning a refresh
 * failed and the projection is at least one index tick old. The reader owns
 * the age bound: it never serves a projection older than its stale window,
 * `min(max(3T, 15s), 5m)` for `chain.indexTickMs` T (18s at the default 6s
 * tick), so a roster removal takes effect within finality depth plus one tick
 * while RPC is healthy and within that window at worst. A numeric bound here
 * would only fight the configured tick. Finalized EVIDENCE — an inactive,
 * malformed, or name-mismatched snapshot — fails closed and never falls back.
 * The public policy bit is immutable on chain, so a public snapshot is served
 * at any provenance.
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
