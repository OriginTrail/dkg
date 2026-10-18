// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { assertionLifecycleUri, contextGraphMetaUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, generateGraphKnowledgeAssetMetadata } from '@origintrail-official/dkg-publisher';
import { assertionLifecycleWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { repairPublishedDescriptor } from '../src/published-descriptor-repair.js';
import { AUTHOR, PUBLISHER, TX_HASH } from './_helpers/named-ka-recovery-fixture.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of stores.splice(0)) await s.close(); });
const DKG = 'http://dkg.io/ontology/';
async function fixture() {
  const store = new OxigraphStore(); stores.push(store);
  const author = ethers.getAddress(AUTHOR);
  const input = { contextGraphId: 'repair-cg', name: 'published', kaUal: `did:dkg:evm:31337/${AUTHOR}/402` };
  const kaId = (BigInt(AUTHOR) << 96n) | 402n;
  const subject = assertionLifecycleUri(input.contextGraphId, author, input.name);
  const graph = contextGraphMetaUri(input.contextGraphId);
  const vm = contextGraphLayerUri(input.contextGraphId, MemoryLayer.VerifiableMemory, AUTHOR, 402n);
  const content: Quad[] = [{ graph: vm, subject: 'urn:asset:body', predicate: 'urn:text', object: '"exact accepted revision"' }];
  const root = computeFlatKCRootV10(content, []);
  const snapshot = { latestRoot: ethers.hexlify(root), rootCount: 1n, latestAuthor: AUTHOR,
    latestPublisher: PUBLISHER, blockNumber: 100, blockHash: `0x${'11'.repeat(32)}` };
  const chain = {
    chainId: 'evm:31337',
    readKnowledgeAssetVersionSnapshot: vi.fn(async () => snapshot),
    getKAContextGraphId: vi.fn(async () => 1n), getMerkleRootCount: vi.fn(async () => 1n),
    isContextGraphActiveOnChain: vi.fn(async () => true), getContextGraphAccessPolicy: vi.fn(async () => 0),
    isReceiptBlockFinalAndCanonical: vi.fn(async () => true),
    resolveCanonicalFinalizationReceipt: vi.fn(async () => ({ status: 'confirmed', receipt: {
      txHash: TX_HASH, blockNumber: 90, blockHash: snapshot.blockHash, txIndex: 1,
      merkleRoot: root, publisherAddress: PUBLISHER, authorAddress: AUTHOR,
      kaId, batchId: kaId, startKAId: kaId, endKAId: kaId,
    } })),
  };
  const host = { store, chain: chain as unknown as ChainAdapter, writeLocks: new Map<string, Promise<void>>(),
    getContextGraphOnChainId: async () => '1',
    stampPublishedLifecycle: (input: Parameters<typeof applyPublishedNamedKaVmLifecycle>[1]) => applyPublishedNamedKaVmLifecycle(store, input) };
  const row = (p: string, value: string): Quad => ({ graph, subject, predicate: DKG + p, object: JSON.stringify(value) });
  await store.insert([...content, ...generateGraphKnowledgeAssetMetadata({
    ual: input.kaUal, contextGraphId: input.contextGraphId, merkleRoot: root, publisherPeerId: 'fixture',
    accessPolicy: 'public', allowedPeers: [], timestamp: new Date(), authorAddress: AUTHOR,
    assertionVersion: 1, publicTripleCount: 1, privateTripleCount: 0, assertionGraph: vm,
  }, { status: 'confirmed', confirmation: { kind: 'transaction', provenance: {
    txHash: TX_HASH, blockNumber: 90, blockTimestamp: 0, publisherAddress: PUBLISHER,
    batchId: kaId, chainId: 'evm:31337',
  } } }),
  ...Object.entries({ assertionName: input.name, kaId: '402', reservedUal: input.kaUal, publishedUal: input.kaUal,
    assertionVersion: '1', memoryLayer: 'VM', vmCurrentAssertion: snapshot.latestRoot.slice(2),
    wmCurrentAssertion: snapshot.latestRoot.slice(2), swmCurrentAssertion: snapshot.latestRoot.slice(2),
    shareOperationId: 'original-share' }).map(([p, v]) => row(p, v)),
  { graph, subject, predicate: DKG + 'assertionGraph', object: vm },
  { graph, subject, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${AUTHOR}` },
  ]);
  await host.stampPublishedLifecycle({ ...input, agentAddress: author, publishedUal: input.kaUal,
    merkleRoot: snapshot.latestRoot, packedKaId: kaId });
  await store.deleteByPattern({ graph, subject, predicate: DKG + 'state' });
  const all = async () => {
    const r = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
    if (r.type !== 'bindings') throw new Error('bindings required');
    return r.bindings.map(r => JSON.stringify(r)).sort();
  };
  return { host, chain, store, input, subject, graph, vm, content, snapshot, row, all };
}

describe('targeted published descriptor repair', () => {
  it('defaults to read-only, restores only state on the original case-preserved subject, and is idempotent', async () => {
    const h = await fixture(); const before = await h.all();
    expect(await repairPublishedDescriptor(h.host, h.input)).toMatchObject({ status: 'verified', author: ethers.getAddress(AUTHOR) });
    expect(await h.all()).toEqual(before);
    expect(await repairPublishedDescriptor(h.host, { ...h.input, dryRun: false })).toMatchObject({ status: 'repaired' });
    const after = await h.all(); expect(after).toHaveLength(before.length + 1);
    expect(after.filter(r => !before.includes(r))).toEqual([JSON.stringify({ g: h.graph, s: h.subject, p: DKG + 'state', o: '"published"' })]);
    await repairPublishedDescriptor(h.host, { ...h.input, dryRun: false }); expect(await h.all()).toEqual(after);
  });

  it.each(['identity', 'duplicate', 'multivalue', 'draft', 'swm-draft', 'version', 'content', 'chain-root', 'chain-author', 'chain-cg', 'receipt', 'finality', 'chain-moved', 'private-controls'] as const)(
    'refuses %s without any mutation', async failure => {
      const h = await fixture();
      const replace = async (p: string, v: string) => {
        await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: DKG + p });
        await h.store.insert([h.row(p, v)]);
      };
      if (failure === 'identity') await replace('kaId', '999');
      if (failure === 'duplicate') await h.store.insert([{ ...h.row('kaId', '402'), subject: assertionLifecycleUri(h.input.contextGraphId, AUTHOR, h.input.name) }]);
      if (failure === 'multivalue') await h.store.insert([h.row('wmCurrentAssertion', 'ff'.repeat(32))]);
      if (failure === 'draft') await replace('wmCurrentAssertion', 'ff'.repeat(32));
      if (failure === 'swm-draft') await replace('swmCurrentAssertion', 'ff'.repeat(32));
      if (failure === 'version') await replace('assertionVersion', '2');
      if (failure === 'content') { await h.store.dropGraph(h.vm); await h.store.insert([{ ...h.content[0]!, object: '"same count wrong content"' }]); }
      if (failure === 'chain-root') h.snapshot.latestRoot = `0x${'ff'.repeat(32)}`;
      if (failure === 'chain-author') h.snapshot.latestAuthor = PUBLISHER;
      if (failure === 'chain-cg') h.chain.getKAContextGraphId.mockResolvedValue(2n);
      if (failure === 'receipt') h.chain.resolveCanonicalFinalizationReceipt.mockRejectedValue(new Error('receipt unavailable'));
      if (failure === 'finality') h.chain.isReceiptBlockFinalAndCanonical.mockResolvedValue(false);
      if (failure === 'chain-moved') h.chain.readKnowledgeAssetVersionSnapshot.mockResolvedValueOnce(h.snapshot)
        .mockResolvedValueOnce({ ...h.snapshot, rootCount: 2n });
      if (failure === 'private-controls') h.chain.getContextGraphAccessPolicy.mockResolvedValue(1);
      const before = await h.all();
      await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false })).rejects.toMatchObject({ code: expect.stringMatching(/REPAIR_REFUSED|RECOVERY_INCONSISTENT/) });
      if (['draft', 'swm-draft', 'identity', 'version', 'multivalue'].includes(failure)) {
        await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false })).rejects.toThrow(
          ['draft', 'swm-draft'].includes(failure) ? 'newer local draft' : failure === 'multivalue' ? 'conflicting' : 'does not match');
      }
      expect(await h.all()).toEqual(before);
    });

  it('completes the trailing fields after the actual first-publication writer loses state', async () => {
    const h = await fixture();
    await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: DKG + 'publishedUal' });
    await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: DKG + 'assertionGraph' });
    await h.store.insert([{ graph: h.graph, subject: h.subject, predicate: DKG + 'assertionGraph',
      object: contextGraphLayerUri(h.input.contextGraphId, MemoryLayer.SharedWorkingMemory, AUTHOR, 402n) }, h.row('state', 'promoted')]);
    const insert = h.store.insert.bind(h.store);
    const fault = vi.spyOn(h.store, 'insert').mockImplementation(async quads => {
      if (quads.some(q => q.predicate === DKG + 'state')) throw new Error('state insertion failed');
      return insert(quads);
    });
    await expect(h.host.stampPublishedLifecycle({ ...h.input, agentAddress: ethers.getAddress(AUTHOR),
      publishedUal: h.input.kaUal, merkleRoot: h.snapshot.latestRoot, packedKaId: (BigInt(AUTHOR) << 96n) | 402n }))
      .rejects.toThrow('state insertion failed');
    fault.mockRestore();
    await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false })).resolves.toMatchObject({ status: 'repaired' });
    const rows = await h.all();
    for (const [p, o] of [['state', '"published"'], ['publishedUal', JSON.stringify(h.input.kaUal)], ['assertionGraph', h.vm]]) {
      expect(rows).toContain(JSON.stringify({ g: h.graph, s: h.subject, p: DKG + p, o }));
    }
  });

  it.each(['lock', 'read'] as const)('bounds a stalled %s and never writes after its deadline', async phase => {
    const h = await fixture(); const before = await h.all();
    const deadline = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const predecessor = phase === 'lock' ? withKeyedLocks(h.host.writeLocks,
      [assertionLifecycleWriteLockKey(h.input.contextGraphId, h.input.name, AUTHOR)], async () => { entered(); await held; }) : undefined;
    if (phase === 'read') h.chain.readKnowledgeAssetVersionSnapshot.mockImplementation(async () => { entered(); await held; return h.snapshot; });
    const pending = repairPublishedDescriptor(h.host, { ...h.input, dryRun: false });
    await started; deadline.abort();
    await expect(pending).rejects.toThrow('deadline exceeded');
    await expect(repairPublishedDescriptor(h.host, h.input)).rejects.toMatchObject({ code: 'KA_DESCRIPTOR_REPAIR_BUSY' });
    expect(await h.all()).toEqual(before); release(); await predecessor;
    // Drain the abandoned read/gate without allowing a timer-dependent late write.
    await vi.waitFor(async () => {
      vi.mocked(AbortSignal.timeout).mockReturnValue(new AbortController().signal);
      await expect(repairPublishedDescriptor(h.host, h.input)).resolves.toMatchObject({ status: 'verified' });
    });
    expect(await h.all()).toEqual(before);
  });

  it('awaits an entered mutation even if the read deadline expires', async () => {
    const h = await fixture(); const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const writer = h.host.stampPublishedLifecycle;
    h.host.stampPublishedLifecycle = async input => { entered(); await held; await writer(input); };
    let settled = false; const pending = repairPublishedDescriptor(h.host, { ...h.input, dryRun: false }).finally(() => { settled = true; });
    await started; deadline.abort(); await Promise.resolve(); expect(settled).toBe(false);
    await expect(repairPublishedDescriptor(h.host, h.input)).rejects.toMatchObject({ code: 'KA_DESCRIPTOR_REPAIR_BUSY' });
    release(); await expect(pending).resolves.toMatchObject({ status: 'repaired' });
  });

  it('accepts a new confirmed block when the coherent asset version is unchanged', async () => {
    const h = await fixture();
    h.chain.readKnowledgeAssetVersionSnapshot.mockResolvedValueOnce(h.snapshot)
      .mockResolvedValueOnce({ ...h.snapshot, blockNumber: 101, blockHash: `0x${'22'.repeat(32)}` });
    await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false }))
      .resolves.toMatchObject({ status: 'repaired' });
  });

  it('rejects concurrent repair instead of accumulating work', async () => {
    const h = await fixture(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    h.chain.readKnowledgeAssetVersionSnapshot.mockImplementation(async () => { await held; return h.snapshot; });
    const first = repairPublishedDescriptor(h.host, h.input);
    await expect(repairPublishedDescriptor(h.host, h.input)).rejects.toMatchObject({ code: 'KA_DESCRIPTOR_REPAIR_BUSY' });
    release(); await expect(first).resolves.toMatchObject({ status: 'verified' });
  });
});
