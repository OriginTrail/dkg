import { randomUUID } from 'node:crypto';

export const DURABLE_DATA_SYNC_SESSION_TTL_MS = 10 * 60_000;

export function createSyncResponderSessionId(scope = 'sync'): string {
  return `${scope}:${randomUUID()}`;
}

export function createDurableDataSyncSessionId(): string {
  return createSyncResponderSessionId('durable-data');
}
