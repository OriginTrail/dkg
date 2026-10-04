import { resolveExactSyncGzipProfile } from '../wire-compression.js';
import { resolveResponderPageFraming, type ResponderPageFraming } from './page-framing-policy.js';

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
  framing?: ResponderPageFraming;
}): DurableDataRequestPolicy {
  const framing = params.framing ?? resolveResponderPageFraming(params);
  const usesByteBudgetPage = !params.includeSharedMemory && params.phase === 'data'
    && framing.usesByteBudgetPage;
  const pageOnlyExactFetch = usesByteBudgetPage && params.hasExactAssetFilter;
  const usesExactAssetExport = pageOnlyExactFetch && resolveExactSyncGzipProfile({
    ...params, assetUals: params.exactAssetCount === 1 ? ['selected'] : undefined,
  }) !== undefined;

  return {
    usesByteBudgetPage,
    limit: usesByteBudgetPage ? framing.limit : params.legacyLimit,
    cacheMode: pageOnlyExactFetch ? 'page-only' : 'session-snapshot',
    exactGraphReadMode: pageOnlyExactFetch ? 'page-only' : 'snapshot-or-page',
    maxPageBytes: framing.maxPageBytes,
    usesExactAssetExport,
  };
}
