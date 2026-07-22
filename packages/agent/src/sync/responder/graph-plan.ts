import {
  DKG_ONTOLOGY,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  assertSafeIri,
  sparqlString,
  validateSubGraphName,
  contextGraphCatalogUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  StoreResponseTooLargeError,
  type QueryOptions,
  type TripleStore,
  type ChangelogReader,
  type ChangeOp,
} from '@origintrail-official/dkg-storage';
import { isSharedMemoryBucketDescendantDataGraph } from '../shared-memory-graphs.js';
import type { SyncRow, SyncRowListMemo } from './snapshot-cache.js';
import {
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
  SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
} from './snapshot-cache.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  SyncRowSnapshotBudgetError,
  type SyncResponderSnapshotBudget,
} from './snapshot-budget.js';
import { estimateStringRowHeapBytes } from '../memory-telemetry.js';
import { SYNC_BYTE_BUDGET_RESPONSE_BYTES } from '../../dkg-agent-constants.js';
import type { ChangelogSyncResponse, ChangelogDeltaRecord } from '../changelog/wire.js';
import { durableMetaDelegationSubjectAdmissionExpression } from './durable-meta-admission.js';
import { exactAssetFilterKey } from '../exact-assets.js';

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
const DKG_CONTENT_SCOPE_VERSION = `${DKG}contentScopeVersion`;
const DKG_KA_UAL = `${DKG}kaUal`;
const DKG_ASSERTION_VERSION = `${DKG}assertionVersion`;
const DKG_SHARE_OPERATION_ID = `${DKG}shareOperationId`;
const DKG_ASSERTION_GRAPH = `${DKG}assertionGraph`;
const DKG_ASSERTION_NAME = `${DKG}assertionName`;
const DKG_MEMORY_LAYER = `${DKG}memoryLayer`;
const DKG_CONTEXT_GRAPH = `${DKG}contextGraph`;
const DKG_PUBLIC_TRIPLE_COUNT = `${DKG}publicTripleCount`;
const DKG_PRIVATE_TRIPLE_COUNT = `${DKG}privateTripleCount`;
const DKG_STATUS = `${DKG}status`;
const DKG_SUB_GRAPH_NAME = `${DKG}subGraphName`;
const DETERMINISTIC_KA_UAL_SHAPE = /^did:dkg:[^/]+\/0x[0-9A-Fa-f]{40}\/[0-9]+$/;
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

interface FreshSwmDataGraphPlanEntry {
  graph: string;
  roots: readonly string[];
  rowCount: number;
}

interface FreshSwmDataGraphPlan {
  entries: readonly FreshSwmDataGraphPlanEntry[];
  totalRows: number;
}

export interface FreshSwmDataGraphPlanMemo {
  get(
    key: string,
    load: () => Promise<FreshSwmDataGraphPlan>,
    options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
  ): Promise<FreshSwmDataGraphPlan | null>;
}

interface FreshSwmMetaSubjectEntry {
  readonly subject: string;
  readonly rowCount: number;
}

interface FreshSwmMetaGraphPlanEntry {
  readonly graph: string;
  /** TTL-admitted subjects, compareCodePoint-sorted; row counts are exact at plan build. */
  readonly subjects: readonly FreshSwmMetaSubjectEntry[];
  readonly rowCount: number;
}

/**
 * Session plan for the TTL-filtered SWM meta phase (#1847). Holds only
 * graph/subject/count scalars — never payload rows — and is bounded at
 * CONSTRUCTION: discovery queries carry LIMIT/response-byte caps, the admitted
 * subject cardinality is capped by {@link FRESH_SWM_META_PLAN_MAX_SUBJECTS},
 * and the retained scalar estimate is capped by the fixed snapshot build byte
 * cap, so plan building can never materialize an unbounded store result. The
 * retained estimate is additionally charged to the process-wide responder
 * snapshot budget by the memo (see createResponderFreshSwmMetaPlanMemo).
 *
 * The plan is IMMUTABLE once built — every reader treats it as a frozen
 * pagination description. The mutable per-session content-digest bindings that
 * used to live on subject entries are held in a sidecar keyed by plan instance
 * (see {@link sessionDigestBindingsFor}), so nothing that "reads a plan" can
 * change it.
 */
interface FreshSwmMetaPlan {
  readonly entries: readonly FreshSwmMetaGraphPlanEntry[];
  readonly totalRows: number;
  /** Estimated retained heap bytes of the plan's subject/count scalars. */
  readonly bytesEstimate: number;
}

/**
 * Sidecar for the mutable per-session digest state of a TTL meta plan (#1868
 * review): content bindings for whole subject row-groups, established on a
 * subject's FIRST window read of the session and verified on every REREAD. Row
 * counts alone pass on same-count replacements, and a reread sliced at the
 * plan's prefix sums could then combine rows of two different versions of one
 * subject across response pages; the digest makes any content or ordering
 * change of an already-served subject fail the session instead (the requester
 * restarts with a fresh plan). A subject read exactly once needs no binding:
 * its row-group is served whole from a single query.
 *
 * Keyed WEAKLY by plan object identity, which is exactly the binding's
 * intended lifetime: the memoized plan IS the session (offset>0 requires the
 * existing plan; refresh/rebuild produces a NEW plan object and therefore a
 * fresh, empty binding map), and evicting or expiring the plan releases its
 * digests with it. Map keys are `graph U+0000 subject` (NUL cannot appear
 * in an IRI, so the composite key cannot collide).
 */
const freshSwmMetaSessionDigests = new WeakMap<FreshSwmMetaPlan, Map<string, string>>();

function sessionDigestBindingsFor(plan: FreshSwmMetaPlan): Map<string, string> {
  let bindings = freshSwmMetaSessionDigests.get(plan);
  if (!bindings) {
    bindings = new Map();
    freshSwmMetaSessionDigests.set(plan, bindings);
  }
  return bindings;
}

export interface FreshSwmMetaPlanMemo {
  get(
    key: string,
    load: () => Promise<FreshSwmMetaPlan>,
    options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
  ): Promise<FreshSwmMetaPlan | null>;
}

interface ExactGraphPagePlanEntry {
  graph: string;
  rowCount: number;
}

interface ConfirmedGraphScopedVmManifestEntry extends ExactGraphPagePlanEntry {
  ual: string;
}

interface GraphScopedVmManifest {
  confirmedEntries: readonly ConfirmedGraphScopedVmManifestEntry[];
  confirmedGraphs: ReadonlySet<string>;
  /** Complete V2 descriptors in any lifecycle state, used to reject tentative VM payloads. */
  knownGraphs: ReadonlySet<string>;
}

interface ExactGraphPagePlan {
  entries: readonly ExactGraphPagePlanEntry[];
  totalRows: number;
  /** At most one exact graph is retained while an oversized phase is framed. */
  activeGraphRows?: {
    graph: string;
    rows: readonly SyncRow[];
  };
  activeGraphRowsLoad?: {
    graph: string;
    promise: Promise<readonly SyncRow[] | null>;
  };
  /** Graphs that exceeded the bounded local snapshot and require ordered paging. */
  pagedGraphs: Set<string>;
}

export interface ExactGraphPagePlanMemo {
  get(
    key: string,
    load: () => Promise<ExactGraphPagePlan>,
    options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
  ): Promise<ExactGraphPagePlan | null>;
}

interface RowListCache {
  memo: SyncRowListMemo;
  key: string;
  refresh?: boolean;
  refreshGeneration?: string;
  expiredMessage?: string;
  /** Byte-budget pages may serialize only a prefix of a short row slice. */
  releaseOnShortPage?: boolean;
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

/**
 * Session-scoped plan cache for oversized TTL-filtered SWM snapshots.
 *
 * The plan is tiny (graph IRIs, admitted root IRIs, and row counts), but it is
 * expensive enough to compute that rebuilding it for every 64-row frame would
 * dominate a large sync. Touch entries on every page so an actively progressing
 * 1 GiB session remains live for the same ten-minute window as its responder
 * token. Offset>0 requires the existing plan: silently rebuilding against a
 * moving TTL cutoff would make the numeric offset skip or duplicate rows.
 */
export function createResponderFreshSwmDataGraphPlanMemo(
  ttlMs = 10 * 60_000,
  maxEntries = 32,
): FreshSwmDataGraphPlanMemo {
  return createSessionPlanMemo<FreshSwmDataGraphPlan>(ttlMs, maxEntries);
}

/**
 * Session-scoped plan cache for the TTL-filtered SWM META phase (#1847). Same
 * lifetime/refresh contract as {@link createResponderFreshSwmDataGraphPlanMemo}:
 * touched on every page, offset>0 requires the existing plan so a rebuilt plan
 * against a moved TTL cutoff can never make a numeric offset skip or duplicate.
 *
 * When a responder snapshot budget is supplied, every retained plan's scalar
 * estimate is charged to the GLOBAL budget as a control-plane entry: peers
 * cannot stack up to maxEntries uncharged plans, admission under global memory
 * pressure fails as the quiet retryable limit, and an idle plan is LRU-evicted
 * exactly like a retained row snapshot (the session then expires and the
 * requester restarts it).
 */
export function createResponderFreshSwmMetaPlanMemo(
  ttlMs = 10 * 60_000,
  maxEntries = 32,
  budget?: SyncResponderSnapshotBudget,
): FreshSwmMetaPlanMemo {
  return createSessionPlanMemo<FreshSwmMetaPlan>(
    ttlMs,
    maxEntries,
    budget && {
      budget,
      phase: 'shared_memory',
      bytesEstimate: (plan) => plan.bytesEstimate,
    },
  );
}

interface SessionPlanBudgetAccounting<T> {
  budget: SyncResponderSnapshotBudget;
  phase: 'shared_memory' | 'durable_meta' | 'durable_data';
  bytesEstimate: (value: T) => number;
}

function createSessionPlanMemo<T>(
  ttlMs: number,
  maxEntries: number,
  accounting?: SessionPlanBudgetAccounting<T>,
): {
  get(
    key: string,
    load: () => Promise<T>,
    options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
  ): Promise<T | null>;
} {
  const cached = new Map<string, { value: T; cachedAt: number; budgetEntryId?: symbol }>();
  const inflight = new Map<string, Promise<T>>();
  const deleteEntry = (key: string, reason: 'expired' | 'released' | 'replaced') => {
    const entry = cached.get(key);
    if (!entry) return;
    cached.delete(key);
    if (entry.budgetEntryId) accounting?.budget.remove(entry.budgetEntryId, reason);
  };
  const prune = (now = Date.now()) => {
    for (const [key, entry] of cached) {
      if (now - entry.cachedAt >= ttlMs) deleteEntry(key, 'expired');
    }
  };
  return {
    async get(key, load, options) {
      throwIfAborted(options?.signal);
      const now = Date.now();
      prune(now);
      const pending = inflight.get(key);
      if (pending) return raceAgainstAbort(pending, options?.signal);
      const existing = cached.get(key);
      if (!options?.refresh && existing) {
        cached.delete(key);
        cached.set(key, { ...existing, cachedAt: now });
        if (existing.budgetEntryId) {
          // Refresh the global-budget LRU position, then stay evictable: an
          // entry pinned forever would let idle plans exempt themselves from
          // memory-pressure eviction.
          accounting?.budget.touch(existing.budgetEntryId);
          accounting?.budget.release(existing.budgetEntryId);
        }
        return existing.value;
      }
      if (options?.requireExisting) return null;
      if (!existing && cached.size >= maxEntries) {
        deleteEntry(cached.keys().next().value!, 'released');
      }
      const pendingLoad = load()
        .then((value) => {
          const replaced = cached.get(key);
          let budgetEntryId: symbol | undefined;
          if (accounting) {
            budgetEntryId = Symbol(key);
            // Throws the typed global budget error when the process-wide
            // responder budget cannot admit the plan; the failed refresh leaves
            // any previously-admitted plan in place (memo entry untouched).
            accounting.budget.admit({
              id: budgetEntryId,
              key,
              phase: accounting.phase,
              rows: 0,
              bytesEstimate: accounting.bytesEstimate(value),
              controlPlane: true,
              replaceId: replaced?.budgetEntryId,
              onEvict: () => {
                if (cached.get(key)?.budgetEntryId === budgetEntryId) cached.delete(key);
              },
            });
            accounting.budget.release(budgetEntryId);
          }
          cached.set(key, { value, cachedAt: Date.now(), budgetEntryId });
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, pendingLoad);
      return raceAgainstAbort(pendingLoad, options?.signal);
    },
  };
}

/**
 * Session-scoped inventory for ordinary durable/SWM graph paging. The memo
 * stores only exact graph IRIs and their row counts. Payload rows remain in the
 * triple store and each page addresses one concrete graph at a time, avoiding
 * the global `VALUES ?g ... ORDER BY ?g ?s ?p ?o OFFSET ...` scan that grows
 * super-linearly on large stores.
 */
export function createResponderExactGraphPagePlanMemo(
  ttlMs = 10 * 60_000,
  maxEntries = 32,
): ExactGraphPagePlanMemo {
  return createSessionPlanMemo<ExactGraphPagePlan>(ttlMs, maxEntries);
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

/**
 * The `(g, s)` identity a durable `_meta` row belongs to. Durable meta is
 * ordered by `(g, s, p, o)`; a graph-scoped assertion seal is ONE `(g, s)`
 * subject whose rows — including the batch-local control field
 * `dkg:assertionVersion` — MUST cross the wire together in a single round, else
 * the receiver's per-round completeness check drops the control fields
 * permanently (#1788). Used to snap durable-meta page boundaries to subject
 * boundaries. The `\n` separator cannot occur inside an IRI, so distinct
 * subjects never collide.
 */
function metaSubjectKey(row: SyncRow): string {
  return `${row.g}\n${row.s}`;
}

function serializeResponderRow(row: SyncRow): string {
  return `${formatTerm(row.s)} <${assertSafeIri(row.p)}> ${formatTerm(row.o)} <${assertSafeIri(row.g)}> .`;
}

export function serializeResponderRows(rows: readonly SyncRow[]): string {
  return rows.map(serializeResponderRow).join('\n');
}

const RESPONDER_ROW_ENCODER = new TextEncoder();

/**
 * Serialized (N-Quads, UTF-8) wire byte length of one responder row — the ONE
 * byte model for response-frame budgets, shared by the byte-budget serializer
 * and the subject-atomic extend so both reason about `maxResponseBytes` the same
 * way (#1916). This is distinct from `estimateStringRowHeapBytes`, which
 * estimates retained HEAP size for snapshot memory budgets only.
 */
function serializedResponderRowByteLength(row: SyncRow): number {
  return RESPONDER_ROW_ENCODER.encode(serializeResponderRow(row)).byteLength;
}

/**
 * How a durable-meta page handles an admitted subject (or cumulative page) that
 * cannot fit the frame-safe response budget:
 *  - `'byte-fit'` — NEGOTIATED (testnet-canary+) requesters: byte-cap the page,
 *    splitting a LONE oversized FIRST subject into a byte-fitting prefix. The
 *    requester paginates via empty=EOF, so a short page is NOT EOF — no metadata
 *    loss and forward progress is guaranteed. This is the verified, bot-accepted
 *    #1916 behavior.
 *  - `'fail-loud'` — NON-NEGOTIATED / pre-`testnet-canary` legacy requesters:
 *    NEVER byte-fit. A legacy requester reads a short page as EOF, so a
 *    byte-fitting prefix would silently drop the rest of the metadata AND split a
 *    seal (#1788 reintroduced). Emit whole subjects up to the row limit; if the
 *    resulting page still cannot be produced frame-safe — a single oversized
 *    subject OR the cumulative row-limit-bound page — throw
 *    {@link DurableMetaPageFrameError} rather than return a silent short page or
 *    an un-sendable over-frame page. Subject atomicity (#1788) holds identically
 *    on both branches; only this oversized-handling differs.
 */
type MetaOversizedSubjectPolicy = 'byte-fit' | 'fail-loud';

/**
 * A non-negotiated (legacy) durable-meta request cannot be served frame-safe:
 * the subject-atomic, row-limit-bound page — a single admitted subject alone or
 * the cumulative page — exceeds the frame-safe response budget, and byte-fitting
 * it would return a SHORT page a legacy requester reads as EOF (silent
 * partial-metadata loss + a #1788 seal split). Failing loud is strictly better
 * than silent loss here: a byte-budget-negotiating requester never hits this (it
 * uses empty=EOF pagination), and the oversized `_meta` subject itself is only
 * reachable via unverified peer-ingest, fixed at the root by #1921.
 *
 * Contract: this is a HARD, NON-RETRYABLE failure. The sync responder surfaces it
 * as `outcome:'error'` and re-throws it (it is deliberately NOT wrapped in a
 * retryable error, and NEVER converted to an empty — EOF — body), because a retry
 * cannot make an oversized subject servable to a legacy requester; the only
 * resolutions are a requester upgrade or the #1921 ingest fix. The budget it is
 * checked against is `SYNC_BYTE_BUDGET_RESPONSE_BYTES` (the router read cap minus
 * the frame headroom) — the largest response body guaranteed to fit one transport
 * frame — so a page within it is always sendable and only a genuinely oversized
 * one throws.
 */
export class DurableMetaPageFrameError extends Error {
  readonly contextGraphId: string;
  readonly bytes: number;
  readonly limit: number;

  constructor(params: { contextGraphId: string; bytes: number; limit: number }) {
    super(
      `Durable-meta page for "${params.contextGraphId}" cannot be served frame-safe to a `
      + `non-negotiated (legacy) requester: a subject-atomic page of ${params.bytes} bytes `
      + `exceeds the ${params.limit}-byte frame budget. A byte-budget-negotiating requester `
      + `(testnet-canary+) paginates this via empty=EOF; upgrade the requester or reject the `
      + `oversized _meta subject at ingest (#1921).`,
    );
    this.name = 'DurableMetaPageFrameError';
    this.contextGraphId = params.contextGraphId;
    this.bytes = params.bytes;
    this.limit = params.limit;
  }
}

/**
 * Exclusive end index of the SUBJECT-ATOMIC, BYTE-FITTING durable-meta page that
 * starts at `start` (#1916). Walks whole `(g, s)` subjects accumulating serialized
 * wire bytes (the same accounting the byte-budget serializer uses), and:
 *  - a subject that would push the page over `maxBytes` is DEFERRED WHOLE to the
 *    next page (cut on the prior subject boundary) — never split;
 *  - ONLY when the FIRST subject alone exceeds `maxBytes` is it emitted (the
 *    serializer then byte-caps that one subject — provably not a valid seal at
 *    that size, so splitting it is safe and guarantees forward progress);
 *  - so "≤ budget" and "subject-atomic" hold together, unlike a plain row-prefix
 *    cut which splits a small seal that sits after large-literal rows.
 *
 * Also bounded by `rowLimit` (the requested page size): once whole subjects
 * totalling ≥ `rowLimit` rows have been accumulated, stop at that subject
 * boundary — so a normal small-subject page stays ~`rowLimit` rows (extended to
 * complete the straddling subject) instead of ballooning to the full byte budget.
 *
 * Subjects are grouped by {@link metaSubjectKey} over `rows`, which is ONE query's
 * result (a cached snapshot or a single store-paged window), so a blank-node
 * subject's rows are self-consistently labelled and stay grouped (same
 * single-query invariant as the #1788 fix). `trailingComplete` says whether the
 * LAST subject in `rows` is fully present; when false that trailing subject is
 * treated as incomplete and the function returns -1 ("need more rows") so the
 * caller grows the window to complete it.
 */
function subjectAtomicBudgetEnd(
  rows: readonly SyncRow[],
  start: number,
  maxBytes: number,
  rowLimit: number,
  trailingComplete: boolean,
  oversizedPolicy: MetaOversizedSubjectPolicy = 'byte-fit',
  contextGraphId = '',
): number {
  const n = rows.length;
  if (start >= n) return start;
  const safeMax = Math.max(1, Math.floor(maxBytes));
  const safeRowLimit = Math.max(1, Math.floor(rowLimit));
  let bytes = 0;
  let lastBoundary = start;
  let i = start;
  while (i < n) {
    let j = i;
    let runBytes = 0;
    const key = metaSubjectKey(rows[i]);
    while (j < n && metaSubjectKey(rows[j]) === key) {
      runBytes += serializedResponderRowByteLength(rows[j]) + (i === start && j === i ? 0 : 1);
      j += 1;
    }
    // The subject is fully present iff a later subject follows it in `rows`, or
    // the caller says the tail is complete.
    const complete = j < n || trailingComplete;
    if (bytes + runBytes > safeMax) {
      // This whole subject won't fit within the budget. `bytes + runBytes` is the
      // frame size of every prior (whole) subject plus this one — the smallest
      // page that keeps this subject atomic.
      if (oversizedPolicy === 'fail-loud') {
        // NON-NEGOTIATED legacy path: we cannot byte-fit (a short page reads as
        // EOF → silent metadata loss + a #1788 split) and cannot over-fill the
        // frame. Whether the FIRST subject alone (`lastBoundary === start`) or the
        // CUMULATIVE page (`lastBoundary > start`) overflows, the page is
        // unservable frame-safe — fail LOUD instead of returning a short page.
        throw new DurableMetaPageFrameError({
          contextGraphId,
          bytes: bytes + runBytes,
          limit: safeMax,
        });
      }
      if (lastBoundary > start) return lastBoundary; // defer it WHOLE; keep prior subjects
      // ESCAPE HATCH: the FIRST subject alone exceeds the budget. It is provably
      // not a valid seal at that size, so split it — return a byte-FITTING row
      // prefix (≥ 1 row for forward progress) so the page is ≤ budget under BOTH
      // the byte-budget and the plain serializer. This is the ONLY place a
      // subject is split, and only on the NEGOTIATED ('byte-fit') path.
      let k = start;
      let prefixBytes = 0;
      while (k < j) {
        const rowBytes = serializedResponderRowByteLength(rows[k]) + (k === start ? 0 : 1);
        if (prefixBytes + rowBytes > safeMax && k > start) break;
        prefixBytes += rowBytes;
        k += 1;
      }
      return k;
    }
    if (!complete) {
      // Trailing subject fits SO FAR but may continue beyond `rows`. It is not
      // over budget, so it should be INCLUDED whole once fully read — signal
      // "need more rows" so the caller grows the window to complete it (rather
      // than deferring a subject that would fit).
      return -1;
    }
    bytes += runBytes;
    lastBoundary = j;
    i = j;
    // Requested page size reached (at a subject boundary): stop here rather than
    // keep pulling whole subjects up to the full byte budget.
    if (lastBoundary - start >= safeRowLimit) return lastBoundary;
  }
  return lastBoundary;
}

/**
 * Serialize the largest prefix that fits the negotiated response target.
 * Pagination advances by the number of N-Quads actually parsed by the
 * requester, so returning a prefix is cursor-safe. Always emit one row when a
 * non-empty input contains an unexpectedly oversized row; that guarantees
 * forward progress and leaves the transport's existing hard frame limit as the
 * final safety boundary for that pathological single row.
 */
export function serializeResponderRowsWithinByteBudget(
  rows: readonly SyncRow[],
  maxBytes: number,
): string {
  const safeMaxBytes = Math.max(1, Math.floor(maxBytes));
  const page: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const serialized = serializeResponderRow(row);
    const rowBytes = serializedResponderRowByteLength(row) + (page.length > 0 ? 1 : 0);
    if (page.length > 0 && bytes + rowBytes > safeMaxBytes) break;
    page.push(serialized);
    bytes += rowBytes;
    if (bytes >= safeMaxBytes) break;
  }
  return page.join('\n');
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
  freshMetaPlanMemo?: FreshSwmMetaPlanMemo;
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

  if (params.cutoffIso == null) {
    // Legacy unfiltered sessions: unchanged bounded raw-graph snapshot with the
    // existing store-paged compatibility fallback.
    return readResponderRowsPage(
      cache,
      (offset, limit, signal) => readSwmMetaRowsPage(
        params.store,
        candidateGraphs,
        offset,
        limit,
        signal,
      ),
      params.offset,
      params.limit,
      params.signal,
      cache
        ? {
          loadSnapshot: () => readBoundedSwmMetaSnapshot(
            params.store,
            candidateGraphs,
            cache,
          ),
        }
        : undefined,
    );
  }

  // #1847: the TTL-filtered lane. Two invariants shape it:
  //
  //  1. The old bounded snapshot loaded the RAW meta graph and applied the
  //     row/byte budget BEFORE the TTL filter, so a long-lived CG whose `_meta`
  //     crossed 64,000 raw rows was refused even when its fresh subset was a
  //     few hundred rows — and with the fallback gated off for TTL sessions the
  //     refusal was permanent (10/15 mainnet cores, fifa-world-cup-2026).
  //  2. The old TTL fallback query (DISTINCT + UNION join + global
  //     `ORDER BY ?g ?s ?p ?o` + growing OFFSET over a mutable graph family)
  //     was gated off DELIBERATELY: it can pin cores and gigabytes on large
  //     stores (#1597 class). Re-enabling the flag alone would trade a bounded
  //     refusal for a store-melting query; that query is deleted, not revived.
  //
  // The fix mirrors buildFreshSwmDataGraphPlan: tiny discovery queries find the
  // TTL-admitted subjects (small results, no payload sort), the session plan
  // caches only graph/subject/count scalars, the snapshot materializes only the
  // ADMITTED rows (so the budget now binds on what is actually served), and an
  // intrinsically-oversized fresh set degrades to bounded whole-subject window
  // pages from the same plan instead of failing permanently.
  const cutoffIso = params.cutoffIso;
  const budgetKey = cache?.key ?? `swm-meta:${params.contextGraphId}`;
  const getPlan = createSessionPlanGetter(
    params.freshMetaPlanMemo,
    params.rowListCacheKey,
    params.refreshRowList === true,
    (signal) => buildFreshSwmMetaPlan(
      params.store,
      candidateGraphs,
      cutoffIso,
      budgetKey,
      signal,
    ),
    'Shared-memory meta sync session graph plan expired before page completion',
  );
  const loadStoreBoundedPage: StorePageLoader = async (offset, limit, signal) =>
    readFreshSwmMetaRowsPageFromPlan(
      params.store,
      await getPlan(offset, signal),
      offset,
      limit,
      budgetKey,
      signal,
    );
  return readResponderRowsPage(
    cache,
    loadStoreBoundedPage,
    params.offset,
    params.limit,
    params.signal,
    {
      loadSnapshot: cache
        ? async () => readBoundedFreshSwmMetaSnapshot(
          params.store,
          await getPlan(0, undefined),
          cutoffIso,
          cache,
        )
        : undefined,
      // The per-snapshot budget fallback MUST stay enabled here (#1847): it
      // degrades to the bounded plan-paged reader above, never to the deleted
      // global-sort query. This policy used to be a positional boolean, and
      // passing `params.cutoffIso == null` in that position is the exact defect
      // that made every 64,000-row `_meta` CG permanently unsyncable on mainnet.
      fallbackOnPerSnapshotBudget: true,
    },
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
  freshGraphPlanMemo?: FreshSwmDataGraphPlanMemo;
  exactGraphPlanMemo?: ExactGraphPagePlanMemo;
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
      params.exactGraphPlanMemo,
    );
  }

  const loadStoreBoundedPage: StorePageLoader = async (offset, limit, signal) => {
    const loadPlan = () => buildFreshSwmDataGraphPlan(
      params.store,
      dataGraphs,
      graphSet,
      candidateGraphsFor,
      params.cutoffIso!,
      signal,
    );
    const plan = params.freshGraphPlanMemo && params.rowListCacheKey
      ? await params.freshGraphPlanMemo.get(params.rowListCacheKey, loadPlan, {
        refresh: offset === 0 ? params.refreshRowList : false,
        requireExisting: offset > 0,
        signal,
      })
      : await loadPlan();
    if (!plan) {
      throw new Error('Shared-memory data sync session graph plan expired before page completion');
    }
    return readFreshSwmDataRowsPageFromPlan(
      params.store,
      plan,
      offset,
      limit,
      signal,
    );
  };
  return readResponderRowsPage(
    cache,
    loadStoreBoundedPage,
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
  assetUals?: readonly string[];
  /**
   * Serialized-response byte budget the store-paged subject extend must not
   * blow (#1916): a single admitted subject larger than this cannot be a valid
   * seal/descriptor (those are ~KB), so the extend stops growing and the page is
   * byte-capped at serialization, splitting that oversized subject with forward
   * progress. Defaults to {@link SYNC_BYTE_BUDGET_RESPONSE_BYTES}; injectable for
   * tests.
   */
  maxResponseBytes?: number;
  /**
   * Oversized-subject policy (#1916/#1923). NEGOTIATED (testnet-canary+)
   * requesters use `'byte-fit'` — the verified byte-budget behavior. A
   * NON-NEGOTIATED legacy requester uses `'fail-loud'` so an oversized `_meta`
   * subject fails loudly ({@link DurableMetaPageFrameError}) instead of returning
   * a short page the requester would read as EOF (silent metadata loss + a #1788
   * split). Defaults to the negotiated behavior; the production caller
   * (sync-handler) always spells it out from the wire `pageMode`. Subject
   * atomicity holds on both branches. See {@link MetaOversizedSubjectPolicy}.
   */
  oversizedSubjectPolicy?: MetaOversizedSubjectPolicy;
}): Promise<SyncRow[]> {
  const maxResponseBytes = params.maxResponseBytes ?? SYNC_BYTE_BUDGET_RESPONSE_BYTES;
  const oversizedSubjectPolicy = params.oversizedSubjectPolicy ?? 'byte-fit';
  if (params.assetUals !== undefined) {
    if (params.assetUals.length === 0) return [];
    const manifest = await readGraphScopedVmManifest(
      params.store,
      params.contextGraphId,
      params.signal,
    );
    const requested = new Set(params.assetUals);
    const confirmedUals = manifest.confirmedEntries
      .map((entry) => entry.ual)
      .filter((ual) => requested.has(ual));
    return readExactDurableMetaRowsPage(
      params.store,
      params.contextGraphId,
      confirmedUals,
      params.offset,
      params.limit,
      params.signal,
    );
  }
  const cache = params.rowListMemo && params.rowListCacheKey
    ? {
      memo: params.rowListMemo,
      key: params.rowListCacheKey,
      refresh: params.refreshRowList,
      refreshGeneration: params.refreshGeneration,
      expiredMessage: 'Durable meta sync session snapshot expired before page completion',
      // Durable meta is byte-budget-paginated on the requester (EOF is an empty
      // page, not a short one), and the subject-atomic extend / byte-cap can
      // legitimately serve a page shorter than `limit`. Never release the
      // session on a short page — only on the empty EOF page — or a byte-capped
      // page would drop the snapshot and strand the rest of the meta (#1916).
      releaseOnShortPage: false,
    }
    : undefined;
  const page = await readResponderRowsPage(
    cache,
    (offset, limit, signal) => readDurableMetaRowsPageSubjectAtomic(
      params.store,
      params.contextGraphId,
      params.registeredSubGraphNames,
      offset,
      limit,
      maxResponseBytes,
      oversizedSubjectPolicy,
      signal,
    ),
    params.offset,
    params.limit,
    params.signal,
    {
      // Durable meta is the one lane whose rows carry graph-scoped seals; snap
      // its page boundaries to `(g, s)` subject boundaries so a seal's control
      // fields are never split across a sync round (#1788). The cached path
      // extends via `subjectAtomic`; the store-paged loader above is itself
      // subject-atomic.
      subjectAtomic: true,
      ...(cache
        ? {
          loadSnapshot: () => readBoundedDurableMetaSnapshot(
            params.store,
            params.contextGraphId,
            params.registeredSubGraphNames,
            cache,
          ),
        }
        : {}),
    },
  );
  // Final SUBJECT-ATOMIC pass (#1916): both lanes return a page that ends on a
  // `(g, s)` boundary (cached: in-memory extend; store-paged: the loader), so its
  // trailing subject is complete. On the NEGOTIATED path this trims to whole
  // subjects within the response byte budget — deferring any subject that would
  // not fit to the next page — so a small seal AFTER large-literal rows is never
  // cut by the byte cap (no-op for the already-byte-fit store-paged page; bites
  // only when the cached extend produced a > budget page). On the NON-NEGOTIATED
  // ('fail-loud') path it does NOT trim (that would be a short page a legacy
  // requester reads as EOF); with an unbounded row limit it walks every subject
  // and throws {@link DurableMetaPageFrameError} if the whole page exceeds the
  // frame budget, otherwise returns the page unchanged.
  return page.slice(0, subjectAtomicBudgetEnd(
    page,
    0,
    maxResponseBytes,
    Number.MAX_SAFE_INTEGER,
    true,
    oversizedSubjectPolicy,
    params.contextGraphId,
  ));
}

/** Response byte budget for one changelog delta page — keeps a page under the
 * transport read cap (the requester loops for more). A single graph larger than
 * this is still emitted alone rather than split across pages. */
const DEFAULT_CHANGELOG_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * Read the constant-size V2 control rows that already form a per-KA manifest.
 *
 * The payload graph and its row count are authenticated again by the requester,
 * but deriving the responder plan from these rows removes three store-wide or
 * per-graph discovery operations from the normal rootless path: graph-family
 * enumeration as authority, child-prefix probing after the reserved VM segment,
 * and COUNT(*)/countQuads for every KA. The query is deliberately one exact
 * metadata graph, standard SPARQL 1.1, unordered, row/response bounded, and
 * backend-neutral.
 */
async function readGraphScopedVmManifest(
  store: TripleStore,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<GraphScopedVmManifest> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraph = contextGraphDataGraphUri(contextGraphId);
  const maxRows = SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS;
  const readBoundedBindings = async (
    sparql: string,
    operation: string,
  ): Promise<Array<Record<string, string>>> => {
    let result;
    try {
      result = await store.query(sparql, {
        ...syncResponderStoreOptions(signal, operation),
        maxResponseBytes: snapshotResponseByteLimit(
          SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
        ),
      });
    } catch (error) {
      if (!(error instanceof StoreResponseTooLargeError)) throw error;
      throw snapshotBudgetError({
        key: `durable-v2-manifest:${contextGraphId}`,
        reason: 'snapshot_bytes',
        rows: 0,
        bytesEstimate: storeResponseActualBytes(error),
        limit: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
      });
    }
    if (result.type !== 'bindings') return [];
    if (result.bindings.length > maxRows) {
      throw snapshotBudgetError({
        key: `durable-v2-manifest:${contextGraphId}`,
        reason: 'snapshot_rows',
        rows: result.bindings.length,
        bytesEstimate: 0,
        limit: maxRows,
      });
    }
    return result.bindings;
  };

  // Read every scope marker independently of the complete descriptor join.
  // Without this pass, a partially written V2 descriptor would be absent from
  // the join below and its payload graph could incorrectly fall through the
  // legacy compatibility lane.
  const markerBindings = await readBoundedBindings(`
    SELECT ?ual ?scopeVersion WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?ual <${DKG_CONTENT_SCOPE_VERSION}> ?scopeVersion .
      }
    }
    LIMIT ${maxRows + 1}
  `, 'sync.responder.readGraphScopedVmManifestMarkers');
  const scopeVersionsByUal = new Map<string, Set<string>>();
  for (const row of markerBindings) {
    const ual = row['ual'];
    const rawVersion = row['scopeVersion'];
    if (!ual || !rawVersion) continue;
    const versions = scopeVersionsByUal.get(ual) ?? new Set<string>();
    versions.add(stripLiteral(rawVersion));
    scopeVersionsByUal.set(ual, versions);
  }
  const currentV2Uals = new Set<string>();
  for (const [ual, versions] of scopeVersionsByUal) {
    // Lifecycle, assertion-graph and SWM-operation rows deliberately repeat
    // contentScopeVersion. Only deterministic UAL subjects are V2 descriptor
    // candidates; a UAL-shaped partial descriptor still fails closed below.
    if (!DETERMINISTIC_KA_UAL_SHAPE.test(ual)) continue;
    if (versions.size !== 1) {
      throw new Error(`Rootless sync manifest ${ual} has ambiguous scopeVersion`);
    }
    const decoded = [...versions][0]!;
    if (!/^-?\d+$/.test(decoded)) {
      throw new Error(`Rootless sync manifest ${ual} has invalid scopeVersion: ${decoded}`);
    }
    const version = BigInt(decoded);
    if (version < 0n || version.toString() !== decoded) {
      throw new Error(`Rootless sync manifest ${ual} has non-canonical scopeVersion: ${decoded}`);
    }
    if (version === 0n || version === 1n) continue;
    if (version !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
      throw new Error(`Rootless sync manifest ${ual} has unsupported contentScopeVersion ${decoded}`);
    }
    currentV2Uals.add(ual);
  }

  const bindings = await readBoundedBindings(`
      SELECT ?ual ?scopeVersion ?kaUal ?assertionVersion ?assertionGraph
             ?contextGraph ?publicTripleCount ?privateTripleCount ?status ?subGraphName
      WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          ?ual <${DKG_CONTENT_SCOPE_VERSION}> ?scopeVersion ;
               <${DKG_KA_UAL}> ?kaUal ;
               <${DKG_ASSERTION_VERSION}> ?assertionVersion ;
               <${DKG_ASSERTION_GRAPH}> ?assertionGraph ;
               <${DKG_CONTEXT_GRAPH}> ?contextGraph ;
               <${DKG_PUBLIC_TRIPLE_COUNT}> ?publicTripleCount ;
               <${DKG_PRIVATE_TRIPLE_COUNT}> ?privateTripleCount ;
               <${DKG_STATUS}> ?status .
          OPTIONAL { ?ual <${DKG_SUB_GRAPH_NAME}> ?subGraphName }
        }
      }
      LIMIT ${maxRows + 1}
  `, 'sync.responder.readGraphScopedVmManifest');

  type ManifestField =
    | 'scopeVersion'
    | 'kaUal'
    | 'assertionVersion'
    | 'assertionGraph'
    | 'contextGraph'
    | 'publicTripleCount'
    | 'privateTripleCount'
    | 'status'
    | 'subGraphName';
  const fields: readonly ManifestField[] = [
    'scopeVersion',
    'kaUal',
    'assertionVersion',
    'assertionGraph',
    'contextGraph',
    'publicTripleCount',
    'privateTripleCount',
    'status',
    'subGraphName',
  ];
  const byUal = new Map<string, Map<ManifestField, Set<string>>>();
  for (const row of bindings) {
    const ual = row['ual'];
    if (!ual) continue;
    const values = byUal.get(ual) ?? new Map<ManifestField, Set<string>>();
    for (const field of fields) {
      const value = row[field];
      if (!value) continue;
      const set = values.get(field) ?? new Set<string>();
      set.add(value);
      values.set(field, set);
    }
    byUal.set(ual, values);
  }
  for (const ual of currentV2Uals) {
    if (!byUal.has(ual)) {
      throw new Error(`Rootless sync manifest ${ual} has an incomplete V2 descriptor`);
    }
  }

  const confirmedEntries: ConfirmedGraphScopedVmManifestEntry[] = [];
  const knownGraphs = new Set<string>();
  const graphOwners = new Map<string, string>();
  for (const [ual, values] of byUal) {
    if (!currentV2Uals.has(ual)) continue;
    const requireSingle = (field: ManifestField): string => {
      const candidates = [...(values.get(field) ?? [])];
      if (candidates.length !== 1) {
        throw new Error(
          `Rootless sync manifest ${ual} has ${candidates.length === 0 ? 'missing' : 'ambiguous'} ${field}`,
        );
      }
      return candidates[0]!;
    };
    const optionalSingle = (field: ManifestField): string | undefined => {
      const candidates = [...(values.get(field) ?? [])];
      if (candidates.length > 1) {
        throw new Error(`Rootless sync manifest ${ual} has ambiguous ${field}`);
      }
      return candidates[0];
    };
    const parseCanonicalInteger = (field: ManifestField, minimum: bigint): bigint => {
      const decoded = stripLiteral(requireSingle(field));
      if (!/^-?\d+$/.test(decoded)) {
        throw new Error(`Rootless sync manifest ${ual} has invalid ${field}: ${decoded}`);
      }
      const value = BigInt(decoded);
      if (value < minimum || value.toString() !== decoded) {
        throw new Error(`Rootless sync manifest ${ual} has non-canonical ${field}: ${decoded}`);
      }
      return value;
    };

    const scopeVersion = parseCanonicalInteger('scopeVersion', 0n);
    if (scopeVersion !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
      throw new Error(`Rootless sync manifest ${ual} changed scopeVersion during projection`);
    }
    const metadataUal = requireSingle('kaUal');
    if (metadataUal !== ual) {
      throw new Error(`Rootless sync manifest UAL mismatch: subject ${ual}, kaUal ${metadataUal}`);
    }
    const assertionVersion = parseCanonicalInteger('assertionVersion', 1n);
    const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
    if (scope.ual !== ual) {
      throw new Error(`Rootless sync manifest contains non-canonical UAL ${ual}`);
    }
    if (requireSingle('contextGraph') !== contextGraph) {
      throw new Error(`Rootless sync manifest ${ual} points outside context graph ${contextGraphId}`);
    }
    const rawSubGraphName = optionalSingle('subGraphName');
    const subGraphName = rawSubGraphName === undefined
      ? undefined
      : stripLiteral(rawSubGraphName);
    if (subGraphName !== undefined && !validateSubGraphName(subGraphName).valid) {
      throw new Error(`Rootless sync manifest ${ual} has invalid subGraphName ${subGraphName}`);
    }
    const expectedGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      scope,
      subGraphName,
    );
    const assertionGraph = requireSingle('assertionGraph');
    if (assertionGraph !== expectedGraph) {
      throw new Error(
        `Rootless sync manifest ${ual} assertionGraph mismatch: expected ${expectedGraph}, found ${assertionGraph}`,
      );
    }
    const publicCount = parseCanonicalInteger('publicTripleCount', 0n);
    const privateCount = parseCanonicalInteger('privateTripleCount', 0n);
    if (publicCount > BigInt(Number.MAX_SAFE_INTEGER) || privateCount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Rootless sync manifest ${ual} has an unsafe triple count`);
    }
    if (publicCount === 0n && privateCount === 0n) {
      throw new Error(`Rootless sync manifest ${ual} describes an empty asset`);
    }
    const owner = graphOwners.get(assertionGraph);
    if (owner && owner !== ual) {
      throw new Error(`Rootless sync graph ${assertionGraph} has multiple UAL owners`);
    }
    graphOwners.set(assertionGraph, ual);
    knownGraphs.add(assertionGraph);

    const statuses = new Set(
      [...(values.get('status') ?? [])].map((status) => stripLiteral(status)),
    );
    if (statuses.size !== 1) {
      throw new Error(`Rootless sync manifest ${ual} has ambiguous status metadata`);
    }
    if (!statuses.has('confirmed')) continue;
    confirmedEntries.push({
      ual,
      graph: assertionGraph,
      rowCount: Number(publicCount),
    });
  }
  confirmedEntries.sort((a, b) => compareCodePoint(a.graph, b.graph));
  return {
    confirmedEntries,
    confirmedGraphs: new Set(confirmedEntries.map((entry) => entry.graph)),
    knownGraphs,
  };
}

/**
 * The per-CG admission boundary shared by the durable-data phase and the
 * changelog delta lane: the candidate-graph exclusions (wrong CG / top or
 * first-level subgraph `_meta` / transient WM / `/_shared_memory*` /
 * `/_private`) and the
 * RFC-49 `isAdmitted` gate
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
  opts: {
    includeTopMeta?: boolean;
    graphScopedVmManifest?: GraphScopedVmManifest;
  } = {},
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
    // `<cg>/<subGraph>/_meta` is protocol control metadata for the subgraph
    // itself (for example local migration markers).  It is not KA payload and
    // must not enter the durable-data integrity verifier.  Keep deeper
    // `.../_meta` graphs admitted: assertion and partition metadata are
    // integrity-bearing durable material served alongside their data graph.
    const relative = graph.startsWith(`${cgPrefix}/`)
      ? graph.slice(cgPrefix.length + 1)
      : '';
    if (relative.split('/').length === 2 && relative.endsWith('/_meta')) return false;
    const segments = relative.split('/').filter(Boolean);
    // Working memory is transient and has no durable metadata anchor (the
    // durable-meta phase deliberately excludes memoryLayer=WM). Serving an
    // orphan or abandoned WM graph here therefore creates unverifiable payload
    // and, on real stores, can sort millions of unrelated draft rows. SWM has a
    // dedicated phase and private graphs are never served by durable sync.
    if (segments.includes('_working_memory')) return false;
    if (segments.includes('_shared_memory') || segments.includes('_shared_memory_meta')) return false;
    return !segments.includes('_private');
  };
  let assertionGraphs: Set<string> | null = null;
  const isAdmitted = (signal?: AbortSignal) => async (graph: string): Promise<boolean> => {
    const graphWithoutMeta = graph.endsWith('/_meta')
      ? graph.slice(0, -'/_meta'.length)
      : graph;
    if (opts.graphScopedVmManifest?.knownGraphs.has(graphWithoutMeta)) {
      if (!opts.graphScopedVmManifest.confirmedGraphs.has(graphWithoutMeta)) return false;
    }
    if (graph.includes('/assertion/')) {
      assertionGraphs ??= await readAdmittedAssertionGraphs(store, contextGraphId, signal);
      if (!assertionGraphs.has(graphWithoutMeta)) return false;
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
  const graphScopedVmManifest = await readGraphScopedVmManifest(
    params.store,
    params.contextGraphId,
    params.signal,
  );
  const { isCandidateGraph, isAdmitted } = createAdmissionContext(
    params.store,
    params.contextGraphId,
    { includeTopMeta: true, graphScopedVmManifest },
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
  exactGraphPlanMemo?: ExactGraphPagePlanMemo;
  /** Keep the immutable row snapshot until an explicit empty-page EOF. */
  releaseCacheOnShortPage?: boolean;
  assetUals?: readonly string[];
}): Promise<SyncRow[]> {
  const cache = params.rowListMemo
    ? {
      memo: params.rowListMemo,
      key: durableDataRowListCacheKey(
        params.rowListCacheScope ?? 'default',
        params.contextGraphId,
        params.sinceBatchId,
        params.assetUals,
      ),
      refresh: params.refreshRowList,
      refreshGeneration: params.refreshGeneration,
      releaseOnShortPage: params.releaseCacheOnShortPage,
    }
    : undefined;

  if (params.assetUals !== undefined) {
    if (params.assetUals.length === 0) return [];
    const requested = new Set(params.assetUals);
    return readPagedRowsFromExactGraphPlanLoader(
      params.store,
      params.offset,
      params.limit,
      cache,
      params.signal,
      params.exactGraphPlanMemo,
      async (planSignal) => {
        const manifest = await readGraphScopedVmManifest(
          params.store,
          params.contextGraphId,
          planSignal,
        );
        const entries = manifest.confirmedEntries.filter((entry) => requested.has(entry.ual));
        return buildExactGraphPagePlan(
          params.store,
          entries.map((entry) => entry.graph),
          () => Promise.resolve(true),
          planSignal,
          new Map(entries.map((entry) => [entry.graph, entry.rowCount])),
        );
      },
    );
  }

  if (params.sinceBatchId == null) {
    return readPagedRowsFromExactGraphPlanLoader(
      params.store,
      params.offset,
      params.limit,
      cache,
      params.signal,
      params.exactGraphPlanMemo,
      async (planSignal) => {
        const manifest = await readGraphScopedVmManifest(
          params.store,
          params.contextGraphId,
          planSignal,
        );
        const { isCandidateGraph, isAdmitted } = createAdmissionContext(
          params.store,
          params.contextGraphId,
          { graphScopedVmManifest: manifest },
        );
        // A just-committed exact graph may precede a stale external graph-list
        // cache. Include every confirmed non-empty manifest graph explicitly;
        // the count-vs-read invariant below will fail closed if its payload is
        // absent or raced.
        //
        // Once a CG has a V2 manifest, that manifest is the complete durable KA
        // payload inventory. Mixing the old aggregate `/context/<id>` projection
        // (and other unbound legacy partitions such as `_catalog`) into the same
        // response makes the requester reject an otherwise valid rootless batch.
        // Legacy-only CGs retain the graph-list path, so their existing local
        // data remains readable and can still be synchronized on that lane.
        const legacyCandidateGraphs = manifest.knownGraphs.size === 0
          ? params.graphList.filter(isCandidateGraph)
          : [];
        const candidateGraphs = dedupeStrings([
          ...legacyCandidateGraphs,
          ...manifest.confirmedEntries
            .filter((entry) => entry.rowCount > 0)
            .map((entry) => entry.graph),
        ]).sort(compareCodePoint);
        const knownRowCounts = new Map(
          manifest.confirmedEntries.map((entry) => [entry.graph, entry.rowCount]),
        );
        return buildExactGraphPagePlan(
          params.store,
          candidateGraphs,
          isAdmitted(params.rowListMemo ? undefined : planSignal),
          planSignal,
          knownRowCounts,
        );
      },
    );
  }

  // The batch-id lane is legacy compatibility. Still load the V2 manifest for
  // admission so tentative V2 graphs cannot fall through as legacy payload;
  // OT-RFC-59 changelog is the scalable incremental lane for rootless KAs.
  const manifest = await readGraphScopedVmManifest(
    params.store,
    params.contextGraphId,
    params.signal,
  );
  const { cgPrefix, topMetaGraph, isCandidateGraph, isAdmitted } =
    createAdmissionContext(params.store, params.contextGraphId, {
      graphScopedVmManifest: manifest,
    });
  const candidateGraphs = dedupeStrings([
    ...params.graphList.filter(isCandidateGraph),
    ...manifest.confirmedEntries
      .filter((entry) => entry.rowCount > 0)
      .map((entry) => entry.graph),
  ]).sort(compareCodePoint);

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
    cache,
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
  planMemo?: ExactGraphPagePlanMemo,
  knownRowCounts?: ReadonlyMap<string, number>,
): Promise<SyncRow[]> {
  return readPagedRowsFromExactGraphPlanLoader(
    store,
    offset,
    limit,
    cache,
    signal,
    planMemo,
    (planSignal) => buildExactGraphPagePlan(
      store,
      graphs,
      isAdmitted,
      planSignal,
      knownRowCounts,
    ),
  );
}

async function readPagedRowsFromExactGraphPlanLoader(
  store: TripleStore,
  offset: number,
  limit: number,
  cache: RowListCache | undefined,
  signal: AbortSignal | undefined,
  planMemo: ExactGraphPagePlanMemo | undefined,
  loadExactGraphPlan: (signal?: AbortSignal) => Promise<ExactGraphPagePlan>,
): Promise<SyncRow[]> {
  const rowSnapshotLimits = cache?.memo.snapshotLoadLimits ?? {
    maxRows: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
    maxBytesEstimate: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
    pageRows: SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
  };
  const getPlan = createSessionPlanGetter(
    planMemo,
    cache?.key,
    cache?.refresh === true,
    (planSignal) => loadExactGraphPlan(planSignal),
    'Sync session exact-graph plan expired before page completion',
  );
  const loadPage: StorePageLoader = async (pageOffset, pageLimit, pageSignal) => {
    const plan = await getPlan(pageOffset, pageSignal);
    return readRowsPageFromExactGraphPlan(
      store,
      plan,
      pageOffset,
      pageLimit,
      rowSnapshotLimits,
      pageSignal,
    );
  };
  return readResponderRowsPage(
    cache && {
      ...cache,
      expiredMessage: cache.expiredMessage ?? 'Durable data sync session snapshot expired before page completion',
    },
    loadPage,
    offset,
    limit,
    signal,
    cache
      ? {
        loadSnapshot: async () => readExactGraphPlanSnapshot(
          store,
          await getPlan(0, undefined),
          cache,
          rowSnapshotLimits,
        ),
      }
      : undefined,
  );
}

async function buildExactGraphPagePlan(
  store: TripleStore,
  graphs: readonly string[],
  isAdmitted: (graph: string) => Promise<boolean>,
  signal?: AbortSignal,
  knownRowCounts?: ReadonlyMap<string, number>,
): Promise<ExactGraphPagePlan> {
  const entries: ExactGraphPagePlanEntry[] = [];
  for (const graph of dedupeStrings(graphs).sort(compareCodePoint)) {
    throwIfAborted(signal);
    if (!(await isAdmitted(graph))) continue;
    const rowCount = knownRowCounts?.get(graph) ?? await store.countQuads(
      graph,
      syncResponderStoreOptions(signal, 'sync.responder.countExactGraphRows'),
    );
    if (rowCount > 0) entries.push({ graph, rowCount });
  }
  return {
    entries,
    totalRows: entries.reduce((sum, entry) => sum + entry.rowCount, 0),
    pagedGraphs: new Set<string>(),
  };
}

interface ExactGraphSnapshotLimits {
  maxRows: number;
  maxBytesEstimate: number;
}

function snapshotResponseByteLimit(maxBytesEstimate: number): number {
  // SPARQL JSON adds field names and escaping around each RDF term. Bound the
  // transport body independently while leaving enough headroom for that wire
  // overhead. HTTP adapters enforce this before parsing; embedded adapters are
  // still bounded by the row LIMIT below.
  return Math.max(
    1,
    Math.min(Number.MAX_SAFE_INTEGER, Math.floor(maxBytesEstimate) * 2),
  );
}

/** Clamp a store response-cap overshoot (possibly bigint) into a safe number. */
function storeResponseActualBytes(error: StoreResponseTooLargeError): number {
  return typeof error.actualBytes === 'bigint'
    ? Number(error.actualBytes > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : error.actualBytes)
    : error.actualBytes;
}

function snapshotBudgetError(params: {
  key: string;
  reason: 'snapshot_rows' | 'snapshot_bytes';
  rows: number;
  bytesEstimate: number;
  limit: number;
}): SyncRowSnapshotBudgetError {
  return new SyncRowSnapshotBudgetError(params);
}

async function loadExactGraphRowsSnapshot(
  store: TripleStore,
  plan: ExactGraphPagePlan,
  entry: ExactGraphPagePlanEntry,
  limits: ExactGraphSnapshotLimits,
  signal?: AbortSignal,
): Promise<readonly SyncRow[] | null> {
  if (entry.rowCount > limits.maxRows || plan.pagedGraphs.has(entry.graph)) return null;
  if (plan.activeGraphRows?.graph === entry.graph) return plan.activeGraphRows.rows;
  if (plan.activeGraphRowsLoad?.graph === entry.graph) {
    return raceAgainstAbort(plan.activeGraphRowsLoad.promise, signal);
  }

  const load = (async (): Promise<readonly SyncRow[] | null> => {
    try {
      const result = await store.query(`
        SELECT ?s ?p ?o WHERE {
          GRAPH <${assertSafeIri(entry.graph)}> { ?s ?p ?o }
        }
        LIMIT ${limits.maxRows + 1}
      `, {
        ...syncResponderStoreOptions(undefined, 'sync.responder.readExactGraphSnapshot'),
        maxResponseBytes: snapshotResponseByteLimit(limits.maxBytesEstimate),
      });
      if (result.type !== 'bindings') return [];
      const rows: SyncRow[] = [];
      let bytesEstimate = 0;
      for (const row of result.bindings) {
        const s = row['s'];
        const p = row['p'];
        const o = row['o'];
        if (!s || !p || !o) continue;
        const nextBytes = bytesEstimate + estimateStringRowHeapBytes(s, p, o, entry.graph);
        if (rows.length + 1 > limits.maxRows || nextBytes > limits.maxBytesEstimate) {
          plan.pagedGraphs.add(entry.graph);
          return null;
        }
        rows.push({ s, p, o, g: entry.graph });
        bytesEstimate = nextBytes;
      }
      // The plan count and payload must describe one immutable graph snapshot.
      // A mismatch means the graph changed between COUNT and SELECT; fail the
      // session rather than silently skipping or duplicating rows.
      if (rows.length !== entry.rowCount) {
        throw new Error(
          `Sync exact-graph plan changed while reading ${entry.graph}: ` +
          `expected ${entry.rowCount} rows, found ${rows.length}`,
        );
      }
      rows.sort(compareRows);
      plan.activeGraphRows = { graph: entry.graph, rows };
      return rows;
    } catch (error) {
      if (error instanceof StoreResponseTooLargeError) {
        plan.pagedGraphs.add(entry.graph);
        return null;
      }
      throw error;
    }
  })().finally(() => {
    if (plan.activeGraphRowsLoad?.promise === load) plan.activeGraphRowsLoad = undefined;
  });
  plan.activeGraphRowsLoad = { graph: entry.graph, promise: load };
  return raceAgainstAbort(load, signal);
}

async function readExactGraphPlanSnapshot(
  store: TripleStore,
  plan: ExactGraphPagePlan,
  cache: RowListCache,
  limits: ExactGraphSnapshotLimits,
): Promise<readonly SyncRow[]> {
  if (plan.totalRows > limits.maxRows) {
    throw snapshotBudgetError({
      key: cache.key,
      reason: 'snapshot_rows',
      rows: plan.totalRows,
      bytesEstimate: 0,
      limit: limits.maxRows,
    });
  }
  const rows: SyncRow[] = [];
  let bytesEstimate = 0;
  for (const entry of plan.entries) {
    const graphRows = await loadExactGraphRowsSnapshot(store, plan, entry, limits);
    if (!graphRows) {
      throw snapshotBudgetError({
        key: cache.key,
        reason: 'snapshot_bytes',
        rows: rows.length,
        bytesEstimate: limits.maxBytesEstimate + 1,
        limit: limits.maxBytesEstimate,
      });
    }
    for (const row of graphRows) {
      const nextBytes = bytesEstimate + estimateStringRowHeapBytes(row.s, row.p, row.o, row.g);
      if (nextBytes > limits.maxBytesEstimate) {
        throw snapshotBudgetError({
          key: cache.key,
          reason: 'snapshot_bytes',
          rows: rows.length + 1,
          bytesEstimate: nextBytes,
          limit: limits.maxBytesEstimate,
        });
      }
      rows.push(row);
      bytesEstimate = nextBytes;
    }
  }
  return rows.sort(compareRows);
}

async function readRowsPageFromExactGraphPlan(
  store: TripleStore,
  plan: ExactGraphPagePlan,
  offset: number,
  limit: number,
  snapshotLimits: ExactGraphSnapshotLimits,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  let skip = Math.max(0, Math.floor(offset));
  let remaining = Math.max(0, Math.floor(limit));
  if (remaining === 0 || skip >= plan.totalRows) return [];
  const rows: SyncRow[] = [];
  for (const entry of plan.entries) {
    if (skip >= entry.rowCount) {
      skip -= entry.rowCount;
      continue;
    }
    let added = 0;
    const graphRows = await loadExactGraphRowsSnapshot(
      store,
      plan,
      entry,
      snapshotLimits,
      signal,
    );
    if (graphRows) {
      const page = graphRows.slice(skip, skip + remaining);
      rows.push(...page);
      added = page.length;
    } else {
      const result = await store.query(`
        SELECT ?s ?p ?o WHERE {
          GRAPH <${assertSafeIri(entry.graph)}> { ?s ?p ?o }
        }
        ORDER BY ?s ?p ?o
        OFFSET ${skip}
        LIMIT ${remaining}
      `, {
        ...syncResponderStoreOptions(signal, 'sync.responder.readExactGraphRowsPage'),
        maxResponseBytes: snapshotResponseByteLimit(snapshotLimits.maxBytesEstimate),
      });
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const s = row['s'];
          const p = row['p'];
          const o = row['o'];
          if (s && p && o) {
            rows.push({ s, p, o, g: entry.graph });
            added += 1;
          }
        }
      }
    }
    remaining -= added;
    if (remaining <= 0) break;
    skip = 0;
  }
  return rows;
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
function createSessionPlanGetter<T>(
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
 * a per-exact-graph `OFFSET`, which — unlike a retained session snapshot — is
 * NOT stable if that exact graph mutates between two page requests of the same
 * session (a row inserted before the current offset can shift the window,
 * duplicating or skipping a row). New graph-scoped KAs are immutable for one
 * assertion version, so this caveat is limited to legacy mutable graph shapes.
 * It is bounded in blast radius:
 * durable data is Merkle-verified end-to-end, so an inconsistent assembly fails
 * verification and the requester restarts the phase (churn, not silent
 * corruption); it only bites an oversized AND concurrently-mutating context
 * graph. The durable legacy fix is a stable keyset/seek cursor within the exact
 * graph; the global cross-graph sort/offset is deliberately no longer used.
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

/**
 * Optional behavior of {@link readResponderRowsPage}, named instead of
 * positional: a bare boolean in this helper's signature is how the #1847
 * production defect happened (`params.cutoffIso == null` read as the fallback
 * policy), so call sites must now spell the policy out.
 */
interface ResponderRowsPageOptions {
  /** Session snapshot loader; omitted phases build via the store-paged loader. */
  loadSnapshot?: () => Promise<readonly SyncRow[]>;
  /**
   * Whether a PER-snapshot rows/bytes budget refusal degrades to the
   * store-bounded page loader for this and every later page of the session
   * (defaults to true; global budget pressure always propagates).
   */
  fallbackOnPerSnapshotBudget?: boolean;
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

async function readResponderRowsPage(
  cache: RowListCache | undefined,
  loadStoreBoundedPage: StorePageLoader,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  options?: ResponderRowsPageOptions,
): Promise<SyncRow[]> {
  const loadSnapshot = options?.loadSnapshot;
  const fallbackOnPerSnapshotBudget = options?.fallbackOnPerSnapshotBudget ?? true;
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
    if (!isPerSnapshotBudgetError(error) || !fallbackOnPerSnapshotBudget) throw error;
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

  // A KA layer segment is a namespace boundary, not a possible child-CG name.
  // Only prefixes BEFORE it can own the graph. The previous generic walk also
  // ASKed the full graph and every publisher/KA-id suffix (including the full
  // graph twice), multiplying a 50-KA bootstrap into roughly 200 pointless
  // metadata probes. Top-level VM therefore needs zero ASK calls; a VM under a
  // named subgraph needs only the one ownership check for that subgraph prefix.
  const vmBoundary = segments.indexOf('_verifiable_memory');
  if (vmBoundary >= 0) {
    let possibleChild = cgPrefix;
    for (let index = 0; index < vmBoundary; index++) {
      possibleChild = `${possibleChild}/${segments[index]}`;
      if (await isKnownContextGraph(store, possibleChild, signal)) return true;
    }
    return false;
  }
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

/**
 * Legacy (cutoffIso == null) bounded snapshot: reads the raw candidate meta
 * graphs under the per-snapshot budget. TTL-filtered sessions use
 * {@link readBoundedFreshSwmMetaSnapshot}, whose budget binds on the admitted
 * fresh subset instead of the raw graph size (#1847).
 */
async function readBoundedSwmMetaSnapshot(
  store: TripleStore,
  swmMetaGraphs: readonly string[],
  cache: RowListCache,
): Promise<readonly SyncRow[]> {
  const limits = cache.memo.snapshotLoadLimits ?? {
    maxRows: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
    maxBytesEstimate: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
    pageRows: SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
  };
  const rows: SyncRow[] = [];
  let bytesEstimate = 0;

  for (const graph of dedupeStrings(swmMetaGraphs).sort(compareCodePoint)) {
    const remainingRows = limits.maxRows - rows.length;
    if (remainingRows < 0) {
      throw snapshotBudgetError({
        key: cache.key,
        reason: 'snapshot_rows',
        rows: rows.length,
        bytesEstimate,
        limit: limits.maxRows,
      });
    }
    let result;
    try {
      result = await store.query(`
        SELECT ?s ?p ?o WHERE {
          GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
        }
        LIMIT ${remainingRows + 1}
      `, {
        ...syncResponderStoreOptions(undefined, 'sync.responder.readSwmMetaGraphSnapshot'),
        maxResponseBytes: snapshotResponseByteLimit(
          Math.max(1, limits.maxBytesEstimate - bytesEstimate),
        ),
      });
    } catch (error) {
      if (!(error instanceof StoreResponseTooLargeError)) throw error;
      throw snapshotBudgetError({
        key: cache.key,
        reason: 'snapshot_bytes',
        rows: rows.length,
        bytesEstimate: bytesEstimate + storeResponseActualBytes(error),
        limit: limits.maxBytesEstimate,
      });
    }
    if (result.type !== 'bindings') continue;
    for (const binding of result.bindings) {
      const s = binding['s'];
      const p = binding['p'];
      const o = binding['o'];
      if (!s || !p || !o) continue;
      const nextRows = rows.length + 1;
      if (nextRows > limits.maxRows) {
        throw snapshotBudgetError({
          key: cache.key,
          reason: 'snapshot_rows',
          rows: nextRows,
          bytesEstimate,
          limit: limits.maxRows,
        });
      }
      const nextBytes = bytesEstimate + estimateStringRowHeapBytes(s, p, o, graph);
      if (nextBytes > limits.maxBytesEstimate) {
        throw snapshotBudgetError({
          key: cache.key,
          reason: 'snapshot_bytes',
          rows: nextRows,
          bytesEstimate: nextBytes,
          limit: limits.maxBytesEstimate,
        });
      }
      rows.push({ s, p, o, g: graph });
      bytesEstimate = nextBytes;
    }
  }

  return filterSwmMetaSnapshotRows(rows, null);
}

function filterSwmMetaSnapshotRows(
  rows: readonly SyncRow[],
  cutoffIso: string | null,
): SyncRow[] {
  if (cutoffIso == null) return [...rows].sort(compareRows);
  const cutoffMs = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoffMs)) return [];

  const bySubject = new Map<string, SyncRow[]>();
  for (const row of rows) {
    const bucket = bySubject.get(row.s) ?? [];
    bucket.push(row);
    bySubject.set(row.s, bucket);
  }
  const objects = (subject: string, predicate: string): string[] =>
    (bySubject.get(subject) ?? [])
      .filter((row) => row.p === predicate)
      .map((row) => row.o);
  const isFresh = (subject: string): boolean => objects(subject, DKG_PUBLISHED_AT)
    .some((value) => {
      const timestamp = Date.parse(stripLiteral(value));
      return Number.isFinite(timestamp) && timestamp >= cutoffMs;
    });
  const scopeIsCurrent = (subject: string): boolean =>
    objects(subject, DKG_CONTENT_SCOPE_VERSION)
      .some((value) => stripLiteral(value) === String(GRAPH_KA_CONTENT_SCOPE_VERSION));
  const tupleKeys = (subject: string): string[] => {
    if (!scopeIsCurrent(subject)) return [];
    const uals = objects(subject, DKG_KA_UAL);
    const versions = objects(subject, DKG_ASSERTION_VERSION);
    const shares = objects(subject, DKG_SHARE_OPERATION_ID);
    const keys: string[] = [];
    for (const ual of uals) {
      for (const version of versions) {
        for (const share of shares) keys.push(JSON.stringify([ual, version, share]));
      }
    }
    return keys;
  };

  const admitted = new Set<string>();
  const freshOperationKeys = new Set<string>();
  for (const [subject] of bySubject) {
    if (isFresh(subject)) admitted.add(subject);
    if (
      isFresh(subject) &&
      objects(subject, DKG_ONTOLOGY.RDF_TYPE).includes(DKG_WORKSPACE_OPERATION)
    ) {
      for (const key of tupleKeys(subject)) freshOperationKeys.add(key);
    }
  }
  for (const [subject] of bySubject) {
    if (tupleKeys(subject).some((key) => freshOperationKeys.has(key))) admitted.add(subject);
  }

  return rows.filter((row) => admitted.has(row.s)).sort(compareRows);
}

/**
 * Legacy UNFILTERED store-paged compatibility path (cutoffIso == null sessions
 * only). The former TTL variant of this query — DISTINCT + a six-predicate
 * UNION join + global `ORDER BY ?g ?s ?p ?o` re-evaluated with a growing
 * OFFSET per page over a mutable graph family — was the #1847 store-melter and
 * is deliberately DELETED, not gated: TTL-filtered sessions page from the
 * session plan via {@link readFreshSwmMetaRowsPageFromPlan} instead.
 */
async function readSwmMetaRowsPage(
  store: TripleStore,
  swmMetaGraphs: readonly string[],
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const swmMetaValues = graphValues(swmMetaGraphs);
  if (!swmMetaValues) return [];
  // sparql-scan-allow: R2 -- ?g is bound by a finite VALUES list of pre-admitted SWM meta graph IRIs
  // sparql-scan-allow: R3 -- pre-existing legacy (cutoff-less) compatibility lane, unchanged behavior; TTL sessions page from the session plan instead (#1847)
  const res = await store.query(`
    SELECT DISTINCT ?g ?s ?p ?o WHERE {
      VALUES ?g { ${swmMetaValues} }
      GRAPH ?g {
        ?s ?p ?o .
      }
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

const FRESH_SWM_META_PLAN_SUBJECT_CHUNK = 100;

/**
 * Hard cardinality cap for a TTL meta session plan's admitted subjects, across
 * all candidate graphs of the phase. The discovery queries are LIMIT-bounded to
 * this cap (plus one sentinel row), so plan construction can never materialize
 * an unbounded subject set no matter how large the fresh window is: a fresh set
 * beyond the cap is a typed bounded refusal, never an unbounded control-plane
 * plan. Sizing: every admitted subject serves at least one row, so this cap
 * alone admits sessions far past the point where they run plan-paged, while
 * the retained plan stays a few megabytes at worst (also capped by the fixed
 * build byte estimate below, which bounds pathological IRI lengths).
 */
export const FRESH_SWM_META_PLAN_MAX_SUBJECTS = 32_000;

/**
 * Discover the TTL-admitted subjects of one SWM meta graph with two
 * small-result queries (no payload rows, no sort, no OFFSET), each bounded by
 * construction: LIMIT (remaining subject allowance + 1 sentinel) and the fixed
 * snapshot-build response byte cap. Crossing either bound is a typed
 * per-snapshot budget refusal — the plan lane's one remaining bounded refusal
 * besides the single-oversized-subject case.
 *
 *  1. subjects carrying their own fresh `publishedAt` — the
 *     {@link readFreshSwmRoots} shape, an indexed predicate probe whose result
 *     is the fresh subset, not the graph;
 *  2. graph-scoped SWM heads. Heads are current-state pointers and
 *     intentionally have no independent publishedAt row; they are admitted via
 *     the timestamped WorkspaceOperation they select (same six-predicate join
 *     the TTL lane has always used), so TTL recovery receives the head plus its
 *     immutable commitment atomically.
 *
 * SWM meta subjects are IRIs by contract (workspace writers skolemize blank
 * nodes before storage); non-IRI subjects cannot appear in a VALUES clause and
 * are skipped.
 */
async function readFreshSwmMetaSubjects(
  store: TripleStore,
  graph: string,
  cutoffIso: string,
  maxSubjects: number,
  budgetKey: string,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const cutoffFilter =
    `FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)`;
  const discoveryLimit = Math.max(1, Math.floor(maxSubjects)) + 1;
  const subjects = new Set<string>();
  const runDiscovery = async (sparql: string, operation: string): Promise<void> => {
    let res;
    try {
      res = await store.query(sparql, {
        ...syncResponderStoreOptions(signal, operation),
        maxResponseBytes: snapshotResponseByteLimit(
          SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
        ),
      });
    } catch (error) {
      if (!(error instanceof StoreResponseTooLargeError)) throw error;
      throw snapshotBudgetError({
        key: budgetKey,
        reason: 'snapshot_bytes',
        rows: subjects.size,
        bytesEstimate: storeResponseActualBytes(error),
        limit: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
      });
    }
    if (res.type !== 'bindings') return;
    for (const row of res.bindings) {
      const subject = row['s'];
      if (subject && isIriTerm(subject)) subjects.add(subject);
    }
    if (subjects.size > maxSubjects) {
      throw snapshotBudgetError({
        key: budgetKey,
        reason: 'snapshot_rows',
        rows: subjects.size,
        bytesEstimate: 0,
        limit: FRESH_SWM_META_PLAN_MAX_SUBJECTS,
      });
    }
  };
  await runDiscovery(`
    SELECT DISTINCT ?s WHERE {
      GRAPH <${assertSafeIri(graph)}> {
        ?s <${DKG_PUBLISHED_AT}> ?ts .
        ${cutoffFilter}
      }
    }
    LIMIT ${discoveryLimit}
  `, 'sync.responder.readFreshSwmMetaSubjects');
  await runDiscovery(`
    SELECT DISTINCT ?s WHERE {
      GRAPH <${assertSafeIri(graph)}> {
        ?s <${DKG_CONTENT_SCOPE_VERSION}> ${GRAPH_KA_CONTENT_SCOPE_VERSION} ;
           <${DKG_KA_UAL}> ?headUal ;
           <${DKG_ASSERTION_VERSION}> ?headVersion ;
           <${DKG_SHARE_OPERATION_ID}> ?shareId .
        ?headOperation <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
           <${DKG_CONTENT_SCOPE_VERSION}> ${GRAPH_KA_CONTENT_SCOPE_VERSION} ;
           <${DKG_KA_UAL}> ?headUal ;
           <${DKG_ASSERTION_VERSION}> ?headVersion ;
           <${DKG_SHARE_OPERATION_ID}> ?shareId ;
           <${DKG_PUBLISHED_AT}> ?ts .
        ${cutoffFilter}
      }
    }
    LIMIT ${discoveryLimit}
  `, 'sync.responder.readFreshSwmMetaHeadSubjects');
  return subjects;
}

function subjectValues(subjects: readonly string[]): string {
  return subjects.map((subject) => `<${assertSafeIri(subject)}>`).join(' ');
}

async function countFreshSwmMetaSubjectRows(
  store: TripleStore,
  graph: string,
  subjects: readonly string[],
  budgetKey: string,
  signal?: AbortSignal,
): Promise<FreshSwmMetaSubjectEntry[]> {
  const countsBySubject = new Map<string, number>();
  for (const chunk of chunkValues(subjects, FRESH_SWM_META_PLAN_SUBJECT_CHUNK)) {
    let res;
    try {
      res = await store.query(`
        SELECT ?s (COUNT(*) AS ?count) WHERE {
          VALUES ?s { ${subjectValues(chunk)} }
          GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
        }
        GROUP BY ?s
      `, {
        ...syncResponderStoreOptions(signal, 'sync.responder.countFreshSwmMetaSubjectRows'),
        maxResponseBytes: snapshotResponseByteLimit(
          SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
        ),
      });
    } catch (error) {
      if (!(error instanceof StoreResponseTooLargeError)) throw error;
      throw snapshotBudgetError({
        key: budgetKey,
        reason: 'snapshot_bytes',
        rows: chunk.length,
        bytesEstimate: storeResponseActualBytes(error),
        limit: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
      });
    }
    if (res.type !== 'bindings') continue;
    for (const row of res.bindings) {
      const subject = row['s'];
      if (subject) countsBySubject.set(subject, parseSparqlInteger(row['count']));
    }
  }
  return subjects
    .map((subject) => ({ subject, rowCount: countsBySubject.get(subject) ?? 0 }))
    .filter((entry) => entry.rowCount > 0);
}

/**
 * Build the tiny, stable pagination plan for a TTL-filtered SWM meta phase.
 * Only graph/subject/count scalars are computed and cached; the payload rows
 * stay in the store until a page (or the bounded snapshot) addresses its own
 * subject window. Subjects are compareCodePoint-sorted so the plan's prefix
 * sums agree with the compareRows order used when window rows are sorted
 * in-process — no store-side ORDER BY or OFFSET is ever needed.
 *
 * The plan itself is bounded by construction: subject cardinality by
 * {@link FRESH_SWM_META_PLAN_MAX_SUBJECTS} (enforced inside the LIMIT-bounded
 * discovery), and the retained scalar estimate by the FIXED snapshot build
 * byte cap — deliberately the constant, not the test/operator-shrinkable
 * session budget, so shrinking the session budget forces plan-paged mode
 * without ever refusing the plan that paged mode needs (#1847 class).
 */
async function buildFreshSwmMetaPlan(
  store: TripleStore,
  swmMetaGraphs: readonly string[],
  cutoffIso: string,
  budgetKey: string,
  signal?: AbortSignal,
): Promise<FreshSwmMetaPlan> {
  const entries: FreshSwmMetaGraphPlanEntry[] = [];
  let subjectAllowance = FRESH_SWM_META_PLAN_MAX_SUBJECTS;
  let bytesEstimate = 0;
  for (const graph of dedupeStrings(swmMetaGraphs).sort(compareCodePoint)) {
    throwIfAborted(signal);
    const admitted = await readFreshSwmMetaSubjects(
      store,
      graph,
      cutoffIso,
      subjectAllowance,
      budgetKey,
      signal,
    );
    if (admitted.size === 0) continue;
    subjectAllowance -= admitted.size;
    const subjects = await countFreshSwmMetaSubjectRows(
      store,
      graph,
      [...admitted].sort(compareCodePoint),
      budgetKey,
      signal,
    );
    if (subjects.length === 0) continue;
    for (const entry of subjects) {
      bytesEstimate += estimateStringRowHeapBytes(entry.subject, '', '', graph);
    }
    if (bytesEstimate > SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE) {
      throw snapshotBudgetError({
        key: budgetKey,
        reason: 'snapshot_bytes',
        rows: subjects.length,
        bytesEstimate,
        limit: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
      });
    }
    entries.push({
      graph,
      subjects,
      rowCount: subjects.reduce((sum, entry) => sum + entry.rowCount, 0),
    });
  }
  return {
    entries,
    totalRows: entries.reduce((sum, entry) => sum + entry.rowCount, 0),
    bytesEstimate,
  };
}

/** Order/content digest of one subject's compareRows-sorted row-group. */
function digestSubjectRows(rows: readonly SyncRow[]): string {
  const hash = sha256.create();
  const encoder = new TextEncoder();
  for (const row of rows) {
    // Length-prefixed fields: literals may contain any delimiter character.
    hash.update(encoder.encode(`${row.p.length}:${row.p}${row.o.length}:${row.o}`));
  }
  return bytesToHex(hash.digest());
}

/**
 * Read ALL rows of a whole-subject window in bounded VALUES chunks, verifying
 * each subject's row-group against the plan two ways. The plan's prefix sums
 * are the pagination cursor, so a mutated subject must fail the session (the
 * requester restarts with a fresh plan) rather than silently skip, duplicate,
 * or tear rows; a seal/head subject is always read atomically within one chunk
 * query, so its row-group can never be torn by a chunk boundary.
 *
 *  1. PER-SUBJECT row count vs the plan. An aggregate count would pass when
 *     two subjects in one window mutate by compensating amounts, and the
 *     prefix-sum slice would then duplicate or skip rows at the page seam.
 *  2. Content digest, bound on the subject's first window read of this
 *     session and verified on every reread. Counts alone pass on a same-count
 *     replacement, and a reread sliced at the stale prefix sums could combine
 *     rows of two versions of one subject across response pages. A subject
 *     that is never reread needs no digest: its group is served whole from a
 *     single query, so a same-count change before its only read serves the
 *     NEWER coherent group (bounded freshness skew, like any keyset pager),
 *     never a hybrid.
 *
 * `digestBindings` is the plan's session sidecar (see
 * {@link sessionDigestBindingsFor}); this reader is the only writer to it, and
 * the plan itself is never mutated.
 */
async function readFreshSwmMetaSubjectWindowRows(
  store: TripleStore,
  graph: string,
  subjects: readonly FreshSwmMetaSubjectEntry[],
  digestBindings: Map<string, string>,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const rows: SyncRow[] = [];
  for (const chunk of chunkValues(subjects, FRESH_SWM_META_PLAN_SUBJECT_CHUNK)) {
    const res = await store.query(`
      SELECT ?s ?p ?o WHERE {
        VALUES ?s { ${subjectValues(chunk.map((entry) => entry.subject))} }
        GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
      }
    `, {
      ...syncResponderStoreOptions(signal, 'sync.responder.readFreshSwmMetaSubjectRows'),
      maxResponseBytes: snapshotResponseByteLimit(
        SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
      ),
    });
    const rowsBySubject = new Map<string, SyncRow[]>();
    if (res.type === 'bindings') {
      for (const row of res.bindings) {
        const s = row['s'];
        const p = row['p'];
        const o = row['o'];
        if (!s || !p || !o) continue;
        const bucket = rowsBySubject.get(s) ?? [];
        bucket.push({ s, p, o, g: graph });
        rowsBySubject.set(s, bucket);
      }
    }
    for (const entry of chunk) {
      const subjectRows = (rowsBySubject.get(entry.subject) ?? []).sort(compareRows);
      if (subjectRows.length !== entry.rowCount) {
        throw new Error(
          `Shared-memory meta sync plan changed while reading ${graph}: ` +
          `expected ${entry.rowCount} rows for subject ${entry.subject}, found ${subjectRows.length}`,
        );
      }
      const digest = digestSubjectRows(subjectRows);
      const digestKey = `${graph}\u0000${entry.subject}`;
      const boundDigest = digestBindings.get(digestKey);
      if (boundDigest === undefined) {
        digestBindings.set(digestKey, digest);
      } else if (boundDigest !== digest) {
        throw new Error(
          `Shared-memory meta sync plan changed while reading ${graph}: ` +
          `subject ${entry.subject} content changed within an active session`,
        );
      }
      for (const row of subjectRows) rows.push(row);
    }
  }
  return rows.sort(compareRows);
}

/**
 * Store-bounded page reader for an intrinsically-oversized TTL-filtered SWM
 * meta phase. Pages advance across the plan's prefix sums; each page reads
 * whole subjects (bounded by the page limit plus at most one subject's rows)
 * and slices precisely. A single SUBJECT larger than the HARD build cap
 * (SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS — deliberately the fixed constant,
 * not the test/operator-shrinkable session budget, so a shrunken budget forces
 * paged mode without refusing ordinary multi-row subjects) is the one
 * remaining bounded refusal: it cannot be served as a coherent row-group
 * within any budget, and unlike the graph-level cap it can only be a
 * pathological writer, never organic operation history.
 */
async function readFreshSwmMetaRowsPageFromPlan(
  store: TripleStore,
  plan: FreshSwmMetaPlan,
  offset: number,
  limit: number,
  budgetKey: string,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  let skip = Math.max(0, Math.floor(offset));
  let remaining = Math.max(0, Math.floor(limit));
  if (remaining === 0 || skip >= plan.totalRows) return [];
  const digestBindings = sessionDigestBindingsFor(plan);
  const rows: SyncRow[] = [];
  for (const entry of plan.entries) {
    if (skip >= entry.rowCount) {
      skip -= entry.rowCount;
      continue;
    }
    // Select the whole-subject window covering [skip, skip + remaining).
    const window: FreshSwmMetaSubjectEntry[] = [];
    let windowStart = 0;
    let windowRows = 0;
    let beforeWindow = 0;
    for (const subject of entry.subjects) {
      if (beforeWindow + subject.rowCount <= skip && window.length === 0) {
        beforeWindow += subject.rowCount;
        continue;
      }
      if (window.length === 0) windowStart = beforeWindow;
      if (subject.rowCount > SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS) {
        throw snapshotBudgetError({
          key: budgetKey,
          reason: 'snapshot_rows',
          rows: subject.rowCount,
          bytesEstimate: 0,
          limit: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
        });
      }
      window.push(subject);
      windowRows += subject.rowCount;
      if (windowStart + windowRows >= skip + remaining) break;
    }
    if (window.length === 0) {
      skip = 0;
      continue;
    }
    const windowRowsRead = await readFreshSwmMetaSubjectWindowRows(
      store,
      entry.graph,
      window,
      digestBindings,
      signal,
    );
    const page = windowRowsRead.slice(skip - windowStart, skip - windowStart + remaining);
    for (const row of page) rows.push(row);
    remaining -= page.length;
    if (remaining <= 0) break;
    skip = 0;
  }
  return rows;
}

/**
 * TTL-filtered bounded snapshot (#1847). The per-snapshot budget binds on the
 * plan's ADMITTED row total — what will actually be served — instead of the
 * raw graph size, so a 64,000-row `_meta` history with a small fresh subset
 * takes the ordinary memoized-snapshot path. The collected rows then pass
 * through {@link filterSwmMetaSnapshotRows}, the canonical in-process
 * admission filter, exactly as the raw-graph snapshot always has; the plan's
 * SPARQL discovery is a candidate superset of that filter for the canonical
 * typed-literal meta writes, so both stages agree in production.
 */
async function readBoundedFreshSwmMetaSnapshot(
  store: TripleStore,
  plan: FreshSwmMetaPlan,
  cutoffIso: string,
  cache: RowListCache,
): Promise<readonly SyncRow[]> {
  const limits = cache.memo.snapshotLoadLimits ?? {
    maxRows: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
    maxBytesEstimate: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
    pageRows: SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
  };
  if (plan.totalRows > limits.maxRows) {
    throw snapshotBudgetError({
      key: cache.key,
      reason: 'snapshot_rows',
      rows: plan.totalRows,
      bytesEstimate: 0,
      limit: limits.maxRows,
    });
  }
  const rows: SyncRow[] = [];
  let bytesEstimate = 0;
  const digestBindings = sessionDigestBindingsFor(plan);
  for (const entry of plan.entries) {
    let graphRows;
    try {
      graphRows = await readFreshSwmMetaSubjectWindowRows(
        store,
        entry.graph,
        entry.subjects,
        digestBindings,
      );
    } catch (error) {
      // The store's response byte cap firing during SNAPSHOT materialization is
      // a per-snapshot byte overflow in disguise: the admitted set is
      // intrinsically too large to hold at once, so it must degrade to the
      // plan-paged reader exactly like the in-process estimate crossing the
      // budget — not escape untyped and fail a syncable phase outright. The
      // plan-paged reader's own bounded window reads keep the store cap
      // un-translated there, so a genuinely oversized single page still
      // surfaces as a hard error rather than being masked.
      if (!(error instanceof StoreResponseTooLargeError)) throw error;
      throw snapshotBudgetError({
        key: cache.key,
        reason: 'snapshot_bytes',
        rows: rows.length,
        bytesEstimate: bytesEstimate + storeResponseActualBytes(error),
        limit: limits.maxBytesEstimate,
      });
    }
    for (const row of graphRows) {
      const nextBytes = bytesEstimate + estimateStringRowHeapBytes(row.s, row.p, row.o, row.g);
      if (nextBytes > limits.maxBytesEstimate) {
        throw snapshotBudgetError({
          key: cache.key,
          reason: 'snapshot_bytes',
          rows: rows.length + 1,
          bytesEstimate: nextBytes,
          limit: limits.maxBytesEstimate,
        });
      }
      rows.push(row);
      bytesEstimate = nextBytes;
    }
  }
  return filterSwmMetaSnapshotRows(rows, cutoffIso);
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

interface FreshSwmCandidateGraph {
  graph: string;
  metaGraph: string;
}

const FRESH_SWM_PLAN_QUERY_GRAPH_CHUNK = 100;

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

function parseSparqlInteger(value: string | undefined): number {
  const match = String(value ?? '').match(/-?\d+/);
  return match ? Math.max(0, Math.floor(Number(match[0]))) : 0;
}

/**
 * Build a tiny, stable pagination plan for an oversized TTL-filtered SWM phase.
 *
 * The old fallback put all candidate graphs behind one `FILTER EXISTS` join for
 * every page. Both Oxigraph and Blazegraph can legally choose a plan that scans
 * the complete literal-heavy graph family before probing the small metadata
 * graph; on a 1 GiB workspace that exceeded the 30s HTTP query timeout on every
 * page. This planner inverts the work with backend-neutral SPARQL 1.1:
 *
 *  1. Join each concrete graph to its fresh metadata roots by the root subject
 *     (an indexed lookup and a DKG workspace invariant: `rootEntity` names an
 *     entity present in the shared payload).
 *  2. Count the exact root closures per concrete graph without returning their
 *     large literal values.
 *  3. Cache only graph/root/count scalars for the responder session.
 *
 * Paging then touches one or two concrete graphs at a time with `VALUES ?root`,
 * preserving the exact root/skolem filter used by {@link readFreshSwmDataRows}
 * while avoiding a database-specific optimizer hint or graph-family scan.
 */
async function buildFreshSwmDataGraphPlan(
  store: TripleStore,
  dataGraphs: readonly string[],
  graphSet: ReadonlySet<string>,
  candidateGraphsFor: (graph: string) => string[],
  cutoffIso: string,
  signal?: AbortSignal,
): Promise<FreshSwmDataGraphPlan> {
  const cutoffFilter =
    `FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)`;
  const candidates: FreshSwmCandidateGraph[] = [];
  for (const graph of dataGraphs) {
    const metaGraph = `${graph}_meta`;
    if (!graphSet.has(metaGraph)) continue;
    for (const candidate of candidateGraphsFor(graph)) {
      candidates.push({ graph: candidate, metaGraph });
    }
  }
  const uniqueCandidates = [...new Map(
    candidates.map((candidate) => [candidate.graph, candidate]),
  ).values()].sort((a, b) => compareCodePoint(a.graph, b.graph));
  if (uniqueCandidates.length === 0) return { entries: [], totalRows: 0 };

  const rootsByGraph = new Map<string, Set<string>>();
  for (const chunk of chunkValues(uniqueCandidates, FRESH_SWM_PLAN_QUERY_GRAPH_CHUNK)) {
    const unions = chunk.map(({ graph, metaGraph }) => `
      {
        SELECT (<${assertSafeIri(graph)}> AS ?g) ?root WHERE {
          GRAPH <${assertSafeIri(metaGraph)}> {
            ?op <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
                <${DKG_PUBLISHED_AT}> ?ts ;
                <${DKG_ROOT_ENTITY}> ?root .
            ${cutoffFilter}
          }
          GRAPH <${assertSafeIri(graph)}> { ?root ?rootPredicate ?rootObject }
        }
      }`);
    const rootResult = await store.query(`
      SELECT DISTINCT ?g ?root WHERE {
        ${unions.join('\n        UNION')}
      }
      ORDER BY ?g ?root
    `, syncResponderStoreOptions(signal, 'sync.responder.planFreshSwmGraphRoots'));
    if (rootResult.type !== 'bindings') continue;
    for (const row of rootResult.bindings) {
      const graph = row['g'];
      const root = row['root'];
      if (!graph || !root) continue;
      const roots = rootsByGraph.get(graph) ?? new Set<string>();
      roots.add(root);
      rootsByGraph.set(graph, roots);
    }
  }

  const countsByGraph = new Map<string, number>();
  const admitted = [...rootsByGraph.entries()]
    .map(([graph, roots]) => ({ graph, roots: [...roots].sort(compareCodePoint) }))
    .sort((a, b) => compareCodePoint(a.graph, b.graph));
  for (const chunk of chunkValues(admitted, FRESH_SWM_PLAN_QUERY_GRAPH_CHUNK)) {
    const unions = chunk.map(({ graph, roots }) => `
      {
        SELECT (<${assertSafeIri(graph)}> AS ?g) (COUNT(*) AS ?count) WHERE {
          {
            SELECT DISTINCT ?s ?p ?o WHERE {
              VALUES ?root { ${graphValues(roots)} }
              GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
              FILTER(?s = ?root || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/")))
            }
          }
        }
      }`);
    const countResult = await store.query(`
      SELECT ?g ?count WHERE {
        ${unions.join('\n        UNION')}
      }
      ORDER BY ?g
    `, syncResponderStoreOptions(signal, 'sync.responder.countFreshSwmGraphRows'));
    if (countResult.type !== 'bindings') continue;
    for (const row of countResult.bindings) {
      const graph = row['g'];
      if (graph) countsByGraph.set(graph, parseSparqlInteger(row['count']));
    }
  }

  const entries = admitted
    .map(({ graph, roots }) => ({ graph, roots, rowCount: countsByGraph.get(graph) ?? 0 }))
    .filter((entry) => entry.rowCount > 0);
  return {
    entries,
    totalRows: entries.reduce((sum, entry) => sum + entry.rowCount, 0),
  };
}

async function readFreshSwmDataRowsPageFromPlan(
  store: TripleStore,
  plan: FreshSwmDataGraphPlan,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  let skip = Math.max(0, Math.floor(offset));
  let remaining = Math.max(0, Math.floor(limit));
  if (remaining === 0 || skip >= plan.totalRows) return [];
  const rows: SyncRow[] = [];
  for (const entry of plan.entries) {
    if (skip >= entry.rowCount) {
      skip -= entry.rowCount;
      continue;
    }
    const result = await store.query(`
      SELECT DISTINCT ?s ?p ?o WHERE {
        VALUES ?root { ${graphValues(entry.roots)} }
        GRAPH <${assertSafeIri(entry.graph)}> { ?s ?p ?o }
        FILTER(?s = ?root || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/")))
      }
      ORDER BY ?s ?p ?o
      OFFSET ${skip}
      LIMIT ${remaining}
    `, syncResponderStoreOptions(signal, 'sync.responder.readFreshSwmDataRowsPage'));
    let added = 0;
    if (result.type === 'bindings') {
      for (const row of result.bindings) {
        const s = row['s'];
        const p = row['p'];
        const o = row['o'];
        if (s && p && o) {
          rows.push({ s, p, o, g: entry.graph });
          added += 1;
        }
      }
    }
    remaining -= added;
    if (remaining <= 0) break;
    skip = 0;
  }
  return rows;
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
  window?:
    | { kind: 'page'; offset: number; limit: number }
    | { kind: 'snapshot'; limit: number },
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
  const pagination = window?.kind === 'page'
    ? `\n    ORDER BY ?g ?s ?p ?o\n    OFFSET ${Math.max(0, Math.floor(window.offset))}` +
      `\n    LIMIT ${Math.max(0, Math.floor(window.limit))}`
    : window?.kind === 'snapshot'
      ? `\n    LIMIT ${Math.max(0, Math.floor(window.limit))}`
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
        || EXISTS {
             GRAPH ?g {
               ?s <${DKG_CONTENT_SCOPE_VERSION}> ?scopeVersion ;
                  <${DKG_STATUS}> ${sparqlString('confirmed')} .
             }
             FILTER(STR(?scopeVersion) = ${sparqlString(String(GRAPH_KA_CONTENT_SCOPE_VERSION))})
             FILTER(REGEX(STR(?s), "^did:dkg:[^/]+/0x[0-9A-Fa-f]{40}/[0-9]+$"))
           }
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
    ${pagination}
  `;
}

async function queryDurableMetaRows(
  store: TripleStore,
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  window:
    | { kind: 'page'; offset: number; limit: number }
    | { kind: 'snapshot'; limit: number; maxResponseBytes: number }
    | undefined,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  if (window && Math.max(0, Math.floor(window.limit)) === 0) return [];
  const res = await store.query(
    buildDurableMetaRowsQuery(contextGraphId, registeredSubGraphNames, window),
    {
      ...syncResponderStoreOptions(
        signal,
        window?.kind === 'page'
          ? 'sync.responder.readDurableMetaRowsPage'
          : 'sync.responder.readDurableMetaRowsSnapshot',
      ),
      ...(window?.kind === 'snapshot' ? { maxResponseBytes: window.maxResponseBytes } : {}),
    },
  );
  if (res.type !== 'bindings') return [];
  const rows = res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: row['g'] }))
    .filter((row) => row.s && row.p && row.o && row.g);
  return window?.kind === 'page' ? rows : rows.sort(compareRows);
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

async function readBoundedDurableMetaSnapshot(
  store: TripleStore,
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  cache: RowListCache,
): Promise<readonly SyncRow[]> {
  const limits = cache.memo.snapshotLoadLimits ?? {
    maxRows: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
    maxBytesEstimate: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
    pageRows: SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
  };
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  let rawRows: SyncRow[];
  try {
    const result = await store.query(`
      SELECT ?s ?p ?o WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> { ?s ?p ?o }
      }
      LIMIT ${limits.maxRows + 1}
    `, {
      ...syncResponderStoreOptions(undefined, 'sync.responder.readDurableMetaGraphSnapshot'),
      maxResponseBytes: snapshotResponseByteLimit(limits.maxBytesEstimate),
    });
    rawRows = result.type === 'bindings'
      ? result.bindings
        .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: metaGraph }))
        .filter((row): row is SyncRow => Boolean(row.s && row.p && row.o))
      : [];
  } catch (error) {
    if (!(error instanceof StoreResponseTooLargeError)) throw error;
    const actualBytes = typeof error.actualBytes === 'bigint'
      ? Number(error.actualBytes > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : error.actualBytes)
      : error.actualBytes;
    throw snapshotBudgetError({
      key: cache.key,
      reason: 'snapshot_bytes',
      rows: 0,
      bytesEstimate: actualBytes,
      limit: limits.maxBytesEstimate,
    });
  }
  if (rawRows.length > limits.maxRows) {
    throw snapshotBudgetError({
      key: cache.key,
      reason: 'snapshot_rows',
      rows: rawRows.length,
      bytesEstimate: 0,
      limit: limits.maxRows,
    });
  }
  let bytesEstimate = 0;
  for (const row of rawRows) {
    bytesEstimate += estimateStringRowHeapBytes(row.s, row.p, row.o, row.g);
    if (bytesEstimate > limits.maxBytesEstimate) {
      throw snapshotBudgetError({
        key: cache.key,
        reason: 'snapshot_bytes',
        rows: rawRows.length,
        bytesEstimate,
        limit: limits.maxBytesEstimate,
      });
    }
  }
  return filterDurableMetaSnapshotRows(
    rawRows,
    contextGraphId,
    registeredSubGraphNames,
  );
}

/**
 * Canonical durable-meta admission over one already-bounded exact graph.
 *
 * This is deliberately the in-process twin of buildDurableMetaRowsQuery's
 * oversized fallback predicate. Executing the nested EXISTS expression in the
 * store caused both Oxigraph and Blazegraph planners to rescan/sort the same
 * metadata graph for every frame. Reading that one graph once and building
 * subject indexes is O(meta rows), backend-neutral, and retains the exact
 * privacy boundary. sync-responder-oversized-fallback.test.ts proves set
 * equivalence between this path and the SPARQL fallback across every branch.
 */
function filterDurableMetaSnapshotRows(
  rows: readonly SyncRow[],
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
): SyncRow[] {
  const cgEntity = contextGraphDataGraphUri(contextGraphId);
  const registeredSubjects = new Set(
    dedupeStrings(registeredSubGraphNames)
      .filter((name) => validateSubGraphName(name).valid)
      .map((name) => `${cgEntity}/${name}`),
  );
  const bySubject = new Map<string, SyncRow[]>();
  for (const row of rows) {
    const bucket = bySubject.get(row.s) ?? [];
    bucket.push(row);
    bySubject.set(row.s, bucket);
  }
  const objects = (subject: string, predicate: string): string[] =>
    (bySubject.get(subject) ?? [])
      .filter((row) => row.p === predicate)
      .map((row) => row.o);
  const lowerStringValues = (subject: string, predicates: readonly string[]): Set<string> =>
    new Set(predicates.flatMap((predicate) => objects(subject, predicate))
      .map((value) => stripLiteral(value).toLowerCase()));

  const nonWorkingSubjects = new Set<string>();
  for (const [subject] of bySubject) {
    if (objects(subject, DKG_MEMORY_LAYER).some(
      (layer) => stripLiteral(layer) !== MemoryLayer.WorkingMemory,
    )) nonWorkingSubjects.add(subject);
  }

  const admitted = new Set<string>([cgEntity, ...registeredSubjects]);
  for (const subject of nonWorkingSubjects) admitted.add(subject);

  // Rootless V2 descriptors live directly on the deterministic UAL and do not
  // carry the legacy lifecycle memoryLayer predicate. Admit confirmed V2
  // descriptor rows explicitly; tentative rows remain workspace-local. The
  // requester performs the complete descriptor, graph-URI, count and Merkle
  // validation, so a malformed confirmed marker is visible and fails closed
  // instead of silently falling through as harmless configuration metadata.
  for (const [subject] of bySubject) {
    if (!DETERMINISTIC_KA_UAL_SHAPE.test(subject)) continue;
    const versions = objects(subject, DKG_CONTENT_SCOPE_VERSION).map(stripLiteral);
    const statuses = objects(subject, DKG_STATUS).map(stripLiteral);
    if (
      versions.includes(String(GRAPH_KA_CONTENT_SCOPE_VERSION)) &&
      statuses.includes('confirmed')
    ) admitted.add(subject);
  }

  const members = lowerStringValues(cgEntity, [
    DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
    DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
  ]);
  const revoked = lowerStringValues(cgEntity, [DKG_ONTOLOGY.DKG_REVOKED_AGENT]);
  const delegationPrefix = `did:dkg:agent-delegation:${contextGraphId}:`;
  for (const [subject] of bySubject) {
    if (subject.startsWith('did:dkg:activity:')) admitted.add(subject);
    if (!subject.startsWith(delegationPrefix)) continue;
    const delegatedAgents = objects(subject, DKG_ONTOLOGY.DKG_DELEGATION_AGENT)
      .map((value) => stripLiteral(value).toLowerCase());
    if (delegatedAgents.some((agent) => members.has(agent) && !revoked.has(agent))) {
      admitted.add(subject);
    }
  }

  const assertionNames = new Set<string>();
  for (const lifecycle of nonWorkingSubjects) {
    for (const graph of objects(lifecycle, DKG_ASSERTION_GRAPH)) admitted.add(graph);
    for (const rawName of objects(lifecycle, DKG_ASSERTION_NAME)) {
      const name = stripLiteral(rawName);
      if (name) assertionNames.add(name);
    }
  }
  const assertionNamesByTail = new Map<string, string[]>();
  for (const name of assertionNames) {
    const tail = name.slice(name.lastIndexOf('/') + 1);
    const names = assertionNamesByTail.get(tail) ?? [];
    names.push(name);
    assertionNamesByTail.set(tail, names);
  }

  for (const [subject, subjectRows] of bySubject) {
    if (subjectRows.some((row) =>
      (row.p === PROV_GENERATED || row.p === PROV_USED) && nonWorkingSubjects.has(row.o),
    )) admitted.add(subject);
    if (subject.includes('/assertion/')) {
      const tail = subject.slice(subject.lastIndexOf('/') + 1);
      if ((assertionNamesByTail.get(tail) ?? []).some(
        (name) => subject.endsWith(`/${name}`),
      )) admitted.add(subject);
    }
  }

  return rows
    .filter((row) =>
      admitted.has(row.s) &&
      !(isIriTerm(row.s) && row.s.startsWith(DKG_JOIN_REQUEST_SUBJECT_PREFIX)),
    )
    .sort(compareRows);
}

function isIriTerm(term: string): boolean {
  return !term.startsWith('_:') && !term.startsWith('"');
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
    { kind: 'page', offset: safeOffset, limit: safeLimit },
    signal,
  );
}

/**
 * Subject-atomic wrapper over {@link readDurableMetaRowsPage} for the
 * store-paged durable-meta lane (the no-session path and the oversized-snapshot
 * fallback). Guarantees the returned page ENDS on a `(g, s)` subject boundary:
 * a subject straddling `limit` is emitted in full, so a graph-scoped seal's
 * rows (incl. `dkg:assertionVersion`) are never split across a page — and
 * therefore never across a sync round (#1788). This mirrors the cached path's
 * in-memory extend for the non-snapshot lane, and holds for ANY admitted
 * subject term, not only IRIs.
 *
 * The trailing subject is completed by RE-READING a GROWING window from the
 * same offset (`limit + extra`, `extra` doubling) until that subject is fully
 * contained — a later subject appears in the window, or the store is exhausted
 * — then cutting at the subject boundary. Each attempt is a SINGLE ordered
 * query, which is what makes this correct for a blank-node subject: Oxigraph
 * relabels a blank node per query (observed `_:x` → `_:<hash>`), so a
 * subject-bound re-read or a multi-query paged loop could not re-identify one,
 * but within a single self-contained window its label — and therefore the
 * `(g, s)` boundary comparison — is consistent. Conforming writers only emit
 * IRI `_meta` subjects (metadata generators build deterministic IRIs; the
 * publisher rejects blank nodes), but a blank-node subject is reachable via the
 * unverified system-CG peer-ingest path, so subject atomicity must cover it too;
 * enforcing the IRI invariant at ingest (defense-in-depth) is tracked
 * separately.
 *
 * `_meta` subjects are small (a seal is 14 quads ≈ a few KB), so this converges
 * in about one read. The returned page is BOTH subject-atomic AND ≤
 * `maxResponseBytes` via {@link subjectAtomicBudgetEnd}: whole subjects are
 * accumulated up to the budget and a subject that would not fit is deferred whole
 * to the next page — so a small seal that sits AFTER large-literal rows is never
 * cut by the byte cap (the #1916 hole). Only a FIRST subject that alone exceeds
 * the budget is emitted and split by the serializer (provably not a valid seal at
 * that size; safe and forward-progressing). The window grows only while its
 * trailing subject is still incomplete AND the budget has not been reached, so
 * memory stays bounded (~one budget) and the loop terminates at EOF. When
 * `oversizedPolicy` is `'fail-loud'` (a non-negotiated legacy requester) the
 * page is NOT byte-fit — an oversized or cumulative-over-budget page throws
 * {@link DurableMetaPageFrameError} instead (see {@link MetaOversizedSubjectPolicy}).
 */
async function readDurableMetaRowsPageSubjectAtomic(
  store: TripleStore,
  contextGraphId: string,
  registeredSubGraphNames: readonly string[],
  offset: number,
  limit: number,
  maxResponseBytes: number,
  oversizedPolicy: MetaOversizedSubjectPolicy,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const safeMaxBytes = Math.max(1, Math.floor(maxResponseBytes));
  let extra = 1;
  // Bounded by construction: `extra` at least doubles each attempt and the store
  // is finite, so a short (exhausted) window always terminates the loop; the
  // iteration cap is a defensive ceiling a real `_meta` graph never nears.
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const window = await readDurableMetaRowsPage(
      store,
      contextGraphId,
      registeredSubGraphNames,
      safeOffset,
      safeLimit + extra,
      signal,
    );
    const windowExhausted = window.length < safeLimit + extra;
    const end = subjectAtomicBudgetEnd(window, 0, safeMaxBytes, safeLimit, windowExhausted, oversizedPolicy, contextGraphId);
    // -1 ⇒ the first subject is still incomplete and fits so far: fetch more to
    // decide whether it completes within budget or is oversized. Otherwise `end`
    // is the subject-atomic, byte-fitting boundary.
    if (end !== -1) return window.slice(0, end);
    extra = extra === 1 ? safeLimit + 1 : extra * 2;
  }
  throw new Error(
    `durable-meta subject-atomic paging did not converge for "${contextGraphId}" at offset ${safeOffset} `
    + '(first subject exceeded the bounded window budget)',
  );
}

/**
 * Serve only the immutable V2 descriptors for an explicitly requested KA set.
 * The caller intersects the request with the confirmed manifest first, so this
 * query cannot expose tentative workspace descriptors. The protocol caps the
 * VALUES list at ten UALs, so read that bounded descriptor set once, sort it,
 * and take the requested page in memory instead of OFFSET-scanning `_meta`.
 */
async function readExactDurableMetaRowsPage(
  store: TripleStore,
  contextGraphId: string,
  assetUals: readonly string[],
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0 || assetUals.length === 0) return [];
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const values = assetUals.map((ual) => `<${assertSafeIri(ual)}>`).join(' ');
  // sparql-scan-allow: R4 -- ?s is bound to at most ten exact, confirmed KA UALs by the protocol filter
  const result = await store.query(`
    SELECT ?s ?p ?o WHERE {
      VALUES ?s { ${values} }
      GRAPH <${assertSafeIri(metaGraph)}> { ?s ?p ?o }
    }
  `, syncResponderStoreOptions(signal, 'sync.responder.readExactDurableMetaRowsPage'));
  if (result.type !== 'bindings') return [];
  return result.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: metaGraph }))
    .filter((row): row is SyncRow => Boolean(row.s && row.p && row.o))
    .sort(compareRows)
    .slice(safeOffset, safeOffset + safeLimit);
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
  // sparql-scan-allow: R2 -- ?g is bound by a finite VALUES list of pre-admitted exact graph IRIs
  return `
      VALUES ?g { ${graphValuesClause} }
      GRAPH ?g { ?s ?p ?o }
      OPTIONAL {
        {
          SELECT ?deltaRoot ?deltaGraph ?deltaBid WHERE {
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
              UNION
              {
                ?deltaKa <${DKG_ASSERTION_GRAPH}> ?deltaGraph ;
                         <${DKG_BATCH_ID}> ?deltaBid .
              }
              FILTER(REGEX(STR(?deltaBid), "^-?\\\\d+$"))
            }
          }
        }
        FILTER(
          IF(
            BOUND(?deltaGraph),
            sameTerm(?g, ?deltaGraph),
            sameTerm(?s, ?deltaRoot) || STRSTARTS(STR(?s), CONCAT(STR(?deltaRoot), "/.well-known/genid/"))
          )
        )
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

function durableDataRowListCacheKey(
  scope: string,
  contextGraphId: string,
  sinceBatchId: bigint | null,
  assetUals?: readonly string[],
): string {
  const selection = assetUals === undefined
    ? (sinceBatchId == null ? 'full' : `since:${sinceBatchId.toString()}`)
    : exactAssetFilterKey(assetUals);
  return `durable-data:${scope}:${contextGraphId}:${selection}`;
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
