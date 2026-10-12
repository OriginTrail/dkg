// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import {
  contextGraphSubscriptionRowsEqual,
  contextGraphSubscriptionSyncPremisesEqual,
  continueContextGraphSubscriptionLine,
  isContextGraphSubscriptionStoredAgain,
} from '../src/context-graph-subscription-policy.js';
import { runGraphScopedPhysicalOperation } from '../src/sync/requester/graph-scoped-operation-fence.js';
import { resolveRfc64CatalogExecutionPlanV1 } from '../src/rfc64/public-catalog-activation-config-v1.js';
import type {
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
} from '../src/dkg-agent-types.js';

function row(overrides: Partial<ContextGraphSub> = {}): ContextGraphSub {
  return { syncMode: 'always-on', subscribed: true, synced: false, ...overrides };
}

describe('contextGraphSubscriptionRowsEqual', () => {
  it('finds a copy, an absent field and an undefined field equal', () => {
    expect(contextGraphSubscriptionRowsEqual(row(), { ...row() })).toBe(true);
    expect(contextGraphSubscriptionRowsEqual(row(), row({ onChainId: undefined }))).toBe(true);
    expect(contextGraphSubscriptionRowsEqual(row({ onChainId: undefined }), row())).toBe(true);
    expect(contextGraphSubscriptionRowsEqual(
      row({ participantAgents: ['0xa', '0xb'] }),
      row({ participantAgents: ['0xa', '0xb'] }),
    )).toBe(true);
  });

  it.each<[string, Partial<ContextGraphSub>, Partial<ContextGraphSub>]>([
    ['a changed flag', {}, { synced: true }],
    ['a flag that was absent and is now false', {}, { sharedMemorySynced: false }],
    ['a flag that was false and is now absent', { metaSynced: false }, {}],
    ['a new chain binding', {}, { onChainId: '7' }],
    ['another lifetime', {}, { syncMode: 'on-demand' }],
    ['a moved watermark', { lastReconciledOrdinal: 1 }, { lastReconciledOrdinal: 2 }],
    ['a longer roster', { participantAgents: ['0xa'] }, { participantAgents: ['0xa', '0xb'] }],
    ['another roster member', { participantAgents: ['0xa'] }, { participantAgents: ['0xb'] }],
    ['a roster that appeared', {}, { participantAgents: [] }],
  ])('finds %s different', (_what, stored, next) => {
    expect(contextGraphSubscriptionRowsEqual(row(stored), row(next))).toBe(false);
  });
});

describe('contextGraphSubscriptionSyncPremisesEqual', () => {
  it('holds across readiness bookkeeping, the reconcile watermark and descriptive fields', () => {
    const captured = row({ onChainId: '7', onChainHash: '0xabc', metaSynced: true });
    expect(contextGraphSubscriptionSyncPremisesEqual(captured, {
      ...captured,
      synced: true,
      sharedMemorySynced: false,
      lastReconciledOrdinal: 4,
      name: 'renamed',
      participantAgents: ['0xa'],
      pendingMeta: false,
      coreHosted: false,
    })).toBe(true);
  });

  it.each<[string, Partial<ContextGraphSub>]>([
    ['the subscription', { subscribed: false }],
    ['core hosting', { coreHosted: true }],
    ['the lifetime', { syncMode: 'on-demand' }],
    ['the on-chain id', { onChainId: '8' }],
    ['the name commitment', { onChainHash: '0xdef' }],
    ['the metadata proof', { metaSynced: false }],
    ['an absent metadata proof', { metaSynced: undefined }],
    ['the wait for metadata', { pendingMeta: true }],
  ])('does not hold when a stored-again row changed %s', (_what, change) => {
    const captured = row({ onChainId: '7', onChainHash: '0xabc', metaSynced: true });
    expect(contextGraphSubscriptionSyncPremisesEqual(captured, { ...captured, ...change })).toBe(false);
  });

  it('does not hold for a row that appeared or went away', () => {
    expect(contextGraphSubscriptionSyncPremisesEqual(undefined, row())).toBe(false);
    expect(contextGraphSubscriptionSyncPremisesEqual(row(), undefined)).toBe(false);
    expect(contextGraphSubscriptionSyncPremisesEqual(undefined, undefined)).toBe(false);
  });
});

describe('isContextGraphSubscriptionStoredAgain', () => {
  it('follows a row through every row stored over it', () => {
    const first = row();
    const second = row({ synced: true });
    const third = row({ synced: true, sharedMemorySynced: true });
    continueContextGraphSubscriptionLine(first, second);
    continueContextGraphSubscriptionLine(second, third);

    expect(isContextGraphSubscriptionStoredAgain(first, first)).toBe(true);
    expect(isContextGraphSubscriptionStoredAgain(first, second)).toBe(true);
    expect(isContextGraphSubscriptionStoredAgain(first, third)).toBe(true);
    expect(isContextGraphSubscriptionStoredAgain(second, third)).toBe(true);
  });

  it('does not take an equal row of another subscription for it, or a missing row', () => {
    const first = row();
    const second = row({ synced: true });
    continueContextGraphSubscriptionLine(first, second);
    // Installed by a new subscribe after the subscription was deleted.
    const recreated = { ...first };

    expect(isContextGraphSubscriptionStoredAgain(first, recreated)).toBe(false);
    expect(isContextGraphSubscriptionStoredAgain(second, recreated)).toBe(false);
    expect(isContextGraphSubscriptionStoredAgain(first, undefined)).toBe(false);
    expect(isContextGraphSubscriptionStoredAgain(undefined, first)).toBe(false);
    expect(isContextGraphSubscriptionStoredAgain(undefined, undefined)).toBe(false);
  });
});

describe('a graph-scoped operation and a row stored again while it runs', () => {
  function fence(options: {
    isEquivalentSubscription?: (captured: object | undefined, current: object | undefined) => boolean;
  } = {}) {
    const live = { row: { version: 1 } as object | undefined, generation: 0 };
    const run = <T>(operation: Parameters<typeof runGraphScopedPhysicalOperation<T, object | undefined>>[0]['operation']) => (
      runGraphScopedPhysicalOperation<T, object | undefined>({
        contextGraphId: 'cg',
        isClosed: () => false,
        captureSubscription: () => live.row,
        captureBindingGeneration: () => live.generation,
        isBindingGenerationCurrent: (generation) => generation === live.generation,
        ...options,
        assertLifecycleCurrent: () => {},
        closedError: () => new Error('closed'),
        bindingChangedError: () => new Error('binding changed'),
        asAbortError: (reason) => reason as Error,
        track: () => {},
        untrack: () => {},
        operation,
      })
    );
    return { live, run };
  }

  it('refuses the stored-again row when the host names no equivalent rows', async () => {
    const { live, run } = fence();
    await expect(run(async (control) => {
      live.row = { version: 1 };
      control.adoptEquivalentSubscription();
      control.assertCurrent();
    })).rejects.toThrow('binding changed');
  });

  it('continues under a row the host finds equivalent, and fences on that row from then on', async () => {
    const isEquivalentSubscription = vi.fn(() => true);
    const { live, run } = fence({ isEquivalentSubscription });
    const captured = live.row;
    const storedAgain = { version: 1 };
    await expect(run(async (control) => {
      expect(control.subscription).toBe(captured);
      // Nothing was stored again: nothing to ask the host about.
      control.adoptEquivalentSubscription();
      expect(isEquivalentSubscription).not.toHaveBeenCalled();

      live.row = storedAgain;
      expect(control.isBindingCurrent()).toBe(false);
      control.adoptEquivalentSubscription();
      expect(isEquivalentSubscription).toHaveBeenCalledWith(captured, storedAgain);
      expect(control.subscription).toBe(storedAgain);
      control.assertCurrent();

      live.row = { version: 1 };
      control.assertCurrent();
    })).rejects.toThrow('binding changed');
  });

  it('refuses a row the host finds different', async () => {
    const { live, run } = fence({ isEquivalentSubscription: () => false });
    const captured = live.row;
    await expect(run(async (control) => {
      live.row = { version: 2 };
      control.adoptEquivalentSubscription();
      expect(control.subscription).toBe(captured);
      control.assertCurrent();
    })).rejects.toThrow('binding changed');
  });

  it('refuses an equivalent row once the binding generation moved', async () => {
    const isEquivalentSubscription = vi.fn(() => true);
    const { live, run } = fence({ isEquivalentSubscription });
    await expect(run(async (control) => {
      live.row = { version: 1 };
      live.generation += 1;
      control.adoptEquivalentSubscription();
      control.assertCurrent();
    })).rejects.toThrow('binding changed');
    expect(isEquivalentSubscription).not.toHaveBeenCalled();
  });
});

describe('a subscription write that changes nothing', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => undefined);
    await agent?.store.close().catch(() => undefined);
    agent = undefined;
  });

  /** `catalog`: the RFC-64 catalog carries the graph's shared memory; `legacy`: the gossip lane does. */
  async function node(lane: 'catalog' | 'legacy', saved: ContextGraphSubscriptionRecord[] = []) {
    const store: ContextGraphSubscriptionStore = {
      loadAll: async () => [],
      save: async (record) => { saved.push(record); },
      delete: async () => {},
    };
    agent = await DKGAgent.create({
      name: `SubscriptionRowIdentity-${Math.random().toString(36).slice(2)}`,
      chainAdapter: new MockChainAdapter(),
      contextGraphSubscriptionStore: store,
    });
    (agent as unknown as { config: { rfc64CatalogExecutionPlan: unknown } }).config
      .rfc64CatalogExecutionPlan = resolveRfc64CatalogExecutionPlanV1({
        configuredContextGraphs: [],
        responsibilityDefaultMode: lane,
        activation: {
          enabled: false,
          selectedContextGraphs: [],
          selectedPublicContextGraphs: [],
          rollout: { killSwitch: false, defaultMode: lane, contextGraphModes: {} },
        },
      });
    // Subscription state changes are under test; no peer is needed for them.
    vi.spyOn(agent, 'peerId', 'get').mockReturnValue('peer-subscription-row-identity');
    agent.gossip = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      onMessage: vi.fn(),
      offMessage: vi.fn(),
      publish: vi.fn(async () => undefined),
      getSubscribers: () => [],
    } as unknown as DKGAgent['gossip'];
    const rows = agent.getSubscribedContextGraphs() as Map<string, ContextGraphSub>;
    return { agent, rows };
  }

  it.each(['catalog', 'legacy'] as const)('keeps the stored row when a client repeats its subscribe (%s lane)', async (lane) => {
    const { agent, rows } = await node(lane);
    const contextGraphId = 'repeat-subscribe';
    expect(agent.rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId)).toBe(lane === 'legacy');
    const first = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
    expect(rows.get(contextGraphId)).toBe(first);
    const generation = agent.contextGraphBindingState.capture(contextGraphId);

    const repeated = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });

    expect(repeated).toBe(first);
    expect(rows.get(contextGraphId)).toBe(first);
    expect(agent.contextGraphBindingState.isGenerationCurrent(contextGraphId, generation)).toBe(true);
  });

  it('keeps the stored row for a readiness result equal to the stored state, and stores a new row for another', async () => {
    const { agent, rows } = await node('catalog');
    const contextGraphId = 'repeat-readiness';
    const first = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });

    agent.markContextGraphSubscriptionState(contextGraphId, { synced: false });
    expect(rows.get(contextGraphId)).toBe(first);

    agent.markContextGraphSubscriptionState(contextGraphId, { synced: false, sharedMemorySynced: false });
    const second = rows.get(contextGraphId)!;
    expect(second).not.toBe(first);
    expect(second).toEqual({ ...first, sharedMemorySynced: false });

    agent.markContextGraphSubscriptionState(contextGraphId, { synced: false, sharedMemorySynced: false });
    expect(rows.get(contextGraphId)).toBe(second);
  });

  it('keeps the rows it stores over one another in one line, and starts a new line after a deletion', async () => {
    const { agent, rows } = await node('catalog');
    const contextGraphId = 'line-of-rows';
    const first = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
    const generation = agent.contextGraphBindingState.capture(contextGraphId);

    agent.markContextGraphSubscriptionState(contextGraphId, { sharedMemorySynced: false });
    const second = rows.get(contextGraphId)!;
    expect(second).not.toBe(first);
    expect(isContextGraphSubscriptionStoredAgain(first, second)).toBe(true);

    // Deleted and subscribed again: the same fields and the same binding
    // generation as the first row had, and another subscription.
    agent.deleteContextGraphSubscription(contextGraphId);
    const recreated = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
    expect(recreated).toEqual(first);
    expect(agent.contextGraphBindingState.isGenerationCurrent(contextGraphId, generation)).toBe(true);
    expect(isContextGraphSubscriptionStoredAgain(first, recreated)).toBe(false);
    expect(isContextGraphSubscriptionStoredAgain(second, recreated)).toBe(false);
  });

  it('stores a new row for a caller that changed the stored row in place and writes it back', async () => {
    const { agent, rows } = await node('catalog');
    const contextGraphId = 'in-place-then-write';
    const first = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });

    // What recording a hosted graph does: it edits the live row and stores it.
    first.coreHosted = true;
    const written = agent.setContextGraphSubscription(contextGraphId, first, { persist: false });

    expect(written).not.toBe(first);
    expect(rows.get(contextGraphId)).toBe(written);
    expect(written).toEqual(first);
  });

  it('stores a new row when a repeated subscribe changes the lifetime or the binding', async () => {
    const { agent, rows } = await node('catalog');
    const contextGraphId = 'changing-subscribe';
    const onDemand = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'on-demand' });
    const alwaysOn = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
    expect(alwaysOn).not.toBe(onDemand);
    expect(alwaysOn.syncMode).toBe('always-on');

    const generation = agent.contextGraphBindingState.capture(contextGraphId);
    const bound = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', onChainId: '7' });
    expect(bound).not.toBe(alwaysOn);
    expect(rows.get(contextGraphId)).toBe(bound);
    expect(agent.contextGraphBindingState.isGenerationCurrent(contextGraphId, generation)).toBe(false);
  });

  it('still saves the row a repeated subscribe leaves unchanged', async () => {
    const saved: ContextGraphSubscriptionRecord[] = [];
    const { agent, rows } = await node('catalog', saved);
    const contextGraphId = 'repeat-subscribe-saved';
    // Installed without a save, as an internal activation does.
    const first = agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', persist: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saved.filter((record) => record.id === contextGraphId)).toEqual([]);

    agent.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });

    expect(rows.get(contextGraphId)).toBe(first);
    await vi.waitFor(() => {
      expect(saved.filter((record) => record.id === contextGraphId)).toHaveLength(1);
    });
    expect(saved.find((record) => record.id === contextGraphId)).toMatchObject({ subscribed: true });
  });
});
