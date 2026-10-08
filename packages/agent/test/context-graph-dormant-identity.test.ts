import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { FinalizationHandler } from '../src/finalization-handler.js';
import type {
  ContextGraphSub,
  ContextGraphSubInput,
  ContextGraphSubscriptionRecord,
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

async function cold(rows: ContextGraphSubscriptionRecord[] = [durable()], seedDormant = true, options: { enabled?: boolean; cap?: number } = {}) {
  // Genuine native lifecycle methods and typed persistence contract. No daemon,
  // provider, external RPC or custom numeric resolver is started.
  let retained = rows.map((row) => ({ ...row }));
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => {
    retained = [...retained.filter((old) => old.id !== row.id), { ...row }];
  });
  const remove = vi.fn(async (id: string) => { retained = retained.filter((row) => row.id !== id); });
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 585n });
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASH });
  await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASH });
  chain.__registerKC({ kaId: PACKED_KA, contextGraphId: 585n, merkleRootHex: ROOT, chunks: [] });
  const agent = await DKGAgent.create({
    name: 'DormantIdentity', chainAdapter: chain, nodeRole: 'edge',
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: options.enabled ?? false,
    maxRehydratedContextGraphSubscriptions: options.cap,
    contextGraphSubscriptionStore: { loadAll: async () => retained.map((row) => ({ ...row })), save, delete: remove },
  });
  agents.push(agent);
  const state = agent as unknown as Internals;
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWDormantIdentityFixture', libp2p: { getPeers: () => [] },
  };
  if (seedDormant) state.setContextGraphSubscription(LOCAL, { subscribed: false, synced: false }, { persist: false });
  const reverse = vi.spyOn(chain, 'resolveContextGraphIdByNameHash');
  const policy = vi.spyOn(chain, 'getContextGraphAccessPolicy');
  const drain = async () => {
    for (const id of [LOCAL, HASH]) await state.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
  };
  return { agent, state, chain, save, remove, reverse, policy, drain, rows: () => retained };
}

function observed(id: string) {
  return {
    contextGraphId: id, nameHash: HASH, owner: id === ORIGINAL ? OWNER : FOREIGN,
    accessPolicy: 0, publishPolicy: 1, active: true, observedAtBlock: id === ORIGINAL ? 100 : 200,
  };
}

describe('dormant durable Context Graph identity', () => {

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
});
