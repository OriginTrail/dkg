import { createHash } from 'node:crypto';

export const DURABLE_DATA_SYNC_SESSION_BUCKET_MS = 10 * 60_000;

export function durableDataSyncSessionId(params: {
  remotePeerId: string;
  contextGraphId: string;
  sinceBatchId?: string;
}): string {
  const sinceScope = params.sinceBatchId?.trim() || 'full';
  const bucket = Math.floor(Date.now() / DURABLE_DATA_SYNC_SESSION_BUCKET_MS);
  const digest = createHash('sha256')
    .update('dkg-sync-durable-data-session')
    .update('\0')
    .update(params.remotePeerId)
    .update('\0')
    .update(params.contextGraphId)
    .update('\0')
    .update(sinceScope)
    .update('\0')
    .update(String(bucket))
    .digest('hex')
    .slice(0, 32);
  return `durable-data:${digest}`;
}
