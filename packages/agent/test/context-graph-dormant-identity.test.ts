import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext, contextGraphDataGraphUri, contextGraphMetaGraphUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { buildAuthoritativePublicMetaQuads } from '../src/context-graph-public-meta-proof.js';
import { projectContextGraphSubscriptionPersistence } from '../src/context-graph-subscription-policy.js';
import type {
  ContextGraphMembershipRecord,
  ContextGraphSub,
  ContextGraphSubInput,
  ContextGraphSubscriptionRecord,
  ContextGraphSubscriptionStore,
} from '../src/dkg-agent-types.js';

const LOCAL = 'cold-dormant-exact-identity';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const ORIGINAL = '585';
const COLLISION = '586';
const OWNER = '0x1111111111111111111111111111111111111111';
const FOREIGN = '0x2222222222222222222222222222222222222222';
const PACKED_KA = (BigInt(OWNER) << 96n) | 4864n;
const ROOT = `0x${'33'.repeat(32)}`;

interface Internals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  wireIdToLocalCgId: Map<string, string>;
  config: { syncContextGraphs?: string[] };
  gossipRegistered: Set<string>;
  setContextGraphSubscription(id: string, next: ContextGraphSubInput, options?: { persist?: boolean }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  enqueueContextGraphMembershipPersistWrite(key: string, write: () => Promise<void>): Promise<void>;
}

function durable(overrides: Partial<ContextGraphSubscriptionRecord> = {}): ContextGraphSubscriptionRecord {
  return {
    id: LOCAL, subscribed: true, synced: true, sharedMemorySynced: true,
    metaSynced: true, syncScoped: false, onChainId: ORIGINAL, onChainHash: HASH,
    ...overrides,
  };
}

const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

async function cold(rows: ContextGraphSubscriptionRecord[] = [durable()], seedDormant = true, options: { enabled?: boolean; cap?: number; syncScoped?: boolean; live?: boolean; pointRead?: boolean } = {}) {
  // Genuine native lifecycle methods and typed persistence contract. No daemon,
  // provider, external RPC or custom numeric resolver is started.
  let retained = rows.map((row) => ({ ...row }));
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => {
    retained = [...retained.filter((old) => old.id !== row.id), { ...row }];
  });
  const remove = vi.fn(async (id: string) => { retained = retained.filter((row) => row.id !== id); });
  const membership = new Map<string, ContextGraphMembershipRecord & { updatedAt: number }>();
  const memberKey = (cg: string, kind: string, principal: string) => [cg, kind, principal].join('\0');
  const memberSave = vi.fn(async (row: ContextGraphMembershipRecord & { updatedAt: number }) => {
    membership.set(memberKey(row.contextGraphId, row.principalType, row.principalId), { ...row });
  });
  const memberRemove = vi.fn(async (cg: string, kind: string, principal: string) => {
    membership.delete(memberKey(cg, kind, principal));
  });
  const subscriptionStore: ContextGraphSubscriptionStore = {
    loadAll: async () => retained.map((row) => ({ ...row })), save, delete: remove,
    ...(options.pointRead ? { load: async (id: string) => {
      const row = retained.find((candidate) => candidate.id === id);
      return row ? { ...row } : null;
    } } : {}),
  };
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 585n });
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASH });
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASH });
  chain.__registerKC({ kaId: PACKED_KA, contextGraphId: 585n, merkleRootHex: ROOT, chunks: [] });
  const agent = await DKGAgent.create({
    name: 'DormantIdentity', chainAdapter: chain, nodeRole: 'edge',
    ...(options.live ? { listenHost: '127.0.0.1', listenPort: 0 } : {}),
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: options.enabled ?? false,
    maxRehydratedContextGraphSubscriptions: options.cap,
    syncContextGraphs: options.syncScoped ? [LOCAL] : undefined,
    contextGraphMembershipStore: {
      loadAll: async () => [...membership.values()].map((row) => ({ ...row })),
      upsert: memberSave, delete: memberRemove,
    },
    contextGraphSubscriptionStore: subscriptionStore,
  });
  agents.push(agent);
  const state = agent as unknown as Internals;
  if (options.live) await agent.start();
  else (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWDormantIdentityFixture', libp2p: { getPeers: () => [] },
  };
  if (seedDormant) state.setContextGraphSubscription(LOCAL, { subscribed: false, synced: false }, { persist: false });
  const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
  const policy = vi.spyOn(chain, 'getContextGraphAccessPolicy');
  const drain = async () => {
    for (const id of [LOCAL, HASH]) await state.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
    await state.enqueueContextGraphMembershipPersistWrite(
      memberKey(LOCAL, 'node', agent.peerId), async () => undefined,
    );
  };
  const seedMember = async () => {
    await agent.upsertContextGraphMember({
      contextGraphId: LOCAL, principalType: 'node', principalId: agent.peerId,
      role: 'subscriber', status: 'active', source: 'subscription',
      metadata: { subscribed: true, onChainId: ORIGINAL },
    }, { strict: true });
    await drain();
    memberSave.mockClear();
    memberRemove.mockClear();
  };
  return {
    agent, state, chain, save, remove, reverse, policy, drain, seedMember, subscriptionStore,
    memberSave, memberRemove, members: () => [...membership.values()], rows: () => retained,
  };
}

async function competingWireOwner() {
  const f = await cold([durable({ onChainId: '582' })], false);
  f.state.setContextGraphSubscription(HASH, {
    subscribed: false, coreHosted: true, synced: true,
    onChainId: '323', onChainHash: HASH,
  }, { persist: false });
  f.agent.applyOnChainContextGraphObservation(observed('323'), { source: 'checkpoint' });
  await f.agent.rehydrateContextGraphSubscriptions(null);
  await f.drain();
  f.save.mockClear();
  f.remove.mockClear();
  f.memberRemove.mockClear();
  return f;
}

function observed(id: string) {
  return {
    contextGraphId: id, nameHash: HASH, owner: id === ORIGINAL ? OWNER : FOREIGN,
    accessPolicy: 0, publishPolicy: 1, active: true, observedAtBlock: id === ORIGINAL ? 100 : 200,
  };
}

describe('dormant durable Context Graph identity', () => {

  it.each(['unsubscribe', 'subscribe-then-unsubscribe'] as const)(
    'preserves independent saved Core hosting through disabled member %s', async (operation) => {
      const f = await cold([durable({ coreHosted: true, lastReconciledOrdinal: 7 })], false, { live: true });
      await f.agent.rehydrateContextGraphSubscriptions(null);
      expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
        subscribed: false, coreHosted: false, synced: false, metaSynced: false,
        onChainId: ORIGINAL, onChainHash: HASH,
      });
      if (operation === 'subscribe-then-unsubscribe') {
        f.agent.subscribeToContextGraph(LOCAL);
        await f.drain();
        expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
          subscribed: true, coreHosted: false, synced: false, metaSynced: false,
        });
        expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
          activated: 1, hostedActivated: 0, hostedActivatedIds: [],
        });
        expect(f.rows().filter((row) => row.id === LOCAL)).toEqual([expect.objectContaining({
          subscribed: true, coreHosted: true, onChainId: ORIGINAL, onChainHash: HASH,
        })]);
      }
      f.agent.unsubscribeFromContextGraph(LOCAL);
      await f.drain();
      expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
        subscribed: false, coreHosted: false, synced: false, metaSynced: false,
      });
      expect(f.rows().filter((row) => row.id === LOCAL)).toEqual([expect.objectContaining({
        subscribed: false, coreHosted: true, synced: false, metaSynced: false,
        syncScoped: false, onChainId: ORIGINAL, onChainHash: HASH, lastReconciledOrdinal: 7,
      })]);
      expect(f.remove).not.toHaveBeenCalledWith(LOCAL);
      expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
        activated: 0, hostedActivated: 0, hostedActivatedIds: [],
        dormantReasons: { rehydrationDisabled: [LOCAL] },
      });
    },
  );

  it.each(['strict-subscription', 'strict-join'] as const)(
    'preserves dormant Core hosting through the native %s point-read store', async (operation) => {
      const f = await cold([durable({ coreHosted: true })], false, { pointRead: true });
      await f.agent.rehydrateContextGraphSubscriptions(null);
      const subscription = f.state.setContextGraphSubscription(LOCAL, {
        ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true,
      }, { persist: false });
      if (operation === 'strict-subscription') {
        await f.agent.persistContextGraphSubscriptionStrict(LOCAL, subscription);
      } else {
        await f.agent.persistJoinApprovalStateStrict(LOCAL, {
          contextGraphId: LOCAL, principalType: 'node', principalId: f.agent.peerId,
          role: 'subscriber', status: 'active', source: 'join',
        }, subscription);
      }
      expect(f.rows()).toEqual([expect.objectContaining({
        subscribed: true, coreHosted: true, synced: false, metaSynced: false,
        onChainId: ORIGINAL, onChainHash: HASH,
      })]);
      expect(f.state.subscribedContextGraphs.get(LOCAL)?.coreHosted).toBe(false);
    },
  );

  it.each([ORIGINAL, COLLISION])('carries wire-keyed saved hosting only into the same canonical slot %s', async (slot) => {
    const f = await cold([durable({ id: HASH, coreHosted: true })], false, { live: true });
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.agent.subscribeToContextGraph(LOCAL, { onChainId: slot });
    await f.drain();
    const saved = f.rows().find((row) => row.id === LOCAL);
    if (slot === ORIGINAL) expect(saved?.coreHosted).toBe(true);
    else expect(saved?.coreHosted).not.toBe(true);
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.coreHosted).not.toBe(true);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    await f.drain();
    if (slot === ORIGINAL) expect(f.rows().find((row) => row.id === LOCAL)?.coreHosted).toBe(true);
    else expect(f.rows().some((row) => row.id === LOCAL)).toBe(false);
  });

  it.each([
    ['member', `0x${HASH.slice(2).toUpperCase()}`], ['join', HASH],
    ['join', `0x${HASH.slice(2).toUpperCase()}`],
  ] as const)('preserves case-folded wire hosting through native %s migration from %s', async (operation, wireId) => {
    const f = await cold([durable({ id: wireId, coreHosted: true })], false, { live: true, pointRead: true });
    await f.agent.rehydrateContextGraphSubscriptions(null);
    if (operation === 'member') {
      f.state.setContextGraphSubscription(LOCAL, {
        subscribed: false, coreHosted: false, synced: false,
        onChainId: ORIGINAL, onChainHash: HASH,
      }, { persist: false });
      f.agent.subscribeToContextGraph(LOCAL, { onChainId: ORIGINAL });
    }
    else {
      const subscription = f.state.setContextGraphSubscription(LOCAL, {
        subscribed: true, coreHosted: false, synced: false,
        onChainId: ORIGINAL, onChainHash: HASH,
      }, { persist: false });
      await f.agent.persistJoinApprovalStateStrict(LOCAL, {
        contextGraphId: LOCAL, principalType: 'node', principalId: f.agent.peerId,
        role: 'subscriber', status: 'active', source: 'join',
      }, subscription);
    }
    await f.drain();
    expect(f.rows().find((row) => row.id === LOCAL)).toMatchObject({
      subscribed: true, coreHosted: true, onChainId: ORIGINAL, onChainHash: HASH,
    });
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.coreHosted).toBe(false);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    await f.drain();
    expect(f.rows().find((row) => row.id === LOCAL)).toMatchObject({ subscribed: false, coreHosted: true });
    expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({ activated: 0, hostedActivated: 0 });
  });

  it('refuses alias hosting transfer across conflicting case-folded wire slots', async () => {
    const f = await cold([
      durable({ id: HASH, coreHosted: true }),
      durable({ id: `0x${HASH.slice(2).toUpperCase()}`, onChainId: COLLISION, coreHosted: true }),
    ], false, { live: true, pointRead: true });
    f.agent.subscribeToContextGraph(LOCAL, { onChainId: ORIGINAL });
    await f.drain();
    expect(f.rows().find((row) => row.id === LOCAL)?.coreHosted).not.toBe(true);
    expect(f.rows().find((row) => row.id === `0x${HASH.slice(2).toUpperCase()}`)?.coreHosted).toBe(true);
  });

  it('ignores an unrelated malformed durable key during native hosting preservation', async () => {
    const f = await cold([durable({ id: HASH, coreHosted: true })], false, { pointRead: true });
    const loadAll = f.subscriptionStore.loadAll.bind(f.subscriptionStore);
    vi.spyOn(f.subscriptionStore, 'loadAll').mockImplementation(async () => [
      ...await loadAll(), JSON.parse('{"id":17,"coreHosted":true}'),
    ]);
    const subscription = f.state.setContextGraphSubscription(LOCAL, {
      subscribed: true, coreHosted: false, synced: false, onChainId: ORIGINAL, onChainHash: HASH,
    }, { persist: false });
    await f.agent.persistContextGraphSubscriptionStrict(LOCAL, subscription);
    expect(f.rows().find((row) => row.id === LOCAL)?.coreHosted).toBe(true);
    expect(subscription.coreHosted).toBe(false);
  });

  it('keeps exact-local hosting despite a foreign-slot wire predecessor', async () => {
    const f = await cold([
      durable({ coreHosted: true }), durable({ id: HASH, onChainId: COLLISION, coreHosted: true }),
    ], false, { pointRead: true });
    await f.agent.rehydrateContextGraphSubscriptions(null);
    const subscription = f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true,
    }, { persist: false });
    await f.agent.persistContextGraphSubscriptionStrict(LOCAL, subscription);
    expect(f.rows().find((row) => row.id === LOCAL)).toMatchObject({ coreHosted: true, onChainId: ORIGINAL });
    expect(subscription.coreHosted).toBe(false);
  });

  it('fences same-object native rebinding while a saved-hosting read is pending', async () => {
    const original = durable({ coreHosted: true });
    const f = await cold([original], false, { pointRead: true });
    await f.agent.rehydrateContextGraphSubscriptions(null);
    const load = f.subscriptionStore.load!.bind(f.subscriptionStore);
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(f.subscriptionStore, 'load').mockImplementation(async (id) => {
      const row = await load(id);
      reached(); await held; return row;
    });
    const subscription = f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true,
    });
    try {
      await waiting;
      f.agent.bindSubscriptionOnChainId(LOCAL, subscription, COLLISION);
      expect(f.state.subscribedContextGraphs.get(LOCAL)).toBe(subscription);
    } finally { release(); }
    await f.drain();
    expect(f.rows()).toEqual([original]);
    expect(f.save).not.toHaveBeenCalled();
    expect(subscription.onChainId).toBe(COLLISION);
  });

  it('refuses aliased join persistence after a native bind during its added durable read', async () => {
    const original = durable({ id: HASH, coreHosted: true });
    const f = await cold([original], false, { pointRead: true });
    const live = f.state.setContextGraphSubscription(LOCAL, {
      subscribed: false, coreHosted: false, synced: false,
      onChainId: ORIGINAL, onChainHash: HASH,
    }, { persist: false });
    const loadAll = f.subscriptionStore.loadAll.bind(f.subscriptionStore);
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(f.subscriptionStore, 'loadAll').mockImplementation(async () => {
      const rows = await loadAll(); reached(); await held; return rows;
    });
    const joining = f.agent.persistJoinApprovalStateStrict(LOCAL, {
      contextGraphId: LOCAL, principalType: 'node', principalId: f.agent.peerId,
      role: 'subscriber', status: 'active', source: 'join',
    }, { ...live, subscribed: true });
    const rejected = expect(joining).rejects.toThrow('changed before join persistence');
    try { await waiting; f.agent.bindSubscriptionOnChainId(LOCAL, live, COLLISION); }
    finally { release(); }
    await rejected; await f.drain();
    expect(f.rows()).toEqual([original]);
    expect(f.memberSave).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toBe(live);
  });

  it('retains explicit teardown of an admitted native Core hosting obligation', async () => {
    const f = await cold([durable({ coreHosted: true })], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: false, coreHosted: true,
    }, { persist: false });
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: false, coreHosted: false,
    });
    await f.drain();
    expect(f.rows()).toEqual([]);
    expect(f.remove).toHaveBeenCalledWith(LOCAL);
  });

  it('does not resurrect saved hosting after a native unbind during the serialized durable read', async () => {
    const f = await cold([durable({ coreHosted: true })], false, { pointRead: true });
    await f.agent.rehydrateContextGraphSubscriptions(null);
    const load = f.subscriptionStore.load!.bind(f.subscriptionStore);
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(f.subscriptionStore, 'load').mockImplementation(async (id) => {
      const row = await load(id);
      reached();
      await held;
      return row;
    });
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true,
    });
    try {
      await waiting;
      f.agent.unbindSubscriptionOnChainId(LOCAL);
    } finally {
      release();
    }
    await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({ subscribed: true, coreHosted: false, onChainId: undefined })]);
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBeUndefined();
  });

  it.each(['best-effort', 'strict'] as const)('keeps saved hosting intact when the %s durable read fails', async (mode) => {
    const original = durable({ coreHosted: true });
    const f = await cold([original], false, { pointRead: true });
    await f.agent.rehydrateContextGraphSubscriptions(null);
    vi.spyOn(f.subscriptionStore, 'load').mockRejectedValue(new Error('hosting intent read failed'));
    if (mode === 'best-effort') {
      f.agent.unsubscribeFromContextGraph(LOCAL);
      await f.drain();
    } else {
      const subscription = f.state.setContextGraphSubscription(LOCAL, {
        ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true,
      }, { persist: false });
      await expect(f.agent.persistContextGraphSubscriptionStrict(LOCAL, subscription)).rejects.toThrow('hosting intent read failed');
    }
    expect(f.rows()).toEqual([original]);
    expect(f.remove).not.toHaveBeenCalledWith(LOCAL);
  });

  it('still deletes an ordinary saved member-only row after disabled restoration', async () => {
    const f = await cold([durable({ coreHosted: false })], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.agent.unsubscribeFromContextGraph(LOCAL);
    await f.drain();
    expect(f.rows()).toEqual([]);
    expect(f.remove).toHaveBeenCalledWith(LOCAL);
  });

  it('does not carry dormant Core hosting across explicit numeric unbinding', async () => {
    const f = await cold([durable({ coreHosted: true })], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.agent.unbindSubscriptionOnChainId(LOCAL);
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBeUndefined();
    expect(f.rows()).toEqual([]);
    expect(f.remove).toHaveBeenCalledWith(LOCAL);
  });


  it.each(['readiness', 'explicit-unsubscribe'] as const)(
    'keeps admitted slot323 routing through dormant %s', async (operation) => {
      const f = await competingWireOwner();
      if (operation === 'readiness') {
        await f.agent.store.insert(buildAuthoritativePublicMetaQuads(LOCAL));
        await f.agent.refreshMetaSyncedFlags([LOCAL]);
      } else {
        f.agent.unsubscribeFromContextGraph(LOCAL);
      }
      await f.drain();
      expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
      await expect(f.agent.resolveContextGraphOnChainIdReference('#323')).resolves.toMatchObject({
        kind: 'resolved', contextGraphId: HASH, onChainId: '323',
      });
      expect(f.state.subscribedContextGraphs.get(HASH)).toMatchObject({
        coreHosted: true, onChainId: '323',
      });
      if (operation === 'explicit-unsubscribe') expect(f.remove).toHaveBeenCalledWith(LOCAL);
      else expect(f.remove).not.toHaveBeenCalledWith(LOCAL);
    },
  );

  it('retains an explicit native numeric rebind beside the admitted wire owner', async () => {
    const f = await competingWireOwner();
    const next = { ...f.state.subscribedContextGraphs.get(LOCAL)! };
    f.agent.bindSubscriptionOnChainId(LOCAL, next, '777');
    f.state.setContextGraphSubscription(LOCAL, next);
    await f.drain();
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(LOCAL);
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBe('777');
    expect(f.remove).toHaveBeenCalledWith(LOCAL);
  });

  it('retains deliberate native dormant unbinding cleanup', async () => {
    const f = await cold([durable()], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await f.seedMember();
    f.agent.unbindSubscriptionOnChainId(LOCAL);
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBeUndefined();
    expect(f.rows()).toEqual([]);
    expect(f.members()).toEqual([]);
    expect(f.remove).toHaveBeenCalledWith(LOCAL);
  });

  it.each([
    { subscribed: false, coreHosted: false, preserve: true, action: 'skip' },
    { subscribed: false, coreHosted: false, preserve: undefined, action: 'delete' },
    { subscribed: true, coreHosted: false, preserve: true, action: 'save' },
    { subscribed: false, coreHosted: true, preserve: true, action: 'save' },
  ] as const)(
    'projects admitted:$subscribed hosted:$coreHosted preserve:$preserve as $action',
    ({ subscribed, coreHosted, preserve, action }) => {
      expect(projectContextGraphSubscriptionPersistence({
        contextGraphId: LOCAL,
        subscription: { subscribed, coreHosted, synced: false, syncMode: 'always-on' },
        syncScoped: false, preserveInactiveIntent: preserve,
      }).action).toBe(action);
    },
  );


  it('preserves dormant intent without readiness, responsibility or gossip activation', async () => {
    const saved = durable({ syncScoped: true });
    const f = await cold([saved], false, { syncScoped: true });
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await f.seedMember();
    const membersBefore = f.members();
    await f.agent.store.insert(buildAuthoritativePublicMetaQuads(LOCAL));
    await expect(f.agent.hasConfirmedMetaState(LOCAL)).resolves.toBe(true);
    const gossip = vi.spyOn(f.agent, 'queueSharedMemoryGossipSubscription');
    const responsibility = vi.spyOn(f.agent, 'reconcileRfc64CatalogResponsibilityV1');
    await f.agent.refreshMetaSyncedFlags([LOCAL]);
    await f.drain();
    expect(gossip).not.toHaveBeenCalled();
    expect(responsibility).not.toHaveBeenCalled();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: false, coreHosted: false, metaSynced: false,
      onChainId: ORIGINAL, onChainHash: HASH,
    });
    expect(f.rows()).toEqual([saved]);
    expect(f.members()).toEqual(membersBefore);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.memberRemove).not.toHaveBeenCalled();
  });

  it('keeps dormant intent through sync readiness and direct watermark persistence', async () => {
    const saved = durable();
    const f = await cold([saved], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await f.seedMember();
    const membersBefore = f.members();
    f.agent.markContextGraphSubscriptionState(LOCAL, {
      synced: true, sharedMemorySynced: true, lastReconciledOrdinal: 9,
    });
    await f.agent.persistContextGraphSubscriptionState(LOCAL);
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: false, coreHosted: false, synced: true,
      sharedMemorySynced: true, lastReconciledOrdinal: 9,
    });
    expect(f.rows()).toEqual([saved]);
    expect(f.members()).toEqual(membersBefore);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.memberRemove).not.toHaveBeenCalled();
  });

  it('persists confirmed-meta readiness for an admitted member', async () => {
    const f = await cold([], false);
    f.state.setContextGraphSubscription(LOCAL, {
      subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: false,
      onChainId: ORIGINAL, onChainHash: HASH,
    }, { persist: false });
    await f.agent.store.insert(buildAuthoritativePublicMetaQuads(LOCAL));
    await f.agent.refreshMetaSyncedFlags([LOCAL]);
    await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({
      id: LOCAL, subscribed: true, metaSynced: true, onChainId: ORIGINAL,
    })]);
    expect(f.members()).toEqual([expect.objectContaining({
      contextGraphId: LOCAL, principalType: 'node', principalId: f.agent.peerId,
      status: 'active', metadata: expect.objectContaining({ subscribed: true, metaSynced: true }),
    })]);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('deletes dormant saved member intent on explicit native unsubscribe', async () => {
    const f = await cold([durable({ syncScoped: true })], false, { syncScoped: true });
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await f.seedMember();
    f.agent.unsubscribeFromContextGraph(LOCAL);
    await f.drain();
    expect(f.rows()).toEqual([]);
    expect(f.members()).toEqual([]);
    expect(f.remove).toHaveBeenCalledWith(LOCAL);
    expect(f.memberRemove).toHaveBeenCalledWith(LOCAL, 'node', f.agent.peerId);
    expect(f.state.config.syncContextGraphs ?? []).not.toContain(LOCAL);
  });


  it('repairs a legacy hash row after disabled restart and a matching native observation', async () => {
    const legacy = durable({ id: HASH, onChainId: '323', onChainHash: undefined });
    const f = await cold([legacy], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.agent.applyOnChainContextGraphObservation(observed('323'), { source: 'checkpoint' });
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(HASH)).toMatchObject({
      onChainId: '323', onChainHash: HASH, subscribed: false,
    });
    expect(f.state.subscribedContextGraphs.get(HASH)?.coreHosted).not.toBe(true);
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    await expect(f.agent.resolveContextGraphOnChainIdReference('#323')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, onChainId: '323', nameHash: HASH,
    });
    expect(f.rows()).toEqual([legacy]);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('retains an explicit literal commitment for a hash-shaped cleartext identity', async () => {
    const literalCommitment = ethers.keccak256(ethers.toUtf8Bytes(HASH)).toLowerCase();
    const literal = durable({ id: HASH, onChainId: '323', onChainHash: literalCommitment });
    const f = await cold([literal], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.agent.applyOnChainContextGraphObservation({
      ...observed('323'), nameHash: literalCommitment,
    }, { source: 'checkpoint' });
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(HASH)).toMatchObject({
      onChainId: '323', onChainHash: literalCommitment, subscribed: false,
    });
    expect(f.state.wireIdToLocalCgId.get(literalCommitment)).toBe(HASH);
    expect(f.state.wireIdToLocalCgId.has(HASH)).toBe(false);
    expect(f.rows()).toEqual([literal]);
  });

  it('preserves admitted hash-slot323 routing beside dormant cleartext slot582', async () => {
    const saved = durable({ onChainId: '582' });
    const f = await cold([saved], false);
    f.state.setContextGraphSubscription(HASH, {
      coreHosted: true, subscribed: false, synced: true,
      sharedMemorySynced: true, metaSynced: true,
      onChainId: '323', onChainHash: HASH,
    }, { persist: false });
    // Typed chain facts enter through the real checkpoint observation owner.
    // The native numeric resolver and subscription setter are never stubbed.
    f.agent.applyOnChainContextGraphObservation(observed('323'), { source: 'checkpoint' });
    await expect(f.agent.resolveContextGraphOnChainIdReference('#323')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, onChainId: '323',
    });
    await f.drain();
    const admitted = f.state.subscribedContextGraphs.get(HASH)!;
    const persistedBefore = f.rows();
    f.save.mockClear();
    f.remove.mockClear();
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await f.drain();
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe('582');
    expect(f.state.subscribedContextGraphs.get(HASH)).toBe(admitted);
    expect(admitted).toMatchObject({
      coreHosted: true, synced: true, sharedMemorySynced: true, metaSynced: true,
      onChainId: '323', onChainHash: HASH,
    });
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    await expect(f.agent.resolveContextGraphOnChainIdReference('#323')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, onChainId: '323', nameHash: HASH,
    });
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: false, coreHosted: false, onChainId: '582', onChainHash: HASH,
    });
    expect(f.rows()).toEqual(persistedBefore);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each([undefined, false] as const)(
    'keeps active readiness and discovery persistence with persist:%s', async (persist) => {
      const f = await cold([], false);
      f.state.setContextGraphSubscription(LOCAL, {
        subscribed: true, synced: true, sharedMemorySynced: true,
        metaSynced: true, onChainHash: HASH,
      }, { persist: false });
      expect(f.agent.bindOnChainContextGraphIdFromNameHash(HASH, ORIGINAL, { persist })).toBe(LOCAL);
      await f.drain();
      expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
        subscribed: true, synced: true, sharedMemorySynced: true,
        metaSynced: true, onChainId: ORIGINAL, onChainHash: HASH,
      });
      if (persist === false) expect(f.save).not.toHaveBeenCalled();
      else expect(f.rows()).toEqual([expect.objectContaining({
        id: LOCAL, subscribed: true, synced: true, sharedMemorySynced: true,
        metaSynced: true, onChainId: ORIGINAL, onChainHash: HASH,
      })]);
      f.save.mockClear();
      expect(f.agent.bindOnChainContextGraphIdFromNameHash(HASH, COLLISION)).toBeNull();
      await f.drain();
      expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBe(ORIGINAL);
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  it.each(['event', 'storage', 'checkpoint'] as const)(
    'retains exact585 and durable intent across foreign-first %s observations', async (source) => {
      const f = await cold();
      await f.agent.rehydrateContextGraphSubscriptions(null);
      for (const id of [COLLISION, ORIGINAL, COLLISION]) {
        f.agent.applyOnChainContextGraphObservation(observed(id), { source });
        await f.drain();
        await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(ORIGINAL);
        expect(f.rows()).toEqual([durable()]);
      }
      expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
        onChainId: ORIGINAL, onChainHash: HASH, subscribed: false, synced: false,
      });
      expect(f.save).not.toHaveBeenCalled();
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.reverse).not.toHaveBeenCalled();
    },
  );

  it.each(['event', 'storage', 'checkpoint'] as const)(
    'preserves durable intent through original-first %s observations', async (source) => {
      const f = await cold();
      await f.agent.rehydrateContextGraphSubscriptions(null);
      for (const id of [ORIGINAL, COLLISION]) f.agent.applyOnChainContextGraphObservation(observed(id), { source });
      await f.drain();
      await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(ORIGINAL);
      expect(f.rows()).toEqual([durable()]);
      expect(f.remove).not.toHaveBeenCalled();
    },
  );

  it('restores identity without admission, policy reads, sync scope or readiness', async () => {
    const f = await cold([durable({ coreHosted: true })], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(ORIGINAL);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      onChainId: ORIGINAL, onChainHash: HASH, subscribed: false, coreHosted: false,
      synced: false, sharedMemorySynced: false, metaSynced: false,
    });
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.pendingMeta).not.toBe(true);
    expect(f.state.config.syncContextGraphs ?? []).not.toContain(LOCAL);
    expect(f.state.gossipRegistered.has(LOCAL)).toBe(false);
    expect(f.policy).not.toHaveBeenCalled();
    expect(f.reverse).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      rehydrationEnabled: false, activated: 0, hostedActivated: 0,
      dormantReasons: { rehydrationDisabled: [LOCAL] },
    });
  });

  it('does not delete a saved member row on a same-slot live event', async () => {
    const f = await cold();
    f.state.setContextGraphSubscription(LOCAL, {
      subscribed: false, synced: false, onChainId: ORIGINAL, onChainHash: HASH,
    }, { persist: false });
    f.agent.applyOnChainContextGraphObservation(observed(ORIGINAL), { source: 'event' });
    await f.drain();
    expect(f.rows()).toEqual([durable()]);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('keeps equal-slot durable placeholder rows intact during identity-only adoption', async () => {
    const placeholder = durable({ id: HASH });
    const f = await cold([placeholder, durable()], false);
    // Real canonical setter adoption, including its native placeholder cleanup.
    f.state.setContextGraphSubscription(HASH, {
      subscribed: true, synced: false, onChainId: ORIGINAL, onChainHash: HASH,
    }, { persist: false });
    f.state.setContextGraphSubscription(LOCAL, {
      subscribed: false, coreHosted: false, synced: false,
      onChainId: ORIGINAL, onChainHash: HASH,
    }, { persist: false });
    await f.drain();
    expect(f.rows()).toEqual([placeholder, durable()]);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('restores both saved equal-slot names without deleting durable rows at disabled bootstrap', async () => {
    const rows = [durable({ id: HASH }), durable()];
    const f = await cold(rows, false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await f.drain();
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(ORIGINAL);
    expect(f.rows()).toEqual(rows);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('feeds the actual full packed-KA guard the original slot after a competing event', async () => {
    const f = await cold();
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.agent.applyOnChainContextGraphObservation(observed(COLLISION), { source: 'event' });
    await f.drain();
    const resolved = await f.agent.getContextGraphOnChainId(LOCAL);
    const getKA = vi.spyOn(f.chain, 'getKAContextGraphId');
    const handler = new FinalizationHandler(f.agent.store, f.chain);
    const guard = handler as unknown as {
      verifyChainCgBinding(kaId: bigint, cgId: string, ctx: ReturnType<typeof createOperationContext>): Promise<boolean>;
    };
    expect(resolved).not.toBeNull();
    await expect(guard.verifyChainCgBinding(PACKED_KA, resolved!, createOperationContext('system'))).resolves.toBe(true);
    expect(getKA).toHaveBeenCalledWith(PACKED_KA);
    await expect(guard.verifyChainCgBinding(PACKED_KA, COLLISION, createOperationContext('system'))).resolves.toBe(false);
    expect(getKA.mock.calls.every(([id]) => id === PACKED_KA)).toBe(true);
  });

  it.each([
    { label: 'absent id', onChainId: undefined },
    { label: 'zero', onChainId: '0' },
    { label: 'leading zero', onChainId: '0585' },
    { label: 'hex', onChainId: '0x249' },
    { label: 'negative', onChainId: '-1' },
    { label: 'non-numeric', onChainId: 'unknown' },
    { label: 'uint256 overflow', onChainId: (1n << 256n).toString() },
    { label: 'wrong commitment', onChainId: ORIGINAL, onChainHash: `0x${'44'.repeat(32)}` },
  ])('does not restore a dormant identity with $label', async ({ onChainId, ...rest }) => {
    const { label: _label, ...overrides } = rest;
    const row = durable({ onChainId, ...overrides });
    const f = await cold([row], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    expect(f.state.subscribedContextGraphs.has(LOCAL)).toBe(false);
    expect(f.rows()).toEqual([row]);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('does not select one slot from conflicting durable rows for the same local id', async () => {
    const rows = [durable(), durable({ onChainId: COLLISION })];
    const f = await cold(rows, false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    expect(f.state.subscribedContextGraphs.has(LOCAL)).toBe(false);
    expect(f.rows()).toEqual(rows);
  });


  it('keeps an enabled but denied private identity without admitting plaintext', async () => {
    const f = await cold([durable()], false, { enabled: true });
    const registered = f.chain.getContextGraph(585n)!;
    registered.accessPolicy = 1;
    registered.participantAgents = [FOREIGN];
    const authority = vi.spyOn(f.agent, 'resolveContextGraphSubscriptionBootstrapAuthority');
    const execute = vi.spyOn(f.agent.queryEngine, 'query');
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(ORIGINAL);
    expect(authority).toHaveBeenCalledTimes(1);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: false, coreHosted: false, metaSynced: false,
    });
    expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 0, dormantReasons: { authorityDenied: [LOCAL] },
    });
    await expect(f.agent.resolveContextGraphReadAuthority(LOCAL, {
      callerAgentAddress: OWNER,
    })).resolves.toMatchObject({ outcome: 'denied', onChainId: 585n });
    await expect(f.agent.query('SELECT ?s WHERE { ?s ?p ?o }', {
      contextGraphId: LOCAL, callerAgentAddress: OWNER,
    })).resolves.toMatchObject({ bindings: [] });
    expect(execute).not.toHaveBeenCalled();
    expect(f.state.gossipRegistered.has(LOCAL)).toBe(false);
    expect(f.state.config.syncContextGraphs ?? []).not.toContain(LOCAL);
    expect(f.rows()).toEqual([durable()]);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('retains exact dormant identity beyond the enabled activation cap without an authority read', async () => {
    const firstId = 'a-cap-allowed';
    const firstHash = ethers.keccak256(ethers.toUtf8Bytes(firstId));
    const rows = [durable({ id: firstId, onChainId: '587', onChainHash: firstHash }), durable()];
    const f = await cold(rows, false, { enabled: true, cap: 1 });
    await f.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: firstHash });
    // Isolate network activation only; numeric identity, fresh native authority,
    // install, persistence and cap selection remain the composed native owners.
    vi.spyOn(f.agent, 'subscribeToContextGraph').mockResolvedValue(undefined);
    const authority = vi.spyOn(f.agent, 'resolveContextGraphSubscriptionBootstrapAuthority');
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.agent.applyOnChainContextGraphObservation(observed(COLLISION), { source: 'event' });
    await f.drain();
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(ORIGINAL);
    expect(authority.mock.calls.map(([id]) => id)).toEqual([firstId]);
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.subscribed).toBe(false);
    expect(f.state.gossipRegistered.has(LOCAL)).toBe(false);
    expect(f.state.config.syncContextGraphs ?? []).not.toContain(LOCAL);
    expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1, dormantReasons: { activationCap: [LOCAL] },
    });
    expect(f.rows().find((row) => row.id === LOCAL)).toEqual(durable());
    expect(f.remove).not.toHaveBeenCalledWith(LOCAL);
  });

  it('keeps cap0 as native uncapped activation with its fresh authority gate', async () => {
    const f = await cold([durable()], false, { enabled: true, cap: 0 });
    vi.spyOn(f.agent, 'subscribeToContextGraph').mockResolvedValue(undefined);
    const authority = vi.spyOn(f.agent, 'resolveContextGraphSubscriptionBootstrapAuthority');
    await f.agent.rehydrateContextGraphSubscriptions(null);
    expect(authority).toHaveBeenCalledTimes(1);
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      onChainId: ORIGINAL, subscribed: true,
    });
    expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      activated: 1, activationCap: 0, capDisabled: true,
    });
  });

  it('does not invent an exact binding for an unbound inactive row with no durable identity', async () => {
    const f = await cold([]);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBeNull();
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBeUndefined();
    expect(f.reverse).not.toHaveBeenCalled();
    expect(f.rows()).toEqual([]);
  });

  it.each([
    ['identity-only', false, false, false, 'denied'],
    ['host-only', false, true, false, 'denied'],
    ['member', true, false, false, 'allowed'],
    ['configured scope', false, false, true, 'allowed'],
  ] as const)('uses admitted membership or configured scope for legacy private authority: %s',
    async (_label, subscribed, coreHosted, scope, outcome) => {
      const f = await cold([durable()], false, { syncScoped: scope });
      await f.agent.rehydrateContextGraphSubscriptions(null);
      if (subscribed || coreHosted) f.state.setContextGraphSubscription(LOCAL, {
        ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed, coreHosted,
      }, { persist: false });
      vi.spyOn(f.agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({ kind: 'unregistered' });
      vi.spyOn(f.agent, 'getContextGraphAllowedPeers').mockResolvedValue(null);
      vi.spyOn(f.agent, 'isPrivateContextGraph').mockResolvedValue(true);
      vi.spyOn(f.agent, 'getContextGraphAgentGateAddresses').mockResolvedValue(null);
      vi.spyOn(f.agent, 'getPrivateContextGraphParticipants').mockResolvedValue([]);
      await expect(f.agent.resolveContextGraphReadAuthority(LOCAL)).resolves.toMatchObject({ outcome });
    },
  );

  it('restores the prior dormant binding after native activation preparation fails', async () => {
    const saved = durable({ lastReconciledOrdinal: 77 });
    const f = await cold([saved], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    const prior = { ...f.state.subscribedContextGraphs.get(LOCAL)! };
    await expect(f.agent.activatePersistedContextGraphSubscriptionRecord(saved, {
      prepare: async () => { throw new Error('owned activation preparation failed'); },
    })).rejects.toThrow('owned activation preparation failed');
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toEqual(prior);
    f.agent.applyOnChainContextGraphObservation(observed(COLLISION), { source: 'event' });
    await f.drain();
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBe(ORIGINAL);
    expect(f.rows()).toEqual([saved]);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('preserves a concurrent replacement when activation preparation fails', async () => {
    const saved = durable();
    const f = await cold([saved], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await expect(f.agent.activatePersistedContextGraphSubscriptionRecord(saved, {
      prepare: async () => {
        f.state.setContextGraphSubscription(LOCAL, {
          subscribed: false, synced: false, onChainId: '777', onChainHash: HASH,
        }, { persist: false });
        throw new Error('owned activation became stale');
      },
    })).rejects.toThrow('owned activation became stale');
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.onChainId).toBe('777');
  });

  it('retains the saved watermark through native explicit subscription of a dormant row', async () => {
    const saved = durable({ lastReconciledOrdinal: 77 });
    const f = await cold([saved], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.lastReconciledOrdinal).toBe(77);
    // Only the network primitive is inert; install/persistence stay native.
    (f.agent as unknown as { gossip: unknown }).gossip = {
      subscribe: vi.fn(), unsubscribe: vi.fn(), onMessage: vi.fn(),
      publish: async () => undefined, getSubscribers: () => [],
    };
    f.agent.subscribeToContextGraph(LOCAL, { trackSyncScope: false });
    await f.drain();
    expect(f.rows()).toEqual([expect.objectContaining({ id: LOCAL, subscribed: true, lastReconciledOrdinal: 77 })]);
  });

  it.each([
    ['confirmed proof', 'unsubscribe'], ['confirmed proof', 'delete'],
    ['registration query', 'unsubscribe'], ['registration query', 'delete'],
  ] as const)('fences readiness generation after deferred %s and native %s', async (phase, mutation) => {
    const f = await cold([durable()], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true,
    }, { persist: false });
    await f.agent.store.insert(buildAuthoritativePublicMetaQuads(LOCAL));
    await expect(f.agent.hasConfirmedMetaState(LOCAL)).resolves.toBe(true);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const actualProof = f.agent.hasConfirmedMetaState.bind(f.agent);
    const actualQuery = f.agent.store.query.bind(f.agent.store);
    if (phase === 'confirmed proof') vi.spyOn(f.agent, 'hasConfirmedMetaState').mockImplementation(async (id) => {
      const result = await actualProof(id);
      entered(); await held; return result;
    });
    else vi.spyOn(f.agent.store, 'query').mockImplementation(async (...args) => {
      if (args[1]?.source === 'agent.durableSync.registrationBinding') { entered(); await held; }
      return actualQuery(...args);
    });
    const setter = vi.spyOn(f.agent, 'setContextGraphSubscription');
    const gossip = vi.spyOn(f.agent, 'queueSharedMemoryGossipSubscription');
    const responsibility = vi.spyOn(f.agent, 'reconcileRfc64CatalogResponsibilityV1');
    const refresh = f.agent.refreshMetaSyncedFlags([LOCAL]);
    await waiting;
    if (mutation === 'unsubscribe') f.agent.unsubscribeFromContextGraph(LOCAL);
    else f.agent.deleteContextGraphSubscription(LOCAL);
    await f.drain();
    const stateAfterMutation = f.state.subscribedContextGraphs.get(LOCAL);
    const rowsAfterMutation = structuredClone(f.rows());
    setter.mockClear(); gossip.mockClear(); responsibility.mockClear();
    f.save.mockClear(); f.remove.mockClear();
    release(); await refresh; await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toEqual(stateAfterMutation);
    expect(f.rows()).toEqual(rowsAfterMutation);
    expect(setter).not.toHaveBeenCalled();
    expect(gossip).not.toHaveBeenCalled();
    expect(responsibility).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('refuses a conflicting numeric binding before confirmed-meta readiness mutation', async () => {
    const saved = durable({ lastReconciledOrdinal: 77 });
    const f = await cold([saved], false);
    await f.agent.rehydrateContextGraphSubscriptions(null);
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true,
    }, { persist: false });
    await f.agent.store.insert([
      ...buildAuthoritativePublicMetaQuads(LOCAL),
      { subject: contextGraphDataGraphUri(LOCAL), predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`, object: `"${COLLISION}"`, graph: contextGraphMetaGraphUri(LOCAL) },
      { subject: contextGraphDataGraphUri(LOCAL), predicate: `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainHash`, object: `"${HASH}"`, graph: contextGraphMetaGraphUri(LOCAL) },
    ]);
    await expect(f.agent.hasConfirmedMetaState(LOCAL)).resolves.toBe(true);
    const before = { ...f.state.subscribedContextGraphs.get(LOCAL)! };
    const gossip = vi.spyOn(f.agent, 'queueSharedMemoryGossipSubscription');
    const responsibility = vi.spyOn(f.agent, 'reconcileRfc64CatalogResponsibilityV1');
    await f.agent.refreshMetaSyncedFlags([LOCAL]); await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toEqual(before);
    expect(f.rows()).toEqual([saved]);
    expect(gossip).not.toHaveBeenCalled();
    expect(responsibility).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
});
