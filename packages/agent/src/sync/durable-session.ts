import { randomUUID } from 'node:crypto';

export const DURABLE_DATA_SYNC_SESSION_TTL_MS = 10 * 60_000;

export function createSyncResponderSessionId(scope = 'sync'): string {
  return `${scope}:${randomUUID()}`;
}

export function createDurableDataSyncSessionId(): string {
  return createSyncResponderSessionId('durable-data');
}

/**
 * A responder-session token is terminal once the responder reports that its
 * immutable snapshot was superseded or expired. Retrying the same request with
 * the same token cannot succeed; the requester must rotate the token instead.
 */
export function isSyncResponderSessionInvalidError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('sync session') && (
    message.includes('superseded')
    || message.includes('expired')
  );
}
