import {
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_REQUEST_SAFE_PAGE_SIZE,
} from '../../dkg-agent-constants.js';

export type DurableDataCacheMode = 'session-snapshot' | 'page-only';
export type ExactGraphReadMode = 'snapshot-or-page' | 'page-only';

export interface DurableDataRequestPolicy {
  usesByteBudgetPage: boolean;
  limit: number;
  cacheMode: DurableDataCacheMode;
  exactGraphReadMode: ExactGraphReadMode;
}

/**
 * Resolve responder resource policy from authenticated request semantics only.
 *
 * Signature fields are deliberately absent: public-graph authorization may
 * accept a request before validating them, so their presence is not proof that
 * a caller is authenticated. Every negotiated exact-asset read therefore uses
 * the conservative store-page path and 64-row floor.
 */
export function resolveDurableDataRequestPolicy(params: {
  legacyLimit: number;
  includeSharedMemory: boolean;
  phase: string;
  pageMode?: string;
  pageRowsHint?: number;
  hasExactAssetFilter: boolean;
}): DurableDataRequestPolicy {
  const hintedPageRows = typeof params.pageRowsHint === 'number' &&
    Number.isSafeInteger(params.pageRowsHint)
    ? Math.max(1, Math.min(params.pageRowsHint, SYNC_BYTE_BUDGET_MAX_ROWS))
    : 0;
  const usesByteBudgetPage = !params.includeSharedMemory &&
    params.phase === 'data' &&
    params.pageMode === SYNC_BYTE_BUDGET_PAGE_MODE &&
    hintedPageRows > 0 &&
    (hintedPageRows > params.legacyLimit || params.hasExactAssetFilter);
  const pageOnlyExactFetch = usesByteBudgetPage && params.hasExactAssetFilter;

  return {
    usesByteBudgetPage,
    limit: usesByteBudgetPage
      ? Math.min(
        hintedPageRows,
        pageOnlyExactFetch
          ? SYNC_REQUEST_SAFE_PAGE_SIZE
          : SYNC_BYTE_BUDGET_MAX_ROWS,
      )
      : params.legacyLimit,
    cacheMode: pageOnlyExactFetch ? 'page-only' : 'session-snapshot',
    exactGraphReadMode: pageOnlyExactFetch ? 'page-only' : 'snapshot-or-page',
  };
}
