import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { PublishMethods } from '../src/evm-adapter-publish.js';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { StorageReadMethods } from '../src/evm-adapter-storage-reads.js';
import { EvmReceiptFinalityReader } from '../src/evm-adapter-receipt-finality.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MockChainAdapter, AdoptExistingMintRefusalError } from '../src/index.js';

const KA_ID = 42n;
const CG_ID = 7n;
const ROOT = `0x${'ab'.repeat(32)}`;
const HASH = `0x${'cd'.repeat(32)}`;
const BLOCK_HASH = `0x${'ef'.repeat(32)}`;
const ADDRESS = '0x1111111111111111111111111111111111111111';

function fixture(finalityConfirmations = 1) {
  const storageInterface = new ethers.Interface(loadAbi('DKGKnowledgeAssets'));
  const roots = [{ publisher: ADDRESS, merkleRoot: ROOT, timestamp: 100n }];
  const log = {
    args: { id: KA_ID, merkleRoot: ROOT, author: ADDRESS },
    transactionHash: HASH, blockNumber: 10, blockHash: BLOCK_HASH, transactionIndex: 2,
  };
  const storage = { target: ADDRESS, interface: storageInterface,
    filters: { KnowledgeAssetCreated: vi.fn(() => ({})) } };
  const receipt = { txHash: HASH, blockNumber: 10, blockHash: BLOCK_HASH, txIndex: 2, blockTimestamp: 100,
    batchId: KA_ID, kaId: KA_ID, startKAId: KA_ID, endKAId: KA_ID,
    merkleRoot: ethers.getBytes(ROOT), publisherAddress: ADDRESS,
    authorAddress: '0x2222222222222222222222222222222222222222', knowledgeAssetsContract: ADDRESS, tokenAmount: 100n };
  const rawReceipt = { hash: HASH, status: 1, blockNumber: 10, blockHash: BLOCK_HASH, index: 2 };
  const graphStorage = { target: '0x3333333333333333333333333333333333333333' };
  const bindings = new Map([[KA_ID, CG_ID], [KA_ID + 1n, CG_ID + 1n]]);
  const readContract = vi.fn(async (contract: unknown, label: string, method: string, id: bigint) => {
    if (contract === storage && label === 'kas.getMerkleRoots' && method === 'getMerkleRoots' && id === KA_ID) return roots;
    if (contract === graphStorage && label === 'cgStorage.kaToContextGraph' && method === 'kaToContextGraph' && bindings.has(id)) return bindings.get(id)!;
    throw new Error(`Unexpected contract read: ${label}/${method}/${id}`);
  });
  const queryEventLogsPage = vi.fn(async (..._args: unknown[]) => ({ logs: [log] }));
  const readPublishReceipt = vi.fn(async () => ({ receipt: rawReceipt, publish: receipt }));
  const provider = { getBlockNumber: vi.fn(async () => 10),
    getBlock: vi.fn(async (number: number) => ({ number, hash: BLOCK_HASH })) };
  const finalityProviderRead = vi.fn(async (_label, read) => read(provider));
  const chain = Object.assign(Object.create(PublishMethods.prototype), {
    init: vi.fn(async () => undefined),
    contracts: { knowledgeAssetStorage: storage, contextGraphStorage: graphStorage },
    knowledgeAssetStorageBindingGeneration: 1, hubBindingGeneration: 1,
    readContract, queryEventLogsPage, readPublishReceipt,
    readKnowledgeAssetVersionSnapshot: vi.fn(async () => ({ knowledgeAssetId: KA_ID, latestRoot: ROOT, rootCount: BigInt(roots.length), latestAuthor: receipt.authorAddress, latestPublisher: ADDRESS, blockNumber: receipt.blockNumber, blockHash: BLOCK_HASH, knowledgeAssetStorageAddress: ADDRESS, knowledgeAssetStorageGeneration: 1 })),
    knowledgeAssetVersionSnapshotIsCurrent: vi.fn(async () => true),
    getTransactionWithFailover: vi.fn(async () => null),
    receiptFinality: new EvmReceiptFinalityReader(finalityConfirmations, finalityProviderRead),
    resolveKaStorageDeployBlock: vi.fn(async () => ({ fromBlock: 1, head: 10, scanProviders: [] })),
    getBlockTimestamp: vi.fn(async (_block: number) => 100),
  }) as PublishMethods;
  return { chain, roots, log, receipt, rawReceipt, queryEventLogsPage, readPublishReceipt, readContract, graphStorage, bindings,
    provider, finalityProviderRead };
}

function longHistoryFixture() {
  const f = fixture();
  const mintBlock = 5_000;
  f.roots[0].timestamp = BigInt(mintBlock * 12);
  f.log.blockNumber = mintBlock;
  f.rawReceipt.blockNumber = mintBlock;
  f.receipt.blockNumber = mintBlock;
  f.provider.getBlockNumber.mockResolvedValue(10_000);
  Reflect.get(f.chain, 'resolveKaStorageDeployBlock').mockResolvedValue({ fromBlock: 1, head: 10_000, scanProviders: [] });
  Reflect.get(f.chain, 'getBlockTimestamp').mockImplementation(async (block: number) => block * 12);
  f.queryEventLogsPage.mockImplementation(async (...args) => ({
    logs: Number(args[2]) <= mintBlock && Number(args[3]) >= mintBlock ? [f.log] : [],
  }));
  return f;
}

/** Keep the real constructor/initContracts; only its external reads are controlled. */
function coldAssembledFixture() {
  const f = fixture();
  const chain = new EVMChainAdapter({ rpcUrl: 'http://127.0.0.1:59998',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337', staticNetwork: false });
  const readContract = vi.fn(async (contract: ethers.Contract, label: string, method: string, id: string | bigint) => {
    if (method === 'getContractAddress' || method === 'getAssetStorageAddress') {
      return id === 'Token' ? ethers.ZeroAddress
        : id === 'ContextGraphStorage' ? f.graphStorage.target : ADDRESS;
    }
    if (contract.target === ADDRESS && label === 'kas.getMerkleRoots' && method === 'getMerkleRoots' && id === KA_ID) return f.roots;
    if (contract.target === f.graphStorage.target && label === 'cgStorage.kaToContextGraph' && method === 'kaToContextGraph' && id === KA_ID) return CG_ID;
    throw new Error(`Unexpected cold contract read: ${label}/${method}/${id}`);
  });
  for (const name of ['queryEventLogsPage', 'readPublishReceipt', 'getTransactionWithFailover',
    'receiptFinality', 'resolveKaStorageDeployBlock', 'getBlockTimestamp',
    'knowledgeAssetVersionSnapshotIsCurrent'] as const) {
    Reflect.set(chain, name, Reflect.get(f.chain, name));
  }
  Reflect.set(chain, 'readContract', readContract);
  Reflect.set(chain, 'startHubRotationListener', vi.fn(async () => undefined));
  Reflect.set(chain, 'readKnowledgeAssetVersionSnapshot', vi.fn(async () => ({
    knowledgeAssetId: KA_ID, latestRoot: ROOT, rootCount: 1n,
    latestAuthor: f.receipt.authorAddress, latestPublisher: ADDRESS,
    blockNumber: f.receipt.blockNumber, blockHash: BLOCK_HASH,
    knowledgeAssetStorageAddress: ADDRESS,
    knowledgeAssetStorageGeneration: Reflect.get(chain, 'knowledgeAssetStorageBindingGeneration'),
  })));
  return { ...f, chain, readContract };
}

describe('existing mint provenance', () => {
  it('requires coherent read methods on the concrete assembled adapter', () => {
    // This assignment also checks the public adapter's required type contract.
    const assembled: Pick<StorageReadMethods, 'readKnowledgeAssetVersionSnapshot' | 'knowledgeAssetVersionSnapshotIsCurrent'>
      = Object.create(EVMChainAdapter.prototype) as EVMChainAdapter;
    expect(assembled.readKnowledgeAssetVersionSnapshot).toBe(StorageReadMethods.prototype.readKnowledgeAssetVersionSnapshot);
    expect(assembled.knowledgeAssetVersionSnapshotIsCurrent).toBe(StorageReadMethods.prototype.knowledgeAssetVersionSnapshotIsCurrent);
  });

  it.each(['readKnowledgeAssetVersionSnapshot', 'knowledgeAssetVersionSnapshotIsCurrent'] as const)(
    'refuses an incomplete holder without %s before starting provenance I/O', async missing => {
      const f = fixture();
      Reflect.set(f.chain, missing, undefined);
      await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
      expect(Reflect.get(f.chain, 'readContract')).not.toHaveBeenCalled();
      expect(f.queryEventLogsPage).not.toHaveBeenCalled();
      expect(f.readPublishReceipt).not.toHaveBeenCalled();
      expect(Reflect.get(f.chain, 'init')).not.toHaveBeenCalled();
    },
  );

  it('recovers an existing mint on the first public read of a cold assembled adapter', async () => {
    const f = coldAssembledFixture();
    try {
      expect(Reflect.get(f.chain, 'initialized')).toBe(false);
      expect(Reflect.get(f.chain, 'contracts').knowledgeAssetStorage).toBeUndefined();
      expect(Reflect.get(f.chain, 'contracts').contextGraphStorage).toBeUndefined();
      await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
        .resolves.toEqual(f.receipt);
      expect(Reflect.get(f.chain, 'initialized')).toBe(true);
      const hubReads = f.readContract.mock.calls.filter(([, , method]) => method === 'getAssetStorageAddress');
      expect(hubReads.map(([, , , name]) => name)).toContain('DKGKnowledgeAssets');
      expect(hubReads.map(([, , , name]) => name)).toContain('ContextGraphStorage');
      const storage = Reflect.get(f.chain, 'contracts').knowledgeAssetStorage;
      expect(f.readContract).toHaveBeenCalledWith(storage, 'kas.getMerkleRoots', 'getMerkleRoots', KA_ID);
      await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
        .resolves.toEqual(f.receipt);
      expect(f.readContract.mock.calls.filter(([, , method]) => method === 'getAssetStorageAddress'))
        .toHaveLength(hubReads.length);
    } finally { f.chain.destroy(); }
  });

  it('propagates cold initialization failure without reading provenance from incomplete bindings', async () => {
    const f = coldAssembledFixture();
    const error = new Error('Hub configuration unavailable');
    f.readContract.mockRejectedValue(error);
    try {
      await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
        .rejects.toBe(error);
      expect(Reflect.get(f.chain, 'initialized')).toBe(false);
      expect(f.queryEventLogsPage).not.toHaveBeenCalled();
      expect(f.readPublishReceipt).not.toHaveBeenCalled();
    } finally { f.chain.destroy(); }
  });

  it('recovers the actual transaction only after verifying root, graph and receipt finality', async () => {
    const f = fixture();
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toEqual(f.receipt);
    expect(f.readPublishReceipt).toHaveBeenCalledWith(HASH, {
      expectedBlockNumber: 10, expectedBlockHash: BLOCK_HASH,
    }, 'canonical finalization receipt');
    expect(f.provider.getBlock).toHaveBeenCalledWith(10);
    expect(f.readContract).toHaveBeenCalledWith(f.graphStorage, 'cgStorage.kaToContextGraph', 'kaToContextGraph', KA_ID);
  });

  it('refuses the requested asset bound to another graph even when the adjacent asset matches', async () => {
    const f = fixture();
    f.bindings.set(KA_ID, CG_ID + 1n);
    f.bindings.set(KA_ID + 1n, CG_ID);
    const adoption = f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID);
    await expect(adoption).rejects.toMatchObject({ code: 'KA_CG_MISMATCH' });
    expect(f.readContract).toHaveBeenCalledWith(f.graphStorage, 'cgStorage.kaToContextGraph', 'kaToContextGraph', KA_ID);
    expect(f.readContract.mock.calls.filter(([, , method]) => method === 'kaToContextGraph').map(([, , , id]) => id))
      .toEqual([KA_ID]);
    expect(f.queryEventLogsPage).not.toHaveBeenCalled();
    expect(f.readPublishReceipt).not.toHaveBeenCalled();
  });

  it('projects definite canonical identity and ordering while retaining parsed costs and storage provenance', async () => {
    const f = fixture();
    Reflect.set(f.receipt, 'kaId', undefined); Reflect.set(f.receipt, 'startKAId', undefined);
    Reflect.set(f.receipt, 'endKAId', undefined); Reflect.set(f.receipt, 'txIndex', undefined);
    const costs = { gasUsed: 100n, effectiveGasPrice: 5n, gasCostWei: 500n, tokenAmount: 123n,
      convictionCostCovered: { accountId: 7n, epoch: 2, baseCost: 20n, discountedCost: 10n,
        drawnFromEpoch: 8n, drawnFromTopUp: 2n } };
    Object.assign(f.receipt, costs, { publisherAddress: '0x3333333333333333333333333333333333333333', blockTimestamp: 999 });
    const adopted = await f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID);
    expect(adopted).toMatchObject({ ...costs, kaId: KA_ID, startKAId: KA_ID, endKAId: KA_ID,
      txIndex: 2, blockHash: BLOCK_HASH, txHash: HASH, blockTimestamp: 100, publisherAddress: ADDRESS });
  });

  it.each([undefined, -1n, '100'])('refuses adoption without an original confirmed bigint cost (%s)', async cost => {
    const f = fixture();
    Reflect.set(f.receipt, 'tokenAmount', cost);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toBeNull();
  });

  it('retains a confirmed historical zero cost without substituting a current quote', async () => {
    const f = fixture();
    f.receipt.tokenAmount = 0n;
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toMatchObject({ txHash: HASH, tokenAmount: 0n });
  });

  it('retains the same strict canonical facts and original cost in a successful mock adoption', async () => {
    const mock = new MockChainAdapter('mock:31337'); mock.minimumRequiredSignatures = 0;
    const root = ethers.getBytes(ROOT);
    const created = await mock.createKnowledgeAssets({ publishOperationId: 'strict-adoption', contextGraphId: CG_ID,
      merkleRoot: root, knowledgeAssetsAmount: 1, byteSize: 1n, epochs: 1, tokenAmount: 100n, isImmutable: false,
      merkleLeafCount: 1, publisherNodeIdentityId: 1n, author: { address: ADDRESS,
        signature: { r: new Uint8Array(32), vs: new Uint8Array(32) }, schemeVersion: 1 }, ackSignatures: [] });
    const canonical = await mock.resolveCanonicalFinalizationReceipt(created.txHash);
    if (canonical.status !== 'confirmed') throw new Error('Expected canonical mock receipt');
    const legacy = await mock.resolvePublishByTxHash(created.txHash);
    if (!legacy) throw new Error('Expected parsed mock publish');
    vi.spyOn(mock, 'resolvePublishByTxHash').mockResolvedValueOnce(legacy).mockResolvedValueOnce({ ...legacy,
      txIndex: undefined, kaId: undefined, startKAId: undefined, endKAId: undefined, merkleRoot: undefined, gasCostWei: 500n });
    // Lifetime extensions can change current storage costs without a new root.
    mock.getCollection(created.batchId)!.updateContext.tokenAmount = 999n;
    const adopted = await mock.getMintedKnowledgeAssetProvenance(created.batchId, root, CG_ID);
    expect(adopted).toMatchObject({ ...canonical.receipt, blockTimestamp: legacy.blockTimestamp,
      gasCostWei: 500n, tokenAmount: 100n });
  });

  it.each([
    ['a different sealed root', `0x${'01'.repeat(32)}`, CG_ID, 'KA_ID_COLLISION'],
    ['a different graph', ROOT, CG_ID + 1n, 'KA_CG_MISMATCH'],
  ])('refuses %s before scanning provenance', async (_name, root, graph, code) => {
    const f = fixture();
    const adoption = f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(root), graph);
    await expect(adoption).rejects.toBeInstanceOf(AdoptExistingMintRefusalError);
    await expect(adoption).rejects.toMatchObject({ code });
    expect(f.queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('refuses an updated asset instead of finalizing its superseded version', async () => {
    const f = fixture();
    f.roots.push({ ...f.roots[0] });
    const adoption = f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID);
    await expect(adoption).rejects.toBeInstanceOf(AdoptExistingMintRefusalError);
    await expect(adoption).rejects.toMatchObject({ code: 'KA_SUPERSEDED' });
  });

  it.each(['roots', 'graph binding'] as const)('leaves a lagging read without %s unavailable, then adopts once current', async (missing) => {
    const f = fixture();
    const [root] = f.roots;
    if (missing === 'roots') f.roots.length = 0; else f.bindings.set(KA_ID, 0n);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
    expect(f.queryEventLogsPage).not.toHaveBeenCalled();
    f.roots.splice(0, f.roots.length, root);
    f.bindings.set(KA_ID, CG_ID);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toMatchObject({ txHash: HASH, kaId: KA_ID });
  });

  it('keeps root collision before superseded before graph mismatch refusals', async () => {
    const f = fixture();
    f.roots.push({ ...f.roots[0] });
    const collision = f.chain.getMintedKnowledgeAssetProvenance(KA_ID, new Uint8Array(32), CG_ID + 1n);
    await expect(collision).rejects.toMatchObject({ code: 'KA_ID_COLLISION' });
    const superseded = f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID + 1n);
    await expect(superseded).rejects.toMatchObject({ code: 'KA_SUPERSEDED' });
    expect(f.queryEventLogsPage).not.toHaveBeenCalled();
  });

  it('refreshes coherent current-version evidence after held receipt recovery', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.readPublishReceipt.mockImplementation(async () => {
      entered();
      await held;
      return { receipt: f.rawReceipt, publish: f.receipt };
    });
    const readCurrent = Reflect.get(f.chain, 'readKnowledgeAssetVersionSnapshot');
    const adoption = f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID);
    await started;
    // The unpinned roots read stays at mint v1 while the finalized view sees v2.
    readCurrent.mockResolvedValue({ knowledgeAssetId: KA_ID, latestRoot: ROOT,
      rootCount: 2n, latestAuthor: f.receipt.authorAddress, latestPublisher: ADDRESS,
      blockNumber: 11, blockHash: BLOCK_HASH,
      knowledgeAssetStorageAddress: ADDRESS, knowledgeAssetStorageGeneration: 1 });
    const refusal = expect(adoption).rejects.toMatchObject({ code: 'KA_SUPERSEDED' });
    release();
    await refusal;
    expect(readCurrent).toHaveBeenCalledWith(KA_ID);
  });

  it.each(['unavailable', 'read failure', 'lost lease', 'lease failure', 'missing reader', 'missing lease', 'wrong identity', 'older than mint', 'empty current version', 'different publisher', 'different author'])(
    'does not adopt when refreshed evidence is %s', async condition => {
      const f = fixture();
      const readCurrent = Reflect.get(f.chain, 'readKnowledgeAssetVersionSnapshot');
      const lease = Reflect.get(f.chain, 'knowledgeAssetVersionSnapshotIsCurrent');
      if (condition === 'unavailable') readCurrent.mockResolvedValue(null);
      else if (condition === 'read failure') readCurrent.mockRejectedValue(new Error('RPC unavailable'));
      else if (condition === 'lost lease') lease.mockResolvedValue(false);
      else if (condition === 'lease failure') lease.mockRejectedValue(new Error('lease RPC unavailable'));
      else if (condition === 'missing reader') Reflect.set(f.chain, 'readKnowledgeAssetVersionSnapshot', undefined);
      else if (condition === 'missing lease') Reflect.set(f.chain, 'knowledgeAssetVersionSnapshotIsCurrent', undefined);
      else {
        const snapshot = await readCurrent();
        readCurrent.mockResolvedValue({ ...snapshot,
          ...(condition === 'wrong identity' ? { knowledgeAssetId: KA_ID + 1n }
            : condition === 'empty current version' ? { rootCount: 0n }
            : condition === 'different publisher' ? { latestPublisher: '0x3333333333333333333333333333333333333333' }
            : condition === 'different author' ? { latestAuthor: '0x3333333333333333333333333333333333333333' }
            : { blockNumber: 9 }) });
      }
      await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
        .resolves.toBeNull();
    },
  );

  it.each(['replacement address', 'same address new handle', 'ABA generation', 'graph binding only'] as const)(
    'does not join retired receipt evidence to a fresh %s observation', async rotation => {
      const f = fixture();
      const contracts = Reflect.get(f.chain, 'contracts');
      const originalStorage = contracts.knowledgeAssetStorage;
      const replacementAddress = '0x3333333333333333333333333333333333333333';
      const snapshot = await Reflect.get(f.chain, 'readKnowledgeAssetVersionSnapshot')();
      const lease = Reflect.get(f.chain, 'knowledgeAssetVersionSnapshotIsCurrent');
      lease.mockResolvedValue(true); // B's own lease is valid, so it cannot fence A's receipt.
      // The first graph check belongs to A; rotate only after receipt recovery.
      const initialGraph = contracts.contextGraphStorage;
      expect(initialGraph).toBe(f.graphStorage); // The strict fixture owns the initial binding.
      // Replacement handles are deliberately absent from the fixture, so an
      // observation on a different contract cannot borrow A's graph response.
      Reflect.get(f.chain, 'readKnowledgeAssetVersionSnapshot').mockImplementation(async () => {
        expect(f.readPublishReceipt).toHaveBeenCalledTimes(1);
        if (rotation !== 'graph binding only') {
          contracts.knowledgeAssetStorage = rotation === 'ABA generation' ? originalStorage : {
            ...originalStorage, target: rotation === 'replacement address' ? replacementAddress : ADDRESS,
          };
          Reflect.set(f.chain, 'knowledgeAssetStorageBindingGeneration', rotation === 'ABA generation' ? 3 : 2);
        }
        contracts.contextGraphStorage = {};
        Reflect.set(f.chain, 'hubBindingGeneration', rotation === 'ABA generation' ? 3 : 2);
        return { ...snapshot, knowledgeAssetStorageAddress: rotation === 'replacement address' ? replacementAddress : ADDRESS,
          knowledgeAssetStorageGeneration: Reflect.get(f.chain, 'knowledgeAssetStorageBindingGeneration') };
      });
      await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
      expect(f.readPublishReceipt).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['storage ABA', 'graph registry'] as const)('fences a %s rotation after the lease answer but before resumption', async rotation => {
    const f = fixture();
    const contracts = Reflect.get(f.chain, 'contracts');
    Reflect.get(f.chain, 'knowledgeAssetVersionSnapshotIsCurrent').mockImplementation(() => {
      const provedCurrent = Promise.resolve(true);
      queueMicrotask(() => {
        if (rotation === 'storage ABA') Reflect.set(f.chain, 'knowledgeAssetStorageBindingGeneration', 3);
        else contracts.contextGraphStorage = {};
        Reflect.set(f.chain, 'hubBindingGeneration', 3);
      });
      return provedCurrent;
    });
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
    expect(Reflect.get(f.chain, 'knowledgeAssetVersionSnapshotIsCurrent')).toHaveBeenCalledTimes(1);
  });

  it.each(['storage address', 'binding generation'] as const)('requires the refreshed snapshot to carry the original %s', async mismatch => {
    const f = fixture();
    const readCurrent = Reflect.get(f.chain, 'readKnowledgeAssetVersionSnapshot');
    const snapshot = await readCurrent();
    readCurrent.mockResolvedValue({ ...snapshot, ...(mismatch === 'storage address'
      ? { knowledgeAssetStorageAddress: '0x3333333333333333333333333333333333333333' }
      : { knowledgeAssetStorageGeneration: 2 }) });
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
    expect(Reflect.get(f.chain, 'knowledgeAssetVersionSnapshotIsCurrent')).not.toHaveBeenCalled();
  });

  it('retains storage publisher provenance when the receipt records another recipient', async () => {
    const f = fixture();
    f.receipt.publisherAddress = '0x3333333333333333333333333333333333333333';
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toEqual({ ...f.receipt, publisherAddress: ADDRESS });
  });

  it('refuses a refreshed current root that no longer matches the seal', async () => {
    const f = fixture();
    const readCurrent = Reflect.get(f.chain, 'readKnowledgeAssetVersionSnapshot');
    readCurrent.mockResolvedValue({ ...await readCurrent(), latestRoot: `0x${'01'.repeat(32)}` });
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .rejects.toMatchObject({ code: 'KA_ID_COLLISION' });
  });

  it('leaves an unrecoverable event without synthesized provenance', async () => {
    const f = fixture();
    f.queryEventLogsPage.mockResolvedValue({ logs: [] });
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toBeNull();
  });

  it('requires the graph storage capability to prove binding', async () => {
    const f = fixture();
    Reflect.get(f.chain, 'contracts').contextGraphStorage = undefined;
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toBeNull();
  });

  it.each(['pending', 'not-found', 'reorged', 'rejected'] as const)('does not adopt a %s receipt', async (status) => {
    const f = fixture();
    if (status === 'pending' || status === 'not-found') {
      f.readPublishReceipt.mockResolvedValue({ receipt: null, publish: null } as never);
      Reflect.get(f.chain, 'getTransactionWithFailover').mockResolvedValue(status === 'pending' ? {} : null);
    } else if (status === 'rejected') f.rawReceipt.status = 0;
    else f.rawReceipt.blockHash = `0x${'01'.repeat(32)}`;
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toBeNull();
  });

  it('holds a matching head mint below the configured confirmation depth', async () => {
    const f = fixture(12);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
    expect(f.provider.getBlockNumber).toHaveBeenCalledOnce();
    f.provider.getBlockNumber.mockResolvedValue(21);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toEqual(f.receipt);
  });

  it('holds a matching receipt whose block hash no longer occupies its height', async () => {
    const f = fixture();
    f.provider.getBlock.mockResolvedValue({ number: 10, hash: `0x${'01'.repeat(32)}` });
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
  });

  it('finds a mid-history mint using block timestamps and a range-aware event read', async () => {
    const f = longHistoryFixture();
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID))
      .resolves.toMatchObject({ txHash: HASH, blockNumber: 5_000, blockTimestamp: 60_000 });
    expect(f.queryEventLogsPage.mock.calls[0].slice(2, 4)).toEqual([4_872, 5_128]);
  });

  it('cannot recover from a wrong head-only scan window', async () => {
    const f = longHistoryFixture();
    Reflect.get(f.chain, 'getBlockTimestamp').mockResolvedValue(0);
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
    expect(f.queryEventLogsPage.mock.calls[0].slice(2, 4)).toEqual([9_872, 10_000]);
  });

  it.each(['merkleRoot', 'kaId', 'startKAId', 'endKAId'] as const)('refuses a confirmed receipt with a mismatched %s', async field => {
    const f = fixture();
    if (field === 'merkleRoot') f.receipt.merkleRoot = ethers.getBytes(`0x${'01'.repeat(32)}`);
    else f.receipt[field] = KA_ID + 1n;
    const adoption = f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID);
    await expect(adoption).rejects.toBeInstanceOf(AdoptExistingMintRefusalError);
    await expect(adoption).rejects.toMatchObject({ code: 'KA_ID_COLLISION' });
  });

  it.each(['queryEventLogsPage', 'readPublishReceipt', 'finalityProviderRead'] as const)('returns unavailable when %s fails', async read => {
    const f = fixture();
    f[read].mockRejectedValue(new Error('RPC unavailable'));
    await expect(f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID)).resolves.toBeNull();
  });

  it('refuses a creation event whose root differs from storage', async () => {
    const f = fixture();
    f.log.args.merkleRoot = `0x${'01'.repeat(32)}`;
    const adoption = f.chain.getMintedKnowledgeAssetProvenance(KA_ID, ethers.getBytes(ROOT), CG_ID);
    await expect(adoption).rejects.toBeInstanceOf(AdoptExistingMintRefusalError);
    await expect(adoption).rejects.toMatchObject({ code: 'KA_ID_COLLISION' });
  });
});
