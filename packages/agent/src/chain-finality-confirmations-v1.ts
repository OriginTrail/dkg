// SPDX-License-Identifier: Apache-2.0

/** The adapter that resolves chain anchors owns finality when it exposes a depth. */
export function resolveChainFinalityConfirmationsV1(
  chain: { getFinalityConfirmations?: () => number | undefined },
  config: { finalityConfirmations?: number } | undefined,
): number | undefined {
  const fromAdapter = typeof chain.getFinalityConfirmations === 'function'
    ? chain.getFinalityConfirmations()
    : undefined;
  return fromAdapter ?? config?.finalityConfirmations;
}
