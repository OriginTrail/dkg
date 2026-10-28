import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, type ContextGraphSubscriptionRecord } from '../src/index.js';
import type { ContextGraphSubInput } from '../src/dkg-agent-types.js';

const LOCAL = 'argus-vault';
const HASH = ethers.keccak256(ethers.toUtf8Bytes(LOCAL)).toLowerCase();
const FOREIGN = '0x2222222222222222222222222222222222222222';
const agents: DKGAgent[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const agent of agents.splice(0)) await agent.stop();
});

function saved(id: string, onChainId: string, onChainHash = HASH): ContextGraphSubscriptionRecord {
  return { id, onChainId, onChainHash, subscribed: true, synced: true, syncScoped: false };
}

async function restart(rows: ContextGraphSubscriptionRecord[], literalHash = false, admittedSlot?: string) {
  const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 323n });
  for (let id = 323; id <= 582; id++) {
    const nameHash = id === 323 && literalHash
      ? ethers.keccak256(ethers.toUtf8Bytes(HASH)).toLowerCase()
      : id === 323 || id === 582 ? HASH : ethers.keccak256(ethers.toUtf8Bytes(`other-${id}`));
    const created = await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash });
    expect(created.contextGraphId).toBe(BigInt(id));
  }
  await chain.__transferContextGraphOwnership(582n, FOREIGN);
  const save = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const agent = await DKGAgent.create({
    name: 'NumericDormant', chainAdapter: chain, nodeRole: 'edge',
    rfc64CatalogActivation: { enabled: false },
    contextGraphSubscriptionRehydrationEnabled: false,
    contextGraphSubscriptionStore: { loadAll: async () => rows.map((row) => ({ ...row })), save, delete: remove },
  });
  agents.push(agent);
  // Native disabled bootstrap requires only its local peer identity; no daemon,
  // providers or external RPC is started. Storage reads remain actual Mock API.
  (agent as unknown as { node: unknown }).node = {
    peerId: '12D3KooWNumericDormantFixture', libp2p: { getPeers: () => [] },
  };
  const state = agent as unknown as {
    subscribedContextGraphs: Map<string, ReturnType<DKGAgent['getSubscribedContextGraphs']> extends ReadonlyMap<string, infer V> ? V : never>;
    wireIdToLocalCgId: Map<string, string>;
    setContextGraphSubscription(id: string, next: ContextGraphSubInput, options: { persist: false }): void;
  };
  if (admittedSlot !== undefined) state.setContextGraphSubscription(HASH, {
    subscribed: false, coreHosted: true, synced: true,
    onChainId: admittedSlot, onChainHash: HASH,
  }, { persist: false });
  await agent.rehydrateContextGraphSubscriptions(null);
  return { agent, state, chain, save, remove, read: vi.spyOn(chain, 'readContextGraphStorageRange') };
}

describe('exact numeric lookup across dormant slots', () => {
  it.each(['wire-first', 'cleartext-first'] as const)('resolves both slots after %s disabled restart', async (order) => {
    const rows = [saved(HASH, '323'), saved(LOCAL, '582')];
    const f = await restart(order === 'wire-first' ? rows : rows.reverse());
    expect(f.state.subscribedContextGraphs.get(HASH)).toMatchObject({ onChainId: '323', subscribed: false });
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({ onChainId: '582', subscribed: false });
    const wireOwner = f.state.wireIdToLocalCgId.get(HASH);
    for (const [id, local] of [['323', HASH], ['582', LOCAL]]) {
      await expect(f.agent.resolveContextGraphOnChainIdReference(`#${id}`)).resolves.toMatchObject({
        kind: 'resolved', onChainId: id, contextGraphId: local, nameHash: HASH,
      });
      expect(f.agent.lookupContextGraphOnChainIdReference(`#${id}`)).toMatchObject({
        kind: 'held', onChainId: id, contextGraphId: local, nameHash: HASH,
      });
    }
    expect(f.read.mock.calls.map(([options]) => options.fromId)).toEqual([323n, 582n]);
    expect(f.chain.getContextGraph(323n)!.manager.toLowerCase()).not.toBe(FOREIGN);
    expect(f.chain.getContextGraph(582n)!.manager.toLowerCase()).toBe(FOREIGN);
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(wireOwner);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('does not substitute retained identity for unavailable chain proof', async () => {
    const f = await restart([saved(HASH, '323'), saved(LOCAL, '582')]);
    f.read.mockRejectedValue(new Error('storage authority unavailable'));
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'unavailable', onChainId: '582', detail: 'storage authority unavailable',
    });
  });

  it('rejects a saved wrong commitment instead of borrowing another slot', async () => {
    const f = await restart([saved(HASH, '323'), saved(LOCAL, '582', `0x${'44'.repeat(32)}`)]);
    expect(f.state.subscribedContextGraphs.has(LOCAL)).toBe(false);
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'unavailable', onChainId: '582',
    });
  });

  it('keeps a wire-only retained slot out of indirect cleartext authority', async () => {
    const f = await restart([saved(HASH, '323')]);
    await expect(f.agent.getContextGraphOnChainId(LOCAL)).resolves.toBeNull();
    await expect(f.agent.resolveCurrentNameHashContextGraphBinding(LOCAL)).resolves.toBeUndefined();
    expect(f.read).not.toHaveBeenCalled();
  });

  it('preserves admitted wire routing while resolving a different retained numeric slot', async () => {
    const f = await restart([saved(HASH, '323'), saved(LOCAL, '582')]);
    f.state.setContextGraphSubscription(HASH, {
      ...f.state.subscribedContextGraphs.get(HASH)!, coreHosted: true,
    }, { persist: false });
    const wireOwner = f.state.wireIdToLocalCgId.get(HASH);
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', onChainId: '582', contextGraphId: LOCAL,
    });
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(wireOwner);
    expect(f.state.subscribedContextGraphs.get(HASH)).toMatchObject({ coreHosted: true, onChainId: '323' });
  });

  it('uses the explicit literal commitment of a hash-shaped local name', async () => {
    const literalHash = ethers.keccak256(ethers.toUtf8Bytes(HASH)).toLowerCase();
    const f = await restart([saved(HASH, '323', literalHash), saved(LOCAL, '582')], true);
    await expect(f.agent.resolveContextGraphOnChainIdReference('#323')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: HASH, nameHash: literalHash,
    });
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', contextGraphId: LOCAL, nameHash: HASH,
    });
  });

  it('prefers admitted wire ownership over a matching dormant same-slot identity', async () => {
    const f = await restart([saved(LOCAL, '582')], false, '582');
    expect(f.state.subscribedContextGraphs.get(HASH)).toMatchObject({ coreHosted: true, onChainId: '582' });
    expect(f.state.subscribedContextGraphs.get(LOCAL)).toMatchObject({ coreHosted: false, onChainId: '582' });
    await expect(f.agent.resolveContextGraphOnChainIdReference('#582')).resolves.toMatchObject({
      kind: 'resolved', onChainId: '582', contextGraphId: HASH, nameHash: HASH,
    });
    expect(f.agent.lookupContextGraphOnChainIdReference('#582')).toMatchObject({ kind: 'held', contextGraphId: HASH });
    expect(f.state.wireIdToLocalCgId.get(HASH)).toBe(HASH);
    expect(f.save).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('fails closed for multiple retained local identities proving the same numeric slot', async () => {
    const f = await restart([saved(HASH, '323')]);
    const wire = f.state.subscribedContextGraphs.get(HASH)!;
    // Corrupt/ambiguous runtime state is an adversarial input, not a successful
    // adoption fixture. Neither the chain reader nor numeric resolver is stubbed.
    f.state.subscribedContextGraphs.set(LOCAL, { ...wire, onChainHash: HASH });
    await expect(f.agent.resolveContextGraphOnChainIdReference('#323')).resolves.toMatchObject({
      kind: 'unavailable', onChainId: '323',
    });
  });
});
