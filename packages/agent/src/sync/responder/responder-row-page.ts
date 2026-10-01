import type { SyncRow, SyncRowListMemo } from './snapshot-cache.js';
import {
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE, SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
  SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS, isSyncRowSnapshotPagingRequiredError,
} from './snapshot-cache.js';
import { SyncRowSnapshotBudgetError } from './snapshot-budget.js';
import { estimateStringRowHeapBytes } from '../memory-telemetry.js';
import { metaSubjectKey } from './row-serialization.js';
const COMPLETED_SYNC_RESPONDER_SESSION_GRACE_MS = 30_000;

export interface RowListCache {
  memo: SyncRowListMemo;
  key: string;
  refresh?: boolean;
  refreshGeneration?: string;
  expiredMessage?: string;
  /** Byte-budget pages may serialize only a prefix of a short row slice. */
  releaseOnShortPage?: boolean;
}

/**
 * Session-plan getter shared by the plan-backed lanes (exact-graph and TTL SWM
 * meta), owning the one lifecycle both must agree on:
 *
 *  - the explicit session refresh is consumed exactly ONCE, so when a snapshot
 *    build crosses its budget, the immediate page-zero fallback reuses the
 *    just-built plan instead of rebuilding (and re-counting) it against a
 *    moving store;
 *  - offset>0 REQUIRES the existing plan — silently rebuilding against moved
 *    data would make the numeric offset skip or duplicate rows;
 *  - memo expiry becomes the lane's session-expired error.
 *
 * The SWM data lane intentionally does not use this helper: it has no snapshot
 * lane, so a single plan access per page means per-call refresh semantics are
 * equivalent and simpler there.
 */
/**
 * Sessionless callers (no `syncSessionId` => no memo cache key) rebuild the
 * plan on EVERY page: per-page discovery + chunked GROUP BY cost (bounded, and
 * still far cheaper than the deleted global-sort query), no `requireExisting`
 * protection, and a fresh digest sidecar per plan object. Offset>0 pages
 * against a mutating store can therefore skip or duplicate rows for such
 * requesters — sessionless TTL paging is BEST-EFFORT, and the per-subject
 * digest guard does NOT cover it. This matches the exposure of the old OFFSET
 * lane (not a regression); requester-side verification still gates admission.
 */
export function createSessionPlanGetter<T>(
  memo: {
    get(
      key: string,
      load: () => Promise<T>,
      options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
    ): Promise<T | null>;
  } | undefined,
  cacheKey: string | undefined,
  initialRefreshPending: boolean,
  loadPlan: (signal?: AbortSignal) => Promise<T>,
  expiredMessage: string,
): (pageOffset: number, pageSignal: AbortSignal | undefined) => Promise<T> {
  let planRefreshPending = initialRefreshPending;
  return async (pageOffset, pageSignal) => {
    const refreshPlan = pageOffset === 0 && planRefreshPending;
    if (refreshPlan) planRefreshPending = false;
    const plan = memo && cacheKey
      ? await memo.get(cacheKey, () => loadPlan(pageSignal), {
        refresh: refreshPlan,
        requireExisting: pageOffset > 0,
        signal: pageSignal,
      })
      : await loadPlan(pageSignal);
    if (!plan) throw new Error(expiredMessage);
    return plan;
  };
}

/**
 * Serve one responder page, owning the single budget-fallback policy for every
 * memoized phase. It tries the stable-snapshot cache first, but an
 * intrinsically-oversized snapshot (over the PER-snapshot row/byte budget) must
 * stay syncable, so it falls back to the store-bounded page read for this and
 * every later page of the session. Transient store errors propagate: they are
 * not proof of intrinsic size, and OFFSET paging cannot provide an immutable
 * session view when the underlying graph may change between requests.
 *
 * GLOBAL (process-wide) budget pressure is deliberately NOT swallowed here: it
 * is not a `snapshot_rows`/`snapshot_bytes` error, so it propagates as the quiet
 * retryable limit and the requester retries once other sessions drain.
 *
 * Sequential store-bounded fallback pages retain a bounded per-session cursor
 * for the last row returned by each page and use a keyset filter for the next
 * request. This avoids making the store revisit a growing exact-graph OFFSET
 * prefix while preserving the committed graph row count and final-page
 * sentinel checks. Unknown offsets and cursor boundaries containing blank
 * nodes retain the deterministic OFFSET compatibility path because portable
 * SPARQL does not define a backend-independent blank-node ordering.
 *
 * The cursor map is session-local and bounded. A boundary changing within the
 * memoized plan, a row-count mismatch, or a surplus final-page row still fails
 * closed; durable data remains Merkle-verified end-to-end by the requester.
 */
export type StorePageLoader = (
  offset: number,
  limit: number,
  signal?: AbortSignal,
) => Promise<SyncRow[]>;

async function loadStorePagedSnapshot(
  cache: RowListCache,
  loadPage: StorePageLoader,
): Promise<readonly SyncRow[]> {
  const limits = cache.memo.snapshotLoadLimits ?? {
    maxRows: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
    maxBytesEstimate: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
    pageRows: SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
  };
  const rows: SyncRow[] = [];
  let bytesEstimate = 0;
  let offset = 0;
  // Read at most one row beyond the configured row cap. Tiny-budget tests and
  // operators therefore never receive a 500-row temporary page merely to learn
  // that a one-row snapshot is oversized.
  const pageRows = Math.max(
    1,
    Math.min(Math.floor(limits.pageRows), Math.floor(limits.maxRows) + 1),
  );

  while (true) {
    // The shared snapshot load is owner-independent: an individual request
    // abort must not cancel a load used by coalesced waiters.
    const page = await loadPage(offset, pageRows, undefined);
    for (const row of page) {
      const nextRows = rows.length + 1;
      const nextBytes = bytesEstimate + estimateStringRowHeapBytes(row.s, row.p, row.o, row.g);
      if (nextRows > limits.maxRows) {
        throw new SyncRowSnapshotBudgetError({
          key: cache.key,
          reason: 'snapshot_rows',
          rows: nextRows,
          bytesEstimate: nextBytes,
          limit: limits.maxRows,
        });
      }
      if (nextBytes > limits.maxBytesEstimate) {
        throw new SyncRowSnapshotBudgetError({
          key: cache.key,
          reason: 'snapshot_bytes',
          rows: nextRows,
          bytesEstimate: nextBytes,
          limit: limits.maxBytesEstimate,
        });
      }
      rows.push(row);
      bytesEstimate = nextBytes;
    }
    if (page.length < pageRows) return rows;
    offset += page.length;
  }
}

interface ResponderRowsPageOptions {
  /** Session snapshot loader; omitted phases build via the store-paged loader. */
  loadSnapshot?: () => Promise<readonly SyncRow[]>;
  /**
   * Extend a served page forward so it ends on a `(g, s)` subject boundary,
   * never mid-subject (#1788). Only the durable-meta lane sets this: its rows
   * carry graph-scoped seals whose control fields (`dkg:assertionVersion`) are
   * admitted only as a complete in-batch subject. Safe because durable meta
   * uses byte-budget pagination (requester page size 8192 > the 500 legacy
   * cap), so the requester never treats an over-sized page as EOF — it advances
   * by the actual row count and the next OFFSET lands on the next subject. This
   * option governs only the cached (snapshot) path; the store-paged loader is
   * made subject-atomic at its call site. See {@link metaSubjectKey}.
   */
  subjectAtomic?: boolean;
}

export async function readResponderRowsPage(
  cache: RowListCache | undefined,
  loadStoreBoundedPage: StorePageLoader,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  options?: ResponderRowsPageOptions,
): Promise<SyncRow[]> {
  const loadSnapshot = options?.loadSnapshot;
  const subjectAtomic = options?.subjectAtomic ?? false;
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  // No session snapshot: the store-paged loader itself enforces subject
  // atomicity where required (durable meta passes a subject-atomic loader), so
  // this path needs no extra handling.
  if (!cache) return loadStoreBoundedPage(safeOffset, safeLimit, signal);
  try {
    return await readCachedRowsPage(
      cache,
      loadSnapshot ?? (() => loadStorePagedSnapshot(cache, loadStoreBoundedPage)),
      safeOffset,
      safeLimit,
      signal,
      subjectAtomic,
    );
  } catch (error) {
    if (!isSyncRowSnapshotPagingRequiredError(error)) throw error;
    return loadStoreBoundedPage(safeOffset, safeLimit, signal);
  }
}

async function readCachedRowsPage(
  cache: RowListCache,
  loadRows: () => Promise<readonly SyncRow[]>,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  subjectAtomic = false,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const rows = await cache.memo.get(cache.key, loadRows, {
    refresh: cache.refresh,
    refreshGeneration: cache.refreshGeneration,
    // No prefix has been consumed at offset zero, so an entry evicted under
    // responder memory pressure can be rebuilt without mixing snapshots.
    refreshExpired: safeOffset === 0,
    requireExisting: safeOffset > 0,
    signal,
  });
  if (rows == null) {
    throw new Error(cache.expiredMessage ?? 'Sync session snapshot expired before page completion');
  }
  // `rows` is an immutable snapshot. Slice it directly so serving a 500-row
  // page allocates only that page's backing array, never a shallow copy of the
  // complete snapshot first.
  let pageEnd = Math.min(safeOffset + safeLimit, rows.length);
  // Subject-atomic durable-meta lane (#1788): if the requested window ends
  // mid-subject, EXTEND it forward until the subject changes (or the snapshot
  // ends) so a graph-scoped seal is never split across a page — and therefore
  // never across a sync round. Extending (never trimming) keeps a non-final
  // page `>= safeLimit`, so it never trips the requester's empty-page EOF nor
  // the release-on-short-page path below. Reads only in-page indices plus a
  // bounded one-subject lookahead — never the whole snapshot. `_meta` subjects
  // are small (a seal is 14 quads; KA descriptors ~10; membership/activity rows
  // bounded), so the extension is O(one subject) and negligible against the
  // #1868 64k-row meta snapshot ceiling; a pathologically large subject is
  // still emitted whole rather than truncated, with the transport frame limit
  // as the final guard.
  if (subjectAtomic && pageEnd > safeOffset && pageEnd < rows.length) {
    const trailingKey = metaSubjectKey(rows[pageEnd - 1]);
    while (pageEnd < rows.length && metaSubjectKey(rows[pageEnd]) === trailingKey) {
      pageEnd += 1;
    }
  }
  const page = rows.slice(safeOffset, pageEnd);
  if (page.length === 0 || (cache.releaseOnShortPage !== false && page.length < safeLimit)) {
    cache.memo.release(cache.key, { graceMs: COMPLETED_SYNC_RESPONDER_SESSION_GRACE_MS });
  }
  return page;
}

function asAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

export function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(asAbortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
