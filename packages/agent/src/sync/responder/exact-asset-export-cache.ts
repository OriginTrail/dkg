import { assertSafeIri, compareCodePoint } from '@origintrail-official/dkg-core';
import {
  StoreResponseTooLargeError,
  ExactGraphReadError,
  asGraphWriteRevisionSource,
  supportsBoundedExactGraphExport,
  readBoundedGraphPayload,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  computeFlatKCRootV10,
  type ConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '@origintrail-official/dkg-publisher';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { SyncRow } from './snapshot-cache.js';
import { SyncRowSnapshotBudgetError, type SyncResponderSnapshotBudget } from './snapshot-budget.js';
import { observeExactBatch } from '../exact-batch-observation.js';
import { EXACT_BATCH_MAX_FRAME_BYTES } from '../exact-batch-stream-contract.js';
import {
  EXACT_SYNC_GZIP_ENCODING,
  EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES,
  EXACT_SYNC_GZIP_MAX_INFLATED_BYTES,
  encodeNegotiatedExactSyncResponse,
} from '../wire-compression.js';
import { serializeResponderRows } from './graph-plan.js';
import { parseResponderAssetMetadata, type ResponderAssetMetadataBinding } from './asset-metadata.js';

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
const ENCODER = new TextEncoder();
// Compressed performance copies share the ordinary responder budget. These
// bounds are local construction limits, never unsigned request allowances.
export const EXACT_ASSET_ENCODED_CACHE_MAX_BYTES = 192 * 1024 * 1024;
export const EXACT_ASSET_ENCODED_CACHE_MAX_ENTRIES = 1_024;
export const EXACT_ASSET_ENCODED_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const ENCODED_ENTRY_OVERHEAD_BYTES = 4_096;
const ENCODED_CACHE_FORMAT = 'exact-asset-body-nquads-v1';

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

export interface ExactAssetEncodedExportLease {
  /** Response-owned bounded META bytes from the same initial snapshot as the body. */
  readonly metadata: Uint8Array;
  /** Response-owned bytes. Mutating them cannot change the retained copy. */
  readonly body: Uint8Array;
  readonly plainBytes: number;
  readonly identity: string;
  readonly wholePayloadExports: 0 | 1;
  /** Local observation only; a warm copy performs no serialization/codec. */
  readonly encodingDurationMs: number;
  /** Fresh full metadata and available source revision fence before ASSET_END. */
  assertCurrent(): Promise<void>;
  release(): void;
}

export type ExactAssetExportStage = 'export-metadata-before' | 'export-store-payload-query'
  | 'export-canonical-preparation-root' | 'export-metadata-after';

export interface ExactAssetExportRequest {
  readonly contextGraphId: string;
  readonly assetUal: string;
  readonly graph: string;
  readonly expectedRows: number;
  readonly expectedIdentity?: string;
  readonly signal?: AbortSignal;
  /** Optional local observation; never controls export ownership or proof. */
  readonly onStage?: (stage: ExactAssetExportStage, durationMs: number) => unknown;
  /** Request-scoped bounded reason; never exposes a selector or budget key. */
  readonly onFallback?: (reason: ExactAssetExportFallbackReason, budgetReason?: SyncRowSnapshotBudgetError['reason']) => unknown;
  /**
   * Trusted local authority read for legacy metadata with no KA accessPolicy.
   * Absence stays strict by default. Every metadata fence reads authority again;
   * explicit policy or private commitments can never use this exception.
   */
  readonly authorizeMissingAccessPolicy?: () => Promise<boolean>;
}

/** Encoded exports derive graph/count/identity from their own bounded metadata read. */
export type ExactAssetEncodedExportRequest = Omit<ExactAssetExportRequest, 'graph' | 'expectedRows' | 'expectedIdentity'>;

export interface ExactAssetExportCache {
  /** null is a resource/capability refusal; the existing conservative reader remains available. */
  acquire(request: ExactAssetExportRequest): Promise<ExactAssetExportLease | null>;
  /** Experimental batch only; legacy row export ownership remains unchanged. */
  acquireEncoded(request: ExactAssetEncodedExportRequest): Promise<ExactAssetEncodedExportLease | null>;
  stats(): Readonly<{
    exports: number;
    cacheHits: number;
    encodedCacheHits: number;
    encodedCacheEntries: number;
    encodedCacheBytes: number;
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

interface VerifiedMetadata {
  readonly identity: string;
  readonly envelope: ConfirmedGraphKnowledgeAssetMetadataEnvelope;
  readonly metaGraph: string;
  readonly bindings: readonly ResponderAssetMetadataBinding[];
}

interface EncodedEntry {
  readonly id: symbol;
  readonly key: string;
  readonly body: Uint8Array;
  readonly digest: string;
  readonly plainBytes: number;
  readonly identity: string;
  readonly heapBytes: number;
  lastUsedAt: number;
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

function compareRows(a: SyncRow, b: SyncRow): number {
  return compareCodePoint(a.s, b.s) || compareCodePoint(a.p, b.p) || compareCodePoint(a.o, b.o);
}

/**
 * Bounded, per-KA export. Cached rows are performance data, never chain authority.
 * The legacy row path recomputes every page on stores lacking stable revisions.
 * The experimental encoded path may retain an earlier root-verified immutable
 * assertion copy, always fenced by fresh full public metadata. Neither copy
 * establishes chain authority or proves present revisionless physical DATA.
 */
export function createBoundedExactAssetExportCache(params: {
  readonly store: TripleStore;
  readonly budget: SyncResponderSnapshotBudget;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  /** Test/operator construction may shrink, never raise, encoded retention. */
  readonly encodedTtlMs?: number;
  readonly encodedMaxEntries?: number;
  readonly encodedMaxBytes?: number;
}): ExactAssetExportCache {
  const { store, budget } = params;
  const ttlMs = params.ttlMs ?? 60_000;
  const maxEntries = params.maxEntries ?? 8;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('Exact asset export cache limits must be positive safe integers');
  }
  const revisions = asGraphWriteRevisionSource(store);
  const cache = new Map<string, ExportEntry>();
  const encodedCache = new Map<string, EncodedEntry>();
  const encodedTtlMs = params.encodedTtlMs ?? EXACT_ASSET_ENCODED_CACHE_TTL_MS;
  const encodedMaxEntries = params.encodedMaxEntries ?? EXACT_ASSET_ENCODED_CACHE_MAX_ENTRIES;
  const encodedMaxBytes = params.encodedMaxBytes ?? EXACT_ASSET_ENCODED_CACHE_MAX_BYTES;
  for (const [value, limit] of [
    [encodedTtlMs, EXACT_ASSET_ENCODED_CACHE_TTL_MS],
    [encodedMaxEntries, EXACT_ASSET_ENCODED_CACHE_MAX_ENTRIES],
    [encodedMaxBytes, EXACT_ASSET_ENCODED_CACHE_MAX_BYTES],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) {
      throw new RangeError('Exact asset encoded cache limits must be positive bounded safe integers');
    }
  }
  let encodedCacheBytes = 0;
  const canReadWholeAsset = supportsBoundedExactGraphExport(store);
  let exports = 0;
  let cacheHits = 0;
  let encodedCacheHits = 0;
  const fallbacks: Partial<Record<ExactAssetExportFallbackReason, number>> = {};
  const refuse = (
    reason: ExactAssetExportFallbackReason,
    request: ExactAssetEncodedExportRequest,
    budgetReason?: SyncRowSnapshotBudgetError['reason'],
  ): null => {
    fallbacks[reason] = (fallbacks[reason] ?? 0) + 1;
    observeExactBatch(() => request.onFallback?.(reason, budgetReason));
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
      return null;
    } catch (error) {
      if (error instanceof SyncRowSnapshotBudgetError) return error;
      throw error;
    }
  };

  const readMetadata = async (
    request: ExactAssetEncodedExportRequest,
    expected?: Pick<ExactAssetExportRequest, 'graph' | 'expectedRows' | 'expectedIdentity'>,
  ): Promise<VerifiedMetadata | null> => {
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
        if (expected?.expectedIdentity !== undefined) throw changed();
        return refuse('metadata-profile', request);
      }
      throw error;
    }
    throwIfAborted(request.signal);
    if (result.type !== 'bindings' || result.bindings.length > METADATA_MAX_ROWS) {
      if (expected?.expectedIdentity !== undefined) throw changed();
      return refuse('metadata-profile', request);
    }
    const metadata = parseResponderAssetMetadata(result.bindings,
      { contextGraphId: request.contextGraphId, ual: request.assetUal });
    if (!metadata) {
      if (expected?.expectedIdentity !== undefined) throw changed();
      throw invalid();
    }
    // A retained export must never silently downgrade into the paged fallback
    // after its metadata changes, including a new private/over-limit profile.
    const { identity, confirmed: parsed } = metadata;
    throwIfAborted(request.signal);
    if (expected?.expectedIdentity !== undefined && identity !== expected.expectedIdentity) throw changed();
    if (parsed.state !== 'confirmed') throw invalid();
    if (metadata.accessPolicy !== 'public') {
      if (metadata.accessPolicy !== 'absent' || parsed.envelope.privateTripleCount !== 0
        || !request.authorizeMissingAccessPolicy || (await request.authorizeMissingAccessPolicy()) !== true) {
        return refuse('non-public', request);
      }
      // Authorization is mandatory control flow, never an observation. Its
      // rejection propagates, and cancellation cannot turn it into a grant.
      throwIfAborted(request.signal);
    }
    if (parsed.envelope.privateTripleCount !== 0) return refuse('private-commitments', request);
    if (expected && (parsed.envelope.assertionGraph !== expected.graph || parsed.envelope.publicTripleCount !== expected.expectedRows)) {
      throw changed();
    }
    return { identity, envelope: parsed.envelope, metaGraph, bindings: metadata.bindings };
  };

  const sourceRevision = (graph: string, metaGraph: string): { key: string | null; reusable: boolean } => {
    if (!revisions) return { key: null, reusable: true };
    const meta = revisions.getWriteRevision(metaGraph);
    const body = revisions.getWriteRevision(graph);
    // An indeterminate remote write never proves quiescence. Keep its token
    // as a local-write fence, but only fresh count/root-verified assertion
    // bytes may be served: neither row nor encoded caches may replay it.
    return { key: JSON.stringify([meta.generation, body.generation, meta.stable, body.stable]),
      reusable: meta.stable && body.stable };
  };

  const lease = (
    entry: ExportEntry,
    keep: boolean,
    request: ExactAssetExportRequest,
    revision: string | null,
    wholePayloadExports: 0 | 1,
  ): ExactAssetExportLease | null => {
    const responseId = Symbol('exact-export-response');
    budget.touch(entry.id);
    const rejected = reserve(responseId, `${entry.key}:response`, 0, RESPONSE_RESERVATION_BYTES, () => {});
    if (rejected) {
      if (entry.active === 0) budget.release(entry.id);
      if (!keep) discard(entry);
      return refuse('response-admission', request, rejected.reason);
    }
    entry.active += 1;
    let released = false;
    return Object.freeze({
      rows: entry.rows,
      identity: entry.identity,
      wholePayloadExports,
      async assertCurrent() {
        if (released) throw changed();
        const metadata = await readMetadata(request, { ...request, expectedIdentity: entry.identity });
        if (!metadata || sourceRevision(request.graph, metadata.metaGraph).key !== revision) throw changed();
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

  const acquireRows = async (
    request: ExactAssetExportRequest,
    knownMetadata?: VerifiedMetadata,
  ): Promise<ExactAssetExportLease | null> => {
      const observeStage = (stage: ExactAssetExportStage, started: number): void => {
        observeExactBatch(() => request.onStage?.(stage, performance.now() - started));
      };
      throwIfAborted(request.signal);
      if (!canReadWholeAsset) return refuse('store-capability', request);
      if (!Number.isSafeInteger(request.expectedRows) || request.expectedRows < 1
        || request.expectedRows > EXACT_ASSET_EXPORT_MAX_ROWS) return refuse('row-profile', request);
      let stageStarted = performance.now();
      const metadata = knownMetadata ?? await readMetadata(request, request);
      if (!knownMetadata) observeStage('export-metadata-before', stageStarted);
      if (!metadata) return null;
      const { key: revision, reusable } = sourceRevision(request.graph, metadata.metaGraph);
      const key = JSON.stringify([request.graph, metadata.identity, revision]);
      prune();
      if (reusable && revision !== null) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.cachedAt < ttlMs) {
          throwIfAborted(request.signal);
          if (sourceRevision(request.graph, metadata.metaGraph).key !== revision) throw changed();
          cacheHits += 1;
          return lease(hit, true, request, revision, 0);
        }
      }
      const id = Symbol('exact-asset-export');
      const rejected = reserve(id, key, request.expectedRows + 1, BUILD_RESERVATION_BYTES, () => {});
      if (rejected) return refuse('build-admission', request, rejected.reason);
      let retained = false;
      try {
        stageStarted = performance.now();
        const payload = await readBoundedGraphPayload(store, request.graph, {
          expectedQuadCount: request.expectedRows, outputGraph: request.graph, canonicalGraph: '',
          profile: {
            maxRows: EXACT_ASSET_EXPORT_MAX_ROWS, maxResponseBytes: EXACT_ASSET_EXPORT_MAX_STORE_BYTES,
            maxNQuadsBytes: EXACT_ASSET_EXPORT_CANONICAL_BYTES, maxHeapBytes: EXACT_ASSET_EXPORT_MAX_HEAP_BYTES,
            rowOverheadBytes: 160, heapAccounting: 'output-graph',
          },
          queryOptions: {
            source: 'sync.responder.exactAssetExport.payload', priority: 'background', signal: request.signal,
          },
          onQuerySettled: () => {
            // Includes scheduler wait, HTTP/body settlement and JSON decoding.
            observeStage('export-store-payload-query', stageStarted);
            stageStarted = performance.now();
          },
        });
        throwIfAborted(request.signal);
        if (payload.status === 'refused') return refuse(payload.reason, request);
        const { heapBytes } = payload;
        const rows: SyncRow[] = payload.quads.map((quad) => Object.freeze({
          s: quad.subject, p: quad.predicate, o: quad.object, g: quad.graph,
        }));
        rows.sort(compareRows);
        const root = computeFlatKCRootV10(rows.map((row) => ({
          subject: row.s, predicate: row.p, object: row.o, graph: '',
        })), []);
        if (!sameRoot(root, metadata.envelope)) throw invalid();
        observeStage('export-canonical-preparation-root', stageStarted);
        stageStarted = performance.now();
        const after = await readMetadata(request, { ...request, expectedIdentity: metadata.identity });
        if (!after || sourceRevision(request.graph, metadata.metaGraph).key !== revision) throw changed();
        observeStage('export-metadata-after', stageStarted);
        throwIfAborted(request.signal);
        exports += 1;
        const entry: ExportEntry = {
          id, key, rows: Object.freeze(rows), identity: metadata.identity,
          heapBytes, cachedAt: Date.now(), active: 0,
        };
        budget.admit({ id, replaceId: id, key, rows: rows.length, bytesEstimate: heapBytes,
          phase: 'durable_data', onEvict: () => { if (cache.get(key) === entry) cache.delete(key); } });
        if (reusable && revision !== null) {
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
        if (error instanceof ExactGraphReadError) throw invalid();
        if (error instanceof SyncRowSnapshotBudgetError) return refuse('build-admission', request, error.reason);
        throw error;
      } finally {
        // Cancellation waits for the actual query promise above before its charge disappears.
        if (!retained) budget.remove(id);
      }
  };

  const discardEncoded = (entry: EncodedEntry): boolean => {
    if (entry.active !== 0) return false;
    if (encodedCache.get(entry.key) === entry) {
      encodedCache.delete(entry.key);
      encodedCacheBytes -= entry.heapBytes;
    }
    budget.remove(entry.id);
    return true;
  };
  const pruneEncoded = () => {
    for (const entry of encodedCache.values()) {
      if (Date.now() - entry.lastUsedAt >= encodedTtlMs) discardEncoded(entry);
    }
  };
  const encodedKey = (request: ExactAssetExportRequest, metadata: VerifiedMetadata, revision: string | null) => (
    JSON.stringify([ENCODED_CACHE_FORMAT, request.contextGraphId, request.assetUal, request.graph,
      metadata.identity, metadata.envelope.assertionVersion, bytesToHex(metadata.envelope.merkleRoot),
      metadata.envelope.publicTripleCount, metadata.envelope.privateTripleCount, EXACT_SYNC_GZIP_ENCODING, revision])
  );
  const assertEncodedCurrent = async (
    request: ExactAssetExportRequest, identity: string, revision: string | null,
  ) => {
    const after = await readMetadata(request, { ...request, expectedIdentity: identity });
    if (!after || sourceRevision(request.graph, after.metaGraph).key !== revision) throw changed();
    throwIfAborted(request.signal);
  };
  const retainEncoded = (key: string, body: Uint8Array, plainBytes: number, identity: string): void => {
    // This is opportunistic retention after a completed source fence. A cache
    // admission failure must not turn a valid current response into refusal.
    if (encodedCache.has(key)) return;
    pruneEncoded();
    const heapBytes = body.byteLength + ENCODED_ENTRY_OVERHEAD_BYTES + 2 * key.length;
    if (heapBytes > encodedMaxBytes) return;
    while (encodedCache.size >= encodedMaxEntries || encodedCacheBytes + heapBytes > encodedMaxBytes) {
      const idle = [...encodedCache.values()].find(entry => entry.active === 0);
      if (!idle || !discardEncoded(idle)) return;
    }
    const id = Symbol('exact-asset-encoded-cache');
    // Reserve before taking ownership of an extra physical copy.
    if (reserve(id, key, 0, heapBytes, () => {
      const entry = encodedCache.get(key);
      if (entry?.id !== id) return;
      encodedCache.delete(key);
      encodedCacheBytes -= entry.heapBytes;
    })) return;
    try {
      const owned = body.slice();
      const entry: EncodedEntry = { id, key, body: owned, digest: bytesToHex(sha256(owned)),
        plainBytes, identity, heapBytes, lastUsedAt: Date.now(), active: 0 };
      encodedCache.set(key, entry);
      encodedCacheBytes += heapBytes;
      budget.release(id);
    } catch (error) {
      budget.remove(id);
      throw error;
    }
  };

  return {
    stats() {
      pruneEncoded();
      return Object.freeze({ exports, cacheHits, encodedCacheHits,
        encodedCacheEntries: encodedCache.size, encodedCacheBytes,
        fallbacks: Object.freeze({ ...fallbacks }) });
    },
    acquire: acquireRows,
    async acquireEncoded(scope) {
      throwIfAborted(scope.signal);
      if (!canReadWholeAsset) return refuse('store-capability', scope);
      const started = performance.now();
      const metadata = await readMetadata(scope);
      observeExactBatch(() => scope.onStage?.('export-metadata-before', performance.now() - started));
      if (!metadata) return null;
      const request: ExactAssetExportRequest = { ...scope, graph: metadata.envelope.assertionGraph,
        expectedRows: metadata.envelope.publicTripleCount, expectedIdentity: metadata.identity };
      if (!Number.isSafeInteger(request.expectedRows) || request.expectedRows < 1
        || request.expectedRows > EXACT_ASSET_EXPORT_MAX_ROWS) return refuse('row-profile', request);
      const metaBytes = ENCODER.encode(serializeResponderRows(metadata.bindings.map(row => ({
        s: request.assetUal, p: row.predicate, o: row.object, g: metadata.metaGraph,
      }))));
      if (metaBytes.byteLength > EXACT_BATCH_MAX_FRAME_BYTES) return refuse('metadata-profile', request);
      const metaDigest = bytesToHex(sha256(metaBytes));
      const { key: revision, reusable } = sourceRevision(request.graph, metadata.metaGraph);
      const key = encodedKey(request, metadata, revision);
      pruneEncoded();
      const hit = reusable ? encodedCache.get(key) : undefined;
      if (hit && Date.now() - hit.lastUsedAt < encodedTtlMs) {
        // Only the independently verified immutable assertion copy is reused.
        // On revisionless stores this is not evidence that present physical
        // DATA remains unchanged. Fresh metadata/public profile and the final
        // fence still apply, and the receiver still authenticates chain truth.
        if (sourceRevision(request.graph, metadata.metaGraph).key !== revision) throw changed();
        if (bytesToHex(sha256(hit.body)) !== hit.digest) {
          discardEncoded(hit);
          throw invalid();
        }
        const responseId = Symbol('exact-encoded-response');
        budget.touch(hit.id);
        const rejected = reserve(responseId, `${key}:response`, 0, RESPONSE_RESERVATION_BYTES, () => {});
        if (rejected) {
          if (hit.active === 0) budget.release(hit.id);
          return refuse('response-admission', request, rejected.reason);
        }
        hit.active += 1;
        let released = false;
        try {
          const body = hit.body.slice();
          hit.lastUsedAt = Date.now();
          encodedCache.delete(key); encodedCache.set(key, hit);
          encodedCacheHits += 1;
          return Object.freeze({ metadata: metaBytes, body, plainBytes: hit.plainBytes, identity: hit.identity,
            wholePayloadExports: 0 as const, encodingDurationMs: 0,
            async assertCurrent() {
              if (released) throw changed();
              await assertEncodedCurrent(request, hit.identity, revision);
              if (bytesToHex(sha256(metaBytes)) !== metaDigest) throw invalid();
            },
            release() {
              if (released) return;
              released = true;
              budget.remove(responseId);
              hit.active -= 1;
              if (hit.active === 0) {
                if (Date.now() - hit.lastUsedAt >= encodedTtlMs) discardEncoded(hit);
                else budget.release(hit.id);
              }
            },
          });
        } catch (error) {
          budget.remove(responseId);
          hit.active -= 1;
          if (hit.active === 0) budget.release(hit.id);
          throw error;
        }
      }

      const rows = await acquireRows(request, metadata);
      if (!rows) return null;
      let transferred = false;
      try {
        const encodeStarted = performance.now();
        const plain = ENCODER.encode(serializeResponderRows(rows.rows));
        const plainBytes = plain.byteLength;
        const body = await encodeNegotiatedExactSyncResponse(plain, {
          request: { phase: 'data', assetUals: [request.assetUal], responseEncoding: EXACT_SYNC_GZIP_ENCODING },
          signal: request.signal,
        });
        throwIfAborted(request.signal);
        // Keep the physical codec's existing compressed and plaintext bounds.
        if (body.byteLength < 1 || body.byteLength > EXACT_SYNC_GZIP_MAX_COMPRESSED_BYTES
          || plainBytes > EXACT_SYNC_GZIP_MAX_INFLATED_BYTES) throw invalid();
        const encodingDurationMs = performance.now() - encodeStarted;
        const digest = bytesToHex(sha256(body));
        let released = false;
        let retained = false;
        const encoded = Object.freeze({ metadata: metaBytes, body, plainBytes, identity: rows.identity,
          wholePayloadExports: rows.wholePayloadExports ?? 1, encodingDurationMs,
          async assertCurrent() {
            if (released) throw changed();
            await rows.assertCurrent();
            if (bytesToHex(sha256(metaBytes)) !== metaDigest) throw invalid();
            // The cold response is caller-owned until promotion. Never retain
            // bytes changed by a send adapter or another response consumer.
            if (bytesToHex(sha256(body)) !== digest) throw invalid();
            if (!retained && reusable) {
              retainEncoded(key, body, plainBytes, rows.identity);
              retained = true;
            }
          },
          release() {
            if (released) return;
            released = true;
            rows.release();
          },
        });
        transferred = true;
        return encoded;
      } finally {
        // The physical encoder settles before its row/response charge ends.
        if (!transferred) rows.release();
      }
    },
  };
}

function sameRoot(root: Uint8Array, envelope: ConfirmedGraphKnowledgeAssetMetadataEnvelope): boolean {
  return root.length === envelope.merkleRoot.length
    && root.every((byte, index) => byte === envelope.merkleRoot[index]);
}
