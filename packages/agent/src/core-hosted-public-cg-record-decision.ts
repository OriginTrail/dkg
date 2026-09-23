// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphSub } from './dkg-agent-types.js';

/** Resolve the durable local identity used for one hosted public Context Graph. */
export function resolveCoreHostedPublicCgLocalId(input: Readonly<{
  onChainId: bigint;
  swmGraphId?: string;
  mappedLocalId?: string;
  /**
   * True when `mappedLocalId` is only the chain-discovered name-hash
   * placeholder of this on-chain graph AND its committed name hash equals
   * keccak256(utf8(swmGraphId)). The hint is then the graph's verified
   * cleartext id and must win: every holder keys the graph's SWM (and the
   * VM it promotes) by that id, so hosting it under the hash would leave the
   * reconciler unable to promote or serve anything.
   */
  mappedLocalIdIsNamePlaceholderOfHint?: boolean;
}>): string {
  const onChainId = input.onChainId.toString();
  // An all-numeric local Context Graph id is still a valid cleartext hint.
  // Only the empty string and the on-chain id itself carry no information.
  const cleartextHint = input.swmGraphId && input.swmGraphId !== onChainId
    ? input.swmGraphId
    : undefined;
  if (cleartextHint !== undefined && input.mappedLocalIdIsNamePlaceholderOfHint === true) {
    return cleartextHint;
  }
  return input.mappedLocalId ?? cleartextHint ?? onChainId;
}

/** True when the durable row already records this exact hosted binding. */
export function isCoreHostedPublicCgRecorded(
  existing: ContextGraphSub | undefined,
  onChainId: string,
): boolean {
  return existing?.coreHosted === true && existing.onChainId === onChainId;
}
