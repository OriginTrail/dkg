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
import {
  decodeKnowledgeAssetMerkleRootCount,
} from './evm-knowledge-asset-update-context.js';

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
    return this.readKnowledgeAssetUpdateContext(kas, kaId, options);
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
    );
    return decodeKnowledgeAssetMerkleRootCount(context, kaId);
  }

  /**
   * GH#2270 PR #2300 r8 — see {@link ChainAdapter.readKnowledgeAssetVersionSnapshot}. Both reads
   * happen inside ONE `readProvider` callback and carry the SAME pinned block number, so the root
   * and the count can never come from endpoints at different heights; an endpoint that cannot
   * produce the pair yields nothing and the whole snapshot moves to the next one.
   */
  async readKnowledgeAssetVersionSnapshot(
    kaId: bigint,
    options: ChainReadOptions = {},
  ): Promise<{ latestRoot: string; rootCount: bigint; blockNumber: number } | null> {
    await this.init();
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) return null;
    try {
      return await this.readProviderRetryingNull(
        'knowledge asset version snapshot',
        async (provider) => {
          const blockNumber = await provider.getBlockNumber();
          if (typeof blockNumber !== 'number') return null;
          const bound = this.rebindContract(kas as Contract, provider);
          const latestRoot: string = await bound.getLatestMerkleRoot(kaId, { blockTag: blockNumber });
          const context = await bound.getKnowledgeAssetUpdateContext(kaId, { blockTag: blockNumber });
          if (!latestRoot) return null;
          return {
            latestRoot,
            rootCount: decodeKnowledgeAssetMerkleRootCount(context, kaId),
            blockNumber,
          };
        },
        { signal: options.signal },
      );
    } catch {
      return null;
    }
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
