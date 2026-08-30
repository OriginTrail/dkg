// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  contextGraphDataUri,
  createOperationContext,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { signAgentPeerIdBinding } from '../src/profile.js';
import {
  getSyncCheckpointKey,
  MemorySyncCheckpointStore,
} from '../src/sync/checkpoint/state.js';
import {
  AuthoritativeGraphSnapshotMaterializer,
  reconcileAgentRegistrySnapshot,
} from '../src/sync/requester/authoritative-graph-snapshot.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const contextGraphId = SYSTEM_CONTEXT_GRAPHS.AGENTS;
const graph = contextGraphDataUri(contextGraphId);
const remotePeerId = '12D3KooWAuthoritativeAgentsPeer';
const ownedRoot = `did:dkg:agent:${remotePeerId}`;
const otherPeerId = '12D3KooWOtherAgentsPeer';
const otherRoot = `did:dkg:agent:${otherPeerId}`;
const peerIdPredicate = 'https://dkg.network/ontology#peerId';
const lastSeenPredicate = 'https://dkg.network/ontology#lastSeen';
const multiaddrPredicate = 'https://dkg.network/ontology#multiaddr';
const peerIdProofPredicate = 'https://dkg.network/ontology#peerIdProof';
const checkpointKey = getSyncCheckpointKey(remotePeerId, contextGraphId, false, 'data');

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph };
}

function profile(root: string, peerId: string, lastSeen: string, multiaddr: string): Quad[] {
  return [
    quad(root, peerIdPredicate, `"${peerId}"`),
    quad(root, lastSeenPredicate, `"${lastSeen}"`),
    quad(root, multiaddrPredicate, `"${multiaddr}"`),
  ];
}

function page(input: {
  quads: Quad[];
  resumedFromOffset: number;
  nextOffset: number;
  completed: boolean;
  timedOut: boolean;
}): SyncPageResult {
  return {
    ...input,
    rawResumedFromOffset: input.resumedFromOffset,
    rawNextOffset: input.nextOffset,
    bytesReceived: input.quads.length,
    checkpointKey,
  };
}

async function graphQuads(store: OxigraphStore): Promise<Quad[]> {
  const result = await store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
  );
  if (result.type !== 'bindings') return [];
  return result.bindings.map((row) => ({
    subject: row['s']!,
    predicate: row['p']!,
    object: row['o']!,
    graph,
  }));
}

async function createHarness(responses: SyncPageResult[], initial: Quad[] = []) {
  const syncCheckpoints = new MemorySyncCheckpointStore();
  const authoritativeAgentSnapshots = new AuthoritativeGraphSnapshotMaterializer(syncCheckpoints);
  const store = new OxigraphStore();
  await store.insert(initial);
  const replaceSubjectPrefix = vi.spyOn(store, 'replaceSubjectPrefix');
  const markAllDirty = vi.fn();
  let responseIndex = 0;
  const agentLike: any = {
    config: { syncAgentsMeta: false },
    store,
    syncCheckpoints,
    authoritativeAgentSnapshots,
    fetchSyncPages: async (
      _ctx: unknown,
      _peerId: string,
      _contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (phase !== 'data') throw new Error(`Unexpected ${phase} fetch`);
      const response = responses[responseIndex++];
      if (!response) throw new Error('No controlled DATA response remains');
      syncCheckpoints.setResponderSession(
        response.checkpointKey,
        'immutable-agents-session',
        Date.now() + 60_000,
        Date.now(),
        undefined,
        undefined,
        response.rawNextOffset ?? response.nextOffset,
      );
      return response;
    },
    processDurableBatchInWorker: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
      verifiedData: dataQuads,
      verifiedMeta: metaQuads,
      consumedUnpersistedMetaTriples: 0,
      totalFetchedDataQuads: dataQuads.length,
      totalFetchedMetaQuads: metaQuads.length,
      rejectedKcs: 0,
      emptyResponses: dataQuads.length === 0 && metaQuads.length === 0 ? 1 : 0,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    }),
    insertSyncedQuadsAndInvalidateListCache: vi.fn(async (quads: Quad[]) => store.insert(quads)),
    oversizeTombstoneLog: { record: vi.fn() },
    invalidateListContextGraphsCache: vi.fn(),
    contextGraphMetaProjection: { markAllDirty },
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const run = () => LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
    agentLike,
    createOperationContext('sync'),
    remotePeerId,
    contextGraphId,
    1,
  );
  return {
    run,
    replaceSubjectPrefix,
    markAllDirty,
    syncCheckpoints,
    authoritativeAgentSnapshots,
    live: () => graphQuads(store),
  };
}

describe('authority-scoped AGENTS durable snapshot materialization', () => {
  it('discards retained bytes when the responder session is superseded', async () => {
    const checkpoints = new MemorySyncCheckpointStore();
    const materializer = new AuthoritativeGraphSnapshotMaterializer(checkpoints);
    const partial = page({
      quads: [quad(ownedRoot, peerIdPredicate, `"${remotePeerId}"`)],
      resumedFromOffset: 0,
      nextOffset: 1,
      completed: false,
      timedOut: true,
    });
    checkpoints.setResponderSession(
      checkpointKey,
      'session-a',
      Date.now() + 60_000,
      Date.now(),
      undefined,
      undefined,
      1,
    );
    await materializer.materialize({
      page: partial,
      verifiedQuads: partial.quads,
      retainablePrefix: true,
      completeSnapshot: false,
      commit: vi.fn(),
      transitionCheckpoint: (decision) => {
        expect(decision).toBe('advance');
        checkpoints.set(checkpointKey, 1, Date.now(), 1);
      },
    });
    checkpoints.setResponderSession(
      checkpointKey,
      'session-b',
      Date.now() + 60_000,
      Date.now(),
      undefined,
      undefined,
      1,
    );

    materializer.prepareFetch(checkpointKey);

    expect(materializer.retainedTriples(checkpointKey)).toBe(0);
    expect(checkpoints.get(checkpointKey)).toBeUndefined();
  });

  it('rolls retained state and its requester checkpoint back together on a failed transition', async () => {
    const checkpoints = new MemorySyncCheckpointStore();
    const materializer = new AuthoritativeGraphSnapshotMaterializer(checkpoints);
    const partial = page({
      quads: [quad(ownedRoot, peerIdPredicate, `"${remotePeerId}"`)],
      resumedFromOffset: 0,
      nextOffset: 1,
      completed: false,
      timedOut: true,
    });
    checkpoints.setResponderSession(
      checkpointKey,
      'session-failure',
      Date.now() + 60_000,
      Date.now(),
      undefined,
      undefined,
      1,
    );

    await expect(materializer.materialize({
      page: partial,
      verifiedQuads: partial.quads,
      retainablePrefix: true,
      completeSnapshot: false,
      commit: vi.fn(),
      transitionCheckpoint: () => { throw new Error('injected checkpoint failure'); },
    })).rejects.toThrow('injected checkpoint failure');

    expect(materializer.retainedTriples(checkpointKey)).toBe(0);
    expect(checkpoints.get(checkpointKey)).toBeUndefined();
  });

  it('prunes only expired retained snapshots and their paired requester checkpoints', async () => {
    const checkpoints = new MemorySyncCheckpointStore({ clock: () => 100, ttlMs: 10_000 });
    const materializer = new AuthoritativeGraphSnapshotMaterializer(checkpoints);
    const partial = page({
      quads: [quad(ownedRoot, peerIdPredicate, `"${remotePeerId}"`)],
      resumedFromOffset: 0,
      nextOffset: 1,
      completed: false,
      timedOut: true,
    });
    checkpoints.setResponderSession(
      checkpointKey,
      'session-expiring',
      1_000,
      100,
      undefined,
      undefined,
      1,
    );
    await materializer.materialize({
      page: partial,
      verifiedQuads: partial.quads,
      retainablePrefix: true,
      completeSnapshot: false,
      commit: vi.fn(),
      transitionCheckpoint: () => checkpoints.set(checkpointKey, 1, 100, 1),
    });

    expect(materializer.pruneExpired(999)).toBe(0);
    expect(materializer.retainedTriples(checkpointKey)).toBe(1);
    expect(checkpoints.get(checkpointKey)).toBeDefined();
    expect(materializer.pruneExpired(1_001)).toBe(1);
    expect(materializer.retainedTriples(checkpointKey)).toBe(0);
    expect(checkpoints.get(checkpointKey)).toBeUndefined();
  });

  it('replaces only the authenticated responder profile and invalidates removed policies', async () => {
    const oldOwned = profile(ownedRoot, remotePeerId, '2026-08-29T00:00:00.000Z', '/ip4/old');
    const oldCapability = quad(
      `${ownedRoot}/.well-known/genid/cap1`,
      'https://schema.org/name',
      '"obsolete-capability"',
    );
    const oldKey = quad(
      `${ownedRoot}#x25519-obsolete`,
      'https://dkg.network/ontology#revokedAt',
      '"2026-08-29T00:00:00.000Z"',
    );
    const retainedOther = profile(
      otherRoot,
      otherPeerId,
      '2026-08-30T00:00:00.000Z',
      '/ip4/other',
    );
    const freshOwned = profile(
      ownedRoot,
      remotePeerId,
      '2026-08-30T00:00:00.000Z',
      '/ip4/new',
    );
    const conflictingOther = profile(
      otherRoot,
      otherPeerId,
      '2026-08-29T00:00:00.000Z',
      '/ip4/poisoned',
    );
    const firstSeenPeerId = '12D3KooWFirstSeenPeer';
    const firstSeenRoot = `did:dkg:agent:${firstSeenPeerId}`;
    const firstSeen = profile(
      firstSeenRoot,
      firstSeenPeerId,
      '2026-08-30T00:00:00.000Z',
      '/ip4/first-seen',
    );
    const harness = await createHarness([
      page({
        quads: [...freshOwned, ...conflictingOther, ...firstSeen],
        resumedFromOffset: 0,
        nextOffset: freshOwned.length + conflictingOther.length + firstSeen.length,
        completed: true,
        timedOut: false,
      }),
    ], [...oldOwned, oldCapability, oldKey, ...retainedOther]);

    const result = await harness.run();
    const live = await harness.live();

    expect(result.complete).toBe(true);
    expect(result.insertedTriples).toBe(freshOwned.length + firstSeen.length);
    expect(harness.replaceSubjectPrefix).toHaveBeenCalledTimes(1);
    expect(harness.markAllDirty).toHaveBeenCalledTimes(1);
    expect(live).toEqual(expect.arrayContaining([...freshOwned, ...retainedOther, ...firstSeen]));
    expect(live).not.toContainEqual(oldOwned[2]);
    expect(live).not.toContainEqual(oldCapability);
    expect(live).not.toContainEqual(oldKey);
    expect(live).not.toContainEqual(conflictingOther[2]);
  });

  it('classifies a peer-id-omitting agent tree and cannot append into an established profile', async () => {
    const current = profile(
      otherRoot,
      otherPeerId,
      '2026-08-30T00:00:00.000Z',
      '/ip4/current',
    );
    const poisoned = quad(otherRoot, multiaddrPredicate, '"/p2p/attacker"');
    const poisonedChild = quad(
      `${otherRoot}/.well-known/genid/cap-poison`,
      'https://schema.org/name',
      '"poisoned"',
    );
    const harness = await createHarness([page({
      quads: [poisoned, poisonedChild],
      resumedFromOffset: 0,
      nextOffset: 2,
      completed: true,
      timedOut: false,
    })], current);

    const result = await harness.run();

    expect(result.insertedTriples).toBe(0);
    expect(harness.replaceSubjectPrefix).not.toHaveBeenCalled();
    expect(await harness.live()).toEqual(expect.arrayContaining(current));
    expect(await harness.live()).not.toContainEqual(poisoned);
    expect(await harness.live()).not.toContainEqual(poisonedChild);
  });

  it('ignores an unproven wallet-root squat and lets a proven wallet owner supersede poison', async () => {
    const squattedWallet = new ethers.Wallet(`0x${'11'.repeat(32)}`);
    const walletRoot = `did:dkg:agent:${squattedWallet.address.toLowerCase()}`;
    const walletSquat = profile(
      walletRoot,
      remotePeerId,
      '2099-01-01T00:00:00.000Z',
      '/ip4/squat',
    );
    // A valid wallet signature copied from a different peer binding must not
    // become authority merely because it is co-located with attacker's peerId.
    walletSquat.push(quad(
      walletRoot,
      peerIdProofPredicate,
      `"${signAgentPeerIdBinding(squattedWallet.address, otherPeerId, squattedWallet.privateKey)}"`,
    ));
    const ownerPrivateKey = `0x${'22'.repeat(32)}`;
    const ownerWallet = new ethers.Wallet(ownerPrivateKey);
    const provenWalletRoot = `did:dkg:agent:${ownerWallet.address.toLowerCase()}`;
    const poisonedExisting = profile(
      provenWalletRoot,
      remotePeerId,
      '2099-01-01T00:00:00.000Z',
      '/ip4/poison',
    );
    const authenticated = profile(
      provenWalletRoot,
      remotePeerId,
      '2026-08-30T00:00:00.000Z',
      '/ip4/authenticated',
    );
    authenticated.push(quad(
      provenWalletRoot,
      peerIdProofPredicate,
      `"${signAgentPeerIdBinding(ownerWallet.address, remotePeerId, ownerPrivateKey)}"`,
    ));
    const harness = await createHarness([page({
      quads: [...walletSquat, ...authenticated],
      resumedFromOffset: 0,
      nextOffset: walletSquat.length + authenticated.length,
      completed: true,
      timedOut: false,
    })], poisonedExisting);

    const result = await harness.run();
    const live = await harness.live();

    expect(result.insertedTriples).toBe(authenticated.length);
    expect(live).toEqual(expect.arrayContaining(authenticated));
    expect(live).not.toContainEqual(poisonedExisting[2]);
    expect(live).not.toEqual(expect.arrayContaining(walletSquat));
  });

  it('applies forwarded hints and owned replacement in one atomic mutation', async () => {
    const store = new OxigraphStore();
    const current = profile(
      ownedRoot,
      remotePeerId,
      '2026-08-29T00:00:00.000Z',
      '/ip4/current',
    );
    await store.insert(current);
    const fresh = profile(
      ownedRoot,
      remotePeerId,
      '2026-08-30T00:00:00.000Z',
      '/ip4/fresh',
    );
    const forwardedPeerId = '12D3KooWForwardedPeer';
    const forwarded = profile(
      `did:dkg:agent:${forwardedPeerId}`,
      forwardedPeerId,
      '2026-08-30T00:00:00.000Z',
      '/ip4/forwarded',
    );
    vi.spyOn(store, 'replaceSubjectPrefix').mockRejectedValueOnce(
      new Error('injected atomic settlement failure'),
    );
    const invalidate = vi.fn();

    await expect(reconcileAgentRegistrySnapshot({
      store,
      graphUri: graph,
      remotePeerId,
      quads: [...fresh, ...forwarded],
      insertForwarded: (quads, options) => store.insert(quads, options),
      invalidate,
    })).rejects.toThrow('injected atomic settlement failure');

    expect(await graphQuads(store)).toEqual(expect.arrayContaining(current));
    expect(await graphQuads(store)).not.toEqual(expect.arrayContaining(forwarded));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not let an empty completed snapshot erase local or learned profiles', async () => {
    const initial = [
      ...profile(ownedRoot, remotePeerId, '2026-08-30T00:00:00.000Z', '/ip4/owned'),
      ...profile(otherRoot, otherPeerId, '2026-08-30T00:00:00.000Z', '/ip4/other'),
    ];
    const harness = await createHarness([page({
      quads: [],
      resumedFromOffset: 0,
      nextOffset: 0,
      completed: true,
      timedOut: false,
    })], initial);

    const result = await harness.run();

    expect(result.complete).toBe(true);
    expect(result.insertedTriples).toBe(0);
    expect(harness.replaceSubjectPrefix).not.toHaveBeenCalled();
    expect(harness.markAllDirty).not.toHaveBeenCalled();
    expect(await harness.live()).toEqual(expect.arrayContaining(initial));
  });

  it('does not roll an established responder profile back to an older snapshot', async () => {
    const current = profile(
      ownedRoot,
      remotePeerId,
      '2026-08-30T00:00:00.000Z',
      '/ip4/current',
    );
    const stale = profile(
      ownedRoot,
      remotePeerId,
      '2026-08-29T00:00:00.000Z',
      '/ip4/stale',
    );
    const harness = await createHarness([
      page({
        quads: current,
        resumedFromOffset: 0,
        nextOffset: current.length,
        completed: true,
        timedOut: false,
      }),
      page({
        quads: stale,
        resumedFromOffset: 0,
        nextOffset: stale.length,
        completed: true,
        timedOut: false,
      }),
    ], current);

    expect((await harness.run()).insertedTriples).toBe(current.length);
    const result = await harness.run();

    expect(result.complete).toBe(true);
    expect(result.insertedTriples).toBe(0);
    expect(harness.replaceSubjectPrefix).toHaveBeenCalledTimes(1);
    expect(await harness.live()).toEqual(expect.arrayContaining(current));
    expect(await harness.live()).not.toContainEqual(stale[2]);
  });

  it('refuses a completed nonzero suffix when no matching prefix is retained', async () => {
    const current = profile(
      ownedRoot,
      remotePeerId,
      '2026-08-29T00:00:00.000Z',
      '/ip4/current',
    );
    const suffix = quad(ownedRoot, multiaddrPredicate, '"/ip4/suffix-only"');
    const response = page({
      quads: [suffix],
      resumedFromOffset: 50,
      nextOffset: 51,
      completed: true,
      timedOut: false,
    });
    const harness = await createHarness([response], current);
    harness.syncCheckpoints.set(checkpointKey, 50, Date.now(), 50);
    harness.syncCheckpoints.setResponderSession(
      checkpointKey,
      'immutable-agents-session',
      Date.now() + 60_000,
      Date.now(),
      undefined,
      undefined,
      50,
    );

    const result = await harness.run();

    expect(result.complete).toBe(false);
    expect(result.insertedTriples).toBe(0);
    expect(harness.replaceSubjectPrefix).not.toHaveBeenCalled();
    expect(await harness.live()).toEqual(expect.arrayContaining(current));
  });

  it('resumes a partial snapshot and promotes it without exposing the prefix', async () => {
    const current = profile(
      ownedRoot,
      remotePeerId,
      '2026-08-29T00:00:00.000Z',
      '/ip4/old',
    );
    const first = [
      quad(ownedRoot, peerIdPredicate, `"${remotePeerId}"`),
      quad(ownedRoot, lastSeenPredicate, '"2026-08-30T00:00:00.000Z"'),
    ];
    const second = [quad(ownedRoot, multiaddrPredicate, '"/ip4/new"')];
    const harness = await createHarness([
      page({
        quads: first,
        resumedFromOffset: 0,
        nextOffset: first.length,
        completed: false,
        timedOut: true,
      }),
      page({
        quads: second,
        resumedFromOffset: first.length,
        nextOffset: first.length + second.length,
        completed: true,
        timedOut: false,
      }),
    ], current);

    const partial = await harness.run();
    expect(partial.complete).toBe(false);
    expect(partial.insertedTriples).toBe(0);
    expect(harness.replaceSubjectPrefix).not.toHaveBeenCalled();
    expect(await harness.live()).toEqual(expect.arrayContaining(current));
    expect(harness.authoritativeAgentSnapshots.retainedTriples(checkpointKey)).toBe(first.length);

    const completed = await harness.run();
    expect(completed.complete).toBe(true);
    expect(completed.insertedTriples).toBe(first.length + second.length);
    expect(harness.replaceSubjectPrefix).toHaveBeenCalledTimes(1);
    expect(await harness.live()).toEqual(expect.arrayContaining([...first, ...second]));
    expect(await harness.live()).not.toContainEqual(current[2]);
    expect(harness.authoritativeAgentSnapshots.retainedTriples(checkpointKey)).toBe(0);
  });
});
