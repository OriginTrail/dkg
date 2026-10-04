import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { assertionLifecycleUri, buildAssertionSealQuads, contextGraphAssertionUri, contextGraphMetaUri,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, StoreOperationTimeoutError, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, DKGPublisher, TripleStoreAsyncLiftPublisher,
  type KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { createKnowledgeAssetVmPublishIntentKey } from '../src/dkg-agent-publish.js';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { decodeLifecycleRepairJournal, lifecycleRepairKey, normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const CG = 'confirmed-lifecycle-repair', NAME = 'repair-asset', UAL = `did:dkg:mock:31337/${AUTHOR}/1`;
const PACKED = (BigInt(AUTHOR) << 96n) | 1n, PUBLISHED = 'did:dkg:mock:31337/0x2222222222222222222222222222222222222222/1';
const DKG = 'http://dkg.io/ontology/', PRIOR = 'ab'.repeat(32);
const QUADS = [{ subject: 'urn:repair:entity', predicate: 'http://schema.org/name', object: '"Confirmed"', graph: '' }];
const ROOT = computeFlatKCRootV10(QUADS, []), HEX = ethers.hexlify(ROOT);
const META = contextGraphMetaUri(CG), LIFECYCLE = assertionLifecycleUri(CG, AUTHOR, NAME), ASSERTION = contextGraphAssertionUri(CG, AUTHOR, NAME);
const dirs: string[] = [];
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of new Set(stores.splice(0))) await store.close().catch(() => undefined); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
class FaultStore extends OxigraphStore {
  armed = false;
  constructor(path: string, readonly predicate: string, readonly operation: 'insert' | 'delete') { super(path); }
  override async insert(quads: Quad[]): Promise<void> {
    if (this.armed && this.operation === 'insert' && quads.some(q => q.predicate === this.predicate)) throw this.failure();
    await super.insert(quads);
  }
  override async deleteByPattern(pattern: Partial<Quad>): Promise<number> {
    if (this.armed && this.operation === 'delete' && pattern.predicate === this.predicate) throw this.failure();
    return super.deleteByPattern(pattern);
  }
  failure() { return new StoreOperationTimeoutError({ backend: 'managed-oxigraph', operation: this.operation === 'insert' ? 'insert' : 'deleteByPattern', outcome: 'not_started' }); }
}
function agentFor(store: OxigraphStore, dir: string, version: number) {
  stores.push(store);
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.defineProperty(agent, 'peerId', { value: 'peer-lifecycle-repair' });
  agent.defaultAgentAddress = AUTHOR; agent.config = { dataDir: dir }; agent.store = store;
  agent.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  agent.chain = { readKnowledgeAssetVersionSnapshot: vi.fn(async () => ({ latestRoot: HEX, rootCount: BigInt(version) })) };
  agent.createV10ACKProvider = () => undefined;
  agent._resolveEncryptInlinePayload = async () => undefined; agent._resolveEncryptInlineChunked = async () => undefined;
  agent._buildPrecomputedUpdateAttestationForSeal = async () => ({});
  agent.afterConfirmedGraphScopedVmPublishV1 = async () => undefined;
  agent.gossip = { publish: async () => undefined };
  return agent;
}
const faults = [
  ['vm pointer delete', `${DKG}vmCurrentAssertion`, 'delete'], ['vm pointer insert', `${DKG}vmCurrentAssertion`, 'insert'],
  ['wm divergence pointer', `${DKG}wmCurrentAssertion`, 'delete'], ['memory layer', `${DKG}memoryLayer`, 'insert'],
  ['published state', `${DKG}state`, 'insert'], ['published UAL', `${DKG}publishedUal`, 'insert'],
  ['update provenance', 'http://www.w3.org/ns/prov#wasRevisionOf', 'insert'],
  ['successful stamp', 'urn:never-fails', 'insert'],
] as const;
for (const mode of ['sync-mint', 'sync-update', 'queued-mint', 'queued-update'] as const) {
  describe(`confirmed descriptor recovery: ${mode}`, () => {
    for (const [label, predicate, operation] of faults) {
      if (label === 'update provenance' && !mode.includes('update')) continue;
      it(`re-stamps ${label} after restart without another publication or version`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'dkg-confirmed-stamp-')); dirs.push(dir);
        let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
        const version = mode.includes('update') ? 2 : 1, storePath = join(dir, 'store.nq');
        const store = new FaultStore(storePath, predicate, operation), scope = createGraphKnowledgeAssetScope(UAL, version);
        const swm = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
        await store.insert([
          ...buildAssertionSealQuads({ assertionUri: ASSERTION, metaGraph: META, merkleRoot: ROOT,
            authorAddress: AUTHOR, authorAttestationR: new Uint8Array(32).fill(1), authorAttestationVS: new Uint8Array(32).fill(2),
            authorSchemeVersion: 1, chainId: 31337n, kav10Address: AUTHOR, reservedKaId: PACKED,
            finalizedAtIso: new Date(now).toISOString(), contentScopeVersion: 2, kaUal: UAL, assertionVersion: version,
            publicTripleCount: 1, privateTripleCount: 0 }), ...QUADS.map(q => ({ ...q, graph: swm })),
          { subject: LIFECYCLE, predicate: `${DKG}kaId`, object: '"1"', graph: META },
          { subject: LIFECYCLE, predicate: `${DKG}wmCurrentAssertion`, object: JSON.stringify(HEX.slice(2)), graph: META },
          { subject: LIFECYCLE, predicate: `${DKG}swmCurrentAssertion`, object: JSON.stringify(HEX.slice(2)), graph: META },
          { subject: LIFECYCLE, predicate: `${DKG}state`, object: '"shared"', graph: META },
          { subject: LIFECYCLE, predicate: `${DKG}memoryLayer`, object: '"SWM"', graph: META },
          ...(version === 2 ? [{ subject: LIFECYCLE, predicate: `${DKG}vmCurrentAssertion`, object: JSON.stringify(PRIOR), graph: META }] : []),
        ]);
        const agent = agentFor(store, dir, version);
        const publish = vi.fn(async () => {
          store.armed = true; // Confirmation precedes the targeted stamp.
          return { status: 'confirmed', ual: PUBLISHED, kaId: PACKED, merkleRoot: ROOT, kaManifest: [],
            onChainResult: { txHash: `0x${'cd'.repeat(32)}`, blockNumber: 2, txIndex: 0, kaId: PACKED, batchId: PACKED,
              startKAId: PACKED, endKAId: PACKED, publisherAddress: AUTHOR } }; 
        });
        agent.publisher = { publish, hasSwmShareComplete: async () => true, clearSwmShareComplete: async () => undefined,
          clearPublishedKnowledgeAssetSwm: async () => undefined };
        agent.publishFromSharedMemory = publish; agent.update = publish;
        let queue: TripleStoreAsyncLiftPublisher | undefined, result: any;
        if (mode.startsWith('queued')) {
          const staging = new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
          await staging.stageKnowledgeAssetSharedWorkingMemoryV1({ contextGraphId: CG, kaUal: UAL, assertionVersion: version,
            shareOperationId: 'confirmed-share', quads: QUADS, privateTripleCount: 0, publisherPeerId: agent.peerId });
          const fields = { contextGraphId: CG, name: NAME, agentAddress: AUTHOR, shareOperationId: 'confirmed-share', roots: [],
            seal: { merkleRoot: HEX, authorAddress: AUTHOR, signature: { r: `0x${'01'.repeat(32)}`, vs: `0x${'02'.repeat(32)}` }, schemeVersion: 1, reservedKaId: PACKED.toString() },
            sealChainId: '31337', sealKav10Address: AUTHOR, sealFinalizedAtIso: new Date(now).toISOString(), sealMerkleRoot: HEX,
            contentScopeVersion: 2, kaUal: UAL, assertionVersion: String(version), publicTripleCount: 1, privateTripleCount: 0,
            ...(version === 2 ? { vmCurrentAssertion: PRIOR } : {}) };
          const request = { ...fields, intentKey: createKnowledgeAssetVmPublishIntentKey(fields as any) } as KnowledgeAssetVmPublishRequest;
          queue = new TripleStoreAsyncLiftPublisher(store, { knowledgeAssetVmPublishHandler: { execute: async ({ request, publishOptions }) => {
            result = await agent.publishQueuedKnowledgeAssetVmPublish(request, publishOptions); return result;
          } } });
          const jobId = await queue.enqueueKnowledgeAssetVmPublish(request);
          const processed = await queue.processNext('wallet-1');
          if (processed?.status === 'failed') throw new Error(JSON.stringify(processed));
          expect(processed).toMatchObject({ jobId, status: 'finalized' });
        } else result = await agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR });
        expect(result.status).toBe('confirmed'); expect(result.ual).toBe(PUBLISHED); expect(result.lifecycleRepairPending).toBe(label === 'successful stamp' ? undefined : true); expect(publish).toHaveBeenCalledTimes(1);
        await agent.namedKaVmLifecycleRepair?.runDue(); // No retry before the persisted 5s deadline.
        await agent.namedKaVmLifecycleRepair?.stop(); await store.close(); now += 6_000;
        const restartedStore = new OxigraphStore(storePath); stores.push(restartedStore);
        // The baseline admits no work: this owner then loads an empty journal and the assertions fail.
        const restarted = agentFor(restartedStore, dir, version);
        const repair = restarted.getOrCreateNamedKaVmLifecycleRepair?.() ?? new NamedKaVmLifecycleRepair({ dataDir: dir, now: () => now,
          apply: input => applyPublishedNamedKaVmLifecycle(restartedStore, input), isCurrent: async () => true, warn: () => undefined });
        await repair.runDue();
        const rows = await restartedStore.query(`SELECT ?p ?o WHERE { GRAPH <${META}> { <${LIFECYCLE}> ?p ?o } }`);
        if (rows.type !== 'bindings') throw new Error('Expected lifecycle rows');
        const values = Object.fromEntries(rows.bindings.map(row => [row.p, row.o]));
        expect(values[`${DKG}vmCurrentAssertion`]).toBe(JSON.stringify(HEX.slice(2)));
        expect(values[`${DKG}wmCurrentAssertion`]).toBeUndefined();
        expect(values[`${DKG}memoryLayer`]).toBe('"VM"'); expect(values[`${DKG}state`]).toBe('"published"');
        expect(values[`${DKG}publishedUal`]).toBe(JSON.stringify(PUBLISHED));
        expect(values[`${DKG}assertionGraph`]).toBe(knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope));
        if (version === 2) expect(values['http://www.w3.org/ns/prov#wasRevisionOf']).toBe(`${LIFECYCLE}#assertion-${PRIOR}`);
        expect(publish).toHaveBeenCalledTimes(1);
        if (queue) expect(await new TripleStoreAsyncLiftPublisher(restartedStore).processNext('wallet-1')).toBeNull();
        await repair.stop(); await restartedStore.close();
      });
    }
  });
}

describe('confirmed lifecycle repair scheduling and fences', () => {
  const input = { contextGraphId: CG, name: NAME, agentAddress: AUTHOR, publishedUal: PUBLISHED,
    merkleRoot: HEX, assertionVersion: '1', packedKaId: PACKED };
  it('persists exponential retry deadlines through restart and never retries rejected evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-stamp-backoff-')); dirs.push(dir);
    let now = 1_000;
    const apply = vi.fn(async () => { throw new StoreOperationTimeoutError({ backend: 'managed-oxigraph', operation: 'insert', outcome: 'indeterminate' }); });
    const create = () => new NamedKaVmLifecycleRepair({ dataDir: dir, now: () => now, apply, isCurrent: async () => true, warn: () => undefined });
    let repair = create();
    expect(await repair.submit(input)).toBe('pending'); expect(apply).toHaveBeenCalledTimes(1);
    await repair.runDue(); expect(apply).toHaveBeenCalledTimes(1);
    await repair.stop(); repair = create();
    now = 5_999; await repair.runDue(); expect(apply).toHaveBeenCalledTimes(1);
    now = 6_000; await repair.runDue(); expect(apply).toHaveBeenCalledTimes(2);
    now = 15_999; await repair.runDue(); expect(apply).toHaveBeenCalledTimes(2);
    now = 16_000; await repair.runDue(); expect(apply).toHaveBeenCalledTimes(3);
    apply.mockImplementation(async () => { throw Object.assign(new Error('Invalid exact evidence'), { code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' }); });
    now = 36_000; await repair.runDue(); expect(apply).toHaveBeenCalledTimes(4);
    now = 999_999; await repair.runDue(); expect(apply).toHaveBeenCalledTimes(4);
    await repair.stop(); repair = create(); await repair.runDue(); expect(apply).toHaveBeenCalledTimes(4);
    await expect(repair.submit({ ...input, assertionVersion: '0' })).rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
    await repair.stop();
  });
  it('limits each retry pass to ten entries and skips an overlapping timer tick', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const apply = vi.fn(async () => { throw new Error('Temporary store outage'); });
      const repair = new NamedKaVmLifecycleRepair({ now: () => now, apply, isCurrent: async () => true, warn: () => undefined });
      for (let i = 0; i < 12; i++) await repair.submit({ ...input, name: `asset-${i}` });
      apply.mockImplementation(async () => { await held; });
      now = 6_000;
      repair.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(apply).toHaveBeenCalledTimes(13);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(apply).toHaveBeenCalledTimes(13);
      release();
      await repair.stop();
      // Stop waits for the physical write but prevents the rest of its batch from starting.
      expect(apply).toHaveBeenCalledTimes(13);
      repair.start();
      await repair.runDue();
      expect(apply).toHaveBeenCalledTimes(23); // Ten remaining entries, leaving one for a later pass.
      await repair.runDue();
      expect(apply).toHaveBeenCalledTimes(24);
      await repair.stop();
    } finally { vi.useRealTimers(); }
  });

  it('fences a superseded chain version and a conflicting same-version root', async () => {
    const apply = vi.fn(async () => undefined);
    const repair = new NamedKaVmLifecycleRepair({ apply, isCurrent: async () => false, warn: () => undefined });
    expect(await repair.submit(input)).toBe('superseded'); expect(apply).not.toHaveBeenCalled(); await repair.stop();
    const pending = new NamedKaVmLifecycleRepair({ apply: async () => { throw new Error('RPC unavailable'); }, isCurrent: async () => true, warn: () => undefined });
    await pending.submit(input);
    await expect(pending.submit({ ...input, merkleRoot: PRIOR })).rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
    await pending.stop();
  });
  it('retains a divergent newer workspace while repairing the confirmed VM descriptor', async () => {
    const store = new OxigraphStore();
    await store.insert([
      { subject: LIFECYCLE, predicate: `${DKG}wmCurrentAssertion`, object: JSON.stringify(PRIOR), graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}memoryLayer`, object: '"WM"', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}state`, object: '"created"', graph: META },
    ]);
    await applyPublishedNamedKaVmLifecycle(store, input);
    const rows = await store.query(`SELECT ?p ?o WHERE { GRAPH <${META}> { <${LIFECYCLE}> ?p ?o } }`);
    if (rows.type !== 'bindings') throw new Error('Expected rows');
    const values = Object.fromEntries(rows.bindings.map(row => [row.p, row.o]));
    expect(values[`${DKG}vmCurrentAssertion`]).toBe(JSON.stringify(HEX.slice(2)));
    expect(values[`${DKG}publishedUal`]).toBe(JSON.stringify(PUBLISHED));
    expect(values[`${DKG}wmCurrentAssertion`]).toBe(JSON.stringify(PRIOR));
    expect(values[`${DKG}memoryLayer`]).toBe('"WM"'); expect(values[`${DKG}state`]).toBe('"created"');
    await store.close();
  });
  it('uses coherent chain version evidence to reject a same-version mismatch and retire an older repair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-stamp-chain-fence-')); dirs.push(dir);
    const store = new OxigraphStore(), agent = agentFor(store, dir, 2);
    const repair = agent.getOrCreateNamedKaVmLifecycleRepair();
    expect(await repair.submit(input)).toBe('superseded');
    agent.chain.readKnowledgeAssetVersionSnapshot.mockResolvedValue({ latestRoot: `0x${PRIOR}`, rootCount: 1n });
    expect(await repair.submit(input)).toBe('rejected');
    const rows = await store.query(`SELECT ?p ?o WHERE { GRAPH <${META}> { <${LIFECYCLE}> ?p ?o } }`);
    expect(rows).toMatchObject({ bindings: [] });
    await repair.stop(); await store.close();
  });
});

describe('review regression boundaries', () => {
  const input = { contextGraphId: CG, name: NAME, agentAddress: AUTHOR, publishedUal: PUBLISHED, merkleRoot: HEX, assertionVersion: '1', packedKaId: PACKED };
  it.each([false, true])('preserves a reopened unsealed WM draft with matching pointer=%s', async (matchingPointer) => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-open-wm-repair-')); dirs.push(dir);
    const store = new OxigraphStore(); stores.push(store);
    const scope = createGraphKnowledgeAssetScope(UAL, 1), vmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope), wmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.WorkingMemory, scope);
    await store.insert([
      ...buildAssertionSealQuads({ assertionUri: ASSERTION, metaGraph: META, merkleRoot: ROOT, authorAddress: AUTHOR,
        authorAttestationR: new Uint8Array(32).fill(1), authorAttestationVS: new Uint8Array(32).fill(2), authorSchemeVersion: 1,
        chainId: 31337n, kav10Address: AUTHOR, reservedKaId: PACKED, finalizedAtIso: new Date().toISOString(),
        contentScopeVersion: 2, kaUal: UAL, assertionVersion: 1, publicTripleCount: 1, privateTripleCount: 0 }),
      ...QUADS.map(quad => ({ ...quad, graph: vmGraph })),
      { subject: LIFECYCLE, predicate: `${DKG}contentScopeVersion`, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}assertionVersion`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}kaId`, object: '"1"', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}reservedUal`, object: UAL, graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}vmCurrentAssertion`, object: JSON.stringify(HEX.slice(2)), graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}state`, object: '"published"', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}memoryLayer`, object: '"VM"', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}assertionGraph`, object: vmGraph, graph: META },
    ]);
    let now = 1_000, fail = true;
    const repair = new NamedKaVmLifecycleRepair({ dataDir: dir, now: () => now, isCurrent: async () => true, warn: () => undefined,
      apply: async value => { if (fail) throw new StoreOperationTimeoutError({ backend: 'managed-oxigraph', operation: 'insert', outcome: 'not_started' }); await applyPublishedNamedKaVmLifecycle(store, value); } });
    expect(await repair.submit(input)).toBe('pending');
    const publisher = new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
    await publisher.assertionPullFrom(CG, NAME, AUTHOR, 'vm');
    await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:new:draft', predicate: 'urn:text', object: '"edited"', graph: '' }]);
    if (matchingPointer) await store.insert([{ subject: LIFECYCLE, predicate: `${DKG}wmCurrentAssertion`, object: JSON.stringify(HEX.slice(2)), graph: META }]);
    fail = false; now = 6_000; await repair.runDue();
    const rows = await store.query(`SELECT ?p ?o WHERE { GRAPH <${META}> { <${LIFECYCLE}> ?p ?o } }`);
    if (rows.type !== 'bindings') throw new Error('Expected lifecycle rows');
    const values = Object.fromEntries(rows.bindings.map(row => [row.p, row.o]));
    expect(values[`${DKG}state`]).toBe('"created"'); expect(values[`${DKG}memoryLayer`]).toBe('"WM"'); expect(values[`${DKG}assertionGraph`]).toBe(wmGraph);
    expect(values[`${DKG}vmCurrentAssertion`]).toBe(JSON.stringify(HEX.slice(2)));
    if (matchingPointer) expect(values[`${DKG}wmCurrentAssertion`]).toBe(JSON.stringify(HEX.slice(2)));
    await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:next:draft', predicate: 'urn:text', object: '"still editable"', graph: '' }]);
    expect(await store.query(`ASK { GRAPH <${META}> { <${wmGraph}> <${DKG}memoryLayer> "WM" } }`)).toMatchObject({ type: 'boolean', value: true });
    await repair.stop();
  });
  it('admits B durably while unrelated A is held in a repair attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-parallel-admission-')); dirs.push(dir);
    let release!: () => void, entered!: () => void, bEntered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), bStarted = new Promise<void>(resolve => { bEntered = resolve; });
    const repair = new NamedKaVmLifecycleRepair({ dataDir: dir, isCurrent: async () => true, warn: () => undefined,
      apply: async value => { if (value.name === NAME) entered(); else bEntered(); await held; } });
    const a = repair.submit(input); await started; const b = repair.submit({ ...input, name: 'independent-B', packedKaId: PACKED + 1n, publishedUal: `${PUBLISHED.slice(0, -1)}2` });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([bStarted, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('B admission blocked by A')), 1_000); })]);
      const journal = decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')));
      expect(journal.size).toBe(2); expect([...journal.values()].map(entry => entry.input.name)).toContain('independent-B');
    } finally { if (timeout) clearTimeout(timeout); release(); await Promise.all([a, b]); await repair.stop(); }
  });
  it('persists write-ahead evidence before the first apply callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-write-ahead-')); dirs.push(dir);
    const apply = vi.fn(async () => {
      const journal = decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')));
      expect([...journal.values()]).toMatchObject([{ input: { name: NAME, merkleRoot: HEX.slice(2), assertionVersion: '1' }, attempts: 0 }]);
    });
    const repair = new NamedKaVmLifecycleRepair({ dataDir: dir, apply, isCurrent: async () => true, warn: () => undefined });
    expect(await repair.submit(input)).toBe('repaired'); expect(apply).toHaveBeenCalledOnce(); await repair.stop();
  });
  it('does not apply after failed durable admission and preserves confirmed evidence in the agent error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-failed-admission-')); dirs.push(dir);
    const apply = vi.fn(async () => undefined), repair = new NamedKaVmLifecycleRepair({ dataDir: dir, apply, isCurrent: async () => true, warn: () => undefined });
    const persist = vi.spyOn(repair as unknown as { persist: () => Promise<void> }, 'persist').mockRejectedValueOnce(Object.assign(new Error('journal fsync failed'), { code: 'EIO' }));
    const store = new OxigraphStore(), agent = agentFor(store, dir, 1); agent.namedKaVmLifecycleRepair = repair;
    await expect(agent._repairConfirmedNamedKaVmLifecycle(input)).rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_REPAIR_REQUIRED', publishedUal: PUBLISHED, merkleRoot: HEX, assertionVersion: '1' });
    expect(persist).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled(); await repair.stop();
  });
  it('round-trips canonical version-1 journal entries and retry state', () => {
    const normalized = normalizeLifecycleRepairInput({ ...input, merkleRoot: HEX.toUpperCase().replace('0X', '0x'), priorMerkleRoot: `0x${PRIOR.toUpperCase()}` }, true), key = lifecycleRepairKey(normalized);
    const decoded = decodeLifecycleRepairJournal({ version: 1, entries: [[key, { input: normalized, attempts: 2, nextAttemptAt: 6_000, rejected: false, lastError: 'timeout' }]] });
    expect(decoded.get(key)).toEqual({ input: { ...normalized, merkleRoot: HEX.slice(2), priorMerkleRoot: PRIOR }, attempts: 2, nextAttemptAt: 6_000, rejected: false, lastError: 'timeout' });
  });
  it.each(['contextGraphId', 'agentAddress', 'name', 'publishedUal', 'merkleRoot', 'assertionVersion', 'packedKaId', 'subGraphName', 'priorMerkleRoot'])('rejects non-string journal field %s', (field) => {
    const normalized = normalizeLifecycleRepairInput(input, true), key = lifecycleRepairKey(normalized);
    expect(() => decodeLifecycleRepairJournal({ version: 1, entries: [[key, { input: { ...normalized, [field]: 123 }, attempts: 0, nextAttemptAt: 0 }]] })).toThrow('Invalid confirmed named KA lifecycle repair evidence');
  });
});

describe('tentative normal publication projection', () => {
  it.each([1, 2])('centralizes tentative mint/update version %s without claiming a VM data graph', async (version) => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-tentative-projection-')); dirs.push(dir);
    const store = new OxigraphStore(), scope = createGraphKnowledgeAssetScope(UAL, version), swm = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
    await store.insert([
      ...buildAssertionSealQuads({ assertionUri: ASSERTION, metaGraph: META, merkleRoot: ROOT, authorAddress: AUTHOR,
        authorAttestationR: new Uint8Array(32).fill(1), authorAttestationVS: new Uint8Array(32).fill(2), authorSchemeVersion: 1,
        chainId: 31337n, kav10Address: AUTHOR, reservedKaId: PACKED, finalizedAtIso: new Date().toISOString(),
        contentScopeVersion: 2, kaUal: UAL, assertionVersion: version, publicTripleCount: 1, privateTripleCount: 0 }),
      ...QUADS.map(quad => ({ ...quad, graph: swm })),
      { subject: LIFECYCLE, predicate: `${DKG}kaId`, object: '"1"', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}state`, object: '"shared"', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}memoryLayer`, object: '"SWM"', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}assertionGraph`, object: swm, graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}wmCurrentAssertion`, object: JSON.stringify(version === 2 ? PRIOR : HEX.slice(2)), graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}swmCurrentAssertion`, object: JSON.stringify(HEX.slice(2)), graph: META },
      ...(version === 2 ? [{ subject: LIFECYCLE, predicate: `${DKG}vmCurrentAssertion`, object: JSON.stringify(PRIOR), graph: META }] : []),
    ]);
    const agent = agentFor(store, dir, version), publish = vi.fn(async () => ({ status: 'tentative', ual: PUBLISHED, kaId: PACKED, merkleRoot: ROOT, kaManifest: [] }));
    agent.publisher = { publish, hasSwmShareComplete: async () => true, clearSwmShareComplete: async () => undefined, clearPublishedKnowledgeAssetSwm: async () => undefined };
    agent.publishFromSharedMemory = publish; agent.update = publish;
    const result = await agent.publishFromFinalizedAssertion(CG, NAME, { agentAddress: AUTHOR });
    expect(result).toMatchObject({ status: 'tentative', ual: PUBLISHED }); expect(result.lifecycleRepairPending).toBeUndefined(); expect(publish).toHaveBeenCalledOnce();
    const rows = await store.query(`SELECT ?p ?o WHERE { GRAPH <${META}> { <${LIFECYCLE}> ?p ?o } }`);
    if (rows.type !== 'bindings') throw new Error('Expected projection rows');
    const values = Object.fromEntries(rows.bindings.map(row => [row.p, row.o]));
    expect(values[`${DKG}vmCurrentAssertion`]).toBe(JSON.stringify(HEX.slice(2))); expect(values[`${DKG}wmCurrentAssertion`]).toBeUndefined();
    expect(values[`${DKG}state`]).toBe('"published"'); expect(values[`${DKG}memoryLayer`]).toBe('"VM"'); expect(values[`${DKG}assertionGraph`]).toBe(swm);
    if (version === 2) expect(values['http://www.w3.org/ns/prov#wasRevisionOf']).toBe(`${LIFECYCLE}#assertion-${PRIOR}`);
    expect(agent.namedKaVmLifecycleRepair).toBeUndefined();
  });
});
