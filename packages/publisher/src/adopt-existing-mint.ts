// SPDX-License-Identifier: Apache-2.0

/**
 * Adopt a sealed publish's own mint that landed after the node stopped
 * waiting for it.
 *
 * Such a mint leaves the asset shared-only locally, and every retry reverts
 * `KaIdAlreadyMinted` because the seal pins the reserved KA id. Adoption reads
 * the mint's receipt, checks it against the seal, and hands the original
 * transaction to the publish's unchanged success path. Anything it cannot
 * prove refuses with {@link MintAdoptionRefusedError}.
 */

import {
  kaIdAlreadyMintedFromError,
  type ChainAdapter,
  type KnowledgeAssetMintEvidence,
  type OnChainPublishResult,
  type V10PublishParams,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

export const MINT_ADOPTION_REFUSED_CODE = 'KA_MINT_ADOPTION_REFUSED';

export type MintAdoptionRefusalReason =
  /** The revert names another KA id than the seal reserved. */
  | 'reserved-id-mismatch'
  /** Reconcile: the finality-depth block proves the reserved id free, so publish it normally. */
  | 'not-minted'
  /** The chain adapter cannot look up mints. */
  | 'lookup-unsupported'
  /** The id is minted but no creation receipt was recovered. */
  | 'mint-receipt-missing'
  /** The creation transaction has not reached the configured finality depth. */
  | 'mint-not-final'
  /** The recovered transaction reverted or lacks the expected creation logs. */
  | 'mint-receipt-invalid'
  | 'root-mismatch'
  | 'context-graph-mismatch'
  | 'author-mismatch';

/** Missing or not-yet-final evidence can appear later; a mismatch never changes. */
const RETRYABLE_REFUSALS: ReadonlySet<MintAdoptionRefusalReason> = new Set([
  'mint-receipt-missing',
  'mint-not-final',
]);

export class MintAdoptionRefusedError extends Error {
  readonly code = MINT_ADOPTION_REFUSED_CODE;
  readonly retryable: boolean;

  constructor(
    readonly reason: MintAdoptionRefusalReason,
    readonly kaId: bigint,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`Refusing to record the existing mint of KA ${kaId} (${reason}): ${detail}`, options);
    this.name = 'MintAdoptionRefusedError';
    this.retryable = RETRYABLE_REFUSALS.has(reason);
  }
}

/** What the sealed publish would have minted. */
export interface MintAdoptionExpectation {
  kaId: bigint;
  merkleRoot: Uint8Array;
  contextGraphId: bigint;
  authorAddress: string;
}

/**
 * Verify the existing mint of `expected.kaId` against the seal and return it
 * as the publish result: the original transaction, block, publisher and TRAC
 * cost, never the retry's quote. `revert` is the `KaIdAlreadyMinted` failure
 * that led here, if any; it becomes the refusal's `cause`.
 */
export async function adoptExistingMint(
  chain: ChainAdapter,
  expected: MintAdoptionExpectation,
  options: { txHash?: string; revert?: unknown; signal?: AbortSignal } = {},
): Promise<OnChainPublishResult> {
  const refuse = (reason: MintAdoptionRefusalReason, detail: string) =>
    new MintAdoptionRefusedError(reason, expected.kaId, detail, { cause: options.revert });
  if (typeof chain.resolveKnowledgeAssetMint !== 'function') {
    throw refuse('lookup-unsupported', 'this chain adapter cannot look up mints');
  }
  const resolution = await chain.resolveKnowledgeAssetMint(expected.kaId, {
    txHash: options.txHash,
    signal: options.signal,
  });
  switch (resolution.status) {
    case 'confirmed':
      break;
    case 'not-minted':
      // A KaIdAlreadyMinted revert proves the id minted at the tip; only the
      // finality-depth block does not show it yet.
      throw options.revert === undefined
        ? refuse('not-minted', 'the reserved id is not minted at the finality-depth block; publish the asset instead')
        : refuse('mint-not-final', 'the mint has not reached the finality-depth block');
    case 'pending':
      throw refuse('mint-not-final', 'the creation transaction has not reached the configured finality depth');
    case 'not-found':
      throw refuse('mint-receipt-missing', 'no creation receipt was recovered; pass the mint transaction hash if it is known');
    case 'rejected':
      throw refuse('mint-receipt-invalid', resolution.reason);
  }
  const mint = resolution.mint;
  if (mint.kaId !== expected.kaId) {
    throw refuse('mint-receipt-invalid', `the receipt minted KA ${mint.kaId}`);
  }
  if (ethers.hexlify(mint.merkleRoot) !== ethers.hexlify(expected.merkleRoot)) {
    throw refuse('root-mismatch',
      `on-chain root ${ethers.hexlify(mint.merkleRoot)} is not the sealed root ${ethers.hexlify(expected.merkleRoot)}`);
  }
  if (mint.contextGraphId !== expected.contextGraphId) {
    throw refuse('context-graph-mismatch',
      `minted into context graph ${mint.contextGraphId}, not ${expected.contextGraphId}`);
  }
  if (mint.authorAddress.toLowerCase() !== expected.authorAddress.toLowerCase()) {
    throw refuse('author-mismatch', `minted for author ${mint.authorAddress}, not ${expected.authorAddress}`);
  }
  return publishResultFromMint(mint);
}

/**
 * The chain step of a publish. A sealed publish (`expected` set) adopts its
 * own existing mint when the contract reports the reserved id already
 * minted: only a `KaIdAlreadyMinted` revert decoded from structured revert
 * data, for exactly the sealed reservation, leads there. `existingOnly`
 * (reconcile) skips `createKnowledgeAssets` and goes straight to adoption,
 * so nothing is sent.
 */
export async function mintOrAdoptKnowledgeAssets(
  chain: ChainAdapter,
  params: V10PublishParams,
  adoption: { expected?: MintAdoptionExpectation; existingOnly?: { txHash?: string } },
): Promise<{ result: OnChainPublishResult; adopted: boolean }> {
  const { expected, existingOnly } = adoption;
  if (existingOnly) {
    if (!expected) throw new Error('Recording an existing mint requires a sealed graph-scoped publish');
    return { result: await adoptExistingMint(chain, expected, { txHash: existingOnly.txHash }), adopted: true };
  }
  try {
    return { result: await chain.createKnowledgeAssets(params), adopted: false };
  } catch (error) {
    const mintedKaId = expected ? kaIdAlreadyMintedFromError(error) : null;
    if (!expected || mintedKaId === null) throw error;
    if (mintedKaId !== expected.kaId || params.reservedKaId !== expected.kaId) {
      throw new MintAdoptionRefusedError('reserved-id-mismatch', expected.kaId,
        `the contract reports KA ${mintedKaId} already minted`, { cause: error });
    }
    return { result: await adoptExistingMint(chain, expected, { revert: error }), adopted: true };
  }
}

function publishResultFromMint(mint: KnowledgeAssetMintEvidence): OnChainPublishResult {
  return {
    batchId: mint.kaId,
    kaId: mint.kaId,
    startKAId: mint.kaId,
    endKAId: mint.kaId,
    merkleRoot: mint.merkleRoot,
    knowledgeAssetsContract: mint.knowledgeAssetsContract,
    txHash: mint.txHash,
    blockNumber: mint.blockNumber,
    txIndex: mint.txIndex,
    blockTimestamp: mint.blockTimestamp,
    publisherAddress: mint.publisherAddress,
    authorAddress: mint.authorAddress,
    tokenAmount: mint.tokenAmount,
  };
}
