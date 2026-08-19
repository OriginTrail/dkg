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
import type { ChainReadOptions, KnowledgeAssetUpdateContext } from './chain-adapter.js';
import {
  decodeKnowledgeAssetMerkleRootCount,
} from './evm-knowledge-asset-update-context.js';

/**
 * The numeric chain id this adapter is configured for, parsed from ids like `evm:31337`. Returns
 * undefined for a configuration that names no numeric chain, where no comparison is possible.
 */
function numericChainIdOf(chainId: string | undefined): bigint | undefined {
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
   * GH#2270 PR #2300 r8 — see {@link ChainAdapter.readKnowledgeAssetVersionSnapshot}. Both reads
   * happen inside ONE `readProvider` callback and carry the SAME pinned block number, so the root
   * and the count can never come from endpoints at different heights; an endpoint that cannot
   * produce the pair yields nothing and the whole snapshot moves to the next one.
   */
  /**
   * GH#2270 PR #2300 — see {@link ChainAdapter.readKnowledgeAssetVersionSnapshot}.
   *
   * Every read for ONE endpoint happens at the SAME pinned block, so a view can never mix a root
   * with a count, an author or a publisher from a different height — that mixture is what let an
   * old transaction in an A -> B -> A history read as current. And because a healthy endpoint can
   * still be BEHIND, every configured endpoint is asked and the MOST ADVANCED complete view wins
   * (r11): first-success ordering would have re-introduced the same staleness through a different
   * door. An endpoint that cannot produce a complete view simply does not compete.
   */
  async readKnowledgeAssetVersionSnapshot(
    kaId: bigint,
    options: ChainReadOptions = {},
  ): Promise<{
    latestRoot: string;
    rootCount: bigint;
    latestAuthor: string;
    latestPublisher: string;
    blockNumber: number;
  } | null> {
    await this.init();
    const kas = this.contracts.knowledgeAssetStorage;
    if (!kas) return null;
    const readOne = async (provider: JsonRpcProvider) => {
      // r15 (3814317260) / r17 (3814893080) — every endpoint must prove it is THIS chain before its
      // view is eligible, because the poll trusts the most advanced answer and an accidentally
      // configured wrong-chain RPC would otherwise supply the durable version decision.
      //
      // The shared `ensureConfiguredStaticChainIdValidated` is NOT sufficient here: it returns
      // immediately when no static chain id is configured, which is exactly the supported
      // `staticNetwork: false` mode — so relying on it alone made this check a no-op in the mode
      // most deployments use. The identity is therefore compared explicitly, against the chain id
      // this adapter was configured with, on every endpoint.
      await this.ensureConfiguredStaticChainIdValidated(provider);
      const expectedChainId = numericChainIdOf(this.chainId);
      if (expectedChainId !== undefined) {
        const network = await provider.getNetwork();
        if (BigInt(network.chainId) !== expectedChainId) return null;
      }
      if (options.signal?.aborted) return null;
      // r13 (3813796492) — pinned to the FINALIZED block, not the head. This view drives a DURABLE
      // decision: marking a recovered transaction superseded finalizes it receipt-only and hands
      // the lifecycle to another version. Read at the head, an unfinalized update that later
      // reorgs out would strip a transaction that is in fact current of its materialization, with
      // nothing left to re-trigger it. Every other mined verdict in this chain already waits for
      // finality; this is the same rule for the one read that had escaped it.
      const finalized = await provider.getBlock('finalized');
      const blockNumber = finalized?.number;
      if (typeof blockNumber !== 'number') return null;
      const bound = this.rebindContract(kas as Contract, provider);
      const at = { blockTag: blockNumber };
      const [latestRoot, context, latestAuthor, latestPublisher] = await Promise.all([
        bound.getLatestMerkleRoot(kaId, at) as Promise<string>,
        bound.getKnowledgeAssetUpdateContext(kaId, at),
        bound.getLatestMerkleRootAuthor(kaId, at) as Promise<string>,
        bound.getLatestMerkleRootPublisher(kaId, at) as Promise<string>,
      ]);
      if (!latestRoot || !latestAuthor || !latestPublisher) return null;
      return {
        latestRoot,
        rootCount: decodeKnowledgeAssetMerkleRootCount(context, kaId),
        latestAuthor,
        latestPublisher,
        blockNumber,
      };
    };
    // r14 (3814017390) — the cancellation boundary is honoured rather than accepted and ignored:
    // an already-aborted signal never starts the poll, and an abort mid-poll is what the caller
    // gets back. The wider point — that this is a second orchestration path next to the canonical
    // transport — is answered on that thread and queued with the recovery-mixin extraction.
    if (options.signal?.aborted) return null;
    // An abort must COMPLETE the call, not merely be observed after every endpoint has settled:
    // one stalled provider would otherwise hold the caller for as long as it stalls.
    const aborted = options.signal
      ? new Promise<null>((resolve) => {
          options.signal?.addEventListener('abort', () => resolve(null), { once: true });
        })
      : null;
    const poll = Promise.allSettled(this.providers.map(readOne));
    const settled = aborted ? await Promise.race([poll, aborted]) : await poll;
    if (!settled || options.signal?.aborted) return null;
    const views = settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
    // r12 (3813506086) — the poll must be UNANIMOUS. Taking the highest block among the endpoints
    // that happened to answer does not establish currency: the endpoint whose read failed is
    // exactly the one that might have been ahead, so a stale-but-complete view would win and an
    // old transaction would materialize as current. Anything less than every configured endpoint
    // reporting a complete view is "cannot establish", and the caller must defer rather than
    // decide — recovery retries on the next tick, and the operator's by-id clear remains.
    if (views.length !== this.providers.length) return null;
    return views.reduce((best, view) => (view.blockNumber > best.blockNumber ? view : best));
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
