import type { SyncPhase } from '../auth/request-build.js';

export interface SyncCheckpointStore {
  get(key: string): number | undefined;
  set(key: string, value: number): void;
  delete(key: string): void;
}

export function getSyncCheckpointKey(
  remotePeerId: string,
  contextGraphId: string,
  includeSharedMemory: boolean,
  phase: SyncPhase,
  snapshotRef?: string,
): string {
  const refSuffix = phase === 'snapshot' && snapshotRef ? `|${snapshotRef}` : '';
  return `${remotePeerId}|${contextGraphId}|${includeSharedMemory ? 'swm' : 'durable'}|${phase}${refSuffix}`;
}
