import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import {
  createSelectedSwmMetaFetcher,
  SelectedSwmMetaTransferCoordinator,
} from '../src/sync/selected-swm-meta-fetcher.js';
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
      maxRows: 1,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 1,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const coordinator = new SelectedSwmMetaTransferCoordinator({ now: clock });
    let releasePeerA!: () => void;
    const peerAGate = new Promise<void>((resolve) => { releasePeerA = resolve; });
    let signalPeerAStarted!: () => void;
    const peerAStarted = new Promise<void>((resolve) => { signalPeerAStarted = resolve; });
    let peerACompleted = false;
    let peerBAvailableRows: number | undefined;
    const createFetcher = (peerId: string) => createSelectedSwmMetaFetcher({
      remotePeerId: peerId,
      requesterScope: `selected-swm-meta:retained:${peerId}`,
      retentionBudget: budget,
      deleteCheckpoint,
      now: clock,
      retentionTtlMs: 20,
      fetchPage: async (request) => {
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
        (fetcher) => fetcher.strategy.fetch(request('peer-a', 'cg-a')),
      );

      const activePeerA = coordinator.run(
        'peer-a',
        () => createFetcher('peer-a'),
        async () => {
          signalPeerAStarted();
          await peerAGate;
        },
      );
      void activePeerA.then(() => { peerACompleted = true; });
      await peerAStarted;
      elapsedMs = 21;

      // A's timer must release its expired process-wide lease without waiting
      // for A's unrelated outer operation. Otherwise concurrent peer B sees a
      // zero-row reservation even though A has exceeded its independent TTL.
      await vi.waitFor(
        () => expect(deleteCheckpoint).toHaveBeenCalledWith('peer-a:cg-a:checkpoint'),
        { timeout: 250 },
      );
      expect(peerACompleted).toBe(false);

      await coordinator.run(
        'peer-b',
        () => createFetcher('peer-b'),
        (fetcher) => fetcher.strategy.fetch(request('peer-b', 'cg-b')),
      );
      expect(peerBAvailableRows).toBe(1);
      expect(peerACompleted).toBe(false);

      releasePeerA();
      await activePeerA;
    } finally {
      releasePeerA();
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
