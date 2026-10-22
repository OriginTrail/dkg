import { describe, expect, it } from 'vitest';
import {
  getSyncCheckpointKey,
  MemorySyncCheckpointStore,
  type SyncCheckpointEntry,
} from '../src/sync/checkpoint/state.js';
import {
  durableBoundaryIdentity,
  preferVerifiedDurableBoundary,
  seedVerifiedDurableBoundary,
  takeRejectedResumeOffset,
  verifiedDurableBoundaryOf,
} from '../src/sync/durable-recovery-boundary-seed.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';
import {
  DurableRecoveryRunner,
  type DurableRecoveryRunnerDependencies,
} from '../src/sync/durable-recovery-runner.js';
import type { DurableMetaContinuation } from '../src/sync/requester/durable-sync.js';

const GRAPH = 'resume-across-peers';
const GENERATION = `sha256:${'a1'.repeat(32)}` as const;
const NEWER_GENERATION = `sha256:${'b2'.repeat(32)}` as const;
const PREFIX_10 = `sha256:${'c3'.repeat(32)}` as const;
const PREFIX_20 = `sha256:${'d4'.repeat(32)}` as const;

const dataKey = (peerId: string) => getSyncCheckpointKey(peerId, GRAPH, false, 'data');

type Slice = (
  peerId: string,
  store: MemorySyncCheckpointStore,
  continuation: DurableMetaContinuation,
) => Promise<ReturnType<typeof createIncompleteDurableSyncResult>>;

function runner(peers: string[], slices: Record<string, Slice[]>, store = new MemorySyncCheckpointStore()) {
  const atSliceStart: Array<{ peerId: string; checkpoint?: SyncCheckpointEntry }> = [];
  const info: string[] = [];
  const dependencies: DurableRecoveryRunnerDependencies = {
    checkpointStore: store,
    isRunning: () => true,
    resolvePreferredPeerId: async () => undefined,
    connectRequestedPeer: async () => {},
    primeConnections: async () => {},
    liveConnectionPeerIds: () => peers,
    admitPeer: async () => true,
    isPrivateContextGraph: async () => false,
    orderPeerIds: (peerIds) => [...peerIds],
    isSyncCapable: async () => true,
    executeSlice: async (peerId, continuation) => {
      atSliceStart.push({ peerId, checkpoint: store.get(dataKey(peerId)) });
      const next = slices[peerId]?.shift();
      if (!next) throw new Error(`no scripted slice left for ${peerId}`);
      return next(peerId, store, continuation);
    },
    logDebug: () => {},
    logInfo: (message) => { info.push(message); },
    logWarn: () => {},
  };
  return { store, atSliceStart, info, dependencies };
}

/** A slice that verified and stored the graphs up to `offset` of `GENERATION`. */
const advanceTo = (offset: number, prefix: `sha256:${string}`, terminal = false): Slice => async (peerId, store) => {
  store.setManifestBoundOffset(dataKey(peerId), offset, GENERATION, Date.now(), prefix, terminal);
  return { ...createIncompleteDurableSyncResult(), complete: terminal };
};
const failWith = (message: string): Slice => async () => { throw new Error(message); };
/** A DATA round whose rows did not start the next manifest graph after the boundary it resumed at. */
const refuseResume: Slice = async (peerId, store, continuation) => {
  const resumedAt = store.get(dataKey(peerId))?.offset ?? 0;
  store.delete(dataKey(peerId));
  continuation.rejectedResumeOffset = resumedAt;
  return { ...createIncompleteDurableSyncResult(), failedPhases: 1 };
};
const noProgress: Slice = async () => createIncompleteDurableSyncResult();

describe('durable recovery continues a verified prefix with another peer', () => {
  it('seeds the next peer with the verified boundary instead of row 0', async () => {
    const f = runner(['peer-aaaaaaaa', 'peer-bbbbbbbb'], {
      'peer-aaaaaaaa': [
        advanceTo(10, PREFIX_10),
        failWith('Graph-scoped durable authentication exceeded its context-graph deadline'),
      ],
      'peer-bbbbbbbb': [advanceTo(20, PREFIX_20, true)],
    });

    const execution = await new DurableRecoveryRunner().run({
      contextGraphId: GRAPH,
      dependencies: f.dependencies,
    });

    expect(execution.outcome).toBe('terminal');
    expect(f.atSliceStart.map(({ peerId }) => peerId))
      .toEqual(['peer-aaaaaaaa', 'peer-aaaaaaaa', 'peer-bbbbbbbb']);
    // Peer B starts at peer A's verified boundary, without a responder token,
    // so its first DATA round primes a fresh session and jumps there.
    expect(f.atSliceStart[2]!.checkpoint).toMatchObject({
      offset: 10,
      manifestDigest: GENERATION,
      manifestPrefixDigest: PREFIX_10,
    });
    expect(f.atSliceStart[2]!.checkpoint?.responderSessionId).toBeUndefined();
    expect(f.info).toContainEqual(expect.stringContaining('from verified offset 10'));
  });

  it('remembers the boundary for a later owner run and peers that are behind it', async () => {
    const recovery = new DurableRecoveryRunner();
    const first = runner(['peer-aaaaaaaa'], {
      'peer-aaaaaaaa': [advanceTo(10, PREFIX_10), failWith('store queue wait timeout')],
    });
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: first.dependencies })).outcome)
      .toBe('no-progress');

    // A later run sees only a peer whose own checkpoint is behind the boundary.
    const second = runner(['peer-cccccccc'], { 'peer-cccccccc': [advanceTo(20, PREFIX_20, true)] });
    second.store.setManifestBoundOffset(dataKey('peer-cccccccc'), 5, GENERATION, Date.now(), PREFIX_10);
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: second.dependencies })).outcome)
      .toBe('terminal');
    expect(second.atSliceStart[0]!.checkpoint).toMatchObject({ offset: 10, manifestPrefixDigest: PREFIX_10 });
  });

  it('stops seeding when a seeded peer refuses the boundary', async () => {
    const f = runner(['peer-aaaaaaaa', 'peer-bbbbbbbb', 'peer-cccccccc'], {
      'peer-aaaaaaaa': [advanceTo(10, PREFIX_10), failWith('peer reset')],
      'peer-bbbbbbbb': [refuseResume, noProgress],
      'peer-cccccccc': [advanceTo(20, PREFIX_20, true)],
    });

    const execution = await new DurableRecoveryRunner().run({ contextGraphId: GRAPH, dependencies: f.dependencies });

    expect(execution.outcome).toBe('terminal');
    // B is retried once from its own state; C starts from its own checkpoint.
    expect(f.atSliceStart.map(({ peerId, checkpoint }) => [peerId, checkpoint?.offset]))
      .toEqual([
        ['peer-aaaaaaaa', undefined],
        ['peer-aaaaaaaa', 10],
        ['peer-bbbbbbbb', 10],
        ['peer-bbbbbbbb', undefined],
        ['peer-cccccccc', undefined],
      ]);
  });

  it('retries a peer from row 0 after its rows refuse the boundary it resumed at', async () => {
    // One peer whose own verified checkpoint its rows no longer line up with.
    const f = runner(['peer-aaaaaaaa'], { 'peer-aaaaaaaa': [refuseResume, advanceTo(20, PREFIX_20, true)] });
    f.store.setManifestBoundOffset(dataKey('peer-aaaaaaaa'), 10, GENERATION, Date.now(), PREFIX_10);

    const execution = await new DurableRecoveryRunner().run({ contextGraphId: GRAPH, dependencies: f.dependencies });

    expect(execution.outcome).toBe('terminal');
    expect(f.atSliceStart.map(({ peerId, checkpoint }) => [peerId, checkpoint?.offset]))
      .toEqual([['peer-aaaaaaaa', 10], ['peer-aaaaaaaa', undefined]]);
  });

  it('never hands a peer the boundary it refused, in later runs either', async () => {
    const recovery = new DurableRecoveryRunner();
    const store = new MemorySyncCheckpointStore();
    // A advances to 10 and goes away; B refuses the seeded 10, and its retry makes no progress.
    const first = runner(['peer-aaaaaaaa', 'peer-bbbbbbbb'], {
      'peer-aaaaaaaa': [advanceTo(10, PREFIX_10), failWith('peer reset')],
      'peer-bbbbbbbb': [refuseResume, failWith('stream reset')],
    }, store);
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: first.dependencies })).outcome)
      .toBe('no-progress');
    expect(first.atSliceStart.map(({ peerId, checkpoint }) => [peerId, checkpoint?.offset]))
      .toEqual([
        ['peer-aaaaaaaa', undefined],
        ['peer-aaaaaaaa', 10],
        ['peer-bbbbbbbb', 10],
        ['peer-bbbbbbbb', undefined],
      ]);

    // Later calls see only B: it starts from its own state each time and completes.
    for (const slice of [noProgress, advanceTo(20, PREFIX_20, true)]) {
      const later = runner(['peer-bbbbbbbb'], { 'peer-bbbbbbbb': [slice] }, store);
      await recovery.run({ contextGraphId: GRAPH, dependencies: later.dependencies });
      expect(later.atSliceStart.map(({ checkpoint }) => checkpoint?.offset)).toEqual([undefined]);
    }
    expect(store.get(dataKey('peer-bbbbbbbb'))).toMatchObject({ offset: 20, terminal: true });
  });

  it('reads and clears the boundary a round refused', () => {
    const continuation: Pick<DurableMetaContinuation, 'rejectedResumeOffset'> = { rejectedResumeOffset: 10 };
    expect(takeRejectedResumeOffset(continuation)).toBe(10);
    expect(continuation.rejectedResumeOffset).toBeUndefined();
    expect(takeRejectedResumeOffset(continuation)).toBeUndefined();
    expect(takeRejectedResumeOffset(undefined)).toBeUndefined();
    expect(durableBoundaryIdentity(GENERATION, 10)).not.toBe(durableBoundaryIdentity(GENERATION, 20));
    expect(durableBoundaryIdentity(undefined, 10)).not.toBe(durableBoundaryIdentity(GENERATION, 10));
  });

  it('keeps a peer checkpoint that is already at or past the boundary', () => {
    const store = new MemorySyncCheckpointStore();
    const boundary = verifiedDurableBoundaryOf({
      offset: 10, updatedAtMs: 1, expiresAtMs: 2, manifestDigest: GENERATION, manifestPrefixDigest: PREFIX_10,
    });
    store.setManifestBoundOffset(dataKey('peer-dddddddd'), 10, GENERATION, Date.now(), PREFIX_10);
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-dddddddd'), boundary)).toBe(false);
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-eeeeeeee'), undefined)).toBe(false);
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-eeeeeeee'), boundary)).toBe(true);
    expect(store.get(dataKey('peer-eeeeeeee'))).toMatchObject({ offset: 10, manifestPrefixDigest: PREFIX_10 });
  });

  it('never gives a terminal boundary, which has no interrupted round to continue', async () => {
    const store = new MemorySyncCheckpointStore();
    store.setManifestBoundOffset(dataKey('peer-ffffffff'), 5, GENERATION, Date.now(), PREFIX_10);
    const terminal = verifiedDurableBoundaryOf({
      offset: 20, updatedAtMs: 1, expiresAtMs: 2, terminal: true, manifestDigest: GENERATION, manifestPrefixDigest: PREFIX_20,
    });
    expect(terminal?.terminal).toBe(true);
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-ffffffff'), terminal)).toBe(false);
    expect(store.get(dataKey('peer-ffffffff'))?.offset).toBe(5);

    // A completed recovery is remembered, but a later run does not hand it out.
    const recovery = new DurableRecoveryRunner();
    const done = runner(['peer-aaaaaaaa'], { 'peer-aaaaaaaa': [advanceTo(20, PREFIX_20, true)] });
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: done.dependencies })).outcome).toBe('terminal');
    const later = runner(['peer-bbbbbbbb'], { 'peer-bbbbbbbb': [advanceTo(20, PREFIX_20, true)] });
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: later.dependencies })).outcome).toBe('terminal');
    expect(later.atSliceStart[0]!.checkpoint).toBeUndefined();
  });

  it('prefers the further boundary of a generation and the latest verified generation', () => {
    const at = (manifestDigest: typeof GENERATION, offset: number, updatedAtMs: number) => verifiedDurableBoundaryOf({
      offset, updatedAtMs, expiresAtMs: updatedAtMs + 1, manifestDigest, manifestPrefixDigest: PREFIX_10,
    });
    expect(verifiedDurableBoundaryOf(undefined)).toBeUndefined();
    expect(verifiedDurableBoundaryOf({ offset: 0, updatedAtMs: 1, expiresAtMs: 2, manifestDigest: GENERATION,
      manifestPrefixDigest: PREFIX_10 })).toBeUndefined();
    expect(verifiedDurableBoundaryOf({ offset: 5, updatedAtMs: 1, expiresAtMs: 2 })).toBeUndefined();
    expect(preferVerifiedDurableBoundary(at(GENERATION, 10, 1), at(GENERATION, 20, 0))?.offset).toBe(20);
    expect(preferVerifiedDurableBoundary(at(GENERATION, 20, 0), at(GENERATION, 10, 5))?.offset).toBe(20);
    expect(preferVerifiedDurableBoundary(at(GENERATION, 900, 1), at(NEWER_GENERATION, 10, 2))?.manifestDigest)
      .toBe(NEWER_GENERATION);
    expect(preferVerifiedDurableBoundary(at(NEWER_GENERATION, 10, 2), at(GENERATION, 900, 1))?.manifestDigest)
      .toBe(NEWER_GENERATION);
    expect(preferVerifiedDurableBoundary(undefined, at(GENERATION, 10, 1))?.offset).toBe(10);
    expect(preferVerifiedDurableBoundary(at(GENERATION, 10, 1), undefined)?.offset).toBe(10);
  });
});
