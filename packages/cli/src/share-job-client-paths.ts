import type { ShareReconciliationInput } from '@origintrail-official/dkg-publisher';
import type { KnowledgeAssetShareJobState, KnowledgeAssetShareJobView } from './api-client.js';

const prefix = '/api/knowledge-assets/swm/share-jobs';

/**
 * Options of the share job list. `limit` caps the complete listing; `pageSize` and `cursor` page it instead (OT-RFC-73 P9b):
 * `pageSize` alone asks for the first page, `cursor` (the previous page's `nextCursor`) for the page after it. The daemon
 * refuses `limit` together with either.
 */
export interface ShareJobsListOptions {
  contextGraphId?: string;
  state?: KnowledgeAssetShareJobState | KnowledgeAssetShareJobState[];
  limit?: number;
  cursor?: string;
  pageSize?: number;
}

/**
 * The list answer. `nextCursor` and `complete` are present exactly when the request paged: `complete` means no further job
 * when that page was read, never proof that none arrived since.
 */
export interface ShareJobsListResult {
  jobs: KnowledgeAssetShareJobView[];
  nextCursor?: string | null;
  complete?: boolean;
}

export function shareJobsPath(options?: ShareJobsListOptions): string {
  const params = new URLSearchParams();
  if (options?.contextGraphId) params.set('contextGraphId', options.contextGraphId);
  if (options?.state) params.set('state', Array.isArray(options.state) ? options.state.join(',') : options.state);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.cursor !== undefined) params.set('cursor', options.cursor);
  if (options?.pageSize !== undefined) params.set('pageSize', String(options.pageSize));
  const qs = params.toString();
  return `${prefix}${qs ? `?${qs}` : ''}`;
}
export function shareReconciliationPath(input: ShareReconciliationInput): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) params.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
  return `${prefix}/reconcile?${params.toString()}`;
}
