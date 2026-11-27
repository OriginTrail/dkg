import type {
  OrdinarySharedMemorySyncLane,
  OrdinarySharedMemoryWorkItem,
} from '../../src/sync/on-connect/sync-on-connect.js';

type OrdinarySyncResult = Awaited<
  ReturnType<OrdinarySharedMemoryWorkItem['syncFromPeer']>
>;

/** Build the production lane shape explicitly from one scope and executor. */
export function ordinaryLane(
  resolveContextGraphIds: (
    remotePeerId: string,
  ) => readonly string[] | Promise<readonly string[]>,
  execute: (
    remotePeerId: string,
    contextGraphIds: readonly string[],
  ) => Promise<OrdinarySyncResult>,
): OrdinarySharedMemorySyncLane {
  return {
    resolveWork: async (remotePeerId) => {
      const frozenContextGraphIds = Object.freeze([
        ...await resolveContextGraphIds(remotePeerId),
      ]);
      return Object.freeze({
        contextGraphIds: frozenContextGraphIds,
        syncFromPeer: () => execute(remotePeerId, frozenContextGraphIds),
      });
    },
  };
}
