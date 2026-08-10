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
