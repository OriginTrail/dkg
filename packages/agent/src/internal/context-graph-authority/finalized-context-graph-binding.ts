// SPDX-License-Identifier: Apache-2.0

import type {
  ContextGraphSub,
  DurableContextGraphSubscriptionBinding,
} from '../../dkg-agent-types.js';

/** The agent's local subscription index and commitment derivations. */
export interface FinalizedContextGraphNameBindingSourceV1 {
  resolveContextGraphNameHashBindingTarget(requestedId: string): {
    localId: string;
    subscription: ContextGraphSub;
    nameHash?: string;
  } | null;
  contextGraphNameCommitment(localId: string): string;
  contextGraphWireId(contextGraphId: string): string;
}

/**
 * The one finalized name commitment every finalized-index consumer binds a
 * numeric authority slot against. A locally admitted subscription owns its
 * commitment. Otherwise the persisted wire id wins over hashing the requested
 * string: a wire-id-keyed placeholder row (staged from a `ContextGraphCreated`
 * event before its cleartext arrives) already IS the commitment, and hashing
 * it again can never equal the chain's `nameHash`. A durable row hint applies
 * only before its subscription is installed. The binding target already
 * consulted the subscription map (direct key, then reverse wire id), so a
 * `null` target means no local row exists for the requested id.
 */
export function resolveFinalizedContextGraphNameBindingV1(
  source: FinalizedContextGraphNameBindingSourceV1,
  requestedId: string,
  durableBinding?: Readonly<DurableContextGraphSubscriptionBinding>,
): {
  localId: string;
  subscription: ContextGraphSub | undefined;
  expectedNameHash: string;
} {
  const canonicalTarget = source.resolveContextGraphNameHashBindingTarget(requestedId);
  const localId = canonicalTarget?.localId ?? requestedId;
  const subscription = canonicalTarget?.subscription;
  const persistedNameHash = subscription?.onChainHash ?? durableBinding?.onChainHash;
  const expectedNameHash = canonicalTarget?.nameHash
    ?? (persistedNameHash === undefined
      ? source.contextGraphNameCommitment(localId)
      : source.contextGraphWireId(persistedNameHash));
  return { localId, subscription, expectedNameHash };
}

/** Why a finalized snapshot is not evidence about the graph a binding names. */
export type FinalizedContextGraphSnapshotMismatchV1 =
  | 'inactive'
  | 'context-graph-id'
  | 'name-hash';

const BYTES32_HEX = /^0x[0-9a-f]{64}$/i;

/**
 * The one test every finalized-index consumer applies before it treats a
 * snapshot as evidence about the graph it asked for: the slot is active, it is
 * the numeric slot the binding names, and it carries the binding's name
 * commitment. Commitments compare as bytes32 hex, case-insensitively, and a
 * value that is not bytes32 hex never matches. `nameHash` is omitted only when
 * the request named the numeric slot itself, so there is no commitment to bind.
 *
 * Only the predicate is shared. Each consumer keeps its own failure mode — the
 * registration and VM reconcile lanes throw, the scoped read's policy lane
 * fails closed as `chain-access-policy-unknown` — and a mismatch is reported in
 * the order above, so an inactive snapshot reads as inactive whatever else is
 * wrong with it.
 */
export function finalizedContextGraphSnapshotMismatchV1(
  snapshot: Readonly<{ active: boolean; contextGraphId: string; nameHash: string }>,
  expected: Readonly<{ onChainId: bigint; nameHash?: string }>,
): FinalizedContextGraphSnapshotMismatchV1 | undefined {
  if (snapshot.active !== true) return 'inactive';
  if (snapshot.contextGraphId !== expected.onChainId.toString(10)) return 'context-graph-id';
  if (
    expected.nameHash !== undefined
    && !(
      BYTES32_HEX.test(snapshot.nameHash)
      && BYTES32_HEX.test(expected.nameHash)
      && snapshot.nameHash.toLowerCase() === expected.nameHash.toLowerCase()
    )
  ) return 'name-hash';
  return undefined;
}
