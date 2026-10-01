import { asGraphWriteRevisionSource, type TripleStore } from '@origintrail-official/dkg-storage';
import type { GraphMembershipSnapshot } from '../graph-membership-snapshot.js';
import type { ExactGraphReadMode } from './durable-data-request-policy.js';
import type { ExactAssetExportCache } from './exact-asset-export-cache.js';
import {
  ExactPageSessionReader,
  type ExactPageReadResult,
  type ExactPageExportScope,
} from './exact-page-reader.js';
import {
  buildExactGraphPagePlan,
  readExactGraphPlanSnapshot,
  readGraphScopedVmManifest,
  readRowsPageFromExactGraphPlan,
  rememberExactGraphReturnedPrefix,
  type ExactGraphPagePlan,
  type ExactGraphPagePlanMemo,
  type ExactGraphSnapshotLimits,
} from './exact-graph-reader.js';
import { createSessionPlanGetter, readResponderRowsPage, type RowListCache } from './responder-row-page.js';
import { exactAssetFilterKey } from '../exact-assets.js';
import {
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
  SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
  type SyncRow,
  type SyncRowListMemo,
} from './snapshot-cache.js';

export interface DurableDataPageParams {
  store: TripleStore;
  graphMembership: GraphMembershipSnapshot;
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
  /** Server-derived peer/CG/selection/session identity, independent of row caching. */
  exactGraphPlanCacheKey?: string;
  /** Assemble byte-budgeted pages from conservative store chunks. */
  maxPageBytes?: number;
  /** Keep the immutable row snapshot until an explicit empty-page EOF. */
  releaseCacheOnShortPage?: boolean;
  assetUals?: readonly string[];
  /**
   * Select whether exact-graph payloads may use a bounded graph snapshot or
   * must use OFFSET/LIMIT reads. Resource policy is resolved by the handler;
   * this session owner only consumes the neutral read strategy.
   */
  exactGraphReadMode?: ExactGraphReadMode;
  /** Negotiated single-KA gzip only; plain and older readers keep conservative paging. */
  exactAssetExportCache?: ExactAssetExportCache;
}
/** Selected exact DATA has its own session owner; shared snapshot loaders remain row-only. */
export async function readExactDataSessionPage(params: DurableDataPageParams): Promise<ExactPageReadResult> {
  if (!params.assetUals?.length) return { rows: [] };
  const cache: RowListCache | undefined = params.rowListMemo
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
  const limits = cache?.memo.snapshotLoadLimits ?? {
    maxRows: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
    maxBytesEstimate: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
    pageRows: SYNC_RESPONDER_SNAPSHOT_BUILD_PAGE_ROWS,
  };
  const key = params.exactGraphPlanCacheKey ?? cache?.key;
  const getPlan = createSessionPlanGetter<ExactGraphPagePlan>(params.exactGraphPlanMemo, key,
    params.exactGraphPlanCacheKey ? params.refreshRowList === true : cache?.refresh === true,
    signal => loadExactDataSession(params, cache, limits, Boolean(params.exactGraphPlanMemo && key), signal),
    'Sync session exact-graph plan expired before page completion');
  const getSession = async (offset: number, signal?: AbortSignal): Promise<ExactDataSessionOwner> => {
    const plan = await getPlan(offset, signal);
    if (!(plan instanceof ExactDataSessionOwner)) throw new Error('Sync session exact-graph plan expired before page completion');
    return plan;
  };
  if (!cache) {
    return (await getSession(params.offset, params.signal)).read(
      params.offset, params.limit, params.maxPageBytes, params.signal,
    );
  }
  // Snapshot fallback calls the same retained owner and cannot rebuild against
  // a moved manifest or reinterpret an already-returned byte-page offset.
  return { rows: await readResponderRowsPage(
    { ...cache, expiredMessage: cache.expiredMessage ?? 'Durable data sync session snapshot expired before page completion' },
    async (offset, limit, signal) => (await (await getSession(offset, signal)).read(offset, limit, params.maxPageBytes, signal)).rows,
    params.offset, params.limit, params.signal,
    { loadSnapshot: async () => (await getSession(0)).snapshot(cache) },
  ) };
}

interface ExactDataRevisionFence {
  readonly prefix: string;
  readonly generation: number;
  readonly stable: boolean;
}

async function loadExactDataSession(params: DurableDataPageParams, cache: RowListCache | undefined,
  limits: ExactGraphSnapshotLimits, retained: boolean, signal?: AbortSignal): Promise<ExactDataSessionOwner> {
  const requested = new Set(params.assetUals);
  const revisionSource = params.exactGraphReadMode === 'page-only' ? asGraphWriteRevisionSource(params.store) : null;
  const prefix = `did:dkg:context-graph:${params.contextGraphId}/_meta`;
  const revision = revisionSource?.getWriteRevision(prefix);
  const manifest = await readGraphScopedVmManifest(params.store, params.contextGraphId, signal);
  const entries = manifest.confirmedEntries.filter(entry => requested.has(entry.ual));
  const payloadRevisions = revisionSource ? entries.map(entry => {
    const current = revisionSource.getWriteRevision(entry.graph);
    return { prefix: entry.graph, generation: current.generation, stable: current.stable };
  }) : [];
  const plan = await buildExactGraphPagePlan(params.store, entries.map(entry => entry.graph), () => Promise.resolve(true),
    signal, new Map(entries.map(entry => [entry.graph, entry.rowCount])), params.exactGraphReadMode);
  const fences: readonly ExactDataRevisionFence[] = revision
    ? [{ prefix, generation: revision.generation, stable: revision.stable }, ...payloadRevisions] : [];
  const requiresVerifiedExport = fences.some(current => !current.stable);
  if (requiresVerifiedExport && (params.assetUals?.length !== 1 || !params.exactAssetExportCache || params.maxPageBytes === undefined)) {
    throw new Error('Sync session exact-graph plan expired: store revision is unstable');
  }
  // Stateless readers retain the compatible store order. Snapshot callers
  // never acquire a response lease that their row-only cache cannot own.
  const exportScope = retained && !cache && params.assetUals?.length === 1 && params.exactAssetExportCache && plan.entries.length === 1
    ? { contextGraphId: params.contextGraphId, assetUal: params.assetUals[0]!, cache: params.exactAssetExportCache,
      graph: plan.entries[0]!.graph, expectedRows: plan.entries[0]!.rowCount } : undefined;
  const session = new ExactDataSessionOwner(plan, params.store, limits, fences, params.maxPageBytes !== undefined,
    exportScope, requiresVerifiedExport);
  session.assertCurrent();
  return session;
}

/** The bounded memo retains this owner itself, alongside its reusable store cursor state. */
class ExactDataSessionOwner implements ExactGraphPagePlan {
  readonly entries: ExactGraphPagePlan['entries'];
  readonly totalRows: number;
  readonly pagedGraphs: ExactGraphPagePlan['pagedGraphs'];
  readonly cursors: ExactGraphPagePlan['cursors'];
  declare cursorBytesEstimate: ExactGraphPagePlan['cursorBytesEstimate'];
  declare activeGraphRows: ExactGraphPagePlan['activeGraphRows'];
  declare activeGraphRowsLoad: ExactGraphPagePlan['activeGraphRowsLoad'];
  private readonly reader?: ExactPageSessionReader;

  constructor(plan: ExactGraphPagePlan, private readonly store: TripleStore, private readonly limits: ExactGraphSnapshotLimits,
    private readonly fences: readonly ExactDataRevisionFence[], byteBounded: boolean,
    exportScope: ExactPageExportScope | undefined, requiresVerifiedExport: boolean) {
    this.entries = plan.entries;
    this.totalRows = plan.totalRows;
    this.pagedGraphs = plan.pagedGraphs;
    this.cursors = plan.cursors;
    if (byteBounded) this.reader = new ExactPageSessionReader({ totalRows: this.totalRows,
      readRows: (offset, limit, maxResponseBytes, signal) => readRowsPageFromExactGraphPlan(
        this.store, this, offset, limit, { ...this.limits, maxPageResponseBytes: maxResponseBytes }, signal),
      rememberReturnedPrefix: (offset, rows) => rememberExactGraphReturnedPrefix(this, offset, rows),
    }, exportScope, requiresVerifiedExport);
  }

  assertCurrent(): void {
    if (this.fences.length === 0) return;
    const source = asGraphWriteRevisionSource(this.store);
    for (const expected of this.fences) {
      const revision = source?.getWriteRevision(expected.prefix);
      if (!revision || revision.stable !== expected.stable || revision.generation !== expected.generation) {
        throw new Error('Sync session exact-graph plan expired: store revision changed before page completion');
      }
    }
  }

  async read(offset: number, limit: number, maxBytes?: number, signal?: AbortSignal): Promise<ExactPageReadResult> {
    this.assertCurrent();
    const page = this.reader && maxBytes !== undefined
      ? await this.reader.read({ offset, limit, maxBytes, signal })
      : { rows: await readRowsPageFromExactGraphPlan(this.store, this, offset, limit, this.limits, signal) };
    try {
      this.assertCurrent();
      signal?.throwIfAborted();
      return page;
    } catch (error) {
      page.responseLease?.release();
      throw error;
    }
  }

  async snapshot(cache: RowListCache): Promise<readonly SyncRow[]> {
    this.assertCurrent();
    const rows = await readExactGraphPlanSnapshot(this.store, this, cache, this.limits);
    this.assertCurrent();
    return rows;
  }
}
export function durableDataRowListCacheKey(
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
