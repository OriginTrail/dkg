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
import { Contract, ethers, type JsonRpcProvider } from 'ethers';
import type {
  ChainReadOptions,
  KnowledgeAssetUpdateContext,
  KnowledgeAssetVersionSnapshot,
} from './chain-adapter.js';
import {
  decodeKnowledgeAssetMerkleRootCount,
} from './evm-knowledge-asset-update-context.js';
import { confirmedStateBlockAtHead } from './evm-adapter-constants.js';
import { isContractViewRetryable } from './rpc-failover-client.js';
import { classifyRpcRetryDisposition } from './evm-adapter-rpc.js';
import { readFirstProviderWithTransientRetry } from './rpc-provider-fallback.js';
import { activeRpcRequestAbortSignal } from './rpc-request-transport.js';
import { withRpcUsageConsumer } from './rpc-usage.js';

/** One in-place retry per endpoint for transient transport blips before fallback. */
const VERSION_SNAPSHOT_TRANSIENT_RETRY_DELAY_MS = 250;

/**
 * The numeric chain id this adapter is configured for, parsed from ids like `evm:31337`. Returns
 * undefined for a configuration that names no numeric chain, where no comparison is possible.
 */
/**
 * r17 (3814893080) / r19 (3816490449) — EXPORTED so every pinned-snapshot reader can perform the
 * same check. `ensureConfiguredStaticChainIdValidated` is a no-op under `staticNetwork: false`,
 * which these readers support, so each reader must compare the endpoint's chain id
 * itself. Sharing the parse is what keeps the two readers from drifting apart again.
 */
export function numericChainIdOf(chainId: string | undefined): bigint | undefined {
  if (!chainId) return undefined;
  const tail = chainId.includes(':') ? chainId.split(':').pop() : chainId;
  if (!tail || !/^[0-9]+$/.test(tail)) return undefined;
  try {
    const numeric = BigInt(tail);
    return numeric > 0n ? numeric : undefined;
  } catch {
    return undefined;
  }
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
   * Read root, count and attribution from one endpoint at one pinned block.
   * Configured RPCs are ordered fallbacks (GH#3098): a complete primary view
   * returns immediately, without requiring unused backups to answer. Currency
   * is relative to that selected endpoint; caller receipt/version floors remain
   * necessary when an endpoint is behind known evidence.
   */
  async readKnowledgeAssetVersionSnapshot(
    kaId: bigint,
    options: ChainReadOptions = {},
  ): Promise<KnowledgeAssetVersionSnapshot | null> {
    if (options.signal?.aborted || activeRpcRequestAbortSignal()?.aborted) return null;
    await this.init();
    if (options.signal?.aborted || activeRpcRequestAbortSignal()?.aborted) return null;
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) return null;
    const knowledgeAssetStorageAddress = this.knowledgeAssetStorageBindingAddress(kas);
    const knowledgeAssetStorageGeneration = this.knowledgeAssetStorageBindingGeneration;
    if (knowledgeAssetStorageAddress === undefined) return null;
    const resolutionAbort = new AbortController();
    const resolutionSignal = options.signal
      ? AbortSignal.any([resolutionAbort.signal, options.signal])
      : resolutionAbort.signal;
    const observeLocalPressure = <T>(read: Promise<T>): Promise<T> => read.catch((error) => {
      // End resolution as soon as shared capacity fails. Waiting for a hung
      // sibling would let its endpoint timeout mask this operation verdict.
      if (classifyRpcRetryDisposition(error) === 'retry-later') resolutionAbort.abort(error);
      throw error;
    });
    const readOne = async (provider: JsonRpcProvider, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (!this.knowledgeAssetStorageBindingIsCurrent(
        kas, knowledgeAssetStorageAddress, knowledgeAssetStorageGeneration,
      )) return null;
      // r15 (3814317260) / r17 (3814893080) — every endpoint must prove it is THIS chain before its
      // view is eligible; a configured wrong-chain RPC must not supply a durable version decision.
      //
      // The shared `ensureConfiguredStaticChainIdValidated` is NOT sufficient here: it returns
      // immediately when no static chain id is configured, which is exactly the supported
      // `staticNetwork: false` mode — so relying on it alone made this check a no-op in the mode
      // most deployments use. The identity is therefore compared explicitly, against the chain id
      // this adapter was configured with, on every endpoint.
      await this.ensureConfiguredStaticChainIdValidated(provider);
      signal?.throwIfAborted();
      const expectedChainId = numericChainIdOf(this.chainId);
      if (expectedChainId !== undefined) {
        const network = await provider.getNetwork();
        if (BigInt(network.chainId) !== expectedChainId) return null;
      }
      signal?.throwIfAborted();
      // Use the same operator-selected confirmation depth as the receipt proof. The receipt block
      // itself is confirmation 1, so finalityConfirmations=1 pins this coherent version view to
      // the current head. Larger values pin head-depth+1. Using the RPC-specific `finalized` tag
      // here made one-block receipt finality ineffective because named-KA recovery still waited
      // many minutes for the endpoint's consensus finality marker to advance.
      // Share confirmation arithmetic with the finality resolver while keeping
      // this endpoint's exact numbered block/hash as the snapshot anchor.
      const head = await withRpcUsageConsumer(
        'getBlock',
        () => provider.getBlock('latest'),
      );
      signal?.throwIfAborted();
      if (head === null || !Number.isSafeInteger(head.number) || head.number < 0) return null;
      const blockNumber = confirmedStateBlockAtHead(
        head.number,
        this.finalityConfirmations,
      );
      if (blockNumber === null) return null;
      const block = blockNumber === head.number
        ? head
        : await withRpcUsageConsumer(
            'getBlock',
            () => provider.getBlock(blockNumber),
          );
      signal?.throwIfAborted();
      if (block === null
        || block.number !== blockNumber
        || typeof block.hash !== 'string'
        || !ethers.isHexString(block.hash, 32)) return null;
      const bound = this.rebindContract(kas as Contract, provider);
      const at = { blockTag: blockNumber };
      // Keep the endpoint deadline active until every tuple read settles. An
      // early failure must not abandon hanging sibling requests beside a new
      // fallback attempt; the existing timeout cancels those physical reads.
      const [rootRead, contextRead, authorRead, publisherRead] = await Promise.allSettled([
        observeLocalPressure(bound.getLatestMerkleRoot(kaId, at) as Promise<string>),
        observeLocalPressure(bound.getKnowledgeAssetUpdateContext(kaId, at)),
        observeLocalPressure(bound.getLatestMerkleRootAuthor(kaId, at) as Promise<string>),
        observeLocalPressure(bound.getLatestMerkleRootPublisher(kaId, at) as Promise<string>),
      ]);
      signal?.throwIfAborted();
      if (rootRead.status === 'rejected') throw rootRead.reason;
      if (contextRead.status === 'rejected') throw contextRead.reason;
      if (authorRead.status === 'rejected') throw authorRead.reason;
      if (publisherRead.status === 'rejected') throw publisherRead.reason;
      const latestRoot = rootRead.value;
      const context = contextRead.value;
      const latestAuthor = authorRead.value;
      const latestPublisher = publisherRead.value;
      if (!latestRoot || !latestAuthor || !latestPublisher) return null;
      if (!this.knowledgeAssetStorageBindingIsCurrent(
        kas,
        knowledgeAssetStorageAddress,
        knowledgeAssetStorageGeneration,
      )) return null;
      return {
        knowledgeAssetId: kaId,
        latestRoot,
        rootCount: decodeKnowledgeAssetMerkleRootCount(context, kaId),
        latestAuthor,
        latestPublisher,
        blockNumber,
        blockHash: block.hash.toLowerCase(),
        knowledgeAssetStorageAddress,
        knowledgeAssetStorageGeneration,
      };
    };
    const view = await readFirstProviderWithTransientRetry(this.providers, readOne, {
      retryDelayMs: VERSION_SNAPSHOT_TRANSIENT_RETRY_DELAY_MS,
      isRetryable: isContractViewRetryable,
      signal: resolutionSignal,
    });
    if (!view || options.signal?.aborted || activeRpcRequestAbortSignal()?.aborted) return null;
    return this.knowledgeAssetStorageBindingIsCurrent(
      kas,
      knowledgeAssetStorageAddress,
      knowledgeAssetStorageGeneration,
    ) ? view : null;
  }

  async knowledgeAssetVersionSnapshotIsCurrent(
    kaId: bigint,
    snapshot: KnowledgeAssetVersionSnapshot,
    options: ChainReadOptions = {},
  ): Promise<boolean> {
    options.signal?.throwIfAborted();
    activeRpcRequestAbortSignal()?.throwIfAborted();
    const snapshotBlockHash = snapshot.blockHash;
    const snapshotStorageAddress = snapshot.knowledgeAssetStorageAddress;
    const snapshotStorageGeneration = snapshot.knowledgeAssetStorageGeneration;
    if (snapshot.knowledgeAssetId !== kaId
      || !Number.isSafeInteger(snapshot.blockNumber)
      || snapshot.blockNumber < 0
      || typeof snapshotBlockHash !== 'string'
      || !ethers.isHexString(snapshotBlockHash, 32)
      || typeof snapshotStorageAddress !== 'string'
      || !ethers.isAddress(snapshotStorageAddress)
      || !Number.isSafeInteger(snapshotStorageGeneration)
      || snapshotStorageGeneration! < 0) return false;

    await this.init();
    options.signal?.throwIfAborted();
    activeRpcRequestAbortSignal()?.throwIfAborted();
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) return false;
    const address = this.knowledgeAssetStorageBindingAddress(kas);
    const generation = this.knowledgeAssetStorageBindingGeneration;
    const expectedAddress = ethers.getAddress(
      snapshotStorageAddress,
    ).toLowerCase();
    if (address !== expectedAddress
      || generation !== snapshotStorageGeneration
      || !this.knowledgeAssetStorageBindingIsCurrent(kas, address, generation)) return false;

    const readOne = async (provider: JsonRpcProvider, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (!this.knowledgeAssetStorageBindingIsCurrent(kas, address, generation)) return null;
      await this.ensureConfiguredStaticChainIdValidated(provider);
      signal?.throwIfAborted();
      const expectedChainId = numericChainIdOf(this.chainId);
      if (expectedChainId !== undefined) {
        const network = await provider.getNetwork();
        if (BigInt(network.chainId) !== expectedChainId) return null;
      }
      signal?.throwIfAborted();
      const head = await withRpcUsageConsumer(
        'getBlock',
        () => provider.getBlock('latest'),
      );
      signal?.throwIfAborted();
      if (head === null || !Number.isSafeInteger(head.number) || head.number < 0) return null;
      const blockNumber = confirmedStateBlockAtHead(
        head.number,
        this.finalityConfirmations,
      );
      if (blockNumber === null) return null;
      const block = blockNumber === head.number
        ? head
        : await withRpcUsageConsumer(
            'getBlock',
            () => provider.getBlock(blockNumber),
          );
      signal?.throwIfAborted();
      if (block === null
        || block.number !== blockNumber
        || typeof block.hash !== 'string'
        || !ethers.isHexString(block.hash, 32)) return null;
      return { blockNumber, blockHash: block.hash.toLowerCase() };
    };
    const view = await readFirstProviderWithTransientRetry(this.providers, readOne, {
      retryDelayMs: VERSION_SNAPSHOT_TRANSIENT_RETRY_DELAY_MS,
      isRetryable: isContractViewRetryable,
      signal: options.signal,
    });
    options.signal?.throwIfAborted();
    activeRpcRequestAbortSignal()?.throwIfAborted();
    if (!view) return false;
    // A usable primary header that differs is a negative verdict, not a reason
    // to search the fallbacks for an endpoint matching an older snapshot.
    return view.blockNumber === snapshot.blockNumber
      && view.blockHash === snapshotBlockHash.toLowerCase()
      && this.knowledgeAssetStorageBindingIsCurrent(kas, address, generation)
      && generation === snapshotStorageGeneration;
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
