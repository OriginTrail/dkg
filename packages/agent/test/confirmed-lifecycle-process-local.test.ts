import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { ChangelogStore, GraphSetIndexStore, OxigraphStore, SparqlHttpStore, type TripleStore } from '@origintrail-official/dkg-storage';
import type { KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import type { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';

const input = { contextGraphId: 'process-local-confirmation', agentAddress: '0x1111111111111111111111111111111111111111',
  name: 'asset', publishedUal: 'did:dkg:mock/1', merkleRoot: 'ab'.repeat(32), assertionVersion: '1', packedKaId: 1n, publicationDeployment: { chainId: '31337', lifecycleAddress: '0x' + '22'.repeat(20) } };
const stores: TripleStore[] = [], owners: NamedKaVmLifecycleRepair[] = [], dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const owner of owners.splice(0)) await owner.stop();
  for (const store of stores.splice(0)) await store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function agentFor(store: TripleStore, dataDir?: string) {
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  const warn = vi.fn(), current = vi.fn(async () => ({ latestRoot: `0x${input.merkleRoot}`, rootCount: 1n }));
  Object.assign(agent, { config: { dataDir }, store, writeLocks: new Map(), log: { warn }, _canStampRecoveredKnowledgeAssetVmLifecycle: async () => true,
    chain: { readKnowledgeAssetVersionSnapshot: current, getEvmChainId: vi.fn(async () => 31337n),
      getKnowledgeAssetsLifecycleAddress: vi.fn(async () => input.publicationDeployment.lifecycleAddress) } });
  const owner = agent.getOrCreateNamedKaVmLifecycleRepair(); owners.push(owner); return { agent, owner, current, warn };
}
async function hasVm(store: TripleStore) {
  return store.query(`ASK { GRAPH <${contextGraphMetaUri(input.contextGraphId)}> {
    <${assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name)}> <http://dkg.io/ontology/vmCurrentAssertion> "${input.merkleRoot}" } }`);
}
describe('confirmed lifecycle persistence policy', () => {
  it('completes the default standalone agent through its real composed memory store without a durable journal', async () => {
    const backend = new OxigraphStore(), store = createListContextGraphsCacheInvalidatingStore(
      new ChangelogStore(new GraphSetIndexStore(backend)), () => {});
    stores.push(store); const { owner, current } = agentFor(store);
    expect(await owner.submit(input)).toBe('repaired'); expect(await hasVm(store)).toMatchObject({ value: true });
    expect(current).toHaveBeenCalledWith(1n, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it('keeps a durable journal pending when the selected leaf is only process-local, without projecting metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-memory-journal-refusal-')); dirs.push(dir);
    const store = new OxigraphStore(); stores.push(store); const { owner } = agentFor(store, dir);
    expect(await owner.submit(input)).toBe('pending'); expect(await hasVm(store)).toMatchObject({ value: false });
    const journal = JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
    expect(journal.entries).toHaveLength(1); expect(journal.entries[0][1].input).toMatchObject({ merkleRoot: input.merkleRoot, assertionVersion: '1' });
    expect(journal.entries[0][1].input).not.toHaveProperty('persistence');
  });
  it('refuses an uncertified remote even on a standalone host, before any network mutation or journal retirement', async () => {
    const store = new ChangelogStore(new SparqlHttpStore({ queryEndpoint: 'http://untrusted.test/query' })); stores.push(store);
    const fetch = vi.spyOn(globalThis, 'fetch'); const { warn, owner } = agentFor(store);
    expect(await owner.submit(input)).toBe('pending'); expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('explicitly certified persistence barrier'));
  });
  it.each([false, true])('applies the same host policy during a recovered queued confirmation, durable journal=%s', async durable => {
    const dir = durable ? await mkdtemp(join(tmpdir(), 'dkg-recovered-memory-')) : undefined; if (dir) dirs.push(dir);
    const store = new OxigraphStore(); stores.push(store); const { agent, current } = agentFor(store, dir);
    const request = { contextGraphId: input.contextGraphId, name: input.name, agentAddress: input.agentAddress,
      assertionVersion: input.assertionVersion, sealMerkleRoot: input.merkleRoot,
      sealChainId: input.publicationDeployment.chainId, sealKav10Address: input.publicationDeployment.lifecycleAddress } as KnowledgeAssetVmPublishRequest;
    const stamp = agent._stampQueuedKnowledgeAssetVmPublishedLifecycle(request, input.publishedUal, input.packedKaId);
    if (durable) await expect(stamp).rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_DURABILITY_UNAVAILABLE' });
    else expect(await stamp).toBe(true);
    expect(await hasVm(store)).toMatchObject({ value: !durable }); expect(current).toHaveBeenCalledOnce();
  });
  it('prefers a real durable barrier in process-local host mode and propagates its failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-standalone-durable-')); dirs.push(dir);
    const store = new OxigraphStore(join(dir, 'store.nq')); stores.push(store);
    const failure = new Error('durable storage unavailable'); const persist = vi.spyOn(store.commitment!, 'commit').mockRejectedValueOnce(failure);
    await expect(applyPublishedNamedKaVmLifecycle(store, input, { persistence: 'process-local' })).rejects.toBe(failure);
    expect(persist).toHaveBeenCalledOnce();
  });
});
