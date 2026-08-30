import {
  runSyncOnConnect,
  type OrdinarySharedMemorySyncLane,
  type OrdinarySharedMemoryWorkItem,
  type SyncOnConnectContext,
} from '../../src/sync/on-connect/sync-on-connect.js';

type OrdinarySyncResult = Awaited<
  ReturnType<OrdinarySharedMemoryWorkItem['syncFromPeer']>
>;

type SyncOnConnectTestContext = Omit<
  SyncOnConnectContext,
  'ordinarySharedMemoryLane'
> & {
  ordinarySharedMemoryLane?: OrdinarySharedMemorySyncLane;
  resolveOrdinaryContextGraphIds?: (
    remotePeerId: string,
  ) => readonly string[] | Promise<readonly string[]>;
  executeOrdinary?: (
    remotePeerId: string,
    contextGraphIds: readonly string[],
  ) => Promise<OrdinarySyncResult>;
};

/** Test-only adapter for concise contexts while the core API stays cohesive. */
export function runSyncOnConnectWithTestOrdinaryLane(
  context: SyncOnConnectTestContext,
): ReturnType<typeof runSyncOnConnect> {
  const {
    ordinarySharedMemoryLane,
    resolveOrdinaryContextGraphIds,
    executeOrdinary,
    ...coreContext
  } = context;
  const testLane = ordinarySharedMemoryLane ?? (executeOrdinary === undefined
    ? {
      resolveWork: () => ({
        contextGraphIds: [],
        syncFromPeer: async () => 0,
      }),
    }
    : {
      resolveWork: async (remotePeerId: string) => {
        const contextGraphIds = resolveOrdinaryContextGraphIds
          ? await resolveOrdinaryContextGraphIds(remotePeerId)
          : coreContext.getSyncContextGraphs();
        const frozenContextGraphIds = Object.freeze([...contextGraphIds]);
        return Object.freeze({
          contextGraphIds: frozenContextGraphIds,
          syncFromPeer: () => executeOrdinary(
            remotePeerId,
            frozenContextGraphIds,
          ),
        });
      },
    });
  return runSyncOnConnect({
    ...coreContext,
    ordinarySharedMemoryLane: testLane,
  });
}
