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
 * The resolver is fail-closed by construction: a depth below 1, an unusable
 * head, a head below the configured depth, a missing block, a block whose
 * height does not match the one that was asked for, and a block with no hash
 * each THROW the caller's own subsystem error rather than degrading to a
 * shallower or unpinned read. Callers keep the resolved block, so the existing
 * HASH pinning (an anchor re-read that must still produce the same hash) is
 * preserved, not reduced to a number.
 *
 * ONE head read, and a second read only when the depth actually moves the
 * anchor off the head. At the default depth of 1 the anchor IS the head, so the
 * head block this resolver already holds is the anchor: asking the endpoint for
 * it again would be a second billed round-trip that can also be answered by a
 * DIFFERENT backend of a load-balanced URL, which is how a `null` block (height
 * N from one backend, `eth_getBlockByNumber(N)` from a sibling still at N-1)
 * used to fail an authority read closed. Every caller therefore behaves the
 * same way, and matches `readStrictFinalityAnchorV1`'s long-standing reuse
 * branch, rather than one subsystem paying for a cross-check that the others
 * skip.
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
   * The operator-selected depth, normally already normalized by
   * `resolveFinalityConfirmations` (>= 1, default 1). Re-validated here because
   * this module's fail-closed guarantee must not rest on a caller's discipline:
   * a depth of 0 would resolve to `head + 1`, an anchor ABOVE the head that this
   * resolver exists to make unrepresentable.
   */
  readonly finalityConfirmations: number;
  /**
   * The current chain head BLOCK, from ONE endpoint. Returning `null` (or a
   * block without a hash) fails the anchor closed.
   */
  readonly readHead: () => Promise<TBlock | null | undefined>;
  /**
   * The block at the resolved anchor height, from the SAME endpoint as the head
   * read. Returning `null` (or a block without a hash) fails the anchor closed.
   * Called ONLY when the configured depth puts the anchor below the head.
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
  const confirmations = input.finalityConfirmations;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw input.unavailable(
      `finality depth ${String(confirmations)} is not an integer >= 1`,
    );
  }
  const head = requireAnchorBlockV1(
    await input.readHead(),
    'chain head',
    undefined,
    input.unavailable,
  );
  const anchorBlockNumber = confirmedStateBlockAtHead(head.number, confirmations);
  if (anchorBlockNumber === null) {
    throw input.unavailable(
      `chain head ${head.number} is below the configured finality depth ${confirmations}`,
    );
  }
  // At the default depth the anchor IS the head block already in hand. Re-asking
  // the endpoint for it buys no cross-check (there is only one self-report to
  // check) and costs a round-trip that a sibling backend can answer `null`.
  if (anchorBlockNumber === head.number) return head;
  return requireAnchorBlockV1(
    await input.readBlockAt(anchorBlockNumber),
    `anchor block ${anchorBlockNumber}`,
    anchorBlockNumber,
    input.unavailable,
  );
}

/**
 * Fail an anchor candidate closed unless it carries a usable height and hash.
 *
 * `expectedBlockNumber` is supplied only for the anchor read: an endpoint that
 * answers a different height than the one asked for is answering about a chain
 * view this node did not select. The head read has no expected height to
 * compare against — that is what makes it the head.
 */
function requireAnchorBlockV1<TBlock extends EvmFinalityAnchorBlockIdentityV1>(
  block: TBlock | null | undefined,
  label: string,
  expectedBlockNumber: number | undefined,
  unavailable: (detail: string) => Error,
): TBlock & { readonly hash: string } {
  if (block === null || block === undefined) {
    throw unavailable(`${label} is unavailable`);
  }
  if (!Number.isSafeInteger(block.number) || block.number < 0) {
    throw unavailable(`${label} is not a usable block height: ${String(block.number)}`);
  }
  if (expectedBlockNumber !== undefined && block.number !== expectedBlockNumber) {
    throw unavailable(`${label} was answered by block ${String(block.number)}`);
  }
  if (typeof block.hash !== 'string' || block.hash.length === 0) {
    throw unavailable(`${label} carries no block hash`);
  }
  return block as TBlock & { readonly hash: string };
}
