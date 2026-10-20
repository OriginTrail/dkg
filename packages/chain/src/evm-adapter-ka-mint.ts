// SPDX-License-Identifier: Apache-2.0

/**
 * Recover a Knowledge Asset mint the node did not observe — a publish whose
 * transaction mined after the node stopped waiting for it.
 *
 * Mixin holder; see evm-adapter.ts for the assembly. It extends
 * PublishMethods to reach the pinned chain-proof snapshot.
 */

import { ethers, type Contract, type JsonRpcProvider } from 'ethers';
import { PublishMethods } from './evm-adapter-publish.js';
import {
  decodeKnowledgeAssetMintReceipt,
  type KnowledgeAssetMintLookupOptions,
  type KnowledgeAssetMintResolution,
} from './knowledge-asset-mint-evidence.js';

/** Newest-first pages scanned for the creation log before reporting it missing. */
const MINT_LOOKUP_MAX_SCAN_PAGES = 1_500;

type MintReceiptContracts = Parameters<typeof decodeKnowledgeAssetMintReceipt>[1];

export class KnowledgeAssetMintMethods extends PublishMethods {
  /**
   * Find and verify the transaction that minted `kaId`.
   *
   * Every fact in a `confirmed` answer comes from one receipt: the asset id,
   * Merkle root, author and TRAC cost from its `KnowledgeAssetCreated` log, and
   * the context graph from its `KnowledgeAssetRegisteredToContextGraph` log.
   * That receipt must then hold the configured finality depth, with its block
   * hash still at its height, read from one endpoint. No other chain state is
   * combined with it. `not-minted` is reported only when the finality-depth
   * block proves the id free, never because no log was found.
   */
  async resolveKnowledgeAssetMint(
    kaId: bigint,
    options: KnowledgeAssetMintLookupOptions = {},
  ): Promise<KnowledgeAssetMintResolution> {
    await this.init();
    const knowledgeAssets = this.contracts.knowledgeAssetStorage;
    const contextGraphStorage = this.contracts.contextGraphStorage;
    if (!knowledgeAssets || !contextGraphStorage) {
      throw new Error('Knowledge Asset mint lookup requires DKGKnowledgeAssets and ContextGraphStorage in this Hub.');
    }
    const contracts: MintReceiptContracts = {
      knowledgeAssets: { address: await knowledgeAssets.getAddress(), interface: knowledgeAssets.interface },
      contextGraphStorage: { address: await contextGraphStorage.getAddress(), interface: contextGraphStorage.interface },
    };

    // A hint only short-circuits a proof. A reverted duplicate send or a
    // mistyped hash falls through to the scan instead of deciding the outcome.
    const hinted = options.txHash === undefined
      ? undefined
      : await this.resolveMintTransaction(options.txHash, kaId, contracts, options);
    if (hinted?.status === 'confirmed') return hinted;

    const author = ethers.getAddress(ethers.toBeHex(kaId >> 96n, 20));
    const snapshot = await this.readFinalizedChainProofSnapshot({ address: author, kaId }, options);
    if (snapshot?.kaMinted === false) {
      return hinted?.status === 'pending' ? hinted : { status: 'not-minted' };
    }

    const outcomes: KnowledgeAssetMintResolution[] = hinted?.status === 'pending' ? [hinted] : [];
    for (const txHash of await this.findMintTransactionHashes(knowledgeAssets, kaId, options)) {
      const outcome = await this.resolveMintTransaction(txHash, kaId, contracts, options);
      if (outcome.status === 'confirmed') return outcome;
      outcomes.push(outcome);
    }
    return outcomes.find((outcome) => outcome.status === 'pending')
      ?? outcomes.find((outcome) => outcome.status === 'rejected')
      ?? { status: 'not-found' };
  }

  /** Transactions that emitted `KnowledgeAssetCreated(kaId)`, from the newest page that has any. */
  private async findMintTransactionHashes(
    knowledgeAssets: Contract,
    kaId: bigint,
    options: KnowledgeAssetMintLookupOptions,
  ): Promise<string[]> {
    const { fromBlock, head, scanProviders } = await this.resolveContractDeployBlock(
      await knowledgeAssets.getAddress(),
      'resolveKnowledgeAssetMint',
      'DKGKnowledgeAssets',
    );
    const pageSize = this.kaHighWaterScanPageSize;
    const filter = knowledgeAssets.filters.KnowledgeAssetCreated(kaId);
    const connected = new Map<JsonRpcProvider, Contract>();
    let preferred: JsonRpcProvider | undefined;
    // Newest first: an unobserved mint is recent, and an id is minted once, so
    // the first page with a hit ends the scan.
    for (let hi = head, pages = 0; hi >= fromBlock && pages < MINT_LOOKUP_MAX_SCAN_PAGES; hi -= pageSize, pages += 1) {
      options.signal?.throwIfAborted();
      const lo = Math.max(fromBlock, hi - pageSize + 1);
      const page = await this.queryEventLogsPage(
        knowledgeAssets, filter, lo, hi, scanProviders, connected,
        'resolveKnowledgeAssetMint KnowledgeAssetCreated', preferred, 'knowledgeAssetMintLookup',
      );
      preferred = page.provider;
      if (page.logs.length > 0) return [...new Set(page.logs.map((log) => log.transactionHash))];
    }
    return [];
  }

  private async resolveMintTransaction(
    txHash: string,
    kaId: bigint,
    contracts: MintReceiptContracts,
    options: KnowledgeAssetMintLookupOptions,
  ): Promise<KnowledgeAssetMintResolution> {
    const receipt = await this.getTransactionReceiptWithFailover(txHash, {
      signal: options.signal,
      logLabel: 'knowledge asset mint receipt',
    });
    if (!receipt) {
      return (await this.getTransactionWithFailover(txHash, options)) ? { status: 'pending' } : { status: 'not-found' };
    }
    if (receipt.status !== 1) return { status: 'rejected', reason: `transaction ${receipt.hash} reverted` };
    const facts = decodeKnowledgeAssetMintReceipt(receipt.logs, contracts, kaId);
    if (typeof facts === 'string') return { status: 'rejected', reason: `transaction ${receipt.hash}: ${facts}` };
    if (!(await this.isReceiptBlockFinalAndCanonical(
      { txHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash },
      options,
    ))) {
      return { status: 'pending' };
    }
    return {
      status: 'confirmed',
      mint: {
        ...facts,
        publisherAddress: ethers.getAddress(receipt.from),
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        txIndex: receipt.index,
        blockTimestamp: await this.getFinalizedBlockTimestamp(receipt.blockNumber, receipt.blockHash, options),
      },
    };
  }
}
