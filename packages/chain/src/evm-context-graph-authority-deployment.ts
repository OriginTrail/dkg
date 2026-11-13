// SPDX-License-Identifier: Apache-2.0

/** A contract's deployment block, and whether the lookup could pin it. */
export type ContractDeploymentLookupV1 = Readonly<{
  blockNumber: number;
  /**
   * False for the adapter's genesis fallback: no endpoint could pin the block
   * (pruned or throttled), so `blockNumber` is 0 and the adapter does not
   * cache it.
   */
  pinned: boolean;
}>;

/** The lower bounds of one scan, as `ContextGraphAuthorityIndexScanInput` takes them. */
export type AuthorityScanBoundsV1 = Readonly<{
  deploymentBlockNumber: number;
  /** Set when `deploymentBlockNumber` is the stored checkpoint's own. */
  rebuildFromBlockNumber?: number;
}>;

/** The lower bounds one authority read scans from. */
export interface AuthorityScanDeploymentV1 {
  /** For a chain event log anchor's coverage proof. */
  readonly coverageFrom: number;
  /** For a scan to `anchorBlockNumber`. */
  scanBounds(anchorBlockNumber: number): AuthorityScanBoundsV1;
}

/**
 * Where one authority read's scans start.
 *
 * The index rebuilds a durable checkpoint reduced from a different deployment
 * block, so an unpinned lookup used to replace the whole history with a walk
 * from block 0 whenever it met pruned or throttled endpoints. It now resumes
 * from the block the stored checkpoint was reduced from, but only for an anchor
 * at or above that block, and only while admission keeps that checkpoint: a
 * rebuild starts from the lookup's own bound (`rebuildFromBlockNumber`). A
 * stored block above the anchor, or history admission rejects, belongs to a
 * chain view that is gone (a reset at the same address), and its deployment
 * block must not bound the rebuild that replaces it.
 */
export async function resolveAuthorityScanDeploymentV1(
  lookup: () => Promise<ContractDeploymentLookupV1>,
  storedDeploymentBlock: () => Promise<number | undefined>,
): Promise<AuthorityScanDeploymentV1> {
  const found = await lookup();
  const stored = found.pinned ? undefined : await storedDeploymentBlock();
  return Object.freeze({
    coverageFrom: stored ?? found.blockNumber,
    scanBounds: (anchorBlockNumber: number): AuthorityScanBoundsV1 => (
      stored === undefined || stored > anchorBlockNumber
        ? Object.freeze({ deploymentBlockNumber: found.blockNumber })
        : Object.freeze({ deploymentBlockNumber: stored, rebuildFromBlockNumber: found.blockNumber })
    ),
  });
}
