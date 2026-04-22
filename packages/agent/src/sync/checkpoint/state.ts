export interface SyncCheckpointStore {
  get(key: string): number | undefined;
  set(key: string, value: number): void;
  delete(key: string): void;
}

export function getSyncCheckpointKey(
  remotePeerId: string,
  contextGraphId: string,
  includeSharedMemory: boolean,
  phase: 'data' | 'meta',
): string {
  return `${remotePeerId}|${contextGraphId}|${includeSharedMemory ? 'swm' : 'durable'}|${phase}`;
}
