import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';

vi.mock('../src/sync/requester/swm-recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sync/requester/swm-recovery.js')>(),
  recoverContextGraphSwm: vi.fn(),
  recoverContextGraphSwmWithProgressRetries: vi.fn(),
}));

const recovery = await import('../src/sync/requester/swm-recovery.js');
const { createSwmRecoveryMutationRuntimeV1 } = await import('../src/sync/requester/swm-recovery-apply.js');
const { SwmTargetExecutorV1 } = await import('../src/sync/requester/swm-target-executor.js');
type Ports = ConstructorParameters<typeof SwmTargetExecutorV1>[0];
type RoundResult = Awaited<ReturnType<typeof recovery.recoverContextGraphSwm>>;

const CG = 'private-read-graph-pass';
const SNAPSHOT_GRAPH = `did:dkg:context-graph:${CG}/_shared_memory/0x${'ab'.repeat(20)}/1`;

const round = (replacedGraphs: number, completed = true) => ({
  completed, replacedRoots: 0, replacedGraphs, insertedDataQuads: 0, insertedMetaQuads: 0,
  droppedDataTriples: 0, readySnapshots: 0, totalSnapshots: 0,
  ...(completed ? {} : { phaseFailureCause: 'timeout' }),
}) as unknown as RoundResult;

/** The retry runner: it calls the executor's own round callback `rounds` times, then fails with `error` if given. */
function retries(rounds: number, error?: Error): void {
  vi.mocked(recovery.recoverContextGraphSwmWithProgressRetries).mockImplementationOnce(async (params) => {
    let last: RoundResult | undefined;
    for (let index = 1; index <= rounds; index += 1) last = await params.recover(index, {} as never, Number.MAX_SAFE_INTEGER);
    if (error) throw error;
    return last!;
  });
}

const stores: OxigraphStore[] = [];
function executor() {
  const store = new OxigraphStore();
  stores.push(store);
  const requestReadGraphBuild = vi.fn();
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
  const target = new SwmTargetExecutorV1(ports);
  return { store, requestReadGraphBuild, recover: () => target.recoverPrivateTarget({ remotePeerId: 'peer', contextGraphId: CG }) };
}

describe('the read-graph build pass after a private recovery', () => {
  afterEach(async () => {
    vi.mocked(recovery.recoverContextGraphSwm).mockReset();
    vi.mocked(recovery.recoverContextGraphSwmWithProgressRetries).mockReset();
    await Promise.all(stores.splice(0).map((store) => store.close()));
  });

  it('is not asked for after rounds that replaced no graph', async () => {
    const { requestReadGraphBuild, recover } = executor();
    vi.mocked(recovery.recoverContextGraphSwm).mockResolvedValueOnce(round(0));
    retries(1);
    await recover();
    expect(requestReadGraphBuild).not.toHaveBeenCalled();
  });

  it('is asked for once after a retry that replaced graphs through the recovery store, though a later one replaced none', async () => {
    const { requestReadGraphBuild, recover } = executor();
    vi.mocked(recovery.recoverContextGraphSwm).mockResolvedValueOnce(round(1, false)).mockResolvedValueOnce(round(0));
    retries(2);
    await expect(recover()).resolves.toMatchObject({ completed: true, replacedGraphs: 0 });
    expect(requestReadGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('is asked for once when a retry wrote and the recovery then failed, and the failure stands', async () => {
    const { requestReadGraphBuild, recover } = executor();
    vi.mocked(recovery.recoverContextGraphSwm).mockResolvedValueOnce(round(1, false));
    retries(1, new Error('peer went away'));
    await expect(recover()).rejects.toThrow('peer went away');
    expect(requestReadGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('is asked for once when the materializer wrote a snapshot graph before its round failed', async () => {
    const { store, requestReadGraphBuild, recover } = executor();
    vi.mocked(recovery.recoverContextGraphSwm).mockImplementationOnce(async (options) => {
      await options.snapshotMaterializer!.replaceGraph(SNAPSHOT_GRAPH,
        [{ subject: 'urn:snapshot:s', predicate: 'urn:snapshot:p', object: '"written"', graph: SNAPSHOT_GRAPH }]);
      throw new Error('the next snapshot fetch failed');
    });
    retries(1);
    await expect(recover()).rejects.toThrow('the next snapshot fetch failed');
    expect(await store.countQuads(SNAPSHOT_GRAPH)).toBe(1);
    expect(requestReadGraphBuild).toHaveBeenCalledTimes(1);
  });

  it('is not asked for when the recovery failed before writing', async () => {
    const { requestReadGraphBuild, recover } = executor();
    retries(0, new Error('peer went away'));
    await expect(recover()).rejects.toThrow('peer went away');
    expect(requestReadGraphBuild).not.toHaveBeenCalled();
  });
});
