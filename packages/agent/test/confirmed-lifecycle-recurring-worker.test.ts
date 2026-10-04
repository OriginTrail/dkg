import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/dkg-agent.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { confirmedLifecycleRecoveryFixture } from './_helpers/confirmed-lifecycle-recovery-fixture.js';
import { assertionLifecycleUri, buildAssertionSealQuads, contextGraphAssertionUri,
  contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
const dirs: string[] = [], stores: OxigraphStore[] = [], owners: NamedKaVmLifecycleRepair[] = [];
afterEach(async () => { vi.useRealTimers(); for (const owner of owners.splice(0)) await owner.stop();
  for (const store of stores.splice(0)) await store.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('confirmed lifecycle recurring worker ownership', () => {
  it('completes a confirmed process-local pending repair after same-instance stop/start without publishing again', async () => {
    const chain = new MockChainAdapter();
    const agent = await DKGAgent.create({ name: 'ProcessLocalRepairRestart', nodeRole: 'edge',
      listenHost: '127.0.0.1', listenPort: 0, chainAdapter: chain });
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { input, publication } = confirmedLifecycleRecoveryFixture();
    const data = [{ subject: 'urn:restart:entity', predicate: 'http://schema.org/name', object: '"Pending"', graph: '' }];
    const root = computeFlatKCRootV10(data, []), rootHex = ethers.hexlify(root);
    const scope = createGraphKnowledgeAssetScope(input.publishedUal, 1);
    const packed = (BigInt(input.agentAddress) << 96n) | 1n;
    const meta = contextGraphMetaUri(input.contextGraphId);
    const lifecycle = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name);
    const assertion = contextGraphAssertionUri(input.contextGraphId, input.agentAddress, input.name);
    const deployment = await chain.getKnowledgeAssetsLifecycleAddress();
    const internals = agent as unknown as { namedKaVmLifecycleRepair?: NamedKaVmLifecycleRepair; config: { dataDir?: string } };
    try {
      await agent.start(); expect(internals.config.dataDir).toBeUndefined();
      await agent.store.insert([
        ...data.map(quad => ({ ...quad, graph: knowledgeAssetLayerGraphUri(input.contextGraphId, MemoryLayer.SharedWorkingMemory, scope) })),
        ...buildAssertionSealQuads({ ...publication.seal, assertionUri: assertion, metaGraph: meta,
          merkleRoot: root, kav10Address: deployment, reservedKaId: packed, kaUal: input.publishedUal }),
        { graph: meta, subject: lifecycle, predicate: 'http://dkg.io/ontology/kaId', object: '"1"' },
        { graph: meta, subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"shared"' },
        { graph: meta, subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"SWM"' },
      ]);
      vi.spyOn(agent.publisher, 'hasSwmShareComplete').mockResolvedValue(true);
      vi.spyOn(chain, 'readKnowledgeAssetVersionSnapshot').mockResolvedValue({ latestRoot: rootHex, rootCount: 1n });
      // Control confirmation only; lifecycle recovery still uses the real owner and memory store.
      const publish = vi.spyOn(agent, 'publishFromSharedMemory').mockResolvedValue({ ...publication, merkleRoot: root, kaId: packed });
      const mint = vi.spyOn(agent.publisher, 'publish'), update = vi.spyOn(agent.publisher, 'update');
      const mutate = agent.store.atomicUpdate!.bind(agent.store);
      let failing = true;
      const writes = vi.spyOn(agent.store, 'atomicUpdate').mockImplementation(async (sparql, options) => {
        if (failing && options?.source === 'agent.publish.confirmedLifecycleCommit') {
          throw new StoreOperationTimeoutError({ backend: 'oxigraph', operation: 'atomicUpdate', outcome: 'not_started' });
        }
        return mutate(sparql, options);
      });
      await expect(agent.publishFromFinalizedAssertion(input.contextGraphId, input.name, { agentAddress: input.agentAddress })).rejects.toMatchObject({
        code: 'KA_VM_LIFECYCLE_REPAIR_REQUIRED', repairAdmission: 'pending',
        confirmedPublication: { status: 'confirmed', ual: input.publishedUal, merkleRoot: root },
        lifecycleRecovery: { publishedUal: input.publishedUal, publicationRetrySafe: false },
      });
      expect(publish).toHaveBeenCalledOnce();
      const owner = agent.getOrCreateNamedKaVmLifecycleRepair();
      const committed = () => agent.store.query(`ASK { GRAPH <${meta}> { <${lifecycle}>
        <http://dkg.io/ontology/vmCurrentAssertion> "${rootHex.slice(2)}" ;
        <http://dkg.io/ontology/state> "published" ;
        <http://dkg.io/ontology/publishedUal> ${JSON.stringify(input.publishedUal)} } }`);
      expect(await committed()).toMatchObject({ value: false });
      const attempts = () => writes.mock.calls.filter(([, options]) => options?.source === 'agent.publish.confirmedLifecycleCommit').length;
      await owner.runDue(); expect(attempts()).toBe(1); // The original retry deadline remains authoritative.
      await agent.stop(); now += 6_000; failing = false;
      await owner.runDue(); expect(attempts()).toBe(1); // No retry while dependencies are closed.
      await agent.start();
      await agent.getOrCreateNamedKaVmLifecycleRepair().runDue();
      expect(await committed()).toMatchObject({ value: true });
      expect(attempts()).toBe(2); expect(publish).toHaveBeenCalledOnce();
      expect(mint).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
      expect(internals.namedKaVmLifecycleRepair).toBe(owner);
      await owner.runDue(); expect(attempts()).toBe(2); // Completed evidence is consumed exactly once.
    } finally { await agent.stop().catch(() => undefined); await agent.store.close(); vi.restoreAllMocks(); }
  });
  it('refuses restart and new submissions until a held direct write physically retires, then permits a fresh worker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-worker-retirement-')); dirs.push(dir);
    const path = join(dir, 'store.nq'), store = new OxigraphStore(path); stores.push(store);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const { input } = confirmedLifecycleRecoveryFixture();
    const apply = vi.fn(async (current: typeof input) => {
      if (current.name === input.name) { entered(); await held; }
      await store.insert([{ graph: 'urn:worker', subject: `urn:${current.name}`, predicate: 'urn:value', object: '"committed"' }]);
      await store.commitment!.commit();
    });
    const owner = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), warn: vi.fn(), apply, isCurrent: async () => true }); owners.push(owner);
    owner.start(); const submission = owner.submit(input); await started;
    let drained = false; const stop = owner.stop().then(() => { drained = true; }); owner.start();
    try {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await expect(Promise.race([owner.submit({ ...input, name: 'after-stop' }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('admission was not fenced')), 1_000); }),
      ])).rejects.toThrow('stopped'); } finally { clearTimeout(timeout); }
      await new Promise(resolve => setTimeout(resolve, 20)); expect(drained).toBe(false); expect(apply).toHaveBeenCalledOnce();
      const journal = JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8'));
      expect(journal.entries).toHaveLength(1);
    } finally { release(); await submission; await stop; }
    const reopened = new OxigraphStore(path); stores.push(reopened);
    expect(await reopened.query(`ASK { GRAPH <urn:worker> { <urn:${input.name}> <urn:value> "committed" } }`)).toMatchObject({ value: true });
    owner.start(); expect(await owner.submit({ ...input, name: 'after-retirement' })).toBe('repaired');
    expect(apply).toHaveBeenCalledTimes(2); await owner.stop();
  });
  it('fences agent admission before teardown, drains physical writes and restarts the retained owner', async () => {
    const agent = await DKGAgent.create({ name: 'ConfirmedRepairRestart', nodeRole: 'edge',
      listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new MockChainAdapter() });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const internals = agent as unknown as { namedKaVmLifecycleRepair?: NamedKaVmLifecycleRepair; writeLocks: Map<string, Promise<void>> };
    const { input } = confirmedLifecycleRecoveryFixture();
    const owner = new NamedKaVmLifecycleRepair({ writeLocks: internals.writeLocks, warn: vi.fn(), isCurrent: async () => true,
      apply: async () => { entered(); await held;
        await agent.store.insert([{ graph: 'urn:worker', subject: 'urn:before-stop', predicate: 'urn:value', object: '"committed"' }]);
        await agent.store.commitment!.commit();
      } });
    let submission: Promise<unknown> | undefined, stopping: Promise<void> | undefined;
    try {
      await agent.start();
      await internals.namedKaVmLifecycleRepair!.stop();
      internals.namedKaVmLifecycleRepair = owner; owner.start();
      submission = owner.submit(input); await started;
      const close = vi.spyOn(agent.store, 'close');
      const nextTeardown = vi.spyOn(agent, 'closeRfc64CatalogRuntimeV1');
      stopping = agent.stop();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await expect(Promise.race([owner.submit({ ...input, name: 'after-stop' }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('admission was not fenced')), 1_000); }),
      ])).rejects.toThrow('stopped'); } finally { clearTimeout(timeout); }
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(close).not.toHaveBeenCalled(); expect(nextTeardown).not.toHaveBeenCalled();
      release(); expect(await submission).toBe('repaired'); await stopping;
      expect(close).toHaveBeenCalledOnce(); expect(nextTeardown).toHaveBeenCalledOnce();
      expect(internals.namedKaVmLifecycleRepair).toBe(owner);
      const restart = vi.spyOn(NamedKaVmLifecycleRepair.prototype, 'start');
      await agent.start();
      const retained = agent.getOrCreateNamedKaVmLifecycleRepair();
      expect(retained).toBe(owner); expect(restart).toHaveBeenCalledOnce();
      expect(restart.mock.contexts[0]).toBe(retained);
      expect(await agent.store.query('ASK { GRAPH <urn:worker> { <urn:before-stop> <urn:value> "committed" } }')).toMatchObject({ value: true });
    } finally { release(); await Promise.allSettled([submission, stopping]); await owner.stop();
      await agent.stop().catch(() => undefined); await agent.store.close(); vi.restoreAllMocks(); }
  });
  it('owns delayed periodic errors and cancels future deadlines before restart', async () => {
    vi.useFakeTimers(); const dir = await mkdtemp(join(tmpdir(), 'dkg-worker-error-')); dirs.push(dir);
    const journal = join(dir, 'named-ka-vm-lifecycle-repairs.json'); await writeFile(journal, '{broken');
    const warn = vi.fn(), owner = new NamedKaVmLifecycleRepair({ dataDir: dir, writeLocks: new Map(), warn, apply: async () => {}, isCurrent: async () => true }); owners.push(owner);
    owner.start(); await vi.advanceTimersByTimeAsync(4999); expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    await owner.stop(); await vi.advanceTimersByTimeAsync(20_000); expect(warn).toHaveBeenCalledOnce();
    await writeFile(journal, JSON.stringify({ version: 2, entries: [] })); owner.start();
    await vi.advanceTimersByTimeAsync(5000); await owner.stop(); expect(warn).toHaveBeenCalledOnce();
  });
});
