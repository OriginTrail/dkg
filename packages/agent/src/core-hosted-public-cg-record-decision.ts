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
  | 'persist-failed';

/** Resolve the durable local identity used for one hosted public Context Graph. */
export function resolveCoreHostedPublicCgLocalId(input: Readonly<{
  onChainId: bigint;
  swmGraphId?: string;
  mappedLocalId?: string;
}>): string {
  const onChainId = input.onChainId.toString();
  // An all-numeric local Context Graph id is still a valid cleartext hint.
  // Only the empty string and the on-chain id itself carry no information.
  const cleartextHint = input.swmGraphId && input.swmGraphId !== onChainId
    ? input.swmGraphId
    : undefined;
  return input.mappedLocalId ?? cleartextHint ?? onChainId;
}

/** True when the durable row already records this exact hosted binding. */
export function isCoreHostedPublicCgRecorded(
  existing: ContextGraphSub | undefined,
  onChainId: string,
): boolean {
  return existing?.coreHosted === true && existing.onChainId === onChainId;
}
