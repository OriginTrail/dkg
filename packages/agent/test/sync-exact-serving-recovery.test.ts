import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10,
  generateGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-publisher';
import { OxigraphStore, StoreResponseTooLargeError, type Quad } from '@origintrail-official/dkg-storage';
import {
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
  SYNC_PAGE_SIZE,
  SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD,
  SYNC_REQUEST_PAGE_SIZE,
  SYNC_REQUEST_SAFE_PAGE_SIZE,
} from '../src/dkg-agent-constants.js';
import { DURABLE_DATA_SYNC_SESSION_TTL_MS } from '../src/sync/durable-session.js';
import { verifySyncedData } from '../src/sync-verify-worker-impl.js';
import { buildSyncRequestEnvelope, type SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { fetchSyncPages, SyncPageSizeProfileCache } from '../src/sync/requester/page-fetch.js';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import { EXACT_SYNC_GZIP_ENCODING } from '../src/sync/wire-compression.js';
import { parseOldSyncRequest } from './fixtures/sync-request-parser-10.0.20.fixture.js';
import { serializeResponderRows } from '../src/sync/responder/graph-plan.js';
import {
  TEST_SYNC_DENIED,
  linesFromNquads,
  registerTestSyncHandler,
} from './_helpers/sync-responder.js';

const EXACT_PAGE_ROWS = 512;
const STORE_PAGE_BYTES = 8 * 1024 * 1024;
const MANIFEST_SOURCES = new Set([
  'sync.responder.readGraphScopedVmManifestMarkers',
  'sync.responder.readGraphScopedVmManifest',
]);

interface AssetFixture {
  readonly contextGraphId: string;
  readonly ual: string;
  readonly graph: string;
  readonly payload: Quad[];
  readonly meta: Quad[];
}

function asset(contextGraphId: string, index: number, rows: number, options: {
  readonly version?: number;
  readonly literal?: string;
  readonly integerObjects?: boolean;
} = {}): AssetFixture {
  const version = options.version ?? 1;
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/${index}`;
  const graph = knowledgeAssetLayerGraphUri(
    contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, version),
  );
  const payload = Array.from({ length: rows }, (_, row): Quad => ({
    graph,
    subject: options.integerObjects ? 'urn:exact-serving:integer'
      : `urn:exact-serving:${index}:${row.toString().padStart(5, '0')}`,
    predicate: 'urn:exact-serving:value',
    object: options.integerObjects ? `"${row}"^^<http://www.w3.org/2001/XMLSchema#integer>`
      : `"${options.literal ?? `version-${version}-row-${row}`}"`,
  }));
  const meta = generateGraphKnowledgeAssetMetadata({
    ual, contextGraphId, assertionGraph: graph, assertionVersion: String(version),
    merkleRoot: computeFlatKCRootV10(payload, []),
    publisherPeerId: 'publisher-peer', accessPolicy: 'public', timestamp: new Date(0),
    publicTripleCount: payload.length, privateTripleCount: 0,
  }, {
    status: 'confirmed',
    confirmation: { kind: 'transaction', provenance: {
      txHash: `0x${'11'.repeat(32)}`, batchId: BigInt(index), blockNumber: 1, blockTimestamp: 0,
      publisherAddress: '0x00000000000000000000000000000000000000ab', chainId: '31337',
    } },
  });
  return { contextGraphId, ual, graph, payload, meta };
}

function request(fixture: AssetFixture, token = 'exact-serving-session'): SyncRequestEnvelope {
  return {
    contextGraphId: fixture.contextGraphId, includeSharedMemory: false,
    phase: 'data', offset: 0, limit: SYNC_PAGE_SIZE,
    pageMode: SYNC_BYTE_BUDGET_PAGE_MODE, pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
    syncSessionId: token, assetUals: [fixture.ual],
  };
}

function expectedLines(payload: readonly Quad[]): string[] {
  return linesFromNquads(serializeResponderRows(payload.map((quad) => ({
    s: quad.subject, p: quad.predicate, o: quad.object, g: quad.graph,
  }))));
}

function observe(store: OxigraphStore, payloadGraphs: readonly string[]) {
  const query = store.query.bind(store);
  const manifestSources: string[] = [];
  const payloadQueries: Array<{ readonly query: string; readonly maxResponseBytes?: number }> = [];
  let payloadSnapshots = 0;
  store.query = (async (sparql, options) => {
    if (MANIFEST_SOURCES.has(options?.source ?? '')) manifestSources.push(options!.source!);
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    if (payloadGraphs.some((graph) => normalized.includes(`GRAPH <${graph}>`))
      && normalized.startsWith('SELECT ?s ?p ?o WHERE')) {
      if (normalized.includes('ORDER BY ?s ?p ?o')) {
        payloadQueries.push({ query: normalized, maxResponseBytes: options?.maxResponseBytes });
      } else payloadSnapshots += 1;
    }
    return query(sparql, options);
  }) as OxigraphStore['query'];
  return { manifestSources, payloadQueries, get payloadSnapshots() { return payloadSnapshots; } };
}

afterEach(() => vi.restoreAllMocks());

describe('bounded exact DATA serving recovery', () => {
  it('serves 1,200 rows in three 512-row windows and an explicit EOF using one retained plan', async () => {
    const store = new OxigraphStore();
    try {
      const fixture = asset('exact-serving-small', 1, 1_200);
      await store.insert([...fixture.meta, ...fixture.payload]);
      const reads = observe(store, [fixture.graph]);
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
      const base = request(fixture);
      const pages: string[][] = [];
      for (const offset of [0, 512, 1_024, 1_200]) {
        pages.push(linesFromNquads(await cap.invoke({ ...base, offset })));
      }
      expect(pages.map((page) => page.length)).toEqual([512, 512, 176, 0]);
      expect(pages.flat()).toEqual(expectedLines(fixture.payload));
      expect(new Set(pages.flat()).size).toBe(fixture.payload.length);
      expect(reads.manifestSources).toEqual([...MANIFEST_SOURCES]);
      expect(reads.payloadSnapshots).toBe(0);
      expect(reads.payloadQueries).toHaveLength(Math.ceil(1_200 / SYNC_REQUEST_SAFE_PAGE_SIZE));
      expect(reads.payloadQueries[0]!.query).toContain('OFFSET 0');
      for (const page of reads.payloadQueries.slice(1)) {
        expect(page.query).toContain('FILTER(');
        expect(page.query).not.toMatch(/\bOFFSET\b/);
      }
      for (const page of reads.payloadQueries) {
        expect(Number(/\bLIMIT (\d+)/.exec(page.query)![1]))
          .toBeLessThanOrEqual(SYNC_REQUEST_SAFE_PAGE_SIZE + 1);
        expect(page.maxResponseBytes).toBeLessThanOrEqual(STORE_PAGE_BYTES);
      }
      // A transport page is not a complete Merkle-bound KA. Neither page-sized
      // prefix can become verified durable data before the entire KA arrives.
      expect(verifySyncedData(fixture.payload.slice(0, 512), fixture.meta).data).toHaveLength(0);
      expect(verifySyncedData(fixture.payload.slice(0, 1_024), fixture.meta).data).toHaveLength(0);
      const complete = verifySyncedData(fixture.payload, fixture.meta);
      expect(complete.rejected).toBe(0);
      expect(complete.data).toEqual(fixture.payload);
    } finally { await store.close(); }
  });

  it('byte-fits large UTF-8 literals and seeks from the actual emitted prefix until empty EOF', async () => {
    const store = new OxigraphStore();
    try {
      const fixture = asset('exact-serving-large', 2, 96, { literal: '界'.repeat(21_800) });
      await store.insert([...fixture.meta, ...fixture.payload]);
      const reads = observe(store, [fixture.graph]);
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
      const base = request(fixture);
      const delivered: string[] = [];
      const pageSizes: number[] = [];
      let offset = 0;
      for (let page = 0; page < 10; page += 1) {
        const body = await cap.invoke({ ...base, offset });
        expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);
        const lines = linesFromNquads(body);
        pageSizes.push(lines.length);
        if (lines.length === 0) break;
        delivered.push(...lines);
        offset += lines.length;
      }
      expect(pageSizes[0]).toBeGreaterThan(0);
      expect(pageSizes[0]).toBeLessThan(fixture.payload.length);
      expect(pageSizes.at(-1)).toBe(0);
      expect(offset).toBe(fixture.payload.length);
      expect(delivered).toEqual(expectedLines(fixture.payload));
      expect(new Set(delivered).size).toBe(fixture.payload.length);
      expect(reads.manifestSources).toEqual([...MANIFEST_SOURCES]);
      expect(reads.payloadSnapshots).toBe(0);
      expect(reads.payloadQueries[1]!.query).toContain('FILTER(');
      expect(reads.payloadQueries[1]!.query).not.toMatch(/\bOFFSET\b/);
      expect(reads.payloadQueries.every((query) => query.maxResponseBytes! <= STORE_PAGE_BYTES)).toBe(true);
    } finally { await store.close(); }
  });

  it('halves a rejected bounded store read without restarting the plan or skipping rows', async () => {
    const store = new OxigraphStore();
    try {
      const fixture = asset('exact-serving-store-limit', 3, 700);
      await store.insert([...fixture.meta, ...fixture.payload]);
      const reads = observe(store, [fixture.graph]);
      const query = store.query.bind(store);
      const rejectedLimits: number[] = [];
      store.query = (async (sparql, options) => {
        if (options?.source === 'sync.responder.readExactGraphRowsPage') {
          const limit = Number(/\bLIMIT\s+(\d+)/i.exec(sparql)![1]);
          expect(options.maxResponseBytes).toBeLessThanOrEqual(STORE_PAGE_BYTES);
          if (limit > 32) {
            rejectedLimits.push(limit);
            throw new StoreResponseTooLargeError(STORE_PAGE_BYTES, STORE_PAGE_BYTES + 1);
          }
        }
        return query(sparql, options);
      }) as OxigraphStore['query'];
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
      const base = request(fixture);
      const first = linesFromNquads(await cap.invoke(base));
      expect(first).toHaveLength(EXACT_PAGE_ROWS);
      expect(rejectedLimits[0]).toBe(SYNC_REQUEST_SAFE_PAGE_SIZE);
      const second = linesFromNquads(await cap.invoke({ ...base, offset: first.length }));
      expect(second).toHaveLength(188);
      expect([...first, ...second]).toEqual(expectedLines(fixture.payload));
      expect(reads.manifestSources).toEqual([...MANIFEST_SOURCES]);
      expect(reads.payloadSnapshots).toBe(0);
      expect(reads.payloadQueries.at(-1)!.query).toContain('FILTER(');
    } finally { await store.close(); }
  });

  it('isolates plans by peer, Context Graph and exact asset selection even with the same token', async () => {
    const store = new OxigraphStore();
    try {
      const a = asset('exact-serving-scope-a', 4, 600);
      const sibling = asset(a.contextGraphId, 5, 600);
      const b = asset('exact-serving-scope-b', 4, 600);
      await store.insert([a, sibling, b].flatMap((fixture) => [...fixture.meta, ...fixture.payload]));
      const reads = observe(store, [a.graph, sibling.graph, b.graph]);
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
      for (const [fixture, peer] of [[a, 'peer-a'], [sibling, 'peer-a'], [b, 'peer-a'], [a, 'peer-b']] as const) {
        expect(linesFromNquads(await cap.invoke(request(fixture, 'same-token'), peer)))
          .toEqual(expectedLines(fixture.payload.slice(0, 512)));
      }
      for (const [fixture, peer] of [[a, 'peer-a'], [sibling, 'peer-a'], [b, 'peer-a'], [a, 'peer-b']] as const) {
        expect(linesFromNquads(await cap.invoke({ ...request(fixture, 'same-token'), offset: 512 }, peer)))
          .toEqual(expectedLines(fixture.payload.slice(512)));
      }
      expect(reads.manifestSources).toHaveLength(8);
      expect(reads.payloadSnapshots).toBe(0);
    } finally { await store.close(); }
  });

  it('reuses a page-zero retry but reloads a changed token and refuses the superseded token', async () => {
    const store = new OxigraphStore();
    try {
      const old = asset('exact-serving-token', 6, 600);
      const replacement = asset(old.contextGraphId, 6, 600, { version: 2 });
      await store.insert([...old.meta, ...old.payload]);
      const reads = observe(store, [old.graph, replacement.graph]);
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
      expect(linesFromNquads(await cap.invoke(request(old, 'old')))).toHaveLength(512);
      expect(linesFromNquads(await cap.invoke(request(old, 'old')))).toHaveLength(512);
      expect(reads.manifestSources).toHaveLength(2);
      await store.delete([...old.meta, ...old.payload]);
      await store.insert([...replacement.meta, ...replacement.payload]);
      expect(linesFromNquads(await cap.invoke(request(replacement, 'new'))))
        .toEqual(expectedLines(replacement.payload.slice(0, 512)));
      expect(reads.manifestSources).toHaveLength(4);
      await expect(cap.invoke({ ...request(old, 'old'), offset: 512 }))
        .rejects.toThrow(/session was superseded/);
      expect(linesFromNquads(await cap.invoke({ ...request(replacement, 'new'), offset: 512 })))
        .toEqual(expectedLines(replacement.payload.slice(512)));
      expect(reads.manifestSources).toHaveLength(4);
    } finally { await store.close(); }
  });

  it('fences a same-token continuation after a local write and lets a fresh token rebuild', async () => {
    const store = new OxigraphStore();
    try {
      const original = asset('exact-serving-write-fence', 10, 600);
      const replacement = asset(original.contextGraphId, 10, 600, { version: 2 });
      await store.insert([...original.meta, ...original.payload]);
      const reads = observe(store, [original.graph]);
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
      const base = request(original, 'before-write');
      expect(linesFromNquads(await cap.invoke(base))).toHaveLength(EXACT_PAGE_ROWS);
      const payloadReadsBeforeWrite = reads.payloadQueries.length;
      const changedRow = { ...original.payload[550]!, object: '"changed-after-first-page"' };
      await store.delete([original.payload[550]!]);
      await store.insert([changedRow]);

      await expect(cap.invoke({ ...base, offset: EXACT_PAGE_ROWS }))
        .rejects.toThrow(/store revision changed/);
      expect(reads.payloadQueries).toHaveLength(payloadReadsBeforeWrite);
      expect(reads.manifestSources).toHaveLength(2);

      await store.delete([...original.meta, ...original.payload, changedRow]);
      await store.insert([...replacement.meta, ...replacement.payload]);
      const restarted = request(replacement, 'after-write');
      const first = linesFromNquads(await cap.invoke(restarted));
      const last = linesFromNquads(await cap.invoke({ ...restarted, offset: first.length }));
      expect([...first, ...last]).toEqual(expectedLines(replacement.payload));
      expect(reads.manifestSources).toHaveLength(4);
    } finally { await store.close(); }
  });

  it('continues the retained exact plan after an unrelated payload write in the same Context Graph', async () => {
    const store = new OxigraphStore();
    try {
      const selected = asset('exact-serving-unrelated-write', 11, 600);
      const sibling = asset(selected.contextGraphId, 12, 600);
      await store.insert([selected, sibling].flatMap((fixture) => [...fixture.meta, ...fixture.payload]));
      const reads = observe(store, [selected.graph]);
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
      const base = request(selected);
      const first = linesFromNquads(await cap.invoke(base));
      expect(first).toHaveLength(EXACT_PAGE_ROWS);

      await store.delete([sibling.payload[0]!]);
      await store.insert([{ ...sibling.payload[0]!, object: '"unrelated-write"' }]);
      const last = linesFromNquads(await cap.invoke({ ...base, offset: first.length }));
      expect(last).toHaveLength(88);
      expect([...first, ...last]).toEqual(expectedLines(selected.payload));
      expect(reads.manifestSources).toHaveLength(2);
      expect(reads.payloadSnapshots).toBe(0);
      expect(reads.payloadQueries.at(-1)!.query).toContain('FILTER(');
    } finally { await store.close(); }
  });

  it('keeps an active exact plan alive beyond its initial TTL and refuses an idle expired continuation', async () => {
    const store = new OxigraphStore();
    try {
      const fixture = asset('exact-serving-sliding-ttl', 7, 1_400);
      await store.insert([...fixture.meta, ...fixture.payload]);
      let now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const reads = observe(store, [fixture.graph]);
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE });
      const base = request(fixture);
      expect(linesFromNquads(await cap.invoke(base))).toHaveLength(512);
      now += DURABLE_DATA_SYNC_SESSION_TTL_MS - 1;
      expect(linesFromNquads(await cap.invoke({ ...base, offset: 512 }))).toHaveLength(512);
      now += DURABLE_DATA_SYNC_SESSION_TTL_MS - 1;
      expect(linesFromNquads(await cap.invoke({ ...base, offset: 1_024 }))).toHaveLength(376);
      expect(reads.manifestSources).toHaveLength(2);
      now += DURABLE_DATA_SYNC_SESSION_TTL_MS + 1;
      await expect(cap.invoke({ ...base, offset: 1_400 })).rejects.toThrow(/expired|superseded/);
      expect(reads.manifestSources).toHaveLength(2);
    } finally { await store.close(); }
  });

  it('rechecks authorization on every page before exposing a retained plan', async () => {
    const store = new OxigraphStore();
    try {
      const fixture = asset('exact-serving-read-authority', 8, 600);
      await store.insert([...fixture.meta, ...fixture.payload]);
      let allowed = true;
      const authorize = vi.fn(async () => allowed);
      const reads = observe(store, [fixture.graph]);
      const cap = registerTestSyncHandler(store, { syncPageSize: SYNC_PAGE_SIZE, authorize });
      const base = request(fixture);
      expect(linesFromNquads(await cap.invoke(base))).toHaveLength(512);
      allowed = false;
      expect(await cap.invoke({ ...base, offset: 512 })).toBe(TEST_SYNC_DENIED);
      expect(reads.payloadQueries).toHaveLength(EXACT_PAGE_ROWS / SYNC_REQUEST_SAFE_PAGE_SIZE);
      allowed = true;
      expect(linesFromNquads(await cap.invoke({ ...base, offset: 512 })))
        .toEqual(expectedLines(fixture.payload.slice(512)));
      expect(authorize).toHaveBeenCalledTimes(3);
      expect(reads.manifestSources).toHaveLength(2);
    } finally { await store.close(); }
  });

  it('refuses retained exact plan admission under the global byte budget rather than returning false EOF', async () => {
    const store = new OxigraphStore();
    try {
      const fixture = asset('exact-serving-budget', 9, 600);
      await store.insert([...fixture.meta, ...fixture.payload]);
      const cap = registerTestSyncHandler(store, {
        syncPageSize: SYNC_PAGE_SIZE,
        snapshotBudget: {
          maxRows: 10_000, maxBytesEstimate: 256 * 1024 - 1,
          maxSnapshotRows: 10_000, maxSnapshotBytesEstimate: 128 * 1024 * 1024,
        },
      });
      await expect(cap.invoke(request(fixture))).rejects.toMatchObject({
        name: 'QuietRetryableHandlerError',
        message: expect.stringContaining('exceeds global estimated bytes budget'),
      });
    } finally { await store.close(); }
  });
});


describe('adaptive exact DATA wire continuations', () => {
  it.each(['JSON', 'pipe'] as const)('keeps one plan and numeric row order across learned 64 to 512 pages for %s requests', async wire => {
    const store = new OxigraphStore();
    try {
      const fixture = asset(`adaptive-exact-${wire.toLowerCase()}`, 15, 4_000, { integerObjects: true });
      await store.insert([...fixture.meta, ...fixture.payload]);
      const reads = observe(store, [fixture.graph]);
      const parsedRequests: SyncRequestEnvelope[] = [];
      const rawRequests: string[] = [];
      const requestedSizes: number[] = [];
      const responderFailures: Array<{ offset: number; rows?: number; message: string }> = [];
      const signedLimits: number[] = [];
      const parser = { parsePipeDelimitedSyncRequest: ContextGraphResolveMethods.prototype.parsePipeDelimitedSyncRequest };
      let handler!: (bytes: Uint8Array, peer: string) => Promise<Uint8Array>;
      registerSyncHandler({
        register: (_protocol, callback) => { handler = callback; },
        protocolSync: '/test/adaptive-exact-sync', syncDeniedResponse: TEST_SYNC_DENIED,
        syncPageSize: SYNC_PAGE_SIZE, sharedMemoryTtlMs: 0, store, peerId: 'adaptive-source',
        parseSyncRequest: bytes => {
          rawRequests.push(new TextDecoder().decode(bytes));
          const parsed = ContextGraphResolveMethods.prototype.parseSyncRequest.call(parser as never, bytes);
          parsedRequests.push(parsed);
          return parsed;
        },
        authorizeSyncRequest: async () => true, logWarn: () => {}, logDebug: () => {},
      });
      const pageSizeProfileCache = new SyncPageSizeProfileCache();
      pageSizeProfileCache.remember({ remotePeerId: 'adaptive-source', contextGraphId: fixture.contextGraphId,
        includeSharedMemory: false, phase: 'data', responseEncoding: EXACT_SYNC_GZIP_ENCODING }, 64);
      const quadsByLine = new Map(expectedLines(fixture.payload).map((line, index) => [line, fixture.payload[index]!]));
      const delivered: string[] = [];
      const fetched = await fetchSyncPages({
        ctx: { kind: 'system', id: 'adaptive-exact-wire', startedAt: Date.now() } as never,
        remotePeerId: 'adaptive-source', contextGraphId: fixture.contextGraphId,
        graphUri: fixture.graph, includeSharedMemory: false, phase: 'data',
        assetUals: [fixture.ual], responseEncoding: EXACT_SYNC_GZIP_ENCODING,
        deadline: Date.now() + 30_000, syncPageTimeoutMs: 5_000, syncRouterAttempts: 1,
        syncPageRetryAttempts: 1, syncPageSize: EXACT_PAGE_ROWS, pageSizeProfileCache,
        syncDeniedResponse: TEST_SYNC_DENIED, protocolSync: '/test/adaptive-exact-sync',
        debugSyncProgress: false, checkpointStore: new MemorySyncCheckpointStore(), forceFreshSession: true,
        buildSyncRequest: async (cg, offset, limit, swm, peer, phase, snapshot, since, token, recovery, assets) => {
          requestedSizes.push(limit);
          return buildSyncRequestEnvelope({ contextGraphId: cg, offset, limit, includeSharedMemory: swm,
            targetPeerId: peer, requesterPeerId: 'adaptive-requester', phase, snapshotRef: snapshot,
            sinceBatchId: since, syncSessionId: token, recovery, assetUals: assets, needsAuth: wire === 'JSON',
            computeSyncDigest: (_cg, _offset, signedLimit) => { signedLimits.push(signedLimit); return new Uint8Array(32); },
            getIdentityId: async () => 1n,
            signMessage: async () => ({ r: new Uint8Array(32).fill(1), vs: new Uint8Array(32).fill(2) }) });
        },
        send: async (_peer, _protocol, bytes) => {
          try { return await handler(bytes, 'adaptive-requester'); }
          catch (error) {
            const last = parsedRequests.at(-1)!;
            responderFailures.push({ offset: last.offset, rows: last.pageRowsHint, message: (error as Error).message });
            throw error;
          }
        },
        parseAndFilter: async text => {
          const lines = linesFromNquads(text);
          delivered.push(...lines);
          const quads = lines.map(line => {
            const quad = quadsByLine.get(line);
            if (!quad) throw new Error('Unexpected exact assertion row');
            return quad;
          });
          return { quads, totalQuads: lines.length };
        },
        logWarn: () => {}, logInfo: () => {}, logDebug: () => {},
      });
      expect(responderFailures).toEqual([]);
      expect(fetched).toMatchObject({ completed: true, nextOffset: 4_000 });
      expect(requestedSizes).toEqual([
        ...[64, 128, 256].flatMap(rows => Array(SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD).fill(rows)), 512, 512,
      ]);
      expect(parsedRequests[24]).toMatchObject({ offset: 3_584, limit: 500, pageRowsHint: 512 });
      expect(parsedRequests.map(request => request.pageRowsHint)).toEqual(requestedSizes);
      expect(new Set(parsedRequests.map(request => request.syncSessionId)).size).toBe(1);
      expect(delivered).toEqual(expectedLines(fixture.payload));
      expect(new Set(delivered).size).toBe(4_000);
      expect(verifySyncedData(fetched.quads, fixture.meta).data).toEqual(fixture.payload);
      // The frozen previous-version parser still sees the same signed limit,
      // exact selection and token while ignoring the additive small-row hint.
      for (const [index, raw] of rawRequests.entries()) {
        expect(parseOldSyncRequest(new TextEncoder().encode(raw))).toMatchObject({
          limit: Math.min(requestedSizes[index]!, SYNC_PAGE_SIZE), assetUals: [fixture.ual],
          syncSessionId: parsedRequests[index]!.syncSessionId,
        });
      }
      expect(reads.manifestSources).toEqual([...MANIFEST_SOURCES]);
      expect(reads.payloadSnapshots).toBe(0);
      expect(reads.payloadQueries.every(read => Number(/LIMIT (\d+)/.exec(read.query)?.[1]) <= 65)).toBe(true);
      if (wire === 'JSON') {
        expect(signedLimits).toEqual(requestedSizes.map(rows => Math.min(rows, SYNC_PAGE_SIZE)));
        expect(rawRequests.every(raw => raw.startsWith('{'))).toBe(true);
      } else {
        expect(signedLimits).toEqual([]);
        expect(rawRequests.every(raw => !raw.startsWith('{'))).toBe(true);
        expect(rawRequests[0]).toContain('|page-mode|byte-budget-v1|page-rows|64|');
      }
    } finally { await store.close(); }
  });
});
