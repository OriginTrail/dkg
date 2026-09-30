import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  gzipBounded,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import { BlazegraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import {
  createUalOnlyExactAssetSelection,
  MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
} from '../src/sync/exact-assets.js';
import { filterExactAssetDurablePayload } from '../src/sync/requester/exact-durable-fetch.js';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import { serializeResponderRows } from '../src/sync/responder/graph-plan.js';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';
import { createBoundedExactAssetExportCache, EXACT_ASSET_EXPORT_MAX_STORE_BYTES } from '../src/sync/responder/exact-asset-export-cache.js';
import { verifySyncedData } from '../src/sync-verify-worker-impl.js';
import {
  decodeNegotiatedExactSyncResponse,
  encodeNegotiatedExactSyncResponse,
  EXACT_SYNC_GZIP_ENCODING,
  isExactSyncGzipFrame,
} from '../src/sync/wire-compression.js';

const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/7';
const CG = 'hostile-native-export';
const encoder = new TextEncoder();
const request = { phase: 'data', includeSharedMemory: false, assetUals: [UAL], responseEncoding: EXACT_SYNC_GZIP_ENCODING } as const;

function frame(raw: Uint8Array, overrides: { bytes?: number; rows?: number; compressed?: Uint8Array } = {}): Uint8Array {
  const compressed = overrides.compressed ?? gzipSync(raw);
  const result = new Uint8Array(20 + compressed.byteLength);
  result.set(encoder.encode('DKGZQ01\n'));
  const view = new DataView(result.buffer);
  view.setUint32(8, overrides.bytes ?? raw.byteLength);
  let rows = 0;
  for (const byte of raw) if (byte === 10) rows++;
  rows += raw.byteLength > 0 && raw.at(-1) !== 10 ? 1 : 0;
  view.setUint32(12, overrides.rows ?? rows);
  view.setUint32(16, compressed.byteLength);
  result.set(compressed, 20);
  return result;
}

function payload(rows = 20): Quad[] {
  const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(UAL, 1));
  return Array.from({ length: rows }, (_, index) => ({
    subject: `urn:native-export:subject:${index}`, predicate: 'urn:native-export:value',
    object: `"${'repeated-data-'.repeat(12)}${index}"`, graph,
  }));
}

function nquads(quads: readonly Quad[]): Uint8Array {
  return encoder.encode(serializeResponderRows(quads.map((quad) => ({ s: quad.subject, p: quad.predicate, o: quad.object, g: quad.graph }))));
}

describe('hostile compressed exact VM pages', () => {
  it('refuses a recognized compressed frame without negotiation', async () => {
    await expect(decodeNegotiatedExactSyncResponse(frame(nquads(payload())), { allowCompression: false })).rejects.toThrow(/Unnegotiated/);
  });

  it.each(['short-header', 'false-length', 'false-row-count', 'truncated-gzip', 'corrupted-gzip'] as const)(
    'fails closed for %s instead of decoding the bytes as plain N-Quads', async (kind) => {
      const raw = nquads(payload());
      let hostile = frame(raw);
      if (kind === 'short-header') hostile = hostile.slice(0, 12);
      if (kind === 'false-length') hostile = frame(raw, { bytes: raw.byteLength - 1 });
      if (kind === 'false-row-count') hostile = frame(raw, { rows: 1 });
      if (kind === 'truncated-gzip') hostile = frame(raw, { compressed: gzipSync(raw).subarray(0, gzipSync(raw).byteLength - 5) });
      if (kind === 'corrupted-gzip') hostile[hostile.length - 5] ^= 0xff;
      expect(isExactSyncGzipFrame(hostile)).toBe(true);
      await expect(decodeNegotiatedExactSyncResponse(hostile, { allowCompression: true })).rejects.toThrow();
    },
  );

  it('rejects a small gzip bomb at its claimed inflated length', async () => {
    const raw = encoder.encode(`${'x'.repeat(1_000_000)}\n`);
    const hostile = frame(raw, { bytes: 1024 });
    expect(hostile.byteLength).toBeLessThan(2048);
    await expect(decodeNegotiatedExactSyncResponse(hostile, { allowCompression: true })).rejects.toMatchObject({ code: 'BOUNDED_GZIP_LIMIT' });
  });

  it('rejects invalid UTF-8 even when all declared gzip lengths are correct', async () => {
    await expect(decodeNegotiatedExactSyncResponse(frame(Uint8Array.of(0xff, 10)), { allowCompression: true })).rejects.toThrow();
  });

  it('checks the remaining phase allowance before decompressing a valid page', async () => {
    const raw = nquads(payload());
    await expect(decodeNegotiatedExactSyncResponse(frame(raw), { allowCompression: true, maxInflatedBytes: raw.byteLength - 1 })).rejects.toThrow();
  });

  it('keeps old plain responses and plain empty EOF valid under negotiation', async () => {
    const raw = nquads(payload());
    expect(await decodeNegotiatedExactSyncResponse(raw, { allowCompression: true })).toMatchObject({ bytes: raw, compressed: false });
    expect(await decodeNegotiatedExactSyncResponse(new Uint8Array(), { allowCompression: true, maxInflatedBytes: 0 })).toMatchObject({ bytes: new Uint8Array(), compressed: false });
  });

  it('does not send compressed bodies to a peer that omitted the encoding capability', async () => {
    const raw = nquads(payload());
    expect(await encodeNegotiatedExactSyncResponse(raw, { request: { ...request, responseEncoding: undefined } })).toBe(raw);
  });

  it('retains exact selection and per-KA Merkle verification after decompression', async () => {
    const data = payload();
    const meta = generateGraphKnowledgeAssetMetadata({
      ual: UAL, contextGraphId: CG, assertionGraph: data[0]!.graph, assertionVersion: '1',
      merkleRoot: computeFlatKCRootV10(data, []), publisherPeerId: 'publisher-peer',
      accessPolicy: 'public', timestamp: new Date(0), publicTripleCount: data.length, privateTripleCount: 0,
    }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: { txHash: `0x${'11'.repeat(32)}`, batchId: 1n } } });
    const decoded = await decodeNegotiatedExactSyncResponse(frame(nquads(data)), { allowCompression: true });
    expect(Array.from(decoded.bytes)).toEqual(Array.from(nquads(data)));
    const selection = createUalOnlyExactAssetSelection([UAL]);
    const filtered = filterExactAssetDurablePayload(data, meta, selection);
    expect(filtered.descriptorCoverageComplete).toBe(true);
    expect(verifySyncedData(filtered.dataQuads, filtered.metaQuads).data).toEqual(data);
    const poisoned = data.map((quad, index) => index === 0 ? { ...quad, object: '"attacker-controlled"' } : quad);
    expect(verifySyncedData(poisoned, meta).data).toEqual([]);
    const foreign = filterExactAssetDurablePayload(data.map((quad) => ({ ...quad, graph: `${quad.graph}-foreign` })), meta, selection);
    expect(foreign.dataQuads).toEqual([]);
    const wrongAsset = createUalOnlyExactAssetSelection([UAL.replace('/7', '/8')]);
    expect(filterExactAssetDurablePayload(data, meta, wrongAsset).descriptorCoverageComplete).toBe(false);
  });

  it('drains cancelled native codecs and releases capacity for a subsequent valid operation', async () => {
    const controller = new AbortController();
    const raw = encoder.encode('x'.repeat(1_000_000));
    const options = { maxInputBytes: raw.byteLength, maxOutputBytes: raw.byteLength, timeoutMs: 5_000, signal: controller.signal };
    const pending = Array.from({ length: 4 }, () => gzipBounded(raw, options));
    await expect(gzipBounded(raw, options)).rejects.toMatchObject({ code: 'BOUNDED_GZIP_CAPACITY' });
    controller.abort(new DOMException('test cancelled', 'AbortError'));
    const settled = await Promise.allSettled(pending);
    expect(settled.every((item) => item.status === 'rejected')).toBe(true);
    expect(await gzipBounded(encoder.encode('ok'), { maxInputBytes: 2, maxOutputBytes: 100, timeoutMs: 5_000 })).toBeInstanceOf(Uint8Array);
  });
});

type FetchParams = Parameters<typeof fetchSyncPages>[0];
function fetchParams(overrides: Partial<FetchParams>): FetchParams {
  return {
    ctx: { operationId: 'hostile-native-export', operationName: 'sync' }, remotePeerId: 'test-source',
    contextGraphId: CG, includeSharedMemory: false, phase: 'data', graphUri: payload(1)[0]!.graph,
    deadline: Date.now() + 10_000, syncPageTimeoutMs: 1_000, syncRouterAttempts: 1, syncPageRetryAttempts: 1,
    syncPageSize: 8192, syncDeniedResponse: 'denied', debugSyncProgress: false, protocolSync: '/dkg/test/sync',
    checkpointStore: new MemorySyncCheckpointStore(), assetUals: [UAL], responseEncoding: EXACT_SYNC_GZIP_ENCODING,
    buildSyncRequest: async () => encoder.encode('request'),
    parseAndFilter: async () => ({ quads: payload(1), totalQuads: 1 }),
    send: async () => new Uint8Array(), logWarn: () => {}, logInfo: () => {}, logDebug: () => {},
    ...overrides,
  };
}

describe('compressed page requester ceilings', () => {
  it('caps cumulative wire bytes even when gzip zero padding decodes to tiny pages', async () => {
    const raw = nquads(payload(1));
    const paddedGzip = new Uint8Array(4 * 1024 * 1024 - 20);
    paddedGzip.set(gzipSync(raw));
    const body = frame(raw, { compressed: paddedGzip });
    const parse = vi.fn(async () => ({ quads: payload(1), totalQuads: 1 }));
    let sends = 0;
    await expect(fetchSyncPages(fetchParams({
      parseAndFilter: parse,
      send: async () => ++sends <= 5 ? body : new Uint8Array(),
    }))).rejects.toThrow();
    expect(sends).toBeLessThanOrEqual(5);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('charges cumulative inflated bytes before parsing the next page', async () => {
    const raw = nquads(payload());
    const body = frame(raw);
    const parse = vi.fn(async (_text: string, _graph: string, _cg: string) => ({ quads: payload(1), totalQuads: 1 }));
    let sends = 0;
    await expect(fetchSyncPages(fetchParams({
      maxAcceptedBytes: raw.byteLength + 1,
      parseAndFilter: parse,
      send: async () => ++sends <= 2 ? body : new Uint8Array(),
    }))).rejects.toThrow();
    expect(sends).toBe(2);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0]![0]).toBe(new TextDecoder().decode(raw));
  });

  it('does not let highly compressible data exceed the exact one-asset phase limit', async () => {
    const raw = encoder.encode(`<urn:s> <urn:p> "${'x'.repeat(MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET)}" <urn:g> .\n`);
    const parse = vi.fn(async () => ({ quads: [], totalQuads: 0 }));
    await expect(fetchSyncPages(fetchParams({
      maxAcceptedBytes: MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
      parseAndFilter: parse, send: async () => frame(raw),
    }))).rejects.toThrow();
    expect(parse).not.toHaveBeenCalled();
  });
});

function sparqlCell(value: string): Record<string, string> {
  if (value.startsWith('"')) {
    const literal = /^("(?:[^"\\]|\\.)*")(?:(?:\^\^<([^>]+)>)|@([\w-]+))?$/.exec(value);
    if (!literal) throw new Error(`Invalid test RDF literal: ${value}`);
    return { type: 'literal', value: JSON.parse(literal[1]!),
      ...(literal[2] ? { datatype: literal[2] } : {}), ...(literal[3] ? { 'xml:lang': literal[3] } : {}) };
  }
  return { type: 'uri', value };
}

async function httpExportFixture() {
  const data = payload(30);
  const meta = generateGraphKnowledgeAssetMetadata({
    ual: UAL, contextGraphId: CG, assertionGraph: data[0]!.graph, assertionVersion: '1',
    merkleRoot: computeFlatKCRootV10(data, []), publisherPeerId: 'publisher-peer', accessPolicy: 'public',
    timestamp: new Date(0), publicTripleCount: data.length, privateTripleCount: 0,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: { txHash: `0x${'11'.repeat(32)}`, batchId: 1n } } });
  const state = { payloadReads: 0, oversizedPayload: false };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const query = Buffer.concat(chunks).toString('utf8');
    const metadata = query.includes('SELECT ?predicate ?object');
    if (!metadata) state.payloadReads++;
    res.setHeader('Content-Type', 'application/sparql-results+json');
    if (!metadata && state.oversizedPayload) {
      res.end(' '.repeat(EXACT_ASSET_EXPORT_MAX_STORE_BYTES + 1));
      return;
    }
    const rows: Record<string, string>[] = metadata
      ? meta.map((quad) => ({ predicate: quad.predicate, object: quad.object }))
      : data.map((quad) => ({ s: quad.subject, p: quad.predicate, o: quad.object }));
    res.end(JSON.stringify({ head: { vars: Object.keys(rows[0]!) }, results: {
      bindings: rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sparqlCell(value)]))),
    } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test HTTP address');
  const store = new BlazegraphStore(`http://127.0.0.1:${address.port}/sparql`);
  const budget = createSyncResponderSnapshotBudget({ maxRows: 100_000, maxBytesEstimate: 384 * 1024 * 1024,
    maxSnapshotRows: 100_000, maxSnapshotBytesEstimate: 128 * 1024 * 1024 });
  const cache = createBoundedExactAssetExportCache({ store, budget });
  return { data, meta, state, cache, budget, request: { contextGraphId: CG, assetUal: UAL,
    graph: data[0]!.graph, expectedRows: data.length }, async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } };
}

describe('actual HTTP Blazegraph export boundary', () => {
  it('reloads bounded revisionless exports and detects metadata mutation before serving', async () => {
    const f = await httpExportFixture();
    try {
      const first = await f.cache.acquire(f.request);
      expect(first?.rows).toHaveLength(f.data.length);
      first!.release();
      const second = await f.cache.acquire({ ...f.request, expectedIdentity: first!.identity });
      expect(f.state.payloadReads).toBe(2);
      f.meta.push({ graph: f.meta[0]!.graph, subject: UAL, predicate: 'urn:local-control:changed', object: '"changed"' });
      await expect(second!.assertCurrent()).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      second!.release();
      expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
    } finally { await f.close(); }
  });

  it('refuses an actual oversized HTTP payload before JSON materialization and releases admission', async () => {
    const f = await httpExportFixture();
    try {
      f.state.oversizedPayload = true;
      expect(await f.cache.acquire(f.request)).toBeNull();
      expect(f.state.payloadReads).toBe(1);
      expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
    } finally { await f.close(); }
  });

  it('refuses a mismatched graph binding before any HTTP body export', async () => {
    const f = await httpExportFixture();
    try {
      await expect(f.cache.acquire({ ...f.request, graph: `${f.request.graph}-foreign` })).rejects.toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      expect(f.state.payloadReads).toBe(0);
      expect(f.budget.stats()).toEqual({ snapshots: 0, rows: 0, bytesEstimate: 0 });
    } finally { await f.close(); }
  });

  it('rotates a retained requester session after the actual export mutation error', async () => {
    const f = await httpExportFixture();
    try {
      const lease = await f.cache.acquire(f.request);
      f.meta.push({ graph: f.meta[0]!.graph, subject: UAL, predicate: 'urn:local-control:changed', object: '"changed"' });
      const sourceError = await lease!.assertCurrent().then(() => { throw new Error('Mutation went unnoticed'); }, (error) => error);
      expect(sourceError).toMatchObject({ code: 'SYNC_EXACT_EXPORT_CHANGED' });
      lease!.release();
      f.meta.pop();
      const tokens: Array<string | undefined> = [];
      const checkpointStore = new MemorySyncCheckpointStore();
      const base = fetchParams({ checkpointStore,
        buildSyncRequest: async (_cg, _offset, _limit, _swm, _peer, _phase, _snapshot, _since, token) => {
          tokens.push(token);
          return encoder.encode('request');
        } });
      await expect(fetchSyncPages({ ...base, send: async () => { throw sourceError; } })).rejects.toThrow(/sync session/i);
      await fetchSyncPages({ ...base, send: async () => new Uint8Array() });
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toBeTruthy();
      expect(tokens[1]).toBeTruthy();
      expect(tokens[1]).not.toBe(tokens[0]);
      expect(f.budget.stats().snapshots).toBe(0);
    } finally { await f.close(); }
  });
});

// Local certification uses an actually built, frozen 10.0.20 responder rather
// than another implementation of its parser. CI can supply a baseline build
// with this environment variable; the independent hostile suite above does
// not depend on a neighbouring checkout.
const oldDist = process.env.DKG_SYNC_COMPAT_OLD_AGENT_DIST;
describe.skipIf(!oldDist)('actual old20 parser compatibility', () => {
  async function oldParser() {
    const module = await import(/* @vite-ignore */ pathToFileURL(`${oldDist}/dkg-agent-cg-resolve.js`).href);
    return Object.create(module.ContextGraphResolveMethods.prototype) as { parseSyncRequest(data: Uint8Array): Record<string, unknown> };
  }
  it.each(['data', 'meta'] as const)('preserves exact public %s narrowing and ignores compression', async (phase) => {
    const wire = await buildSyncRequestEnvelope({
      contextGraphId: CG, offset: 17, limit: 8192, includeSharedMemory: false,
      targetPeerId: 'source', requesterPeerId: 'requester', phase, syncSessionId: 'retained-session',
      sinceBatchId: '42', assetUals: [UAL], needsAuth: false,
      computeSyncDigest: () => new Uint8Array(32), getIdentityId: async () => 0n,
    });
    const parsed = (await oldParser()).parseSyncRequest(wire);
    expect(parsed).toMatchObject({ contextGraphId: CG, offset: 17, limit: 500, phase,
      assetUals: [UAL], syncSessionId: 'retained-session', sinceBatchId: '42' });
    expect(parsed.responseEncoding).toBeUndefined();
  });

  it('keeps signed limit and old JSON authorization fields unchanged', async () => {
    const digest = vi.fn((..._args: unknown[]) => new Uint8Array(32));
    const wire = await buildSyncRequestEnvelope({
      contextGraphId: CG, offset: 17, limit: 8192, includeSharedMemory: false,
      targetPeerId: 'source', requesterPeerId: 'requester', phase: 'data', syncSessionId: 'retained-session',
      assetUals: [UAL], needsAuth: true, computeSyncDigest: digest, getIdentityId: async () => 1n,
      signMessage: async () => ({ r: new Uint8Array(32).fill(1), vs: new Uint8Array(32).fill(2) }),
    });
    const parsed = (await oldParser()).parseSyncRequest(wire);
    expect(parsed).toMatchObject({ contextGraphId: CG, offset: 17, limit: 500, phase: 'data',
      targetPeerId: 'source', requesterPeerId: 'requester', requesterIdentityId: '1', assetUals: [UAL] });
    expect(parsed.requesterSignatureR).toBeTruthy();
    expect(parsed.requesterSignatureVS).toBeTruthy();
    expect(parsed.responseEncoding).toBeUndefined();
    expect(digest.mock.calls[0]![2]).toBe(500);
  });
});
