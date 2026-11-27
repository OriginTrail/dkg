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

export type ShareJobReference = string | { jobId: string; url?: string } | { jobId?: string | null; url: string };

/** Retained recovery URLs stay relative to this client's daemon and canonical job route. */
export function shareJobPath(reference: ShareJobReference): string {
  if (typeof reference === 'string') return `${prefix}/${encodeURIComponent(reference)}`;
  if (reference.jobId) return shareJobPath(reference.jobId);
  const path = reference.url;
  if (!path?.startsWith(`${prefix}/`)) throw new Error('Invalid share recovery job URL');
  const encodedId = path.slice(prefix.length + 1);
  if (!encodedId || /[/?#]/.test(encodedId)) throw new Error('Invalid share recovery job URL');
  return shareJobPath(decodeURIComponent(encodedId));
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
