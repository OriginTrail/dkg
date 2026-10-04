// SPDX-License-Identifier: Apache-2.0
import {
  SYNC_BYTE_BUDGET_EXACT_MAX_ROWS,
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
} from '../../dkg-agent-constants.js';
import { resolveExactSyncGzipProfile } from '../wire-compression.js';
import { serializeResponderRows, serializeResponderRowsWithinByteBudget } from './row-serialization.js';
import type { DurableDataRequestPolicy } from './durable-data-request-policy.js';

export interface SyncResponderRequestProfileParams {
  legacyLimit: number;
  includeSharedMemory: boolean;
  phase: string;
  pageMode?: string;
  pageRowsHint?: number;
  /** Already normalized by the sync request parser; present empty selections stay exact. */
  assetUals?: readonly string[];
  responseEncoding?: string;
}

/** One negotiated framing/read/export profile; encoding never establishes read authority. */
export function resolveSyncResponderRequestProfile(params: SyncResponderRequestProfileParams) {
  const hasExactAssetFilter = params.assetUals !== undefined;
  const compression = resolveExactSyncGzipProfile(params);
  const hintedRows = typeof params.pageRowsHint === 'number' && Number.isSafeInteger(params.pageRowsHint)
    ? Math.max(1, Math.min(params.pageRowsHint, SYNC_BYTE_BUDGET_MAX_ROWS)) : 0;
  const durableExactData = !params.includeSharedMemory && params.phase === 'data'
    && hasExactAssetFilter;
  const usesByteBudgetPage = params.pageMode === SYNC_BYTE_BUDGET_PAGE_MODE
    && (params.phase === 'meta' || (params.phase === 'data' && hintedRows > 0
      && (hintedRows > params.legacyLimit || durableExactData)));
  const usesCompressedData = usesByteBudgetPage && durableExactData && compression !== undefined;
  const limit = usesByteBudgetPage && hintedRows > 0
    ? Math.min(hintedRows, durableExactData && !usesCompressedData
      ? SYNC_BYTE_BUDGET_EXACT_MAX_ROWS : SYNC_BYTE_BUDGET_MAX_ROWS)
    : params.legacyLimit;
  const maxPageBytes = usesCompressedData ? compression.maxInflatedBytes : SYNC_BYTE_BUDGET_RESPONSE_BYTES;
  const framing = Object.freeze({
    usesByteBudgetPage, limit, maxPageBytes,
    serialize: usesByteBudgetPage
      ? (rows: Parameters<typeof serializeResponderRows>[0]) => serializeResponderRowsWithinByteBudget(rows, maxPageBytes)
      : serializeResponderRows,
  });
  const usesDurableByteBudgetPage = !params.includeSharedMemory && params.phase === 'data'
    && usesByteBudgetPage;
  const pageOnlyExactFetch = usesDurableByteBudgetPage && hasExactAssetFilter;
  const durableData: Readonly<DurableDataRequestPolicy> = Object.freeze({
    usesByteBudgetPage: usesDurableByteBudgetPage,
    limit: usesDurableByteBudgetPage ? limit : params.legacyLimit,
    cacheMode: pageOnlyExactFetch ? 'page-only' : 'session-snapshot',
    exactGraphReadMode: pageOnlyExactFetch ? 'page-only' : 'snapshot-or-page',
    maxPageBytes,
    usesExactAssetExport: usesCompressedData,
  });
  return Object.freeze({ framing, durableData, compression });
}

export type SyncResponderRequestProfile = ReturnType<typeof resolveSyncResponderRequestProfile>;
