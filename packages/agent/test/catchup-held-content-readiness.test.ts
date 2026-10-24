// The agent's own catch-up (`runCatchupOverPeers`: name resolution, the
// post-approval sync, the inline runner) marked a graph synced only when a peer
// round inserted data (issue #3296). A member that already held every asset its
// peer served stayed `synced: false`. A clean round that finds nothing missing
// now proves the shared-memory plane, on the first walk and on a continuation
// pass, and the daemon is told so; a round that left an asset to the catalog
// lane, left a ref unwritten or failed proves nothing.
import { describe, expect, it } from 'vitest';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { emptySharedMemorySyncResult, type SwmSnapshotCoverage } from '../src/sync/shared-memory-diagnostics.js';
import { createUnstartedAgent, emptyDetailedSync } from './_helpers/sync-on-connect-test-fixture.js';

const PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const CG = 'held-content-catchup-cg';

function coverage(resolved: number, total = 3): SwmSnapshotCoverage {
  return {
    contextGraphId: CG,
    peerIdSuffix: PEER.slice(-8),
    snapshotsResolved: resolved,
    snapshotsTotal: total,
    manifestComplete: true,
    descriptorsAuthoritative: true,
    missingCount: total - resolved,
    missingSample: resolved < total ? ['sha256:missing'] : [],
    materializationFailures: 0,
  };
}

/** The member's SWM round when every asset the peer serves is already held here. */
function heldRound(overrides: Record<string, unknown> = {}) {
  return {
    ...emptySharedMemorySyncResult(),
    fetchedMetaTriples: 19,
    completedPhases: 2,
    alreadyHeldAssets: 3,
    catalogDeferredAssets: 0,
    swmCoverage: coverage(3),
    ...overrides,
  };
}

/** A member of `CG` whose one peer answers `rounds`, one per SWM call. */
async function member(name: string, rounds: Array<Record<string, unknown>>) {
  const agent = await createUnstartedAgent(name);
  agent.subscribedContextGraphs.set(CG, { subscribed: true, synced: false, sharedMemorySynced: false });
  agent.persistLocalNodeMembership = () => undefined;
  agent.refreshMetaSyncedFlags = async () => undefined;
  agent.waitForSyncProtocol = async () => true;
  // The durable plane completes and holds nothing to prove.
  agent.syncFromPeerDetailed = async () => emptyDetailedSync({ completedPhases: 1 });
  let call = 0;
  agent.syncSharedMemoryFromPeerDetailed = async () => rounds[Math.min(call++, rounds.length - 1)]!;
  const synced: unknown[] = [];
  agent.eventBus.on(DKGEvent.PROJECT_SYNCED, (data: unknown) => { synced.push(data); });
  const catchUp = (maxPasses = 1) => agent.runCatchupOverPeers(
    CG,
    true,
    [{ toString: () => PEER }],
    { swmCatchupPassConfig: { budgetMs: 60_000, maxPasses } },
  );
  return { agent, synced, catchUp, calls: () => call };
}

describe('the inline catch-up of a member that already holds the graph (#3296)', () => {
  it('proves the shared-memory plane from a clean round that found nothing missing', async () => {
    const m = await member('HeldContentFirstWalk', [heldRound()]);

    const result = await m.catchUp();

    expect(result).toMatchObject({ dataSynced: 0, sharedMemorySynced: 0, sharedMemoryCompletedCleanly: true });
    expect(m.agent.subscribedContextGraphs.get(CG)).toMatchObject({ synced: true, sharedMemorySynced: true });
    expect(m.synced).toEqual([expect.objectContaining({
      contextGraphId: CG, dataSynced: 0, sharedMemorySynced: 0, sharedMemoryHeldAssets: 3,
    })]);
  });

  it('proves it from a continuation pass that found the rest already held', async () => {
    // Pass 1 ran out of its local budget with one ref missing; by pass 2 that
    // asset had arrived by gossip, so the pass inserts nothing.
    const yielded = heldRound({
      alreadyHeldAssets: 2, failedPhases: 1, localYield: true, snapshotPlaneIncomplete: 1, swmCoverage: coverage(2),
    });
    const m = await member('HeldContentContinuation', [yielded, heldRound()]);

    const result = await m.catchUp(2);

    expect(m.calls()).toBe(2);
    expect(result.diagnostics.sharedMemory.continuationPasses).toBe(1);
    expect(m.agent.subscribedContextGraphs.get(CG)).toMatchObject({ synced: true, sharedMemorySynced: true });
    expect(m.synced).toEqual([expect.objectContaining({ sharedMemoryHeldAssets: 3 })]);
  });

  it.each([
    ['left a root asset to the catalog lane', heldRound({ catalogDeferredAssets: 1 })],
    ['kept a newer stored head without its content', heldRound({ supersededUnprovenAssets: 1 })],
    ['left a ref of its manifest unwritten', heldRound({ swmCoverage: coverage(2) })],
    ['failed a phase', heldRound({ failedPhases: 1 })],
    ['served no asset', heldRound({ alreadyHeldAssets: 0, swmCoverage: undefined })],
  ])('proves nothing from a round that %s', async (_name, round) => {
    const m = await member('HeldContentRefused', [round]);

    const result = await m.catchUp();

    expect(result.sharedMemoryCompletedCleanly).toBe(false);
    expect(m.agent.subscribedContextGraphs.get(CG)).toMatchObject({ synced: false, sharedMemorySynced: false });
    expect(m.synced).toEqual([]);
  });
});
