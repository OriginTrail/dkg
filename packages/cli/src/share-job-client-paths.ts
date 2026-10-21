import type { ShareReconciliationInput } from '@origintrail-official/dkg-publisher';
import type { KnowledgeAssetShareJobState } from './api-client.js';

const prefix = '/api/knowledge-assets/swm/share-jobs';
export function shareJobsPath(options?: {
  contextGraphId?: string; state?: KnowledgeAssetShareJobState | KnowledgeAssetShareJobState[]; limit?: number;
}): string {
  const params = new URLSearchParams();
  if (options?.contextGraphId) params.set('contextGraphId', options.contextGraphId);
  if (options?.state) params.set('state', Array.isArray(options.state) ? options.state.join(',') : options.state);
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
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
