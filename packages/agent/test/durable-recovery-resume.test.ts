import { durableRecoveryRoundOutcome, type DurableRecoveryRoundOutcome } from '../src/sync/durable-recovery-round.js';
import { resolveManifestResumePlan } from '../src/sync/requester/manifest-resume-policy.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_CHECKPOINT_TTL_MS,
  getSyncCheckpointKey,
  MemorySyncCheckpointStore,
  type SyncCheckpointEntry,
} from '../src/sync/checkpoint/state.js';
import {
  durableBoundaryIdentity,
  liveDurableBoundarySource,
  preferVerifiedDurableBoundary,
  eligibleDurableBoundarySource,
  type VerifiedDurableBoundary,
  verifiedDurableBoundaryOf,
} from '../src/sync/durable-recovery-boundary-seed.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';
import {
  DurableRecoveryRunner,
  type DurableRecoveryRunnerDependencies,
} from '../src/sync/durable-recovery-runner.js';
import { deleteSyncPageCheckpoint } from '../src/sync/requester/page-fetch.js';
import type { DurableMetaContinuation } from '../src/sync/requester/durable-sync.js';

const GRAPH = 'resume-across-peers';
const GENERATION = `sha256:${'a1'.repeat(32)}` as const;
const NEWER_GENERATION = `sha256:${'b2'.repeat(32)}` as const;
const PREFIX_10 = `sha256:${'c3'.repeat(32)}` as const;
const PREFIX_20 = `sha256:${'d4'.repeat(32)}` as const;

const dataKey = (peerId: string) => getSyncCheckpointKey(peerId, GRAPH, false, 'data');

// The runner fixture applies the same pure plan as paging after a simulated META proof.
const seedVerifiedDurableBoundary = (
  store: MemorySyncCheckpointStore, key: string, boundary: VerifiedDurableBoundary | undefined,
) => {
  const plan = resolveManifestResumePlan({ checkpoint: store.get(key),
    proposedCheckpoint: eligibleDurableBoundarySource(store, key, boundary),
    manifestDigest: GENERATION, prefixDigestAtOffset: () => boundary?.manifestPrefixDigest,
    hasExactAssetFilter: false, usesPageSession: true, nowMs: Date.now() });
  if (!plan.seeded) return false;
  const final = plan.checkpoint;
  deleteSyncPageCheckpoint(store, key);
  store.setManifestBoundOffset(key, final.offset, final.manifestDigest, final.updatedAtMs, final.manifestPrefixDigest);
  return true;
};

type Slice = (
  peerId: string,
  store: MemorySyncCheckpointStore,
  continuation: DurableMetaContinuation,
) => Promise<DurableRecoveryRoundOutcome>;

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
    executeSlice: async (peerId, continuation, _holdings, boundary) => {
      seedVerifiedDurableBoundary(store, dataKey(peerId), boundary);
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
  store.setManifestBoundOffset(dataKey(peerId), offset, GENERATION, undefined, prefix, terminal);
  return durableRecoveryRoundOutcome({ ...createIncompleteDurableSyncResult(), complete: terminal }, { strategy: 'full', continuation: 'full-graph' });
};
const failWith = (message: string): Slice => async () => { throw new Error(message); };
/** A DATA round whose rows did not start the next manifest graph after the boundary it resumed at. */
const refuseResume: Slice = async (peerId, store) => {
  const resumedAt = store.get(dataKey(peerId))?.offset ?? 0;
  store.delete(dataKey(peerId));
  return durableRecoveryRoundOutcome({ ...createIncompleteDurableSyncResult(), failedPhases: 1 },
    { strategy: 'full', continuation: 'full-graph', rejectedResumeOffset: resumedAt });
};
const noProgress: Slice = async () => durableRecoveryRoundOutcome(createIncompleteDurableSyncResult(), { strategy: 'not-started' });

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
    expect(f.info).toContainEqual(expect.stringContaining('verified offset 10'));
  });

  it('remembers the boundary for a later owner run and peers that are behind it', async () => {
    const recovery = new DurableRecoveryRunner();
    const store = new MemorySyncCheckpointStore();
    const first = runner(['peer-aaaaaaaa'], {
      'peer-aaaaaaaa': [advanceTo(10, PREFIX_10), failWith('store queue wait timeout')],
    }, store);
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: first.dependencies })).outcome)
      .toBe('no-progress');

    // A later run sees only a peer whose own checkpoint is behind the boundary.
    const second = runner(['peer-cccccccc'], { 'peer-cccccccc': [advanceTo(20, PREFIX_20, true)] }, store);
    store.setManifestBoundOffset(dataKey('peer-cccccccc'), 5, GENERATION, Date.now(), PREFIX_10);
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: second.dependencies })).outcome)
      .toBe('terminal');
    expect(second.atSliceStart[0]!.checkpoint).toMatchObject({ offset: 10, manifestPrefixDigest: PREFIX_10 });
  });

  it('forgets a remembered boundary once the checkpoint it came from is gone', async () => {
    let now = Date.now();
    const store = new MemorySyncCheckpointStore({ clock: () => now });
    const recovery = new DurableRecoveryRunner();
    const advanceAndLeave = () => recovery.run({
      contextGraphId: GRAPH,
      dependencies: runner(['peer-aaaaaaaa'], {
        'peer-aaaaaaaa': [advanceTo(10, PREFIX_10), failWith('store queue wait timeout')],
      }, store).dependencies,
    });
    const laterPeerStartsAt = async () => {
      const later = runner(['peer-cccccccc'], { 'peer-cccccccc': [noProgress] }, store);
      await recovery.run({ contextGraphId: GRAPH, dependencies: later.dependencies });
      return later.atSliceStart.map(({ checkpoint }) => checkpoint?.offset);
    };

    // Deleted: the boundary goes with the checkpoint that recorded it.
    expect((await advanceAndLeave()).outcome).toBe('no-progress');
    store.delete(dataKey('peer-aaaaaaaa'));
    expect(await laterPeerStartsAt()).toEqual([undefined]);

    // Expired: the boundary is not handed out again with a fresh lifetime.
    expect((await advanceAndLeave()).outcome).toBe('no-progress');
    now += DEFAULT_SYNC_CHECKPOINT_TTL_MS + 1;
    expect(await laterPeerStartsAt()).toEqual([undefined]);
    expect(store.get(dataKey('peer-cccccccc'))).toBeUndefined();
  });

  it('gives a boundary only while its checkpoint records it, and only for that checkpoint\'s lifetime', () => {
    let now = Date.now();
    const store = new MemorySyncCheckpointStore({ clock: () => now });
    const sourceKey = dataKey('peer-aaaaaaaa');
    store.setManifestBoundOffset(sourceKey, 10, GENERATION, undefined, PREFIX_10);
    const source = store.get(sourceKey)!;
    const boundary = verifiedDurableBoundaryOf(source, sourceKey);
    expect(liveDurableBoundarySource(store, boundary)).toEqual(source);
    expect(liveDurableBoundarySource(store, undefined)).toBeUndefined();

    // Seeded halfway through the source's lifetime, the copy expires with the source.
    now += DEFAULT_SYNC_CHECKPOINT_TTL_MS / 2;
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-bbbbbbbb'), boundary)).toBe(true);
    expect(store.get(dataKey('peer-bbbbbbbb'))).toMatchObject({
      offset: 10, updatedAtMs: source.updatedAtMs, expiresAtMs: source.expiresAtMs,
    });
    now = source.expiresAtMs + 1;
    expect(store.get(dataKey('peer-bbbbbbbb'))).toBeUndefined();
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-bbbbbbbb'), boundary)).toBe(false);
    expect(store.get(dataKey('peer-bbbbbbbb'))).toBeUndefined();

    // A checkpoint that moved on no longer records the boundary read from it.
    store.setManifestBoundOffset(sourceKey, 10, GENERATION, undefined, PREFIX_10);
    const recorded = verifiedDurableBoundaryOf(store.get(sourceKey), sourceKey);
    store.setManifestBoundOffset(sourceKey, 20, GENERATION, undefined, PREFIX_20);
    expect(liveDurableBoundarySource(store, recorded)).toBeUndefined();
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-cccccccc'), recorded)).toBe(false);
    expect(store.get(dataKey('peer-cccccccc'))).toBeUndefined();
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

  it('identifies refused boundaries by generation and offset', () => {
    expect(durableBoundaryIdentity(GENERATION, 10)).not.toBe(durableBoundaryIdentity(GENERATION, 20));
    expect(durableBoundaryIdentity(undefined, 10)).not.toBe(durableBoundaryIdentity(GENERATION, 10));
  });

  it('keeps a peer checkpoint that is already at or past the boundary', () => {
    const store = new MemorySyncCheckpointStore();
    store.setManifestBoundOffset(dataKey('peer-aaaaaaaa'), 10, GENERATION, undefined, PREFIX_10);
    const boundary = verifiedDurableBoundaryOf(store.get(dataKey('peer-aaaaaaaa')), dataKey('peer-aaaaaaaa'));
    store.setManifestBoundOffset(dataKey('peer-dddddddd'), 10, GENERATION, Date.now(), PREFIX_10);
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-dddddddd'), boundary)).toBe(false);
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-eeeeeeee'), undefined)).toBe(false);
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-eeeeeeee'), boundary)).toBe(true);
    expect(store.get(dataKey('peer-eeeeeeee'))).toMatchObject({ offset: 10, manifestPrefixDigest: PREFIX_10 });
  });

  it('never gives a terminal boundary, which has no interrupted round to continue', async () => {
    const store = new MemorySyncCheckpointStore();
    store.setManifestBoundOffset(dataKey('peer-ffffffff'), 5, GENERATION, Date.now(), PREFIX_10);
    store.setManifestBoundOffset(dataKey('peer-aaaaaaaa'), 20, GENERATION, Date.now(), PREFIX_20, true);
    const terminal = verifiedDurableBoundaryOf(store.get(dataKey('peer-aaaaaaaa')), dataKey('peer-aaaaaaaa'));
    expect(liveDurableBoundarySource(store, terminal)).toBeDefined();
    expect(terminal?.terminal).toBe(true);
    expect(seedVerifiedDurableBoundary(store, dataKey('peer-ffffffff'), terminal)).toBe(false);
    expect(store.get(dataKey('peer-ffffffff'))?.offset).toBe(5);

    // A completed recovery is remembered, but a later run does not hand it out.
    const recovery = new DurableRecoveryRunner();
    const done = runner(['peer-aaaaaaaa'], { 'peer-aaaaaaaa': [advanceTo(20, PREFIX_20, true)] }, store);
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: done.dependencies })).outcome).toBe('terminal');
    const later = runner(['peer-bbbbbbbb'], { 'peer-bbbbbbbb': [advanceTo(20, PREFIX_20, true)] }, store);
    expect((await recovery.run({ contextGraphId: GRAPH, dependencies: later.dependencies })).outcome).toBe('terminal');
    expect(later.atSliceStart[0]!.checkpoint).toBeUndefined();
  });

  it('prefers the further boundary of a generation and the latest verified generation', () => {
    const source = dataKey('peer-aaaaaaaa');
    const at = (manifestDigest: typeof GENERATION, offset: number, updatedAtMs: number) => verifiedDurableBoundaryOf({
      offset, updatedAtMs, expiresAtMs: updatedAtMs + 1, manifestDigest, manifestPrefixDigest: PREFIX_10,
    }, source);
    expect(verifiedDurableBoundaryOf(undefined, source)).toBeUndefined();
    expect(verifiedDurableBoundaryOf({ offset: 0, updatedAtMs: 1, expiresAtMs: 2, manifestDigest: GENERATION,
      manifestPrefixDigest: PREFIX_10 }, source)).toBeUndefined();
    expect(verifiedDurableBoundaryOf({ offset: 5, updatedAtMs: 1, expiresAtMs: 2 }, source)).toBeUndefined();
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
