// SPDX-License-Identifier: Apache-2.0

import { ethers, type Interface, type Log } from 'ethers';
import type { ChainReadOptions } from './chain-adapter.js';

export interface KnowledgeAssetMintLookupOptions extends ChainReadOptions {
  /**
   * Transaction the caller believes minted the asset. A hint that does not
   * prove this mint (for example a duplicate send that reverted) falls back
   * to the creation-log scan instead of deciding the outcome.
   */
  txHash?: string;
}

/**
 * Everything the node records for a mint it did not observe. Every fact comes
 * from ONE canonical receipt, so no later state read is spliced onto it.
 */
export interface KnowledgeAssetMintEvidence {
  kaId: bigint;
  merkleRoot: Uint8Array;
  contextGraphId: bigint;
  authorAddress: string;
  /** The account that sent the mint, which need not be the node's current signer. */
  publisherAddress: string;
  /** TRAC the original mint paid, from `KnowledgeAssetCreated`. */
  tokenAmount: bigint;
  knowledgeAssetsContract: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  txIndex: number;
  blockTimestamp: number;
}

export type KnowledgeAssetMintResolution =
  | { status: 'confirmed'; mint: KnowledgeAssetMintEvidence }
  /** The finality-depth block proves the id unminted, so a plain publish may claim it. */
  | { status: 'not-minted' }
  /** The id is minted, or not proven free, but no creation receipt was recovered. */
  | { status: 'not-found' }
  /** A creation transaction exists but is not yet at the configured finality depth. */
  | { status: 'pending' }
  /** The recovered transaction does not prove this mint. */
  | { status: 'rejected'; reason: string };

/** The optional mint lookup of a `ChainAdapter`. */
export interface KnowledgeAssetMintLookup {
  /**
   * Find and verify the transaction that minted `kaId`, for a publish whose
   * transaction mined after the node stopped waiting. All facts of a
   * `confirmed` answer come from one receipt at the configured finality depth.
   */
  resolveKnowledgeAssetMint?(
    kaId: bigint,
    options?: KnowledgeAssetMintLookupOptions,
  ): Promise<KnowledgeAssetMintResolution>;
}

type MintReceiptFacts = Pick<
  KnowledgeAssetMintEvidence,
  'kaId' | 'merkleRoot' | 'contextGraphId' | 'authorAddress' | 'tokenAmount' | 'knowledgeAssetsContract'
>;

interface MintReceiptContract {
  readonly address: string;
  readonly interface: Interface;
}

/**
 * Read one mint out of a successful receipt: exactly one `KnowledgeAssetCreated`
 * for `kaId` from DKGKnowledgeAssets and exactly one
 * `KnowledgeAssetRegisteredToContextGraph` for it from ContextGraphStorage.
 * Returns the reason as a string when the receipt does not prove the mint.
 */
export function decodeKnowledgeAssetMintReceipt(
  logs: readonly Pick<Log, 'address' | 'topics' | 'data'>[],
  contracts: { knowledgeAssets: MintReceiptContract; contextGraphStorage: MintReceiptContract },
  kaId: bigint,
): MintReceiptFacts | string {
  const created = matchingLogs(logs, contracts.knowledgeAssets, 'KnowledgeAssetCreated', 'id', kaId);
  const registered = matchingLogs(
    logs, contracts.contextGraphStorage, 'KnowledgeAssetRegisteredToContextGraph', 'kaId', kaId,
  );
  if (created.length !== 1) {
    return `expected one KnowledgeAssetCreated for kaId ${kaId}, found ${created.length}`;
  }
  if (registered.length !== 1) {
    return `expected one KnowledgeAssetRegisteredToContextGraph for kaId ${kaId}, found ${registered.length}`;
  }
  const event = created[0]!;
  return {
    kaId,
    merkleRoot: ethers.getBytes(event.args.merkleRoot),
    contextGraphId: BigInt(registered[0]!.args.contextGraphId),
    authorAddress: ethers.getAddress(event.args.author),
    tokenAmount: BigInt(event.args.tokenAmount),
    knowledgeAssetsContract: ethers.getAddress(contracts.knowledgeAssets.address),
  };
}

function matchingLogs(
  logs: readonly Pick<Log, 'address' | 'topics' | 'data'>[],
  contract: MintReceiptContract,
  eventName: string,
  idField: string,
  kaId: bigint,
): ethers.LogDescription[] {
  const address = contract.address.toLowerCase();
  const matches: ethers.LogDescription[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== address) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue; // another event of the same contract
    }
    if (parsed?.name === eventName && BigInt(parsed.args[idField]) === kaId) matches.push(parsed);
  }
  return matches;
}
