// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { assertionLifecycleUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { assertionLifecycleWriteLockKey, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import { repairPublishedDescriptor } from '../src/published-descriptor-repair.js';
import { AUTHOR, PUBLISHER, TX_HASH } from './_helpers/named-ka-recovery-fixture.js';

import { descriptorRepairFixture } from './_helpers/descriptor-repair-fixture.js';
import { incompleteNamedKaLifecycleOwner } from '../src/incomplete-named-ka-lifecycle.js';

const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const s of stores.splice(0)) await s.close(); });
const DKG = 'http://dkg.io/ontology/';
async function fixture(version = 1, lifecycleOwner?: string) {
  const h = await descriptorRepairFixture(version, AUTHOR, lifecycleOwner); stores.push(h.store); return h;
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
      if (failure === 'duplicate') {
        const retained = await h.store.query(`SELECT ?p ?o WHERE { GRAPH <${h.graph}> { <${h.subject}> ?p ?o } }`);
        if (retained.type !== 'bindings') throw new Error('bindings required');
        await h.store.insert(retained.bindings.map(r => ({ graph: h.graph,
          subject: assertionLifecycleUri(h.input.contextGraphId, AUTHOR, h.input.name), predicate: r.p!, object: r.o! })));
      }
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
      if (failure === 'duplicate') await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false }))
        .rejects.toThrow('missing or ambiguous lifecycle identity');
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

  it.each(['binding', 'receipt-root', 'receipt-controls'].flatMap(phase => [false, true].map(rejectSibling => ({ phase, rejectSibling }))))(
    'retains backpressure after $phase fails until its sibling settles (reject=$rejectSibling)', async ({ phase, rejectSibling }) => {
    const h = await fixture(); const before = await h.all();
    const deadline = new AbortController(); vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let release!: () => void;
    const held = new Promise<void>((resolve, reject) => { release = () => rejectSibling ? reject(new Error('sibling failed')) : resolve(); });
    const failure = new Error('parallel proof unavailable');
    if (phase === 'binding') {
      vi.spyOn(h.host, 'getContextGraphOnChainId').mockRejectedValueOnce(failure);
      h.chain.getKAContextGraphId.mockImplementationOnce(async () => { await held; return 1n; });
    } else {
      h.chain.resolveCanonicalFinalizationReceipt.mockRejectedValueOnce(failure);
      if (phase === 'receipt-root') {
        h.chain.getMerkleRootCount.mockImplementationOnce(async () => { await held; return 1n; });
      } else {
        const query = h.store.query.bind(h.store); let stalled = false;
        vi.spyOn(h.store, 'query').mockImplementation(async (sparql, options) => {
          if (!stalled && options?.source === 'agent.finalization.recoverReceiptBackedEvidence.controls') {
            stalled = true; await held;
          }
          return query(sparql, options);
        });
      }
    }
    const writer = vi.spyOn(h.host, 'stampPublishedLifecycle');
    try {
      await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false })).rejects.toThrow(failure.message);
      await expect(repairPublishedDescriptor(h.host, h.input)).rejects.toMatchObject({ code: 'KA_DESCRIPTOR_REPAIR_BUSY' });
      deadline.abort();
      await expect(repairPublishedDescriptor(h.host, h.input)).rejects.toMatchObject({ code: 'KA_DESCRIPTOR_REPAIR_BUSY' });
      expect(writer).not.toHaveBeenCalled(); expect(await h.all()).toEqual(before);
    } finally { release(); }
    vi.mocked(AbortSignal.timeout).mockReturnValue(new AbortController().signal);
    await vi.waitFor(async () => {
      await expect(repairPublishedDescriptor(h.host, h.input)).resolves.toMatchObject({ status: 'verified' });
    });
    expect(writer).not.toHaveBeenCalled(); expect(await h.all()).toEqual(before);
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

  it('preserves proof fields through compatibility repair faults and retries', async () => {
    const h = await fixture(); const before = await h.all();
    const remove = h.store.deleteByPatternWithoutCount.bind(h.store);
    let destructiveProofDeletes = 0;
    vi.spyOn(h.store, 'deleteByPatternWithoutCount').mockImplementation(async pattern => {
      await remove(pattern);
      if (pattern.subject === h.subject && ['vmCurrentAssertion', 'memoryLayer'].some(p => pattern.predicate === DKG + p)) {
        destructiveProofDeletes++; throw new Error('failure after deleting required retry proof');
      }
    });
    const insert = h.store.insert.bind(h.store);
    const stateFailure = vi.spyOn(h.store, 'insert').mockImplementation(async quads => {
      if (quads.some(q => q.predicate === DKG + 'state')) throw new Error('transient state insertion');
      return insert(quads);
    });
    await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false })).rejects.toThrow('transient state insertion');
    expect(destructiveProofDeletes).toBe(0); expect(await h.all()).toEqual(before);
    stateFailure.mockRestore();
    await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false })).resolves.toMatchObject({ status: 'repaired' });
    expect(destructiveProofDeletes).toBe(0);
  });

  it.each([true, false])('verifies an UPDATE receipt (matching version: %s)', async matches => {
    const h = await fixture(2); const before = await h.all();
    if (!matches) h.chain.verifyKAUpdate.mockResolvedValue({ verified: true, onChainMerkleRoot: ethers.getBytes(h.snapshot.latestRoot), merkleRootCount: 1n,
      blockNumber: 90, blockHash: h.snapshot.blockHash, txIndex: 1 });
    const repair = repairPublishedDescriptor(h.host, { ...h.input, dryRun: false });
    if (matches) {
      await expect(repair).resolves.toMatchObject({ status: 'repaired', assertionVersion: '2', root: h.snapshot.latestRoot });
      expect(await h.all()).toHaveLength(before.length + 1);
    } else {
      await expect(repair).rejects.toThrow('update receipt does not match'); expect(await h.all()).toEqual(before);
    }
    expect(h.chain.verifyKAUpdate).toHaveBeenCalledWith(TX_HASH, (BigInt(AUTHOR) << 96n) | 402n, PUBLISHER);
    expect(h.chain.resolveCanonicalFinalizationReceipt).not.toHaveBeenCalled();
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


describe('incomplete lifecycle diagnostics', () => {
  it.each(['storage', 'corrupt'] as const)('preserves the %s failure evidence', async kind => {
    const h = await fixture();
    const failure = Object.assign(new Error('Store scheduler queue wait timeout', { cause: new Error('store unavailable') }), { code: 'STORE_QUEUE_TIMEOUT' });
    if (kind === 'storage') {
      const query = h.store.query.bind(h.store);
      vi.spyOn(h.store, 'query').mockImplementation((sparql, options) => {
        if (options?.source === 'publisher.lifecycle.candidates') return Promise.reject(failure);
        return query(sparql, options);
      });
    } else {
      await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: DKG + 'kaId' });
      await h.store.insert([h.row('kaId', 'not-an-integer')]);
    }
    const pending = incompleteNamedKaLifecycleOwner(h.store, { ...h.input, kaNumber: '402', assertionVersion: '1', sealMerkleRoot: h.snapshot.latestRoot }, AUTHOR);
    if (kind === 'storage') await expect(pending).rejects.toBe(failure);
    else await expect(pending).rejects.toMatchObject({ code: 'KA_VM_RECOVERY_INCONSISTENT', cause: { code: 'KA_WM_LIFECYCLE_CORRUPT' } });
  });
});


it('repairs a peer-owned lifecycle while proving the wallet-authored KA identity', async () => {
  const lifecycleOwner = '12D3KooWJqhnnfouiNRUyJBEREpuKtV4A448LUbS6JiVCe8Q82bZ';
  const h = await fixture(2, lifecycleOwner); const before = await h.all();
  // A UAL author alone cannot select a different local owner; require the explicit selector.
  await expect(repairPublishedDescriptor(h.host, { ...h.input, dryRun: false }))
    .rejects.toThrow('missing or ambiguous lifecycle identity');
  await expect(repairPublishedDescriptor(h.host, { ...h.input, lifecycleOwner: 'wrong-owner', dryRun: false }))
    .rejects.toThrow('missing or ambiguous lifecycle identity');
  expect(await h.all()).toEqual(before);
  const provenance = 'http://www.w3.org/ns/prov#wasAttributedTo';
  await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: provenance });
  await h.store.insert([{ graph: h.graph, subject: h.subject, predicate: provenance, object: `did:dkg:agent:${lifecycleOwner.toLowerCase()}` }]);
  const wrongOwnerCase = await h.all();
  await expect(repairPublishedDescriptor(h.host, { ...h.input, lifecycleOwner, dryRun: false })).rejects.toThrow('does not match');
  expect(await h.all()).toEqual(wrongOwnerCase);
  await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: provenance });
  await h.store.insert([{ graph: h.graph, subject: h.subject, predicate: provenance, object: `did:dkg:agent:${lifecycleOwner}` }]);
  expect(await h.all()).toEqual(before);
  await expect(repairPublishedDescriptor(h.host, { ...h.input, lifecycleOwner }))
    .resolves.toMatchObject({ status: 'verified', author: ethers.getAddress(AUTHOR), lifecycleOwner, assertionVersion: '2' });
  expect(await h.all()).toEqual(before);
  await expect(repairPublishedDescriptor(h.host, { ...h.input, lifecycleOwner, dryRun: false }))
    .resolves.toMatchObject({ status: 'repaired', author: ethers.getAddress(AUTHOR), lifecycleOwner });
  const repaired = await h.all(); expect(repaired).toHaveLength(before.length + 1);
  expect(repaired).toContain(JSON.stringify({ g: h.graph, s: h.subject, p: DKG + 'state', o: '"published"' }));
  await repairPublishedDescriptor(h.host, { ...h.input, lifecycleOwner, dryRun: false });
  expect(await h.all()).toEqual(repaired);
  // The peer identity cannot substitute for the KA wallet in a retained VM graph.
  await h.store.deleteByPattern({ graph: h.graph, subject: h.subject, predicate: DKG + 'assertionGraph' });
  await h.store.insert([{ graph: h.graph, subject: h.subject, predicate: DKG + 'assertionGraph',
    object: contextGraphLayerUri(h.input.contextGraphId, MemoryLayer.VerifiableMemory, lifecycleOwner, 402n) }]);
  const wrongGraph = await h.all();
  await expect(repairPublishedDescriptor(h.host, { ...h.input, lifecycleOwner, dryRun: false }))
    .rejects.toThrow('conflicting published identity or layer');
  expect(await h.all()).toEqual(wrongGraph);
});
