import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

vi.mock('../src/sync/requester/swm-recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sync/requester/swm-recovery.js')>(),
  recoverContextGraphSwmWithProgressRetries: vi.fn(),
}));

const { recoverContextGraphSwmWithProgressRetries } = await import('../src/sync/requester/swm-recovery.js');
const { createSwmRecoveryMutationRuntimeV1 } = await import('../src/sync/requester/swm-recovery-apply.js');
const { SwmTargetExecutorV1 } = await import('../src/sync/requester/swm-target-executor.js');
type Ports = ConstructorParameters<typeof SwmTargetExecutorV1>[0];
type RecoveryResult = Awaited<ReturnType<typeof recoverContextGraphSwmWithProgressRetries>>;

const recovered = (replacedGraphs: number) => ({
  completed: true, replacedRoots: 0, replacedGraphs, insertedDataQuads: 0, insertedMetaQuads: 0,
  droppedDataTriples: 0, readySnapshots: 0, totalSnapshots: 0,
}) as unknown as RecoveryResult;

function executor(requestReadGraphBuild: () => void) {
  const store = new OxigraphStore();
  const ports = {
    store,
    writeLocks: new Map(),
    createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
    recoveryMutation: createSwmRecoveryMutationRuntimeV1({
      store, recordDrops: () => undefined, invalidateListContextGraphsCache: () => undefined,
    }),
    invalidateListContextGraphsCache: () => undefined,
    requestReadGraphBuild,
  } as unknown as Ports;
  return { store, executor: new SwmTargetExecutorV1(ports) };
}

describe('the read-graph build pass after a private recovery round', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    vi.mocked(recoverContextGraphSwmWithProgressRetries).mockReset();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('is asked for when the round replaced graphs through the recovery store, and not when it replaced none', async () => {
    const requestReadGraphBuild = vi.fn();
    const { store, executor: target } = executor(requestReadGraphBuild);
    stores.push(store);
    const recover = vi.mocked(recoverContextGraphSwmWithProgressRetries);
    recover.mockResolvedValueOnce(recovered(0));
    await target.recoverPrivateTarget({ remotePeerId: 'peer', contextGraphId: 'private-read-graph-pass' });
    expect(requestReadGraphBuild).not.toHaveBeenCalled();
    recover.mockResolvedValueOnce(recovered(2));
    await target.recoverPrivateTarget({ remotePeerId: 'peer', contextGraphId: 'private-read-graph-pass' });
    expect(requestReadGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('is not asked for when a round that wrote nothing fails', async () => {
    const requestReadGraphBuild = vi.fn();
    const { store, executor: target } = executor(requestReadGraphBuild);
    stores.push(store);
    vi.mocked(recoverContextGraphSwmWithProgressRetries).mockRejectedValueOnce(new Error('peer went away'));
    await expect(target.recoverPrivateTarget({ remotePeerId: 'peer', contextGraphId: 'private-read-graph-pass' }))
      .rejects.toThrow('peer went away');
    expect(requestReadGraphBuild).not.toHaveBeenCalled();
  });
});
