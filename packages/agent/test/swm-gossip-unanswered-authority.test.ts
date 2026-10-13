/**
 * The shared-memory gossip reconcile asks whether this node may use the
 * graph's shared memory and then subscribes or unsubscribes. When the chain
 * read behind that check gets no answer (the node's own RPC budget did not
 * admit it, or the endpoint did not reply in time) the reconcile learns
 * nothing about the graph: the subscription stays as it is and the graph is
 * asked again shortly.
 *
 * These run the production reconcile, gate and read-authority resolution.
 * Only the chain read is scripted, the gossip manager is a recorder, and the
 * graph's local metadata is taken as confirmed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeRpcRequestContext,
  ChainRpcTransportError,
  type ContextGraphLiveAuthority,
} from '@origintrail-official/dkg-chain';
import { contextGraphSharedMemoryTopic, type GossipSubManager } from '@origintrail-official/dkg-core';
import { sharedMemoryAuthorityRecheckOf } from '../src/gossip-session.js';
import { UNANSWERED_AUTHORITY_RECHECK_MS as RECHECK_MS } from '../src/internal/unanswered-authority-recheck.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const CORE = '12D3KooWGossipAuthorityCore';
const localCgId = '0x0000000000000000000000000000000000000001/gossip-unanswered-authority';
/** The request-scoped deadline of one authority read. */
const AUTHORITY_READ_TIMEOUT_MS = 2_500;

type LiveAuthorityRead = () => Promise<ContextGraphLiveAuthority | null>;

/** What the transport raises when a read's attempt deadline ran out in the node's own RPC queue. */
const notAdmitted: LiveAuthorityRead = () => Promise.reject(new ChainRpcTransportError(
  'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
  'cgStorage.getContextGraph waited 1000ms for local RPC admission and was not sent',
));
const publicGraph: LiveAuthorityRead = async () => ({ active: true, accessPolicy: 0, participantAgents: [] });
/** The chain answered: the id names no live graph. Final, not a missing answer. */
const inactiveGraph: LiveAuthorityRead = async () => ({ active: false, accessPolicy: 0, participantAgents: [] });
const neverAnswers: LiveAuthorityRead = () => new Promise<never>(() => undefined);

const waitingLine = (read: string, meanwhile: string): string => (
  `SWM gossip subscription for "${localCgId}" is waiting for read authority `
  + `(registered-chain/${read}/chain): the chain read got no answer; ${meanwhile}, asking again shortly`
);

/**
 * A subscribed, bound public graph on a node with a live gossip session whose
 * authority read is scripted: each read takes the next entry, and the last
 * one repeats.
 */
async function subscribedHost(script: readonly LiveAuthorityRead[]) {
  const h = await createVmRecoveryHostHarness({
    name: 'GossipUnansweredAuthority', localCgId, peers: [CORE], targetCount: 0,
    targetForOrdinal: (ordinal) => ({
      localCgId, onChainCgId: '1', ordinal, reason: 'no-swm' as const,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    }),
    onFetch: () => 'found',
  });
  // The one cast exposes private host seams. The reconcile, the gate and the
  // read authority behind it stay production code.
  const internals = h.agent as any;
  internals.subscribedContextGraphs.set(localCgId, {
    subscribed: true, synced: false, syncMode: 'always-on', onChainId: h.contextGraphId.toString(),
  });
  internals.hasConfirmedSharedMemoryMetaState = async () => true;
  /** The request class each authority read was issued in. */
  const readClasses: string[] = [];
  const authorityReads = vi.fn<LiveAuthorityRead>();
  let next = 0;
  authorityReads.mockImplementation(() => {
    readClasses.push(activeRpcRequestContext().requestClass);
    return script[Math.min(next++, script.length - 1)]!();
  });
  h.chainAdapter.getContextGraphLiveAuthority = authorityReads;

  const subscribedTopics = new Set<string>();
  const manager = {
    subscribe: vi.fn((topic: string) => { subscribedTopics.add(topic); }),
    unsubscribe: vi.fn((topic: string) => { subscribedTopics.delete(topic); }),
    onMessage: vi.fn(),
    offMessage: vi.fn(),
  };
  h.agent.gossip = manager as unknown as GossipSubManager;
  const topic = contextGraphSharedMemoryTopic(internals.gossipWireIdFor(localCgId));
  const hostModeReconciles = vi.spyOn(internals, 'reconcileSwmHostModeSubscription');

  const spies = {
    info: vi.spyOn(internals.log, 'info'),
    debug: vi.spyOn(internals.log, 'debug'),
    warn: vi.spyOn(internals.log, 'warn'),
  };
  const logged = (level: keyof typeof spies): string[] => spies[level].mock.calls
    .map(([, message]) => String(message))
    .filter((message) => message.startsWith('SWM gossip'));
  return {
    h, internals, authorityReads, readClasses, manager, hostModeReconciles, logged,
    subscribed: () => subscribedTopics.has(topic)
      && (internals.sharedMemoryGossipRegistered.has(localCgId) as boolean),
    waiting: () => sharedMemoryAuthorityRecheckOf(internals.gossipSession).size,
    /** What a subscription, metadata or responsibility event does. */
    reconcile: () => internals.reconcileSharedMemoryGossipSubscription(localCgId) as Promise<void>,
    /** Let the reconcile the wait started run to its end. */
    async settled() {
      for (let turn = 0; turn < 50; turn += 1) await vi.advanceTimersByTimeAsync(0);
    },
    async close() {
      vi.useRealTimers();
      await h.agent.stop();
    },
  };
}

function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

afterEach(() => { vi.useRealTimers(); });

describe('shared-memory gossip reconcile whose authority check gets no answer', () => {
  it('keeps a subscription it holds and asks again on its own', async () => {
    const host = await subscribedHost([publicGraph, notAdmitted, publicGraph]);
    const { authorityReads, manager, logged } = host;
    useFakeClock();
    try {
      await host.reconcile();
      expect(host.subscribed()).toBe(true);

      await host.reconcile();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(host.subscribed()).toBe(true);
      expect(manager.unsubscribe).not.toHaveBeenCalled();
      expect(host.waiting()).toBe(1);
      // Not a refusal, and the log says what it is.
      expect(logged('warn')).toEqual([]);
      expect(logged('info')).toEqual([
        waitingLine('chain-access-policy-unavailable', 'the subscription is kept'),
      ]);
      // A member subscription owns the topic: nothing for host mode to do.
      expect(host.hostModeReconciles).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RECHECK_MS - 1);
      expect(authorityReads).toHaveBeenCalledTimes(2);

      // No event reconciled the graph from outside.
      await vi.advanceTimersByTimeAsync(1);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(3);
      expect(host.subscribed()).toBe(true);
      expect(host.waiting()).toBe(0);
      // The node's own repeat is background work, whatever class the check
      // that armed it ran in.
      expect(host.readClasses).toEqual(['foreground', 'foreground', 'background']);

      // The check was answered: no further one comes on its own.
      await vi.advanceTimersByTimeAsync(10 * RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(3);
      expect(manager.unsubscribe).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  });

  it('subscribes once the check answers, without waiting for another event', async () => {
    const host = await subscribedHost([notAdmitted, publicGraph]);
    const { authorityReads, manager, logged } = host;
    useFakeClock();
    try {
      await host.reconcile();
      // Unanswered is not a grant either.
      expect(host.subscribed()).toBe(false);
      expect(manager.subscribe).not.toHaveBeenCalled();
      expect(logged('warn')).toEqual([]);
      expect(logged('info')).toEqual([
        waitingLine('chain-access-policy-unavailable', 'not subscribed yet'),
      ]);
      // Without a member subscription the host-mode decision is taken as
      // after a refusal.
      expect(host.hostModeReconciles).toHaveBeenCalledTimes(1);
      expect(host.hostModeReconciles).toHaveBeenCalledWith(localCgId);

      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(host.subscribed()).toBe(true);
      expect(host.waiting()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it('keeps asking, one check per delay, and still unsubscribes when the chain refuses', async () => {
    const host = await subscribedHost([
      publicGraph, notAdmitted, notAdmitted, notAdmitted, inactiveGraph,
    ]);
    const { authorityReads, logged } = host;
    useFakeClock();
    try {
      await host.reconcile();
      await host.reconcile();
      for (const reads of [3, 4]) {
        await vi.advanceTimersByTimeAsync(RECHECK_MS - 1);
        expect(authorityReads).toHaveBeenCalledTimes(reads - 1);
        await vi.advanceTimersByTimeAsync(1);
        await host.settled();
        expect(authorityReads).toHaveBeenCalledTimes(reads);
        expect(host.subscribed()).toBe(true);
        expect(host.waiting()).toBe(1);
      }
      // Said once where an operator sees it; the repeats stay at debug level.
      expect(logged('info')).toHaveLength(1);
      expect(logged('debug')).toEqual([
        waitingLine('chain-access-policy-unavailable', 'the subscription is kept'),
        waitingLine('chain-access-policy-unavailable', 'the subscription is kept'),
      ]);
      expect(logged('warn')).toEqual([]);

      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(5);
      expect(host.subscribed()).toBe(false);
      expect(host.waiting()).toBe(0);
      expect(logged('warn')).toEqual([
        `SWM gossip unsubscribed for "${localCgId}": local node is no longer authorized`,
      ]);
    } finally {
      await host.close();
    }
  });

  it('counts a check that ran out of time as unanswered', async () => {
    const host = await subscribedHost([publicGraph, neverAnswers, publicGraph]);
    const { authorityReads, logged } = host;
    useFakeClock();
    try {
      await host.reconcile();
      const reconciled = host.reconcile();
      await vi.advanceTimersByTimeAsync(AUTHORITY_READ_TIMEOUT_MS);
      await reconciled;
      expect(host.subscribed()).toBe(true);
      expect(logged('info')).toEqual([
        waitingLine('chain-access-policy-timeout', 'the subscription is kept'),
      ]);

      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(3);
      expect(host.subscribed()).toBe(true);
      expect(host.waiting()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it('unsubscribes at once when the chain refuses, and asks nothing again', async () => {
    const host = await subscribedHost([publicGraph, inactiveGraph]);
    const { authorityReads, logged } = host;
    useFakeClock();
    try {
      await host.reconcile();
      await host.reconcile();
      expect(host.subscribed()).toBe(false);
      expect(host.waiting()).toBe(0);
      expect(logged('info')).toEqual([]);
      expect(logged('warn')).toEqual([
        `SWM gossip unsubscribed for "${localCgId}": local node is no longer authorized`,
      ]);

      await vi.advanceTimersByTimeAsync(10 * RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });

  it('does not ask again a graph that an event reconciled in the meantime', async () => {
    const host = await subscribedHost([publicGraph, notAdmitted, publicGraph]);
    const { authorityReads } = host;
    useFakeClock();
    try {
      await host.reconcile();
      await host.reconcile();
      expect(host.waiting()).toBe(1);

      // An event reconciles the graph before its turn, and the chain answers.
      await host.reconcile();
      expect(authorityReads).toHaveBeenCalledTimes(3);
      expect(host.waiting()).toBe(0);

      await vi.advanceTimersByTimeAsync(10 * RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(3);
    } finally {
      await host.close();
    }
  });

  it('does not ask again, or subscribe, a graph whose subscription was withdrawn before its turn', async () => {
    const host = await subscribedHost([publicGraph, notAdmitted, publicGraph]);
    const { authorityReads, manager, h } = host;
    useFakeClock();
    try {
      await host.reconcile();
      await host.reconcile();
      expect(host.subscribed()).toBe(true);
      expect(host.waiting()).toBe(1);

      h.agent.unsubscribeFromContextGraph(localCgId, { persist: false });
      expect(host.subscribed()).toBe(false);
      manager.subscribe.mockClear();

      // The chain would now answer that the graph is public. Nobody asks.
      await vi.advanceTimersByTimeAsync(10 * RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(manager.subscribe).not.toHaveBeenCalled();
      expect(host.subscribed()).toBe(false);
      expect(host.waiting()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it('does not ask again, or subscribe, a graph whose subscription was withdrawn while its check was out', async () => {
    const host = await subscribedHost([publicGraph, neverAnswers, publicGraph]);
    const { authorityReads, manager, h, logged } = host;
    useFakeClock();
    try {
      await host.reconcile();
      expect(host.subscribed()).toBe(true);

      const reconciled = host.reconcile();
      await host.settled();
      // The check is waiting for its chain read when the subscription is withdrawn.
      expect(authorityReads).toHaveBeenCalledTimes(2);
      h.agent.unsubscribeFromContextGraph(localCgId, { persist: false });
      expect(host.subscribed()).toBe(false);
      manager.subscribe.mockClear();

      await vi.advanceTimersByTimeAsync(AUTHORITY_READ_TIMEOUT_MS);
      await reconciled;
      expect(logged('info')).toEqual([
        expect.stringContaining('(registered-chain/chain-access-policy-timeout/chain)'),
      ]);

      // The chain would now answer that the graph is public. Nobody asks.
      await vi.advanceTimersByTimeAsync(10 * RECHECK_MS);
      await host.settled();
      expect(manager.subscribe).not.toHaveBeenCalled();
      expect(host.subscribed()).toBe(false);
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(host.waiting()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it('starts counting at one again for a graph subscribed anew after its withdrawn subscription was dropped', async () => {
    const host = await subscribedHost([publicGraph, notAdmitted]);
    const { authorityReads, h, internals, logged } = host;
    useFakeClock();
    try {
      await host.reconcile();
      await host.reconcile();
      expect(host.waiting()).toBe(1);

      h.agent.unsubscribeFromContextGraph(localCgId, { persist: false });
      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(host.waiting()).toBe(0);

      // Subscribed anew, and its first check gets no answer: a first one,
      // said where an operator sees it.
      internals.subscribedContextGraphs.set(localCgId, {
        ...internals.subscribedContextGraphs.get(localCgId),
        subscribed: true,
      });
      await host.reconcile();
      expect(authorityReads).toHaveBeenCalledTimes(3);
      expect(logged('info')).toEqual([
        waitingLine('chain-access-policy-unavailable', 'the subscription is kept'),
        waitingLine('chain-access-policy-unavailable', 'not subscribed yet'),
      ]);
      expect(logged('debug')).toEqual([]);
      expect(host.waiting()).toBe(1);
    } finally {
      await host.close();
    }
  });

  it('asks again a graph it was reconciling without a member subscription', async () => {
    const host = await subscribedHost([notAdmitted, publicGraph]);
    const { authorityReads, internals } = host;
    // What a reconcile looks like for a graph this node holds no member
    // subscription for: there is no intent that could be withdrawn.
    internals.subscribedContextGraphs.set(localCgId, {
      ...internals.subscribedContextGraphs.get(localCgId),
      subscribed: false,
    });
    useFakeClock();
    try {
      await host.reconcile();
      expect(host.waiting()).toBe(1);

      await vi.advanceTimersByTimeAsync(RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(host.waiting()).toBe(0);
    } finally {
      await host.close();
    }
  });

  it('asks nothing after its gossip session is retired', async () => {
    const host = await subscribedHost([publicGraph, notAdmitted, publicGraph]);
    const { authorityReads, internals } = host;
    useFakeClock();
    try {
      await host.reconcile();
      await host.reconcile();
      expect(host.waiting()).toBe(1);
      const retired = internals.gossipSession;

      // What stop() does to the session before a restart builds a new one.
      internals.retireGossipSession();
      expect(sharedMemoryAuthorityRecheckOf(retired).size).toBe(0);
      await vi.advanceTimersByTimeAsync(10 * RECHECK_MS);
      await host.settled();
      expect(authorityReads).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });
});
