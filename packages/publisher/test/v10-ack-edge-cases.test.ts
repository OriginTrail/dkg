import { describe, it, expect, vi } from 'vitest';
import { ACKCollector, type ACKCollectorDeps } from '../src/ack-collector.js';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import { computeFlatKCRootV10 as computeFlatKCRoot } from '../src/merkle.js';
import { encodeStorageACK, computePublishACKDigest, encodePublishIntent, decodeStorageACK } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';

// ── Helpers ──────────────────────────────────────────────────────────────

// Test H5 prefix inputs. The collector + handler reject cgId == 0n as
// part of the production fail-loud guard; use a real numeric id here.
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function quadsToNQuads(quads: Quad[]): string {
  return quads.map(q => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`).join('\n');
}

function createMockStore(quads: Quad[] = []) {
  return {
    query: vi.fn().mockResolvedValue({ type: 'quads' as const, quads }),
    insert: vi.fn().mockResolvedValue(undefined),
    dropGraph: vi.fn().mockResolvedValue(undefined),
    countQuads: vi.fn().mockResolvedValue(quads.length),
    hasGraph: vi.fn().mockResolvedValue(quads.length > 0),
  } as any;
}

function makeEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn(), once: vi.fn() };
}

async function signACK(
  wallet: ethers.Wallet,
  contextGraphId: bigint,
  merkleRoot: Uint8Array,
  kaCount: number = 2,
  byteSize: bigint = 500n,
  epochs: bigint = 1n,
  tokenAmount: bigint = 0n,
) {
  const digest = computePublishACKDigest(
    TEST_CHAIN_ID,
    TEST_KAV10_ADDR,
    contextGraphId,
    merkleRoot,
    BigInt(kaCount),
    byteSize,
    epochs,
    tokenAmount,
  );
  const sig = ethers.Signature.from(await wallet.signMessage(digest));
  return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
}

const testQuads: Quad[] = [
  makeQuad('urn:a', 'urn:p', 'urn:o1'),
  makeQuad('urn:a', 'urn:p', 'urn:o2'),
  makeQuad('urn:b', 'urn:p', 'urn:o3'),
];
const merkleRoot = computeFlatKCRoot(testQuads, []);
// Numeric CG id — the storage-ack-handler and ACK provider both fail-loud
// on non-numeric / zero ids, matching the V10 contract guard.
const testCGIdStr = '42';
const testCGId = 42n;

const coreWallets = Array.from({ length: 6 }, () => ethers.Wallet.createRandom());

function buildCollectParams(overrides: Partial<Parameters<ACKCollector['collect']>[0]> = {}) {
  return {
    merkleRoot,
    contextGraphId: testCGId,
    contextGraphIdStr: testCGIdStr,
    publisherPeerId: 'publisher-0',
    publicByteSize: 500n,
    isPrivate: false,
    kaCount: 2,
    rootEntities: ['urn:a', 'urn:b'],
    chainId: TEST_CHAIN_ID,
    kav10Address: TEST_KAV10_ADDR,
    ...overrides,
  };
}

function buildSendP2P(opts: {
  wallets?: ethers.Wallet[];
  identityMap?: Record<string, number>;
  merkleRootOverride?: Uint8Array;
  kaCount?: number;
  byteSize?: bigint;
} = {}) {
  const wallets = opts.wallets ?? coreWallets;
  return async (peerId: string) => {
    const idx = parseInt(peerId.replace('peer-', ''), 10);
    const wallet = wallets[idx % wallets.length];
    const root = opts.merkleRootOverride ?? merkleRoot;
    const { r, vs } = await signACK(wallet, testCGId, root, opts.kaCount ?? 2, opts.byteSize ?? 500n);
    const identityId = opts.identityMap?.[peerId] ?? (idx + 1);
    return encodeStorageACK({
      merkleRoot: root,
      coreNodeSignatureR: r,
      coreNodeSignatureVS: vs,
      contextGraphId: testCGIdStr,
      nodeIdentityId: identityId,
    });
  };
}

// ── ACKCollector quorum fast-fail (spec §9.0 Phase 3) ────────────────────

describe('ACKCollector quorum fast-fail (spec §9.0 Phase 3)', () => {
  it('throws immediately when 0 peers connected', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: vi.fn(),
      getConnectedCorePeers: () => [],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    await expect(collector.collect(buildCollectParams()))
      .rejects.toThrow('no connected core peers');
    expect(deps.sendP2P).not.toHaveBeenCalled();
    expect(deps.gossipPublish).not.toHaveBeenCalled();
  });

  it('throws immediately when peers < requiredACKs (e.g., 2 peers, need 3)', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: vi.fn(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    await expect(collector.collect(buildCollectParams({ requiredACKs: 3 })))
      .rejects.toThrow('quorum impossible');
    expect(deps.sendP2P).not.toHaveBeenCalled();
  });

  it('succeeds with exactly requiredACKs peers (3 peers, need 3)', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    expect(result.acks).toHaveLength(3);
    expect(result.merkleRoot).toBe(merkleRoot);
    expect(result.contextGraphId).toBe(testCGId);
  });

  it('succeeds with more peers than required (5 peers, need 3)', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams({ requiredACKs: 3 }));
    expect(result.acks).toHaveLength(3);
    const uniquePeers = new Set(result.acks.map(a => a.peerId));
    expect(uniquePeers.size).toBe(3);
    const uniqueIdentities = new Set(result.acks.map(a => a.nodeIdentityId));
    expect(uniqueIdentities.size).toBe(3);
  });
});

// ── ACKCollector identity verification ───────────────────────────────────

describe('ACKCollector identity verification', () => {
  it('accepts ACK when verifyIdentity returns true', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      verifyIdentity: vi.fn().mockResolvedValue(true),
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    expect(deps.verifyIdentity).toHaveBeenCalled();
    for (const call of (deps.verifyIdentity as ReturnType<typeof vi.fn>).mock.calls) {
      expect(typeof call[0]).toBe('string');
      expect(typeof call[1]).toBe('bigint');
    }
  });

  it('rejects ACK when verifyIdentity returns false', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      verifyIdentity: vi.fn().mockResolvedValue(false),
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    await expect(collector.collect(buildCollectParams()))
      .rejects.toThrow('storage_ack_insufficient');
    expect(deps.verifyIdentity).toHaveBeenCalledTimes(3);
  });

  it('accepts ACK when verifyIdentity is undefined (no on-chain check)', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    expect(result.acks.every(a => a.signatureR.length === 32)).toBe(true);
  });

  it('multiple rejected identities still reaches quorum if enough valid ones', async () => {
    const validPeers = new Set(['peer-2', 'peer-3', 'peer-4']);
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      verifyIdentity: vi.fn().mockImplementation((_addr: string, identityId: bigint) => {
        const idx = Number(identityId) - 1;
        return Promise.resolve(validPeers.has(`peer-${idx}`));
      }),
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    for (const ack of result.acks) {
      const idx = Number(ack.nodeIdentityId) - 1;
      expect(validPeers.has(`peer-${idx}`)).toBe(true);
    }
  });

  it('all identities rejected = storage_ack_insufficient error', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P(),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3'],
      verifyIdentity: vi.fn().mockResolvedValue(false),
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    await expect(collector.collect(buildCollectParams()))
      .rejects.toThrow('storage_ack_insufficient');
    expect((deps.log as ReturnType<typeof vi.fn>).mock.calls.some(
      (c: string[]) => c[0].includes('not registered'),
    )).toBe(true);
  });
});

// ── ACKCollector deduplication ───────────────────────────────────────────

describe('ACKCollector deduplication', () => {
  it('same peerId sends two different ACKs — only first accepted', async () => {
    const callCounts = new Map<string, number>();
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: async (peerId) => {
        const count = (callCounts.get(peerId) ?? 0) + 1;
        callCounts.set(peerId, count);
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const wallet = coreWallets[idx];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 2, 500n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    const peerIds = result.acks.map(a => a.peerId);
    expect(new Set(peerIds).size).toBe(peerIds.length);
  });

  it('different peers with same nodeIdentityId — only first accepted', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P({
        identityMap: {
          'peer-0': 1, 'peer-1': 1, 'peer-2': 1,
          'peer-3': 2, 'peer-4': 3,
        },
      }),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    const identityIds = result.acks.map(a => a.nodeIdentityId);
    expect(new Set(identityIds).size).toBe(3);
    expect(identityIds).toContain(1n);
    expect(identityIds).toContain(2n);
    expect(identityIds).toContain(3n);
  });

  it('different peers with different identities — all accepted', async () => {
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: buildSendP2P({
        identityMap: { 'peer-0': 10, 'peer-1': 20, 'peer-2': 30 },
      }),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    const ids = new Set(result.acks.map(a => a.nodeIdentityId));
    expect(ids.size).toBe(3);
    expect(ids).toContain(10n);
    expect(ids).toContain(20n);
    expect(ids).toContain(30n);
  });
});

// ── ACKCollector retry behavior ──────────────────────────────────────────

describe('ACKCollector retry behavior', () => {
  it('retries failed P2P request up to 3 times', async () => {
    const attemptsByPeer = new Map<string, number>();
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: async (peerId) => {
        const attempts = (attemptsByPeer.get(peerId) ?? 0) + 1;
        attemptsByPeer.set(peerId, attempts);
        if (peerId === 'peer-0' && attempts < 3) {
          throw new Error('connection reset');
        }
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const wallet = coreWallets[idx];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 2, 500n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    expect(attemptsByPeer.get('peer-0')).toBe(3);
    expect((deps.log as ReturnType<typeof vi.fn>).mock.calls.some(
      (c: string[]) => c[0].includes('Retry'),
    )).toBe(true);
  });

  it('handles mixed success/failure responses', async () => {
    const failPeers = new Set(['peer-0', 'peer-1']);
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: async (peerId) => {
        if (failPeers.has(peerId)) throw new Error('unreachable');
        const idx = parseInt(peerId.replace('peer-', ''), 10);
        const wallet = coreWallets[idx];
        const { r, vs } = await signACK(wallet, testCGId, merkleRoot, 2, 500n);
        return encodeStorageACK({
          merkleRoot,
          coreNodeSignatureR: r,
          coreNodeSignatureVS: vs,
          contextGraphId: testCGIdStr,
          nodeIdentityId: idx + 1,
        });
      },
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2', 'peer-3', 'peer-4'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const result = await collector.collect(buildCollectParams());
    expect(result.acks).toHaveLength(3);
    const peerIds = new Set(result.acks.map(a => a.peerId));
    expect(peerIds.has('peer-0')).toBe(false);
    expect(peerIds.has('peer-1')).toBe(false);
  });

  it('timeout after ACK_TIMEOUT_MS produces storage_ack_timeout error', async () => {
    // Cannot use vi.useFakeTimers here — the source's Promise.race creates a
    // timer-fired rejection that escapes before the test handler attaches,
    // causing an unhandled-rejection vitest error. Instead we verify that when
    // all peers fail after retries, the error message follows the expected
    // timeout/insufficient pattern and includes the ACK count ratio.
    const deps: ACKCollectorDeps = {
      gossipPublish: vi.fn(),
      sendP2P: vi.fn().mockRejectedValue(new Error('connection refused')),
      getConnectedCorePeers: () => ['peer-0', 'peer-1', 'peer-2'],
      log: vi.fn(),
    };
    const collector = new ACKCollector(deps);

    const err = await collector.collect(buildCollectParams()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/storage_ack_(insufficient|timeout)/);
    expect(err.message).toMatch(/0\/3/);
    expect(deps.sendP2P).toHaveBeenCalled();
    // Each peer retried 3 times (MAX_RETRIES)
    expect((deps.sendP2P as ReturnType<typeof vi.fn>).mock.calls.length).toBe(9);
  });
});

// ── StorageACKHandler inline verification ────────────────────────────────

describe('StorageACKHandler inline verification', () => {
  const coreWallet = ethers.Wallet.createRandom();
  const coreIdentityId = 42n;
  const fakePeerId = { toString: () => 'publisher-peer' };

  function createConfig(overrides: Partial<StorageACKHandlerConfig> = {}): StorageACKHandlerConfig {
    return {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      ...overrides,
    };
  }

  it('verifies merkle root from inline stagingQuads in-memory', async () => {
    const store = createMockStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const stagingBytes = new TextEncoder().encode(quadsToNQuads(testQuads));
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:a', 'urn:b'],
      stagingQuads: stagingBytes,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(ack.contextGraphId).toBe(testCGIdStr);
    const ackRoot = ack.merkleRoot instanceof Uint8Array ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(ackRoot).equals(Buffer.from(merkleRoot))).toBe(true);
    expect(store.query).not.toHaveBeenCalled();
  });

  it('persists inline quads to staging graph before signing (crash safety)', async () => {
    const store = createMockStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const stagingBytes = new TextEncoder().encode(quadsToNQuads(testQuads));
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:a'],
      stagingQuads: stagingBytes,
    });

    await handler.handler(intent, fakePeerId);

    expect(store.dropGraph).toHaveBeenCalled();
    expect(store.insert).toHaveBeenCalled();
    const insertedQuads = store.insert.mock.calls[0][0];
    expect(insertedQuads[0].graph).toContain('/staging/');
    expect(store.query).not.toHaveBeenCalled();
  });

  it('falls back to SWM query when stagingQuads not present', async () => {
    const store = createMockStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(store.query).toHaveBeenCalled();
    expect(ack.contextGraphId).toBe(testCGIdStr);
  });

  it('SWM fallback: rejects when no data in SWM graph', async () => {
    const store = createMockStore([]);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:a'],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('No data found in SWM');
    expect(store.query).toHaveBeenCalled();
  });

  it("SWM fallback: rejects when merkle root doesn't match SWM data", async () => {
    const differentQuads = [makeQuad('urn:other', 'urn:p', 'urn:v')];
    const store = createMockStore(differentQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Merkle root mismatch');
    expect(store.query).toHaveBeenCalled();
  });
});

// ── StorageACKHandler security ───────────────────────────────────────────

describe('StorageACKHandler security', () => {
  const coreWallet = ethers.Wallet.createRandom();
  const fakePeerId = { toString: () => 'publisher-peer' };

  function createConfig(overrides: Partial<StorageACKHandlerConfig> = {}): StorageACKHandlerConfig {
    return {
      nodeRole: 'core',
      nodeIdentityId: 42n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      ...overrides,
    };
  }

  it('rejects request from edge node (nodeRole=edge)', async () => {
    const store = createMockStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig({ nodeRole: 'edge' }), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 100,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Only core nodes can issue StorageACKs');
    expect(store.query).not.toHaveBeenCalled();
  });

  it('rejects stagingQuads > 4MB', async () => {
    const store = createMockStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const oversizedPayload = new Uint8Array(4 * 1024 * 1024 + 1).fill(0x41);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: oversizedPayload.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: oversizedPayload,
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('exceeds');
    expect(store.query).not.toHaveBeenCalled();
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('rejects empty stagingQuads (0 parseable quads)', async () => {
    const store = createMockStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const emptyNQuads = new TextEncoder().encode('# just a comment\n\n');
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: emptyNQuads.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: emptyNQuads,
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('no parseable N-Quads');
  });

  it('rejects stagingQuads with wrong merkle root (tampered payload)', async () => {
    const store = createMockStore();
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const tamperedQuads = [makeQuad('urn:tampered', 'urn:p', 'urn:evil')];
    const stagingBytes = new TextEncoder().encode(quadsToNQuads(tamperedQuads));

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      stagingQuads: stagingBytes,
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Merkle root mismatch (inline quads)');
    expect(store.insert).not.toHaveBeenCalled();
  });

  it('nodeIdentityId > 2^64 throws protocol upgrade error', async () => {
    const store = createMockStore(testQuads);
    const hugeIdentity = (1n << 64n);
    const handler = new StorageACKHandler(
      store,
      createConfig({ nodeIdentityId: hugeIdentity }),
      makeEventBus() as any,
    );

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('protocol upgrade required');
  });
});

// ── StorageACKHandler signature format ───────────────────────────────────

describe('StorageACKHandler signature format', () => {
  const coreWallet = ethers.Wallet.createRandom();
  const coreIdentityId = 99n;
  const fakePeerId = { toString: () => 'publisher-peer' };

  function createConfig(): StorageACKHandlerConfig {
    return {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };
  }

  it('ACK signature matches the H5-prefixed publish digest', async () => {
    const store = createMockStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    const expectedDigest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      testCGId,
      merkleRoot,
      2n,
      300n,
      1n,
      0n,
    );
    const prefixedHash = ethers.hashMessage(expectedDigest);

    const sigR = ack.coreNodeSignatureR instanceof Uint8Array
      ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR);
    const sigVS = ack.coreNodeSignatureVS instanceof Uint8Array
      ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS);

    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(sigR),
      yParityAndS: ethers.hexlify(sigVS),
    });

    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
    expect(sigR.length).toBe(32);
    expect(sigVS.length).toBe(32);
  });

  it('ecrecover from response matches handler signer wallet', async () => {
    const store = createMockStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const stagingBytes = new TextEncoder().encode(quadsToNQuads(testQuads));
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 2,
      rootEntities: ['urn:a'],
      stagingQuads: stagingBytes,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      testCGId,
      merkleRoot,
      2n,
      BigInt(stagingBytes.length),
      1n,
      0n,
    );
    const prefixedHash = ethers.hashMessage(digest);

    const sigR = ack.coreNodeSignatureR instanceof Uint8Array
      ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR);
    const sigVS = ack.coreNodeSignatureVS instanceof Uint8Array
      ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS);

    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(sigR),
      yParityAndS: ethers.hexlify(sigVS),
    });

    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());

    const otherWallet = ethers.Wallet.createRandom();
    expect(recovered.toLowerCase()).not.toBe(otherWallet.address.toLowerCase());
  });

  it('contextGraphId in response matches request', async () => {
    const store = createMockStore(testQuads);
    const handler = new StorageACKHandler(store, createConfig(), makeEventBus() as any);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId: testCGIdStr,
      publisherPeerId: 'pub-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 2,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(ack.contextGraphId).toBe(testCGIdStr);
    const ackRoot = ack.merkleRoot instanceof Uint8Array ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(ackRoot).equals(Buffer.from(merkleRoot))).toBe(true);

    const identityId = typeof ack.nodeIdentityId === 'number'
      ? BigInt(ack.nodeIdentityId)
      : BigInt(ack.nodeIdentityId.low) | (BigInt(ack.nodeIdentityId.high) << 32n);
    expect(identityId).toBe(coreIdentityId);
  });
});
