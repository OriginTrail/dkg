// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSub } from './dkg-agent-types.js';

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
