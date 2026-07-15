import {
  DKG_ONTOLOGY,
  MemoryLayer,
  assertSafeIri,
  sparqlString,
  validateSubGraphName,
  contextGraphCatalogUri,
} from '@origintrail-official/dkg-core';
import type { QueryOptions, TripleStore, ChangelogReader, ChangeOp } from '@origintrail-official/dkg-storage';
import { isSharedMemoryBucketDescendantDataGraph } from '../shared-memory-graphs.js';
import type { SyncRow, SyncRowListMemo } from './snapshot-cache.js';
import {
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
  SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
} from './snapshot-cache.js';
import { SyncRowSnapshotBudgetError } from './snapshot-budget.js';
import { estimateStringRowHeapBytes } from '../memory-telemetry.js';
import type { ChangelogSyncResponse, ChangelogDeltaRecord } from '../changelog/wire.js';
import { durableMetaDelegationSubjectAdmissionExpression } from './durable-meta-admission.js';

export {
  createResponderSyncRowListMemo,
  SyncRowSnapshotLimitError,
  type SyncRow,
  type SyncRowListMemo,
} from './snapshot-cache.js';

const DKG = 'http://dkg.io/ontology/';
const DKG_SUB_GRAPH = `${DKG}SubGraph`;
const DKG_WORKSPACE_OPERATION = `${DKG}WorkspaceOperation`;
const DKG_PUBLISHED_AT = `${DKG}publishedAt`;
const DKG_ROOT_ENTITY = `${DKG}rootEntity`;
const DKG_ASSERTION_GRAPH = `${DKG}assertionGraph`;
const DKG_ASSERTION_NAME = `${DKG}assertionName`;
const DKG_MEMORY_LAYER = `${DKG}memoryLayer`;
const DKG_PART_OF = `${DKG}partOf`;
const DKG_BATCH_ID = `${DKG}batchId`;
const SCHEMA_NAME = 'http://schema.org/name';
const PROV_GENERATED = 'http://www.w3.org/ns/prov#generated';
const PROV_USED = 'http://www.w3.org/ns/prov#used';
const DKG_JOIN_REQUEST_SUBJECT_PREFIX = 'did:dkg:join-request:';
const COMPLETED_SYNC_RESPONDER_SESSION_GRACE_MS = 30_000;

function syncResponderStoreOptions(signal: AbortSignal | undefined, source: string): QueryOptions {
  return { signal, priority: 'background', source };
}

export interface GraphListMemo {
  get(options?: {
    refresh?: boolean;
    refreshGeneration?: string;
    signal?: AbortSignal;
  }): Promise<readonly string[]>;
}

export interface SubGraphNameMemo {
  get(contextGraphId: string, options?: {
    refresh?: boolean;
    refreshGeneration?: string;
    signal?: AbortSignal;
  }): Promise<readonly string[]>;
}

interface RowListCache {
  memo: SyncRowListMemo;
  key: string;
  refresh?: boolean;
  refreshGeneration?: string;
  expiredMessage?: string;
}

export function createResponderGraphListMemo(
  store: TripleStore,
  ttlMs = 10_000,
): GraphListMemo {
  let cached: {
    value: readonly string[];
    cachedAt: number;
    refreshGeneration?: string;
  } | null = null;
  let inflight: {
    promise: Promise<readonly string[]>;
    refreshGeneration?: string;
  } | null = null;
  return {
    async get(options?: {
      refresh?: boolean;
      refreshGeneration?: string;
      signal?: AbortSignal;
    }) {
      throwIfAborted(options?.signal);
      while (inflight) {
        const pending = inflight;
        const supersedesPending = options?.refreshGeneration !== undefined &&
          options.refreshGeneration !== pending.refreshGeneration;
        if (!supersedesPending) {
          return [...(await raceAgainstAbort(pending.promise, options?.signal))];
        }
        try {
          await raceAgainstAbort(pending.promise, options?.signal);
        } catch {
          throwIfAborted(options?.signal);
        }
      }
      const now = Date.now();
      if (
        cached &&
        options?.refreshGeneration !== undefined &&
        cached.refreshGeneration !== options.refreshGeneration
      ) cached = null;
      if (!options?.refresh && cached && now - cached.cachedAt < ttlMs) return [...cached.value];
      // This load is shared by concurrent responders. Do not bind it to the
      // first stream's abort signal; waiters race their own abort locally via
      // raceAgainstAbort/throwIfAborted below.
      const load = store.listGraphs(syncResponderStoreOptions(undefined, 'sync.responder.listGraphs'))
        .then((graphs) => {
          const sorted = [...new Set(graphs)].sort(compareCodePoint);
          cached = {
            value: sorted,
            cachedAt: Date.now(),
            refreshGeneration: options?.refreshGeneration,
          };
          return sorted;
        })
        .finally(() => {
          if (inflight?.promise === load) inflight = null;
        });
      inflight = {
        promise: load,
        refreshGeneration: options?.refreshGeneration,
      };
      const graphs = await load;
      throwIfAborted(options?.signal);
      return [...graphs];
    },
  };
}

export function createResponderSwmAdmissionMemo(
  store: TripleStore,
  ttlMs = 10_000,
): SubGraphNameMemo {
  return createSubGraphNameMemo(
    (contextGraphId) => readAdmittedSwmSubGraphNames(store, contextGraphId),
    ttlMs,
  );
}

export function createResponderSubGraphRegistrationMemo(
  store: TripleStore,
  ttlMs = 10_000,
): SubGraphNameMemo {
  return createSubGraphNameMemo(
    (contextGraphId) => readRegisteredSubGraphNames(store, contextGraphId),
    ttlMs,
  );
}

function createSubGraphNameMemo(
  loadNames: (contextGraphId: string) => Promise<string[]>,
  ttlMs: number,
): SubGraphNameMemo {
  const cached = new Map<string, {
    value: readonly string[];
    cachedAt: number;
    refreshGeneration?: string;
  }>();
  const inflight = new Map<string, {
    promise: Promise<readonly string[]>;
    refreshGeneration?: string;
  }>();
  return {
    async get(contextGraphId: string, options?: {
      refresh?: boolean;
      refreshGeneration?: string;
      signal?: AbortSignal;
    }) {
      throwIfAborted(options?.signal);
      while (true) {
        const pending = inflight.get(contextGraphId);
        if (!pending) break;
        const supersedesPending = options?.refreshGeneration !== undefined &&
          options.refreshGeneration !== pending.refreshGeneration;
        if (!supersedesPending) {
          return [...(await raceAgainstAbort(pending.promise, options?.signal))];
        }
        try {
          await raceAgainstAbort(pending.promise, options?.signal);
        } catch {
          throwIfAborted(options?.signal);
        }
      }
      const now = Date.now();
      let existing = cached.get(contextGraphId);
      if (
        existing &&
        options?.refreshGeneration !== undefined &&
        existing.refreshGeneration !== options.refreshGeneration
      ) {
        cached.delete(contextGraphId);
        existing = undefined;
      }
      if (!options?.refresh && existing && now - existing.cachedAt < ttlMs) return [...existing.value];
      const load = loadNames(contextGraphId)
        .then((names) => {
          cached.set(contextGraphId, {
            value: names,
            cachedAt: Date.now(),
            refreshGeneration: options?.refreshGeneration,
          });
          return names;
        })
        .finally(() => {
          if (inflight.get(contextGraphId)?.promise === load) inflight.delete(contextGraphId);
        });
      inflight.set(contextGraphId, {
        promise: load,
        refreshGeneration: options?.refreshGeneration,
      });
      const names = await load;
      throwIfAborted(options?.signal);
      return [...names];
    },
  };
}

export function compareCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const delta = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

export function compareRows(a: SyncRow, b: SyncRow): number {
  return (
    compareCodePoint(a.g, b.g) ||
    compareCodePoint(a.s, b.s) ||
    compareCodePoint(a.p, b.p) ||
    compareCodePoint(a.o, b.o)
  );
}

export function serializeResponderRows(rows: readonly SyncRow[]): string {
  return rows.map((row) =>
    `${formatTerm(row.s)} <${assertSafeIri(row.p)}> ${formatTerm(row.o)} <${assertSafeIri(row.g)}> .`,
  ).join('\n');
}

export async function readSwmMetaPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  registeredSubGraphNames: readonly string[];
  contextGraphId: string;
  cutoffIso: string | null;
  offset: number;
  limit: number;
  signal?: AbortSignal;
  rowListMemo?: SyncRowListMemo;
  rowListCacheKey?: string;
  refreshRowList?: boolean;
  refreshGeneration?: string;
}): Promise<SyncRow[]> {
  const graphs = swmGraphsForRegisteredSubGraphs(params.contextGraphId, params.registeredSubGraphNames, true);
  const graphSet = new Set(params.graphList);
  const candidateGraphs = graphs.filter((graph) => graphSet.has(graph));
  const cache = params.rowListMemo && params.rowListCacheKey
    ? {
      memo: params.rowListMemo,
      key: params.rowListCacheKey,
      refresh: params.refreshRowList,
      refreshGeneration: params.refreshGeneration,
      expiredMessage: 'Shared-memory meta sync session snapshot expired before page completion',
    }
    : undefined;
  return readResponderRowsPage(
    cache,
    (offset, limit, signal) => readSwmMetaRowsPage(
      params.store,
      candidateGraphs,
      params.cutoffIso,
      offset,
      limit,
      signal,
    ),
    params.offset,
    params.limit,
    params.signal,
  );
}

export async function readSwmDataPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  registeredSubGraphNames: readonly string[];
  contextGraphId: string;
  cutoffIso: string | null;
  offset: number;
  limit: number;
  signal?: AbortSignal;
  rowListMemo?: SyncRowListMemo;
  rowListCacheKey?: string;
  refreshRowList?: boolean;
  refreshGeneration?: string;
}): Promise<SyncRow[]> {
  const dataGraphs = swmGraphsForRegisteredSubGraphs(params.contextGraphId, params.registeredSubGraphNames, false);
  const graphSet = new Set(params.graphList);
  const candidateGraphsFor = (graph: string) => params.graphList
    .filter((candidate) => candidate === graph || isSharedMemoryBucketDescendantDataGraph(candidate, graph))
    .sort(compareCodePoint);
  const cache = params.rowListMemo && params.rowListCacheKey
    ? {
      memo: params.rowListMemo,
      key: params.rowListCacheKey,
      refresh: params.refreshRowList,
      refreshGeneration: params.refreshGeneration,
      expiredMessage: 'Shared-memory data sync session snapshot expired before page completion',
    }
    : undefined;

  if (!params.cutoffIso) {
    const candidateGraphs = dedupeStrings(dataGraphs.flatMap(candidateGraphsFor)).sort(compareCodePoint);
    return readPagedRowsAcrossGraphs(
      params.store,
      candidateGraphs,
      params.offset,
      params.limit,
      async () => true,
      cache,
      params.signal,
    );
  }

  return readResponderRowsPage(
    cache,
    (offset, limit, signal) => readFreshSwmDataRowsPage(
      params.store,
      dataGraphs,
      graphSet,
      candidateGraphsFor,
      params.cutoffIso!,
      offset,
      limit,
      signal,
    ),
    params.offset,
    params.limit,
    params.signal,
  );
}

export async function readDurableMetaPage(params: {
  store: TripleStore;
  contextGraphId: string;
  registeredSubGraphNames: readonly string[];
  offset: number;
  limit: number;
  signal?: AbortSignal;
  rowListMemo?: SyncRowListMemo;
  rowListCacheKey?: string;
  refreshRowList?: boolean;
  refreshGeneration?: string;
}): Promise<SyncRow[]> {
  const cache = params.rowListMemo && params.rowListCacheKey
    ? {
      memo: params.rowListMemo,
      key: params.rowListCacheKey,
      refresh: params.refreshRowList,
      refreshGeneration: params.refreshGeneration,
      expiredMessage: 'Durable meta sync session snapshot expired before page completion',
    }
    : undefined;
  return readResponderRowsPage(
    cache,
    (offset, limit, signal) => readDurableMetaRowsPage(
      params.store,
      params.contextGraphId,
      params.registeredSubGraphNames,
      offset,
      limit,
      signal,
    ),
    params.offset,
    params.limit,
    params.signal,
  );
}

/** Response byte budget for one changelog delta page — keeps a page under the
 * transport read cap (the requester loops for more). A single graph larger than
 * this is still emitted alone rather than split across pages. */
const DEFAULT_CHANGELOG_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * The per-CG admission boundary shared by the durable-data phase and the
 * changelog delta lane: the candidate-graph exclusions (wrong CG / top `_meta` /
 * `/_shared_memory*` / `/_private`) and the RFC-49 `isAdmitted` gate
 * (assertion-graph membership + child-CG descendant rejection). `assertionGraphs`
 * is memoised per invocation, matching the original inline closure.
 */
function createAdmissionContext(
  store: TripleStore,
  contextGraphId: string,
  // The durable-DATA phase (readDurableDataPage) excludes the top-level `_meta`
  // graph because the separate durable-META phase serves it. The changelog lane
  // serves data AND meta in ONE delta stream, so it must INCLUDE topMeta —
  // otherwise a public CG routed to changelog-only never converges its top-level
  // metadata (OT-RFC-59 review 🔴 3594). SWM (own phase) and `/_private` stay out.
  opts: { includeTopMeta?: boolean } = {},
): {
  cgPrefix: string;
  topMetaGraph: string;
  isCandidateGraph: (graph: string) => boolean;
  isAdmitted: (signal?: AbortSignal) => (graph: string) => Promise<boolean>;
} {
  const cgPrefix = contextGraphDataGraphUri(contextGraphId);
  const topMetaGraph = contextGraphMetaGraphUri(contextGraphId);
  const isCandidateGraph = (graph: string): boolean => {
    if (graph !== cgPrefix && !graph.startsWith(`${cgPrefix}/`)) return false;
    if (!opts.includeTopMeta && graph === topMetaGraph) return false;
    // SWM graphs are the dedicated SWM phase's exclusive domain; `/_private` is
    // never durable-served (see readDurableDataPage's original inline note).
    if (graph.includes('/_shared_memory')) return false;
    return !graph.includes('/_private');
  };
  let assertionGraphs: Set<string> | null = null;
  const isAdmitted = (signal?: AbortSignal) => async (graph: string): Promise<boolean> => {
    if (graph.includes('/assertion/')) {
      assertionGraphs ??= await readAdmittedAssertionGraphs(store, contextGraphId, signal);
      const assertionGraph = graph.endsWith('/_meta') ? graph.slice(0, -'/_meta'.length) : graph;
      if (!assertionGraphs.has(assertionGraph)) return false;
    }
    return !(await isDescendantOfKnownChildContextGraph(store, cgPrefix, graph, signal));
  };
  return { cgPrefix, topMetaGraph, isCandidateGraph, isAdmitted };
}

/**
 * OT-RFC-59 changelog delta lane (PROTOCOL_SYNC_CHANGELOG). Answers "what changed
 * in this CG since (era, sinceSeq)?" from the append-only log instead of scanning
 * the store. Reuses the SAME candidate exclusions + RFC-49 `isAdmitted` boundary
 * as the durable-data phase, applied to BOTH upsert and drop records, so a graph
 * — or its very existence — the requester may not host never leaks.
 *
 * Returns a `resync` directive on era mismatch / rollback / first contact (the
 * requester then runs the existing bootstrap lane), else a byte-bounded `delta`
 * page. Progress is `nextSeq` (scanned-through), never the record count, because
 * `readChanges` is node-global and a CG-scoped page can be validly empty.
 */
export async function readChangelogDeltaPage(params: {
  reader: ChangelogReader;
  store: TripleStore;
  contextGraphId: string;
  sinceSeq: number;
  requesterEra: string | null;
  limit: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}): Promise<ChangelogSyncResponse> {
  const head = await params.reader.changelogHead(
    syncResponderStoreOptions(params.signal, 'sync.responder.changelogHead'),
  );

  // (1) First contact / era rotation (wipe, restore) / rollback ⇒ full resync.
  if (
    params.requesterEra == null ||
    params.requesterEra !== head.era ||
    head.seq < params.sinceSeq
  ) {
    return { kind: 'resync', era: head.era, headSeq: head.seq };
  }

  // (2) Node-global raw scan of the log since the requester's cursor.
  const raw = await params.reader.readChanges(
    params.sinceSeq,
    params.limit,
    syncResponderStoreOptions(params.signal, 'sync.responder.readChanges'),
  );

  // (3) Re-apply the candidate exclusions (readChanges bypassed every phase
  // filter) and collapse to the latest op per graph (ascending seq ⇒ last wins).
  // The changelog lane serves data AND meta in one stream, so — unlike the durable
  // DATA phase — it INCLUDES the top-level `_meta` graph (the requester applies meta
  // as a trusted anchor, legacy-parity), so a changelog-only public CG converges its
  // top-level metadata rather than silently skipping it.
  const { isCandidateGraph, isAdmitted } = createAdmissionContext(
    params.store, params.contextGraphId, { includeTopMeta: true },
  );
  const lastOp = new Map<string, { seq: number; op: ChangeOp }>();
  for (const r of raw) {
    if (!isCandidateGraph(r.graph)) continue; // wrong-CG / SWM / private — hides other/private-CG URIs
    lastOp.set(r.graph, { seq: r.seq, op: r.op });
  }

  // (4) Admit + serialise in SEQ order under a byte budget. Emitting ascending by
  // seq makes `nextSeq = last-emitted seq` safe on a partial page: every graph
  // with a smaller last-op seq is already emitted, so re-requesting from nextSeq
  // never skips an un-emitted change.
  const admit = isAdmitted(params.signal);
  const ordered = [...lastOp.entries()]
    .map(([graph, v]) => ({ graph, seq: v.seq, op: v.op }))
    .sort((a, b) => a.seq - b.seq);
  const budget = params.maxResponseBytes ?? DEFAULT_CHANGELOG_PAGE_BYTES;

  const records: ChangelogDeltaRecord[] = [];
  let bytes = 0;
  let budgetStopped = false;
  for (const { graph, seq, op } of ordered) {
    if (!(await admit(graph))) continue; // unadmitted ⇒ omit URI + op entirely
    if (op === 'drop') {
      records.push({ seq, graph, op: 'drop' });
      continue;
    }
    // Changelog upserts serialize the whole admitted graph. Keep curator-only
    // moderation rows out of that snapshot at the store boundary so a long
    // join-request history is neither materialized nor sent to members.
    const quads = serializeResponderRows(
      await readRowsAcrossGraphsExcludingSubjectPrefix(
        params.store,
        [graph],
        DKG_JOIN_REQUEST_SUBJECT_PREFIX,
        params.signal,
      ),
    );
    // Always include at least one record; otherwise stop before exceeding the
    // budget (a single graph over budget is emitted alone, never split).
    if (records.length > 0 && bytes + quads.length > budget) {
      budgetStopped = true;
      break;
    }
    bytes += quads.length;
    records.push({ seq, graph, op: 'upsert', quads });
  }

  // (5) nextSeq: on a budget-truncated page, the last emitted record's seq; else
  // the scanned-through high-water — head.seq if the scan drained the log,
  // otherwise the max raw seq scanned (more remains beyond this window).
  const scannedTo = raw.length > 0 ? raw[raw.length - 1].seq : head.seq;
  const drained = raw.length < params.limit;
  const nextSeq = budgetStopped
    ? records[records.length - 1].seq
    : drained ? head.seq : scannedTo;

  return { kind: 'delta', era: head.era, headSeq: head.seq, nextSeq, records };
}

export async function readDurableDataPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  contextGraphId: string;
  sinceBatchId: bigint | null;
  offset: number;
  limit: number;
  signal?: AbortSignal;
  rowListMemo?: SyncRowListMemo;
  rowListCacheScope?: string;
  refreshRowList?: boolean;
  refreshGeneration?: string;
}): Promise<SyncRow[]> {
  // Admission context (candidate exclusions + RFC-49 `isAdmitted`) — extracted to
  // a module factory so `readChangelogDeltaPage` reuses it verbatim. Behaviour
  // here is byte-identical to the previous inline closures.
  const { cgPrefix, topMetaGraph, isCandidateGraph, isAdmitted } =
    createAdmissionContext(params.store, params.contextGraphId);
  const candidateGraphs = params.graphList.filter(isCandidateGraph).sort(compareCodePoint);

  if (params.sinceBatchId == null) {
    return readPagedRowsAcrossGraphs(
      params.store,
      candidateGraphs,
      params.offset,
      params.limit,
      isAdmitted(params.rowListMemo ? undefined : params.signal),
      params.rowListMemo
        ? {
          memo: params.rowListMemo,
          key: durableDataRowListCacheKey(params.rowListCacheScope ?? 'default', params.contextGraphId, params.sinceBatchId),
          refresh: params.refreshRowList,
          refreshGeneration: params.refreshGeneration,
        }
        : undefined,
      params.signal,
    );
  }

  const graphs: string[] = [];
  const isAdmittedForRequest = isAdmitted(params.signal);
  for (const graph of candidateGraphs) {
    if (await isAdmittedForRequest(graph)) graphs.push(graph);
  }

  const metaGraphs = [
    topMetaGraph,
    ...graphs.filter((graph) =>
      graph.startsWith(`${cgPrefix}/`) && graph.endsWith('/_meta'),
    ),
  ];
  return readPagedDurableDeltaRowsAcrossGraphs(
    params.store,
    graphs,
    metaGraphs,
    params.sinceBatchId,
    params.offset,
    params.limit,
    params.rowListMemo
      ? {
        memo: params.rowListMemo,
        key: durableDataRowListCacheKey(params.rowListCacheScope ?? 'default', params.contextGraphId, params.sinceBatchId),
        refresh: params.refreshRowList,
        refreshGeneration: params.refreshGeneration,
      }
      : undefined,
    params.signal,
  );
}

/**
 * read the public catalog facet. STRICTLY bounded to exactly the
 * `_catalog` named graph (`did:dkg:context-graph:{cg}/_catalog`): it reads that
 * one graph and nothing else, so the open-serve path cannot leak any gated
 * quad. This is the only graph the §7 facet open-serve releases without auth.
 */
export async function readCatalogPage(params: {
  store: TripleStore;
  contextGraphId: string;
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  const catalogGraph = contextGraphCatalogUri(params.contextGraphId);
  return readPagedRowsAcrossGraphs(
    params.store,
    [catalogGraph],
    params.offset,
    params.limit,
    async () => true, // the single graph is already the bound; admit it
  );
}

async function readPagedRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  isAdmitted: (graph: string) => Promise<boolean>,
  cache?: RowListCache,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  return readResponderRowsPage(
    cache && {
      ...cache,
      expiredMessage: cache.expiredMessage ?? 'Durable data sync session snapshot expired before page completion',
    },
    (pageOffset, pageLimit, pageSignal) => readPagedRowsAcrossGraphsStoreBounded(
      store,
      graphs,
      pageOffset,
      pageLimit,
      isAdmitted,
      pageSignal,
    ),
    offset,
    limit,
    signal,
  );
}

async function readPagedRowsAcrossGraphsStoreBounded(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  isAdmitted: (graph: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const admittedGraphs: string[] = [];
  for (const graph of graphs) {
    if (!(await isAdmitted(graph))) continue;
    admittedGraphs.push(graph);
  }

  return readRowsPageAcrossGraphs(store, admittedGraphs, offset, limit, signal);
}

async function readPagedDurableDeltaRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  offset: number,
  limit: number,
  cache?: RowListCache,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  return readResponderRowsPage(
    cache && {
      ...cache,
      expiredMessage: cache.expiredMessage ?? 'Durable data sync session snapshot expired before page completion',
    },
    (pageOffset, pageLimit, pageSignal) => readDurableDeltaRowsPageAcrossGraphs(
      store,
      graphs,
      metaGraphs,
      sinceBatchId,
      pageOffset,
      pageLimit,
      pageSignal,
    ),
    offset,
    limit,
    signal,
  );
}

function isPerSnapshotBudgetError(error: unknown): error is SyncRowSnapshotBudgetError {
  return error instanceof SyncRowSnapshotBudgetError &&
    (error.reason === 'snapshot_rows' || error.reason === 'snapshot_bytes');
}

/**
 * Serve one responder page, owning the single budget-fallback policy for every
 * memoized phase. It tries the stable-snapshot cache first, but an
 * intrinsically-oversized snapshot (over the PER-snapshot row/byte budget) must
 * stay syncable, so it falls back to the session-less store-bounded page read
 * for this and every later page of the session. The memo remembers the
 * per-snapshot rejection for the session, so subsequent pages reach this
 * fallback without repeating the full materialization inside the memo.
 *
 * GLOBAL (process-wide) budget pressure is deliberately NOT swallowed here: it
 * is not a `snapshot_rows`/`snapshot_bytes` error, so it propagates as the quiet
 * retryable limit and the requester retries once other sessions drain.
 *
 * KNOWN LIMITATION (tracked as follow-up): the store-bounded fallback pages via
 * `OFFSET`, which — unlike a retained session snapshot — is NOT stable if the
 * graph mutates between two page requests of the same session (a row inserted
 * before the current offset can shift the window, duplicating or skipping a
 * row). This is inherent to any non-cached fallback and pre-dates the meta/SWM
 * work (durable-data already paged this way). It is bounded in blast radius:
 * durable data is Merkle-verified end-to-end, so an inconsistent assembly fails
 * verification and the requester restarts the phase (churn, not silent
 * corruption); it only bites an oversized AND concurrently-mutating context
 * graph. The durable fix is a stable keyset/seek cursor for the fallback (page
 * on `(g,s,p,o) > lastKey` instead of `OFFSET`); see the PR follow-up list.
 */
type StorePageLoader = (
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

async function readResponderRowsPage(
  cache: RowListCache | undefined,
  loadStoreBoundedPage: StorePageLoader,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  if (!cache) return loadStoreBoundedPage(safeOffset, safeLimit, signal);
  try {
    return await readCachedRowsPage(
      cache,
      () => loadStorePagedSnapshot(cache, loadStoreBoundedPage),
      safeOffset,
      safeLimit,
      signal,
    );
  } catch (error) {
    if (!isPerSnapshotBudgetError(error)) throw error;
    return loadStoreBoundedPage(safeOffset, safeLimit, signal);
  }
}

async function readCachedRowsPage(
  cache: RowListCache,
  loadRows: () => Promise<readonly SyncRow[]>,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const rows = await cache.memo.get(cache.key, loadRows, {
    refresh: cache.refresh,
    refreshGeneration: cache.refreshGeneration,
    requireExisting: safeOffset > 0,
    signal,
  });
  if (rows == null) {
    throw new Error(cache.expiredMessage ?? 'Sync session snapshot expired before page completion');
  }
  // `rows` is an immutable snapshot. Slice it directly so serving a 500-row
  // page allocates only that page's backing array, never a shallow copy of the
  // complete snapshot first.
  const page = rows.slice(safeOffset, safeOffset + safeLimit);
  if (page.length < safeLimit) {
    cache.memo.release(cache.key, { graceMs: COMPLETED_SYNC_RESPONDER_SESSION_GRACE_MS });
  }
  return page;
}

function asAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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

async function readAdmittedSwmSubGraphNames(
  store: TripleStore,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const cgPrefix = contextGraphDataGraphUri(contextGraphId);
  const names: string[] = [];
  for (const name of await readRegisteredSubGraphNames(store, contextGraphId, signal)) {
    const childCgUri = `${cgPrefix}/${name}`;
    if (await isKnownContextGraph(store, childCgUri, signal)) continue;
    names.push(name);
  }
  return names.sort(compareCodePoint);
}

function swmGraphsForRegisteredSubGraphs(
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  meta: boolean,
): string[] {
  const cgPrefix = contextGraphDataGraphUri(contextGraphId);
  const suffix = meta ? '/_shared_memory_meta' : '/_shared_memory';
  return [
    `${cgPrefix}${suffix}`,
    ...dedupeStrings(registeredSubGraphNames)
      .filter((name) => validateSubGraphName(name).valid)
      .map((name) => `${cgPrefix}/${name}${suffix}`),
  ].sort(compareCodePoint);
}

async function readRegisteredSubGraphNames(
  store: TripleStore,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const res = await store.query(`
    SELECT DISTINCT ?sg ?name WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?sg <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_SUB_GRAPH}> ;
            <${SCHEMA_NAME}> ?name .
      }
    }
  `, syncResponderStoreOptions(signal, 'sync.responder.readRegisteredSubGraphNames'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ subject: row['sg'], name: stripLiteral(row['name']) }))
    .filter(({ subject, name }) =>
      name &&
      validateSubGraphName(name).valid &&
      subject === `${contextGraphDataGraphUri(contextGraphId)}/${name}`,
    )
    .map(({ name }) => name)
    .sort(compareCodePoint);
}

async function isKnownContextGraph(
  store: TripleStore,
  contextGraphUri: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const metaGraph = `${contextGraphUri}/_meta`;
  const res = await store.query(`
    ASK {
      GRAPH <${assertSafeIri(metaGraph)}> {
        {
          <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        } UNION {
          <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status .
        }
      }
    }
  `, syncResponderStoreOptions(signal, 'sync.responder.isKnownContextGraph'));
  return res.type === 'boolean' && res.value;
}

async function isDescendantOfKnownChildContextGraph(
  store: TripleStore,
  cgPrefix: string,
  graph: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (graph === cgPrefix || !graph.startsWith(`${cgPrefix}/`)) return false;
  const remainder = graph.slice(cgPrefix.length + 1);
  const segments = remainder.split('/').filter(Boolean);
  if (isParentOwnedReservedGraphSegments(segments)) return false;
  if (await isKnownContextGraph(store, graph, signal)) return true;
  if (graph.endsWith('/_meta')) {
    const graphOwner = graph.slice(0, -'/_meta'.length);
    if (await isKnownContextGraph(store, graphOwner, signal)) return true;
  }
  let childUri = cgPrefix;
  for (const segment of segments) {
    childUri = `${childUri}/${segment}`;
    if (await isKnownContextGraph(store, childUri, signal)) return true;
  }
  return false;
}

function isParentOwnedReservedGraphSegments(segments: readonly string[]): boolean {
  return isDurableContextPartitionGraphSegments(segments) || isAssertionGraphSegments(segments);
}

function isDurableContextPartitionGraphSegments(segments: readonly string[]): boolean {
  return segments[0] === 'context' && (
    (segments.length === 2 && /^[0-9]+$/.test(segments[1])) ||
    (segments.length === 3 && /^[0-9]+$/.test(segments[1]) && segments[2] === '_meta')
  );
}

function isAssertionGraphSegments(segments: readonly string[]): boolean {
  if (segments.length !== 3 && !(segments.length === 4 && segments[3] === '_meta')) {
    return false;
  }
  return (
    segments[0] === 'assertion' &&
    segments[1].startsWith('0x') &&
    segments[1].length > 2 &&
    segments[2].length > 0
  );
}

async function readAdmittedAssertionGraphs(
  store: TripleStore,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const res = await store.query(`
    SELECT DISTINCT ?g WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?lifecycle <${DKG_ASSERTION_GRAPH}> ?g ;
                   <${DKG_MEMORY_LAYER}> ?layer .
        FILTER(?layer != ${sparqlString(MemoryLayer.WorkingMemory)})
      }
    }
  `, syncResponderStoreOptions(signal, 'sync.responder.readAdmittedAssertionGraphs'));
  if (res.type !== 'bindings') return new Set();
  return new Set(res.bindings.map((row) => row['g']).filter(Boolean));
}

async function readRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const values = graphValues(graphs);
  if (!values) return [];
  const res = await store.query(`
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${values} }
      GRAPH ?g { ?s ?p ?o }
    }
  `, syncResponderStoreOptions(signal, 'sync.responder.readRowsAcrossGraphs'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g)
    .sort(compareRows);
}

async function readRowsAcrossGraphsExcludingSubjectPrefix(
  store: TripleStore,
  graphs: readonly string[],
  excludedSubjectPrefix: string,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const values = graphValues(graphs);
  if (!values) return [];
  const res = await store.query(`
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${values} }
      GRAPH ?g { ?s ?p ?o }
      FILTER(!isIRI(?s) || !STRSTARTS(STR(?s), ${sparqlString(excludedSubjectPrefix)}))
    }
  `, syncResponderStoreOptions(signal, 'sync.responder.readRowsAcrossGraphsExcludingSubjectPrefix'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g)
    .sort(compareRows);
}

async function readRowsPageAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  const values = graphValues(graphs);
  if (safeLimit === 0 || !values) return [];
  const res = await store.query(`
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${values} }
      GRAPH ?g { ?s ?p ?o }
    }
    ORDER BY ?g ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `, syncResponderStoreOptions(signal, 'sync.responder.readRowsPageAcrossGraphs'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

async function readSwmMetaRows(
  store: TripleStore,
  swmMetaGraphs: readonly string[],
  cutoffIso: string | null,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const swmMetaValues = graphValues(swmMetaGraphs);
  if (!swmMetaValues) return [];
  const res = await store.query(`
    SELECT DISTINCT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${swmMetaValues} }
      GRAPH ?g {
        ?s ?p ?o .
        ${cutoffIso
    ? `
        ?s <${DKG_PUBLISHED_AT}> ?ts .
        FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)`
    : ''}
      }
    }
  `, syncResponderStoreOptions(signal, 'sync.responder.readSwmMetaRows'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g)
    .sort(compareRows);
}

async function readSwmMetaRowsPage(
  store: TripleStore,
  swmMetaGraphs: readonly string[],
  cutoffIso: string | null,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const swmMetaValues = graphValues(swmMetaGraphs);
  const swmMetaClause = swmMetaValues
    ? `
        VALUES ?g { ${swmMetaValues} }
        GRAPH ?g {
          ?s ?p ?o .
          ${cutoffIso
            ? `
          ?s <${DKG_PUBLISHED_AT}> ?ts .
          FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)`
            : ''}
        }
      `
    : '';
  if (!swmMetaClause) return [];
  const res = await store.query(`
    SELECT DISTINCT ?g ?s ?p ?o WHERE {
      ${swmMetaClause}
    }
    ORDER BY ?g ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `, syncResponderStoreOptions(signal, 'sync.responder.readSwmMetaRowsPage'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

// NOTE: keep in sync with its page-safe twin {@link readFreshSwmDataRowsPage} —
// both MUST return the same SET of rows (see readDurableMetaRows note).
async function readFreshSwmDataRows(
  store: TripleStore,
  dataGraphs: readonly string[],
  graphSet: ReadonlySet<string>,
  candidateGraphsFor: (graph: string) => string[],
  cutoffIso: string,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const rows: SyncRow[] = [];
  for (const graph of dataGraphs) {
    const metaGraph = `${graph}_meta`;
    if (!graphSet.has(metaGraph)) continue;
    const roots = await readFreshSwmRoots(store, metaGraph, cutoffIso, signal);
    if (roots.size === 0) continue;
    const rootPrefixes = [...roots].map((root) => `${root}/.well-known/genid/`);
    const graphRows = await readRowsAcrossGraphs(store, candidateGraphsFor(graph), signal);
    // Append only matching rows, one at a time — never `rows.push(...matches)`.
    // The spread passes every element as a call argument, so a shared-memory
    // graph with more than V8's argument-count limit (~1.25e5) of matching rows
    // throws `RangeError: Maximum call stack size exceeded` mid-serve. The loop
    // also avoids allocating a filtered intermediary before appending.
    for (const row of graphRows) {
      if (roots.has(row.s) || rootPrefixes.some((prefix) => row.s.startsWith(prefix))) {
        rows.push(row);
      }
    }
  }
  return rows.sort(compareRows);
}

/**
 * Store-bounded, page-safe equivalent of {@link readFreshSwmDataRows} used as the
 * oversized-snapshot fallback for TTL-cutoff shared-memory data. Fresh roots are
 * resolved per data-graph inside the store (`FILTER EXISTS`), so a page reads
 * only the requested rows instead of materializing every fresh root's data
 * across all candidate graphs.
 *
 * INVARIANT: this MUST return the same SET of rows as {@link readFreshSwmDataRows}
 * and MUST be edited together with it. Row ORDER may differ from `compareRows`;
 * that is safe within a single paginated session (see readDurableMetaRowsPage).
 */
async function readFreshSwmDataRowsPage(
  store: TripleStore,
  dataGraphs: readonly string[],
  graphSet: ReadonlySet<string>,
  candidateGraphsFor: (graph: string) => string[],
  cutoffIso: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const cutoffFilter =
    `FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)`;
  const unions: string[] = [];
  for (const graph of dataGraphs) {
    const metaGraph = `${graph}_meta`;
    if (!graphSet.has(metaGraph)) continue;
    const candidateValues = graphValues(candidateGraphsFor(graph));
    if (!candidateValues) continue;
    unions.push(`
      {
        VALUES ?g { ${candidateValues} }
        GRAPH ?g { ?s ?p ?o }
        FILTER EXISTS {
          GRAPH <${assertSafeIri(metaGraph)}> {
            ?op <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
                <${DKG_PUBLISHED_AT}> ?ts ;
                <${DKG_ROOT_ENTITY}> ?root .
            ${cutoffFilter}
          }
          FILTER(?s = ?root || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/")))
        }
      }`);
  }
  if (unions.length === 0) return [];
  const res = await store.query(`
    SELECT DISTINCT ?g ?s ?p ?o WHERE {
      ${unions.join('\n      UNION')}
    }
    ORDER BY ?g ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `, syncResponderStoreOptions(signal, 'sync.responder.readFreshSwmDataRowsPage'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

async function readFreshSwmRoots(
  store: TripleStore,
  metaGraph: string,
  cutoffIso: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const res = await store.query(`
    SELECT DISTINCT ?root WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?op <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
            <${DKG_PUBLISHED_AT}> ?ts ;
            <${DKG_ROOT_ENTITY}> ?root .
        FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
    }
  `, syncResponderStoreOptions(signal, 'sync.responder.readFreshSwmRoots'));
  if (res.type !== 'bindings') return new Set();
  return new Set(res.bindings.map((row) => row['root']).filter(Boolean));
}

function buildDurableMetaRowsQuery(
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  page?: { offset: number; limit: number },
): string {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const cgEntity = contextGraphDataGraphUri(contextGraphId);
  const activeDelegationSubjectExpression =
    durableMetaDelegationSubjectAdmissionExpression(contextGraphId);
  const notWorking = `FILTER(?ml != ${sparqlString(MemoryLayer.WorkingMemory)})`;
  const registeredSubGraphSubjects = dedupeStrings(registeredSubGraphNames)
    .filter((name) => validateSubGraphName(name).valid)
    .map((name) => `<${assertSafeIri(`${cgEntity}/${name}`)}>`);
  const registeredSubGraphClause = registeredSubGraphSubjects.length
    ? `|| ?s IN (${registeredSubGraphSubjects.join(', ')})`
    : '';
  const pagination = page
    ? `\n    OFFSET ${Math.max(0, Math.floor(page.offset))}\n    LIMIT ${Math.max(0, Math.floor(page.limit))}`
    : '';
  return `
    SELECT ?g ?s ?p ?o WHERE {
      VALUES ?g { <${assertSafeIri(metaGraph)}> }
      GRAPH ?g { ?s ?p ?o }
      FILTER(!isIRI(?s) || !STRSTARTS(STR(?s), ${sparqlString(DKG_JOIN_REQUEST_SUBJECT_PREFIX)}))
      FILTER(
        ?s = <${assertSafeIri(cgEntity)}>
        || ${activeDelegationSubjectExpression}
        ${registeredSubGraphClause}
        || STRSTARTS(STR(?s), "did:dkg:activity:")
        || EXISTS { GRAPH ?g { ?s <${DKG_MEMORY_LAYER}> ?ml } ${notWorking} }
        || EXISTS { GRAPH ?g { ?agLifecycle <${DKG_ASSERTION_GRAPH}> ?s ; <${DKG_MEMORY_LAYER}> ?ml } ${notWorking} }
        || EXISTS {
             GRAPH ?g { ?s (<${PROV_GENERATED}>|<${PROV_USED}>) ?evLifecycle . ?evLifecycle <${DKG_MEMORY_LAYER}> ?ml }
             ${notWorking}
           }
        || (
             CONTAINS(STR(?s), "/assertion/") &&
             EXISTS {
               GRAPH ?g { ?anLifecycle <${DKG_ASSERTION_NAME}> ?an ; <${DKG_MEMORY_LAYER}> ?ml }
               ${notWorking}
               FILTER(STR(?an) != "")
               FILTER(STRENDS(STR(?s), CONCAT("/", STR(?an))))
             }
           )
      )
    }
    ORDER BY ?g ?s ?p ?o${pagination}
  `;
}

async function queryDurableMetaRows(
  store: TripleStore,
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  page: { offset: number; limit: number } | undefined,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  if (page && Math.max(0, Math.floor(page.limit)) === 0) return [];
  const res = await store.query(
    buildDurableMetaRowsQuery(contextGraphId, registeredSubGraphNames, page),
    syncResponderStoreOptions(
      signal,
      page ? 'sync.responder.readDurableMetaRowsPage' : 'sync.responder.readDurableMetaRows',
    ),
  );
  if (res.type !== 'bindings') return [];
  const rows = res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
  return page ? rows : rows.sort(compareRows);
}

/**
 * Read admitted durable metadata from one store snapshot. The delegation
 * credential and its allow/revoke facts are evaluated in the same query, so
 * an ACL mutation cannot race a separately materialized JavaScript subject set.
 */
async function readDurableMetaRows(
  store: TripleStore,
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  return queryDurableMetaRows(
    store,
    contextGraphId,
    registeredSubGraphNames,
    undefined,
    signal,
  );
}

/**
 * Store-bounded, page-safe equivalent of {@link readDurableMetaRows} used as the
 * oversized-snapshot fallback. It pushes the entire subject-membership predicate
 * into the store (the graph-scaling non-working-lifecycle / event-subject sets
 * are expressed as `EXISTS`, never materialized in Node) and pages with
 * `OFFSET`/`LIMIT`, so an intrinsically-oversized durable-meta snapshot syncs
 * without buffering the complete filtered set in heap.
 *
 * INVARIANT: this MUST return the same SET of rows as {@link readDurableMetaRows}.
 * The two encode the same filter and MUST be edited together. Row ORDER may
 * differ (SPARQL term order vs `compareRows` code-point order diverge on the
 * object tiebreaker); that is safe because only one path runs within a single
 * paginated session and SPARQL `ORDER BY` is internally deterministic, so pages
 * never skip or duplicate.
 */
async function readDurableMetaRowsPage(
  store: TripleStore,
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  return queryDurableMetaRows(
    store,
    contextGraphId,
    registeredSubGraphNames,
    { offset: safeOffset, limit: safeLimit },
    signal,
  );
}

async function readDurableDeltaRowsPageAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  const values = graphValues(graphs);
  if (safeLimit === 0 || !values) return [];
  const res = await store.query(`
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?g ?s ?p ?o WHERE {
      ${durableDeltaWhereClauseForGraphs(values, metaGraphs)}
    }
    ${durableDeltaGroupClause(metaGraphs, sinceBatchId, true)}
    ORDER BY ?g ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `, syncResponderStoreOptions(signal, 'sync.responder.readDurableDeltaRowsPageAcrossGraphs'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
}

async function readDurableDeltaRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const values = graphValues(graphs);
  if (!values) return [];
  const res = await store.query(`
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?g ?s ?p ?o WHERE {
      ${durableDeltaWhereClauseForGraphs(values, metaGraphs)}
    }
    ${durableDeltaGroupClause(metaGraphs, sinceBatchId, true)}
  `, syncResponderStoreOptions(signal, 'sync.responder.readDurableDeltaRowsAcrossGraphs'));
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g)
    .sort(compareRows);
}

function durableDeltaWhereClauseForGraphs(
  graphValuesClause: string,
  metaGraphs: readonly string[],
): string {
  const values = metaGraphs.map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
  if (!values) {
    return `
      VALUES ?g { ${graphValuesClause} }
      GRAPH ?g { ?s ?p ?o }
    `;
  }
  return `
      VALUES ?g { ${graphValuesClause} }
      GRAPH ?g { ?s ?p ?o }
      OPTIONAL {
        {
          SELECT ?deltaRoot ?deltaBid WHERE {
            VALUES ?deltaMg { ${values} }
            GRAPH ?deltaMg {
              {
                ?deltaKa <${DKG_PART_OF}> ?deltaUal ;
                         <${DKG_ROOT_ENTITY}> ?deltaRoot .
                { ?deltaUal <${DKG_BATCH_ID}> ?deltaBid }
                UNION
                { ?deltaKa <${DKG_BATCH_ID}> ?deltaBid }
              }
              UNION
              {
                ?deltaKa <${DKG_ROOT_ENTITY}> ?deltaRoot ;
                         <${DKG_BATCH_ID}> ?deltaBid .
              }
              FILTER(REGEX(STR(?deltaBid), "^-?\\\\d+$"))
            }
          }
        }
        FILTER(sameTerm(?s, ?deltaRoot) || STRSTARTS(STR(?s), CONCAT(STR(?deltaRoot), "/.well-known/genid/")))
        BIND(xsd:integer(STR(?deltaBid)) AS ?deltaBatch)
      }
    `;
}

function durableDeltaGroupClause(
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  includeGraph: boolean = false,
): string {
  if (metaGraphs.length === 0) return '';
  return `
    GROUP BY ${includeGraph ? '?g ' : ''}?s ?p ?o
    HAVING(COUNT(?deltaBatch) = 0 || MAX(?deltaBatch) > ${sinceBatchId.toString()})
  `;
}

function graphValues(graphs: readonly string[]): string {
  return dedupeStrings(graphs).map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
}

function durableDataRowListCacheKey(scope: string, contextGraphId: string, sinceBatchId: bigint | null): string {
  return `durable-data:${scope}:${contextGraphId}:${sinceBatchId == null ? 'full' : `since:${sinceBatchId.toString()}`}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function contextGraphDataGraphUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}`;
}

function contextGraphMetaGraphUri(contextGraphId: string): string {
  return `${contextGraphDataGraphUri(contextGraphId)}/_meta`;
}

function stripLiteral(value: string | undefined): string {
  if (!value) return '';
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/);
  return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : value;
}

function formatTerm(term: string): string {
  if (term.startsWith('"') || term.startsWith('_:')) return term;
  if (term.startsWith('<') && term.endsWith('>')) return term;
  return `<${assertSafeIri(term)}>`;
}
