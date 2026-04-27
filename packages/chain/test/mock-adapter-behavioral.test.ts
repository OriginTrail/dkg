/**
 * MockChainAdapter behavioral test suite.
 *
 * Companion to `mock-adapter-parity.test.ts` (which audits API surface).
 * This file exercises every production code path in MockChainAdapter end-to-end
 * so a regression in offline-mode behavior (breaks a real user running the
 * daemon with `chain: { type: 'mock' }`) turns the test red.
 *
 * POLICY: MockChainAdapter is production code — see the header of
 * mock-adapter-parity.test.ts for the full justification. No external mocks,
 * no vi.fn / vi.spyOn usage: we instantiate the real class and exercise its
 * real implementation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  MOCK_DEFAULT_SIGNER,
  computeConvictionMultiplier,
} from '../src/mock-adapter.js';

// Helper: deterministic bytes for merkle roots etc.
const bytes = (seed: number, len = 32): Uint8Array => {
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = (seed + i) & 0xff;
  return arr;
};

// Helper: build a minimal publish-params struct with N receiver signatures.
function makePublishParams(
  sigCount: number,
  overrides?: Partial<Parameters<MockChainAdapter['publishKnowledgeAssets']>[0]>,
) {
  return {
    kaCount: 3,
    publisherNodeIdentityId: 7n,
    merkleRoot: bytes(1),
    publicByteSize: 1024n,
    epochs: 2,
    tokenAmount: 500n,
    publisherSignature: { r: bytes(2), vs: bytes(3) },
    receiverSignatures: Array.from({ length: sigCount }, (_, i) => ({
      identityId: BigInt(100 + i),
      r: bytes(10 + i),
      vs: bytes(20 + i),
    })),
    ...overrides,
  };
}

function makeV10Params(
  sigCount: number,
  overrides?: Partial<Parameters<MockChainAdapter['createKnowledgeAssetsV10']>[0]>,
) {
  return {
    publishOperationId: '0x' + 'aa'.repeat(32),
    merkleRoot: bytes(42),
    knowledgeAssetsAmount: 5,
    byteSize: 2048n,
    chunksAmount: 8,
    epochs: 2,
    tokenAmount: 1000n,
    isImmutable: false,
    paymaster: '0x' + '0'.repeat(40),
    publisherIdentityId: 1n,
    publisherSignature: { r: bytes(50), vs: bytes(51) },
    ackSignatures: Array.from({ length: sigCount }, (_, i) => ({
      identityId: BigInt(200 + i),
      r: bytes(60 + i),
      vs: bytes(70 + i),
    })),
    contextGraphId: 0n,
    ...overrides,
  };
}

describe('MockChainAdapter — construction + identity lifecycle', () => {
  it('constructs with defaults', () => {
    const m = new MockChainAdapter();
    expect(m.chainType).toBe('evm');
    expect(m.chainId).toBe('mock:31337');
    expect(m.signerAddress).toBe(MOCK_DEFAULT_SIGNER);
  });

  it('constructs with custom chainId and signerAddress', () => {
    const signer = '0x' + '2'.repeat(40);
    const m = new MockChainAdapter('mock:42', signer);
    expect(m.chainId).toBe('mock:42');
    expect(m.signerAddress).toBe(signer);
  });

  it('getIdentityId returns 0 when no identity was registered for this signer', async () => {
    const m = new MockChainAdapter();
    expect(await m.getIdentityId()).toBe(0n);
  });

  it('ensureProfile assigns a positive id on first call and is idempotent on subsequent calls', async () => {
    const m = new MockChainAdapter();
    const id1 = await m.ensureProfile();
    const id2 = await m.ensureProfile();
    expect(id1).toBeGreaterThan(0n);
    expect(id2).toBe(id1);
  });

  it('registerIdentity returns a unique id per public key; repeated registration returns the same id', async () => {
    const m = new MockChainAdapter();
    const proofA = { publicKey: bytes(1, 33), signature: bytes(2, 64) };
    const proofB = { publicKey: bytes(100, 33), signature: bytes(101, 64) };
    const a1 = await m.registerIdentity(proofA);
    const a2 = await m.registerIdentity(proofA);
    const b = await m.registerIdentity(proofB);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it('registerIdentity emits an IdentityRegistered event', async () => {
    const m = new MockChainAdapter();
    await m.registerIdentity({ publicKey: bytes(1, 33), signature: bytes(2, 64) });
    const events: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['IdentityRegistered'] })) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0].data.identityId).toBeTruthy();
  });

  it('seedIdentity lets tests pin an identityId for a fixed address and advances nextIdentityId', async () => {
    const m = new MockChainAdapter();
    const addr = '0x' + 'b'.repeat(40);
    m.seedIdentity(addr, 42n);
    expect(m.getIdentityIdByKey(new Uint8Array([]))).toBeUndefined();
    const id = m.getNamespaceOwner(addr); // just exercise getter; seeded via seedIdentity path
    expect(id).toBeUndefined();
    // next registration must not collide with seeded id
    const newId = await m.registerIdentity({ publicKey: bytes(9, 33), signature: bytes(9, 64) });
    expect(newId).toBeGreaterThan(42n);
  });
});

describe('MockChainAdapter — UAL ranges, publishing, verify', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('reserveUALRange returns a contiguous [start,end] and monotonically advances on successive calls', async () => {
    const r1 = await m.reserveUALRange(5);
    const r2 = await m.reserveUALRange(3);
    expect(r1.startId).toBe(1n);
    expect(r1.endId).toBe(5n);
    expect(r2.startId).toBe(6n);
    expect(r2.endId).toBe(8n);
  });

  it('reserveUALRange emits a UALRangeReserved event with publisher + start/end', async () => {
    await m.reserveUALRange(10);
    const events: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['UALRangeReserved'] })) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0].data.publisher).toBe(m.signerAddress);
    expect(events[0].data.startId).toBe('1');
    expect(events[0].data.endId).toBe('10');
  });

  it('verifyPublisherOwnsRange returns true for an exact reserved range', async () => {
    await m.reserveUALRange(5);
    expect(await m.verifyPublisherOwnsRange(m.signerAddress, 1n, 5n)).toBe(true);
  });

  it('verifyPublisherOwnsRange returns true for a strict sub-range within a reservation', async () => {
    await m.reserveUALRange(10);
    expect(await m.verifyPublisherOwnsRange(m.signerAddress, 3n, 7n)).toBe(true);
  });

  it('verifyPublisherOwnsRange returns false for ranges the publisher never reserved', async () => {
    await m.reserveUALRange(5);
    expect(await m.verifyPublisherOwnsRange('0xnever', 1n, 5n)).toBe(false);
    expect(await m.verifyPublisherOwnsRange(m.signerAddress, 4n, 9n)).toBe(false);
  });

  it('publishKnowledgeAssets returns batchId/startKAId/endKAId/txHash and emits BatchCreated + KCCreated events', async () => {
    const out = await m.publishKnowledgeAssets(makePublishParams(1));
    expect(out.batchId).toBe(1n);
    expect(out.startKAId).toBe(1n);
    expect(out.endKAId).toBe(3n);
    expect(out.txHash).toMatch(/^0x[0-9a-f]+$/);
    expect(out.blockNumber).toBeGreaterThan(0);

    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['KnowledgeBatchCreated', 'KCCreated'] })) evs.push(e);
    const byType = new Set(evs.map(e => e.type));
    expect(byType.has('KnowledgeBatchCreated')).toBe(true);
    expect(byType.has('KCCreated')).toBe(true);
  });

  it('publishKnowledgeAssets throws when receiver signatures are below minimumRequiredSignatures', async () => {
    m.minimumRequiredSignatures = 3;
    await expect(m.publishKnowledgeAssets(makePublishParams(2))).rejects.toThrow(/MinSignaturesRequirementNotMet/);
  });

  it('resolvePublishByTxHash finds a publish by its emitted txHash and returns it; unknown hashes return null', async () => {
    const r1 = await m.publishKnowledgeAssets(makePublishParams(1));
    const looked = await m.resolvePublishByTxHash(r1.txHash);
    expect(looked).not.toBeNull();
    expect(looked!.startKAId).toBe(r1.startKAId);
    expect(looked!.endKAId).toBe(r1.endKAId);
    expect(await m.resolvePublishByTxHash('0xdeadbeef')).toBeNull();
  });

  it('getRequiredPublishTokenAmount returns the fixed 1n placeholder price', async () => {
    expect(await m.getRequiredPublishTokenAmount(1024n, 10)).toBe(1n);
  });

  it('publishKnowledgeAssetsPermanent emits a KnowledgeBatchCreated with isPermanent=true', async () => {
    await m.publishKnowledgeAssetsPermanent({
      ...makePublishParams(1),
    });
    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['KnowledgeBatchCreated'] })) evs.push(e);
    expect(evs.some(e => e.data.isPermanent === true)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PR #229 bot review (r3148... — mock-adapter.ts:868). The real EVM
  // adapter ALSO emits a `V10KnowledgeBatchEmitted` event alongside
  // `KnowledgeBatchCreated` whenever a V10 batch is published; downstream
  // V10 consumers (the chain-event-poller's `onUnmatchedBatchCreated` WAL
  // recovery callback, the publisher's `V10KnowledgeBatchEmitted` matchers)
  // listen for this name specifically. The mock used to only emit the
  // plain `KnowledgeBatchCreated` form, which created a divergence: tests
  // and dev environments using the mock could not exercise WAL recovery
  // matching against `V10KnowledgeBatchEmitted` because the mock never
  // produced one.
  //
  // These tests pin the emission contract: every V10 publish (regular AND
  // permanent) MUST surface a `V10KnowledgeBatchEmitted` event with the
  // schema-shape consumers expect (batchId / merkleRoot / startKAId /
  // endKAId / isPermanent / txHash). If the mock regresses to NOT emitting
  // this event, V10 WAL recovery silently fails to find its match.
  // ─────────────────────────────────────────────────────────────────────────
  it('r30-6: publishKnowledgeAssets emits V10KnowledgeBatchEmitted with shape parity to the real EVM adapter', async () => {
    const params = makePublishParams(1);
    const out = await m.publishKnowledgeAssets(params);
    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['V10KnowledgeBatchEmitted'] })) {
      evs.push(e);
    }
    expect(evs.length).toBe(1);
    const ev = evs[0];
    expect(ev.type).toBe('V10KnowledgeBatchEmitted');
    expect(ev.data.batchId).toBe(out.batchId.toString());
    expect(ev.data.startKAId).toBe(out.startKAId.toString());
    expect(ev.data.endKAId).toBe(out.endKAId.toString());
    expect(ev.data.knowledgeAssetsCount).toBe(params.kaCount.toString());
    expect(ev.data.txHash).toBe(out.txHash);
    expect(ev.data.merkleRoot).toMatch(/^0x[0-9a-f]+$/i);
    expect(ev.data.publisherAddress).toBe(m.signerAddress);
    expect(ev.data.isPermanent).toBe(false);
  });

  it('r30-6: publishKnowledgeAssetsPermanent emits V10KnowledgeBatchEmitted with isPermanent=true', async () => {
    const params = makePublishParams(1);
    const out = await m.publishKnowledgeAssetsPermanent(params);
    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['V10KnowledgeBatchEmitted'] })) {
      evs.push(e);
    }
    expect(evs.length).toBe(1);
    expect(evs[0].data.isPermanent).toBe(true);
    expect(evs[0].data.batchId).toBe(out.batchId.toString());
    expect(evs[0].data.txHash).toBe(out.txHash);
  });

  it('r30-6: V10KnowledgeBatchEmitted is emitted IN THE SAME BLOCK as KnowledgeBatchCreated for the same publish', async () => {
    // The real EVM adapter emits the two events in the same transaction
    // receipt. Downstream consumers that correlate by blockNumber rely
    // on this. The mock must mirror that ordering.
    const out = await m.publishKnowledgeAssets(makePublishParams(1));
    const all: any[] = [];
    for await (const e of m.listenForEvents({
      fromBlock: 0,
      eventTypes: ['KnowledgeBatchCreated', 'V10KnowledgeBatchEmitted'],
    })) {
      all.push(e);
    }
    const v10 = all.filter(e => e.type === 'V10KnowledgeBatchEmitted');
    const created = all.filter(e => e.type === 'KnowledgeBatchCreated');
    expect(v10.length).toBe(1);
    expect(created.length).toBe(1);
    expect(v10[0].blockNumber).toBe(created[0].blockNumber);
    // Same logical batch — same batchId on both events.
    expect(v10[0].data.batchId).toBe(out.batchId.toString());
    expect(created[0].data.batchId).toBe(out.batchId.toString());
  });

  it('r30-6: multiple V10 publishes each produce one V10KnowledgeBatchEmitted (no missed emissions, no spurious extras)', async () => {
    // WAL recovery iterates events looking for a matching merkleRoot;
    // missing OR duplicated emissions both break it. Pin both shapes.
    const a = await m.publishKnowledgeAssets(makePublishParams(1));
    const b = await m.publishKnowledgeAssets(makePublishParams(1));
    const c = await m.publishKnowledgeAssetsPermanent(makePublishParams(1));
    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['V10KnowledgeBatchEmitted'] })) {
      evs.push(e);
    }
    expect(evs.length).toBe(3);
    expect(evs.map(e => e.data.batchId)).toEqual([
      a.batchId.toString(),
      b.batchId.toString(),
      c.batchId.toString(),
    ]);
    // Pin the isPermanent flag pattern across the sequence.
    expect(evs.map(e => e.data.isPermanent)).toEqual([false, false, true]);
  });

  it('transferNamespace moves reserved ranges + nextId to the new owner and emits NamespaceTransferred', async () => {
    await m.reserveUALRange(5);
    const newOwner = '0x' + '9'.repeat(40);
    await m.transferNamespace(newOwner);
    expect(await m.verifyPublisherOwnsRange(newOwner, 1n, 5n)).toBe(true);
    expect(await m.verifyPublisherOwnsRange(m.signerAddress, 1n, 5n)).toBe(false);
    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['NamespaceTransferred'] })) evs.push(e);
    expect(evs[0].data.from).toBe(m.signerAddress);
    expect(evs[0].data.to).toBe(newOwner);
  });

  it('updateKnowledgeAssets replaces merkleRoot on an existing batch and returns success=true', async () => {
    const pub = await m.publishKnowledgeAssets(makePublishParams(1));
    const out = await m.updateKnowledgeAssets({ batchId: pub.batchId, newMerkleRoot: bytes(99) });
    expect(out.success).toBe(true);
  });

  it('updateKnowledgeAssets returns success=false for a non-existent batch id', async () => {
    const out = await m.updateKnowledgeAssets({ batchId: 9999n, newMerkleRoot: bytes(1) });
    expect(out.success).toBe(false);
  });

  it('updateKnowledgeCollectionV10 updates the merkle root of an existing KC and returns success=true', async () => {
    const pub = await m.publishKnowledgeAssets(makePublishParams(1));
    const out = await m.updateKnowledgeCollectionV10({ kcId: pub.batchId, newMerkleRoot: bytes(55) } as any);
    expect(out.success).toBe(true);
  });

  it('updateKnowledgeCollectionV10 returns success=false for a non-existent kcId', async () => {
    const out = await m.updateKnowledgeCollectionV10({ kcId: 9999n, newMerkleRoot: bytes(1) } as any);
    expect(out.success).toBe(false);
  });

  it('verifyKAUpdate confirms an update post-fact with onChainMerkleRoot + blockNumber populated', async () => {
    const pub = await m.publishKnowledgeAssets(makePublishParams(1));
    const newRoot = bytes(77);
    const u = await m.updateKnowledgeAssets({ batchId: pub.batchId, newMerkleRoot: newRoot });
    const ver = await m.verifyKAUpdate(u.hash, pub.batchId, m.signerAddress);
    expect(ver.verified).toBe(true);
    expect(ver.onChainMerkleRoot).toBeDefined();
    expect(ver.blockNumber).toBe(u.blockNumber);
  });

  it('verifyKAUpdate returns verified=false when the txHash does not match any KnowledgeBatchUpdated event', async () => {
    const pub = await m.publishKnowledgeAssets(makePublishParams(1));
    const ver = await m.verifyKAUpdate('0xdeadbeef', pub.batchId, m.signerAddress);
    expect(ver.verified).toBe(false);
  });

  it('extendStorage on an existing batch succeeds and emits StorageExtended; missing batch returns success=false', async () => {
    const pub = await m.publishKnowledgeAssets(makePublishParams(1));
    const ok = await m.extendStorage({ batchId: pub.batchId, additionalEpochs: 3 } as any);
    expect(ok.success).toBe(true);

    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['StorageExtended'] })) evs.push(e);
    expect(evs[0].data.additionalEpochs).toBe(3);

    const fail = await m.extendStorage({ batchId: 9999n, additionalEpochs: 1 } as any);
    expect(fail.success).toBe(false);
  });
});

describe('MockChainAdapter — V8 back-compat KC surface', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('createKnowledgeCollection allocates a kcId and emits KCCreated', async () => {
    const out = await m.createKnowledgeCollection({ merkleRoot: bytes(1), knowledgeAssetsCount: 7 } as any);
    expect(out.success).toBe(true);
    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['KCCreated'] })) evs.push(e);
    expect(evs[0].data.kaCount).toBe(7);
  });

  it('updateKnowledgeCollection updates an existing kc and returns success=true; missing kc returns success=false', async () => {
    await m.createKnowledgeCollection({ merkleRoot: bytes(1), knowledgeAssetsCount: 2 } as any);
    const ok = await m.updateKnowledgeCollection({ kcId: 1n, newMerkleRoot: bytes(2) } as any);
    expect(ok.success).toBe(true);
    const fail = await m.updateKnowledgeCollection({ kcId: 9999n, newMerkleRoot: bytes(3) } as any);
    expect(fail.success).toBe(false);
  });
});

describe('MockChainAdapter — event stream filters by block and type', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('listenForEvents honors fromBlock/toBlock and filters by eventTypes', async () => {
    await m.publishKnowledgeAssets(makePublishParams(1)); // block 1
    await m.publishKnowledgeAssets(makePublishParams(1)); // block 2 (autoMine)
    const t1: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, toBlock: Infinity, eventTypes: ['KCCreated'] })) t1.push(e);
    expect(t1.length).toBeGreaterThanOrEqual(2);

    const t2: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, toBlock: Infinity, eventTypes: ['DoesNotExist' as any] })) t2.push(e);
    expect(t2).toHaveLength(0);
  });

  it('listenForEvents stops at toBlock even when later events exist', async () => {
    await m.publishKnowledgeAssets(makePublishParams(1));
    const blockAfterFirst = (m as any).nextBlock as number;
    await m.publishKnowledgeAssets(makePublishParams(1));
    const captured: any[] = [];
    for await (const e of m.listenForEvents({
      fromBlock: 0,
      toBlock: blockAfterFirst - 1,
      eventTypes: ['KCCreated', 'KnowledgeBatchCreated'],
    })) captured.push(e);
    const types = new Set(captured.map(e => e.type));
    // Every captured event must be within the requested block range.
    for (const e of captured) expect(e.blockNumber).toBeLessThanOrEqual(blockAfterFirst - 1);
    expect(types.size).toBeGreaterThan(0);
  });
});

describe('MockChainAdapter — V9 context-graph registry (legacy)', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('createContextGraph allocates an id and emits ParanetCreated', async () => {
    const r = await m.createContextGraph({ name: 'world', description: 'd', accessPolicy: 0 } as any);
    expect(r.success).toBe(true);
    expect((r as any).contextGraphId).toBeTruthy();
  });

  it('createContextGraph throws when the same id is reused', async () => {
    await m.createContextGraph({ contextGraphId: '0xabc', metadata: {} } as any);
    await expect(m.createContextGraph({ contextGraphId: '0xabc', metadata: {} } as any)).rejects.toThrow(/already exists/);
  });

  it('submitToContextGraph emits KCSubmittedToContextGraph and returns success', async () => {
    const out = await m.submitToContextGraph('kc-1', 'cg-1');
    expect(out.success).toBe(true);
    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['KCSubmittedToContextGraph'] })) evs.push(e);
    expect(evs[0].data.kcId).toBe('kc-1');
    expect(evs[0].data.contextGraphId).toBe('cg-1');
  });

  it('revealContextGraphMetadata updates the registry and emits ParanetMetadataRevealed; unknown id throws', async () => {
    const r = await m.createContextGraph({ name: 'n', description: 'd', accessPolicy: 0 } as any);
    const id = (r as any).contextGraphId as string;
    const out = await m.revealContextGraphMetadata(id, 'pretty', 'human');
    expect(out.success).toBe(true);
    await expect(m.revealContextGraphMetadata('0xdoesnotexist', 'a', 'b')).rejects.toThrow(/not found/);
  });

  it('listContextGraphsFromChain returns an empty array on the mock (placeholder)', async () => {
    expect(await m.listContextGraphsFromChain()).toEqual([]);
  });
});

describe('MockChainAdapter — conviction accounts', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('createConvictionAccount returns a positive accountId and emits ConvictionAccountCreated', async () => {
    const r = await m.createConvictionAccount(1000n, 3);
    expect(r.accountId).toBeGreaterThan(0n);
    const evs: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['ConvictionAccountCreated'] })) evs.push(e);
    expect(evs[0].data.accountId).toBe(r.accountId.toString());
  });

  it('addConvictionFunds increases balance on an existing account; returns failure for unknown id', async () => {
    const r = await m.createConvictionAccount(1000n, 3);
    const ok = await m.addConvictionFunds(r.accountId, 500n);
    expect(ok.success).toBe(true);
    const info = await m.getConvictionAccountInfo(r.accountId);
    expect(info!.balance).toBe(1500n);

    const fail = await m.addConvictionFunds(9999n, 1n);
    expect(fail.success).toBe(false);
  });

  it('extendConvictionLock adds epochs and recomputes conviction = initialDeposit × lockEpochs', async () => {
    const r = await m.createConvictionAccount(1000n, 3);
    await m.extendConvictionLock(r.accountId, 2);
    const info = await m.getConvictionAccountInfo(r.accountId);
    expect(info!.lockEpochs).toBe(5);
    expect(info!.conviction).toBe(1000n * 5n);

    const fail = await m.extendConvictionLock(9999n, 1);
    expect(fail.success).toBe(false);
  });

  it('getConvictionDiscount returns discountBps ∈ [0,5000] for any valid account; unknown id returns zeros', async () => {
    const r = await m.createConvictionAccount(1_000_000n * 10n ** 18n, 12);
    const d = await m.getConvictionDiscount(r.accountId);
    expect(d.discountBps).toBeGreaterThan(0);
    expect(d.discountBps).toBeLessThanOrEqual(5000);

    const zero = await m.getConvictionDiscount(9999n);
    expect(zero).toEqual({ discountBps: 0, conviction: 0n });
  });

  it('getConvictionAccountInfo returns null for an unknown account', async () => {
    expect(await m.getConvictionAccountInfo(9999n)).toBeNull();
  });
});

// PR #229 cleanup: the FairSwap lifecycle test block previously
// referenced a `MockChainAdapter` API surface (`initiatePurchase`,
// `fulfillPurchase`, `revealKey`, `claimPayment`, `disputeDelivery`,
// `claimRefund`, `getFairSwapPurchase`) that was never implemented on
// `packages/chain/src/mock-adapter.ts`. Per spec
// (`docs/SPEC_TRUST_LAYER.md`) FairSwap is a future trust-layer feature
// and the mock adapter has no commitment to that surface yet. The
// tests therefore failed with `TypeError: m.initiatePurchase is not a
// function` on every CI run.
//
// Removing the block (rather than skipping) avoids leaving "phantom"
// red tests that block CI. When FairSwap actually lands on the
// MockChainAdapter, this block can be reintroduced — at that point
// the methods will exist and the tests will be meaningful instead of
// referring to a fictional API surface.

describe('MockChainAdapter — staking conviction', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('stakeWithLock records a lock; getDelegatorConvictionMultiplier reflects it', async () => {
    await m.stakeWithLock(5n, 1000n, 6);
    const r = await m.getDelegatorConvictionMultiplier(5n, m.signerAddress);
    // 6 epochs → tier 3.5x per Solidity schedule
    expect(r.multiplier).toBe(3.5);
  });

  it('stakeWithLock only extends, never shortens — second smaller lock is ignored', async () => {
    await m.stakeWithLock(5n, 1000n, 12);
    await m.stakeWithLock(5n, 1000n, 1);
    const r = await m.getDelegatorConvictionMultiplier(5n, m.signerAddress);
    expect(r.multiplier).toBe(6.0); // 12+ epochs
  });

  it('getDelegatorConvictionMultiplier defaults to 1.0 for an unknown delegator/identity pair', async () => {
    const r = await m.getDelegatorConvictionMultiplier(99n, m.signerAddress);
    expect(r.multiplier).toBe(1.0);
  });
});

describe('computeConvictionMultiplier — exhaustive tier coverage', () => {
  it('returns 0 for zero or negative locks', () => {
    expect(computeConvictionMultiplier(0)).toBe(0);
    expect(computeConvictionMultiplier(-5)).toBe(0);
  });
  it('returns 1.0 for a single epoch', () => {
    expect(computeConvictionMultiplier(1)).toBe(1.0);
  });
  it('returns 1.5 at exactly 2 epochs', () => {
    expect(computeConvictionMultiplier(2)).toBe(1.5);
  });
  it('returns 2.0 for 3–5 epochs', () => {
    expect(computeConvictionMultiplier(3)).toBe(2.0);
    expect(computeConvictionMultiplier(5)).toBe(2.0);
  });
  it('returns 3.5 for 6–11 epochs', () => {
    expect(computeConvictionMultiplier(6)).toBe(3.5);
    expect(computeConvictionMultiplier(11)).toBe(3.5);
  });
  it('returns 6.0 for 12+ epochs', () => {
    expect(computeConvictionMultiplier(12)).toBe(6.0);
    expect(computeConvictionMultiplier(10_000)).toBe(6.0);
  });
});

describe('MockChainAdapter — on-chain context graphs (V10)', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('createOnChainContextGraph stores the cg and emits ContextGraphCreated', async () => {
    const r = await m.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n, 3n],
      requiredSignatures: 2,
    } as any);
    expect(r.success).toBe(true);
    expect(r.contextGraphId).toBeGreaterThan(0n);

    const ev: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['ContextGraphCreated'] })) ev.push(e);
    expect(ev[0].data.requiredSignatures).toBe(2);
  });

  it('createOnChainContextGraph rejects requiredSignatures < 1', async () => {
    await expect(m.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 0,
    } as any)).rejects.toThrow(/requiredSignatures must be >= 1/);
  });

  it('createOnChainContextGraph rejects requiredSignatures > participant count', async () => {
    await expect(m.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 3,
    } as any)).rejects.toThrow(/exceeds participant count/);
  });

  it('createOnChainContextGraph rejects non-strictly-increasing participant ids (sort/unique check)', async () => {
    await expect(m.createOnChainContextGraph({
      participantIdentityIds: [1n, 1n, 2n],
      requiredSignatures: 1,
    } as any)).rejects.toThrow(/strictly increasing/);
    await expect(m.createOnChainContextGraph({
      participantIdentityIds: [3n, 2n, 1n],
      requiredSignatures: 1,
    } as any)).rejects.toThrow(/strictly increasing/);
  });

  it('getContextGraphRequiredSignatures returns stored quorum for existing cg; 0 for unknown / <= 0n', async () => {
    const r = await m.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n, 3n],
      requiredSignatures: 2,
    } as any);
    expect(await m.getContextGraphRequiredSignatures(r.contextGraphId)).toBe(2);
    expect(await m.getContextGraphRequiredSignatures(9999n)).toBe(0);
    expect(await m.getContextGraphRequiredSignatures(0n)).toBe(0);
  });

  it('getContextGraphParticipants returns the participant list for existing cg; null for unknown', async () => {
    const r = await m.createOnChainContextGraph({
      participantIdentityIds: [10n, 20n, 30n],
      requiredSignatures: 1,
    } as any);
    const ps = await m.getContextGraphParticipants(r.contextGraphId);
    expect(ps).toEqual([10n, 20n, 30n]);
    expect(await m.getContextGraphParticipants(9999n)).toBeNull();
  });

  it('publishToContextGraph fails when cg is unknown/inactive', async () => {
    await expect(m.publishToContextGraph({
      ...makePublishParams(1),
      contextGraphId: 9999n,
      participantSignatures: [{ identityId: 1n, r: bytes(1), vs: bytes(2) }],
    } as any)).rejects.toThrow(/not found or inactive/);
  });

  it('publishToContextGraph rejects when participantSignatures < cg.requiredSignatures', async () => {
    const cg = await m.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n, 3n],
      requiredSignatures: 2,
    } as any);
    await expect(m.publishToContextGraph({
      ...makePublishParams(1),
      contextGraphId: cg.contextGraphId,
      participantSignatures: [{ identityId: 1n, r: bytes(1), vs: bytes(2) }],
    } as any)).rejects.toThrow(/participant signatures/);
  });

  it('publishToContextGraph happy path appends batch to cg and emits ContextGraphExpanded', async () => {
    const cg = await m.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 1,
    } as any);
    const r = await m.publishToContextGraph({
      ...makePublishParams(1),
      contextGraphId: cg.contextGraphId,
      participantSignatures: [{ identityId: 1n, r: bytes(1), vs: bytes(2) }],
    } as any);
    expect(r.batchId).toBeGreaterThan(0n);

    const ev: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['ContextGraphExpanded'] })) ev.push(e);
    expect(ev.some(e => e.data.contextGraphId === cg.contextGraphId.toString())).toBe(true);

    expect(m.getContextGraph(cg.contextGraphId)!.batches).toContain(r.batchId);
  });

  it('verify requires ≥ requiredSignatures and a matching merkleRoot on an existing batch', async () => {
    const pub = await m.publishKnowledgeAssets(makePublishParams(1));
    const cg = await m.createOnChainContextGraph({
      participantIdentityIds: [1n, 2n, 3n],
      requiredSignatures: 2,
    } as any);
    // Too few sigs
    await expect(m.verify({
      contextGraphId: cg.contextGraphId,
      batchId: pub.batchId,
      merkleRoot: makePublishParams(1).merkleRoot,
      signerSignatures: [{ identityId: 1n, r: bytes(1), vs: bytes(2) }],
    } as any)).rejects.toThrow(/Not enough signatures/);

    // Wrong merkleRoot
    await expect(m.verify({
      contextGraphId: cg.contextGraphId,
      batchId: pub.batchId,
      merkleRoot: bytes(99),
      signerSignatures: [
        { identityId: 1n, r: bytes(1), vs: bytes(2) },
        { identityId: 2n, r: bytes(3), vs: bytes(4) },
      ],
    } as any)).rejects.toThrow(/merkleRoot mismatch/);

    // Unknown batch
    await expect(m.verify({
      contextGraphId: cg.contextGraphId,
      batchId: 9999n,
      merkleRoot: bytes(1),
      signerSignatures: [
        { identityId: 1n, r: bytes(1), vs: bytes(2) },
        { identityId: 2n, r: bytes(3), vs: bytes(4) },
      ],
    } as any)).rejects.toThrow(/does not exist/);

    // Happy path: same merkle root as publish, enough sigs
    const ok = await m.verify({
      contextGraphId: cg.contextGraphId,
      batchId: pub.batchId,
      merkleRoot: bytes(1),
      signerSignatures: [
        { identityId: 1n, r: bytes(1), vs: bytes(2) },
        { identityId: 2n, r: bytes(3), vs: bytes(4) },
      ],
    } as any);
    expect(ok.success).toBe(true);
  });

  it('verify returns success=false when cg is inactive/unknown', async () => {
    const pub = await m.publishKnowledgeAssets(makePublishParams(1));
    const out = await m.verify({
      contextGraphId: 9999n,
      batchId: pub.batchId,
      merkleRoot: bytes(1),
      signerSignatures: [],
    } as any);
    expect(out.success).toBe(false);
  });
});

describe('MockChainAdapter — signatures, ACK / sync identity verification', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('signMessage returns 32-byte r and 32-byte vs (deterministic zero-filled on the mock)', async () => {
    const sig = await m.signMessage(bytes(1));
    expect(sig.r).toBeInstanceOf(Uint8Array);
    expect(sig.r.length).toBe(32);
    expect(sig.vs.length).toBe(32);
  });

  it('signACKDigest returns undefined when no mock signer is configured', async () => {
    expect(await m.signACKDigest(bytes(1))).toBeUndefined();
    expect(m.getACKSignerKey()).toBeUndefined();
  });

  it('signACKDigest returns an EIP-2098 compact signature when a mock signer is configured', async () => {
    const wallet = ethers.Wallet.createRandom();
    m.setMockACKSigner(wallet);
    const sig = await m.signACKDigest(bytes(1));
    expect(sig).toBeDefined();
    expect(sig!.r.length).toBe(32);
    expect(sig!.vs.length).toBe(32);
    expect(m.getACKSignerKey()).toBe(wallet.privateKey);
  });

  it('verifyACKIdentity requires both registered identity + matching recovered address', async () => {
    const addr = '0x' + 'a'.repeat(40);
    m.seedIdentity(addr, 7n);
    expect(await m.verifyACKIdentity(addr, 7n)).toBe(true);
    expect(await m.verifyACKIdentity(addr.toUpperCase(), 7n)).toBe(true); // case-insensitive
    expect(await m.verifyACKIdentity(addr, 8n)).toBe(false); // wrong identityId
    expect(await m.verifyACKIdentity('0x' + 'b'.repeat(40), 7n)).toBe(false); // wrong addr
  });

  it('verifySyncIdentity mirrors verifyACKIdentity', async () => {
    const addr = '0x' + 'c'.repeat(40);
    m.seedIdentity(addr, 9n);
    expect(await m.verifySyncIdentity(addr, 9n)).toBe(true);
    expect(await m.verifySyncIdentity(addr, 10n)).toBe(false);
  });

  it('getMinimumRequiredSignatures reflects the configurable field (default 1)', async () => {
    expect(await m.getMinimumRequiredSignatures()).toBe(1);
    m.minimumRequiredSignatures = 4;
    expect(await m.getMinimumRequiredSignatures()).toBe(4);
  });
});

describe('MockChainAdapter — V10 direct publish (KnowledgeAssetsV10)', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('createKnowledgeAssetsV10 records kcId, emits KCCreated, returns start/end KAId and tokenAmount', async () => {
    const out = await m.createKnowledgeAssetsV10(makeV10Params(1));
    expect(out.batchId).toBeGreaterThan(0n);
    expect(out.startKAId).toBeGreaterThan(0n);
    expect(out.endKAId).toBeGreaterThanOrEqual(out.startKAId!);
    expect(out.tokenAmount).toBe(1000n);

    const ev: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['KCCreated'] })) ev.push(e);
    expect(ev[0].data.isImmutable).toBe(false);
  });

  it('createKnowledgeAssetsV10 throws when ackSignatures < minimumRequiredSignatures', async () => {
    m.minimumRequiredSignatures = 3;
    await expect(m.createKnowledgeAssetsV10(makeV10Params(2))).rejects.toThrow(/MinSignaturesRequirementNotMet/);
  });

  it('createKnowledgeAssetsV10 tolerates contextGraphId=0n (documented offline-mode laxity)', async () => {
    const out = await m.createKnowledgeAssetsV10(makeV10Params(1, { contextGraphId: 0n }));
    expect(out.batchId).toBeGreaterThan(0n);
  });

  it('isV10Ready returns true (capability gate)', () => {
    expect(m.isV10Ready()).toBe(true);
  });

  it('getKnowledgeAssetsV10Address returns a stable 20-byte hex address', async () => {
    const a = await m.getKnowledgeAssetsV10Address();
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('getEvmChainId returns 31337n', async () => {
    expect(await m.getEvmChainId()).toBe(31337n);
  });
});

describe('MockChainAdapter — block advancement + test helpers', () => {
  let m: MockChainAdapter;
  beforeEach(() => { m = new MockChainAdapter(); });

  it('autoMine=true (default) advances the block after every tx-producing call', async () => {
    const before = (m as any).nextBlock as number;
    await m.publishKnowledgeAssets(makePublishParams(1));
    const after = (m as any).nextBlock as number;
    expect(after).toBeGreaterThan(before);
  });

  it('autoMine=false keeps the same block across calls; advanceBlock is a manual control', async () => {
    m.autoMine = false;
    const b1 = (m as any).nextBlock as number;
    await m.publishKnowledgeAssets(makePublishParams(1));
    await m.publishKnowledgeAssets(makePublishParams(1));
    expect((m as any).nextBlock).toBe(b1);
    m.advanceBlock();
    expect((m as any).nextBlock).toBe(b1 + 1);
    expect((m as any).txIndexInBlock).toBe(0);
  });

  it('getBatch / getCollection expose internal state for tests', async () => {
    const pub = await m.publishKnowledgeAssets(makePublishParams(1));
    const b = m.getBatch(pub.batchId);
    expect(b).toBeDefined();
    expect(b!.kaCount).toBe(3);

    await m.createKnowledgeCollection({ merkleRoot: bytes(1), knowledgeAssetsCount: 1 } as any);
    const c = m.getCollection(2n);
    expect(c).toBeDefined();
  });

  it('getIdentityIdByKey returns a registered key id or undefined', async () => {
    const pubKey = bytes(1, 33);
    const id = await m.registerIdentity({ publicKey: pubKey, signature: bytes(2, 64) });
    expect(m.getIdentityIdByKey(pubKey)).toBe(id);
    expect(m.getIdentityIdByKey(bytes(99, 33))).toBeUndefined();
  });

  it('batchMintKnowledgeAssets allocates an explicit batchId and emits KnowledgeBatchCreated with the publisher address', async () => {
    const params = {
      publisherNodeIdentityId: 7n,
      merkleRoot: bytes(1),
      startKAId: 10n,
      endKAId: 15n,
      publicByteSize: 512n,
      epochs: 1,
      tokenAmount: 100n,
      publisherSignature: { r: bytes(2), vs: bytes(3) },
      receiverSignatures: [{ identityId: 100n, r: bytes(10), vs: bytes(20) }],
    };
    const out = await m.batchMintKnowledgeAssets(params);
    expect(out.batchId).toBeGreaterThan(0n);
    expect(out.success).toBe(true);

    const ev: any[] = [];
    for await (const e of m.listenForEvents({ fromBlock: 0, eventTypes: ['KnowledgeBatchCreated'] })) ev.push(e);
    expect(ev[0].data.publisherAddress).toBe(m.signerAddress);
    expect(ev[0].data.kaCount).toBe(6); // 15 - 10 + 1
  });
});
