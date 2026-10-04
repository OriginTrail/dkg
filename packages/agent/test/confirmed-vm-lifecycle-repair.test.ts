import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { assertionLifecycleUri, buildAssertionSealQuads, contextGraphAssertionUri, contextGraphMetaUri,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, TypedEventBus, generateEd25519Keypair, parseAssertionSealQuads } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { ChangelogStore, GraphSetIndexStore, OxigraphStore, SparqlHttpStore, StoreOperationTimeoutError, UnsupportedTripleStoreCapabilityError, type Quad } from '@origintrail-official/dkg-storage';
import { computeFlatKCRootV10, DKGPublisher, TripleStoreAsyncLiftPublisher,
  type KnowledgeAssetVmPublishRequest } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/dkg-agent.js';
import { GossipSession } from '../src/gossip-session.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';
import { createKnowledgeAssetVmPublishIntentKey } from '../src/dkg-agent-publish.js';
import { NamedKaVmLifecycleRepair, type ConfirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-repair.js';
import { decodeLifecycleRepairJournal, lifecycleRepairKey, normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { applyPublishedNamedKaVmLifecycle, applyTentativeNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const CG = 'confirmed-lifecycle-repair', NAME = 'repair-asset', UAL = `did:dkg:mock:31337/${AUTHOR}/1`;
const PACKED = (BigInt(AUTHOR) << 96n) | 1n, PUBLISHED = 'did:dkg:mock:31337/0x2222222222222222222222222222222222222222/1';
const DKG = 'http://dkg.io/ontology/', PRIOR = 'ab'.repeat(32);
const QUADS = [{ subject: 'urn:repair:entity', predicate: 'http://schema.org/name', object: '"Confirmed"', graph: '' }];
const ROOT = computeFlatKCRootV10(QUADS, []), HEX = ethers.hexlify(ROOT);
const META = contextGraphMetaUri(CG), LIFECYCLE = assertionLifecycleUri(CG, AUTHOR, NAME), ASSERTION = contextGraphAssertionUri(CG, AUTHOR, NAME);
const dirs: string[] = [];
const stores: OxigraphStore[] = [];
const flushBarrier = vi.hoisted(() => ({ path: null as string | null, captured: null as (() => void) | null,
  release: null as Promise<void> | null, fail: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]) === flushBarrier.path && args[1] === 'w') {
      flushBarrier.captured?.();
      await flushBarrier.release;
      if (flushBarrier.fail) throw Object.assign(new Error('snapshot persistence failed'), { code: 'EIO' });
    }
    return actual.open(...args);
  } };
});
afterEach(async () => { flushBarrier.path = null; flushBarrier.captured = null; flushBarrier.release = null; flushBarrier.fail = false;
  vi.restoreAllMocks(); for (const store of new Set(stores.splice(0))) await store.close().catch(() => undefined); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
class FaultStore extends OxigraphStore {
  armed = false;
  constructor(path: string, readonly predicate: string, readonly operation: 'insert' | 'delete') { super(path); Object.defineProperty(this, 'atomicUpdate', { value: undefined }); }
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
async function persistentStore(): Promise<OxigraphStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-confirmed-store-')); dirs.push(dir);
  const store = new OxigraphStore(join(dir, 'store.nq')); stores.push(store);
  return store;
}
function agentFor(store: OxigraphStore, dir: string, version: number) {
  stores.push(store);
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.defineProperty(agent, 'peerId', { value: 'peer-lifecycle-repair' });
  agent.defaultAgentAddress = AUTHOR; agent.config = { dataDir: dir }; agent.store = store;
  agent.writeLocks = new Map<string, Promise<void>>();
  agent.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  agent.chain = { readKnowledgeAssetVersionSnapshot: vi.fn(async () => ({ latestRoot: HEX, rootCount: BigInt(version) })) };
  agent.createV10ACKProvider = () => undefined;
  agent._resolveEncryptInlinePayload = async () => undefined; agent._resolveEncryptInlineChunked = async () => undefined;
  agent._buildPrecomputedUpdateAttestationForSeal = async () => ({});
  agent.afterConfirmedGraphScopedVmPublishV1 = async () => undefined;
  agent.gossipSession = new GossipSession();
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
        const repair = restarted.getOrCreateNamedKaVmLifecycleRepair?.() ?? new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, now: () => now,
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
    const create = () => new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, now: () => now, apply, isCurrent: async () => true, warn: () => undefined });
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
      const repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), now: () => now, apply, isCurrent: async () => true, warn: () => undefined });
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
    const repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), apply, isCurrent: async () => false, warn: () => undefined });
    expect(await repair.submit(input)).toBe('superseded'); expect(apply).not.toHaveBeenCalled(); await repair.stop();
    const pending = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), apply: async () => { throw new Error('RPC unavailable'); }, isCurrent: async () => true, warn: () => undefined });
    await pending.submit(input);
    await expect(pending.submit({ ...input, merkleRoot: PRIOR })).rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_REPAIR_INTEGRITY' });
    await pending.stop();
  });
  it('retains a divergent newer workspace while repairing the confirmed VM descriptor', async () => {
    const store = await persistentStore();
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
    const store = await persistentStore(), agent = agentFor(store, dir, 2);
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
  it.each(['raw', 'agent-facade'] as const)('retains %s repair evidence across a failed snapshot and abrupt reopen, then durably retires it', async facade => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-crash-stamp-')), crashDir = await mkdtemp(join(tmpdir(), 'dkg-crash-reopen-'));
    dirs.push(dir, crashDir);
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const path = join(dir, 'store.nq'), store = new OxigraphStore(path), agent = agentFor(store, dir, 1);
    if (facade === 'agent-facade') agent.store = createListContextGraphsCacheInvalidatingStore(store, vi.fn(), vi.fn());
    await store.insert([{ subject: LIFECYCLE, predicate: `${DKG}state`, object: '"shared"', graph: META }]);
    await store.flush();
    let entered!: () => void, release!: () => void;
    const captured = new Promise<void>(resolve => { entered = resolve; });
    const flush = vi.spyOn(store, 'flush');
    flushBarrier.path = `${path}.tmp`; flushBarrier.captured = entered;
    flushBarrier.release = new Promise<void>(resolve => { release = resolve; }); flushBarrier.fail = true;
    const publish = vi.fn(); agent.publisher = { publish, writeLocks: agent.writeLocks };
    const repairing = agent._repairConfirmedNamedKaVmLifecycle(input);
    try {
      await captured;
      // The stamp is visible in memory while the captured disk snapshot is held.
      expect(await store.query(`ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}state> "published" } }`)).toMatchObject({ value: true });
    } finally { release(); }
    expect(await repairing).toBe(true);
    expect(flush).toHaveBeenCalledWith({ source: 'agent.publish.confirmedLifecycleFlush' });
    const journalPath = join(dir, 'named-ka-vm-lifecycle-repairs.json');
    expect(decodeLifecycleRepairJournal(JSON.parse(await readFile(journalPath, 'utf8'))).size).toBe(1);
    // Copy only durable bytes, without closing the store or stopping the agent.
    const crashPath = join(crashDir, 'store.nq');
    await copyFile(path, crashPath); await copyFile(journalPath, join(crashDir, 'named-ka-vm-lifecycle-repairs.json'));
    flushBarrier.path = null;
    const reopened = new OxigraphStore(crashPath), fresh = agentFor(reopened, crashDir, 1);
    if (facade === 'agent-facade') fresh.store = createListContextGraphsCacheInvalidatingStore(reopened, vi.fn(), vi.fn());
    fresh.publisher = { publish, writeLocks: fresh.writeLocks };
    expect(await reopened.query(`ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}state> "published" } }`)).toMatchObject({ value: false });
    now += 6_000; await fresh.getOrCreateNamedKaVmLifecycleRepair().runDue();
    expect(decodeLifecycleRepairJournal(JSON.parse(await readFile(join(crashDir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'))).size).toBe(0);
    // Reopen again immediately after retirement, still without any graceful flush.
    const durable = new OxigraphStore(crashPath); stores.push(durable);
    expect(await durable.query(`ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}state> "published" ; <${DKG}vmCurrentAssertion> "${HEX.slice(2)}" ; <${DKG}publishedUal> ${JSON.stringify(PUBLISHED)} } }`)).toMatchObject({ value: true });
    expect(publish).not.toHaveBeenCalled();
    await fresh.namedKaVmLifecycleRepair.stop(); await agent.namedKaVmLifecycleRepair.stop();
  });
  it.each(['raw', 'agent-facade', 'decorated'] as const)('retains the journal when the %s backend cannot certify durable completion', async facade => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-uncertified-stamp-')); dirs.push(dir);
    const store = await persistentStore(), agent = agentFor(store, dir, 1);
    Object.defineProperty(store, 'persist', { value: undefined, configurable: true });
    const wrapped = facade === 'decorated' ? new ChangelogStore(new GraphSetIndexStore(store)) : store;
    agent.store = facade === 'raw' ? wrapped : createListContextGraphsCacheInvalidatingStore(wrapped, vi.fn(), vi.fn());
    const commit = vi.spyOn(store, 'atomicUpdate');
    expect(await agent._repairConfirmedNamedKaVmLifecycle(input)).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    const journal = decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')));
    expect([...journal.values()]).toMatchObject([{ input: { publishedUal: PUBLISHED }, attempts: 1, rejected: false }]);
    await agent.namedKaVmLifecycleRepair.stop();
  });
  it.each([false, true])('preserves a reopened unsealed WM draft with matching pointer=%s', async (matchingPointer) => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-open-wm-repair-')); dirs.push(dir);
    const store = await persistentStore(); stores.push(store);
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
    const repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, now: () => now, isCurrent: async () => true, warn: () => undefined,
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
  it.each(['matching-pointers', 'divergent-seal', 'reopened-draft', 'tentative-prior'] as const)('decodes canonical escaped RDF workspace values for %s', async scenario => {
    const store = await persistentStore(); stores.push(store);
    const reopened = scenario === 'reopened-draft', tentative = scenario === 'tentative-prior';
    const preserve = reopened || scenario === 'divergent-seal';
    const rows = {
      state: reopened ? 'created' : 'shared', layer: reopened ? 'WM' : 'SWM',
      ...(!reopened ? { wm: tentative ? PRIOR : HEX.slice(2), swm: HEX.slice(2), activeSeal: scenario === 'divergent-seal' ? PRIOR : HEX.slice(2) } : {}),
    };
    await store.insert(Object.entries(rows).map(([key, value]) => ({ subject: key === 'activeSeal' ? ASSERTION : LIFECYCLE,
      predicate: key === 'activeSeal' ? 'http://dkg.io/ontology/assertionMerkleRoot' : `${DKG}${({ wm: 'wmCurrentAssertion', swm: 'swmCurrentAssertion', layer: 'memoryLayer' } as Record<string, string>)[key] ?? key}`,
      object: JSON.stringify(value), graph: META })));
    const query = store.query.bind(store);
    const encoded = (value: string) => '"' + '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0') + value.slice(1) + '"^^<http://www.w3.org/2001/XMLSchema#string>';
    vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      if (options?.source === 'agent.publish.confirmedLifecycleWorkspaceGuard') return {
        type: 'bindings', bindings: [Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, encoded(value)]))],
      };
      return query(sparql, options);
    });
    if (tentative) await applyTentativeNamedKaVmLifecycle(store, { ...input, tentative: true, priorMerkleRoot: PRIOR });
    else await applyPublishedNamedKaVmLifecycle(store, input);
    const result = await query(`SELECT ?state ?layer ?wm WHERE { GRAPH <${META}> {
      <${LIFECYCLE}> <${DKG}state> ?state ; <${DKG}memoryLayer> ?layer .
      OPTIONAL { <${LIFECYCLE}> <${DKG}wmCurrentAssertion> ?wm }
    } }`);
    expect(result).toMatchObject({ bindings: [{ state: JSON.stringify(preserve ? rows.state : 'published'), layer: JSON.stringify(preserve ? rows.layer : 'VM') }] });
    if (result.type !== 'bindings') throw new Error('Expected bindings');
    expect(result.bindings[0].wm).toBe(preserve && !reopened ? JSON.stringify(HEX.slice(2)) : undefined);
  });

  const metadataRows = (): Quad[] => [
    { subject: LIFECYCLE, predicate: `${DKG}vmCurrentAssertion`, object: JSON.stringify(PRIOR), graph: META },
    { subject: LIFECYCLE, predicate: `${DKG}wmCurrentAssertion`, object: JSON.stringify(HEX.slice(2)), graph: META },
    { subject: LIFECYCLE, predicate: `${DKG}state`, object: '"shared"', graph: META },
    { subject: LIFECYCLE, predicate: `${DKG}memoryLayer`, object: '"SWM"', graph: META },
    { subject: ASSERTION, predicate: `${DKG}memoryLayer`, object: '"SWM"', graph: META },
    { subject: LIFECYCLE, predicate: `${DKG}state`, object: '"unrelated graph"', graph: 'urn:unrelated:metadata' },
  ];
  const metadataSnapshot = (store: OxigraphStore) => store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');

  it.each(['raw', 'agent-facade'] as const)('retires the journal after an explicitly durable remote acknowledgement through %s', async facade => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-durable-remote-stamp-')); dirs.push(dir);
    const path = join(dir, 'remote.nq'), backing = new OxigraphStore(path), agent = agentFor(backing, dir, 1);
    await backing.insert(metadataRows()); await backing.flush();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = String(init?.body);
      if (body.startsWith('SELECT')) return Response.json({ head: { vars: ['wm', 'state', 'layer'] }, results: { bindings: [{
        wm: { type: 'literal', value: HEX.slice(2) }, state: { type: 'literal', value: 'shared' }, layer: { type: 'literal', value: 'SWM' },
      }] } });
      await backing.atomicUpdate(body); await backing.flush(); // Endpoint contract: acknowledgement follows durable commit.
      return new Response(null, { status: 204 });
    });
    const remote = new SparqlHttpStore({ queryEndpoint: 'http://durable-remote.test/sparql', consistencyProfile: 'atomic-update', writesDurableOnAcknowledgement: true });
    agent.store = facade === 'raw' ? remote : createListContextGraphsCacheInvalidatingStore(remote, vi.fn(), vi.fn());
    try {
      expect(agent.store.writesDurableOnAcknowledgement).toBe(true); expect(agent.store.flush).toBeUndefined();
      expect(await agent._repairConfirmedNamedKaVmLifecycle(input)).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
      expect(decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'))).size).toBe(0);
      const reopened = new OxigraphStore(path); stores.push(reopened);
      expect(await reopened.query(`ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}state> "published" ; <${DKG}vmCurrentAssertion> "${HEX.slice(2)}" } }`)).toMatchObject({ value: true });
    } finally { await agent.namedKaVmLifecycleRepair?.stop(); await remote.close(); }
  });

  it('does not infer remote persistence from atomicity and readback guarantees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-uncertified-remote-stamp-')); dirs.push(dir);
    const agent = agentFor(await persistentStore(), dir, 1), fetch = vi.spyOn(globalThis, 'fetch');
    const remote = new SparqlHttpStore({ queryEndpoint: 'http://uncertified-remote.test/sparql', consistencyProfile: 'atomic-readback' });
    agent.store = createListContextGraphsCacheInvalidatingStore(remote, vi.fn(), vi.fn());
    try {
      expect(agent.store.writesDurableOnAcknowledgement).toBe(false);
      expect(await agent._repairConfirmedNamedKaVmLifecycle(input)).toBe(true); expect(fetch).not.toHaveBeenCalled();
      expect(decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'))).size).toBe(1);
    } finally { await agent.namedKaVmLifecycleRepair?.stop(); await remote.close(); }
  });

  it('commits once through the production agent wrapper without separate lifecycle writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-wrapped-atomic-repair-')); dirs.push(dir);
    const store = await persistentStore(), agent = agentFor(store, dir, 1);
    await store.insert(metadataRows());
    const commit = vi.spyOn(store, 'atomicUpdate'), insert = vi.spyOn(store, 'insert');
    const remove = vi.spyOn(store, 'deleteByPattern'), removeWithoutCount = vi.spyOn(store, 'deleteByPatternWithoutCount');
    const invalidate = vi.fn(), dirty = vi.fn();
    agent.store = createListContextGraphsCacheInvalidatingStore(store, invalidate, dirty);
    try {
      expect(await agent._repairConfirmedNamedKaVmLifecycle({ ...input, priorMerkleRoot: PRIOR })).toBe(false);
      expect(commit).toHaveBeenCalledTimes(1); expect(insert).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled(); expect(removeWithoutCount).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledTimes(1); expect(dirty).toHaveBeenCalledTimes(1);
      expect(await store.query(`ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}state> "published" ; <${DKG}vmCurrentAssertion> "${HEX.slice(2)}" } }`)).toMatchObject({ value: true });
    } finally { await agent.namedKaVmLifecycleRepair.stop(); }
  });

  it('propagates a wrapped atomic execution failure without falling back or exposing partial metadata', async () => {
    const store = await persistentStore(); stores.push(store); await store.insert(metadataRows());
    const before = await metadataSnapshot(store), failure = new Error('atomic execution failed');
    const commit = vi.spyOn(store, 'atomicUpdate').mockRejectedValue(failure);
    const insert = vi.spyOn(store, 'insert'), remove = vi.spyOn(store, 'deleteByPattern');
    const removeWithoutCount = vi.spyOn(store, 'deleteByPatternWithoutCount');
    const invalidate = vi.fn(), dirty = vi.fn();
    const wrapped = createListContextGraphsCacheInvalidatingStore(store, invalidate, dirty);
    await expect(applyPublishedNamedKaVmLifecycle(wrapped, { ...input, priorMerkleRoot: PRIOR })).rejects.toBe(failure);
    expect(commit).toHaveBeenCalledTimes(1); expect(insert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled(); expect(removeWithoutCount).not.toHaveBeenCalled();
    expect(await metadataSnapshot(store)).toEqual(before);
    // An unclassified response could have followed a commit, so invalidate conservatively.
    expect(invalidate).toHaveBeenCalledTimes(1); expect(dirty).toHaveBeenCalledTimes(1);
    commit.mockRejectedValue(new StoreOperationTimeoutError({ backend: 'managed-oxigraph', operation: 'update', outcome: 'not_started' }));
    await expect(applyPublishedNamedKaVmLifecycle(wrapped, input)).rejects.toBeInstanceOf(StoreOperationTimeoutError);
    expect(invalidate).toHaveBeenCalledTimes(1); expect(dirty).toHaveBeenCalledTimes(1);
    expect(await metadataSnapshot(store)).toEqual(before);
  });

  it('produces identical graph-scoped metadata on atomic and both compatibility stores', async () => {
    const snapshots = [];
    for (const capability of ['atomic', 'absent', 'typed-refusal'] as const) {
      const store = await persistentStore(); stores.push(store); await store.insert(metadataRows());
      if (capability !== 'atomic') Object.defineProperty(store, 'atomicUpdate', { value: capability === 'absent'
        ? undefined : async () => { throw new UnsupportedTripleStoreCapabilityError('atomicUpdate', 'legacy-test-store'); } });
      const wrapped = createListContextGraphsCacheInvalidatingStore(store, vi.fn(), vi.fn());
      await applyPublishedNamedKaVmLifecycle(wrapped, { ...input, priorMerkleRoot: PRIOR });
      snapshots.push(await metadataSnapshot(store));
    }
    expect(snapshots[1]).toEqual(snapshots[0]); expect(snapshots[2]).toEqual(snapshots[0]);
    expect(snapshots[0]).toMatchObject({ type: 'bindings', bindings: expect.arrayContaining([
      { g: 'urn:unrelated:metadata', s: LIFECYCLE, p: `${DKG}state`, o: '"unrelated graph"' },
      { g: META, s: LIFECYCLE, p: `${DKG}state`, o: '"published"' },
      { g: META, s: LIFECYCLE, p: 'http://www.w3.org/ns/prov#wasRevisionOf', o: `${LIFECYCLE}#assertion-${PRIOR}` },
    ]) });
  });

  it('commits the planned metadata atomically and leaves every row unchanged on commit failure', async () => {
    const store = await persistentStore(); stores.push(store);
    await store.insert([
      { subject: LIFECYCLE, predicate: `${DKG}vmCurrentAssertion`, object: JSON.stringify(PRIOR), graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}wmCurrentAssertion`, object: JSON.stringify(HEX.slice(2)), graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}state`, object: '"shared"', graph: META },
      { subject: LIFECYCLE, predicate: `${DKG}memoryLayer`, object: '"SWM"', graph: META },
      { subject: ASSERTION, predicate: `${DKG}memoryLayer`, object: '"SWM"', graph: META },
    ]);
    const snapshot = () => store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${META}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`);
    const before = await snapshot();
    const commit = vi.fn(async () => { throw new StoreOperationTimeoutError({ backend: 'managed-oxigraph', operation: 'update', outcome: 'not_started' }); });
    Object.defineProperty(store, 'atomicUpdate', { value: commit, configurable: true });
    await expect(applyPublishedNamedKaVmLifecycle(store, { ...input, priorMerkleRoot: PRIOR })).rejects.toThrow();
    expect(commit).toHaveBeenCalledTimes(1); expect(await snapshot()).toEqual(before);
    Object.defineProperty(store, 'atomicUpdate', { value: async (sparql: string) => store.update(sparql), configurable: true });
    await applyPublishedNamedKaVmLifecycle(store, { ...input, priorMerkleRoot: PRIOR });
    expect(await snapshot()).not.toEqual(before);
    expect(await store.query(`ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}vmCurrentAssertion> "${HEX.slice(2)}" ; <${DKG}state> "published" } }`)).toMatchObject({ value: true });
  });

  it.each(['absent', 'typed-refusal'] as const)('uses explicit compatibility repair when atomic capability is %s', async capability => {
    const store = await persistentStore(); stores.push(store);
    const atomic = capability === 'absent' ? undefined : vi.fn(async () => { throw new UnsupportedTripleStoreCapabilityError('atomicUpdate', 'legacy-test-store'); });
    Object.defineProperty(store, 'atomicUpdate', { value: atomic });
    const update = vi.spyOn(store, 'update').mockRejectedValue(new Error('generic UPDATE is not atomic certification'));
    await applyPublishedNamedKaVmLifecycle(store, input);
    expect(update).not.toHaveBeenCalled();
    if (atomic) expect(atomic).toHaveBeenCalledTimes(1);
    expect(await store.query(`ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}state> "published" ; <${DKG}vmCurrentAssertion> "${HEX.slice(2)}" } }`)).toMatchObject({ value: true });
  });

  it('uses the real publisher lifecycle lock while repair is paused after its workspace read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-overlapping-wm-repair-')); dirs.push(dir);
    const store = await persistentStore(), agent = agentFor(store, dir, 1);
    const scope = createGraphKnowledgeAssetScope(UAL, 1), vmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope);
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
    const publisher = new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
    agent.publisher = publisher; agent.writeLocks = publisher.writeLocks;
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const query = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      const result = await query(sparql, options);
      if (options?.source === 'agent.publish.confirmedLifecycleWorkspaceGuard') { entered(); await held; }
      return result;
    });
    const repairing = agent._repairConfirmedNamedKaVmLifecycle(input); await started;
    let mutationFinished = false;
    const editing = publisher.assertionPullFrom(CG, NAME, AUTHOR, 'vm').then(async () => {
      await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:overlap:draft', predicate: 'urn:text', object: '"editable"', graph: '' }]);
      mutationFinished = true;
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally { release(); }
    const finishedWhileHeld = mutationFinished;
    await repairing; await editing;
    expect(finishedWhileHeld).toBe(false);
    const wmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.WorkingMemory, scope);
    expect(await query(`ASK { GRAPH <${META}> { <${LIFECYCLE}> <${DKG}state> "created" ; <${DKG}memoryLayer> "WM" ; <${DKG}assertionGraph> <${wmGraph}> } }`)).toMatchObject({ value: true });
    await publisher.assertionWrite(CG, NAME, AUTHOR, [{ subject: 'urn:overlap:next', predicate: 'urn:text', object: '"still editable"', graph: '' }]);
    expect(await store.countQuads(wmGraph)).toBe(3);
    await agent.namedKaVmLifecycleRepair.stop();
  });

  it('admits B durably while unrelated A is held in a repair attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-parallel-admission-')); dirs.push(dir);
    let release!: () => void, entered!: () => void, bEntered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; }), bStarted = new Promise<void>(resolve => { bEntered = resolve; });
    const repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, isCurrent: async () => true, warn: () => undefined,
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
      const path = join(dir, 'named-ka-vm-lifecycle-repairs.json'), bytes = await readFile(path, 'utf8');
      const journal = decodeLifecycleRepairJournal(JSON.parse(bytes));
      expect(bytes).toBe(JSON.stringify(JSON.parse(bytes)));
      expect(await readdir(dir)).toEqual(['named-ka-vm-lifecycle-repairs.json']);
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600 & ~process.umask());
      expect([...journal.values()]).toMatchObject([{ input: { name: NAME, merkleRoot: HEX.slice(2), assertionVersion: '1' }, attempts: 0 }]);
    });
    const repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, apply, isCurrent: async () => true, warn: () => undefined });
    expect(await repair.submit(input)).toBe('repaired'); expect(apply).toHaveBeenCalledOnce(); await repair.stop();
  });
  it('does not apply after failed durable admission and preserves confirmed evidence in the agent error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-failed-admission-')); dirs.push(dir);
    const apply = vi.fn(async () => undefined), repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, apply, isCurrent: async () => true, warn: () => undefined });
    const persist = vi.spyOn(repair as unknown as { persist: () => Promise<void> }, 'persist').mockRejectedValueOnce(Object.assign(new Error('journal fsync failed'), { code: 'EIO' }));
    const store = await persistentStore(), agent = agentFor(store, dir, 1); agent.namedKaVmLifecycleRepair = repair;
    const seal = parseAssertionSealQuads(buildAssertionSealQuads({ assertionUri: ASSERTION, metaGraph: META,
      merkleRoot: ROOT, authorAddress: AUTHOR, authorAttestationR: new Uint8Array(32).fill(1),
      authorAttestationVS: new Uint8Array(32).fill(2), authorSchemeVersion: 1, chainId: 31337n,
      kav10Address: AUTHOR, reservedKaId: PACKED, finalizedAtIso: new Date().toISOString(),
      contentScopeVersion: 2, kaUal: UAL, assertionVersion: 1, publicTripleCount: 1, privateTripleCount: 0 }), ASSERTION)!;
    const confirmedPublication = { status: 'confirmed' as const, ual: PUBLISHED, kaId: PACKED, merkleRoot: ROOT,
      kaManifest: [], assertionUri: ASSERTION, seal };
    await expect(agent._repairConfirmedNamedKaVmLifecycle(input, confirmedPublication)).rejects.toMatchObject({ code: 'KA_VM_LIFECYCLE_REPAIR_REQUIRED', publishedUal: PUBLISHED, merkleRoot: HEX, assertionVersion: '1' });
    expect(persist).toHaveBeenCalledOnce(); expect(apply).not.toHaveBeenCalled(); await repair.stop();
  });
  it('round-trips canonical version-2 journal entries and retry state', () => {
    const normalized = normalizeLifecycleRepairInput({ ...input, merkleRoot: HEX.toUpperCase().replace('0X', '0x'), priorMerkleRoot: `0x${PRIOR.toUpperCase()}` }, true), key = lifecycleRepairKey(normalized);
    const decoded = decodeLifecycleRepairJournal({ version: 2, entries: [[key, { input: normalized, attempts: 2, nextAttemptAt: 6_000, rejected: false, lastError: 'timeout' }]] });
    expect(decoded.get(key)).toEqual({ input: { ...normalized, merkleRoot: HEX.slice(2), priorMerkleRoot: PRIOR }, attempts: 2, nextAttemptAt: 6_000, rejected: false, lastError: 'timeout' });
  });
  it('keeps peer case identities independent through durable retry and restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-peer-identity-repair-')); dirs.push(dir);
    let now = 1_000;
    const fail = vi.fn(async () => { throw new Error('temporary store failure'); });
    const repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, now: () => now, apply: fail, isCurrent: async () => true, warn: () => undefined });
    for (const agentAddress of ['PeerABC', 'peerabc']) await repair.submit({ ...input, agentAddress });
    const file = join(dir, 'named-ka-vm-lifecycle-repairs.json');
    const journal = decodeLifecycleRepairJournal(JSON.parse(await readFile(file, 'utf8')));
    expect(journal.size).toBe(2); expect(new Set([...journal.values()].map(entry => entry.input.agentAddress))).toEqual(new Set(['PeerABC', 'peerabc']));
    await repair.stop(); now = 6_000;
    const apply = vi.fn(async (_input: ConfirmedNamedKaVmLifecycleInput) => undefined), fresh = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, now: () => now, apply, isCurrent: async () => true, warn: () => undefined });
    await fresh.runDue(); expect(new Set(apply.mock.calls.map(call => call[0].agentAddress))).toEqual(new Set(['PeerABC', 'peerabc']));
    await fresh.stop();
  });
  it('selects versions across equivalent EVM identities and migrates historical journal keys', async () => {
    const mixed = `0x${'aB'.repeat(20)}`, lower = mixed.toLowerCase();
    const dir = await mkdtemp(join(tmpdir(), 'dkg-evm-identity-repair-')); dirs.push(dir);
    const apply = vi.fn(async () => { throw new Error('temporary store failure'); });
    const repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, now: () => 1_000, apply, isCurrent: async () => true, warn: () => undefined });
    await repair.submit({ ...input, agentAddress: mixed });
    await repair.submit({ ...input, agentAddress: lower, assertionVersion: '2' });
    expect(await repair.submit({ ...input, agentAddress: mixed })).toBe('superseded');
    const journal = decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')));
    expect([...journal.values()]).toMatchObject([{ input: { agentAddress: lower, assertionVersion: '2' } }]);
    await repair.stop();
    const normalized = normalizeLifecycleRepairInput({ ...input, agentAddress: mixed }, true);
    const historical = createHash('sha256').update(JSON.stringify([CG, lower, NAME, ''])).digest('hex');
    await writeFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), JSON.stringify({ version: 1, entries: [[historical, { input: normalized, attempts: 2, nextAttemptAt: 6_000 }]] }));
    const migrated = decodeLifecycleRepairJournal(JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')));
    expect(migrated.get(lifecycleRepairKey(normalized))).toMatchObject({ input: normalized, attempts: 2, nextAttemptAt: 6_000 });
    const freshApply = vi.fn(async (_input: ConfirmedNamedKaVmLifecycleInput) => { throw new Error('retry remains pending'); });
    const fresh = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: dir, now: () => 6_000, apply: freshApply, isCurrent: async () => true, warn: () => undefined });
    await fresh.runDue(); expect(freshApply).toHaveBeenCalledWith({ ...normalized, packedKaId: PACKED });
    const rewritten = JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
    expect(rewritten.version).toBe(2); expect(decodeLifecycleRepairJournal(rewritten).get(lifecycleRepairKey(normalized))).toMatchObject({ attempts: 3 });
    await fresh.stop();
  });
  it.each([1, 2])('rejects mismatched and duplicate version-%s journal identities before migration', version => {
    const normalized = normalizeLifecycleRepairInput(input, true);
    const historical = createHash('sha256').update(JSON.stringify([CG, AUTHOR, NAME, ''])).digest('hex');
    const key = version === 1 ? historical : lifecycleRepairKey(normalized);
    const entry = { input: normalized, attempts: 0, nextAttemptAt: 0 };
    expect(() => decodeLifecycleRepairJournal({ version, entries: [['bad-key', entry]] })).toThrow('Invalid confirmed named KA lifecycle repair evidence');
    expect(() => decodeLifecycleRepairJournal({ version, entries: [[key, entry], [key, entry]] })).toThrow('Invalid confirmed named KA lifecycle repair evidence');
  });
  it('migrates a historical peer key while preserving its case-sensitive identity', () => {
    const normalized = normalizeLifecycleRepairInput({ ...input, agentAddress: 'PeerABC' }, true);
    const historical = createHash('sha256').update(JSON.stringify([CG, 'peerabc', NAME, ''])).digest('hex');
    const entry = { input: normalized, attempts: 2, nextAttemptAt: 6_000 };
    const journal = decodeLifecycleRepairJournal({ version: 1, entries: [[historical, entry]] });
    expect(journal.get(lifecycleRepairKey(normalized))).toEqual(entry);
    expect(journal.has(lifecycleRepairKey({ ...normalized, agentAddress: 'peerabc' }))).toBe(false);
    // Historical key collisions are corruption, not permission to merge two principals.
    expect(() => decodeLifecycleRepairJournal({ version: 1, entries: [[historical, entry], [historical, { ...entry, input: { ...normalized, agentAddress: 'peerabc' } }]] })).toThrow('Invalid confirmed named KA lifecycle repair evidence');
  });
  it.each(['contextGraphId', 'agentAddress', 'name', 'publishedUal', 'merkleRoot', 'assertionVersion', 'packedKaId', 'subGraphName', 'priorMerkleRoot'])('rejects non-string journal field %s', (field) => {
    const normalized = normalizeLifecycleRepairInput(input, true), key = lifecycleRepairKey(normalized);
    expect(() => decodeLifecycleRepairJournal({ version: 2, entries: [[key, { input: { ...normalized, [field]: 123 }, attempts: 0, nextAttemptAt: 0 }]] })).toThrow('Invalid confirmed named KA lifecycle repair evidence');
  });
});

describe('tentative normal publication projection', () => {
  it.each([1, 2])('centralizes tentative mint/update version %s without claiming a VM data graph', async (version) => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-tentative-projection-')); dirs.push(dir);
    const store = await persistentStore(), scope = createGraphKnowledgeAssetScope(UAL, version), swm = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
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
