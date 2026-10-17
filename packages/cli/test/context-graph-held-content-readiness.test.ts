// A member that already held a graph's data stayed `synced: false` (issue
// #3296). Its writes arrived by gossip or by an earlier pull before the
// catch-up ran, so the catch-up's peers served content the node already had:
// nothing was inserted, and readiness counted only inserted data. Seen on a
// devnet as "SWM sync for <graph>: 0 data + 19 meta triples" with the listing
// at `subscribed=true synced=false`, and again after a restart.
//
// A catch-up that completes against a capable peer and finds nothing missing
// proves the graph synced. A failed or partial catch-up, one with no capable
// peer, or one that left an asset to another lane does not.
//
// First: the harness mocks `node:worker_threads`, so the catch-up runner loaded
// below runs its real worker in this thread.
import './helpers/catchup-runner-worker-test-harness.js';
import { emptySharedMemorySyncResult } from '@origintrail-official/dkg-agent';
import { createIncompleteDurableSyncResult } from '@origintrail-official/dkg-agent/dist/sync/durable-progress.js';
import { recordSharedMemoryPhaseFailure } from '@origintrail-official/dkg-agent/dist/sync/shared-memory-diagnostics.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { CatchupRunner } from '../src/catchup-runner.js';
import { CG, PEERS, PUBLIC_UNREGISTERED, memberEdge } from './_helpers/readiness-member-edge.js';
import { emptyCatchupTracker, nextFinishedJob, startReadinessRoutes } from './_helpers/readiness-subscribe-routes.js';

await import('../src/catchup-runner-worker-impl.js');
const { createCatchupRunner } = await import('../src/catchup-runner.js');
const { daemonState } = await import('../src/daemon/state.js');
const { readinessRepeatTimers, cancelContextGraphReadinessRepeats } =
  await import('../src/daemon/context-graph-readiness-repeat.js');
const { startActivationCatchups } = await import('../src/daemon/context-graph-activation-catchup.js');

/** Admission of a public graph registered on chain: its finalized public policy. */
const REGISTERED_PUBLIC = Object.freeze({
  outcome: 'allowed', source: 'registered-chain', reason: 'chain-public',
  metadataBootstrap: 'eligible', grantScope: 'public',
});

/** Admission of a member of a private graph registered on chain. */
const REGISTERED_PRIVATE = Object.freeze({
  outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
  metadataBootstrap: 'eligible', grantScope: 'caller',
});

/** Knowledge Assets each peer serves; the member holds every one already. */
const HELD = 3;

/** The peer's complete snapshot manifest, every ref already materialized here. */
function coverage(peerId: string, missing = 0) {
  return {
    contextGraphId: CG,
    peerIdSuffix: peerId,
    snapshotsResolved: HELD - missing,
    snapshotsTotal: HELD,
    manifestComplete: true,
    descriptorsAuthoritative: true,
    missingCount: missing,
    missingSample: missing > 0 ? ['ref-missing'] : [],
    materializationFailures: 0,
  };
}

/**
 * A public peer's selected round when the member already holds the graph: the
 * metadata and the snapshot manifest arrive, every asset they name is already
 * in the local store, and nothing is inserted.
 */
function heldPublicRound(peerId: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'selected-shared-memory',
    shared: {
      ...emptySharedMemorySyncResult(),
      fetchedMetaTriples: 19,
      bytesReceived: 4_096,
      completedPhases: 2,
      alreadyHeldAssets: HELD,
      swmCoverage: coverage(peerId),
      ...overrides,
    },
    scopeComplete: false,
  };
}

/**
 * A private recovery round when the member already holds every asset the
 * curator serves. The private lane re-applies each held asset under its lock
 * and reports its public quads as inserted, so this round also carries data.
 */
function heldPrivateRound(overrides: Record<string, unknown> = {}) {
  return {
    ...emptySharedMemorySyncResult(),
    completedPhases: 1,
    insertedDataTriples: HELD,
    insertedMetaTriples: 17,
    insertedTriples: HELD + 17,
    alreadyHeldAssets: HELD,
    ...overrides,
  };
}

/** The curator of a private graph with nothing in Verified Memory: its `_meta` only. */
function metadataOnlyDurable() {
  return {
    ...createIncompleteDurableSyncResult(),
    complete: true,
    fetchedMetaTriples: 7,
    insertedMetaTriples: 7,
    insertedTriples: 7,
    metaOnlyResponses: 1,
    completedPhases: 1,
    bytesReceived: 512,
  };
}

/** A sync that never reached the peer. */
function transportFailure() {
  return emptySharedMemorySyncResult(1);
}

/** A round this node cut short: its local budget ran out with refs still missing. */
function yieldedPublicRound(peerId: string) {
  const round = heldPublicRound(peerId, { swmCoverage: coverage(peerId, 1) });
  recordSharedMemoryPhaseFailure(round.shared, 'local-budget');
  return round;
}

describe('a member that already holds the graph is proven synced by a catch-up that finds nothing missing', () => {
  const previousRunner = daemonState.catchupRunner;
  const originalTimers = { set: readinessRepeatTimers.set, clear: readinessRepeatTimers.clear };
  const servers: Server[] = [];
  const runners: CatchupRunner[] = [];
  const stops: Array<() => void> = [];

  beforeEach(() => {
    // A graph left unproven arms a repeat; keep it from running on a real timer.
    readinessRepeatTimers.set = () => ({});
    readinessRepeatTimers.clear = () => {};
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop();
    cancelContextGraphReadinessRepeats();
    readinessRepeatTimers.set = originalTimers.set;
    readinessRepeatTimers.clear = originalTimers.clear;
    daemonState.catchupRunner = previousRunner;
    for (const runner of runners.splice(0)) await runner.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  type Member = ReturnType<typeof memberEdge>;

  /** A member of a public graph, registered on chain or not; its peers answer `answer`. */
  function publicMember(authority: Record<string, unknown>, answer: (peerId: string) => unknown) {
    const member = memberEdge();
    member.node.authority = authority;
    member.node.answer = answer;
    return withRunner(member);
  }

  /**
   * A member of a private graph. Its curator holds nothing in Verified Memory
   * yet, so the durable plane answers with the graph's `_meta` only, which can
   * never prove a private graph; the private shared-memory lane answers `answer`.
   */
  function privateMember(answer: (peerId: string) => unknown) {
    const member = memberEdge();
    member.node.authority = REGISTERED_PRIVATE;
    const agent = member.agent as any;
    agent.isPrivateContextGraph = async () => true;
    agent.canUseLegacyDurableSyncForContextGraphV1 = async () => true;
    agent.syncDurableRecoveryContextGraph = async () => ({ result: metadataOnlyDurable() });
    agent.syncSharedMemoryFromPeerDetailed = async (peerId: string) => answer(peerId);
    agent.syncSelectedSharedMemoryFromPeerDetailed = async () => {
      throw new Error('a private graph has no selected public lane');
    };
    return withRunner(member);
  }

  function withRunner(member: Member): Member {
    const runner = createCatchupRunner(member.agent);
    runners.push(runner);
    daemonState.catchupRunner = runner;
    return member;
  }

  /** Subscribe `member`; resolves with the job once it has finished. */
  const subscribe = async (member: Member) => (await startReadinessRoutes(member, servers)).subscribe();

  it.each([
    ['registered on chain', REGISTERED_PUBLIC],
    ['not registered', PUBLIC_UNREGISTERED],
  ])('public graph %s: every peer serves only what the member holds', async (_name, authority) => {
    const member = publicMember(authority, (peerId) => heldPublicRound(peerId));

    const job = await subscribe(member);

    expect(job.result?.sharedMemorySynced).toBe(0);
    expect(job.result?.cleanPlaneCompletions?.sharedMemory)
      .toMatchObject({ verifiedDataPeers: 0, emptyPeers: 0, heldContentPeers: PEERS.length });
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: true, sharedMemorySynced: true });
    expect(member.readiness()).toMatchObject({ version: 1, sharedMemoryVerified: true });
  });

  it('private graph: the curator serves only what the member holds', async () => {
    // Already proven before #3296: the private lane counts re-applied held
    // assets as inserted. Kept so the rule is pinned for all three graph types.
    const member = privateMember(() => heldPrivateRound());

    const job = await subscribe(member);

    expect(job.result?.dataSynced).toBe(0);
    expect(job.result?.cleanPlaneCompletions?.sharedMemory).toMatchObject({ heldContentPeers: PEERS.length });
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: true, sharedMemorySynced: true });
    expect(member.readiness()).toMatchObject({ version: 1, durableVerified: false, sharedMemoryVerified: true });
  });

  it('after a restart: the job that catches up the restored subscription finds nothing missing', async () => {
    const member = publicMember(REGISTERED_PUBLIC, (peerId) => heldPublicRound(peerId));
    member.restore({
      subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: true, syncMode: 'always-on',
    });
    const catchupTracker = emptyCatchupTracker();
    stops.push(startActivationCatchups({
      agent: member.agent, store: member.store, catchupTracker, log: () => {},
    }));

    await nextFinishedJob(catchupTracker);

    expect(member.subscription()).toMatchObject({ subscribed: true, synced: true, sharedMemorySynced: true });
  });

  it('one peer that finds nothing missing proves the graph although another peer failed', async () => {
    const member = publicMember(REGISTERED_PUBLIC, (peerId) => (
      peerId === 'peer-1' ? heldPublicRound(peerId) : { kind: 'selected-shared-memory', shared: transportFailure(), scopeComplete: false }
    ));

    await subscribe(member);

    expect(member.subscription()).toMatchObject({ synced: true, sharedMemorySynced: true });
  });

  describe('leaves the graph unsynced when data may be missing', () => {
    const cases: Array<[string, () => Member]> = [
      ['every peer failed', () => publicMember(REGISTERED_PUBLIC, () => (
        { kind: 'selected-shared-memory', shared: transportFailure(), scopeComplete: false }
      ))],
      ['the round was cut short with an asset still missing', () => publicMember(
        PUBLIC_UNREGISTERED, (peerId) => yieldedPublicRound(peerId),
      )],
      ['a clean round reports a ref it could not materialize', () => publicMember(
        PUBLIC_UNREGISTERED, (peerId) => heldPublicRound(peerId, { swmCoverage: coverage(peerId, 1) }),
      )],
      ['a round left a root asset to the catalog lane', () => publicMember(
        PUBLIC_UNREGISTERED, (peerId) => heldPublicRound(peerId, { catalogDeferredAssets: 1 }),
      )],
      ['a round kept a newer stored head without its content', () => publicMember(
        PUBLIC_UNREGISTERED, (peerId) => heldPublicRound(peerId, { supersededUnprovenAssets: 1 }),
      )],
      ['the peers served metadata and no asset', () => publicMember(
        PUBLIC_UNREGISTERED, (peerId) => heldPublicRound(peerId, { alreadyHeldAssets: 0, swmCoverage: undefined }),
      )],
      ['the private round did not complete', () => privateMember(() => {
        const round = heldPrivateRound({ completedPhases: 0 });
        recordSharedMemoryPhaseFailure(round, 'transport');
        return round;
      })],
      ['no peer speaks the sync protocol', () => {
        const member = publicMember(REGISTERED_PUBLIC, (peerId) => heldPublicRound(peerId));
        (member.agent as any).waitForSyncProtocol = async () => false;
        return member;
      }],
      ['no peer is connected', () => {
        const member = publicMember(REGISTERED_PUBLIC, (peerId) => heldPublicRound(peerId));
        (member.agent as any).listAdmittedConnectedPeers = async () => [];
        return member;
      }],
    ];

    it.each(cases)('%s', async (_name, setup) => {
      const member = setup();

      await subscribe(member);

      expect(member.subscription()).toMatchObject({ subscribed: true, synced: false });
      expect(member.readiness()?.sharedMemoryVerified ?? false).toBe(false);
    });
  });
});
