// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSub } from './dkg-agent-types.js';

/**
 * What one attempt to record a public Context Graph as core-hosted achieved.
 * Only `recorded` and `already-recorded` mean the chain-driven VM reconciler
 * will sweep the graph; when the caller asked for durability they also mean
 * the host-only row is in the subscription store.
 */
export type CoreHostedPublicCgRecordOutcome =
  | 'recorded'
  | 'already-recorded'
  /** The on-chain access policy is curated: not the public VM path. */
  | 'curated'
  /** Liveness or access policy could not be established right now. */
  | 'policy-unknown'
  | 'invalid-id'
  | 'vm-reconcile-disabled'
  /** Shutdown started, or a restart superseded this attempt. */
  | 'closed'
  /** The row is in memory but the strict store write failed. */
  | 'persist-failed'
  /**
   * The namespace has a persisted subscription row that is dormant (not yet
   * rehydrated). Writing a fresh host-only row would overwrite its member
   * intent and reconcile watermark, so recording waits for activation.
   */
  | 'dormant'
  /**
   * The namespace is a member subscription with no on-chain binding yet; the
   * subscription's own authoritative binding must settle first.
   */
  | 'binding-pending'
  /**
   * The namespace is bound to a different, still-live Context Graph (a
   * member subscription, or a hosted graph whose copies still need it). One
   * local namespace reconciles one on-chain graph, so this graph's copies
   * there could not be promoted.
   */
  | 'namespace-conflict';

/**
 * The local id a hosted public Context Graph is recorded and reconciled under:
 * the SWM namespace the StorageACK copy was written to. That is the
 * publisher-supplied `swmGraphId` when present, otherwise the numeric id
 * itself. The reconciler reads workspace heads and writes VM metadata only in
 * its row's own namespace, so any other choice (an existing mapping for the
 * on-chain id, for instance) would leave the ACKed copy where promotion never
 * looks.
 */
export function resolveCoreHostedPublicCgLocalId(input: Readonly<{
  onChainId: bigint;
  swmGraphId?: string;
}>): string {
  const onChainId = input.onChainId.toString();
  // An all-numeric local Context Graph id is still a valid cleartext hint.
  // Only the empty string and the on-chain id itself carry no information.
  // A chain-discovered name-hash placeholder of the same graph (#2744) is not
  // a separate namespace: writing the row under the verified cleartext id
  // makes the canonical setter adopt and retire the placeholder.
  return input.swmGraphId && input.swmGraphId !== onChainId
    ? input.swmGraphId
    : onChainId;
}

/** True when the durable row already records this exact hosted binding. */
export function isCoreHostedPublicCgRecorded(
  existing: ContextGraphSub | undefined,
  onChainId: string,
): boolean {
  return existing?.coreHosted === true && existing.onChainId === onChainId;
}
