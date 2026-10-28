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
  | 'author-mismatch'
  /** An update replaced the minted content, so recording it would install a stale version as current. */
  | 'superseded'
  /** The current-version view at the finality-depth block is missing, behind the mint, or contradicts it. */
  | 'version-view-unavailable'
  /** The node already holds a record of this KA that does not describe the sealed content. */
  | 'existing-record-conflict';

/** Missing or not-yet-final evidence can appear later; a mismatch never changes. */
const RETRYABLE_REFUSALS: ReadonlySet<MintAdoptionRefusalReason> = new Set([
  'mint-receipt-missing',
  'mint-not-final',
  'version-view-unavailable',
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
 * cost, never the retry's quote. The mint must also still be the asset's
 * current version. `revert` is the `KaIdAlreadyMinted` failure that led here,
 * if any; it becomes the refusal's `cause`.
 */
export async function adoptExistingMint(
  chain: ChainAdapter,
  expected: MintAdoptionExpectation,
  options: { txHash?: string; revert?: unknown; signal?: AbortSignal } = {},
): Promise<OnChainPublishResult> {
  return publishResultFromMint(await resolveVerifiedMintEvidence(chain, expected, options));
}
async function resolveVerifiedMintEvidence(chain: ChainAdapter, expected: MintAdoptionExpectation,
  options: { txHash?: string; revert?: unknown; signal?: AbortSignal }): Promise<KnowledgeAssetMintEvidence> {
  const refuse = (reason: MintAdoptionRefusalReason, detail: string) =>
    new MintAdoptionRefusedError(reason, expected.kaId, detail, { cause: options.revert });
  if (typeof chain.resolveKnowledgeAssetMint !== 'function' || typeof chain.readKnowledgeAssetVersionSnapshot !== 'function') {
    throw refuse('lookup-unsupported', 'this chain adapter cannot look up mints and current versions');
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
  await assertMintCurrent(chain, expected, mint, options);
  return mint;
}
async function assertMintCurrent(chain: ChainAdapter, expected: MintAdoptionExpectation,
  mint: Pick<KnowledgeAssetMintEvidence, 'merkleRoot' | 'blockNumber'>,
  options: { revert?: unknown; signal?: AbortSignal } = {}): Promise<void> {
  const refuse = (reason: MintAdoptionRefusalReason, detail: string) =>
    new MintAdoptionRefusedError(reason, expected.kaId, detail, { cause: options.revert });
  // A receipt proves the content was minted, not that it is still current.
  // The pinned version view only gates adoption: every recorded fact still
  // comes from the receipt. A mint is version 1, so more roots mean an update
  // superseded it; fewer, or one other root, mean the view cannot be trusted
  // yet (the rule named-ka-publish-recovery.ts applies to a recovered create).
  const current = await chain.readKnowledgeAssetVersionSnapshot?.(expected.kaId, { signal: options.signal });
  if (current && current.rootCount > 1n) {
    throw refuse('superseded', `the KA is at version ${current.rootCount}; an update replaced the minted content`);
  }
  if (!current || current.blockNumber < mint.blockNumber || current.rootCount < 1n
    || current.latestRoot.toLowerCase() !== ethers.hexlify(mint.merkleRoot).toLowerCase()) {
    throw refuse('version-view-unavailable',
      'the current version at the finality-depth block is unavailable or does not show this mint yet');
  }
}

/** The chain step's result and how the publish records it. */
export interface MintOrAdoptOutcome {
  readonly result: OnChainPublishResult;
  readonly adopted: boolean;
}

/**
 * The chain step of a publish. A sealed publish adopts its own existing mint
 * when the contract reports the reserved id already minted: only a
 * `KaIdAlreadyMinted` revert decoded from structured revert data, for exactly
 * the sealed reservation, leads there. Explicit record-only acquisition uses
 * adoptMintForRecording at the publisher boundary. The seal's expectation is the publish's own reserved id, root,
 * context graph and author.
 */
export async function mintOrAdoptKnowledgeAssets(
  chain: ChainAdapter,
  params: V10PublishParams,
  sealed: boolean,
): Promise<MintOrAdoptOutcome> {
  const expected: MintAdoptionExpectation | undefined = sealed && params.reservedKaId !== undefined
    ? {
      kaId: params.reservedKaId,
      merkleRoot: params.merkleRoot,
      contextGraphId: params.contextGraphId,
      authorAddress: params.author.address,
    }
    : undefined;
  try {
    return { result: await chain.createKnowledgeAssets(params), adopted: false };
  } catch (error) {
    const mintedKaId = expected ? kaIdAlreadyMintedFromError(error) : null;
    if (!sealed || !expected || mintedKaId === null) throw error;
    if (mintedKaId !== expected.kaId) {
      throw new MintAdoptionRefusedError('reserved-id-mismatch', expected.kaId,
        `the contract reports KA ${mintedKaId} already minted`, { cause: error });
    }
    return { result: await adoptExistingMint(chain, expected, { revert: error }), adopted: true };
  }
}

/** Opaque verified receipt, scoped to one adapter and sealed reservation. */
export interface PreparedMintAdoption { readonly preparedMintAdoption: unique symbol }
const preparedEvidence = new WeakMap<object, { chain: ChainAdapter; expected: MintAdoptionExpectation; mint: KnowledgeAssetMintEvidence }>();
export type MintAdoptionRequest = Readonly<{ kind?: 'lookup'; txHash?: string }>
  | Readonly<{ kind: 'prepared'; evidence: PreparedMintAdoption }>;
/** Read slow chain evidence before taking an assertion lifecycle write lock. */
export async function prepareMintAdoption(chain: ChainAdapter, expected: MintAdoptionExpectation,
  txHash?: string): Promise<PreparedMintAdoption> {
  if (!chain.isReceiptBlockFinalAndCanonical) throw new MintAdoptionRefusedError('lookup-unsupported', expected.kaId, 'prepared mint evidence requires canonical block revalidation');
  const mint = await resolveVerifiedMintEvidence(chain, expected, { txHash });
  const token = Object.freeze({}) as PreparedMintAdoption;
  preparedEvidence.set(token, { chain, expected: { ...expected, merkleRoot: Uint8Array.from(expected.merkleRoot) }, mint: { ...mint, merkleRoot: Uint8Array.from(mint.merkleRoot) } });
  return token;
}
/** Revalidate prepared evidence inside the lifecycle lease, without rescanning creation logs. */
export async function readPreparedMintAdoption(token: PreparedMintAdoption, chain: ChainAdapter,
  expected: MintAdoptionExpectation): Promise<OnChainPublishResult> {
  const evidence = preparedEvidence.get(token);
  if (!evidence || evidence.chain !== chain || evidence.expected.kaId !== expected.kaId
    || evidence.expected.contextGraphId !== expected.contextGraphId
    || evidence.expected.authorAddress.toLowerCase() !== expected.authorAddress.toLowerCase()
    || ethers.hexlify(evidence.expected.merkleRoot) !== ethers.hexlify(expected.merkleRoot))
    throw new Error('Prepared mint evidence does not match the current sealed reservation');
  if (!chain.isReceiptBlockFinalAndCanonical || !await chain.isReceiptBlockFinalAndCanonical(evidence.mint))
    throw new MintAdoptionRefusedError('mint-not-final', expected.kaId, 'the prepared mint block is no longer final and canonical');
  await assertMintCurrent(chain, expected, evidence.mint);
  return publishResultFromMint(evidence.mint);
}

/** Verify receipt evidence directly; local record policy belongs to the recorder. */
export async function adoptMintForRecording(chain: ChainAdapter, expected: MintAdoptionExpectation,
  request: MintAdoptionRequest): Promise<MintOrAdoptOutcome> {
  return { result: request.kind === 'prepared'
    ? await readPreparedMintAdoption(request.evidence, chain, expected)
    : await adoptExistingMint(chain, expected, { txHash: request.txHash }), adopted: true };
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
