import { describe, expect, it, vi } from 'vitest';

const compositionMocks = vi.hoisted(() => ({
  capturedPorts: undefined as unknown,
  createContextGraphSyncDeadline: vi.fn(() => 12_345),
  deleteSyncPageCheckpoint: vi.fn(),
}));

vi.mock('../src/sync/requester/durable-sync-budget.js', () => ({
  createContextGraphSyncDeadline: compositionMocks.createContextGraphSyncDeadline,
}));

vi.mock('../src/sync/requester/page-fetch.js', () => ({
  deleteSyncPageCheckpoint: compositionMocks.deleteSyncPageCheckpoint,
}));

vi.mock('../src/sync/requester/swm-target-executor.js', () => ({
  SwmTargetExecutorV1: class {
    constructor(ports: unknown) {
      compositionMocks.capturedPorts = ports;
    }
  },
}));

import { SwmTargetExecutorCompositionMethods } from
  '../src/dkg-agent-swm-target-executor.js';
import type { SwmTargetExecutorPortsV1 } from
  '../src/sync/requester/swm-target-executor.js';

describe('DKGAgent SWM target executor composition', () => {
  it('binds every narrow requester port and keeps ownership maps session-safe', async () => {
    const listSubGraphs = vi.fn(async () => [{ name: 'named' }]);
    const fetchSyncPages = vi.fn(async () => ({ completed: true }));
    const processSharedMemoryBatch = vi.fn(async () => ({ verifiedData: [] }));
    const recordDrops = vi.fn();
    const invalidateListContextGraphsCache = vi.fn();
    const markDirtyFromQuads = vi.fn();
    const retireFinalizedSwmTwinCandidate = vi.fn(async () => undefined);
    const logInfo = vi.fn();
    const logWarn = vi.fn();
    const logDebug = vi.fn();
    const syncCheckpoints = new Map();
    const workspaceOwnedEntities = new Map();
    const agentLike = {
      store: { kind: 'store' },
      writeLocks: new Map(),
      listSubGraphs,
      fetchSyncPages,
      getOrCreateSyncVerifyWorker: () => ({ processSharedMemoryBatch }),
      publicSnapshotStore: { kind: 'snapshots' },
      oversizeTombstoneLog: { record: recordDrops },
      invalidateListContextGraphsCache,
      contextGraphMetaProjection: { markDirtyFromQuads },
      syncCheckpoints,
      workspaceOwnedEntities,
      retireFinalizedSwmTwinCandidate,
      log: { info: logInfo, warn: logWarn, debug: logDebug },
    };

    SwmTargetExecutorCompositionMethods.prototype.createSwmTargetExecutorV1.call(
      agentLike as never,
    );
    const ports = compositionMocks.capturedPorts as SwmTargetExecutorPortsV1;

    expect(ports.store).toBe(agentLike.store);
    expect(ports.writeLocks).toBe(agentLike.writeLocks);
    expect(ports.publicSnapshotStore).toBe(agentLike.publicSnapshotStore);
    await expect(ports.listSubGraphs('cg')).resolves.toEqual([{ name: 'named' }]);
    expect(ports.createContextGraphSyncDeadline(3)).toBe(12_345);
    expect(compositionMocks.createContextGraphSyncDeadline)
      .toHaveBeenCalledWith({ remainingContextGraphs: 3 });

    const fetchArgs = [
      { operationName: 'sync' },
      'peer',
      'cg',
      true,
      'meta',
      'urn:graph',
      12_345,
      { recovery: true },
    ] as const;
    await ports.fetchSyncPages(...fetchArgs as never);
    expect(fetchSyncPages).toHaveBeenCalledWith(...fetchArgs);
    await ports.processSharedMemoryBatch([], [], 'cg', [], []);
    expect(processSharedMemoryBatch).toHaveBeenCalledWith([], [], 'cg', [], []);

    ports.recordDrops([] as never, 'swm-sync');
    ports.invalidateListContextGraphsCache();
    ports.markMetaProjectionDirty([]);
    ports.setCheckpoint('checkpoint' as never, 4);
    ports.deleteCheckpoint('checkpoint' as never);
    ports.deletePublicCheckpoint('public-checkpoint' as never);
    expect(recordDrops).toHaveBeenCalledWith([], 'swm-sync');
    expect(invalidateListContextGraphsCache).toHaveBeenCalledOnce();
    expect(markDirtyFromQuads).toHaveBeenCalledWith([]);
    expect(syncCheckpoints.has('checkpoint')).toBe(false);
    expect(compositionMocks.deleteSyncPageCheckpoint)
      .toHaveBeenCalledWith(syncCheckpoints, 'public-checkpoint');

    const firstOwned = ports.ensureOwnedMap('ownership');
    const secondOwned = ports.ensureOwnedMap('ownership');
    expect(secondOwned).toBe(firstOwned);
    expect(workspaceOwnedEntities.get('ownership')).toBe(firstOwned);

    const retirement = { contextGraphId: 'cg' };
    const ctx = { operationName: 'sync' };
    await ports.retireFinalizedSwmTwin(retirement as never, ctx as never);
    ports.logInfo(ctx as never, 'info');
    ports.logWarn(ctx as never, 'warn');
    ports.logDebug(ctx as never, 'debug');
    expect(retireFinalizedSwmTwinCandidate).toHaveBeenCalledWith(retirement, ctx);
    expect(logInfo).toHaveBeenCalledWith(ctx, 'info');
    expect(logWarn).toHaveBeenCalledWith(ctx, 'warn');
    expect(logDebug).toHaveBeenCalledWith(ctx, 'debug');
  });
});
