import { durableRecoveryRoundOutcome, type DurableRecoveryRoundOutcome } from '../src/sync/durable-recovery-round.js';
import { describe, expect, it, vi } from 'vitest';
import * as accounting from '../src/sync/durable-recovery-peer-health.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';
import {
  DurableRecoveryRunner,
  type DurableRecoveryRunnerDependencies,
} from '../src/sync/durable-recovery-runner.js';
import type { MissingDurableAsset, DurableHoldingsOptions } from '../src/sync/requester/durable-data-holdings.js';

const GRAPH = 'missing-assets-graph';
const PEER = 'peer-missing-aaaaaaaa';
const GENERATION = `sha256:${'e5'.repeat(32)}` as const;
const PREFIX = `sha256:${'f6'.repeat(32)}` as const;
const dataKey = getSyncCheckpointKey(PEER, GRAPH, false, 'data');

type Round = (options: DurableHoldingsOptions, store: MemorySyncCheckpointStore) => Promise<DurableRecoveryRoundOutcome>;

const missing = (...assets: Array<[string, string]>): MissingDurableAsset[] => (
  assets.map(([ual, assertionVersion]) => ({ ual, assertionVersion }))
);

/** A round that found the rest of the generation held and left these batches to the owner. */
const leaves = (...batches: MissingDurableAsset[][]): Round => async (continuation) => {
  return durableRecoveryRoundOutcome(createIncompleteDurableSyncResult(), continuation.ownerFetchesMissingAssets
    ? { strategy: 'exact-missing', batches } : { strategy: 'full', continuation: 'full-graph' });
};
/** A round that found the whole generation held: it settles the terminal boundary. */
const held: Round = async (_continuation, store) => {
  store.setManifestBoundOffset(dataKey, 30, GENERATION, Date.now(), PREFIX, true);
  return durableRecoveryRoundOutcome({ ...createIncompleteDurableSyncResult(), completedPhases: 2, resumedPhases: 1, complete: true },
    { strategy: 'held' });
};
/** A bounded full-graph round that verified the rest of the graph. */
const pulledAll: Round = held;
/** A round that pulls the graph itself unless the owner fetches missing assets. */
const leavesOrPulls = (...batches: MissingDurableAsset[][]): Round => async (continuation, store) => (
  continuation.ownerFetchesMissingAssets ? leaves(...batches)(continuation, store) : pulledAll(continuation, store)
);

function runner(
  rounds: Round[],
  exact: (assetUals: readonly string[]) => Promise<boolean> = async () => true,
  withExactRequests = true,
  isRunning = () => true,
) {
  const store = new MemorySyncCheckpointStore();
  const offered: boolean[] = [];
  const exactRequests: string[][] = [];
  const warnings: string[] = [];
  const dependencies: DurableRecoveryRunnerDependencies = {
    checkpointStore: store,
    isRunning,
    resolvePreferredPeerId: async () => undefined,
    connectRequestedPeer: async () => {},
    primeConnections: async () => {},
    liveConnectionPeerIds: () => [PEER],
    admitPeer: async () => true,
    isPrivateContextGraph: async () => false,
    orderPeerIds: (peerIds) => [...peerIds],
    isSyncCapable: async () => true,
    executeSlice: async (_peerId, _meta, continuation) => {
      offered.push(continuation.ownerFetchesMissingAssets === true);
      const next = rounds.shift();
      if (!next) throw new Error('no scripted round left');
      return next(continuation, store);
    },
    ...(withExactRequests ? {
      executeExactSlice: async (_peerId: string, assetUals: readonly string[]) => {
        exactRequests.push([...assetUals]);
        const complete = await exact(assetUals);
        return { ...createIncompleteDurableSyncResult(), insertedDataTriples: complete ? 7 : 0, complete };
      },
    } : {}),
    logDebug: () => {},
    logInfo: () => {},
    logWarn: (message) => { warnings.push(message); },
  };
  return {
    offered,
    exactRequests,
    warnings,
    run: () => new DurableRecoveryRunner().run({ contextGraphId: GRAPH, dependencies }),
  };
}

describe('durable recovery fetches the assets a held generation lacks', () => {
  it('fetches the missing assets with exact requests, then confirms the generation', async () => {
    const f = runner([leaves(missing(['ual-1', '2'], ['ual-2', '1']), missing(['ual-9', '3'])), held]);

    const execution = await f.run();

    expect(execution.outcome).toBe('terminal');
    expect(f.exactRequests).toEqual([['ual-1', 'ual-2'], ['ual-9']]);
    expect(f.offered).toEqual([true, true]);
    expect(execution.slices).toBe(4);
    expect(execution.result.insertedDataTriples).toBe(14);
  });

  it.each([1, 2])('stays graph-incomplete when stopped after %s exact batches', async stopAfter => {
    let running = true, completed = 0;
    const f = runner([leaves(missing(['ual-1', '2']), missing(['ual-9', '3'])), held], async () => {
      if (++completed === stopAfter) running = false;
      return true;
    }, true, () => running);
    const execution = await f.run();
    expect(execution.outcome).toBe('no-progress');
    expect(execution.result.complete).toBe(false);
    expect(execution.result.insertedDataTriples).toBe(stopAfter * 7);
    expect(execution.peerResults).toHaveLength(1);
    expect(execution.peerResults[0]!.result.complete).toBe(false);
    expect(execution.peerResults[0]!.result.insertedDataTriples).toBe(stopAfter * 7);
    expect(f.exactRequests).toHaveLength(stopAfter);
    expect(f.offered).toEqual([true]);
  });

  it('preserves verified legacy completion without a rootless manifest checkpoint', async () => {
    const f = runner([async () => durableRecoveryRoundOutcome(
      { ...createIncompleteDurableSyncResult(), insertedDataTriples: 3, complete: true }, { strategy: 'legacy' },
    )]);
    const execution = await f.run();
    expect(execution.outcome).toBe('terminal');
    expect(execution.result.complete).toBe(true);
    expect(execution.peerResults[0]!.result.complete).toBe(true);
  });

  it('refuses graph readiness without a persisted terminal boundary', async () => {
    const f = runner([async () => durableRecoveryRoundOutcome({ ...createIncompleteDurableSyncResult(), complete: true }, { strategy: 'not-started' })]);
    const execution = await f.run();
    expect(execution.outcome).toBe('no-progress');
    expect(execution.result.complete).toBe(false);
    expect(execution.peerResults[0]!.result.complete).toBe(false);
  });

  it('pulls full-graph rounds for the rest of the run after an exact request fails', async () => {
    const f = runner(
      [leaves(missing(['ual-1', '2']), missing(['ual-2', '1'])), pulledAll],
      async () => false,
    );

    const execution = await f.run();

    expect(execution.outcome).toBe('terminal');
    // The second batch is not requested, and the next round is not offered exact requests.
    expect(f.exactRequests).toEqual([['ual-1']]);
    expect(f.offered).toEqual([true, false]);
    expect(f.warnings).toContainEqual(expect.stringContaining('did not store 1 missing asset(s)'));
  });

  it('treats a failed exact request like an incomplete one', async () => {
    const f = runner(
      [leaves(missing(['ual-1', '2'])), pulledAll],
      async () => { throw new Error('exact stream reset'); },
    );

    expect((await f.run()).outcome).toBe('terminal');
    expect(f.offered).toEqual([true, false]);
    expect(f.warnings).toContainEqual(expect.stringContaining('exact stream reset'));
  });

  it('never asks for an asset version again once an exact request stored it', async () => {
    const f = runner([
      leaves(missing(['ual-1', '2'])),
      // Stored, yet the next round still finds that version missing.
      leaves(missing(['ual-1', '2'])),
      pulledAll,
    ]);

    expect((await f.run()).outcome).toBe('terminal');
    expect(f.exactRequests).toEqual([['ual-1']]);
    expect(f.offered).toEqual([true, true, false]);
    expect(f.warnings).toContainEqual(expect.stringContaining('still lacks 1 asset version(s)'));
  });

  it('asks again for an asset that has a newer version since', async () => {
    const f = runner([leaves(missing(['ual-1', '2'])), leaves(missing(['ual-1', '3'])), held]);

    expect((await f.run()).outcome).toBe('terminal');
    expect(f.exactRequests).toEqual([['ual-1'], ['ual-1']]);
    expect(f.offered).toEqual([true, true, true]);
  });

  it('keeps pulling full-graph rounds once a run advanced one, as a first recovery does', async () => {
    let stored = 0;
    const advance: Round = async (continuation, store) => {
      // A first recovery: nothing held yet, so the round pulls the graph and checkpoints a prefix.
      if (stored === 0) {
        stored = 10;
        store.setManifestBoundOffset(dataKey, stored, GENERATION, Date.now(), PREFIX);
        return durableRecoveryRoundOutcome({ ...createIncompleteDurableSyncResult(), checkpointAdvances: 1 },
          { strategy: 'full', continuation: 'full-graph' });
      }
      return leavesOrPulls(missing(['ual-1', '1']))(continuation, store);
    };
    const f = runner([advance, advance]);

    expect((await f.run()).outcome).toBe('terminal');
    expect(f.offered).toEqual([true, false]);
    expect(f.exactRequests).toEqual([]);
  });

  it('uses the explicit reconsider policy after partial progress', async () => {
    const advance: Round = async (_continuation, store) => {
      store.setManifestBoundOffset(dataKey, 10, GENERATION, Date.now(), PREFIX);
      return durableRecoveryRoundOutcome({ ...createIncompleteDurableSyncResult(), checkpointAdvances: 1 },
        { strategy: 'full', continuation: 'reconsider-holdings' });
    };
    const f = runner([advance, leaves(missing(['ual-1', '2'])), held]);
    expect((await f.run()).outcome).toBe('terminal');
    expect(f.offered).toEqual([true, true, true]);
    expect(f.exactRequests).toEqual([['ual-1']]);
  });

  it('offers nothing to rounds when it cannot make exact requests', async () => {
    const f = runner([leavesOrPulls(missing(['ual-1', '2']))], undefined, false);

    // Not offered the missing assets, the round pulls the graph itself.
    expect((await f.run()).outcome).toBe('terminal');
    expect(f.offered).toEqual([false]);
    expect(f.exactRequests).toEqual([]);
  });
});


it.each([true, false])('accounts graph planning, exact success=%s and terminal completion once per action', async succeeds => {
  const updates: Array<{ kind: accounting.DurableRecoveryAccounting; health: accounting.MutableDurableRecoveryPeerHealth }> = [];
  const original = accounting.accountDurableRecoveryAction;
  const spy = vi.spyOn(accounting, 'accountDurableRecoveryAction').mockImplementation((health, kind, result, now) => {
    original(health, kind, result, now);
    updates.push({ kind, health: { ...health } });
  });
  try {
    const f = runner([leaves(missing(['ual-1', '2'])), held], async () => {
      if (!succeeds) throw new Error('transport reset');
      return true;
    });
    expect((await f.run()).outcome).toBe('terminal');
    expect(updates.map(row => row.kind)).toEqual(['success', succeeds ? 'success' : 'failure', 'terminal']);
    expect(updates[1]!.health).toMatchObject({ attempts: 2, successfulSlices: succeeds ? 2 : 1, recentTransportResets: succeeds ? 0 : 1 });
    expect(updates[2]!.health).toMatchObject({ attempts: 3, successfulSlices: succeeds ? 3 : 2, recentTransportResets: 0 });
  } finally { spy.mockRestore(); }
});
