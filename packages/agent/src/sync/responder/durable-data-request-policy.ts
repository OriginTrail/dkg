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
