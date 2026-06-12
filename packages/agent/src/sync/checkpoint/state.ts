import type { SyncPhase } from '../auth/request-build.js';

export interface SyncCheckpointStore {
  get(key: string): number | undefined;
  set(key: string, value: number): void;
  delete(key: string): void;
  pruneExpired?(nowMs?: number): number;
}

export function getSyncCheckpointKey(
  remotePeerId: string,
  contextGraphId: string,
  includeSharedMemory: boolean,
  phase: SyncPhase,
  snapshotRef?: string,
  sinceBatchId?: string,
): string {
  const refSuffix = phase === 'snapshot' && snapshotRef ? `|${snapshotRef}` : '';
  // Phase C: `sinceBatchId` changes the responder's result set, so a delta
  // fetch MUST NOT resume at an offset recorded against a full scan (or a
  // delta with a different high-water mark) — that would skip newly eligible
  // triples. Scoping the key by `sinceBatchId` keeps each filtered dataset on
  // its own resume cursor; a full sync (no hint) keeps the unscoped key.
  const sinceSuffix = sinceBatchId ? `|since:${sinceBatchId}` : '';
  return `${remotePeerId}|${contextGraphId}|${includeSharedMemory ? 'swm' : 'durable'}|${phase}${refSuffix}${sinceSuffix}`;
}
