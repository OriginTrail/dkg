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
  asGraphWriteRevisionSource,
  loadSortedGraphCatalog,
  StoreResponseTooLargeError,
  type QueryOptions,
  type TripleStore,
  type ChangelogReader,
  type ChangeOp,
  type GraphWriteRevision,
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
import type { SyncResponderSnapshotBudget } from './snapshot-budget.js';
import { estimateStringRowHeapBytes } from '../memory-telemetry.js';
import {
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
} from '../../dkg-agent-constants.js';
import type { ChangelogSyncResponse, ChangelogDeltaRecord } from '../changelog/wire.js';
import { durableMetaDelegationSubjectAdmissionExpression } from './durable-meta-admission.js';
import { isIriTerm } from '../iri-term.js';
import { compareCodePoint } from '@origintrail-official/dkg-core';
import { isLegacySyncGraphCandidateV1 } from '../legacy-sync-graph-candidate.js';
import {
  createGraphMembershipSnapshotFromSortedCatalog,
  type GraphMembershipSnapshot,
} from '../graph-membership-snapshot.js';
import {
  readExactDataSessionPage,
  durableDataRowListCacheKey,
  createStoreOnlyDataSession,
  type DurableDataPageParams,
  type ExactDataPageParams,
  type LegacyDurableDataPageParams,
} from './exact-data-session.js';
import { createSessionPlanMemo, createPageOnlySessionPlanMemo } from './session-plan-memo.js';
import type { ExactPageReadResult } from './exact-page-reader.js';
import {
  buildExactGraphPagePlan,
  readRowsPageFromExactGraphPlan,
  readExactGraphPlanSnapshot,
  readGraphScopedVmManifest,
  snapshotResponseByteLimit,
  storeResponseActualBytes,
  snapshotBudgetError,
  type ExactGraphPagePlan,
  type ExactGraphPagePlanMemo,
  type GraphScopedVmManifest,
} from './exact-graph-reader.js';
import {
  createSessionPlanGetter,
  readResponderRowsPage,
  raceAgainstAbort,
  throwIfAborted,
  type RowListCache,
  type StorePageLoader,
} from './responder-row-page.js';
export type { ExactGraphPagePlanMemo } from './exact-graph-reader.js';
export { createResponderExactDataSessionMemo, createResponderPageOnlyExactDataSessionMemo } from './exact-data-session.js';
import {
  compareRows,
  metaSubjectKey,
  serializeResponderRows,
  serializedResponderRowByteLength,
} from './row-serialization.js';
export { compareRows, serializeResponderRows, serializeResponderRowsWithinByteBudget } from './row-serialization.js';

export {
  createResponderSyncRowListMemo,
  SyncRowSnapshotLimitError,
  type SyncRow,
  type SyncRowListMemo,
} from './snapshot-cache.js';
export { compareCodePoint } from '../code-point-order.js';

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
const DKG_CONTEXT_GRAPH_ID = `${DKG}contextGraphId`;
const DKG_STATUS = `${DKG}status`;
const DETERMINISTIC_KA_UAL_SHAPE = /^did:dkg:[^/]+\/0x[0-9A-Fa-f]{40}\/[0-9]+$/;
const DKG_PART_OF = `${DKG}partOf`;
const DKG_BATCH_ID = `${DKG}batchId`;
const SCHEMA_NAME = 'http://schema.org/name';
const PROV_GENERATED = 'http://www.w3.org/ns/prov#generated';
const PROV_USED = 'http://www.w3.org/ns/prov#used';
const DKG_JOIN_REQUEST_SUBJECT_PREFIX = 'did:dkg:join-request:';
function syncResponderStoreOptions(signal: AbortSignal | undefined, source: string): QueryOptions {
  return { signal, priority: 'background', source };
}

export interface GraphListMemo {
  get(options?: {
    refresh?: boolean;
    refreshGeneration?: string;
    signal?: AbortSignal;
  }): Promise<GraphMembershipSnapshot>;
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
  /** Null selects a complete graph-scoped KA; otherwise select root closures. */
  roots: readonly string[] | null;
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


export function createResponderGraphListMemo(
  store: TripleStore,
  ttlMs = 10_000,
): GraphListMemo {
  const writeRevisionSource = asGraphWriteRevisionSource(store);
  type Revision = GraphWriteRevision | string | undefined;
  const currentRevision = (refreshGeneration: string | undefined): Revision =>
    writeRevisionSource?.getWriteRevision('') ?? refreshGeneration;
  const isWriteRevision = (revision: Revision): revision is GraphWriteRevision =>
    typeof revision === 'object' && revision !== null;
  const supersedesCompleted = (stored: Revision, current: Revision): boolean => {
    if (writeRevisionSource) {
      return !isWriteRevision(stored)
        || !isWriteRevision(current)
        || !stored.stable
        || !current.stable
        || stored.generation !== current.generation;
    }
    // A deep-page read without a session generation joins/uses the current
    // snapshot; only an explicitly newer responder session supersedes it.
    return current !== undefined && stored !== current;
  };
  const supersedesInflight = (stored: Revision, current: Revision): boolean => {
    if (writeRevisionSource) {
      return !isWriteRevision(stored)
        || !isWriteRevision(current)
        || stored.generation !== current.generation;
    }
    return current !== undefined && stored !== current;
  };
  let lastSnapshot: GraphMembershipSnapshot | null = null;
  let cached: {
    value: GraphMembershipSnapshot;
    cachedAt: number;
    revision: Revision;
  } | null = null;
  let inflight: {
    promise: Promise<GraphMembershipSnapshot>;
    revision: Revision;
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
        const revision = currentRevision(options?.refreshGeneration);
        // Stability controls completed-cache reuse, not single-flight
        // identity. Concurrent reads at the same unstable generation share
        // one enumeration; the result is simply discarded for later callers.
        if (!supersedesInflight(pending.revision, revision)) {
          return raceAgainstAbort(pending.promise, options?.signal);
        }
        try {
          await raceAgainstAbort(pending.promise, options?.signal);
        } catch {
          throwIfAborted(options?.signal);
        }
      }
      const now = Date.now();
      const revision = currentRevision(options?.refreshGeneration);
      if (cached && supersedesCompleted(cached.revision, revision)) cached = null;
      if (
        cached &&
        now - cached.cachedAt < ttlMs &&
        (!options?.refresh || (writeRevisionSource !== null && isWriteRevision(revision) && revision.stable))
      ) return cached.value;
      // This load is shared by concurrent responders. Do not bind it to the
      // first stream's abort signal; waiters race their own abort locally via
      // raceAgainstAbort/throwIfAborted below.
      const graphOptions = syncResponderStoreOptions(undefined, 'sync.responder.listGraphs');
      const load = loadSortedGraphCatalog(store, graphOptions)
        .then((graphs) => {
          // Content writes advance the store revision even when named-graph
          // membership is unchanged. Reuse the immutable index in that case:
          // enumeration stays freshness-safe, while sorting, Set construction,
          // and every downstream membership index remain stable.
          const snapshot = (
            lastSnapshot?.graphs === graphs || lastSnapshot?.matches(graphs)
          )
            ? lastSnapshot
            : createGraphMembershipSnapshotFromSortedCatalog(graphs);
          lastSnapshot = snapshot;
          cached = {
            value: snapshot,
            cachedAt: Date.now(),
            revision,
          };
          return snapshot;
        })
        .finally(() => {
          if (inflight?.promise === load) inflight = null;
        });
      inflight = {
        promise: load,
        revision,
      };
      const snapshot = await load;
      throwIfAborted(options?.signal);
      return snapshot;
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

/**
 * Exact byte-budget sessions retain only bounded graph/count scalars and
 * keyset cursors. Reserve the cursor ceiling up front so later pages cannot
 * grow uncharged state outside the process-wide responder budget.
 */
export function createResponderPageOnlyExactGraphPlanMemo(
  ttlMs: number,
  maxEntries: number,
  budget: SyncResponderSnapshotBudget,
): ExactGraphPagePlanMemo {
  return createPageOnlySessionPlanMemo(ttlMs, maxEntries, budget, plan => plan);
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
 * reachable via unverified peer-ingest. Closing that SIZE vector at the root is
 * tracked by #1923 (SyncPagePolicy) — it is orthogonal to #1921's IRI-only
 * ingest guard, since a peer can inject a valid-IRI subject bearing a giant
 * literal.
 *
 * Contract: this is a HARD, NON-RETRYABLE failure. The sync responder surfaces it
 * as `outcome:'error'` and re-throws it (it is deliberately NOT wrapped in a
 * retryable error, and NEVER converted to an empty — EOF — body), because a retry
 * cannot make an oversized subject servable to a legacy requester; the only
 * resolutions are a requester upgrade or the #1923 ingest fix. The budget it is
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
      + `oversized _meta subject at ingest (#1923).`,
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

export async function readSwmMetaPage(params: {
  store: TripleStore;
  graphMembership: GraphMembershipSnapshot;
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
  releaseCacheOnShortPage?: boolean;
  freshMetaPlanMemo?: FreshSwmMetaPlanMemo;
}): Promise<SyncRow[]> {
  const graphs = swmGraphsForRegisteredSubGraphs(params.contextGraphId, params.registeredSubGraphNames, true);
  const candidateGraphs = graphs.filter((graph) => params.graphMembership.has(graph));
  const cache = params.rowListMemo && params.rowListCacheKey
    ? {
      memo: params.rowListMemo,
      key: params.rowListCacheKey,
      refresh: params.refreshRowList,
      refreshGeneration: params.refreshGeneration,
      releaseOnShortPage: params.releaseCacheOnShortPage,
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
      // Intrinsic snapshot-size refusals always degrade to the bounded
      // plan-paged reader above, never to the deleted global-sort query (#1847).
    },
  );
}

export async function readSwmDataPage(params: {
  store: TripleStore;
  graphMembership: GraphMembershipSnapshot;
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
  releaseCacheOnShortPage?: boolean;
  freshGraphPlanMemo?: FreshSwmDataGraphPlanMemo;
  exactGraphPlanMemo?: ExactGraphPagePlanMemo;
}): Promise<SyncRow[]> {
  const dataGraphs = swmGraphsForRegisteredSubGraphs(params.contextGraphId, params.registeredSubGraphNames, false);
  const candidateGraphsFor = (graph: string) => params.graphMembership.equalOrUnder(
    graph,
    (candidate) => candidate === graph || isSharedMemoryBucketDescendantDataGraph(candidate, graph),
  );
  const cache = params.rowListMemo && params.rowListCacheKey
    ? {
      memo: params.rowListMemo,
      key: params.rowListCacheKey,
      refresh: params.refreshRowList,
      refreshGeneration: params.refreshGeneration,
      releaseOnShortPage: params.releaseCacheOnShortPage,
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
      params.graphMembership,
      params.cutoffIso!,
      params.contextGraphId,
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
      params.assetUals,
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
    return isLegacySyncGraphCandidateV1(
      graph,
      contextGraphId,
      opts.includeTopMeta ? 'changelog' : 'durable-data',
    );
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

  // (5) The page may reach past the head captured in (1): this node's own
  // writes landed meanwhile, or readChanges adopted markers another writer
  // appended above this instance's counter. The wire requires `headSeq` to
  // cover every emitted record, so it comes from the head AFTER the read. An
  // era that rotated underneath the read is a restore in progress: hand the
  // requester a resync rather than records from two eras.
  const headAfter = await params.reader.changelogHead(
    syncResponderStoreOptions(params.signal, 'sync.responder.changelogHead'),
  );
  if (headAfter.era !== head.era) {
    return { kind: 'resync', era: headAfter.era, headSeq: headAfter.seq };
  }

  // (6) nextSeq: on a budget-truncated page, the last emitted record's seq;
  // else the scanned-through high-water. A full window stops at the last raw
  // seq (more remains beyond it). A drained scan read everything up to at
  // least the head captured in (1) — readChanges skips holes and stops only at
  // the head — so it advances to the higher of that head and the last raw seq.
  // Never the head AFTER the read: a marker committed while this page was
  // serialized was not scanned, and counting it would make the requester skip
  // it for good.
  const lastRawSeq = raw.length > 0 ? raw[raw.length - 1].seq : head.seq;
  const drained = raw.length < params.limit;
  const nextSeq = budgetStopped
    ? records[records.length - 1].seq
    : drained ? Math.max(lastRawSeq, head.seq) : lastRawSeq;

  return { kind: 'delta', era: headAfter.era, headSeq: headAfter.seq, nextSeq, records };
}

/** Compatibility dispatcher; selected exact DATA owns its reader and fences separately. */
export async function readDurableDataPageWithLease(params: DurableDataPageParams): Promise<ExactPageReadResult> {
  return params.assetUals !== undefined ? readExactDataSessionPage(params) : { rows: await readDurableDataPage(params) };
}

/** Ordinary row callers use the conservative reader without acquiring a response lease. */
export async function readDurableDataPage(params: Omit<ExactDataPageParams, 'exactAssetExportCache'> | Omit<LegacyDurableDataPageParams, 'exactAssetExportCache'>): Promise<SyncRow[]> {
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
    return (await readExactDataSessionPage({ ...params, exactAssetExportCache: undefined })).rows;
  }

  const sessionMemo = params.exactDataSessionMemo;
  const planMemo: ExactGraphPagePlanMemo | undefined = sessionMemo
    ? { async get(key, load, options) {
      const session = await sessionMemo.get(key, async () => createStoreOnlyDataSession(
        params.store, await load(), cache?.memo.snapshotLoadLimits ?? {
          maxRows: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
          maxBytesEstimate: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
        },
      ), options);
      return session?.graphPlan ?? null;
    } }
    : params.exactGraphPlanMemo;

  if (params.sinceBatchId == null) {
    return readPagedRowsFromExactGraphPlanLoader(
      params.store,
      params.offset,
      params.limit,
      cache,
      params.signal,
      planMemo,
      async (planSignal) => {
        const manifest = await readGraphScopedVmManifest(
          params.store,
          params.contextGraphId,
          planSignal,
        );
        const { cgPrefix, isCandidateGraph, isAdmitted } = createAdmissionContext(
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
          ? params.graphMembership.equalOrUnder(cgPrefix, isCandidateGraph)
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
          params.exactGraphReadMode,
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
    ...params.graphMembership.equalOrUnder(cgPrefix, isCandidateGraph),
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
    const rows = await readRowsPageFromExactGraphPlan(store, plan, pageOffset, pageLimit, rowSnapshotLimits, pageSignal);
    throwIfAborted(pageSignal);
    return rows;
  };
  return readResponderRowsPage(
    cache && { ...cache, expiredMessage: cache.expiredMessage ?? 'Durable data sync session snapshot expired before page completion' },
    loadPage, offset, limit, signal,
    cache ? { loadSnapshot: async () => readExactGraphPlanSnapshot(store, await getPlan(0, undefined), cache, rowSnapshotLimits) } : undefined,
  );
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
 * Ceiling for one subject row-group in the fresh-SWM plan lane. Whole-subject
 * windows are its consistency unit (#1788), so an oversized subject cannot be
 * served atomically and receives a bounded refusal. This limit is intentionally
 * independent of snapshot materialization limits.
 */
export const FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS = 64_000;

/**
 * Retained-heap ceiling for fresh-SWM plan scalars (subject IRIs + row counts).
 * A plan is control-plane state and must remain much smaller than the rows it
 * describes, independently of snapshot materialization limits.
 */
export const FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE = 32 * 1024 * 1024;

function freshSwmMetaPlanResponseByteLimit(): number {
  return snapshotResponseByteLimit(FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE);
}

/**
 * Hard cardinality cap for a TTL meta session plan's admitted subjects, across
 * all candidate graphs of the phase. The discovery queries are LIMIT-bounded to
 * this cap (plus one sentinel row), so plan construction can never materialize
 * an unbounded subject set no matter how large the fresh window is: a fresh set
 * beyond the cap is a typed bounded refusal, never an unbounded control-plane
 * plan. Sizing: every admitted subject serves at least one row, so this cap
 * alone admits sessions far past the point where they run plan-paged. The
 * 64,000-subject ceiling covers the 33k-41k subjects observed on mainnet while
 * the independent 32 MiB plan estimate still bounds pathological IRI lengths.
 */
export const FRESH_SWM_META_PLAN_MAX_SUBJECTS = 64_000;

/**
 * Discover the TTL-admitted subjects of one SWM meta graph with two
 * small-result queries (no payload rows, no sort, no OFFSET), each bounded by
 * construction: LIMIT (remaining subject allowance + 1 sentinel) and the fixed
 * plan response byte cap. Crossing either bound is a typed
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
        maxResponseBytes: freshSwmMetaPlanResponseByteLimit(),
      });
    } catch (error) {
      if (!(error instanceof StoreResponseTooLargeError)) throw error;
      throw snapshotBudgetError({
        key: budgetKey,
        reason: 'snapshot_bytes',
        rows: subjects.size,
        bytesEstimate: storeResponseActualBytes(error),
        limit: FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE,
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
        maxResponseBytes: freshSwmMetaPlanResponseByteLimit(),
      });
    } catch (error) {
      if (!(error instanceof StoreResponseTooLargeError)) throw error;
      throw snapshotBudgetError({
        key: budgetKey,
        reason: 'snapshot_bytes',
        rows: chunk.length,
        bytesEstimate: storeResponseActualBytes(error),
        limit: FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE,
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

function assertFreshSwmMetaSubjectWindowRows(
  subject: FreshSwmMetaSubjectEntry,
  budgetKey: string,
): void {
  if (subject.rowCount <= FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS) return;
  throw snapshotBudgetError({
    key: budgetKey,
    reason: 'snapshot_rows',
    rows: subject.rowCount,
    bytesEstimate: 0,
    limit: FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS,
  });
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
 * discovery), and the retained scalar estimate and construction-query response
 * caps by the FIXED plan byte cap — deliberately the constant, not the
 * test/operator-shrinkable session budget, so shrinking the session budget
 * forces plan-paged mode without ever refusing the plan that paged mode needs
 * (#1847 class).
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
      // This is a plan invariant, not just a plan-paged reader guard: the
      // ordinary snapshot lane also consumes this plan and must refuse the
      // same pathological row-group under default budgets.
      assertFreshSwmMetaSubjectWindowRows(entry, budgetKey);
      bytesEstimate += estimateStringRowHeapBytes(entry.subject, '', '', graph);
    }
    // Pinned to FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE: a plan holds scalars
    // (subject IRI + row count), so its ceiling is independent of how large a
    // materialized snapshot may be.
    if (bytesEstimate > FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE) {
      throw snapshotBudgetError({
        key: budgetKey,
        reason: 'snapshot_bytes',
        rows: subjects.length,
        bytesEstimate,
        limit: FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE,
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
      // Pinned to FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS, NOT the snapshot
      // build cap: this guards row-group atomicity (#1788), not materialization
      // size, so it must not drift when the snapshot caps move.
      assertFreshSwmMetaSubjectWindowRows(subject, budgetKey);
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
  graphMembership: GraphMembershipSnapshot,
  candidateGraphsFor: (graph: string) => string[],
  cutoffIso: string,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const rows: SyncRow[] = [];
  for (const graph of dataGraphs) {
    const metaGraph = `${graph}_meta`;
    if (!graphMembership.has(metaGraph)) continue;
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
 * Discover complete graph-scoped KA graphs selected by fresh V2 operation/head
 * pairs in one SWM metadata bucket. These graphs already belong to the normal
 * `_shared_memory/{address}/{number}` family; this only teaches the TTL planner
 * that V2 operations have no `rootEntity` and must be paged as exact graphs.
 */
async function readFreshGraphScopedSwmDataGraphs(params: {
  store: TripleStore;
  graphMembership: GraphMembershipSnapshot;
  contextGraphId: string;
  bucketGraph: string;
  metaGraph: string;
  cutoffIso: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const result = await params.store.query(`
    SELECT DISTINCT ?op ?head ?ual ?version ?shareId ?assertionGraph WHERE {
      GRAPH <${assertSafeIri(params.metaGraph)}> {
        ?op <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
            <${DKG_CONTENT_SCOPE_VERSION}> ?opScope ;
            <${DKG_CONTEXT_GRAPH_ID}> ?operationContextGraphId ;
            <${DKG_KA_UAL}> ?ual ;
            <${DKG_ASSERTION_VERSION}> ?version ;
            <${DKG_SHARE_OPERATION_ID}> ?shareId ;
            <${DKG_PUBLISHED_AT}> ?ts .
        ?head <${DKG_CONTENT_SCOPE_VERSION}> ?headScope ;
              <${DKG_KA_UAL}> ?ual ;
              <${DKG_ASSERTION_VERSION}> ?version ;
              <${DKG_SHARE_OPERATION_ID}> ?shareId ;
              <${DKG_ASSERTION_GRAPH}> ?assertionGraph .
        FILTER(STR(?opScope) = ${sparqlString(String(GRAPH_KA_CONTENT_SCOPE_VERSION))})
        FILTER(STR(?headScope) = ${sparqlString(String(GRAPH_KA_CONTENT_SCOPE_VERSION))})
        FILTER(STR(?operationContextGraphId) = ${sparqlString(params.contextGraphId)})
        FILTER(?ts >= ${sparqlString(params.cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
    }
  `, syncResponderStoreOptions(params.signal, 'sync.responder.readFreshGraphScopedSwmDataGraphs'));
  if (result.type !== 'bindings') return [];

  const rootBucket = `${contextGraphDataGraphUri(params.contextGraphId)}/_shared_memory`;
  let subGraphName: string | undefined;
  if (params.bucketGraph !== rootBucket) {
    const prefix = `${contextGraphDataGraphUri(params.contextGraphId)}/`;
    const suffix = '/_shared_memory';
    if (!params.bucketGraph.startsWith(prefix) || !params.bucketGraph.endsWith(suffix)) return [];
    subGraphName = params.bucketGraph.slice(prefix.length, -suffix.length);
    if (!validateSubGraphName(subGraphName).valid) return [];
  }

  const graphs = new Set<string>();
  for (const row of result.bindings) {
    const ual = row['ual'];
    const assertionVersion = stripLiteral(row['version'] ?? '').trim();
    const shareOperationId = stripLiteral(row['shareId'] ?? '').trim();
    const assertionGraph = row['assertionGraph'];
    if (!ual || !assertionVersion || !shareOperationId || !assertionGraph) continue;
    if (row['op'] !== `urn:dkg:share:${params.contextGraphId}:${shareOperationId}`) continue;
    if (row['head'] !== `${ual}#dkg-swm-head`) continue;
    let expectedGraph: string;
    try {
      expectedGraph = knowledgeAssetLayerGraphUri(
        params.contextGraphId,
        MemoryLayer.SharedWorkingMemory,
        createGraphKnowledgeAssetScope(ual, assertionVersion),
        subGraphName,
      );
    } catch {
      continue;
    }
    if (
      assertionGraph !== expectedGraph
      || !params.graphMembership.has(expectedGraph)
      || !isSharedMemoryBucketDescendantDataGraph(expectedGraph, params.bucketGraph)
    ) continue;
    graphs.add(expectedGraph);
  }
  return [...graphs].sort(compareCodePoint);
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
 *  1. Discover fresh metadata roots ONCE per SWM bucket, then locate those few
 *     roots through an indexed subject lookup across the bucket graph family.
 *  2. Count the exact root closures per concrete graph without returning their
 *     large literal values.
 *  3. Cache only graph/root/count scalars for the responder session.
 *
 * The discovery/lookup split is important on long-lived context graphs. The
 * previous planner emitted one UNION branch per historical data graph, and
 * every branch repeated the same fresh-metadata join. A bucket with no fresh
 * legacy roots could therefore spend its complete deadline proving the same
 * empty result tens of thousands of times. Work here is proportional to the
 * fresh root set instead of the historical graph count. Paging then touches
 * one or two concrete graphs at a time with `VALUES ?root`, preserving the
 * exact root/skolem filter used by {@link readFreshSwmDataRows}.
 */
async function buildFreshSwmDataGraphPlan(
  store: TripleStore,
  dataGraphs: readonly string[],
  graphMembership: GraphMembershipSnapshot,
  cutoffIso: string,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<FreshSwmDataGraphPlan> {
  const rootsByGraph = new Map<string, Set<string>>();
  const exactGraphs = new Set<string>();
  for (const bucketGraph of dedupeStrings(dataGraphs).sort(compareCodePoint)) {
    throwIfAborted(signal);
    const metaGraph = `${bucketGraph}_meta`;
    if (!graphMembership.has(metaGraph)) continue;
    const roots = [...await readFreshSwmRoots(store, metaGraph, cutoffIso, signal)]
      .sort(compareCodePoint);
    for (const graph of await readFreshGraphScopedSwmDataGraphs({
      store,
      graphMembership,
      contextGraphId,
      bucketGraph,
      metaGraph,
      cutoffIso,
      signal,
    })) exactGraphs.add(graph);
    for (const chunk of chunkValues(roots, FRESH_SWM_PLAN_QUERY_GRAPH_CHUNK)) {
      const chunkSet = new Set(chunk);
      // sparql-scan-allow: R2 -- ?root is VALUES-bound to at most 100 fresh metadata roots and every result graph is admitted against the finite current graph snapshot
      const rootResult = await store.query(`
        SELECT DISTINCT ?g ?root WHERE {
          VALUES ?root { ${graphValues(chunk)} }
          GRAPH ?g { ?root ?rootPredicate ?rootObject }
          FILTER(
            ?g = <${assertSafeIri(bucketGraph)}>
            || STRSTARTS(STR(?g), CONCAT(STR(<${assertSafeIri(bucketGraph)}>), "/"))
          )
        }
      `, syncResponderStoreOptions(signal, 'sync.responder.planFreshSwmGraphRoots'));
      if (rootResult.type !== 'bindings') continue;
      for (const row of rootResult.bindings) {
        const graph = row['g'];
        const root = row['root'];
        // The broad prefix filter keeps the store lookup optimizer-friendly;
        // enforce the exact read-both graph shape and current graph snapshot in
        // process before admitting a result. This excludes staging, malformed
        // descendants and unrelated/nested graph families.
        if (
          !graph
          || !root
          || !graphMembership.has(graph)
          || !chunkSet.has(root)
          || (graph !== bucketGraph
            && !isSharedMemoryBucketDescendantDataGraph(graph, bucketGraph))
        ) continue;
        const graphRoots = rootsByGraph.get(graph) ?? new Set<string>();
        graphRoots.add(root);
        rootsByGraph.set(graph, graphRoots);
      }
    }
  }

  const countsByGraph = new Map<string, number>();
  const admitted: Array<{ graph: string; roots: readonly string[] | null }> = [
    ...[...rootsByGraph.entries()]
      .filter(([graph]) => !exactGraphs.has(graph))
      .map(([graph, roots]) => ({ graph, roots: [...roots].sort(compareCodePoint) })),
    ...[...exactGraphs].map((graph) => ({ graph, roots: null })),
  ]
    .sort((a, b) => compareCodePoint(a.graph, b.graph));
  for (const chunk of chunkValues(admitted, FRESH_SWM_PLAN_QUERY_GRAPH_CHUNK)) {
    const unions = chunk.map(({ graph, roots }) => roots === null ? `
      {
        SELECT (<${assertSafeIri(graph)}> AS ?g) (COUNT(*) AS ?count) WHERE {
          GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
        }
      }` : `
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
    const selection = entry.roots === null
      ? `GRAPH <${assertSafeIri(entry.graph)}> { ?s ?p ?o }`
      : `VALUES ?root { ${graphValues(entry.roots)} }
        GRAPH <${assertSafeIri(entry.graph)}> { ?s ?p ?o }
        FILTER(?s = ?root || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/")))`;
    // sparql-scan-allow: R3 -- the retained session plan pre-counts each exact admitted graph, bounds skip to that graph rowCount, and LIMIT is the remaining response page
    const result = await store.query(`
      SELECT DISTINCT ?s ?p ?o WHERE {
        ${selection}
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
 * publisher rejects blank nodes). NEW unverified peer ingest now enforces this
 * IRI invariant at the durable-meta selection (#1921), so it no longer admits a
 * blank-node subject — but that guard operates on incoming quads only and does
 * NOT sweep already-persisted data, so a blank-node `_meta` subject written by a
 * pre-fix peer may still reside in the store. Subject atomicity must therefore
 * still cover it, and this per-query relabel accommodation stays as
 * defense-in-depth.
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
