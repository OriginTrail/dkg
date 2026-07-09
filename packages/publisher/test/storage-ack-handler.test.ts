import { afterEach, describe, it, expect, vi } from 'vitest';
import { StorageACKHandler, type StorageACKHandlerConfig } from '../src/storage-ack-handler.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
  computePrivateRootV10,
} from '../src/merkle.js';
import {
  encodePublishIntent, decodeStorageACK, computePublishACKDigest,
  isStorageACKDecline, STORAGE_ACK_DECLINE_CODES, computeCatalogRoot, Logger,
} from '@origintrail-official/dkg-core';
import { TypedEventBus, rebuildMetrics } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  InMemoryMetricExporter,
  AggregationTemporality,
} from '@opentelemetry/sdk-metrics';

// Test H5 prefix inputs — must match whatever `StorageACKHandlerConfig`
// carries so that the ACK digest the test computes equals the one the
// handler computes. The handler rejects non-numeric / zero CG ids
// (production guard), so the test CG id is a plain numeric string.
const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';
const TEST_ASSET_UAL = `did:dkg:evm:${TEST_CHAIN_ID}/${TEST_KAV10_ADDR}/7`;

function makeQuad(s: string, p: string, o: string, g = 'urn:test:swm'): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

/**
 * Wrap a REAL OxigraphStore so only the named ops throw the classic mid-
 * worker-restart oxigraph failure ('store is closed'); every other op keeps
 * hitting the live store. Mirrors `storeWithFailingOps` in
 * storage-ack-core-unavailable.test.ts — the curated-catalog store-failure
 * regressions below need the SAME real-store-with-armed-failure model so
 * they exercise the actual persist path (parse → verify → deleteByPattern →
 * insert) up to the failing store call.
 */
function storeWithFailingOps(
  base: OxigraphStore,
  failingOps: readonly ('query' | 'insert' | 'dropGraph' | 'deleteByPattern' | 'flush')[],
): TripleStore {
  return new Proxy(base as unknown as TripleStore, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && (failingOps as readonly string[]).includes(prop)) {
        return async () => {
          throw new Error('store is closed');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('StorageACKHandler', () => {
  afterEach(() => {
    Logger.setSink(null);
  });

  const contextGraphId = '42';
  const cgIdBigInt = 42n;

  const swmQuads: Quad[] = [
    makeQuad('urn:entity:1', 'urn:p', 'urn:o1'),
    makeQuad('urn:entity:1', 'urn:p', 'urn:o2'),
    makeQuad('urn:entity:2', 'urn:p', 'urn:o3'),
  ];
  const merkleRoot = computeFlatKCRoot(swmQuads, []);
  const swmMerkleLeafCount = computeFlatKCMerkleLeafCountV10(swmQuads, []);

  const coreWallet = ethers.Wallet.createRandom();
  const coreIdentityId = 42n;
  const fakePeerId = { toString: () => 'publisher-peer' };

  async function createHandler(
    storeQuads: Quad[],
    configOverrides: Partial<StorageACKHandlerConfig> = {},
  ) {
    const store = new OxigraphStore();

    const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
    if (storeQuads.length > 0) {
      await store.insert(
        storeQuads.map(q => ({ ...q, graph: swmGraph })),
      );
    }

    const config: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: coreIdentityId,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
      // Codex PR #608: default to "all test CGs are curated" so the
      // pre-existing `isEncryptedPayload` test cases keep exercising
      // the happy path; tests that need to assert the bypass-rejection
      // semantics override this explicitly.
      isCgCurated: async () => true,
      ...configOverrides,
    };

    return new StorageACKHandler(store as any, config, new TypedEventBus() as any);
  }

  it('returns valid StorageACK for matching data', async () => {
    const handler = await createHandler(swmQuads);
    // OT-RFC-44 / Design B: two member entities = ONE Knowledge Asset, so the
    // ACK digest signs kaCount=1 (the value the publisher submits on chain),
    // not the entity count. rootEntities still lists both member entities.
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(ack.contextGraphId).toBe(contextGraphId);

    const decodedRoot = ack.merkleRoot instanceof Uint8Array
      ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(decodedRoot).equals(Buffer.from(merkleRoot))).toBe(true);

    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      cgIdBigInt,
      merkleRoot,
      1n,
      300n,
      1n,
      1000n,
      BigInt(swmMerkleLeafCount),
    );
    const prefixedHash = ethers.hashMessage(digest);
    const recovered = ethers.recoverAddress(prefixedHash, {
      r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array
        ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
      yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array
        ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
    });
    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
  });

  it('does not emit a canonical lifecycle assetUal from an unverified PublishIntent field', async () => {
    const handler = await createHandler(swmQuads, {
      localPeerId: 'receiver-peer',
      ackHandlerDeadlineMs: 0,
    });
    const entries: string[] = [];
    Logger.setSink((entry) => entries.push(entry.message));
    const spoofedAssetUal = `did:dkg:evm:${TEST_CHAIN_ID}/${TEST_KAV10_ADDR}/999`;

    await handler.handler(encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
      assetUal: spoofedAssetUal,
    } as any), fakePeerId);

    expect(entries.some((message) => message.includes(`assetUal=${spoofedAssetUal}`))).toBe(false);
    expect(entries.some((message) => message.includes('stage=storage_ack'))).toBe(false);
  });

  it('emits receiver ACK lifecycle logs from the same ACK decision path', async () => {
    const resolveAssetUalForPublishIntent = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return TEST_ASSET_UAL;
    });
    const handler = await createHandler(swmQuads, {
      localPeerId: 'receiver-peer',
      ackHandlerDeadlineMs: 0,
      resolveAssetUalForPublishIntent,
    } as any);
    const entries: string[] = [];
    Logger.setSink((entry) => entries.push(entry.message));
    const spoofedAssetUal = `did:dkg:evm:${TEST_CHAIN_ID}/${TEST_KAV10_ADDR}/999`;

    const response = await handler.handler(encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
      assetUal: spoofedAssetUal,
    } as any), fakePeerId);

    expect(resolveAssetUalForPublishIntent).toHaveBeenCalled();
    expect(isStorageACKDecline(decodeStorageACK(response))).toBe(false);
    expect(entries).toContainEqual(expect.stringContaining(`assetUal=${TEST_ASSET_UAL}`));
    expect(entries.some((message) => message.includes(`assetUal=${spoofedAssetUal}`))).toBe(false);
  });

  it('bounds lifecycle assetUal resolution and still returns a valid ACK', async () => {
    const resolveAssetUalForPublishIntent = vi.fn(() => new Promise<string>(() => {}));
    const handler = await createHandler(swmQuads, {
      localPeerId: 'receiver-peer',
      ackHandlerDeadlineMs: 0,
      resolveAssetUalForPublishIntent,
    } as any);

    const response = await Promise.race<Uint8Array | 'timed-out'>([
      handler.handler(encodePublishIntent({
        merkleRoot,
        contextGraphId,
        publisherPeerId: 'publisher-0',
        publicByteSize: 300,
        isPrivate: false,
        kaCount: 1,
        rootEntities: ['urn:entity:1', 'urn:entity:2'],
        epochs: 1,
        tokenAmountStr: '1000',
        merkleLeafCount: swmMerkleLeafCount,
      }), fakePeerId),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 1_000)),
    ]);

    expect(response).not.toBe('timed-out');
    expect(resolveAssetUalForPublishIntent).toHaveBeenCalled();
    const ack = decodeStorageACK(response as Uint8Array);
    expect(isStorageACKDecline(ack)).toBe(false);
  });

  it('emits ackHandlerTotal{outcome} through the REAL handler (ack + decline paths)', async () => {
    // Review coverage gap: the inbound storage-ACK outcome metric is a separate
    // contract from ACKCollector's — drive the real handler and assert it.
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const mp = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })] });
    metrics.setGlobalMeterProvider(mp);
    rebuildMetrics();
    try {
      const handler = await createHandler(swmQuads);
      const base = {
        merkleRoot, contextGraphId, publisherPeerId: 'publisher-0', isPrivate: false,
        kaCount: 1, rootEntities: ['urn:entity:1', 'urn:entity:2'], epochs: 1,
        tokenAmountStr: '1000', merkleLeafCount: swmMerkleLeafCount,
      };
      // ACK path (valid byte size) then DECLINE path (byteSize=1 → underclaim).
      await handler.handler(encodePublishIntent({ ...base, publicByteSize: 300 }), fakePeerId);
      await handler.handler(encodePublishIntent({ ...base, publicByteSize: 1 }), fakePeerId);

      await mp.forceFlush();
      const pts: Array<Record<string, unknown>> = [];
      for (const rm of exporter.getMetrics())
        for (const sm of rm.scopeMetrics)
          for (const m of sm.metrics)
            if (m.descriptor.name === 'dkg.ack.handler.total')
              for (const dp of m.dataPoints) pts.push(dp.attributes as Record<string, unknown>);

      expect(pts.some((a) => a.outcome === 'ack')).toBe(true);
      expect(pts.some((a) => a.outcome === 'decline' && a.decline_code === STORAGE_ACK_DECLINE_CODES.BYTESIZE_UNDERCLAIM)).toBe(true);
      // Bounded labels only — no high-cardinality keys leak in.
      const keys = new Set(pts.flatMap((a) => Object.keys(a)));
      for (const bad of ['peer_id', 'operation_id', 'tx_hash', 'context_graph_id']) expect(keys.has(bad)).toBe(false);
    } finally {
      await mp.forceFlush().catch(() => {});
      await mp.shutdown().catch(() => {});
      metrics.disable();
      rebuildMetrics();
    }
  });

  it('returns valid StorageACK for folded public+private data using private root commitments', async () => {
    const publicQuads: Quad[] = [
      makeQuad('urn:entity:private-folded', 'urn:p', 'urn:public'),
    ];
    const privateQuads: Quad[] = [
      makeQuad('urn:entity:private-folded', 'urn:p', '"secret"'),
    ];
    const privateRoot = computePrivateRootV10(privateQuads)!;
    const foldedRoot = computeFlatKCRoot(publicQuads, [privateRoot]);
    const foldedLeafCount = computeFlatKCMerkleLeafCountV10(publicQuads, [privateRoot]);
    const handler = await createHandler(publicQuads);

    const intent = encodePublishIntent({
      merkleRoot: foldedRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: true,
      kaCount: 1,
      rootEntities: ['urn:entity:private-folded'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: foldedLeafCount,
      privateMerkleRoots: [privateRoot],
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(new Uint8Array(ack.merkleRoot)).toEqual(foldedRoot);

    const digest = computePublishACKDigest(
      TEST_CHAIN_ID,
      TEST_KAV10_ADDR,
      cgIdBigInt,
      foldedRoot,
      1n,
      300n,
      1n,
      1000n,
      BigInt(foldedLeafCount),
    );
    const recovered = ethers.recoverAddress(ethers.hashMessage(digest), {
      r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array
        ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
      yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array
        ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
    });
    expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
  });

  it('returns valid StorageACK for inline folded public+private stagingQuads', async () => {
    const publicQuads: Quad[] = [
      makeQuad('urn:entity:inline-private-folded', 'urn:p', 'urn:public', 'did:dkg:context-graph:42'),
    ];
    const privateQuads: Quad[] = [
      makeQuad('urn:entity:inline-private-folded', 'urn:p', '"secret"', 'did:dkg:context-graph:42'),
    ];
    const privateRoot = computePrivateRootV10(privateQuads)!;
    const foldedRoot = computeFlatKCRoot(publicQuads, [privateRoot]);
    const foldedLeafCount = computeFlatKCMerkleLeafCountV10(publicQuads, [privateRoot]);
    const stagingQuads = new TextEncoder().encode(
      publicQuads
        .map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`)
        .join('\n'),
    );
    const handler = await createHandler([]);

    const response = await handler.handler(encodePublishIntent({
      merkleRoot: foldedRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: stagingQuads.length,
      isPrivate: true,
      kaCount: 1,
      rootEntities: ['urn:entity:inline-private-folded'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: foldedLeafCount,
      stagingQuads,
      privateMerkleRoots: [privateRoot],
    }), fakePeerId);
    const ack = decodeStorageACK(response);

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(new Uint8Array(ack.merkleRoot)).toEqual(foldedRoot);
  });

  it('rejects inline folded public+private stagingQuads when private root commitment mismatches', async () => {
    const publicQuads: Quad[] = [
      makeQuad('urn:entity:inline-private-mismatch', 'urn:p', 'urn:public', 'did:dkg:context-graph:42'),
    ];
    const privateQuads: Quad[] = [
      makeQuad('urn:entity:inline-private-mismatch', 'urn:p', '"secret"', 'did:dkg:context-graph:42'),
    ];
    const privateRoot = computePrivateRootV10(privateQuads)!;
    const foldedRoot = computeFlatKCRoot(publicQuads, [privateRoot]);
    const foldedLeafCount = computeFlatKCMerkleLeafCountV10(publicQuads, [privateRoot]);
    const stagingQuads = new TextEncoder().encode(
      publicQuads
        .map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`)
        .join('\n'),
    );
    const wrongPrivateRoot = new Uint8Array(privateRoot);
    wrongPrivateRoot[0] ^= 0xff;
    const handler = await createHandler([]);

    await expect(handler.handler(encodePublishIntent({
      merkleRoot: foldedRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: stagingQuads.length,
      isPrivate: true,
      kaCount: 1,
      rootEntities: ['urn:entity:inline-private-mismatch'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: foldedLeafCount,
      stagingQuads,
      privateMerkleRoots: [wrongPrivateRoot],
    }), fakePeerId)).rejects.toThrow('Merkle root mismatch (inline quads)');
  });

  it('rejects private root commitments on curated/encrypted ACK mode', async () => {
    const privateRoot = computePrivateRootV10([
      makeQuad('urn:entity:curated-mode-mix', 'urn:p', '"secret"'),
    ])!;
    const handler = await createHandler([]);

    await expect(handler.handler(encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 1,
      isPrivate: true,
      kaCount: 1,
      rootEntities: ['urn:entity:curated-mode-mix'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
      isEncryptedPayload: true,
      privateMerkleRoots: [privateRoot],
    }), fakePeerId)).rejects.toThrow('privateMerkleRoots are only valid for folded-private public-CG ACKs');
  });

  it('declines (BYTESIZE_UNDERCLAIM) when publicByteSize is below the real content lower bound', async () => {
    // The 3 fixture triples have Σ(|s|+|p|+|o|) = 69, a strict lower bound on
    // any valid N-Quads serialization. A claim of 1 (the byteSize=1 cost dodge)
    // must be refused so the on-chain ask actually prices the real footprint.
    const handler = await createHandler(swmQuads);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 1,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);

    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.BYTESIZE_UNDERCLAIM);
    expect(decoded.declineMessage).toContain('under-claim');
  });

  it('signs a public ACK when publicByteSize meets the real content lower bound (boundary)', async () => {
    // Exactly the Σ term-length floor (69) is accepted — an honest publisher's
    // `publicByteSize == nquads.length` is always strictly above it.
    const handler = await createHandler(swmQuads);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 69,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(false);
  });

  it('byteSize floor is UTF-8 bytes — a UTF-16 code-unit count is rejected for non-ASCII content', async () => {
    // `publicByteSize` is a UTF-8 byte count; the floor must be too. With a
    // non-ASCII IRI, UTF-8 byte length > UTF-16 code-unit length, so a claim at
    // the (smaller) code-unit sum — which a JS `.length` floor would have wrongly
    // ACCEPTED — must be declined.
    const naQuads: Quad[] = [makeQuad('urn:s:日本', 'urn:p', 'urn:o:語')];
    const naRoot = computeFlatKCRoot(naQuads, []);
    const naLeafCount = computeFlatKCMerkleLeafCountV10(naQuads, []);
    const utf8Floor =
      Buffer.byteLength('urn:s:日本', 'utf8') +
      Buffer.byteLength('urn:p', 'utf8') +
      Buffer.byteLength('urn:o:語', 'utf8');
    const utf16Sum = 'urn:s:日本'.length + 'urn:p'.length + 'urn:o:語'.length;
    expect(utf8Floor).to.be.greaterThan(utf16Sum); // sanity: non-ASCII makes UTF-8 > UTF-16

    const handler = await createHandler(naQuads);
    const mk = (publicByteSize: number) =>
      encodePublishIntent({
        merkleRoot: naRoot,
        contextGraphId,
        publisherPeerId: 'publisher-0',
        publicByteSize,
        isPrivate: false,
        kaCount: 1,
        rootEntities: ['urn:s:日本'],
        epochs: 1,
        tokenAmountStr: '1000',
        merkleLeafCount: naLeafCount,
      });

    // Claim at the UTF-16 code-unit sum (< UTF-8 floor) → declined under-claim.
    const declined = decodeStorageACK(await handler.handler(mk(utf16Sum), fakePeerId));
    expect(isStorageACKDecline(declined)).toBe(true);
    expect(declined.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.BYTESIZE_UNDERCLAIM);
    // Claim at the UTF-8 floor → accepted.
    const accepted = decodeStorageACK(await handler.handler(mk(utf8Floor), fakePeerId));
    expect(isStorageACKDecline(accepted)).toBe(false);
  });

  it('inline path: byteSize floor is the EXACT serialized payload, not just term bytes', async () => {
    // When the publisher sends the payload inline (stagingQuads), the core has
    // the exact serialized bytes, so the floor is the full payload length — a
    // claim at the bare term-byte sum (which the loose lower bound accepted)
    // under-prices the real serialization (<>, separators, graph term, ` .`).
    const g = 'did:dkg:context-graph:42';
    const inlineQuads: Quad[] = [makeQuad('urn:s', 'urn:p', 'urn:o', g)];
    const nquadsStr = inlineQuads
      .map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`)
      .join('\n');
    const stagingBytes = new TextEncoder().encode(nquadsStr);
    const inlineRoot = computeFlatKCRoot(inlineQuads, []);
    const inlineLeaf = computeFlatKCMerkleLeafCountV10(inlineQuads, []);
    const termSum =
      Buffer.byteLength('urn:s', 'utf8') +
      Buffer.byteLength('urn:p', 'utf8') +
      Buffer.byteLength('urn:o', 'utf8');
    expect(stagingBytes.length).to.be.greaterThan(termSum); // serialization overhead exists

    const handler = await createHandler([]); // no SWM data; the payload is inline
    const mk = (publicByteSize: number) =>
      encodePublishIntent({
        merkleRoot: inlineRoot,
        contextGraphId,
        publisherPeerId: 'publisher-0',
        publicByteSize,
        isPrivate: false,
        kaCount: 1,
        rootEntities: ['urn:s'],
        epochs: 1,
        tokenAmountStr: '1000',
        merkleLeafCount: inlineLeaf,
        stagingQuads: stagingBytes,
      });

    // Claim at the term-byte sum (omits serialization overhead) → declined.
    const declined = decodeStorageACK(await handler.handler(mk(termSum), fakePeerId));
    expect(isStorageACKDecline(declined)).toBe(true);
    expect(declined.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.BYTESIZE_UNDERCLAIM);
    // Claim at the exact serialized byte length → accepted.
    const ok = decodeStorageACK(await handler.handler(mk(stagingBytes.length), fakePeerId));
    expect(isStorageACKDecline(ok)).toBe(false);
  });

  it('otReviewAgent #1408 P2a: a malformed term is a bad request, NOT a transient store outage', async () => {
    // A term with a SPARQL-breaking char (`|`) parses under the permissive
    // parseSimpleNQuads and hashes into a self-consistent merkle root, but is
    // not a valid store term. It must reset the stream (malformed request),
    // not be mislabeled as a retryable CORE_TEMPORARILY_UNAVAILABLE decline.
    const g = 'did:dkg:context-graph:42';
    const badQuads: Quad[] = [makeQuad('urn:s|bad', 'urn:p', 'urn:o', g)];
    const nquadsStr = badQuads
      .map((q) => `<${q.subject}> <${q.predicate}> <${q.object}> <${q.graph}> .`)
      .join('\n');
    const stagingBytes = new TextEncoder().encode(nquadsStr);
    const badRoot = computeFlatKCRoot(badQuads, []);
    const badLeaf = computeFlatKCMerkleLeafCountV10(badQuads, []);

    const handler = await createHandler([]); // inline payload; no SWM data
    const intent = encodePublishIntent({
      merkleRoot: badRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: stagingBytes.length,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:s|bad'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: badLeaf,
      stagingQuads: stagingBytes,
    });

    // Malformed → the persist validation throws (stream reset), it does NOT
    // return a signed ACK nor a transient store-unavailable decline.
    await expect(handler.handler(intent, fakePeerId)).rejects.toThrow(/unsafe|empty|iri/i);
  });

  it('declines (SIGNER_NOT_REGISTERED) when the signer is no longer confirmed registered', async () => {
    // PR #557: this used to throw, which the publisher saw as a libp2p
    // stream reset; now the handler returns a typed decline so the
    // collector can record the reason and skip retries against this
    // peer.
    const handler = await createHandler(swmQuads, {
      isSignerRegistered: async () => false,
    });
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
    expect(decoded.declineMessage).toContain('not confirmed on-chain');
  });

  it('declines (CORE_TEMPORARILY_UNAVAILABLE) when signer registration lookup fails — still refuses to sign', async () => {
    // Testnet dead-air fix: a THROWN lookup used to escape the handler,
    // which ProtocolRouter surfaced as a bare stream reset — the publisher
    // retried 3× and bucketed the peer as `no_response`. It now replies
    // with a transient in-band decline (fail-closed still holds: no ACK is
    // ever signed without a confirmed registration). The definitive
    // `registered === false` verdict keeps SIGNER_NOT_REGISTERED above.
    const lookupFailed = vi.fn();
    const unregistered = vi.fn();
    const handler = await createHandler(swmQuads, {
      isSignerRegistered: async () => { throw new Error('rpc unavailable'); },
      onSignerRegistrationLookupFailed: lookupFailed,
      onSignerUnregistered: unregistered,
    });
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1', 'urn:entity:2'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount: swmMerkleLeafCount,
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
    expect(decoded.declineMessage).toContain('signer registration lookup unavailable');
    // The raw RPC error stays off the wire — it only reaches the local hook.
    expect(decoded.declineMessage).not.toContain('rpc unavailable');
    expect(lookupFailed).toHaveBeenCalledOnce();
    expect(unregistered).not.toHaveBeenCalled();
  });

  it('declines (NO_DATA_IN_SWM) when SWM has no data', async () => {
    // PR #557: this is the exact #541 path. Used to throw → stream reset
    // → publisher retried 3× → quorum failed → on-chain
    // MinSignaturesRequirementNotMet. Now decline → publisher records
    // the reason and surfaces it in the final error.
    const handler = await createHandler([]);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1'],
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
    expect(decoded.declineMessage).toContain('No data found in SWM');
    expect(decoded.declineMessage).toContain('urn:entity:1');
  });

  it('calls the decline hook with typed, bounded details when returning a decline', async () => {
    const onDecline = vi.fn();
    const handler = await createHandler([], { onDecline });
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1'],
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);

    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
    expect(onDecline).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledWith({
      code: STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM,
      contextGraphId,
      message: expect.stringContaining('No data found in SWM'),
    });
    const details = onDecline.mock.calls[0]?.[0];
    expect(details.message.length).toBeLessThanOrEqual(240);
  });

  it('ignores decline hook failures and preserves the encoded decline', async () => {
    const handler = await createHandler([], {
      onDecline: async () => { throw new Error('logger unavailable'); },
    });
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1'],
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);

    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.NO_DATA_IN_SWM);
    expect(decoded.declineMessage).toContain('No data found in SWM');
  });

  it('declines (MERKLE_MISMATCH_IN_SWM) when SWM data does not match the publisher merkle root', async () => {
    const differentQuads = [makeQuad('urn:other', 'urn:p', 'urn:val')];
    const handler = await createHandler(differentQuads);

    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 300,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    const response = await handler.handler(intent, fakePeerId);
    const decoded = decodeStorageACK(response);
    expect(isStorageACKDecline(decoded)).toBe(true);
    expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(decoded.declineMessage).toContain('Merkle root mismatch');
  });

  // OT-RFC-38 / LU-5 — encrypted-payload branch for curated CGs.
  describe('isEncryptedPayload (curated catalog ACK path — OT-RFC-49)', () => {
    // OT-RFC-49 / WS-D — a curated ACK ships the PUBLIC `_catalog` N-quads
    // inline (plaintext — the catalog is public; the PRIVATE data is encrypted
    // for members only, off the ACK wire). The core REBUILDS the catalog root
    // over the inline catalog via `computeCatalogRoot(catalogCommittedLeaves(...))`
    // and DECLINEs `CATALOG_ROOT_MISMATCH` on disagreement — it does NOT blindly
    // sign over opaque bytes (the behaviour OT-RFC-49 deliberately reversed).
    //
    // `merkleRoot` is the PRIVATE flat-KC root the core cannot recompute (it
    // holds no plaintext) — it is trusted and signed verbatim, gated by the
    // independent `isCgCurated` oracle.
    const cgDid = `did:dkg:context-graph:${contextGraphId}`;
    const catalogTriples = [
      { subject: cgDid, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://www.w3.org/ns/dcat#Dataset' },
      { subject: cgDid, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#PrivateContextGraph' },
      { subject: cgDid, predicate: 'http://purl.org/dc/terms/identifier', object: `"${cgDid}"` },
    ];
    const catalogNquads = catalogTriples
      .map((t) => `<${t.subject}> <${t.predicate}> ${t.object.startsWith('"') ? t.object : `<${t.object}>`} .`)
      .join('\n');
    const catalogBytes = new TextEncoder().encode(catalogNquads);
    const expectedCatalog = computeCatalogRoot(catalogTriples);
    const catalogRoot = expectedCatalog.root;
    const catalogLeafCount = expectedCatalog.leafCount;
    // The publisher's claimed PRIVATE flat-KC root (the core trusts it).
    const claimedRoot = ethers.getBytes(ethers.keccak256(new TextEncoder().encode('test-private-root')));
    const claimedKaCount = 1;
    const claimedLeafCount = 9;
    const claimedEpochs = 2;
    const claimedTokenAmountStr = '5000';

    function curatedIntent(overrides: Record<string, unknown> = {}): Uint8Array {
      return encodePublishIntent({
        merkleRoot: claimedRoot,
        contextGraphId,
        publisherPeerId: 'curator-edge',
        publicByteSize: catalogBytes.length,
        isPrivate: true,
        kaCount: claimedKaCount,
        rootEntities: [],
        stagingQuads: catalogBytes,
        epochs: claimedEpochs,
        tokenAmountStr: claimedTokenAmountStr,
        merkleLeafCount: claimedLeafCount,
        isEncryptedPayload: true,
        catalogRoot,
        catalogLeafCount,
        ...overrides,
      });
    }

    it('rebuilds + verifies the catalog root, persists the catalog, and signs the catalog ACK digest', async () => {
      const handler = await createHandler([]);
      const response = await handler.handler(curatedIntent(), fakePeerId);
      const ack = decodeStorageACK(response);

      expect(isStorageACKDecline(ack)).toBe(false);
      const decodedRoot = ack.merkleRoot instanceof Uint8Array
        ? ack.merkleRoot : new Uint8Array(ack.merkleRoot);
      // The ACK carries the PRIVATE merkleRoot the publisher claimed.
      expect(Buffer.from(decodedRoot).equals(Buffer.from(claimedRoot))).toBe(true);

      // The digest is now signed over the CATALOG commitment (not ciphertext).
      const expectedDigest = computePublishACKDigest(
        TEST_CHAIN_ID,
        TEST_KAV10_ADDR,
        cgIdBigInt,
        claimedRoot,
        BigInt(claimedKaCount),
        BigInt(catalogBytes.length),
        BigInt(claimedEpochs),
        BigInt(claimedTokenAmountStr),
        BigInt(claimedLeafCount),
        catalogRoot,
        BigInt(catalogLeafCount),
        false,
      );
      const prefixedHash = ethers.hashMessage(expectedDigest);
      const recovered = ethers.recoverAddress(prefixedHash, {
        r: ethers.hexlify(ack.coreNodeSignatureR instanceof Uint8Array
          ? ack.coreNodeSignatureR : new Uint8Array(ack.coreNodeSignatureR)),
        yParityAndS: ethers.hexlify(ack.coreNodeSignatureVS instanceof Uint8Array
          ? ack.coreNodeSignatureVS : new Uint8Array(ack.coreNodeSignatureVS)),
      });
      expect(recovered.toLowerCase()).toBe(coreWallet.address.toLowerCase());
    });

    it('DECLINEs CATALOG_ROOT_MISMATCH when the rebuilt root != the claimed catalogRoot', async () => {
      const handler = await createHandler([]);
      const wrongRoot = ethers.getBytes(ethers.keccak256(new TextEncoder().encode('wrong-catalog-root')));
      const response = await handler.handler(curatedIntent({ catalogRoot: wrongRoot }), fakePeerId);
      const decoded = decodeStorageACK(response);
      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
    });

    it('DECLINEs CATALOG_ROOT_MISMATCH when the inline catalog byteSize != publicByteSize (pricing fraud)', async () => {
      const handler = await createHandler([]);
      const response = await handler.handler(
        curatedIntent({ publicByteSize: catalogBytes.length + 100 }),
        fakePeerId,
      );
      const decoded = decodeStorageACK(response);
      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
    });

    it('DECLINEs when the inline catalog stagingQuads is missing', async () => {
      const handler = await createHandler([]);
      const response = await handler.handler(
        curatedIntent({ stagingQuads: undefined, publicByteSize: 0 }),
        fakePeerId,
      );
      const decoded = decodeStorageACK(response);
      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CATALOG_ROOT_MISMATCH);
    });

    it('Codex PR #608: rejects isEncryptedPayload=true when the local curation oracle says the CG is PUBLIC', async () => {
      // The bypass we're plugging: a malicious publisher sets
      // `isEncryptedPayload=true` on a CG that is actually public so the core
      // would sign over a private `merkleRoot` it cannot verify. The oracle
      // reports "not curated" → handler MUST refuse before signing.
      const handler = await createHandler([], { isCgCurated: async () => false });
      await expect(handler.handler(curatedIntent(), fakePeerId)).rejects.toThrow(
        /isEncryptedPayload=true rejected.*PUBLIC \(not curated\)/,
      );
    });

    it('Codex PR #608: rejects isEncryptedPayload=true when the oracle returns null (curation unknown)', async () => {
      const handler = await createHandler([], { isCgCurated: async () => null });
      await expect(handler.handler(curatedIntent(), fakePeerId)).rejects.toThrow(
        /isEncryptedPayload=true rejected.*UNKNOWN/,
      );
    });

    it('Codex PR #608: rejects isEncryptedPayload=true when no curation oracle is wired (defensive default)', async () => {
      const handler = await createHandler([], { isCgCurated: undefined });
      await expect(handler.handler(curatedIntent(), fakePeerId)).rejects.toThrow(
        /no curation oracle wired/,
      );
    });

    it('honours the signer-registration gate (declines instead of signing when key is unregistered)', async () => {
      // Catalog is VALID, so the handler reaches the signing gate and declines
      // there (not earlier on a catalog mismatch).
      const handler = await createHandler([], { isSignerRegistered: async () => false });
      const response = await handler.handler(curatedIntent(), fakePeerId);
      const decoded = decodeStorageACK(response);
      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
    });

    // Build a curated handler over a REAL store whose named ops are armed to
    // throw the classic 'store is closed' mid-restart error, reusing the
    // curated fixtures above. The catalog is VALID (root/leaf/byteSize all
    // check out) so the handler reaches the `<cg>/_catalog` persist —
    // deleteByPattern + insert — which is the store-outage catch path this
    // regression pins (otReviewAgent #1408:650).
    async function curatedHandlerWithFailingStore(
      failingOps: readonly ('deleteByPattern' | 'insert' | 'flush')[],
      configOverrides: Partial<StorageACKHandlerConfig> = {},
    ) {
      const base = new OxigraphStore();
      const config: StorageACKHandlerConfig = {
        nodeRole: 'core',
        nodeIdentityId: coreIdentityId,
        signerWallet: coreWallet,
        contextGraphSharedMemoryUri: (cgId: string) =>
          `did:dkg:context-graph:${cgId}/_shared_memory`,
        chainId: TEST_CHAIN_ID,
        kav10Address: TEST_KAV10_ADDR,
        isCgCurated: async () => true,
        ...configOverrides,
      };
      return new StorageACKHandler(
        storeWithFailingOps(base, failingOps) as any,
        config,
        new TypedEventBus() as any,
      );
    }

    it('curated catalog persist / deleteByPattern throws → CORE_TEMPORARILY_UNAVAILABLE ("store unavailable"), NO signed ACK', async () => {
      // Dead-air regression: a curated encrypted publish with a VALID catalog
      // root whose `<cg>/_catalog` REPLACE (deleteByPattern) hits a closed
      // store used to throw out of the handler → stream reset → publisher
      // no_response. It must instead reply with the transient decline.
      const onDecline = vi.fn();
      const handler = await curatedHandlerWithFailingStore(['deleteByPattern'], { onDecline });
      const decoded = decodeStorageACK(await handler.handler(curatedIntent(), fakePeerId));

      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(decoded.declineMessage).toBe('store unavailable');
      // No signed ACK rides a decline — the signature fields stay empty.
      const r = decoded.coreNodeSignatureR instanceof Uint8Array
        ? decoded.coreNodeSignatureR : new Uint8Array(decoded.coreNodeSignatureR ?? []);
      expect(r.length).toBe(0);
      // Wire hygiene: the raw store error stays OFF the network...
      expect(decoded.declineMessage).not.toContain('store is closed');
      // ...but the local WARN hook still gets the real cause for the operator.
      expect(onDecline).toHaveBeenCalledOnce();
      expect(onDecline.mock.calls[0]?.[0]).toMatchObject({
        code: STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE,
        contextGraphId,
        message: expect.stringContaining('store is closed'),
      });
    });

    it('curated catalog persist / insert throws → CORE_TEMPORARILY_UNAVAILABLE ("store unavailable"), NO signed ACK', async () => {
      // Same durability invariant, second store call: the deletes succeed but
      // the catalog INSERT hits the closed store. Still a transient decline.
      const handler = await curatedHandlerWithFailingStore(['insert']);
      const decoded = decodeStorageACK(await handler.handler(curatedIntent(), fakePeerId));

      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(decoded.declineMessage).toBe('store unavailable');
      const r = decoded.coreNodeSignatureR instanceof Uint8Array
        ? decoded.coreNodeSignatureR : new Uint8Array(decoded.coreNodeSignatureR ?? []);
      expect(r.length).toBe(0);
    });

    it('otReviewAgent #1408 P1b: catalog persist FLUSH throws → transient decline, NO signed ACK (durability boundary before sign)', async () => {
      // The delete+insert succeed but the durability flush (forcing the write
      // past the debounced-flush window, so a worker respawn can't roll back
      // ACKed data) fails. We MUST decline rather than sign an ACK for data
      // that isn't guaranteed durable.
      const handler = await curatedHandlerWithFailingStore(['flush']);
      const decoded = decodeStorageACK(await handler.handler(curatedIntent(), fakePeerId));

      expect(isStorageACKDecline(decoded)).toBe(true);
      expect(decoded.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CORE_TEMPORARILY_UNAVAILABLE);
      expect(decoded.declineMessage).toBe('store unavailable');
      const r = decoded.coreNodeSignatureR instanceof Uint8Array
        ? decoded.coreNodeSignatureR : new Uint8Array(decoded.coreNodeSignatureR ?? []);
      expect(r.length).toBe(0);
    });
  });

  it('rejects non-core node role', async () => {
    const store = new OxigraphStore();
    const config: StorageACKHandlerConfig = {
      nodeRole: 'edge',
      nodeIdentityId: 1n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: () => 'urn:test',
      chainId: TEST_CHAIN_ID,
      kav10Address: TEST_KAV10_ADDR,
    };

    const handler = new StorageACKHandler(store as any, config, new TypedEventBus() as any);
    const intent = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-0',
      publicByteSize: 100,
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
    });

    await expect(handler.handler(intent, fakePeerId))
      .rejects.toThrow('Only core nodes can issue StorageACKs');
  });
});
