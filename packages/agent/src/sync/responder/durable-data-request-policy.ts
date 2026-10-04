import {
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_EXACT_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
} from '../../dkg-agent-constants.js';
import { EXACT_SYNC_GZIP_ENCODING, EXACT_SYNC_GZIP_MAX_INFLATED_BYTES } from '../wire-compression.js';

export type DurableDataCacheMode = 'session-snapshot' | 'page-only';
export type ExactGraphReadMode = 'snapshot-or-page' | 'page-only';

export interface DurableDataRequestPolicy {
  usesByteBudgetPage: boolean;
  limit: number;
  cacheMode: DurableDataCacheMode;
  exactGraphReadMode: ExactGraphReadMode;
  maxPageBytes: number;
  usesExactAssetExport: boolean;
}

/**
 * Resolve responder resource policy from authenticated request semantics only.
 *
 * Signature fields are deliberately absent: public-graph authorization may
 * accept a request before validating them, so their presence is not proof that
 * a caller is authenticated. Ordinary exact reads retain the 512-row ceiling.
 * A single-KA compression capability selects a separate bounded export profile
 * after authorization; its physical store and memory ceilings remain local.
 */
export function resolveDurableDataRequestPolicy(params: {
  legacyLimit: number;
  includeSharedMemory: boolean;
  phase: string;
  pageMode?: string;
  pageRowsHint?: number;
  hasExactAssetFilter: boolean;
  responseEncoding?: string;
  exactAssetCount?: number;
}): DurableDataRequestPolicy {
  const hintedPageRows = typeof params.pageRowsHint === 'number' &&
    Number.isSafeInteger(params.pageRowsHint)
    ? Math.max(1, Math.min(params.pageRowsHint, SYNC_BYTE_BUDGET_MAX_ROWS))
    : 0;
  const usesByteBudgetPage = params.phase === 'data' &&
    params.pageMode === SYNC_BYTE_BUDGET_PAGE_MODE &&
    hintedPageRows > 0 &&
    (hintedPageRows > params.legacyLimit || params.hasExactAssetFilter);
  const pageOnlyExactFetch = usesByteBudgetPage && params.hasExactAssetFilter;
  const usesExactAssetExport = pageOnlyExactFetch && params.exactAssetCount === 1
    && params.responseEncoding === EXACT_SYNC_GZIP_ENCODING;

  return {
    usesByteBudgetPage,
    limit: usesByteBudgetPage
      ? Math.min(
        hintedPageRows,
        pageOnlyExactFetch && !usesExactAssetExport
          ? SYNC_BYTE_BUDGET_EXACT_MAX_ROWS
          : SYNC_BYTE_BUDGET_MAX_ROWS,
      )
      : params.legacyLimit,
    cacheMode: pageOnlyExactFetch ? 'page-only' : 'session-snapshot',
    exactGraphReadMode: pageOnlyExactFetch ? 'page-only' : 'snapshot-or-page',
    maxPageBytes: usesExactAssetExport ? EXACT_SYNC_GZIP_MAX_INFLATED_BYTES : SYNC_BYTE_BUDGET_RESPONSE_BYTES,
    usesExactAssetExport,
  };
}
