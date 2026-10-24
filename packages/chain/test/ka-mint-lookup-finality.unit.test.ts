/**
 * `resolveKnowledgeAssetMint` confirms a recovered mint only after the
 * production receipt finality gate passes: the endpoint's head must hold the
 * configured confirmation depth above the receipt's block, and the block at
 * that height must still be the receipt's block. The adapter runs its real
 * finality reader here; only the endpoint's head and header are controlled.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { EvmReceiptFinalityReader } from '../src/evm-adapter-receipt-finality.js';

const AUTHOR = ethers.getAddress(`0x${'ab'.repeat(20)}`);
const PUBLISHER = ethers.getAddress(`0x${'cd'.repeat(20)}`);
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const ROOT = ethers.keccak256(ethers.toUtf8Bytes('sealed content'));
const TX_HASH = `0x${'aa'.repeat(32)}`;
const MINT_BLOCK = 100;
const MINT_BLOCK_HASH = `0x${'bb'.repeat(32)}`;
const REORGED_BLOCK_HASH = `0x${'ee'.repeat(32)}`;
const CONFIRMATIONS = 3;
/** The lowest head at which a block-100 receipt has three confirmations. */
const FINAL_HEAD = MINT_BLOCK + CONFIRMATIONS - 1;

/** What the endpoint holds besides its head: the receipt, whether the id is free, and pending transactions. */
interface ChainState {
  receiptStatus?: number;
  /** The scanned creation log belongs to another KA's transaction. */
  receiptMintsKaId?: bigint;
  kaMinted?: boolean;
  pendingTransactions?: string[];
}

function mintLookupAdapter(
  endpoint: { head: number; hashAtMintHeight: string },
  scan: { finds: boolean },
  state: ChainState = {},
) {
  const knowledgeAssets = {
    address: ethers.getAddress(`0x${'11'.repeat(20)}`),
    interface: new ethers.Interface(loadAbi('DKGKnowledgeAssets')),
  };
  const contextGraphStorage = {
    address: ethers.getAddress(`0x${'22'.repeat(20)}`),
    interface: new ethers.Interface(loadAbi('ContextGraphStorage')),
  };
  const receipt = {
    hash: TX_HASH,
    status: state.receiptStatus ?? 1,
    blockNumber: MINT_BLOCK,
    blockHash: MINT_BLOCK_HASH,
    index: 4,
    from: PUBLISHER,
    logs: [
      {
        address: knowledgeAssets.address,
        ...knowledgeAssets.interface.encodeEventLog('KnowledgeAssetCreated', [
          state.receiptMintsKaId ?? KA_ID, AUTHOR, 'op', ROOT, 256n, 1n, 3n, 42n, false,
        ]),
      },
      {
        address: contextGraphStorage.address,
        ...contextGraphStorage.interface.encodeEventLog('KnowledgeAssetRegisteredToContextGraph', [35n, state.receiptMintsKaId ?? KA_ID]),
      },
    ],
  };
  const provider = {
    getBlockNumber: vi.fn(async () => endpoint.head),
    getBlock: vi.fn(async (height: number) => (height <= endpoint.head
      ? { number: height, hash: height === MINT_BLOCK ? endpoint.hashAtMintHeight : ethers.ZeroHash, timestamp: 1_700_000_000 }
      : null)),
  };
  const queryEventLogsPage = vi.fn(async () => ({ logs: scan.finds ? [{ transactionHash: TX_HASH }] : [], provider: undefined }));
  const chain = Object.assign(Object.create(EVMChainAdapter.prototype) as EVMChainAdapter, {
    init: vi.fn(async () => undefined),
    finalityConfirmations: CONFIRMATIONS,
    kaHighWaterScanPageSize: 2_000,
    contracts: {
      knowledgeAssetStorage: {
        getAddress: async () => knowledgeAssets.address,
        interface: knowledgeAssets.interface,
        filters: { KnowledgeAssetCreated: (kaId: bigint) => ({ kaId }) },
      },
      contextGraphStorage: {
        getAddress: async () => contextGraphStorage.address,
        interface: contextGraphStorage.interface,
      },
    },
    getTransactionReceiptWithFailover: vi.fn(async (hash: string) => (hash === TX_HASH ? receipt : null)),
    getTransactionWithFailover: vi.fn(async (hash: string) => (state.pendingTransactions?.includes(hash) ? { hash } : null)),
    readFinalizedChainProofSnapshot: vi.fn(async () => ({ kaMinted: state.kaMinted ?? true })),
    resolveContractDeployBlock: vi.fn(async () => ({ fromBlock: 0, head: 1_000, scanProviders: [] })),
    queryEventLogsPage,
    readProviderRetryingNull: vi.fn(async (_label: string, read: (p: typeof provider) => Promise<unknown>) => read(provider)),
  });
  const internals = chain as unknown as {
    receiptFinality: EvmReceiptFinalityReader;
    readProviderRetryingNull: ConstructorParameters<typeof EvmReceiptFinalityReader>[1];
  };
  internals.receiptFinality = new EvmReceiptFinalityReader(
    CONFIRMATIONS,
    (...args) => internals.readProviderRetryingNull(...args),
  );
  return { chain, provider, queryEventLogsPage };
}

const confirmed = {
  status: 'confirmed',
  mint: {
    kaId: KA_ID,
    merkleRoot: ethers.getBytes(ROOT),
    contextGraphId: 35n,
    authorAddress: AUTHOR,
    publisherAddress: PUBLISHER,
    tokenAmount: 42n,
    knowledgeAssetsContract: ethers.getAddress(`0x${'11'.repeat(20)}`),
    txHash: TX_HASH,
    blockNumber: MINT_BLOCK,
    blockHash: MINT_BLOCK_HASH,
    txIndex: 4,
    blockTimestamp: 1_700_000_000,
  },
};

describe('resolveKnowledgeAssetMint holds a recovered receipt to the production finality gate', () => {
  describe.each([
    ['scanned', { finds: true }, undefined],
    ['hinted', { finds: false }, TX_HASH],
  ] as const)('a %s mint receipt', (_lookup, scan, txHash) => {
    it('stays pending below the configured confirmation depth', async () => {
      const { chain } = mintLookupAdapter({ head: FINAL_HEAD - 1, hashAtMintHeight: MINT_BLOCK_HASH }, scan);

      await expect(chain.resolveKnowledgeAssetMint(KA_ID, { txHash })).resolves.toEqual({ status: 'pending' });
    });

    it('stays pending when another block now occupies the receipt height', async () => {
      const { chain } = mintLookupAdapter({ head: FINAL_HEAD + 10, hashAtMintHeight: REORGED_BLOCK_HASH }, scan);

      await expect(chain.resolveKnowledgeAssetMint(KA_ID, { txHash })).resolves.toEqual({ status: 'pending' });
    });

    it('confirms from the one receipt once its block is final and canonical', async () => {
      const { chain, provider } = mintLookupAdapter({ head: FINAL_HEAD, hashAtMintHeight: MINT_BLOCK_HASH }, scan);

      await expect(chain.resolveKnowledgeAssetMint(KA_ID, { txHash })).resolves.toEqual(confirmed);
      expect(provider.getBlock).toHaveBeenCalledWith(MINT_BLOCK);
    });
  });

  it('confirms a hinted receipt without scanning for the creation log', async () => {
    const { chain, queryEventLogsPage } = mintLookupAdapter({ head: FINAL_HEAD, hashAtMintHeight: MINT_BLOCK_HASH }, { finds: true });

    await expect(chain.resolveKnowledgeAssetMint(KA_ID, { txHash: TX_HASH })).resolves.toEqual(confirmed);
    expect(queryEventLogsPage).not.toHaveBeenCalled();
  });
});

describe('resolveKnowledgeAssetMint without a final mint receipt', () => {
  const finalEndpoint = { head: FINAL_HEAD, hashAtMintHeight: MINT_BLOCK_HASH };
  const PENDING_TX = `0x${'cc'.repeat(32)}`;

  it('reports not-minted only when the finality-depth block proves the id free', async () => {
    const { chain, queryEventLogsPage } = mintLookupAdapter(finalEndpoint, { finds: false }, { kaMinted: false });

    await expect(chain.resolveKnowledgeAssetMint(KA_ID)).resolves.toEqual({ status: 'not-minted' });
    await expect(chain.resolveKnowledgeAssetMint(KA_ID, { txHash: PENDING_TX })).resolves.toEqual({ status: 'not-minted' });
    // A hinted transaction still in the mempool keeps the answer pending.
    const pending = mintLookupAdapter(finalEndpoint, { finds: false }, { kaMinted: false, pendingTransactions: [PENDING_TX] });
    await expect(pending.chain.resolveKnowledgeAssetMint(KA_ID, { txHash: PENDING_TX })).resolves.toEqual({ status: 'pending' });
    expect(queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('reports not-found when no creation log or receipt is recovered', async () => {
    const { chain } = mintLookupAdapter(finalEndpoint, { finds: false });

    await expect(chain.resolveKnowledgeAssetMint(KA_ID)).resolves.toEqual({ status: 'not-found' });
    await expect(chain.resolveKnowledgeAssetMint(KA_ID, { txHash: PENDING_TX })).resolves.toEqual({ status: 'not-found' });
  });

  it('rejects a reverted receipt and a receipt that minted another id', async () => {
    const reverted = mintLookupAdapter(finalEndpoint, { finds: true }, { receiptStatus: 0 });
    await expect(reverted.chain.resolveKnowledgeAssetMint(KA_ID))
      .resolves.toEqual({ status: 'rejected', reason: `transaction ${TX_HASH} reverted` });

    const other = mintLookupAdapter(finalEndpoint, { finds: true }, { receiptMintsKaId: KA_ID + 1n });
    await expect(other.chain.resolveKnowledgeAssetMint(KA_ID))
      .resolves.toMatchObject({ status: 'rejected', reason: expect.stringContaining(TX_HASH) });
  });

  it('requires the knowledge asset and context graph storage contracts', async () => {
    const { chain } = mintLookupAdapter(finalEndpoint, { finds: true });
    (chain as unknown as { contracts: Record<string, unknown> }).contracts = {};

    await expect(chain.resolveKnowledgeAssetMint(KA_ID)).rejects.toThrow(/requires DKGKnowledgeAssets and ContextGraphStorage/);
  });
});
