import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import {
  createSelectedSwmMetaFetcher,
  SelectedSwmMetaTransferOwner,
} from '../src/sync/selected-swm-meta-fetcher.js';
import { syncPublicSnapshotsForMeta } from '../src/sync/requester/shared-memory-sync.js';
import { SelectedSwmMetaTransferCoordinator } from '../src/sync/selected-swm-meta-transfer-coordinator.js';
import { createSelectedSwmMetaRetentionBudget } from '../src/sync/selected-swm-meta-budget.js';

const testContext = {
  operationId: 'selected-meta-owner-test',
  operationName: 'sync',
} as OperationContext;

function retentionBudget() {
  return createSelectedSwmMetaRetentionBudget({
    maxRows: 100,
    maxBytesEstimate: 1024 * 1024,
    maxPrefixRows: 100,
    maxPrefixBytesEstimate: 1024 * 1024,
  });
}

describe('selected SWM metadata transfer ownership', () => {
  it('keeps retained-prefix lifecycle controls private to the per-peer owner', async () => {
    const coordinator = new SelectedSwmMetaTransferCoordinator();
    const fetcher = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-private-owner',
      requesterScope: 'selected-swm-meta:retained:private-owner',
      retentionBudget: retentionBudget(),
      deleteCheckpoint: () => {},
      fetchPage: async () => {
        throw new Error('unused');
      },
    });

    expect(fetcher).not.toHaveProperty('settleOuterInvocation');
    expect(fetcher).not.toHaveProperty('pruneExpiredPrefixes');
    expect(fetcher).not.toHaveProperty('cleanup');
    await coordinator.run('peer-private-owner', () => fetcher, async () => {});
    await coordinator.close();
  });

  it('retains a completed manifest only while its exact snapshot walk is incomplete', async () => {
    const peerId = 'peer-snapshot-resume';
    const contextGraphId = 'cg-snapshot-resume';
    const coordinator = new SelectedSwmMetaTransferCoordinator();
    const fetchPage = vi.fn(async () => ({
      quads: [{ subject: 'urn:manifest', predicate: 'urn:p', object: '"o"', graph: 'urn:meta' }],
      bytesReceived: 1,
      resumedFromOffset: 0,
      nextOffset: 1,
      checkpointKey: 'snapshot-resume-checkpoint',
      completed: true,
      timedOut: false,
    }));
    const createFetcher = vi.fn(() => createSelectedSwmMetaFetcher({
      remotePeerId: peerId,
      requesterScope: 'selected-swm-meta:retained:snapshot-resume',
      retentionBudget: retentionBudget(),
      deleteCheckpoint: () => {},
      fetchPage,
    }));
    const request = {
      ctx: testContext,
      remotePeerId: peerId,
      contextGraphId,
      graphUri: 'urn:meta',
      deadline: Date.now() + 1_000,
    };
    const manifest = [
      { ref: 'ref-a', digest: 'digest-a', count: 1 },
      { ref: 'ref-b', digest: 'digest-b', count: 1 },
      { ref: 'ref-c', digest: 'digest-c', count: 1 },
    ];
    const suppressedRow = {
      subject: 'urn:suppressed', predicate: 'urn:p', object: '"o"', graph: 'urn:meta',
    };

    try {
      await coordinator.run(peerId, createFetcher, async (fetcher) => {
        await fetcher.strategy.fetch(request);
        const walk = fetcher.strategy.snapshotWalk!(contextGraphId, manifest);
        walk.markResolved('ref-a', [suppressedRow]);
        expect([...walk.resolvedRefs]).toEqual(['ref-a']);
      });

      await coordinator.run(peerId, createFetcher, async (fetcher) => {
        const cached = await fetcher.strategy.fetch(request);
        expect(cached.result.bytesReceived).toBe(0);
        const walk = fetcher.strategy.snapshotWalk!(contextGraphId, manifest);
        expect([...walk.resolvedRefs]).toEqual(['ref-a']);
        expect(walk.suppressedMetadataRows('ref-a')).toEqual([suppressedRow]);
        walk.markResolved('ref-a');
        expect(walk.suppressedMetadataRows('ref-a')).toEqual([suppressedRow]);
        walk.markResolved('ref-b');
        walk.markResolved('ref-c');
      });

      expect(fetchPage).toHaveBeenCalledOnce();
      expect(createFetcher).toHaveBeenCalledOnce();

      // A fully resolved walk is terminal owner state. The next outer
      // invocation must start from a new fetcher rather than retaining trust.
      await coordinator.run(peerId, createFetcher, async (fetcher) => {
        await fetcher.strategy.fetch(request);
      });
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(createFetcher).toHaveBeenCalledTimes(2);
    } finally {
      await coordinator.close();
    }
  });

  it('releases completed metadata when no snapshot walk remains active', async () => {
    const peerId = 'peer-complete-without-walk';
    const contextGraphId = 'cg-complete-without-walk';
    const coordinator = new SelectedSwmMetaTransferCoordinator();
    const fetchPage = vi.fn(async () => ({
      quads: [{ subject: 'urn:terminal-meta', predicate: 'urn:p', object: '"o"', graph: 'urn:meta' }],
      bytesReceived: 1,
      resumedFromOffset: 0,
      nextOffset: 1,
      checkpointKey: 'terminal-meta-checkpoint',
      completed: true,
      timedOut: false,
    }));
    const createFetcher = vi.fn(() => createSelectedSwmMetaFetcher({
      remotePeerId: peerId,
      requesterScope: 'selected-swm-meta:retained:terminal-without-walk',
      retentionBudget: retentionBudget(),
      deleteCheckpoint: () => {},
      fetchPage,
    }));
    const request = {
      ctx: testContext,
      remotePeerId: peerId,
      contextGraphId,
      graphUri: 'urn:meta',
      deadline: Date.now() + 1_000,
    };

    try {
      await coordinator.run(peerId, createFetcher, (fetcher) => fetcher.strategy.fetch(request));
      await coordinator.run(peerId, createFetcher, (fetcher) => fetcher.strategy.fetch(request));

      // Terminal metadata without a post-metadata walk carries no resumable
      // work into the next outer invocation.
      expect(fetchPage).toHaveBeenCalledTimes(2);
      expect(createFetcher).toHaveBeenCalledTimes(2);
    } finally {
      await coordinator.close();
    }
  });

  it('invalidates resolved refs when the exact manifest changes digest, count, or order', async () => {
    const peerId = 'peer-manifest-invalidation';
    const contextGraphId = 'cg-manifest-invalidation';
    const coordinator = new SelectedSwmMetaTransferCoordinator();
    const fetchPage = vi.fn(async () => ({
      quads: [{ subject: 'urn:manifest', predicate: 'urn:p', object: '"o"', graph: 'urn:meta' }],
      bytesReceived: 1,
      resumedFromOffset: 0,
      nextOffset: 1,
      checkpointKey: 'manifest-invalidation-checkpoint',
      completed: true,
      timedOut: false,
    }));
    const createFetcher = vi.fn(() => createSelectedSwmMetaFetcher({
      remotePeerId: peerId,
      requesterScope: 'selected-swm-meta:retained:manifest-invalidation',
      retentionBudget: retentionBudget(),
      deleteCheckpoint: () => {},
      fetchPage,
    }));
    const request = {
      ctx: testContext,
      remotePeerId: peerId,
      contextGraphId,
      graphUri: 'urn:meta',
      deadline: Date.now() + 1_000,
    };
    const original = [
      { ref: 'ref-a', digest: 'digest-a', count: 1 },
      { ref: 'ref-b', digest: 'digest-b', count: 1 },
    ];
    const changedDigest = [
      { ref: 'ref-a', digest: 'digest-a-v2', count: 1 },
      { ref: 'ref-b', digest: 'digest-b', count: 1 },
    ];
    const changedCount = [
      { ...changedDigest[0]!, count: 2 },
      changedDigest[1]!,
    ];
    const reordered = [changedCount[1]!, changedCount[0]!];
    const requestedRefs: string[] = [];

    try {
      await coordinator.run(peerId, createFetcher, async (fetcher) => {
        await fetcher.strategy.fetch(request);
        const walk = fetcher.strategy.snapshotWalk!(contextGraphId, original);
        walk.markResolved('ref-a');
        expect([...walk.resolvedRefs]).toEqual(['ref-a']);
      });

      await coordinator.run(peerId, createFetcher, async (fetcher) => {
        await fetcher.strategy.fetch(request);
        const walk = fetcher.strategy.snapshotWalk!(contextGraphId, changedDigest);
        expect([...walk.resolvedRefs]).toEqual([]);
        await syncPublicSnapshotsForMeta({
          ctx: testContext,
          remotePeerId: peerId,
          contextGraphId,
          deadline: Date.now() + 1_000,
          snapshotWalk: walk,
          publicSnapshotStore: {
            getSnapshot: async () => null,
            putSnapshot: async ({ digest }) => ({ ref: digest, byteLength: 0 }),
          },
          fetchSyncPages: async (
            _ctx,
            _remotePeerId,
            _contextGraphId,
            _includeSharedMemory,
            _phase,
            _graphUri,
            _deadline,
            options,
          ) => {
            requestedRefs.push(options?.snapshotRef ?? '');
            return {
              quads: [],
              bytesReceived: 0,
              resumedFromOffset: 0,
              nextOffset: 0,
              checkpointKey: 'changed-manifest-snapshot',
              completed: false,
              timedOut: true,
            };
          },
          deleteCheckpoint: () => {},
          setCheckpoint: () => {},
        });
        expect(requestedRefs).toEqual(['ref-a']);
        walk.markResolved('ref-a');
      });

      await coordinator.run(peerId, createFetcher, async (fetcher) => {
        await fetcher.strategy.fetch(request);
        const walk = fetcher.strategy.snapshotWalk!(contextGraphId, changedCount);
        expect([...walk.resolvedRefs]).toEqual([]);
        walk.markResolved('ref-a');
      });

      await coordinator.run(peerId, createFetcher, async (fetcher) => {
        await fetcher.strategy.fetch(request);
        const walk = fetcher.strategy.snapshotWalk!(contextGraphId, reordered);
        expect([...walk.resolvedRefs]).toEqual([]);
        walk.markResolved('ref-a');
        walk.markResolved('ref-b');
      });

      expect(fetchPage).toHaveBeenCalledOnce();
      expect(createFetcher).toHaveBeenCalledOnce();
    } finally {
      await coordinator.close();
    }
  });

  it('notifies its registry after timer-driven final-prefix expiry', async () => {
    const baseNow = Date.now();
    let elapsedMs = 0;
    const clock = () => baseNow + elapsedMs;
    const onIdle = vi.fn();
    const owner = new SelectedSwmMetaTransferOwner({ now: clock, onIdle });
    const fetcher = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-owner-idle',
      requesterScope: 'selected-swm-meta:retained:owner-idle',
      retentionBudget: retentionBudget(),
      deleteCheckpoint: () => {},
      now: clock,
      retentionTtlMs: 20,
      fetchPage: async () => ({
        quads: [{ subject: 'urn:idle', predicate: 'urn:p', object: '"o"', graph: 'urn:meta' }],
        bytesReceived: 1,
        resumedFromOffset: 0,
        nextOffset: 1,
        checkpointKey: 'owner-idle-checkpoint',
        completed: false,
        timedOut: true,
      }),
    });

    try {
      await owner.run(() => fetcher, (selectedFetcher) => selectedFetcher.strategy.fetch({
        ctx: testContext,
        remotePeerId: 'peer-owner-idle',
        contextGraphId: 'cg-owner-idle',
        graphUri: 'urn:meta',
        deadline: clock() + 1_000,
      }));
      expect(owner.isIdle()).toBe(false);
      expect(onIdle).not.toHaveBeenCalled();

      elapsedMs = 21;
      await vi.waitFor(() => expect(onIdle).toHaveBeenCalledOnce(), { timeout: 250 });
      expect(owner.isIdle()).toBe(true);
    } finally {
      await owner.close();
    }
  });

  it('eagerly releases an expired prefix without requiring another reconciler invocation', async () => {
    const peerId = 'peer-expiry';
    const contextGraphId = 'cg-expiry';
    const baseNow = Date.now();
    let elapsedMs = 0;
    const clock = () => baseNow + elapsedMs;
    const deleteCheckpoint = vi.fn();
    let ownedFetcher: ReturnType<typeof createSelectedSwmMetaFetcher> | undefined;
    const coordinator = new SelectedSwmMetaTransferCoordinator({ now: clock });

    const createFetcher = () => {
      ownedFetcher = createSelectedSwmMetaFetcher({
        remotePeerId: peerId,
        requesterScope: 'selected-swm-meta:retained:eager-expiry',
        retentionBudget: retentionBudget(),
        deleteCheckpoint,
        now: clock,
        retentionTtlMs: 20,
        fetchPage: async () => ({
          quads: [{ subject: 'urn:expiry', predicate: 'urn:p', object: '"o"', graph: 'urn:meta' }],
          bytesReceived: 1,
          resumedFromOffset: 0,
          nextOffset: 1,
          checkpointKey: 'expiry-checkpoint',
          completed: false,
          timedOut: true,
        }),
      });
      return ownedFetcher;
    };

    try {
      await coordinator.run(peerId, createFetcher, (fetcher) => fetcher.strategy.fetch({
        ctx: testContext,
        remotePeerId: peerId,
        contextGraphId,
        graphUri: 'urn:meta',
        deadline: clock() + 1_000,
      }));
      expect(ownedFetcher?.continuation(contextGraphId).progress).toBe(1);

      elapsedMs = 21;
      await vi.waitFor(
        () => expect(ownedFetcher?.continuation(contextGraphId).progress).toBeUndefined(),
        { timeout: 250 },
      );
      expect(deleteCheckpoint).toHaveBeenCalledWith('expiry-checkpoint');
    } finally {
      await coordinator.close();
    }
  });

  it('expires Context Graph prefixes independently inside one peer owner', async () => {
    const peerId = 'peer-multi-cg';
    const baseNow = Date.now();
    let elapsedMs = 0;
    const clock = () => baseNow + elapsedMs;
    let ownedFetcher: ReturnType<typeof createSelectedSwmMetaFetcher> | undefined;
    const coordinator = new SelectedSwmMetaTransferCoordinator({ now: clock });
    const createFetcher = () => {
      ownedFetcher = createSelectedSwmMetaFetcher({
        remotePeerId: peerId,
        requesterScope: 'selected-swm-meta:retained:multi-cg',
        retentionBudget: retentionBudget(),
        deleteCheckpoint: () => {},
        now: clock,
        retentionTtlMs: 30,
        fetchPage: async ({ contextGraphId }) => ({
          quads: [{
            subject: `urn:${contextGraphId}`,
            predicate: 'urn:p',
            object: '"o"',
            graph: 'urn:meta',
          }],
          bytesReceived: 1,
          resumedFromOffset: 0,
          nextOffset: 1,
          checkpointKey: `${contextGraphId}:checkpoint`,
          completed: false,
          timedOut: true,
        }),
      });
      return ownedFetcher;
    };
    const fetch = (contextGraphId: string) => coordinator.run(
      peerId,
      createFetcher,
      (fetcher) => fetcher.strategy.fetch({
        ctx: testContext,
        remotePeerId: peerId,
        contextGraphId,
        graphUri: 'urn:meta',
        deadline: clock() + 1_000,
      }),
    );

    try {
      const first = await fetch('cg-a');
      expect(first.result.quads.map((quad) => quad.subject)).toEqual(['urn:cg-a']);
      elapsedMs = 20;
      const second = await fetch('cg-b');
      expect(second.result.quads.map((quad) => quad.subject)).toEqual(['urn:cg-b']);

      elapsedMs = 31;
      await vi.waitFor(
        () => expect(ownedFetcher?.continuation('cg-a').progress).toBeUndefined(),
        { timeout: 250 },
      );
      expect(ownedFetcher?.continuation('cg-b').progress).toBe(1);
    } finally {
      await coordinator.close();
    }
  });

  it('releases an expired sibling prefix and its budget before a gated same-peer fetch completes', async () => {
    const peerId = 'peer-active-expiry';
    const baseNow = Date.now();
    let elapsedMs = 0;
    const clock = () => baseNow + elapsedMs;
    const deleteCheckpoint = vi.fn();
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 1,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 1,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    let ownedFetcher: ReturnType<typeof createSelectedSwmMetaFetcher> | undefined;
    let releaseSecondOperation!: () => void;
    const secondOperationGate = new Promise<void>((resolve) => {
      releaseSecondOperation = resolve;
    });
    let signalSecondOperationStarted!: () => void;
    const secondOperationStarted = new Promise<void>((resolve) => {
      signalSecondOperationStarted = resolve;
    });
    let releaseSecondFetch!: () => void;
    const secondFetchGate = new Promise<void>((resolve) => {
      releaseSecondFetch = resolve;
    });
    let signalSecondFetchStarted!: (availableRows: number) => void;
    const secondFetchStarted = new Promise<number>((resolve) => {
      signalSecondFetchStarted = resolve;
    });
    const coordinator = new SelectedSwmMetaTransferCoordinator({ now: clock });
    const createFetcher = () => {
      ownedFetcher = createSelectedSwmMetaFetcher({
        remotePeerId: peerId,
        requesterScope: 'selected-swm-meta:retained:active-expiry',
        retentionBudget: budget,
        deleteCheckpoint,
        now: clock,
        retentionTtlMs: 20,
        fetchPage: async (request) => {
          if (request.contextGraphId === 'cg-b') {
            signalSecondFetchStarted(request.maxAcceptedQuads);
            await secondFetchGate;
          }
          return {
            quads: [{
              subject: `urn:${request.contextGraphId}`,
              predicate: 'urn:p',
              object: '"o"',
              graph: 'urn:meta',
            }],
            bytesReceived: 1,
            resumedFromOffset: 0,
            nextOffset: 1,
            checkpointKey: `${request.contextGraphId}:checkpoint`,
            completed: false,
            timedOut: true,
          };
        },
      });
      return ownedFetcher;
    };
    const request = (contextGraphId: string) => ({
      ctx: testContext,
      remotePeerId: peerId,
      contextGraphId,
      graphUri: 'urn:meta',
      deadline: clock() + 1_000,
    });

    try {
      await coordinator.run(
        peerId,
        createFetcher,
        (fetcher) => fetcher.strategy.fetch(request('cg-a')),
      );
      expect(ownedFetcher?.continuation('cg-a').progress).toBe(1);

      let secondCompleted = false;
      const second = coordinator.run(peerId, createFetcher, async (fetcher) => {
        signalSecondOperationStarted();
        await secondOperationGate;
        return fetcher.strategy.fetch(request('cg-b'));
      });
      void second.then(() => { secondCompleted = true; });
      await secondOperationStarted;

      // The peer-wide idle timer is suspended by the active outer operation.
      // Crossing A's independent TTL before B reaches its fetch boundary must
      // still release A's checkpoint and make its global row available to B.
      elapsedMs = 21;
      releaseSecondOperation();
      expect(await secondFetchStarted).toBe(1);
      expect(secondCompleted).toBe(false);
      expect(deleteCheckpoint).toHaveBeenCalledWith('cg-a:checkpoint');
      expect(ownedFetcher?.continuation('cg-a').progress).toBeUndefined();

      releaseSecondFetch();
      await second;
    } finally {
      releaseSecondOperation();
      releaseSecondFetch();
      await coordinator.close();
    }
  });

  it('releases an expired prefix globally while its peer has another active operation', async () => {
    const baseNow = Date.now();
    let elapsedMs = 0;
    const clock = () => baseNow + elapsedMs;
    const deleteCheckpoint = vi.fn();
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 1,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const coordinator = new SelectedSwmMetaTransferCoordinator({ now: clock });
    let releasePeerAActiveFetch!: () => void;
    const peerAActiveFetchGate = new Promise<void>((resolve) => {
      releasePeerAActiveFetch = resolve;
    });
    let signalPeerAActiveFetchStarted!: (availableRows: number) => void;
    const peerAActiveFetchStarted = new Promise<number>((resolve) => {
      signalPeerAActiveFetchStarted = resolve;
    });
    let peerACompleted = false;
    let peerBAvailableRows: number | undefined;
    let peerAFetcher: ReturnType<typeof createSelectedSwmMetaFetcher> | undefined;
    const createFetcher = (peerId: string) => {
      const fetcher = createSelectedSwmMetaFetcher({
        remotePeerId: peerId,
        requesterScope: `selected-swm-meta:retained:${peerId}`,
        retentionBudget: budget,
        deleteCheckpoint,
        now: clock,
        retentionTtlMs: 20,
        fetchPage: async (request) => {
          if (peerId === 'peer-a' && request.contextGraphId === 'cg-active') {
            signalPeerAActiveFetchStarted(request.maxAcceptedQuads);
            await peerAActiveFetchGate;
          }
          if (peerId === 'peer-b') peerBAvailableRows = request.maxAcceptedQuads;
          return {
            quads: [{
              subject: `urn:${peerId}:${request.contextGraphId}`,
              predicate: 'urn:p',
              object: '"o"',
              graph: 'urn:meta',
            }],
            bytesReceived: 1,
            resumedFromOffset: 0,
            nextOffset: 1,
            checkpointKey: `${peerId}:${request.contextGraphId}:checkpoint`,
            completed: false,
            timedOut: true,
          };
        },
      });
      if (peerId === 'peer-a') peerAFetcher = fetcher;
      return fetcher;
    };
    const request = (peerId: string, contextGraphId: string) => ({
      ctx: testContext,
      remotePeerId: peerId,
      contextGraphId,
      graphUri: 'urn:meta',
      deadline: clock() + 1_000,
    });

    try {
      await coordinator.run(
        'peer-a',
        () => createFetcher('peer-a'),
        (fetcher) => fetcher.strategy.fetch(request('peer-a', 'cg-old')),
      );

      const activePeerA = coordinator.run(
        'peer-a',
        () => createFetcher('peer-a'),
        (fetcher) => fetcher.strategy.fetch(request('peer-a', 'cg-active')),
      );
      void activePeerA.then(() => { peerACompleted = true; });
      expect(await peerAActiveFetchStarted).toBe(1);
      elapsedMs = 21;

      // A's timer must release the old prefix without touching the active CG's
      // in-flight reservation. Otherwise B sees zero rows, or A loses its
      // active continuation, after the shared process-wide budget is reclaimed.
      await vi.waitFor(
        () => expect(deleteCheckpoint).toHaveBeenCalledWith('peer-a:cg-old:checkpoint'),
        { timeout: 250 },
      );
      expect(peerACompleted).toBe(false);
      expect(deleteCheckpoint).not.toHaveBeenCalledWith('peer-a:cg-active:checkpoint');

      await coordinator.run(
        'peer-b',
        () => createFetcher('peer-b'),
        (fetcher) => fetcher.strategy.fetch(request('peer-b', 'cg-b')),
      );
      expect(peerBAvailableRows).toBe(1);
      expect(peerACompleted).toBe(false);

      releasePeerAActiveFetch();
      await activePeerA;
      expect(peerAFetcher?.continuation('cg-active').progress).toBe(1);
      expect(deleteCheckpoint).not.toHaveBeenCalledWith('peer-a:cg-active:checkpoint');
    } finally {
      releasePeerAActiveFetch();
      await coordinator.close();
    }
  });

  it('does not serialize independent peers behind one transfer owner', async () => {
    const coordinator = new SelectedSwmMetaTransferCoordinator();
    let releasePeerA!: () => void;
    const peerARelease = new Promise<void>((resolve) => { releasePeerA = resolve; });
    let signalPeerAStarted!: () => void;
    const peerAStarted = new Promise<void>((resolve) => { signalPeerAStarted = resolve; });
    const createEmptyFetcher = (peerId: string) => createSelectedSwmMetaFetcher({
      remotePeerId: peerId,
      requesterScope: `selected-swm-meta:retained:${peerId}`,
      retentionBudget: retentionBudget(),
      deleteCheckpoint: () => {},
      fetchPage: async () => {
        throw new Error('unused');
      },
    });

    try {
      const peerA = coordinator.run('peer-a', () => createEmptyFetcher('peer-a'), async () => {
        signalPeerAStarted();
        await peerARelease;
      });
      await peerAStarted;
      let peerBStarted = false;
      await coordinator.run('peer-b', () => createEmptyFetcher('peer-b'), async () => {
        peerBStarted = true;
      });
      expect(peerBStarted).toBe(true);
      releasePeerA();
      await peerA;
    } finally {
      releasePeerA();
      await coordinator.close();
    }
  });
});
