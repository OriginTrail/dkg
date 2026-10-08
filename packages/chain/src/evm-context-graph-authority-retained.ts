// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphAuthorityReadOptions, ContextGraphAuthoritySnapshot } from './chain-adapter.js';
import type { ChainEventLogAuthoritySource } from './chain-event-log-binding.js';
import type { ContextGraphAuthorityIndex } from './context-graph-authority-index.js';
import { contextGraphAuthorityIndexScope, type ContextGraphAuthorityIndexProjection } from './context-graph-authority-index-projection.js';
import { snapshotAuthorityNameHashTargetsV1, projectAuthoritySnapshotsByNameHashesV1 } from './evm-context-graph-authority-snapshot.js';

/**
 * Can the LOG alone prove a retained fold's anchor is still current?
 *
 * The projection cache re-validates the anchor of any retained projection that
 * carries an unsettled tail, and until now that was always a block read — on a
 * measured six-node run, `authorityProjection.validateAnchor` was 982 requests,
 * 8.7% of a private cell, and the single largest consumer of
 * `eth_getBlockByNumber`. But a fold that came from the event log already
 * carries the anchor it was admitted under, and when the tick has not committed
 * since, the log's own CAS token proves that the LOCAL indexed generation has
 * not moved. That costs no RPC.
 *
 * This is deliberately the same bounded-consistency contract as every direct
 * answer from the one-log fast path: it does NOT independently ask the chain
 * whether the anchor is still canonical between ticks. The tick's fetch-time
 * and chain-time freshness limits bound that window. A caller that requires a
 * fresh external-canonicality proof must continue to use the provider path.
 *
 * IT MAY ONLY EVER ANSWER YES. Its return type makes that invariant explicit:
 * `true` is local proof and `undefined` means the local log cannot prove the
 * anchor, so the caller must continue to the provider. Two reasons matter:
 *
 *  - A moved revision does not prove a reorg. It proves the tick committed,
 *    which is the ordinary case once per `chain.indexTickMs`. The log stores a
 *    hash for exactly two blocks — its observed head and its settled boundary
 *    (`ChainEventLogCursor`) — so it cannot speak for the mid-window block a
 *    retained fold is usually anchored at, and silence is not a mismatch.
 *  - `false` is not "unproven" to the cache: it reads it as proof of a
 *    fork and DROPS the whole scope's projection. Answering `false` on a
 *    commit would turn a routine tick into a full rescan.
 *
 * So every case this cannot prove, including a local-store read error, falls
 * through to the block read unchanged. A scan-origin projection has no anchor
 * and always does.
 */
export async function contextGraphAuthorityProjectionAnchorProvenByLogV1(
  cached: ContextGraphAuthorityIndexProjection,
  currentSource: ChainEventLogAuthoritySource | undefined,
  currentContractAddress: string,
): Promise<true | undefined> {
  const anchor = cached.origin.kind === 'log' ? cached.origin.anchor : undefined;
  if (anchor === undefined || currentSource === undefined) return undefined;
  // The LATE-BOUND owner, not the one that produced the fold. A Hub rotation or
  // runtime rebuild may have replaced the source since, and a retired
  // generation's token must not vouch for rows it no longer owns — even when it
  // happens to have kept the same physical address.
  const cachedContractAddress = cached.contractAddress.toLowerCase();
  const sourceContractAddress = currentSource.contractAddress.toLowerCase();
  const boundContractAddress = currentContractAddress.toLowerCase();
  if (cachedContractAddress !== boundContractAddress
    || sourceContractAddress !== boundContractAddress) return undefined;
  try {
    return await currentSource.anchorHolds(anchor) ? true : undefined;
  } catch {
    // This is an optional local proof. A store failure must not replace the
    // provider-backed validation that existed before the optimization.
    return undefined;
  }
}

/**
 * Revalidate a cached proof that a name was absent at its finalized anchor.
 * Bounded readers may use the local log generation as the first fence; live
 * readers and any local-proof miss keep the provider-backed comparison.
 */
export async function contextGraphFinalizedNameAbsenceAnchorHoldsV1(
  cached: ContextGraphAuthorityIndexProjection,
  options: ContextGraphAuthorityReadOptions,
  input: Readonly<{
    currentSource?: ChainEventLogAuthoritySource;
    contractAddress: string;
    readCurrentFinalized: () => Promise<Readonly<{ number: number; hash: string }>>;
  }>,
): Promise<boolean> {
  options.signal?.throwIfAborted();
  if (options.freshness === 'bounded') {
    const provenByLog = await contextGraphAuthorityProjectionAnchorProvenByLogV1(
      cached,
      input.currentSource,
      input.contractAddress,
    );
    options.signal?.throwIfAborted();
    if (provenByLog === true) return true;
  }
  const current = await input.readCurrentFinalized();
  options.signal?.throwIfAborted();
  return cached.finalized.number === current.number
    && cached.finalized.hash.toLowerCase() === current.hash.toLowerCase();
}

/** Retained-only name resolution has no provider or initialization port. */
export async function peekRetainedAuthoritySnapshotsV1(
  input: Readonly<{
    index: ContextGraphAuthorityIndex;
    deploymentId: string;
    contractAddress: string;
    currentSource?: () => ChainEventLogAuthoritySource | undefined;
  }>,
  rawNameHashes: readonly string[],
  options: ContextGraphAuthorityReadOptions,
): Promise<ReadonlyMap<string, ContextGraphAuthoritySnapshot> | undefined> {
  options.signal?.throwIfAborted();
  const nameHashes = snapshotAuthorityNameHashTargetsV1(rawNameHashes);
  if (nameHashes.length === 0) return new Map();
  const proveAnchor = (cached: ContextGraphAuthorityIndexProjection) =>
    contextGraphAuthorityProjectionAnchorProvenByLogV1(cached, input.currentSource?.(), input.contractAddress);
  const retained = await input.index.peekProjection({
    scope: contextGraphAuthorityIndexScope(input.deploymentId, input.contractAddress),
    signal: options.signal,
    project: (projection) => projectAuthoritySnapshotsByNameHashesV1(nameHashes, projection),
    validateAnchor: proveAnchor,
    validateIncomplete: async (cached) => options.freshness === 'bounded' && await proveAnchor(cached) === true,
    onServed: options.onContextGraphAuthorityProjectionServed,
  });
  options.signal?.throwIfAborted();
  return retained.hit ? retained.value : undefined;
}
