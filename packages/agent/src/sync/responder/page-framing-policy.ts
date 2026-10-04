// SPDX-License-Identifier: Apache-2.0
import {
  SYNC_BYTE_BUDGET_EXACT_MAX_ROWS,
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
} from '../../dkg-agent-constants.js';
import { resolveExactSyncGzipProfile } from '../wire-compression.js';
import { serializeResponderRows, serializeResponderRowsWithinByteBudget } from './graph-plan.js';

export interface ResponderPageFramingParams {
  legacyLimit: number;
  includeSharedMemory: boolean;
  phase: string;
  pageMode?: string;
  pageRowsHint?: number;
  hasExactAssetFilter: boolean;
  responseEncoding?: string;
  exactAssetCount?: number;
}

/** Common wire framing; shared memory never inherits durable export allowances. */
export function resolveResponderPageFraming(params: ResponderPageFramingParams) {
  const hintedRows = typeof params.pageRowsHint === 'number' && Number.isSafeInteger(params.pageRowsHint)
    ? Math.max(1, Math.min(params.pageRowsHint, SYNC_BYTE_BUDGET_MAX_ROWS)) : 0;
  const durableExactData = !params.includeSharedMemory && params.phase === 'data'
    && params.hasExactAssetFilter;
  const usesByteBudgetPage = params.pageMode === SYNC_BYTE_BUDGET_PAGE_MODE
    && (params.phase === 'meta' || (params.phase === 'data' && hintedRows > 0
      && (hintedRows > params.legacyLimit || durableExactData)));
  const compression = resolveExactSyncGzipProfile({
    ...params,
    assetUals: params.hasExactAssetFilter
      ? params.exactAssetCount === 1 ? ['selected'] : ['selected', 'another'] : undefined,
  });
  const usesCompressedData = usesByteBudgetPage && durableExactData && compression !== undefined;
  const limit = usesByteBudgetPage && hintedRows > 0
    ? Math.min(hintedRows, durableExactData && !usesCompressedData
      ? SYNC_BYTE_BUDGET_EXACT_MAX_ROWS : SYNC_BYTE_BUDGET_MAX_ROWS)
    : params.legacyLimit;
  const maxPageBytes = usesCompressedData ? compression.maxInflatedBytes : SYNC_BYTE_BUDGET_RESPONSE_BYTES;
  return Object.freeze({
    usesByteBudgetPage, limit, maxPageBytes,
    serialize: usesByteBudgetPage
      ? (rows: Parameters<typeof serializeResponderRows>[0]) => serializeResponderRowsWithinByteBudget(rows, maxPageBytes)
      : serializeResponderRows,
  });
}

export type ResponderPageFraming = ReturnType<typeof resolveResponderPageFraming>;
