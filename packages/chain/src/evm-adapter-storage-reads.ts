// SPDX-License-Identifier: Apache-2.0

/**
 * Low-level on-chain storage read methods.
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Bodies
 * are a 1:1 move — no behaviour change. Mixed into the concrete EVMChainAdapter
 * via applyMixins(); see evm-adapter.ts for the assembly.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import { Contract, ethers } from 'ethers';
import type { ChainReadOptions, KnowledgeAssetUpdateContext } from './chain-adapter.js';

const UPDATE_CONTEXT_FIELDS = [
  'merkleRootsCount',
  'minted',
  'byteSize',
  'endEpoch',
  'tokenAmount',
  'isImmutable',
  'merkleLeafCount',
] as const;

type UpdateContextField = (typeof UPDATE_CONTEXT_FIELDS)[number];
type NormalizedUpdateContext = Record<UpdateContextField, unknown>;

/** Normalize ethers' named Result and plain positional tuple shapes once. */
function normalizeUpdateContext(raw: unknown, kaId: bigint): NormalizedUpdateContext {
  const named = typeof raw === 'object' && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const positional = Array.isArray(raw) ? raw : [];
  return Object.fromEntries(UPDATE_CONTEXT_FIELDS.map((name, index) => {
    const value = named[name] ?? positional[index];
    if (value === undefined) {
      throw new Error(`Missing ${name} in update context for KA ${kaId}`);
    }
    return [name, value];
  })) as NormalizedUpdateContext;
}

function decodeBigIntScalar(value: unknown, name: UpdateContextField, kaId: bigint): bigint {
  if (
    typeof value !== 'string'
    && typeof value !== 'number'
    && typeof value !== 'bigint'
    && typeof value !== 'boolean'
  ) {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
  try {
    return BigInt(value);
  } catch {
    throw new Error(`Invalid ${name} in update context for KA ${kaId}`);
  }
}

function decodeKnowledgeAssetUpdateContext(
  raw: unknown,
  kaId: bigint,
): KnowledgeAssetUpdateContext {
  const context = normalizeUpdateContext(raw, kaId);
  const merkleLeafCount = Number(decodeBigIntScalar(
    context.merkleLeafCount,
    'merkleLeafCount',
    kaId,
  ));
  if (!Number.isSafeInteger(merkleLeafCount) || merkleLeafCount < 0) {
    throw new Error(`Invalid merkleLeafCount in update context for KA ${kaId}`);
  }
  if (typeof context.isImmutable !== 'boolean') {
    throw new Error(`Invalid isImmutable in update context for KA ${kaId}`);
  }
  return {
    merkleRootsCount: decodeBigIntScalar(context.merkleRootsCount, 'merkleRootsCount', kaId),
    minted: decodeBigIntScalar(context.minted, 'minted', kaId),
    byteSize: decodeBigIntScalar(context.byteSize, 'byteSize', kaId),
    endEpoch: decodeBigIntScalar(context.endEpoch, 'endEpoch', kaId),
    tokenAmount: decodeBigIntScalar(context.tokenAmount, 'tokenAmount', kaId),
    isImmutable: context.isImmutable,
    merkleLeafCount,
  };
}

export class StorageReadMethods extends EVMChainAdapterBase {
  // =====================================================================
  // KC views (V10 DKGKnowledgeAssets + ContextGraphStorage)
  // =====================================================================

  requireKCStorage(): Contract {
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) {
      throw new Error(
        'DKGKnowledgeAssets not deployed in this Hub. ' +
        'V10 KC views require a Hub with DKGKnowledgeAssets registered.',
      );
    }
    return kas;
  }

  async getLatestMerkleRoot(kaId: bigint, options: ChainReadOptions = {}): Promise<Uint8Array> {
    await this.init();
    const kas = this.requireKCStorage();
    const rootHex: string = await this.readContractWithOptions(
      kas,
      'kas.getLatestMerkleRoot',
      'getLatestMerkleRoot',
      [kaId],
      { signal: options.signal },
    );
    return ethers.getBytes(rootHex);
  }

  async getKnowledgeAssetUpdateContext(
    kaId: bigint,
    options: ChainReadOptions = {},
  ): Promise<KnowledgeAssetUpdateContext> {
    await this.init();
    const kas = this.requireKCStorage();
    const rawContext = await this.readContractWithOptions(
      kas,
      'kas.getKnowledgeAssetUpdateContext',
      'getKnowledgeAssetUpdateContext',
      [kaId],
      { signal: options.signal },
    );
    return decodeKnowledgeAssetUpdateContext(rawContext, kaId);
  }

  async getMerkleRootCount(kaId: bigint, options: ChainReadOptions = {}): Promise<bigint> {
    await this.init();
    const kas = this.requireKCStorage();
    const context = await this.readContractWithOptions(
      kas,
      'kas.getKnowledgeAssetUpdateContext',
      'getKnowledgeAssetUpdateContext',
      [kaId],
      { signal: options.signal },
    ) as { merkleRootsCount?: bigint } & readonly unknown[];
    const rawCount = context.merkleRootsCount ?? context[0];
    if (rawCount === undefined) {
      throw new Error(`Missing Merkle-root count for KA ${kaId}`);
    }
    return BigInt(rawCount as string | number | bigint | boolean);
  }

  async getMerkleLeafCount(kaId: bigint): Promise<number> {
    await this.init();
    const kas = this.requireKCStorage();
    const count: bigint = BigInt(await this.readContract(
      kas, 'kas.getMerkleLeafCount', 'getMerkleLeafCount', kaId,
    ));
    return Number(count);
  }

  async getCatalogRoot(kaId: bigint): Promise<Uint8Array> {
    await this.init();
    const kas = this.requireKCStorage();
    const rootHex: string = await this.readContract(
      kas, 'kas.getCatalogRoot', 'getCatalogRoot', kaId,
    );
    return ethers.getBytes(rootHex);
  }

  async getCatalogLeafCount(kaId: bigint): Promise<number> {
    await this.init();
    const kas = this.requireKCStorage();
    const count: bigint = BigInt(await this.readContract(
      kas, 'kas.getCatalogLeafCount', 'getCatalogLeafCount', kaId,
    ));
    return Number(count);
  }

  async getLatestMerkleRootPublisher(
    kaId: bigint,
    options: ChainReadOptions = {},
  ): Promise<string> {
    await this.init();
    const kas = this.requireKCStorage();
    const publisher: string = await this.readContractWithOptions(
      kas,
      'kas.getLatestMerkleRootPublisher',
      'getLatestMerkleRootPublisher',
      [kaId],
      { signal: options.signal },
    );
    return publisher;
  }

  async getLatestMerkleRootAuthor(kaId: bigint): Promise<string> {
    await this.init();
    const kas = this.requireKCStorage();
    const author: string = await this.readContract(
      kas, 'kas.getLatestMerkleRootAuthor', 'getLatestMerkleRootAuthor', kaId,
    );
    return author;
  }
}
