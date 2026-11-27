import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

const LOCAL = '0-team';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const SLOT = '582';
const ORDERS = ['cleartext-first', 'placeholder-first'] as const;
type Order = typeof ORDERS[number];
interface Internals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  wireIdToLocalCgId: Map<string, string>;
  setContextGraphSubscription(id: string, next: ContextGraphSubInput, options: { persist: false }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  config: { syncContextGraphs?: string[] };
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

function pair(order: Order, clear: Partial<ContextGraphSubscriptionRecord> = {}, placeholder: Partial<ContextGraphSubscriptionRecord> = {}) {
  const row = (id: string, extra: Partial<ContextGraphSubscriptionRecord>): ContextGraphSubscriptionRecord => ({
    id, subscribed: true, synced: true, sharedMemorySynced: true,
    metaSynced: true, onChainId: SLOT, onChainHash: HASH, syncScoped: true, ...extra,
  });
  const rows = [row(LOCAL, clear), row(HASH, placeholder)];
  return order === 'cleartext-first' ? rows : rows.reverse();
}

async function fixture(rows: ContextGraphSubscriptionRecord[], admitted?: 'member' | 'host') {
  let retained = rows.map((row) => ({ ...row }));
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => {
    retained = [...retained.filter((old) => old.id !== row.id), { ...row }];
  });
  const remove = vi.fn(async (id: string) => { retained = retained.filter((row) => row.id !== id); });
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 581n });
  for (const slot of [581n, 582n]) {
    const created = await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: HASH });
    expect(created.contextGraphId).toBe(slot);
  }
  const agent = await DKGAgent.create({
    name: 'DormantPlaceholderOrder', chainAdapter: chain, nodeRole: 'edge',
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: false,
    syncContextGraphs: [HASH],
    contextGraphSubscriptionStore: { loadAll: async () => retained.map((row) => ({ ...row })), save, delete: remove },
  });
  agents.push(agent);
  // Local bootstrap identity only: no daemon, network, provider or authority override.
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWDormantPlaceholderOrder', libp2p: { getPeers: () => [] },
  };
  const state = agent as unknown as Internals;
  if (admitted) state.setContextGraphSubscription(HASH, {
    subscribed: admitted === 'member', coreHosted: admitted === 'host',
    synced: true, sharedMemorySynced: true, metaSynced: true,
    onChainId: SLOT, onChainHash: HASH, lastReconciledOrdinal: 17,
  }, { persist: false });
  const original = state.subscribedContextGraphs.get(HASH);
  const originalSnapshot = original && { ...original };
  const authority = vi.spyOn(agent, 'resolveContextGraphSubscriptionBootstrapAuthority');
  await agent.rehydrateContextGraphSubscriptions(null);
  for (const id of [LOCAL, HASH]) await state.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
  expect(retained).toEqual(rows);
  expect(save).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(authority).not.toHaveBeenCalled();
  return { agent, state, original, originalSnapshot };
}

function expectInactive(row: ContextGraphSub | undefined) {
  expect(row).toMatchObject({
    subscribed: false, coreHosted: false, synced: false,
    sharedMemorySynced: false, metaSynced: false,
  });
  expect(row?.pendingMeta).not.toBe(true);
}

describe('dormant superseded placeholder partition is independent of activation', () => {
  it.each(ORDERS)('resolves the canonical cleartext alias and numeric slot after %s restart', async (order) => {
    const { agent, state } = await fixture(pair(order));
    expect(state.subscribedContextGraphs.has(HASH)).toBe(false);
    expectInactive(state.subscribedContextGraphs.get(LOCAL));
    expect(agent.resolveContextGraphIdAlias(HASH)).toBe(LOCAL);
    expect(state.config.syncContextGraphs).toEqual([LOCAL]);
    await expect(agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: LOCAL, onChainId: SLOT, nameHash: HASH,
    });
  });

  it.each(ORDERS)('counts canonical dormant targets and actual system rows after %s restart', async (order) => {
    const rows = [...pair(order), { id: SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, subscribed: true, synced: true }];
    const { agent } = await fixture(rows);
    expect(agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
      rehydrationEnabled: false, persistedTotal: 1, systemExcluded: 1,
      activated: 0, hostedActivated: 0, dormant: 1, dormantIds: [LOCAL],
      dormantReasons: { rehydrationDisabled: [LOCAL] },
    });
  });

  it.each(ORDERS)('retains both distinct numeric slots after %s restart', async (order) => {
    const { agent, state } = await fixture(pair(order, {}, { onChainId: '581' }));
    expect(agent.resolveContextGraphIdAlias(HASH)).toBeNull();
    for (const [slot, id] of [['581', HASH], [SLOT, LOCAL]]) {
      expectInactive(state.subscribedContextGraphs.get(id));
      await expect(agent.resolveContextGraphOnChainIdReference(`#${slot}`)).resolves.toMatchObject({
        kind: 'resolved', contextGraphId: id, onChainId: slot, nameHash: HASH,
      });
    }
  });

  it.each(ORDERS)('does not supersede a valid wire row using a wrong cleartext commitment (%s)', async (order) => {
    const { agent, state } = await fixture(pair(order, { onChainHash: `0x${'44'.repeat(32)}` }));
    expect(state.subscribedContextGraphs.has(LOCAL)).toBe(false);
    expectInactive(state.subscribedContextGraphs.get(HASH));
    expect(agent.resolveContextGraphIdAlias(HASH)).toBeNull();
    await expect(agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, onChainId: SLOT, nameHash: HASH,
    });
  });

  it.each(ORDERS)('does not restore or alias a noncanonical saved slot (%s)', async (order) => {
    const { agent, state } = await fixture(pair(order, { onChainId: '0582' }, { onChainId: '0582' }));
    expect(state.subscribedContextGraphs.has(LOCAL)).toBe(false);
    expect(state.subscribedContextGraphs.has(HASH)).toBe(false);
    expect(agent.resolveContextGraphIdAlias(HASH)).toBeNull();
    expect(agent.lookupContextGraphOnChainIdReference('#582')).toMatchObject({ kind: 'not-held', onChainId: SLOT });
  });

  it.each([
    ['cleartext-first', 'member'], ['placeholder-first', 'member'],
    ['cleartext-first', 'host'], ['placeholder-first', 'host'],
  ] as const)('preserves already admitted wire %s/%s custody', async (order, role) => {
    const { agent, state, original, originalSnapshot } = await fixture(pair(order), role);
    expect(state.subscribedContextGraphs.get(HASH)).toBe(original);
    expect(original).toEqual(originalSnapshot);
    expect(state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    expectInactive(state.subscribedContextGraphs.get(LOCAL));
    expect(agent.resolveContextGraphIdAlias(HASH)).toBeNull();
    await expect(agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, onChainId: SLOT, nameHash: HASH,
    });
  });
});
