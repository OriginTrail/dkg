// SPDX-License-Identifier: Apache-2.0

/**
 * THE single definition of "the finality anchor block".
 *
 * Chain finality in this node is SINGULAR and operator-defined: it is
 * `chain.finalityConfirmations` (see `resolveFinalityConfirmations` and
 * `confirmedStateBlockAtHead` in evm-adapter-constants.ts). Confirmation 1 is
 * the current head, so the default pins the head; a larger value pins
 * `head - confirmations + 1`. Every subsystem that needs "the block whose state
 * this node is willing to believe" resolves it HERE, so there is exactly one
 * notion of finality and one place an operator can move it.
 *
 * The RPC-specific `finalized` block tag is deliberately NOT that notion. It is
 * the endpoint's own consensus-finality marker — ~600 blocks / ~20 minutes
 * behind head on Base Sepolia, inherited from Ethereum's two-epoch finality and
 * not configurable by the operator. `evm-adapter-storage-reads.ts` already
 * diagnosed the damage that causes for named-KA recovery; the Context Graph
 * authority index and the RFC-64 precommit anchors had the same defect.
 *
 * The resolver is fail-closed by construction: an unusable head, a head below
 * the configured depth, a missing block, a block whose height does not match the
 * one that was asked for, and a block with no hash each THROW the caller's own
 * subsystem error rather than degrading to a shallower or unpinned read. Callers
 * keep the resolved block, so the existing HASH pinning (an anchor re-read that
 * must still produce the same hash) is preserved, not reduced to a number.
 */

import { confirmedStateBlockAtHead } from './evm-adapter-constants.js';

/** The identity every anchor candidate block must carry. */
export interface EvmFinalityAnchorBlockIdentityV1 {
  readonly number: number;
  readonly hash: string | null;
}

export interface ResolveEvmFinalityAnchorBlockInputV1<
  TBlock extends EvmFinalityAnchorBlockIdentityV1,
> {
  /**
   * The operator-selected depth, already normalized by
   * `resolveFinalityConfirmations` (>= 1, default 1).
   */
  readonly finalityConfirmations: number;
  /** Current chain head height, from ONE endpoint. */
  readonly readHeadBlockNumber: () => Promise<number>;
  /**
   * The block at the resolved anchor height, from the SAME endpoint as the head
   * read. Returning `null` (or a block without a hash) fails the anchor closed.
   */
  readonly readBlockAt: (anchorBlockNumber: number) => Promise<TBlock | null | undefined>;
  /** Build the fail-closed error this subsystem already throws. */
  readonly unavailable: (detail: string) => Error;
}

/**
 * Resolve the operator-configured finality anchor block, hash included.
 *
 * The height comes from `confirmedStateBlockAtHead` — the SAME arithmetic the
 * receipt proof, the pinned version snapshot and the chain-proof snapshot use.
 * No caller re-derives it.
 */
export async function resolveEvmFinalityAnchorBlockV1<
  TBlock extends EvmFinalityAnchorBlockIdentityV1,
>(
  input: ResolveEvmFinalityAnchorBlockInputV1<TBlock>,
): Promise<TBlock & { readonly hash: string }> {
  const head = await input.readHeadBlockNumber();
  if (!Number.isSafeInteger(head) || head < 0) {
    throw input.unavailable(`chain head ${String(head)} is not a usable block height`);
  }
  const anchorBlockNumber = confirmedStateBlockAtHead(head, input.finalityConfirmations);
  if (anchorBlockNumber === null) {
    throw input.unavailable(
      `chain head ${head} is below the configured finality depth `
      + `${input.finalityConfirmations}`,
    );
  }
  const block = await input.readBlockAt(anchorBlockNumber);
  if (block === null || block === undefined) {
    throw input.unavailable(`anchor block ${anchorBlockNumber} is unavailable`);
  }
  // An endpoint that answers a different height than the one asked for is
  // answering about a chain view this node did not select. Under the `finalized`
  // tag there was no expected height to compare against; under an operator-
  // selected depth there is, so a lagging or lying endpoint is detectable here.
  if (block.number !== anchorBlockNumber) {
    throw input.unavailable(
      `anchor block ${anchorBlockNumber} was answered by block ${String(block.number)}`,
    );
  }
  if (typeof block.hash !== 'string' || block.hash.length === 0) {
    throw input.unavailable(`anchor block ${anchorBlockNumber} carries no block hash`);
  }
  return block as TBlock & { readonly hash: string };
}
