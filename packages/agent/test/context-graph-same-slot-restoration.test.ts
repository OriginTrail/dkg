import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { buildAuthoritativePublicMetaQuads } from '../src/context-graph-public-meta-proof.js';
import type { ContextGraphSub, ContextGraphSubInput, ContextGraphSubscriptionRecord } from '../src/dkg-agent-types.js';

const LOCAL = 'same-slot-admitted-restoration';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const SLOT = '582';
const FOREIGN = '0x2222222222222222222222222222222222222222';
interface Internals {
  subscribedContextGraphs: Map<string, ContextGraphSub>;
  wireIdToLocalCgId: Map<string, string>;
  setContextGraphSubscription(id: string, next: ContextGraphSubInput, options?: { persist?: boolean }): ContextGraphSub;
  enqueueContextGraphSubscriptionPersistWrite(id: string, write: () => Promise<void>): Promise<void>;
  adoptVerifiedContextGraphCleartext(target: { nameHash: string; onChainId: string }, id: string, source: 'peer-ontology'): Promise<boolean>;
}
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
  vi.restoreAllMocks();
});

async function fixture(role: 'member' | 'host', gate: 'disabled' | 'denied' = 'disabled', clearAdmitted = false) {
  const saved: ContextGraphSubscriptionRecord = {
    id: LOCAL, subscribed: true, synced: true, sharedMemorySynced: true,
    metaSynced: true, onChainId: SLOT, onChainHash: HASH, syncScoped: false,
  };
  let rows = [{ ...saved }];
  const save = vi.fn(async (row: ContextGraphSubscriptionRecord) => {
    rows = [...rows.filter((old) => old.id !== row.id), { ...row }];
  });
  const remove = vi.fn(async (id: string) => { rows = rows.filter((row) => row.id !== id); });
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 582n });
  await chain.createOnChainContextGraph({
    accessPolicy: gate === 'denied' ? 1 : 0, publishPolicy: 1, nameHash: HASH,
    participantAgents: gate === 'denied' ? [FOREIGN] : [],
  });
  const agent = await DKGAgent.create({
    name: 'SameSlotRestoration', chainAdapter: chain, nodeRole: 'edge',
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: gate === 'denied',
    contextGraphSubscriptionStore: { loadAll: async () => rows.map((row) => ({ ...row })), save, delete: remove },
  });
  agents.push(agent);
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWSameSlotRestorationFixture', libp2p: { getPeers: () => [] },
  };
  // Inert native gossip transport; the owning subscription/adoption methods
  // remain real, including unsubscribe and the post-adoption member install.
  (agent as unknown as { gossip: unknown }).gossip = {
    subscribe: () => undefined, unsubscribe: () => undefined,
    onMessage: () => undefined, offMessage: () => undefined,
    publish: async () => undefined, subscribedTopics: [],
  };
  const state = agent as unknown as Internals;
  if (clearAdmitted) state.setContextGraphSubscription(LOCAL, {
    subscribed: true, synced: true, onChainId: SLOT, onChainHash: HASH,
  }, { persist: false });
  state.setContextGraphSubscription(HASH, {
    subscribed: role === 'member', coreHosted: role === 'host',
    synced: true, sharedMemorySynced: true, metaSynced: true,
    onChainId: SLOT, onChainHash: HASH, lastReconciledOrdinal: 17,
  }, { persist: false });
  const original = state.subscribedContextGraphs.get(HASH)!;
  const snapshot = { ...original };
  const drain = async () => {
    for (const id of [LOCAL, HASH]) await state.enqueueContextGraphSubscriptionPersistWrite(id, async () => undefined);
  };
  await drain();
  save.mockClear(); remove.mockClear();
  const unchangedWire = () => {
    expect(state.subscribedContextGraphs.get(HASH)).toBe(original);
    expect(original).toEqual(snapshot);
    expect(state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
  };
  return { agent, state, saved, save, remove, rows: () => rows, drain, unchangedWire };
}

describe('same-slot admitted wire identity during dormant restoration', () => {
  it.each([
    ['member', 'disabled'], ['host', 'disabled'],
    ['member', 'denied'], ['host', 'denied'],
  ] as const)('retains admitted %s and progress with rehydration %s', async (role, gate) => {
    const f = await fixture(role, gate);
    const authority = vi.spyOn(f.agent, 'resolveContextGraphSubscriptionBootstrapAuthority');
    await f.agent.rehydrateContextGraphSubscriptions(null);
    await f.drain();
    f.unchangedWire();
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, onChainId: SLOT, nameHash: HASH,
    });
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({
      subscribed: false, coreHosted: false, synced: false,
      onChainId: SLOT, onChainHash: HASH,
    });
    if (gate === 'denied') {
      expect(authority).toHaveBeenCalledTimes(1);
      expect(f.agent.getContextGraphSubscriptionRehydrationStatus()).toMatchObject({
        activated: 0, dormantReasons: { authorityDenied: [LOCAL] },
      });
    } else expect(authority).not.toHaveBeenCalled();

    // Ordinary proof/readiness enrichment must not later retire live custody.
    await f.agent.store.insert(buildAuthoritativePublicMetaQuads(LOCAL));
    await f.agent.refreshMetaSyncedFlags([LOCAL]);
    f.agent.recordDiscoveredContextGraph(LOCAL, { onChainId: SLOT, onChainHash: HASH });
    await f.drain();
    f.unchangedWire();
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, onChainId: SLOT, nameHash: HASH,
    });
    expect(f.rows()).toEqual([f.saved]);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it.each(['member', 'host'] as const)('keeps wire %s routing when an admitted cleartext row unsubscribes', async (role) => {
    const f = await fixture(role, 'disabled', true);
    f.unchangedWire();
    f.agent.unsubscribeFromContextGraph(LOCAL);
    await f.drain();
    f.unchangedWire();
    expect(f.state.subscribedContextGraphs.get(LOCAL)?.subscribed).toBe(false);
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, onChainId: SLOT,
    });
    expect(f.rows()).toEqual([]);
    expect(f.remove).toHaveBeenCalledWith(LOCAL);
    expect(f.remove).not.toHaveBeenCalledWith(HASH);
  });

  it.each(['member', 'host'] as const)('still transfers %s through verified native adoption', async (role) => {
    const f = await fixture(role);
    await expect(f.state.adoptVerifiedContextGraphCleartext({ nameHash: HASH, onChainId: SLOT }, LOCAL, 'peer-ontology'))
      .resolves.toBe(true);
    await f.drain();
    expect(f.state.subscribedContextGraphs.has(HASH)).toBe(false);
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(LOCAL);
    const adopted = f.state.subscribedContextGraphs.get(LOCAL)!;
    expect(adopted).toMatchObject({ onChainId: SLOT, onChainHash: HASH });
    expect(adopted.subscribed).toBe(role === 'member');
    expect(adopted.coreHosted === true).toBe(role === 'host');
  });
});
