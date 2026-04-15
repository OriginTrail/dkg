import { describe, it, expect } from 'vitest';
import { MockChainAdapter, MOCK_DEFAULT_SIGNER } from '../src/mock-adapter.js';

describe('MockChainAdapter V9', () => {
  function createAdapter() {
    return new MockChainAdapter('mock:31337');
  }

  // =====================================================================
  // Identity
  // =====================================================================

  it('registers an identity and returns a unique ID', async () => {
    const adapter = createAdapter();
    const pubKey = new Uint8Array([1, 2, 3, 4]);
    const id = await adapter.registerIdentity({ publicKey: pubKey, signature: new Uint8Array() });
    expect(id).toBe(1n);
  });

  it('returns same identity for duplicate public key', async () => {
    const adapter = createAdapter();
    const pubKey = new Uint8Array([10, 20, 30]);
    const id1 = await adapter.registerIdentity({ publicKey: pubKey, signature: new Uint8Array() });
    const id2 = await adapter.registerIdentity({ publicKey: pubKey, signature: new Uint8Array() });
    expect(id1).toBe(id2);
  });

  it('assigns different IDs for different keys', async () => {
    const adapter = createAdapter();
    const id1 = await adapter.registerIdentity({ publicKey: new Uint8Array([1]), signature: new Uint8Array() });
    const id2 = await adapter.registerIdentity({ publicKey: new Uint8Array([2]), signature: new Uint8Array() });
    expect(id1).not.toBe(id2);
  });

  // =====================================================================
  // UAL Range Reservation
  // =====================================================================

  it('reserves a UAL range starting at 1', async () => {
    const adapter = createAdapter();
    const range = await adapter.reserveUALRange(10);
    expect(range.startId).toBe(1n);
    expect(range.endId).toBe(10n);
  });

  it('reserves consecutive non-overlapping ranges', async () => {
    const adapter = createAdapter();
    const r1 = await adapter.reserveUALRange(5);
    const r2 = await adapter.reserveUALRange(3);
    expect(r1.endId).toBe(5n);
    expect(r2.startId).toBe(6n);
    expect(r2.endId).toBe(8n);
  });

  // =====================================================================
  // Batch Minting
  // =====================================================================

  it('batch-mints KAs and returns a batchId', async () => {
    const adapter = createAdapter();
    const merkleRoot = new Uint8Array(32).fill(0xab);
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    const result = await adapter.batchMintKnowledgeAssets({
      publisherNodeIdentityId: 1n,
      merkleRoot,
      startKAId: 1n,
      endKAId: 5n,
      publicByteSize: 1024n,
      epochs: 2,
      tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    expect(result.success).toBe(true);
    expect(result.batchId).toBe(1n);

    const batch = adapter.getBatch(1n);
    expect(batch).toBeDefined();
    expect(batch!.kaCount).toBe(5);
  });

  it('assigns sequential batch IDs', async () => {
    const adapter = createAdapter();
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };
    const mkParams = (start: bigint, end: bigint) => ({
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(Number(start)),
      startKAId: start,
      endKAId: end,
      publicByteSize: 512n,
      epochs: 1,
      tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    const r1 = await adapter.batchMintKnowledgeAssets(mkParams(1n, 3n));
    const r2 = await adapter.batchMintKnowledgeAssets(mkParams(4n, 6n));
    expect(r1.batchId).toBe(1n);
    expect(r2.batchId).toBe(2n);
  });

  // =====================================================================
  // Publish Knowledge Assets (auto-reserve + mint)
  // =====================================================================

  it('publishKnowledgeAssets reserves and mints, returns OnChainPublishResult', async () => {
    const adapter = createAdapter();
    const merkleRoot = new Uint8Array(32).fill(0xcc);
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    const result = await adapter.publishKnowledgeAssets({
      kaCount: 7,
      publisherNodeIdentityId: 1n,
      merkleRoot,
      publicByteSize: 1024n,
      epochs: 2,
      tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    expect(result.batchId).toBe(1n);
    expect(result.startKAId).toBe(1n);
    expect(result.endKAId).toBe(7n);
    expect(result.txHash).toBeDefined();
    expect(result.txHash.startsWith('0x')).toBe(true);
    expect(result.blockNumber).toBeGreaterThan(0);
    expect(result.blockTimestamp).toBeGreaterThan(0);
    expect(result.publisherAddress).toBe(MOCK_DEFAULT_SIGNER);
  });

  // =====================================================================
  // Transfer Namespace
  // =====================================================================

  it('transferNamespace succeeds and emits NamespaceTransferred event', async () => {
    const adapter = createAdapter();
    await adapter.reserveUALRange(5); // ensure namespace exists

    const newOwner = '0x' + '2'.repeat(40);
    const result = await adapter.transferNamespace(newOwner);

    expect(result.success).toBe(true);
    expect(result.hash).toBeDefined();

    expect(adapter.getNamespaceOwner(MOCK_DEFAULT_SIGNER)).toBe(newOwner);

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const evt of adapter.listenForEvents({ eventTypes: ['NamespaceTransferred'] })) {
      events.push(evt);
    }
    const transferred = events.find((e) => e.type === 'NamespaceTransferred');
    expect(transferred).toBeDefined();
    expect(transferred!.data.from).toBe(MOCK_DEFAULT_SIGNER);
    expect(transferred!.data.to).toBe(newOwner);
  });

  // =====================================================================
  // Knowledge Updates
  // =====================================================================

  it('updates an existing batch merkle root', async () => {
    const adapter = createAdapter();
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await adapter.batchMintKnowledgeAssets({
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x01),
      startKAId: 1n, endKAId: 3n,
      publicByteSize: 1024n, epochs: 2, tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    const newRoot = new Uint8Array(32).fill(0xff);
    const result = await adapter.updateKnowledgeAssets({
      batchId: 1n,
      newMerkleRoot: newRoot,
      newPublicByteSize: 2048n,
    });

    expect(result.success).toBe(true);
    const batch = adapter.getBatch(1n);
    expect(batch!.merkleRoot).toEqual(newRoot);
  });

  it('fails to update non-existent batch', async () => {
    const adapter = createAdapter();
    const result = await adapter.updateKnowledgeAssets({
      batchId: 999n,
      newMerkleRoot: new Uint8Array(32),
      newPublicByteSize: 1024n,
    });
    expect(result.success).toBe(false);
  });

  // =====================================================================
  // Storage Extension
  // =====================================================================

  it('extends storage for an existing batch', async () => {
    const adapter = createAdapter();
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await adapter.batchMintKnowledgeAssets({
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x01),
      startKAId: 1n, endKAId: 3n,
      publicByteSize: 1024n, epochs: 2, tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    const result = await adapter.extendStorage({
      batchId: 1n,
      additionalEpochs: 5,
      tokenAmount: 100n,
    });
    expect(result.success).toBe(true);
  });

  it('fails to extend non-existent batch', async () => {
    const adapter = createAdapter();
    const result = await adapter.extendStorage({
      batchId: 999n,
      additionalEpochs: 5,
      tokenAmount: 100n,
    });
    expect(result.success).toBe(false);
  });

  // =====================================================================
  // Events
  // =====================================================================

  it('emits UALRangeReserved event on reservation', async () => {
    const adapter = createAdapter();
    await adapter.reserveUALRange(10);

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const evt of adapter.listenForEvents({ eventTypes: ['UALRangeReserved'] })) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(events[0].data.publisher).toBe(MOCK_DEFAULT_SIGNER);
    expect(events[0].data.startId).toBe('1');
    expect(events[0].data.endId).toBe('10');
  });

  it('emits KnowledgeBatchCreated event on mint', async () => {
    const adapter = createAdapter();
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await adapter.batchMintKnowledgeAssets({
      publisherNodeIdentityId: 3n,
      merkleRoot: new Uint8Array(32).fill(0xcc),
      startKAId: 1n, endKAId: 4n,
      publicByteSize: 512n, epochs: 1, tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const evt of adapter.listenForEvents({ eventTypes: ['KnowledgeBatchCreated'] })) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(events[0].data.batchId).toBe('1');
    expect(events[0].data.kaCount).toBe(4);
  });

  it('filters events by type', async () => {
    const adapter = createAdapter();
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await adapter.reserveUALRange(5);
    await adapter.batchMintKnowledgeAssets({
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x01),
      startKAId: 1n, endKAId: 3n,
      publicByteSize: 1024n, epochs: 2, tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    // Only request UALRangeReserved — should not include batch events
    const events: Array<{ type: string }> = [];
    for await (const evt of adapter.listenForEvents({ eventTypes: ['UALRangeReserved'] })) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('UALRangeReserved');
  });

  // =====================================================================
  // V8 backward compat
  // =====================================================================

  // =====================================================================
  // V10 createKnowledgeAssetsV10
  // =====================================================================

  it('createKnowledgeAssetsV10 stores KC and emits event with V10 params', async () => {
    const adapter = createAdapter();
    const merkleRoot = new Uint8Array(32).fill(0xdd);
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    const result = await adapter.createKnowledgeAssetsV10({
      publishOperationId: 'v10-op-001',
      contextGraphId: 42n,
      merkleRoot,
      knowledgeAssetsAmount: 5,
      byteSize: 2048n,
      epochs: 3,
      tokenAmount: 100n,
      isImmutable: true,
      paymaster: '0x' + '0'.repeat(40),
      publisherNodeIdentityId: 1n,
      publisherSignature: sig,
      ackSignatures: [
        { identityId: 2n, ...sig },
        { identityId: 3n, ...sig },
        { identityId: 4n, ...sig },
      ],
    });

    expect(result.batchId).toBe(1n);
    expect(result.txHash).toBeDefined();
    expect(result.blockNumber).toBeGreaterThan(0);
    expect(result.publisherAddress).toBe(MOCK_DEFAULT_SIGNER);
    expect(result.tokenAmount).toBe(100n);

    const collection = adapter.getCollection(1n);
    expect(collection).toBeDefined();
    expect(collection!.kaCount).toBe(5);
  });

  it('createKnowledgeAssetsV10 rejects insufficient ACK signatures', async () => {
    const adapter = createAdapter();
    adapter.minimumRequiredSignatures = 3;
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await expect(
      adapter.createKnowledgeAssetsV10({
        publishOperationId: 'v10-insufficient',
        contextGraphId: 42n,
        merkleRoot: new Uint8Array(32).fill(0xee),
        knowledgeAssetsAmount: 1,
        byteSize: 512n,
        epochs: 1,
        tokenAmount: 10n,
        isImmutable: false,
        paymaster: '0x' + '0'.repeat(40),
        publisherNodeIdentityId: 1n,
        publisherSignature: sig,
        ackSignatures: [{ identityId: 2n, ...sig }],
      }),
    ).rejects.toThrow('MinSignaturesRequirementNotMet');
  });

  it('createKnowledgeAssetsV10 emits KCCreated event with contextGraphId', async () => {
    const adapter = createAdapter();
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await adapter.createKnowledgeAssetsV10({
      publishOperationId: 'v10-event-test',
      contextGraphId: 99n,
      merkleRoot: new Uint8Array(32).fill(0xff),
      knowledgeAssetsAmount: 1,
      byteSize: 100n,
      epochs: 1,
      tokenAmount: 1n,
      isImmutable: false,
      paymaster: '0x' + '0'.repeat(40),
      publisherNodeIdentityId: 1n,
      publisherSignature: sig,
      ackSignatures: [{ identityId: 2n, ...sig }],
    });

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    for await (const evt of adapter.listenForEvents({ eventTypes: ['KCCreated'] })) {
      events.push(evt);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('KCCreated');
    expect(events[0].data.publishOperationId).toBe('v10-event-test');
    expect(events[0].data.contextGraphId).toBe('99');
    expect(events[0].data.isImmutable).toBe(false);
    expect(events[0].data.txHash).toBeDefined();
    expect(events[0].data.publisherAddress).toBeDefined();
  });

  // =====================================================================
  // V8 backward compat
  // =====================================================================

  it('createKnowledgeCollection still works (V8 compat)', async () => {
    const adapter = createAdapter();
    const result = await adapter.createKnowledgeCollection({
      merkleRoot: new Uint8Array(32).fill(0xaa),
      knowledgeAssetsCount: 10,
      signatures: [{ identityId: 1n, r: new Uint8Array(32), vs: new Uint8Array(32) }],
    });
    expect(result.success).toBe(true);
  });

  // =====================================================================
  // Context graphs (V9 registry)
  // =====================================================================

  it('creates a context graph with legacy explicit contextGraphId + metadata', async () => {
    const adapter = createAdapter();
    const contextGraphId = 'test-context-graph';
    const result = await adapter.createContextGraph({
      contextGraphId,
      metadata: { name: 'Test' },
    });
    expect(result.success).toBe(true);
    expect(result.contextGraphId).toBe(contextGraphId);
  });

  it('creates a context graph with a name (privacy-preserving: hash-based on-chain ID)', async () => {
    const adapter = createAdapter();
    const result = await adapter.createContextGraph({
      name: 'MyContextGraph',
      description: 'A test context graph',
      accessPolicy: 0,
    });
    expect(result.success).toBe(true);
    expect(result.contextGraphId).toBeDefined();
    expect(result.contextGraphId).toMatch(/^0x/);
  });

  it('rejects duplicate context graph creation', async () => {
    const adapter = createAdapter();
    await adapter.createContextGraph({ contextGraphId: 'dup-test', metadata: { name: 'First' } });
    await expect(
      adapter.createContextGraph({ contextGraphId: 'dup-test', metadata: { name: 'Second' } }),
    ).rejects.toThrow(/already exists/);
  });

  it('reveals context graph metadata', async () => {
    const adapter = createAdapter();
    const contextGraphId = 'reveal-test';
    const result = await adapter.createContextGraph({ contextGraphId });
    expect(result.success).toBe(true);
    await adapter.revealContextGraphMetadata!(contextGraphId, 'Revealed Name', 'A description');
  });

  it('revealContextGraphMetadata rejects unknown context graph', async () => {
    const adapter = createAdapter();
    await expect(
      adapter.revealContextGraphMetadata!('unknown-id', 'Name', 'Desc'),
    ).rejects.toThrow(/not found/);
  });

  it('listContextGraphsFromChain returns empty when mock has no chain events', async () => {
    const adapter = createAdapter();
    const list = await adapter.listContextGraphsFromChain!();
    expect(list).toEqual([]);
  });

  it('submits KC to a context graph', async () => {
    const adapter = createAdapter();
    const result = await adapter.submitToContextGraph('kc-1', 'cg-1');
    expect(result.success).toBe(true);
  });

  // =====================================================================
  // verifyPublisherOwnsRange (for PublishHandler on-chain check)
  // =====================================================================

  it('verifyPublisherOwnsRange returns false when publisher never reserved', async () => {
    const adapter = createAdapter();
    const otherAddress = '0x' + '2'.repeat(40);
    const owns = await adapter.verifyPublisherOwnsRange!(otherAddress, 1n, 1n);
    expect(owns).toBe(false);
  });

  it('verifyPublisherOwnsRange returns true when publisher reserved the range', async () => {
    const signer = '0x' + '3'.repeat(40);
    const adapter = new MockChainAdapter('mock:31337', signer);
    await adapter.reserveUALRange(5); // 1..5
    expect(await adapter.verifyPublisherOwnsRange!(signer, 1n, 1n)).toBe(true);
    expect(await adapter.verifyPublisherOwnsRange!(signer, 3n, 4n)).toBe(true);
    expect(await adapter.verifyPublisherOwnsRange!(signer, 1n, 5n)).toBe(true);
  });

  it('verifyPublisherOwnsRange returns false when range is outside reserved', async () => {
    const signer = '0x' + '4'.repeat(40);
    const adapter = new MockChainAdapter('mock:31337', signer);
    await adapter.reserveUALRange(5); // 1..5
    expect(await adapter.verifyPublisherOwnsRange!(signer, 6n, 6n)).toBe(false);
    expect(await adapter.verifyPublisherOwnsRange!(signer, 0n, 1n)).toBe(false);
  });

  // =====================================================================
  // Context graph operations
  // =====================================================================

  it('createOnChainContextGraph returns an incrementing contextGraphId and stores the graph config', async () => {
    const adapter = createAdapter();
    const result = await adapter.createOnChainContextGraph!({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 2,
      metadataBatchId: 5n,
    });

    expect(result.success).toBe(true);
    expect(result.contextGraphId).toBe(1n);

    const graph = adapter.getContextGraph!(1n);
    expect(graph).toBeDefined();
    expect(graph!.manager).toBe(MOCK_DEFAULT_SIGNER);
    expect(graph!.participantIdentityIds).toEqual([1n, 2n]);
    expect(graph!.requiredSignatures).toBe(2);
    expect(graph!.metadataBatchId).toBe(5n);
    expect(graph!.active).toBe(true);
    expect(graph!.batches).toEqual([]);
  });

  it('verify succeeds when the batch exists', async () => {
    const adapter = createAdapter();
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    await adapter.createOnChainContextGraph!({
      participantIdentityIds: [1n, 2n],
      requiredSignatures: 1,
    });

    await adapter.batchMintKnowledgeAssets({
      publisherNodeIdentityId: 1n,
      merkleRoot: new Uint8Array(32).fill(0x01),
      startKAId: 1n,
      endKAId: 3n,
      publicByteSize: 1024n,
      epochs: 2,
      tokenAmount: 0n,
      publisherSignature: sig,
      receiverSignatures: [{ identityId: 2n, ...sig }],
    });

    const result = await adapter.verify!({
      contextGraphId: 1n,
      batchId: 1n,
      signerSignatures: [{ identityId: 1n, ...sig }],
    });

    expect(result.success).toBe(true);

    const graph = adapter.getContextGraph!(1n);
    expect(graph!.batches).toEqual([1n]);
  });

  it('verify fails when the context graph does not exist', async () => {
    const adapter = createAdapter();
    const sig = { r: new Uint8Array(32), vs: new Uint8Array(32) };

    const result = await adapter.verify!({
      contextGraphId: 999n,
      batchId: 1n,
      signerSignatures: [{ identityId: 1n, ...sig }],
    });

    expect(result.success).toBe(false);
  });

  it('multiple context graphs get unique IDs', async () => {
    const adapter = createAdapter();

    const r1 = await adapter.createOnChainContextGraph!({
      participantIdentityIds: [1n],
      requiredSignatures: 1,
    });
    const r2 = await adapter.createOnChainContextGraph!({
      participantIdentityIds: [2n],
      requiredSignatures: 1,
    });
    const r3 = await adapter.createOnChainContextGraph!({
      participantIdentityIds: [3n],
      requiredSignatures: 1,
    });

    expect(r1.contextGraphId).toBe(1n);
    expect(r2.contextGraphId).toBe(2n);
    expect(r3.contextGraphId).toBe(3n);

    expect(adapter.getContextGraph!(1n)!.participantIdentityIds).toEqual([1n]);
    expect(adapter.getContextGraph!(2n)!.participantIdentityIds).toEqual([2n]);
    expect(adapter.getContextGraph!(3n)!.participantIdentityIds).toEqual([3n]);
  });
});
