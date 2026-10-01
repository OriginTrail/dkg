import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { BlazegraphStore, OxigraphStore, StoreResponseTooLargeError, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { SyncVerifyWorker } from '../src/sync-verify-worker.js';
import { registerSyncHandler, type ExperimentalExactBatchResponderResources } from '../src/sync/responder/sync-handler.js';
import { createExactBatchResponderBinding } from '../src/sync/responder/exact-batch-stream.js';
import { parseResponderAssetMetadata } from '../src/sync/responder/asset-metadata.js';
import { consumeExactBatchVerifiedSession, exchangeExactBatchVerified, exactBatchStartFrame, type ExactBatchAgentSession } from '../src/sync/requester/exact-batch-stream.js';
import { authenticateVerifiedGraphScopedAsset, materializeVerifiedGraphScopedAsset } from '../src/sync/requester/graph-scoped-materialization.js';
import { EXACT_BATCH_FRAME_KIND as K, EXACT_BATCH_MAX_FRAME_BYTES, decodeExactBatchFrames, encodeExactBatchFrame, type ExactBatchFrame } from '../src/sync/exact-batch-stream-contract.js';
import { decodeNegotiatedExactSyncResponse, isExactSyncGzipFrame } from '../src/sync/wire-compression.js';

/** Module integration fixture, not a live-chain or encrypted-network benchmark. */
async function fixture(assetCount = 10, rows = 2000) {
  const contextGraphId = 'exact-batch-public';
  const items = Array.from({ length: assetCount }, (_, n) => {
    const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/${n + 1}`;
    const graph = knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, 1));
    const data: Quad[] = Array.from({ length: rows }, (_, i) => ({ graph, subject: `urn:batch:asset:${n}:row:${i}`,
      predicate: 'urn:batch:value', object: JSON.stringify(`${'public repeated value '.repeat(8)}${createHash('sha256').update(`${n}:${i}`).digest('hex')}`) }));
    const root = computeFlatKCRootV10(data, []);
    const meta = generateGraphKnowledgeAssetMetadata({ ual, contextGraphId, assertionGraph: graph, assertionVersion: '1', merkleRoot: root,
      publisherPeerId: 'fixture-core', accessPolicy: 'public', timestamp: new Date(0), publicTripleCount: rows, privateTripleCount: 0 },
      { status: 'confirmed', confirmation: { kind: 'finalized-materialization', provenance: { batchId: (0xabn << 96n) | BigInt(n + 1), materializedVersion: { blockNumber: 123, txIndex: 0 } } } });
    return { ual, graph, root, data, meta, kaId: (0xabn << 96n) | BigInt(n + 1) };
  }).sort((a, b) => a.ual.localeCompare(b.ual));
  const backing = new OxigraphStore(), target = new OxigraphStore();
  await backing.insert(items.flatMap(item => [...item.data, ...item.meta]));
  function cell(value: string) {
    if (!value.startsWith('"')) return { type: 'uri', value };
    const match = /^("(?:[^"\\]|\\.)*")(?:(?:\^\^<([^>]+)>)|@([\w-]+))?$/.exec(value);
    if (!match) throw new Error('Invalid fixture literal');
    return { type: 'literal', value: JSON.parse(match[1]!), ...(match[2] ? { datatype: match[2] } : {}), ...(match[3] ? { 'xml:lang': match[3] } : {}) };
  }
  const server = createServer(async (req, res) => {
    try {
      const pieces: Buffer[] = []; let bytes = 0;
      for await (const piece of req) { bytes += piece.length; if (bytes > 1_048_576) throw new Error('Fixture request limit'); pieces.push(Buffer.from(piece)); }
      const result = await backing.query(Buffer.concat(pieces).toString('utf8'));
      if (result.type !== 'bindings') throw new Error('Fixture SELECT only');
      res.setHeader('Content-Type', 'application/sparql-results+json');
      res.end(JSON.stringify({ head: { vars: Object.keys(result.bindings[0] ?? {}) }, results: { bindings: result.bindings.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)]))) } }));
    } catch { res.statusCode = 500; res.end('fixture-query-failure'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server absent');
  const store = new BlazegraphStore(`http://127.0.0.1:${address.port}/sparql`);
  const reads: string[] = [], query = store.query.bind(store);
  vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => { reads.push(options?.source ?? 'unknown'); return query(sparql, options); });
  const parse = vi.fn((bytes: Uint8Array) => ContextGraphResolveMethods.prototype.parseSyncRequest.call({
    parsePipeDelimitedSyncRequest: ContextGraphResolveMethods.prototype.parsePipeDelimitedSyncRequest,
  } as never, bytes));
  const publicAgent = { isPrivateContextGraph: vi.fn(async () => false) };
  // The real normal authorizer intentionally allows public CG reads. A signed
  // START uses the real digest/builder, not a synthetic authorize()=>true port.
  const authorize = vi.fn((request, peer, options) => ContextGraphResolveMethods.prototype.authorizeSyncRequest.call(publicAgent as never, request, peer, options));
  const isPublic = vi.fn(async (cg: string) => cg === contextGraphId);
  let resources!: ExperimentalExactBatchResponderResources;
  let legacyHandler!: (bytes: Uint8Array, peer: string, options?: { signal?: AbortSignal }) => Promise<Uint8Array>;
  registerSyncHandler({ register: (_protocol, handler) => { legacyHandler = handler; }, protocolSync: '/fixture/legacy-sync', syncDeniedResponse: 'denied', syncPageSize: 500,
    sharedMemoryTtlMs: 0, store, peerId: 'source', parseSyncRequest: parse, authorizeSyncRequest: authorize, logWarn: () => {}, logDebug: () => {},
    contextGraphPriorities: { [contextGraphId]: 100 }, onExperimentalExactBatchResources: captured => { resources = captured; } });
  const exportCache = resources.exportCache;
  const exportCounts: number[] = [];
  const payloadSizes: Array<{ plain: number; encoded: number }> = [];
  const responderStage = vi.fn((_stage: string, _assetIndex: number, _durationMs: number) => {});
  const responderFallback = vi.fn((_reason: string, _assetIndex: number, _context: unknown, _budgetReason?: string) => {});
  // The exact SAME legacy cache and admission limiter guard this binding.
  const binding = createExactBatchResponderBinding({ localPeerId: 'source', store, exportCache, parseSyncRequest: parse, authorizeSyncRequest: authorize, isPublicContextGraph: isPublic,
    admission: resources, onStage: responderStage, onFallback: responderFallback,
    onExport: (_index, count) => exportCounts.push(count),
    onPayload: (_index, plain, encoded) => payloadSizes.push({ plain, encoded }) });
  const wallet = ethers.Wallet.createRandom();
  const signed = await buildSyncRequestEnvelope({ contextGraphId, offset: 0, limit: 500, includeSharedMemory: false, targetPeerId: 'source', requesterPeerId: 'requester',
    phase: 'data', assetUals: items.map(item => item.ual), needsAuth: true, getIdentityId: async () => 1n,
    computeSyncDigest: (...args) => ContextGraphResolveMethods.prototype.computeSyncDigest.call({} as never, ...args),
    signMessage: async digest => { const signature = ethers.Signature.from(await wallet.signMessage(digest)); return { r: ethers.getBytes(signature.r), vs: ethers.getBytes(signature.yParityAndS) }; },
  });
  const byId = new Map(items.map(item => [item.kaId, item]));
  const chainReads: string[] = [];
  // Deterministic canonical chain views are the sole authority fixture here.
  const chain = { chainId: 'hardhat:31337',
    getLatestMerkleRoot: async (id: bigint) => { chainReads.push('root'); return byId.get(id)!.root; },
    getMerkleRootCount: async (_id: bigint) => { chainReads.push('version'); return 1n; },
    getKAContextGraphId: async (_id: bigint) => { chainReads.push('CG'); return 14n; },
  } as unknown as ChainAdapter;
  const worker = new SyncVerifyWorker();
  const applied: string[] = [];
  const receiver = { contextGraphId, assetUals: items.map(item => item.ual), ctx: { operationId: 'batch-fixture', operationName: 'sync' },
    parseAndFilter: worker.parseAndFilter.bind(worker),
    processDurableBatchInWorker: async (data, meta, _ctx, accept, mode) => worker.processDurableBatch(data, meta, accept, mode),
    authenticationDeadline: () => Date.now() + 30_000,
    storeGraphScopedAsset: async ({ asset, signal }) => {
      const authenticated = await authenticateVerifiedGraphScopedAsset(chain, asset, async (cg, id) => cg === contextGraphId && id === 14n, new Date(), { signal });
      const outcome = await materializeVerifiedGraphScopedAsset({ store: target, asset: authenticated.asset, options: { signal } });
      if (outcome === 'applied') applied.push(asset.ual); return outcome;
    },
  } satisfies Parameters<typeof consumeExactBatchVerifiedSession>[1];
  return { items, contextGraphId, backing, store, target, binding, signed, receiver, reads, chainReads, applied, exportCache, authorize, parse, isPublic, resources, legacyHandler, exportCounts, payloadSizes, responderStage, responderFallback,
    async close() { await worker.close(); vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await backing.close(); await target.close(); } };
}

/** Actual byte codec with adversarial physical chunk boundaries; no network claim. */
function duplex(assetUals: readonly string[], transform?: (frame: ExactBatchFrame) => ExactBatchFrame) {
  const controller = new AbortController();
  const sent: ExactBatchFrame[][] = [[], []];
  function pipe() {
    const queue: Uint8Array[] = []; let wake: (() => void) | undefined;
    controller.signal.addEventListener('abort', () => wake?.(), { once: true });
    return { push(bytes: Uint8Array) { for (let offset = 0; offset < bytes.length; offset += 31_337) queue.push(bytes.slice(offset, offset + 31_337)); wake?.(); wake = undefined; },
      async *source() { while (true) { controller.signal.throwIfAborted(); if (queue.length) yield queue.shift()!; else await new Promise<void>(resolve => { wake = resolve; }); } } };
  }
  const pipes = [pipe(), pipe()];
  const sessions = [0, 1].map(index => {
    const decoded = decodeExactBatchFrames(pipes[index]!.source(), { signal: controller.signal });
    return { windowSize: 2, signal: controller.signal, assetUals,
      async next() { const result = await decoded.next(); return result.done ? undefined : result.value; },
      async send(input: ExactBatchFrame) { controller.signal.throwIfAborted(); const outgoing = index === 1 && transform ? transform(input) : input; sent[index]!.push(outgoing); pipes[1 - index]!.push(encodeExactBatchFrame(outgoing)); },
    } satisfies ExactBatchAgentSession;
  });
  return { client: sessions[0]!, server: sessions[1]!, sent, abort(cause?: unknown) { controller.abort(cause ?? new Error('Fixture complete')); } };
}

async function run(f: Awaited<ReturnType<typeof fixture>>, wire = duplex(f.receiver.assetUals), receiver = f.receiver) {
  await wire.client.send(exactBatchStartFrame(f.signed));
  const request = await wire.server.next(); if (!request) throw new Error('START absent');
  await f.binding.authorizeRequest(request.payload, 'requester', wire.server.signal);
  const sender = f.binding.respond(request.payload, wire.server, 'requester');
  const consumer = consumeExactBatchVerifiedSession(wire.client, receiver);
  try { return await Promise.all([sender, consumer]); } catch (error) {
    wire.abort(error); const settled = await Promise.allSettled([sender, consumer]);
    if (settled[1]!.status === 'rejected') throw settled[1]!.reason;
    throw error;
  }
}

describe('exact batch normal verifier/materializer binding', () => {
  it('binds batch metadata to the same envelope and full identity as the cache despite fetched row order changes', async () => {
    const f = await fixture(1, 20), wire = duplex(f.receiver.assetUals);
    try {
      const parsedReads: NonNullable<ReturnType<typeof parseResponderAssetMetadata>>[] = [];
      const acquire = vi.spyOn(f.exportCache, 'acquireEncoded');
      const query = vi.mocked(f.store.query), original = query.getMockImplementation()!;
      let metadataReads = 0;
      query.mockImplementation(async (sparql, options) => {
        const result = await original(sparql, options);
        if (result.type === 'bindings' && options?.source?.endsWith('.metadata')) {
          if (++metadataReads % 2 === 1) result.bindings.reverse();
          parsedReads.push(parseResponderAssetMetadata(result.bindings, { contextGraphId: f.contextGraphId, ual: f.items[0]!.ual })!);
        }
        return result;
      });
      await run(f, wire);
      const expected = parsedReads[0]!;
      expect(parsedReads.every(read => read.identity === expected.identity)).toBe(true);
      expect(parsedReads.every(read => read.confirmed.state === 'confirmed')).toBe(true);
      expect(expected.confirmed.state).toBe('confirmed');
      if (expected.confirmed.state !== 'confirmed') throw new Error('Confirmed fixture absent');
      expect(acquire).toHaveBeenCalledOnce();
      expect(acquire.mock.calls[0]![0]).toMatchObject({ expectedIdentity: expected.identity,
        graph: expected.confirmed.envelope.assertionGraph, expectedRows: expected.confirmed.envelope.publicTripleCount });
      expect((await acquire.mock.results[0]!.value)!.identity).toBe(expected.identity);
      // One batch header read and the unchanged before/after/completion cache fences.
      expect(metadataReads).toBe(4);
      expect(f.applied).toEqual(f.receiver.assetUals);
      expect(wire.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(1);
    } finally { wire.abort(); await f.close(); }
  });

  it('keeps embedded-store ordinary exact paging available without advertising the export-only stream', async () => {
    const f = await fixture(1, 1);
    try {
      const advertiseStream = vi.fn();
      let ordinary!: typeof f.legacyHandler;
      registerSyncHandler({ register: (_protocol, handler) => { ordinary = handler; },
        protocolSync: '/fixture/embedded-sync', syncDeniedResponse: 'denied', syncPageSize: 500,
        sharedMemoryTtlMs: 0, store: f.backing, peerId: 'source',
        parseSyncRequest: f.parse, authorizeSyncRequest: f.authorize,
        logWarn: () => {}, logDebug: () => {}, onExperimentalExactBatchResources: advertiseStream });
      expect(advertiseStream).not.toHaveBeenCalled();
      const body = await ordinary(f.signed, 'requester');
      const decoded = await decodeNegotiatedExactSyncResponse(body, { allowCompression: true });
      const text = new TextDecoder().decode(decoded.bytes);
      expect(text).toContain(f.items[0]!.data[0]!.subject);
      expect(text).toContain(f.items[0]!.graph);
      expect(text.split('\n').filter(line => line.trim() && !line.startsWith('#'))).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('imports10 distinct confirmed fixtureKAs with oneSTART, oneexport each, realgzip/root/count verification and atomic writes', async () => {
    const f = await fixture(), wire = duplex(f.receiver.assetUals);
    try {
      const [, result] = await run(f, wire);
      expect(result).toEqual({ complete: true, committedAssetUals: f.receiver.assetUals });
      expect(wire.sent[0]!.filter(frame => frame.kind === K.REQUEST)).toHaveLength(1);
      expect(wire.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(10);
      expect(wire.sent[1]!.filter(frame => frame.kind === K.META)).toHaveLength(10);
      expect(wire.sent[1]!.filter(frame => frame.kind === K.ASSET_END)).toHaveLength(10);
      expect(wire.sent[1]!.filter(frame => frame.kind === K.BATCH_END)).toHaveLength(1);
      expect(wire.sent[1]!.filter(frame => frame.kind === K.DATA).length).toBeGreaterThan(10);
      expect(f.exportCache.stats().exports).toBe(10);
      expect(f.exportCounts).toEqual(Array(10).fill(1));
      expect(f.responderFallback).not.toHaveBeenCalled();
      expect(f.payloadSizes).toHaveLength(10);
      expect(f.payloadSizes.every(size => size.plain > size.encoded && size.encoded > 0)).toBe(true);
      for (const stage of ['export', 'export-metadata-before', 'export-store-payload-query',
        'export-canonical-preparation-root', 'export-metadata-after']) {
        const observations = f.responderStage.mock.calls.filter(([observed]) => observed === stage);
        expect(observations).toHaveLength(10);
        expect(observations.map(([, index]) => index)).toEqual(Array.from({ length: 10 }, (_, index) => index));
        expect(observations.every(([, , duration]) => Number.isFinite(duration) && duration >= 0)).toBe(true);
      }
      expect(f.reads.filter(source => source === 'sync.responder.exactAssetExport.payload')).toHaveLength(10);
      expect(f.reads.some(source => source === 'sync.responder.readExactGraphRowsPage')).toBe(false);
      expect(f.authorize).toHaveBeenCalledOnce(); expect(f.parse).toHaveBeenCalledOnce();
      expect(f.chainReads.filter(stage => stage === 'root')).toHaveLength(10); expect(f.chainReads.filter(stage => stage === 'version')).toHaveLength(10); expect(f.chainReads.filter(stage => stage === 'CG')).toHaveLength(10);
      for (const item of f.items) {
        const body = await f.target.query(`SELECT ?s ?p ?o WHERE { GRAPH <${item.graph}> { ?s ?p ?o } }`);
        expect(body.type).toBe('bindings'); if (body.type !== 'bindings') throw new Error('Fixture result shape');
        const quads = body.bindings.map(row => ({ graph: item.graph, subject: row.s!, predicate: row.p!, object: row.o! }));
        expect(quads).toHaveLength(item.data.length); expect(computeFlatKCRootV10(quads, [])).toEqual(item.root);
      }
    } finally { wire.abort(); await f.close(); }
  }, 60_000);

  it.each(['byte-limit', 'row-limit', 'malformed-binding'] as const)(
    'keeps metadata %s refusal handling at the batch transport boundary', async kind => {
      const f = await fixture(1, 2), signal = new AbortController().signal;
      const session = { signal, windowSize: 2, assetUals: f.receiver.assetUals,
        send: vi.fn(async (_frame: ExactBatchFrame) => {}), next: vi.fn(async () => undefined) };
      try {
        const query = vi.mocked(f.store.query), original = query.getMockImplementation()!;
        query.mockImplementation(async (sparql, options) => {
          if (options?.source !== 'sync.responder.exactBatch.metadata') return original(sparql, options);
          expect(sparql).toContain('LIMIT 129');
          expect(options).toMatchObject({ priority: 'background', signal, maxResponseBytes: EXACT_BATCH_MAX_FRAME_BYTES });
          if (kind === 'byte-limit') throw new StoreResponseTooLargeError(EXACT_BATCH_MAX_FRAME_BYTES, EXACT_BATCH_MAX_FRAME_BYTES + 1);
          return { type: 'bindings', bindings: kind === 'row-limit'
            ? Array.from({ length: 129 }, () => ({ predicate: 'urn:overflow', object: '"value"' }))
            : [{ predicate: 'urn:missing-object' }] };
        });
        await f.binding.authorizeRequest(f.signed, 'requester', signal);
        const respond = f.binding.respond(f.signed, session, 'requester');
        if (kind === 'malformed-binding') {
          await expect(respond).rejects.toThrow('metadata malformed');
          expect(session.send).not.toHaveBeenCalled();
        } else {
          await expect(respond).resolves.toBeUndefined();
          expect(session.send).toHaveBeenCalledOnce();
          const refusal = session.send.mock.calls[0]![0];
          expect(refusal.kind).toBe(K.REFUSE);
          expect(new TextDecoder().decode(refusal.payload)).toBe('RESOURCE_LIMIT');
        }
        expect(f.exportCache.stats().exports).toBe(0);
        expect(f.reads.some(source => source.endsWith('.payload'))).toBe(false);
      } finally { await f.close(); }
    });

  it('never exports before normal authorization and public-only gates pass', async () => {
    const f = await fixture(1, 2);
    try {
      f.isPublic.mockResolvedValue(false);
      await expect(f.binding.authorizeRequest(f.signed, 'requester', new AbortController().signal)).rejects.toThrow('public');
      expect(f.authorize).toHaveBeenCalledOnce(); expect(f.exportCache.stats().exports).toBe(0);
    } finally { await f.close(); }
  });

  it.each(['throw', 'reject'] as const)('logs the operation and asset refusal without letting an observer %s change RESOURCE_LIMIT', async failure => {
    const f = await fixture(1, 2), wire = duplex(f.receiver.assetUals);
    const query = vi.mocked(f.store.query).getMockImplementation()!;
    vi.mocked(f.store.query).mockImplementation(async (sparql, options) => {
      if (options?.source?.endsWith('.payload')) throw new StoreResponseTooLargeError(8 * 1024 * 1024, 8 * 1024 * 1024 + 1);
      return query(sparql, options);
    });
    f.responderFallback.mockImplementation(() => {
      if (failure === 'throw') throw new Error('Observation failure');
      return Promise.reject(new Error('Observation failure'));
    });
    try {
      await expect(run(f, wire)).rejects.toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: [] });
      expect(f.responderFallback).toHaveBeenCalledExactlyOnceWith('store-byte-profile', 0,
        expect.objectContaining({ operationId: expect.any(String), operationName: 'sync' }), undefined);
      const refusal = wire.sent[1]!.find(frame => frame.kind === K.REFUSE)!;
      expect(new TextDecoder().decode(refusal.payload)).toBe('RESOURCE_LIMIT');
      expect(wire.sent[1]!.some(frame => frame.kind === K.META || frame.kind === K.DATA)).toBe(false);
      expect(wire.sent[0]!.some(frame => frame.kind === K.ACK)).toBe(false);
      expect(f.applied).toEqual([]);
      expect(f.resources.snapshotBudget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
    } finally { wire.abort(); await f.close(); }
  });

  it('repeats a warm revisionless transfer with no payload export and full normal chain verification and ACK', async () => {
    const f = await fixture(3, 30), cold = duplex(f.receiver.assetUals), warm = duplex(f.receiver.assetUals);
    try {
      await run(f, cold);
      const payloadReads = f.reads.filter(source => source === 'sync.responder.exactAssetExport.payload').length;
      const chainReads = f.chainReads.length;
      const metadataReads = f.reads.filter(source => source === 'sync.responder.exactAssetExport.metadata').length;
      await run(f, warm);
      expect(f.reads.filter(source => source === 'sync.responder.exactAssetExport.payload')).toHaveLength(payloadReads);
      expect(f.reads.filter(source => source === 'sync.responder.exactAssetExport.metadata')).toHaveLength(metadataReads + 6);
      expect(f.exportCounts).toEqual([1, 1, 1, 0, 0, 0]);
      expect(f.exportCache.stats()).toMatchObject({ exports: 3, encodedCacheHits: 3, encodedCacheEntries: 3 });
      expect(f.chainReads.length - chainReads).toBe(9);
      expect(f.applied).toEqual([...f.receiver.assetUals, ...f.receiver.assetUals]);
      expect(warm.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(3);
      expect(warm.sent[1]!.filter(frame => frame.kind === K.ASSET_END)).toHaveLength(3);
      expect(f.authorize).toHaveBeenCalledTimes(2);
    } finally { cold.abort(); warm.abort(); await f.close(); }
  });

  it('serves legacy missing-policy metadata cold and warm through fresh public CG authority and normal chain verification', async () => {
    const f = await fixture(1, 20), cold = duplex(f.receiver.assetUals), warm = duplex(f.receiver.assetUals);
    try {
      await f.backing.delete(f.items[0]!.meta.filter(quad => quad.predicate === 'http://dkg.io/ontology/accessPolicy'));
      await run(f, cold); await run(f, warm);
      expect(f.exportCounts).toEqual([1, 0]);
      expect(f.isPublic).toHaveBeenCalledTimes(9); // START, per-asset, and every metadata fence.
      expect(f.chainReads).toHaveLength(6);
      expect(f.applied).toEqual([...f.receiver.assetUals, ...f.receiver.assetUals]);
      expect(cold.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(1);
      expect(warm.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(1);
      expect(f.responderFallback).not.toHaveBeenCalled();
    } finally { cold.abort(); warm.abort(); await f.close(); }
  });

  it.each(['cold', 'warm'] as const)('stops legacy %s transfer before ASSET_END when CG authority changes at the final fence', async mode => {
    const f = await fixture(1, 20), wire = duplex(f.receiver.assetUals);
    try {
      await f.backing.delete(f.items[0]!.meta.filter(quad => quad.predicate === 'http://dkg.io/ontology/accessPolicy'));
      if (mode === 'warm') {
        const first = duplex(f.receiver.assetUals);
        try { await run(f, first); } finally { first.abort(); }
        f.applied.length = 0;
      }
      let reads = 0;
      f.isPublic.mockImplementation(async () => ++reads < (mode === 'cold' ? 5 : 4));
      await expect(run(f, wire)).rejects.toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: [], cause: { code: 'SYNC_EXACT_EXPORT_CHANGED' } });
      expect(wire.sent[1]!.some(frame => frame.kind === K.DATA)).toBe(true);
      expect(wire.sent[1]!.some(frame => frame.kind === K.ASSET_END)).toBe(false);
      expect(wire.sent[0]!.some(frame => frame.kind === K.ACK)).toBe(false);
      expect(f.applied).toEqual([]);
      expect(f.resources.snapshotBudget.stats().bytesEstimate).toBe(f.exportCache.stats().encodedCacheBytes);
    } finally { wire.abort(); await f.close(); }
  });

  it('checks public CG authority again before serving a retained body', async () => {
    const f = await fixture(1, 30), cold = duplex(f.receiver.assetUals), warm = duplex(f.receiver.assetUals);
    try {
      await run(f, cold);
      await f.binding.authorizeRequest(f.signed, 'requester', warm.server.signal);
      f.isPublic.mockResolvedValue(false);
      await expect(f.binding.respond(f.signed, warm.server, 'requester')).rejects.toThrow('public');
      expect(warm.sent[1]).toEqual([]);
      expect(f.exportCache.stats().encodedCacheHits).toBe(0);
      expect(f.reads.filter(source => source === 'sync.responder.exactAssetExport.payload')).toHaveLength(1);
    } finally { cold.abort(); warm.abort(); await f.close(); }
  });

  it('rejects corrupted warm bytes before commit without poisoning the next retained transfer', async () => {
    const f = await fixture(1, 30), cold = duplex(f.receiver.assetUals);
    const corrupt = duplex(f.receiver.assetUals, frame => {
      if (frame.kind !== K.DATA) return frame;
      const payload = frame.payload.slice(); payload[payload.length - 3] ^= 0xff;
      return { ...frame, payload };
    });
    const retry = duplex(f.receiver.assetUals);
    try {
      await run(f, cold);
      f.applied.length = 0;
      await expect(run(f, corrupt)).rejects.toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: [] });
      expect(corrupt.sent[0]!.some(frame => frame.kind === K.ACK)).toBe(false);
      expect(f.applied).toEqual([]);
      await run(f, retry);
      expect(f.applied).toEqual(f.receiver.assetUals);
      expect(retry.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(1);
      expect(f.reads.filter(source => source === 'sync.responder.exactAssetExport.payload')).toHaveLength(1);
    } finally { cold.abort(); corrupt.abort(); retry.abort(); await f.close(); }
  });

  it('accepts the ordinary public pipe START from an unregistered Edge without identity or signing work', async () => {
    const f = await fixture(2, 20), wire = duplex(f.receiver.assetUals);
    const getIdentityId = vi.fn(async () => 0n);
    const signMessage = vi.fn(async () => { throw new Error('Public fixture must not sign'); });
    try {
      f.signed = await buildSyncRequestEnvelope({ contextGraphId: f.contextGraphId, offset: 0, limit: 500,
        includeSharedMemory: false, targetPeerId: 'source', requesterPeerId: 'requester',
        phase: 'data', assetUals: f.receiver.assetUals, needsAuth: false, getIdentityId, signMessage,
        computeSyncDigest: (...args) => ContextGraphResolveMethods.prototype.computeSyncDigest.call({} as never, ...args) });
      expect(new TextDecoder().decode(f.signed).startsWith(`${f.contextGraphId}|0|500|data`)).toBe(true);
      await run(f, wire);
      expect(f.applied).toEqual(f.receiver.assetUals);
      expect(f.authorize).toHaveBeenCalledOnce(); expect(f.isPublic).toHaveBeenCalled();
      expect(getIdentityId).not.toHaveBeenCalled(); expect(signMessage).not.toHaveBeenCalled();
      expect(wire.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(2);
    } finally { wire.abort(); await f.close(); }
  });

  it.each(['throw', 'reject'] as const)('keeps applied prefix, ACK and completion when post-store/responder observations %s', async failure => {
    const f = await fixture(2, 20), wire = duplex(f.receiver.assetUals);
    const observe = () => {
      if (failure === 'throw') throw new Error('Fixture observer throws');
      return Promise.reject(new Error('Fixture observer rejects'));
    };
    f.responderStage.mockImplementation(observe);
    const receiver = { ...f.receiver,
      onStage: (stage: string) => stage === 'authenticate-and-store' ? observe() : undefined,
      onCommitted: observe };
    try {
      const [, result] = await run(f, wire, receiver);
      expect(result).toEqual({ complete: true, committedAssetUals: f.receiver.assetUals });
      expect(f.applied).toEqual(f.receiver.assetUals);
      expect(wire.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(2);
    } finally { wire.abort(); await f.close(); }
  });

  it.each(['requesterPeerId', 'targetPeerId'] as const)('refuses a signed START with mismatched optional %s before export', async claim => {
    const f = await fixture(1, 2);
    try {
      const parsed = JSON.parse(new TextDecoder().decode(f.signed));
      parsed[claim] = 'unrelated-peer';
      const changed = new TextEncoder().encode(JSON.stringify(parsed));
      await expect(f.binding.authorizeRequest(changed, 'requester', new AbortController().signal)).rejects.toThrow('peer claims');
      expect(f.authorize).not.toHaveBeenCalled(); expect(f.exportCache.stats().exports).toBe(0);
    } finally { await f.close(); }
  });

  it('rejects a corrupted bounded gzip body without ACK or local write', async () => {
    const f = await fixture(1, 50);
    const wire = duplex(f.receiver.assetUals, frame => {
      if (frame.kind !== K.DATA) return frame;
      const payload = frame.payload.slice(); payload[payload.length - 3] ^= 0xff; return { ...frame, payload };
    });
    try {
      await expect(run(f, wire)).rejects.toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: [] });
      expect(wire.sent[0]!.some(frame => frame.kind === K.ACK)).toBe(false); expect(f.applied).toEqual([]);
    } finally { wire.abort(); await f.close(); }
  });

  it('preserves a committed prefix when the next canonical chain binding fails', async () => {
    const f = await fixture(3, 20), wire = duplex(f.receiver.assetUals);
    const store = f.receiver.storeGraphScopedAsset;
    const receiver = { ...f.receiver, storeGraphScopedAsset: async request => {
      if (request.asset.ual === f.receiver.assetUals[1]) throw Object.assign(new Error('Canonical chain fixture CG mismatch'), { code: 'VM_CHAIN_CONTEXT_GRAPH_MISMATCH' });
      return store(request);
    } };
    try {
      await expect(run(f, wire, receiver)).rejects.toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: [f.receiver.assetUals[0]] });
      expect(f.applied).toEqual([f.receiver.assetUals[0]]);
      expect(wire.sent[0]!.filter(frame => frame.kind === K.ACK).map(frame => frame.assetIndex)).toEqual([0]);
      const second = await f.target.query(`SELECT (COUNT(*) AS ?count) WHERE { GRAPH <${f.items[1]!.graph}> { ?s ?p ?o } }`);
      expect(second.type === 'bindings' && second.bindings[0]?.count).toBe('"0"^^<http://www.w3.org/2001/XMLSchema#integer>');
    } finally { wire.abort(); await f.close(); }
  });

  it('accepts the existing bounded plaintext fallback without changing verification or ACK semantics', async () => {
    const f = await fixture(1, 1), wire = duplex(f.receiver.assetUals);
    try {
      await run(f, wire);
      const firstData = wire.sent[1]!.find(frame => frame.kind === K.DATA)!;
      // A one-row payload may still compress; force the permitted plaintext
      // path through the same real committer separately in the next session.
      const second = await fixture(1, 1);
      const plainWire = duplex(second.receiver.assetUals, frame => frame.kind === K.DATA
        ? { ...frame, payload: new TextEncoder().encode(`<${second.items[0]!.data[0]!.subject}> <${second.items[0]!.data[0]!.predicate}> ${second.items[0]!.data[0]!.object} <${second.items[0]!.graph}> .`) }
        : frame);
      try {
        await run(second, plainWire);
        expect(isExactSyncGzipFrame(plainWire.sent[1]!.find(frame => frame.kind === K.DATA)!.payload)).toBe(false);
        expect(plainWire.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(1);
        expect(firstData.payload.byteLength).toBeGreaterThan(0);
      } finally { plainWire.abort(); await second.close(); }
    } finally { wire.abort(); await f.close(); }
  });

  it.each(['cold', 'warm'] as const)('fences %s source metadata after chunks and before ASSET_END, releasing its physical export lease', async mode => {
    const f = await fixture(1, 30), wire = duplex(f.receiver.assetUals), acquire = f.exportCache.acquireEncoded.bind(f.exportCache);
    if (mode === 'warm') {
      const first = duplex(f.receiver.assetUals);
      try { await run(f, first); } finally { first.abort(); }
      f.applied.length = 0;
    }
    const released = vi.fn();
    vi.spyOn(f.exportCache, 'acquireEncoded').mockImplementation(async request => {
      const lease = await acquire(request); if (!lease) return null;
      return { ...lease, async assertCurrent() {
        await f.backing.insert([{ graph: f.items[0]!.meta[0]!.graph, subject: f.items[0]!.ual, predicate: 'urn:source:generation', object: '"changed"' }]);
        await lease.assertCurrent();
      }, release() { released(); lease.release(); } };
    });
    try {
      await expect(run(f, wire)).rejects.toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: [], cause: { code: 'SYNC_EXACT_EXPORT_CHANGED' } });
      expect(wire.sent[1]!.some(frame => frame.kind === K.DATA)).toBe(true);
      expect(wire.sent[1]!.some(frame => frame.kind === K.ASSET_END)).toBe(false);
      expect(wire.sent[0]!.some(frame => frame.kind === K.ACK)).toBe(false); expect(f.applied).toEqual([]); expect(released).toHaveBeenCalledOnce();
    } finally { wire.abort(); await f.close(); }
  });

  it('does not replay an authorized START binding and rejects wrong session scopes', async () => {
    const f = await fixture(1, 2), wire = duplex(f.receiver.assetUals);
    try {
      await run(f, wire);
      await expect(f.binding.respond(f.signed, wire.server, 'requester')).rejects.toThrow('not authorized');
      await f.binding.authorizeRequest(f.signed, 'requester', new AbortController().signal);
      await expect(f.binding.respond(f.signed, { ...wire.server, assetUals: [] }, 'requester')).rejects.toThrow('not authorized');
      expect(f.exportCache.stats().exports).toBe(1);
    } finally { wire.abort(); await f.close(); }
  });

  it('awaits the actual atomic writer after cancellation and records only settled partial progress', async () => {
    const f = await fixture(1, 15), wire = duplex(f.receiver.assetUals);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const replace = f.target.replaceGraphAndSubject.bind(f.target);
    vi.spyOn(f.target, 'replaceGraphAndSubject').mockImplementation(async (...args) => { entered(); await held; return replace(...args); });
    let settled = false;
    const operation = run(f, wire).finally(() => { settled = true; });
    const failure = expect(operation).rejects.toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: [f.receiver.assetUals[0]] });
    try {
      await started; wire.abort(new Error('Fixture cancellation during physical atomic write'));
      await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false); expect(f.applied).toEqual([]);
      release(); await failure; expect(f.applied).toEqual([f.receiver.assetUals[0]]);
      expect(wire.sent[0]!.some(frame => frame.kind === K.ACK)).toBe(false);
    } finally { release(); wire.abort(); await operation.catch(() => {}); await f.close(); }
  });

  it('preserves all physically applied KAs when outer transport close times out after ACK and BATCH_END', async () => {
    const f = await fixture(2, 12), wire = duplex(f.receiver.assetUals);
    try {
      await expect(exchangeExactBatchVerified(async consume => {
        await wire.client.send(exactBatchStartFrame(f.signed));
        const request = (await wire.server.next())!;
        await f.binding.authorizeRequest(request.payload, 'requester', wire.server.signal);
        await Promise.all([f.binding.respond(request.payload, wire.server, 'requester'), consume(wire.client)]);
        throw Object.assign(new Error('Fixture final transport close deadline'), { name: 'TimeoutError' });
      }, f.receiver)).rejects.toMatchObject({ code: 'EXACT_BATCH_PARTIAL', committedAssetUals: f.receiver.assetUals, cause: { name: 'TimeoutError' } });
      expect(f.applied).toEqual(f.receiver.assetUals);
      expect(wire.sent[0]!.filter(frame => frame.kind === K.ACK)).toHaveLength(2);
      expect(wire.sent[1]!.filter(frame => frame.kind === K.BATCH_END)).toHaveLength(1);
    } finally { wire.abort(); await f.close(); }
  });

  it('shares legacy per-peer admission and retains the response slot until commit ACK settles', async () => {
    const f = await fixture(1, 15), wire = duplex(f.receiver.assetUals);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const original = f.receiver.storeGraphScopedAsset;
    const receiver = { ...f.receiver, storeGraphScopedAsset: async request => { entered(); await held; return original(request); } };
    const streamed = run(f, wire, receiver);
    let legacySettled = false;
    let legacy: Promise<Uint8Array> | undefined;
    try {
      await started;
      legacy = f.legacyHandler(f.signed, 'requester').then(bytes => { legacySettled = true; return bytes; });
      await Promise.resolve(); await Promise.resolve();
      expect(f.authorize).toHaveBeenCalledOnce(); expect(legacySettled).toBe(false);
      release(); await streamed; await legacy;
      expect(f.authorize).toHaveBeenCalledTimes(2); expect(legacySettled).toBe(true);
      expect(f.resources.snapshotBudget.stats()).toEqual({ snapshots: 1, rows: 0,
        bytesEstimate: f.exportCache.stats().encodedCacheBytes });
      expect(f.exportCache.stats().encodedCacheEntries).toBe(1);
    } finally { release(); wire.abort(); await Promise.allSettled([streamed, ...(legacy ? [legacy] : [])]); await f.close(); }
  });
});
