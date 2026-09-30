import { assertSafeIri, compareCodePoint } from '@origintrail-official/dkg-core';
import {
  BlazegraphStore,
  SparqlHttpStore,
  StoreResponseTooLargeError,
  asGraphWriteRevisionSource,
  findTripleStoreCapability,
  quadToNQuad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  type ConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '@origintrail-official/dkg-publisher';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SyncRow } from './snapshot-cache.js';
import { SyncRowSnapshotBudgetError, type SyncResponderSnapshotBudget } from './snapshot-budget.js';

/** Separate from the broad snapshot loader: unsigned public hints cannot raise these. */
export const EXACT_ASSET_EXPORT_MAX_ROWS = 16_384;
export const EXACT_ASSET_EXPORT_MAX_STORE_BYTES = 8 * 1024 * 1024;
export const EXACT_ASSET_EXPORT_MAX_HEAP_BYTES = 32 * 1024 * 1024;
export const EXACT_ASSET_EXPORT_CANONICAL_BYTES = 4 * 1024 * 1024;
const BUILD_RESERVATION_BYTES = 80 * 1024 * 1024;
// Two UTF-16 serialization copies, encoded bytes and the codec's owned input;
// retain this through the physical encoder and final metadata fence.
const RESPONSE_RESERVATION_BYTES = 96 * 1024 * 1024;
const METADATA_MAX_ROWS = 128;
const METADATA_MAX_BYTES = 64 * 1024;
const DKG = 'http://dkg.io/ontology/';
const ENCODER = new TextEncoder();

export interface ExactAssetExportLease {
  readonly rows: readonly SyncRow[];
  readonly identity: string;
  /** Observational count for this successful lease; absent on custom fixtures. */
  readonly wholePayloadExports?: 0 | 1;
  /** Source/metadata fence after the handler's last asynchronous encoding boundary. */
  assertCurrent(): Promise<void>;
  /** The handler holds the charge through serialization and physical compression. */
  release(): void;
}

export interface ExactAssetExportRequest {
  readonly contextGraphId: string;
  readonly assetUal: string;
  readonly graph: string;
  readonly expectedRows: number;
  readonly expectedIdentity?: string;
  readonly signal?: AbortSignal;
}

export interface ExactAssetExportCache {
  /** null is a resource/capability refusal; the existing conservative reader remains available. */
  acquire(request: ExactAssetExportRequest): Promise<ExactAssetExportLease | null>;
  stats(): Readonly<{
    exports: number;
    cacheHits: number;
    fallbacks: Readonly<Partial<Record<ExactAssetExportFallbackReason, number>>>;
  }>;
}

export type ExactAssetExportFallbackReason = 'store-capability' | 'row-profile'
  | 'metadata-profile' | 'non-public' | 'private-commitments' | 'blank-nodes'
  | 'heap-profile' | 'canonical-byte-profile' | 'store-byte-profile'
  | 'build-admission' | 'response-admission';

interface ExportEntry {
  readonly id: symbol;
  readonly key: string;
  readonly rows: readonly SyncRow[];
  readonly identity: string;
  readonly heapBytes: number;
  readonly cachedAt: number;
  active: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('Exact asset export cancelled'), { name: 'AbortError' });
}

function changed(): Error {
  return Object.assign(new Error('Sync session exact asset export expired: metadata or source changed before page completion'), {
    code: 'SYNC_EXACT_EXPORT_CHANGED',
  });
}

function invalid(): Error {
  return Object.assign(new Error('Exact asset export does not match its confirmed count or Merkle root'), {
    code: 'SYNC_EXACT_EXPORT_INVALID',
  });
}

function boundedHttpStore(store: TripleStore): boolean {
  // Only these adapters enforce maxResponseBytes before JSON materialization.
  // Embedded and third-party stores keep the existing 64-row physical read.
  return findTripleStoreCapability(store, (value): value is BlazegraphStore | SparqlHttpStore => (
    value instanceof BlazegraphStore || value instanceof SparqlHttpStore
  )) !== null;
}

function compareRows(a: SyncRow, b: SyncRow): number {
  return compareCodePoint(a.s, b.s) || compareCodePoint(a.p, b.p) || compareCodePoint(a.o, b.o);
}

function rowHeapBytes(row: SyncRow): number {
  // Charge UTF-16 worst case, including a distinct graph string per returned row.
  return 160 + 2 * (row.s.length + row.p.length + row.o.length + row.g.length);
}

/**
 * Bounded, per-KA export. Cached rows are performance data, never chain authority.
 * Stores lacking stable revisions recompute every page and bracket each export
 * with the complete immutable metadata identity and count/root verification.
 */
export function createBoundedExactAssetExportCache(params: {
  readonly store: TripleStore;
  readonly budget: SyncResponderSnapshotBudget;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}): ExactAssetExportCache {
  const { store, budget } = params;
  const ttlMs = params.ttlMs ?? 60_000;
  const maxEntries = params.maxEntries ?? 8;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('Exact asset export cache limits must be positive safe integers');
  }
  const revisions = asGraphWriteRevisionSource(store);
  const cache = new Map<string, ExportEntry>();
  const canReadWholeAsset = boundedHttpStore(store);
  let exports = 0;
  let cacheHits = 0;
  const fallbacks: Partial<Record<ExactAssetExportFallbackReason, number>> = {};
  const refuse = (reason: ExactAssetExportFallbackReason): null => {
    fallbacks[reason] = (fallbacks[reason] ?? 0) + 1;
    return null;
  };

  const discard = (entry: ExportEntry) => {
    if (entry.active !== 0) return false;
    if (cache.get(entry.key) === entry) cache.delete(entry.key);
    budget.remove(entry.id);
    return true;
  };
  const prune = () => {
    for (const entry of cache.values()) {
      if (Date.now() - entry.cachedAt >= ttlMs) discard(entry);
    }
    while (cache.size > maxEntries) {
      const idle = [...cache.values()].find((entry) => entry.active === 0);
      if (!idle || !discard(idle)) break;
    }
  };
  const reserve = (id: symbol, key: string, rows: number, bytesEstimate: number, onEvict: () => void) => {
    try {
      budget.admit({ id, key, rows, bytesEstimate, phase: 'durable_data', onEvict });
      return true;
    } catch (error) {
      if (error instanceof SyncRowSnapshotBudgetError) return false;
      throw error;
    }
  };

  const readMetadata = async (request: ExactAssetExportRequest) => {
    throwIfAborted(request.signal);
    const metaGraph = `did:dkg:context-graph:${request.contextGraphId}/_meta`;
    let result;
    try { result = await store.query(`
      SELECT ?predicate ?object WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(request.assetUal)}> ?predicate ?object }
      } LIMIT ${METADATA_MAX_ROWS + 1}
    `, {
      source: 'sync.responder.exactAssetExport.metadata', priority: 'background',
      signal: request.signal, maxResponseBytes: METADATA_MAX_BYTES,
    }); } catch (error) {
      if (error instanceof StoreResponseTooLargeError) {
        if (request.expectedIdentity !== undefined) throw changed();
        return refuse('metadata-profile');
      }
      throw error;
    }
    throwIfAborted(request.signal);
    if (result.type !== 'bindings' || result.bindings.length > METADATA_MAX_ROWS) {
      if (request.expectedIdentity !== undefined) throw changed();
      return refuse('metadata-profile');
    }
    if (result.bindings.some((row) => typeof row.predicate !== 'string' || typeof row.object !== 'string')) {
      if (request.expectedIdentity !== undefined) throw changed();
      throw invalid();
    }
    // A retained export must never silently downgrade into the paged fallback
    // after its metadata changes, including a new private/over-limit profile.
    const identity = bytesToHex(sha256(ENCODER.encode(JSON.stringify(result.bindings
      .map((row) => [row.predicate, row.object])
      .sort((a, b) => compareCodePoint(a[0]!, b[0]!) || compareCodePoint(a[1]!, b[1]!))))));
    if (request.expectedIdentity !== undefined && identity !== request.expectedIdentity) throw changed();
    // Use the canonical metadata parser on the already bounded result, with no second IO.
    const metadataReader = new Proxy(store, {
      get(target, key, receiver) {
        return key === 'query' ? async () => result : Reflect.get(target, key, receiver);
      },
    });
    const parsed = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(
      metadataReader, { contextGraphId: request.contextGraphId, ual: request.assetUal },
    );
    throwIfAborted(request.signal);
    if (parsed.state !== 'confirmed') throw invalid();
    const publicPolicies = result.bindings.filter((row) => row.predicate === `${DKG}accessPolicy`);
    if (publicPolicies.length !== 1 || !/^"public"(?:\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#string>)?$/.test(publicPolicies[0]!.object!)) {
      return refuse('non-public');
    }
    if (parsed.envelope.privateTripleCount !== 0) return refuse('private-commitments');
    if (parsed.envelope.assertionGraph !== request.graph || parsed.envelope.publicTripleCount !== request.expectedRows) {
      throw changed();
    }
    return { identity, envelope: parsed.envelope, metaGraph };
  };

  const revisionKey = (graph: string, metaGraph: string): string | null => {
    if (!revisions) return null;
    const meta = revisions.getWriteRevision(metaGraph);
    const body = revisions.getWriteRevision(graph);
    if (!meta.stable || !body.stable) throw changed();
    return JSON.stringify([meta.generation, body.generation]);
  };

  const lease = (
    entry: ExportEntry,
    keep: boolean,
    request: ExactAssetExportRequest,
    sourceRevision: string | null,
    wholePayloadExports: 0 | 1,
  ): ExactAssetExportLease | null => {
    const responseId = Symbol('exact-export-response');
    budget.touch(entry.id);
    if (!reserve(responseId, `${entry.key}:response`, 0, RESPONSE_RESERVATION_BYTES, () => {})) {
      if (entry.active === 0) budget.release(entry.id);
      if (!keep) discard(entry);
      return refuse('response-admission');
    }
    entry.active += 1;
    let released = false;
    return Object.freeze({
      rows: entry.rows,
      identity: entry.identity,
      wholePayloadExports,
      async assertCurrent() {
        if (released) throw changed();
        const metadata = await readMetadata({ ...request, expectedIdentity: entry.identity });
        if (!metadata || revisionKey(request.graph, metadata.metaGraph) !== sourceRevision) throw changed();
        throwIfAborted(request.signal);
      },
      release() {
        if (released) return;
        released = true;
        budget.remove(responseId);
        entry.active -= 1;
        if (entry.active === 0) {
          if (keep && cache.get(entry.key) === entry) budget.release(entry.id);
          else discard(entry);
        }
      },
    });
  };

  return {
    stats() { return Object.freeze({ exports, cacheHits, fallbacks: Object.freeze({ ...fallbacks }) }); },
    async acquire(request) {
      throwIfAborted(request.signal);
      if (!canReadWholeAsset) return refuse('store-capability');
      if (!Number.isSafeInteger(request.expectedRows) || request.expectedRows < 1
        || request.expectedRows > EXACT_ASSET_EXPORT_MAX_ROWS) return refuse('row-profile');
      const metadata = await readMetadata(request);
      if (!metadata) return null;
      const revision = revisionKey(request.graph, metadata.metaGraph);
      const key = JSON.stringify([request.graph, metadata.identity, revision]);
      prune();
      if (revision !== null) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.cachedAt < ttlMs) {
          throwIfAborted(request.signal);
          if (revisionKey(request.graph, metadata.metaGraph) !== revision) throw changed();
          cacheHits += 1;
          return lease(hit, true, request, revision, 0);
        }
      }
      const id = Symbol('exact-asset-export');
      if (!reserve(id, key, request.expectedRows + 1, BUILD_RESERVATION_BYTES, () => {})) return refuse('build-admission');
      let retained = false;
      try {
        const result = await store.query(`
          SELECT ?s ?p ?o WHERE { GRAPH <${assertSafeIri(request.graph)}> { ?s ?p ?o } }
          LIMIT ${request.expectedRows + 1}
        `, {
          source: 'sync.responder.exactAssetExport.payload', priority: 'background',
          signal: request.signal, maxResponseBytes: EXACT_ASSET_EXPORT_MAX_STORE_BYTES,
        });
        throwIfAborted(request.signal);
        if (result.type !== 'bindings' || result.bindings.length !== request.expectedRows) throw invalid();
        const rows: SyncRow[] = [];
        let heapBytes = 0;
        let canonicalBytes = 0;
        for (const row of result.bindings) {
          if (typeof row.s !== 'string' || typeof row.p !== 'string' || typeof row.o !== 'string') throw invalid();
          if (row.s.startsWith('_:') || row.o.startsWith('_:')) return refuse('blank-nodes');
          const value = Object.freeze({ s: row.s, p: row.p, o: row.o, g: request.graph });
          heapBytes += rowHeapBytes(value);
          if (heapBytes > EXACT_ASSET_EXPORT_MAX_HEAP_BYTES) return refuse('heap-profile');
          canonicalBytes += ENCODER.encode(quadToNQuad({
            subject: value.s, predicate: value.p, object: value.o, graph: '',
          })).byteLength + (rows.length > 0 ? 1 : 0);
          if (canonicalBytes > EXACT_ASSET_EXPORT_CANONICAL_BYTES) return refuse('canonical-byte-profile');
          rows.push(value);
        }
        rows.sort(compareRows);
        for (let i = 1; i < rows.length; i += 1) {
          if (compareRows(rows[i - 1]!, rows[i]!) === 0) throw invalid();
        }
        const root = computeFlatKCRootV10(rows.map((row) => ({
          subject: row.s, predicate: row.p, object: row.o, graph: '',
        })), []);
        if (!sameRoot(root, metadata.envelope)) throw invalid();
        const after = await readMetadata({ ...request, expectedIdentity: metadata.identity });
        if (!after || revisionKey(request.graph, metadata.metaGraph) !== revision) throw changed();
        throwIfAborted(request.signal);
        exports += 1;
        const entry: ExportEntry = {
          id, key, rows: Object.freeze(rows), identity: metadata.identity,
          heapBytes, cachedAt: Date.now(), active: 0,
        };
        budget.admit({ id, replaceId: id, key, rows: rows.length, bytesEstimate: heapBytes,
          phase: 'durable_data', onEvict: () => { if (cache.get(key) === entry) cache.delete(key); } });
        if (revision !== null) {
          while (cache.size >= maxEntries) {
            const idle = [...cache.values()].find((value) => value.active === 0);
            if (!idle || !discard(idle)) break;
          }
          if (cache.size < maxEntries) cache.set(key, entry);
        }
        const acquired = lease(entry, cache.get(key) === entry, request, revision, 1);
        if (!acquired) discard(entry);
        retained = acquired !== null;
        return acquired;
      } catch (error) {
        if (error instanceof StoreResponseTooLargeError) return refuse('store-byte-profile');
        if (error instanceof SyncRowSnapshotBudgetError) return refuse('build-admission');
        throw error;
      } finally {
        // Cancellation waits for the actual query promise above before its charge disappears.
        if (!retained) budget.remove(id);
      }
    },
  };
}

function sameRoot(root: Uint8Array, envelope: ConfirmedGraphKnowledgeAssetMetadataEnvelope): boolean {
  return root.length === envelope.merkleRoot.length
    && root.every((byte, index) => byte === envelope.merkleRoot[index]);
}
