import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { STORAGE_ACK_DECLINE_CODES } from '@origintrail-official/dkg-core';
import {
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES,
} from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import type {
  ContextGraphSub,
  ContextGraphSubscriptionRecord,
} from '../src/dkg-agent-types.js';

const LOCAL = 'z-dormant-core-admission';
const FIRST = 'a-cap-admitted-first';
const ID = '9001';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL));
const FIRST_HASH = ethers.keccak256(ethers.toUtf8Bytes(FIRST));
const MODES = ['disabled', 'capped'] as const;
type Mode = typeof MODES[number];

interface State {
  node: unknown;
  store: TripleStore;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  contextGraphSubscriptionDormancyById: Map<string, string>;
  vmPromotionBackfillSettled: Set<string>;
  vmPromotionBackfillBackoff: Map<string, unknown>;
  setContextGraphSubscription(id: string, sub: ContextGraphSub, options: { persist: false }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
}

function saved(id = LOCAL, onChainId = ID, hash = HASH): ContextGraphSubscriptionRecord {
  return {
    id, onChainId, onChainHash: hash,
    subscribed: true, coreHosted: false, synced: true,
    sharedMemorySynced: true, metaSynced: true, syncScoped: true,
    lastReconciledOrdinal: 7,
  };
}

const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

async function fixture(mode: Mode, restore = true) {
  const original = saved();
  let rows = mode === 'capped'
    ? [saved(FIRST, '9002', FIRST_HASH), original]
    : [original];
  const save = vi.fn(async (record: ContextGraphSubscriptionRecord) => {
    rows = [...rows.filter((row) => row.id !== record.id), { ...record }];
  });
  const remove = vi.fn(async (id: string) => { rows = rows.filter((row) => row.id !== id); });
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 9001n });
  await chain.createOnChainContextGraph({ nameHash: HASH, accessPolicy: 0, publishPolicy: 1 });
  if (mode === 'capped') {
    await chain.createOnChainContextGraph({ nameHash: FIRST_HASH, accessPolicy: 0, publishPolicy: 1 });
  }
  const agent = await DKGAgent.create({
    name: 'DormantCoreAdmission', nodeRole: 'core', chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: mode === 'capped',
    maxRehydratedContextGraphSubscriptions: 1,
    contextGraphSubscriptionStore: {
      loadAll: async () => rows.map((row) => ({ ...row })),
      load: async (id) => rows.find((row) => row.id === id) ?? null,
      save, delete: remove,
    },
  });
  agents.push(agent);
  const state = agent as unknown as State;
  state.node = { peerId: '12D3KooWDormantCoreAdmission', libp2p: { getPeers: () => [] } };
  // Only network activation is inert: native authority, cap selection, identity
  // installation, persistence and both automatic custody paths remain real.
  vi.spyOn(agent, 'subscribeToContextGraph').mockImplementation((id) => state.subscribedContextGraphs.get(id)!);
  if (restore) await agent.rehydrateContextGraphSubscriptions(null);
  const policy = vi.spyOn(chain, 'getContextGraphAccessPolicy');
  const nudge = vi.spyOn(agent, 'recordCoreHostedPublicCg');
  const drain = () => state.enqueueContextGraphSubscriptionPersistWrite(LOCAL, async () => undefined);
  save.mockClear(); remove.mockClear();
  return { agent, state, chain, original, save, remove, policy, nudge, drain, rows: () => rows };
}

function expectDormant(f: Awaited<ReturnType<typeof fixture>>, mode: Mode) {
  expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
    subscribed: false, coreHosted: false, synced: false, metaSynced: false,
    onChainId: ID, onChainHash: HASH.toLowerCase(), lastReconciledOrdinal: 7,
  });
  expect(f.state.contextGraphSubscriptionDormancyById.get(LOCAL)).toBe(
    mode === 'disabled' ? 'rehydrationDisabled' : 'activationCap',
  );
  expect(f.rows().find((row) => row.id === LOCAL)).toEqual(f.original);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
}

async function seedLedger(state: State) {
  await state.store.insert([
    {
      subject: 'urn:dkg:test:dormant-core-signed-copy',
      predicate: STORAGE_ACK_LEDGER_PREDICATES.namespace,
      object: `"${LOCAL}"`, graph: STORAGE_ACK_LEDGER_GRAPH,
    },
    {
      subject: 'urn:dkg:test:dormant-core-signed-copy',
      predicate: STORAGE_ACK_LEDGER_PREDICATES.contextGraphId,
      object: `"${ID}"`, graph: STORAGE_ACK_LEDGER_GRAPH,
    },
  ]);
}

describe('automatic Core custody of retained dormant identities', () => {
  it.each(MODES)('declines native StorageACK admission for a %s retained row', async (mode) => {
    const f = await fixture(mode);
    expectDormant(f, mode);
    const verdict = await f.agent.ensureStorageAckVmPromotion({
      contextGraphId: ID, swmGraphId: LOCAL, operation: 'publish',
    });
    expect(verdict).toMatchObject({
      ok: false,
      code: mode === 'disabled'
        ? STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED
        : STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
    });
    await f.drain();
    expectDormant(f, mode);
    expect(f.policy).not.toHaveBeenCalled();
  });

  it.each(MODES)('leaves a %s retained row untouched during native promotion backfill', async (mode) => {
    const f = await fixture(mode);
    await seedLedger(f.state);
    await expect(f.agent.backfillCoreHostedStorageAckGraphs(Date.now(), () => true)).resolves.toMatchObject({
      namespaces: 1, recorded: 0, pending: 1, unresolved: 1,
    });
    await f.drain();
    expectDormant(f, mode);
    expect(f.state.vmPromotionBackfillSettled.has(LOCAL)).toBe(false);
    expect(f.state.vmPromotionBackfillBackoff.has(LOCAL)).toBe(true);
    expect(f.policy).not.toHaveBeenCalled();
    expect(f.nudge).toHaveBeenCalledWith(ID, LOCAL, { durable: true, nudge: false });
  });

  it('rechecks recorded dormancy if native restoration completes during the policy read', async () => {
    const f = await fixture('disabled', false);
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.policy.mockImplementation(async () => { reached(); await held; return 0; });
    const recording = f.agent.recordCoreHostedPublicCg(ID, LOCAL, { durable: true });
    try {
      await waiting;
      await f.agent.rehydrateContextGraphSubscriptions(null);
    } finally { release(); }
    await expect(recording).resolves.toBe('dormant');
    await f.drain();
    expectDormant(f, 'disabled');
  });

  it('allows an explicitly admitted member even while an old dormancy diagnostic remains', async () => {
    const f = await fixture('disabled');
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, subscribed: true,
    }, { persist: false });
    expect(f.state.contextGraphSubscriptionDormancyById.has(LOCAL)).toBe(true);
    await expect(f.agent.ensureStorageAckVmPromotion({
      contextGraphId: ID, swmGraphId: LOCAL, operation: 'publish',
    })).resolves.toEqual({ ok: true });
    await f.drain();
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: true, coreHosted: true, onChainId: ID, lastReconciledOrdinal: 7,
    });
    expect(f.rows().find((row) => row.id === LOCAL)).toMatchObject({ subscribed: true, coreHosted: true });
  });

  it('keeps the existing active-host fast path without a liveness/policy read', async () => {
    const f = await fixture('disabled');
    f.state.setContextGraphSubscription(LOCAL, {
      ...f.state.subscribedContextGraphs.get(LOCAL)!, coreHosted: true,
    }, { persist: false });
    await expect(f.agent.ensureStorageAckVmPromotion({
      contextGraphId: ID, swmGraphId: LOCAL, operation: 'publish',
    })).resolves.toEqual({ ok: true });
    await f.drain();
    expect(f.policy).not.toHaveBeenCalled();
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.coreHosted).toBe(true);
    expect(f.rows().find((row) => row.id === LOCAL)?.coreHosted).toBe(true);
  });
});
