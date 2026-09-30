import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { PeerSyncSession } from '../src/sync/peer-sync-session.js';
import { StorageACKRegistrationRuntime } from '../src/p2p/storage-ack-registration-runtime.js';
import { FinalizationRuntime } from '../src/finalization-runtime.js';
import { SelectedSwmBootstrapAdmission } from '../src/sync/selected-swm-bootstrap-admission.js';
import { Rfc64BackgroundWorkDispatcherV1 } from '../src/rfc64/background-work-dispatcher-v1.js';
import { ContextGraphMembershipPersistScheduler } from '../src/context-graph-membership-persist-scheduler.js';
import {
  ContextGraphSubscriptionPersistQueueClosedError,
  ContextGraphSubscriptionPersistScheduler,
  ContextGraphSubscriptionPersistShutdownTimeoutError,
} from '../src/context-graph-subscription-persist-scheduler.js';
import type {
  ContextGraphMembershipRecord,
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
} from '../src/dkg-agent-types.js';

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** Lets a `stop()` or write that should be blocked show that it is still blocked. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

/** Fails fast with a readable error where a deadlock would otherwise hang to the test timeout. */
async function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sub(overrides: Partial<ContextGraphSub> = {}): ContextGraphSub {
  return {
    name: 'cg',
    syncMode: 'always-on',
    subscribed: true,
    synced: false,
    sharedMemorySynced: false,
    metaSynced: false,
    ...overrides,
  };
}

/**
 * Object.create bypasses DKGAgentBase field initializers, so this carries only
 * what the persistence methods under test touch.
 */
function persistenceAgent(config: Record<string, unknown> = {}): any {
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.assign(agent, {
    config,
    contextGraphSubscriptionPersistence: new ContextGraphSubscriptionPersistScheduler(),
    contextGraphMembershipPersistence: new ContextGraphMembershipPersistScheduler(),
    contextGraphSubscriptionPersistRevisions: new Map<string, number>(),
    contextGraphSubscriptionPersistAppliedRevisions: new Map<string, number>(),
    contextGraphSubscriptionPersistCanceledRevisions: new Map<string, number>(),
    contextGraphSubscriptionPersistPendingRevisions: new Map<string, Set<number>>(),
    contextGraphSubscriptionRehydrationAccountedIds: new Set<string>(),
    subscribedContextGraphs: new Map<string, ContextGraphSub>(),
    log: { warn: vi.fn(), info: vi.fn() },
    invalidateListContextGraphsCache: vi.fn(),
    updateContextGraphSubscriptionRehydrationStatusAfterPersist: vi.fn(),
  });
  return agent;
}

function revisionStateIds(agent: any): string[] {
  return [
    agent.contextGraphSubscriptionPersistRevisions,
    agent.contextGraphSubscriptionPersistAppliedRevisions,
    agent.contextGraphSubscriptionPersistCanceledRevisions,
    agent.contextGraphSubscriptionPersistPendingRevisions,
  ].flatMap((map: Map<string, unknown>) => [...map.keys()]);
}

describe('enqueueContextGraphSubscriptionPersistWrite', () => {
  it('serializes writes to one context graph in order and overlaps different ones', async () => {
    const agent = persistenceAgent();
    const held = gate();
    const order: string[] = [];
    const first = agent.enqueueContextGraphSubscriptionPersistWrite('cg-a', async () => {
      order.push('a1:start');
      await held.promise;
      order.push('a1:end');
    });
    const second = agent.enqueueContextGraphSubscriptionPersistWrite('cg-a', async () => { order.push('a2'); });
    const other = agent.enqueueContextGraphSubscriptionPersistWrite('cg-b', async () => { order.push('b'); });
    await other;
    await flush();
    expect(order).toEqual(['a1:start', 'b']);
    held.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1:start', 'b', 'a1:end', 'a2']);
  });

  it('runs every queued write for one context graph instead of coalescing', async () => {
    const agent = persistenceAgent();
    const held = gate();
    const saved: number[] = [];
    const writes = Array.from({ length: 40 }, (_, index) =>
      agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => {
        if (index === 0) await held.promise;
        saved.push(index);
      }));
    held.open();
    await Promise.all(writes);
    expect(saved).toEqual(Array.from({ length: 40 }, (_, index) => index));
  });

  it('rejects the failing caller but does not stall or poison the next write', async () => {
    const agent = persistenceAgent();
    const boom = new Error('store down');
    const failed = agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => { throw boom; });
    const next = agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => undefined);
    await expect(failed).rejects.toBe(boom);
    await expect(next).resolves.toBeUndefined();
    await agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => undefined);
  });

  it('does not raise an unhandled rejection when a caller drops a failing write', async () => {
    const agent = persistenceAgent();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      void agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => { throw new Error('dropped'); });
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('starts a write after the caller finishes its synchronous section', async () => {
    const agent = persistenceAgent();
    const events: string[] = [];
    const write = agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => { events.push('write'); });
    events.push('caller-sync-done');
    await write;
    expect(events).toEqual(['caller-sync-done', 'write']);
  });

  it('clears revision bookkeeping once a failed write leaves the context graph idle', async () => {
    const agent = persistenceAgent();
    const revision = agent.nextContextGraphSubscriptionPersistRevision('cg');
    agent.claimContextGraphSubscriptionPersistRevision('cg', revision);
    expect(revisionStateIds(agent)).toContain('cg');
    await expect(agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => {
      throw new Error('store down');
    })).rejects.toThrow('store down');
    await flush();
    expect(revisionStateIds(agent)).not.toContain('cg');
  });

  it('keeps revision bookkeeping while a later write is still queued', async () => {
    const agent = persistenceAgent();
    agent.nextContextGraphSubscriptionPersistRevision('cg');
    const held = gate();
    const first = agent.enqueueContextGraphSubscriptionPersistWrite('cg', () => held.promise);
    const second = agent.enqueueContextGraphSubscriptionPersistWrite('cg', () => held.promise);
    held.open();
    await first;
    // The first write left the lane busy, so idle cleanup must not run yet.
    expect(agent.contextGraphSubscriptionPersistRevisions.has('cg')).toBe(true);
    await second;
    await flush();
    expect(agent.contextGraphSubscriptionPersistRevisions.has('cg')).toBe(false);
  });

  it('rejects with the closed error after the subscription queue is closed', async () => {
    const agent = persistenceAgent();
    await agent.contextGraphSubscriptionPersistence.closeAndDrain();
    await expect(agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => undefined))
      .rejects.toBeInstanceOf(ContextGraphSubscriptionPersistQueueClosedError);
  });
});

describe('persistContextGraphSubscription revision semantics', () => {
  function withStore() {
    const saves: ContextGraphSubscriptionRecord[] = [];
    const held = gate();
    const store = {
      loadAll: async () => [],
      save: vi.fn(async (record: ContextGraphSubscriptionRecord) => {
        await held.promise;
        saves.push(record);
      }),
      delete: vi.fn(async () => undefined),
    };
    const agent = persistenceAgent({ contextGraphSubscriptionStore: store });
    agent.subscribedContextGraphs.set('cg', sub());
    return { agent, saves, held, store };
  }

  it('drops the stale revision: only the newest claimed revision updates rehydration status', async () => {
    const { agent, saves, held } = withStore();
    // Revision 2 is admitted before revision 1 settles, so revision 1 is stale
    // when its own callback claims. Every write still reaches the store.
    const newest = agent.persistContextGraphSubscription('cg', { revision: 2, updateRehydrationStatus: true });
    const stale = agent.persistContextGraphSubscription('cg', { revision: 1, updateRehydrationStatus: true });
    held.open();
    await Promise.all([newest, stale]);
    expect(saves).toHaveLength(2);
    expect(agent.updateContextGraphSubscriptionRehydrationStatusAfterPersist).toHaveBeenCalledTimes(1);
  });

  it('a cancel that lands before a write settles drops its callback but not the durable write', async () => {
    const { agent, saves, held } = withStore();
    const revision = agent.nextContextGraphSubscriptionPersistRevision('cg');
    const write = agent.persistContextGraphSubscription('cg', { revision, updateRehydrationStatus: true });
    agent.cancelContextGraphSubscriptionPersistRevisions('cg');
    held.open();
    await write;
    expect(saves).toHaveLength(1);
    expect(agent.updateContextGraphSubscriptionRehydrationStatusAfterPersist).not.toHaveBeenCalled();
  });

  it('a superseded row is cleared from revision state after its last write and pending revision', async () => {
    const { agent, held } = withStore();
    const revision = agent.nextContextGraphSubscriptionPersistRevision('cg');
    const write = agent.persistContextGraphSubscription('cg', { revision, updateRehydrationStatus: true });
    // The node stops caring about the context graph before the write settles.
    agent.subscribedContextGraphs.delete('cg');
    held.open();
    await write;
    await flush();
    expect(revisionStateIds(agent)).not.toContain('cg');
  });

  it('logs and swallows a failed store write so its fire-and-forget callers stay quiet', async () => {
    const { agent, held, store } = withStore();
    store.save.mockImplementationOnce(async () => { throw new Error('disk full'); });
    held.open();
    await expect(agent.persistContextGraphSubscription('cg', { revision: 1 })).resolves.toBeUndefined();
    expect(agent.log.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Failed to persist context-graph subscription for "cg": disk full'),
    );
  });
});

describe('persistJoinApprovalStateStrict nesting', () => {
  function joinAgent() {
    const membershipSaves: ContextGraphMembershipRecord[] = [];
    const subscriptionSaves: ContextGraphSubscriptionRecord[] = [];
    const agent = persistenceAgent({
      contextGraphMembershipStore: {
        loadAll: async () => [],
        upsert: async (record: ContextGraphMembershipRecord) => { membershipSaves.push(record); },
        delete: async () => undefined,
      },
      contextGraphSubscriptionStore: {
        loadAll: async () => [],
        load: async () => null,
        save: async (record: ContextGraphSubscriptionRecord) => { subscriptionSaves.push(record); },
        delete: async () => undefined,
      },
    });
    const membership: ContextGraphMembershipRecord = {
      contextGraphId: 'join-cg',
      principalType: 'node',
      principalId: 'peer-1',
      status: 'active',
    } as ContextGraphMembershipRecord;
    return { agent, membership, membershipSaves, subscriptionSaves };
  }

  it('completes a membership write that awaits a subscription write on a different key', async () => {
    const { agent, membership, membershipSaves, subscriptionSaves } = joinAgent();
    await withinMs(
      agent.persistJoinApprovalStateStrict('join-cg', membership, sub({ name: 'join-cg' })),
      2_000,
      'persistJoinApprovalStateStrict',
    );
    expect(membershipSaves).toHaveLength(1);
    expect(subscriptionSaves).toEqual([expect.objectContaining({ id: 'join-cg', subscribed: true })]);
    expect(agent.contextGraphMembershipPersistence.status()).toMatchObject({ lanes: 0 });
    expect(agent.contextGraphSubscriptionPersistence.status()).toMatchObject({ lanes: 0 });
  });

  it('queues the nested subscription write behind an earlier subscription write for that graph', async () => {
    const { agent, membership, subscriptionSaves } = joinAgent();
    const held = gate();
    const order: string[] = [];
    const earlier = agent.enqueueContextGraphSubscriptionPersistWrite('join-cg', async () => {
      order.push('earlier:start');
      await held.promise;
      order.push('earlier:end');
    });
    const join = agent.persistJoinApprovalStateStrict('join-cg', membership, sub({ name: 'join-cg' }));
    await flush();
    expect(subscriptionSaves).toHaveLength(0);
    held.open();
    await withinMs(Promise.all([earlier, join]), 2_000, 'join approval behind an earlier write');
    expect(order).toEqual(['earlier:start', 'earlier:end']);
    expect(subscriptionSaves).toHaveLength(1);
  });
});

function shutdownAgent(overrides: Record<string, unknown> = {}): any {
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.chain = new MockChainAdapter();
  agent.peerSyncSession = PeerSyncSession.stopped();
  agent.lastSyncDisconnectedAt = new Map();
  agent.selectedSwmBootstrapAdmission = new SelectedSwmBootstrapAdmission();
  agent.rfc64BackgroundWorkDispatcherV1 = new Rfc64BackgroundWorkDispatcherV1();
  agent.storageACKRegistrationRuntime = new StorageACKRegistrationRuntime();
  const stopNode = vi.fn(async () => {});
  const closeStore = vi.fn(async () => {});
  Object.assign(agent, {
    started: true,
    chainPoller: null,
    contextGraphSubscriptionPersistence: new ContextGraphSubscriptionPersistScheduler(),
    contextGraphMembershipPersistence: new ContextGraphMembershipPersistScheduler(),
    contextGraphSubscriptionPersistRevisions: new Map<string, number>(),
    contextGraphSubscriptionPersistAppliedRevisions: new Map<string, number>(),
    contextGraphSubscriptionPersistCanceledRevisions: new Map<string, number>(),
    contextGraphSubscriptionPersistPendingRevisions: new Map<string, Set<number>>(),
    contextGraphSubscriptionRehydrationAccountedIds: new Set<string>(),
    subscribedContextGraphs: new Map<string, ContextGraphSub>(),
    coreHostRecordingsClosed: false,
    drainCoreHostRecordings: vi.fn(async () => {}),
    messenger: { stopOutboxDrain: vi.fn(async () => {}) },
    clearStorageACKRegistrationRetry: vi.fn(),
    storageACKRegistrationRetryInFlight: false,
    inFlightSubstrateFanOutCount: () => 0,
    router: { closePooling: vi.fn(async () => {}) },
    node: { libp2p: { getPeers: () => [] }, stop: stopNode },
    chain: { chainId: 'none' },
    finalizationRuntime: new FinalizationRuntime(),
    store: { close: closeStore },
    log: { warn: vi.fn() },
    ...overrides,
  });
  return agent;
}

describe('DKGAgent.stop() subscription persistence drain', () => {
  it('waits for an in-flight subscription write before network and store teardown', async () => {
    const agent = shutdownAgent();
    const held = gate();
    let written = false;
    const write = agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => {
      await held.promise;
      written = true;
    });

    const stopping = agent.stop();
    await flush();
    expect(agent.node.stop).not.toHaveBeenCalled();
    expect(agent.store.close).not.toHaveBeenCalled();

    held.open();
    await Promise.all([write, stopping]);
    expect(written).toBe(true);
    expect(agent.node.stop).toHaveBeenCalledOnce();
    expect(agent.store.close).toHaveBeenCalledOnce();
    expect(agent.contextGraphSubscriptionPersistence.status()).toEqual({
      closed: true, lanes: 0, active: 0, pending: 0,
    });
  });

  it('drains writes that were admitted but had not started when stop() was called', async () => {
    const agent = shutdownAgent();
    const held = gate();
    const saved: string[] = [];
    const active = agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => {
      await held.promise;
      saved.push('active');
    });
    const queued = agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => { saved.push('queued'); });

    const stopping = agent.stop();
    await flush();
    expect(agent.node.stop).not.toHaveBeenCalled();
    held.open();
    await Promise.all([active, queued, stopping]);
    expect(saved).toEqual(['active', 'queued']);
  });

  it('rejects a subscription write enqueued after stop() closed admission', async () => {
    const agent = shutdownAgent();
    await agent.stop();
    await expect(agent.enqueueContextGraphSubscriptionPersistWrite('late', async () => undefined))
      .rejects.toBeInstanceOf(ContextGraphSubscriptionPersistQueueClosedError);
  });

  it('lets a queued membership write finish its nested subscription write during stop()', async () => {
    const agent = shutdownAgent();
    const heldMembership = gate();
    const saved: string[] = [];
    // A membership write is active and a second, join-approval-shaped one is
    // queued behind it, not yet running, when stop() is called.
    const activeMembership = agent.enqueueContextGraphMembershipPersistWrite(
      'join-cg\0node\0peer',
      () => heldMembership.promise,
      { strict: true },
    );
    const queuedJoin = agent.enqueueContextGraphMembershipPersistWrite(
      'join-cg\0node\0peer',
      () => agent.enqueueContextGraphSubscriptionPersistWrite('join-cg', async () => { saved.push('subscription'); }),
      { strict: true },
    );

    const stopping = agent.stop();
    await flush();
    expect(agent.node.stop).not.toHaveBeenCalled();
    heldMembership.open();
    await withinMs(Promise.all([activeMembership, queuedJoin, stopping]), 2_000, 'stop() with a queued nested join write');
    expect(saved).toEqual(['subscription']);
    expect(agent.node.stop).toHaveBeenCalledOnce();
  });

  it('admits the cursor write of a sync run that stop() is still waiting for', async () => {
    const agent = shutdownAgent();
    const runGate = gate();
    const saved: string[] = [];
    let runOutcome: unknown = 'pending';
    // A graph-scoped physical run that is in flight when stop() begins persists
    // its cursor through the subscription queue after stop() has started.
    const run = (async () => {
      await runGate.promise;
      await agent.enqueueContextGraphSubscriptionPersistWrite('cg', async () => { saved.push('cursor'); });
    })().then(() => { runOutcome = 'written'; }, (error: unknown) => { runOutcome = error; });
    agent.graphScopedStorePhysicalRuns = new Set([run]);

    const stopping = agent.stop();
    await flush();
    expect(agent.node.stop).not.toHaveBeenCalled();
    runGate.open();
    await stopping;

    expect(runOutcome).toBe('written');
    expect(saved).toEqual(['cursor']);
    expect(agent.node.stop).toHaveBeenCalledOnce();
    expect(agent.contextGraphSubscriptionPersistence.status().closed).toBe(true);
  });

  it('quarantines start and store teardown when subscription persistence does not drain in time', async () => {
    const originalTimeout = DKGAgentBase.CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT_MS;
    Object.defineProperty(DKGAgentBase, 'CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT_MS', {
      configurable: true,
      value: 1,
    });
    const agent = shutdownAgent();
    const held = gate();
    const stuck = agent.enqueueContextGraphSubscriptionPersistWrite('stuck', () => held.promise);

    try {
      const timeout = await agent.stop().catch((error: unknown) => error);
      expect(timeout).toBeInstanceOf(ContextGraphSubscriptionPersistShutdownTimeoutError);
      expect(timeout).toMatchObject({ code: 'CG_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT' });
      expect(agent.node.stop).not.toHaveBeenCalled();
      expect(agent.store.close).not.toHaveBeenCalled();
      expect(agent.log.warn).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('context-graph subscription persistence did not drain'),
      );
      await expect(agent.start()).rejects.toBeInstanceOf(ContextGraphSubscriptionPersistShutdownTimeoutError);

      held.open();
      await stuck;
      // The flag clears only through a successful stop() retry, not by the write settling.
      await expect(agent.start()).rejects.toBeInstanceOf(ContextGraphSubscriptionPersistShutdownTimeoutError);
      await expect(agent.stop()).resolves.toBeUndefined();
      expect(agent.node.stop).toHaveBeenCalledOnce();
      expect(agent.store.close).toHaveBeenCalledOnce();
      expect(agent.started).toBe(false);
    } finally {
      held.open();
      Object.defineProperty(DKGAgentBase, 'CONTEXT_GRAPH_SUBSCRIPTION_PERSIST_SHUTDOWN_TIMEOUT_MS', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  it('still stops a synthetic agent that has no subscription scheduler', async () => {
    const agent = shutdownAgent({ contextGraphSubscriptionPersistence: undefined });
    await expect(agent.stop()).resolves.toBeUndefined();
    expect(agent.node.stop).toHaveBeenCalledOnce();
  });
});

describe('DKGAgent restart', () => {
  async function createAgent(store: Record<string, unknown>) {
    return DKGAgent.create({
      name: 'SubscriptionPersistRestart',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      rfc64CatalogActivation: { enabled: false },
      contextGraphSubscriptionStore: store as any,
    });
  }

  it('closes subscription admission on stop() and reopens it on the same-object restart', async () => {
    const saved = new Map<string, ContextGraphSubscriptionRecord>();
    const agent = await createAgent({
      loadAll: async () => [...saved.values()],
      save: async (record: ContextGraphSubscriptionRecord) => { saved.set(record.id, { ...record }); },
      delete: async (id: string) => { saved.delete(id); },
    });
    try {
      await agent.start();
      expect((agent as any).contextGraphSubscriptionPersistence.status().closed).toBe(false);
      await agent.stop();
      expect((agent as any).contextGraphSubscriptionPersistence.status()).toEqual({
        closed: true, lanes: 0, active: 0, pending: 0,
      });

      await agent.start();
      expect((agent as any).contextGraphSubscriptionPersistence.status().closed).toBe(false);
      const before = saved.size;
      agent.setContextGraphSubscription('restart-cg', {
        name: 'restart-cg',
        subscribed: true,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: false,
      });
      await vi.waitFor(() => expect(saved.size).toBe(before + 1));
      expect(saved.get('restart-cg')).toMatchObject({ id: 'restart-cg', subscribed: true });
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('starts without error when subscription writes were already in flight before the first start()', async () => {
    const held = gate();
    const saved = new Map<string, ContextGraphSubscriptionRecord>();
    const agent = await createAgent({
      loadAll: async () => [...saved.values()],
      save: async (record: ContextGraphSubscriptionRecord) => {
        if (record.id === 'pre-start-cg') await held.promise;
        saved.set(record.id, { ...record });
      },
      delete: async (id: string) => { saved.delete(id); },
    });
    try {
      (agent as any).subscribedContextGraphs.set('pre-start-cg', sub({ name: 'pre-start-cg' }));
      const pending = agent.persistContextGraphSubscription('pre-start-cg', { revision: 1 });
      await flush();
      expect((agent as any).contextGraphSubscriptionPersistence.hasLane('pre-start-cg')).toBe(true);
      // reopen() refuses while a lane exists, so start() must not call it on a
      // scheduler that was never closed.
      await withinMs(agent.start(), 20_000, 'start() with a write in flight');
      expect((agent as any).contextGraphSubscriptionPersistence.status().closed).toBe(false);
      held.open();
      await pending;
      expect(saved.get('pre-start-cg')).toMatchObject({ id: 'pre-start-cg', subscribed: true });
    } finally {
      held.open();
      await agent.stop().catch(() => {});
    }
  }, 30_000);
});
