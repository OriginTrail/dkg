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
import type { ChainReadOptions } from './chain-adapter.js';

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
