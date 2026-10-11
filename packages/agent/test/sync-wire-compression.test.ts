import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { decodePipeSyncRequestTail } from '../src/sync/auth/pipe-request-tail.js';
import { exactSyncPhaseAccumulationLimits } from '../src/sync/exact-assets.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { fetchSyncPages, SyncPageSizeProfileCache } from '../src/sync/requester/page-fetch.js';
import {
  EXACT_SYNC_GZIP_ENCODING,
  EXACT_SYNC_GZIP_MAX_INFLATED_BYTES,
  decodeNegotiatedExactSyncResponse,
  encodeNegotiatedExactSyncResponse,
  isExactSyncGzipFrame,
  negotiatesExactSyncGzip,
} from '../src/sync/wire-compression.js';
import { parseOldSyncRequest } from './fixtures/sync-request-parser-10.0.20.fixture.js';

const UAL = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
const UAL_2 = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';
const encoder = new TextEncoder();
const request = { responseEncoding: EXACT_SYNC_GZIP_ENCODING, phase: 'data', includeSharedMemory: false, assetUals: [UAL] };
const rdf = encoder.encode(`<urn:s> <urn:p> "${'long repeated value '.repeat(1_000)}" <urn:g> .\n`);

function rawFrame(bytes: Uint8Array, rows = 1): Uint8Array {
  const compressed = gzipSync(bytes);
  const frame = new Uint8Array(20 + compressed.byteLength);
  frame.set(encoder.encode('DKGZQ01\n'));
  const view = new DataView(frame.buffer);
  view.setUint32(8, bytes.byteLength);
  view.setUint32(12, rows);
  view.setUint32(16, compressed.byteLength);
  frame.set(compressed, 20);
  return frame;
}

function params(needsAuth = false) {
  return {
    contextGraphId: 'mfacts', offset: 25, limit: 8_192,
    includeSharedMemory: false, targetPeerId: 'responder', requesterPeerId: 'requester',
    phase: 'data' as const, assetUals: [UAL], syncSessionId: 'session-1', sinceBatchId: '42',
    needsAuth, computeSyncDigest: vi.fn(() => new Uint8Array(32)),
    getIdentityId: async () => 1n,
    signMessage: async () => ({ r: new Uint8Array(32), vs: new Uint8Array(32) }),
  };
}

describe('exact sync negotiated gzip wire', () => {
  it('uses the unchanged N-Quads bytes, declared lengths and row count', async () => {
    const frame = await encodeNegotiatedExactSyncResponse(rdf, { request });
    expect(isExactSyncGzipFrame(frame)).toBe(true);
    expect(frame.byteLength).toBeLessThan(rdf.byteLength / 10);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    expect(view.getUint32(8)).toBe(rdf.byteLength);
    expect(view.getUint32(12)).toBe(1);
    expect(view.getUint32(16)).toBe(frame.byteLength - 20);
    expect(await decodeNegotiatedExactSyncResponse(frame, { allowCompression: true }))
      .toEqual({ bytes: rdf, compressed: true, rows: 1 });
  });

  it('old public pipe parser preserves exact narrowing, cursor and page hints from the actual new builder', async () => {
    const wire = await buildSyncRequestEnvelope(params());
    const text = new TextDecoder().decode(wire);
    expect(text).toContain('|data|response-encoding|gzip-nquads-v1|page-mode|');
    const parsed = parseOldSyncRequest(wire);
    expect(parsed).toMatchObject({ contextGraphId: 'mfacts', offset: 25, limit: 500,
      includeSharedMemory: false, phase: 'data', assetUals: [UAL],
      syncSessionId: 'session-1', sinceBatchId: '42', pageMode: 'byte-budget-v1', pageRowsHint: 8_192 });
    expect(parsed.responseEncoding).toBeUndefined();
    expect(decodePipeSyncRequestTail(text.split('|')).responseEncoding).toBe(EXACT_SYNC_GZIP_ENCODING);
  });

  it('signed cold-bootstrap JSON preserves old digest inputs and old strict allowlist plain fallback', async () => {
    const build = params(true);
    const wire = await buildSyncRequestEnvelope(build);
    const envelope = JSON.parse(new TextDecoder().decode(wire));
    expect(envelope.responseEncoding).toBe(EXACT_SYNC_GZIP_ENCODING);
    expect(envelope.limit).toBe(500);
    expect(build.computeSyncDigest).toHaveBeenCalledOnce();
    const args = build.computeSyncDigest.mock.calls[0];
    expect(args).toHaveLength(11);
    expect(args).toEqual(['mfacts', 25, 500, false, 'responder', 'requester',
      envelope.requestId, envelope.issuedAtMs, undefined, undefined, undefined]);
    const old = parseOldSyncRequest(wire);
    expect(old.responseEncoding).toBeUndefined();
    expect(old).toMatchObject({ assetUals: [UAL], limit: 500, syncSessionId: 'session-1',
      sinceBatchId: '42', requesterSignatureR: envelope.requesterSignatureR,
      requesterSignatureVS: envelope.requesterSignatureVS });
  });

  it.each([
    { responseEncoding: undefined }, { responseEncoding: 'unknown-v2' },
    { assetUals: undefined }, { assetUals: [] }, { assetUals: [UAL, UAL_2] },
    { includeSharedMemory: true }, { phase: 'catalog' }, { phase: 'snapshot' },
  ])('never expands capability scope for %j', async (change) => {
    const outside = { ...request, ...change };
    expect(negotiatesExactSyncGzip(outside)).toBe(false);
    expect(await encodeNegotiatedExactSyncResponse(rdf, { request: outside })).toBe(rdf);
  });

  it('keeps old/unnegotiated singleton admission unchanged and enlarges only the bounded marker', () => {
    expect(exactSyncPhaseAccumulationLimits([UAL])).toEqual({ maxBytes: 4 * 1024 * 1024, maxQuads: 100_000 });
    expect(exactSyncPhaseAccumulationLimits([UAL], EXACT_SYNC_GZIP_ENCODING))
      .toEqual({ maxBytes: 16 * 1024 * 1024, maxQuads: 100_000, maxHeapBytesEstimate: 32 * 1024 * 1024 });
    expect(exactSyncPhaseAccumulationLimits([UAL, UAL_2], EXACT_SYNC_GZIP_ENCODING))
      .toEqual({ maxBytes: 8 * 1024 * 1024, maxQuads: 200_000 });
  });

  it('accepts bounded old-peer plaintext and empty EOF after exhaustion', async () => {
    expect(await decodeNegotiatedExactSyncResponse(rdf, { allowCompression: true }))
      .toEqual({ bytes: rdf, compressed: false, rows: 1 });
    expect(await decodeNegotiatedExactSyncResponse(new Uint8Array(), { allowCompression: true, maxInflatedBytes: 0 }))
      .toEqual({ bytes: new Uint8Array(), compressed: false, rows: 0 });
    await expect(decodeNegotiatedExactSyncResponse(rdf, { allowCompression: true, maxInflatedBytes: rdf.byteLength - 1 }))
      .rejects.toThrow('remaining allowance');
  });

  it('bounds old plaintext frames even when a custom transport omits its ordinary physical ceiling', async () => {
    await expect(decodeNegotiatedExactSyncResponse(new Uint8Array(4 * 1024 * 1024 + 1), { allowCompression: true }))
      .rejects.toThrow('physical wire allowance');
  });

  it('rejects recognized binary responses without negotiation instead of treating them as plaintext', async () => {
    const frame = rawFrame(rdf);
    await expect(decodeNegotiatedExactSyncResponse(frame, { allowCompression: false })).rejects.toThrow('Unnegotiated');
  });

  it.each(['inflated-short', 'inflated-long', 'rows-short', 'rows-long', 'body-short', 'oversize'])
    ('strictly rejects forged %s declarations', async (dimension) => {
      const frame = rawFrame(rdf);
      const view = new DataView(frame.buffer);
      if (dimension === 'inflated-short') view.setUint32(8, rdf.byteLength - 1);
      if (dimension === 'inflated-long') view.setUint32(8, rdf.byteLength + 1);
      if (dimension === 'rows-short') view.setUint32(12, 0);
      if (dimension === 'rows-long') view.setUint32(12, 2);
      if (dimension === 'body-short') view.setUint32(16, frame.byteLength - 21);
      if (dimension === 'oversize') view.setUint32(8, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES + 1);
      await expect(decodeNegotiatedExactSyncResponse(frame, { allowCompression: true })).rejects.toThrow();
    });

  it('rejects corrupt, truncated, trailing or non-UTF8 bodies without accepting a prefix', async () => {
    const frame = rawFrame(rdf);
    const corrupt = frame.slice(); corrupt[20] = 0;
    const truncated = frame.subarray(0, frame.byteLength - 1);
    const trailing = new Uint8Array(frame.byteLength + 1); trailing.set(frame); trailing[trailing.length - 1] = 42;
    new DataView(trailing.buffer).setUint32(16, trailing.byteLength - 20);
    for (const invalid of [corrupt, truncated, trailing, rawFrame(new Uint8Array([0xff, 10]))]) {
      await expect(decodeNegotiatedExactSyncResponse(invalid, { allowCompression: true })).rejects.toThrow();
    }
  });

  it('rejects declared expansion/row bombs before retaining decoded content', async () => {
    const frame = rawFrame(encoder.encode('x\n'.repeat(100_001)), 100_000);
    await expect(decodeNegotiatedExactSyncResponse(frame, { allowCompression: true })).rejects.toThrow();
    await expect(decodeNegotiatedExactSyncResponse(rawFrame(rdf), { allowCompression: true, maxInflatedBytes: rdf.byteLength - 1 }))
      .rejects.toThrow('Invalid exact sync');
  });

  it('propagates cancellation instead of using the plaintext fallback', async () => {
    const controller = new AbortController();
    const reason = new Error('owner cancelled compression'); controller.abort(reason);
    await expect(encodeNegotiatedExactSyncResponse(rdf, { request, signal: controller.signal })).rejects.toBe(reason);
    await expect(decodeNegotiatedExactSyncResponse(rawFrame(rdf), { allowCompression: true, signal: controller.signal })).rejects.toBe(reason);
  });
});

type FetchParams = Parameters<typeof fetchSyncPages>[0];
function fetchParams(overrides: Partial<FetchParams> = {}): FetchParams {
  return {
    ctx: { operationId: 'gzip-page-profile', operationName: 'sync' },
    remotePeerId: 'profile-peer', contextGraphId: 'profile-cg', includeSharedMemory: false,
    phase: 'data', graphUri: 'urn:g', deadline: Date.now() + 10_000,
    syncPageTimeoutMs: 1_000, syncRouterAttempts: 1, syncPageRetryAttempts: 1,
    syncPageSize: 8_192, syncDeniedResponse: 'denied', debugSyncProgress: false,
    protocolSync: '/dkg/test/sync', checkpointStore: new MemorySyncCheckpointStore(),
    assetUals: [UAL], responseEncoding: EXACT_SYNC_GZIP_ENCODING,
    buildSyncRequest: async () => encoder.encode('request'), send: async () => new Uint8Array(),
    parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
    logWarn: () => {}, logInfo: () => {}, logDebug: () => {}, ...overrides,
  };
}

describe('negotiated exact requester page-size profile', () => {
  const scope = { remotePeerId: 'profile-peer', contextGraphId: 'profile-cg', includeSharedMemory: false, phase: 'data' as const };
  it.each([
    { responseEncoding: undefined },
    { includeSharedMemory: true },
    { phase: 'snapshot' as const },
    { assetUals: [UAL, UAL_2] },
  ])('rejects a compressed page outside the declared profile before parsing: %j', async (outside) => {
    const parseAndFilter = vi.fn(async () => ({ quads: [], totalQuads: 0 }));
    await expect(fetchSyncPages(fetchParams({
      ...outside, send: async () => rawFrame(rdf), parseAndFilter,
    }))).rejects.toThrow(/Unnegotiated/);
    expect(parseAndFilter).not.toHaveBeenCalled();
  });

  it.each(['bytes', 'quads'] as const)('preserves a tighter caller %s allowance after negotiation', async (dimension) => {
    const parseAndFilter = vi.fn(async () => ({
      quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"valid"', graph: 'urn:g' }],
      totalQuads: 1,
    }));
    await expect(fetchSyncPages(fetchParams({
      ...(dimension === 'bytes' ? { maxAcceptedBytes: rdf.byteLength - 1 } : { maxAcceptedQuads: 0 }),
      send: async () => rawFrame(rdf), parseAndFilter,
    }))).rejects.toThrow(dimension === 'bytes' ? /Invalid exact sync/ : /quads/);
    expect(parseAndFilter).toHaveBeenCalledTimes(dimension === 'bytes' ? 0 : 1);
  });

  it('starts the actual cold request at 8192 and requires explicit old-plaintext EOF', async () => {
    const requested: number[] = [];
    let sends = 0;
    const result = await fetchSyncPages(fetchParams({
      buildSyncRequest: async (_cg, _offset, limit) => { requested.push(limit); return encoder.encode('request'); },
      send: async () => ++sends === 1 ? rdf : new Uint8Array(),
      parseAndFilter: async () => ({ quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"valid"', graph: 'urn:g' }], totalQuads: 1 }),
    }));
    expect(requested).toEqual([8_192, 8_192]);
    expect(result.completed).toBe(true);
    expect(result.quads).toHaveLength(1);
  });

  it('isolates legacy learning while honoring stalls learned under the same encoding', async () => {
    const cache = new SyncPageSizeProfileCache();
    cache.remember(scope, 64);
    const requested: number[] = [];
    const buildSyncRequest: FetchParams['buildSyncRequest'] = async (_cg, _offset, limit) => { requested.push(limit); return encoder.encode('request'); };
    await fetchSyncPages(fetchParams({ pageSizeProfileCache: cache, buildSyncRequest }));
    expect(requested).toEqual([8_192]);
    cache.remember({ ...scope, responseEncoding: EXACT_SYNC_GZIP_ENCODING }, 256);
    await fetchSyncPages(fetchParams({ pageSizeProfileCache: cache, buildSyncRequest }));
    expect(requested).toEqual([8_192, 256]);
    expect(cache.preferred(scope)).toBe(64);
  });

  it('keeps the existing bounded retry floor and remembers it for compressed continuations', async () => {
    const cache = new SyncPageSizeProfileCache();
    const requested: number[] = [];
    let sends = 0;
    await fetchSyncPages(fetchParams({ pageSizeProfileCache: cache, syncPageRetryAttempts: 2,
      buildSyncRequest: async (_cg, _offset, limit) => { requested.push(limit); return encoder.encode('request'); },
      send: async () => { if (++sends === 1) throw new Error('relay stream reset'); return new Uint8Array(); },
    }));
    expect(requested).toEqual([8_192, 64]);
    expect(cache.preferred({ ...scope, responseEncoding: EXACT_SYNC_GZIP_ENCODING })).toBe(64);
  });

  it('enforces cumulative raw row admission across independently valid frames before parsing the second', async () => {
    const frame = rawFrame(encoder.encode('x\n'.repeat(50_001)), 50_001);
    const parseAndFilter = vi.fn(async () => ({ quads: [], totalQuads: 50_001 }));
    await expect(fetchSyncPages(fetchParams({ send: async () => frame, parseAndFilter }))).rejects.toThrow('quads');
    expect(parseAndFilter).toHaveBeenCalledOnce();
  });
});
