import { expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertionLifecycleUri, contextGraphMetaUri, createOperationContext } from '@origintrail-official/dkg-core';
import { createTripleStore, StoreOperationTimeoutError, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../../agent/src/dkg-agent.js';
import { NamedKaVmLifecycleRepair } from '../../agent/src/named-ka-vm-lifecycle-repair.js';
import { confirmedLifecycleExecutionCapabilities } from '../../agent/src/named-ka-vm-lifecycle-executor.js';
import { finalizeQueuedKnowledgeAssetVmPublish } from '../../agent/src/queued-publish-finalization.js';
import { confirmedMaterializationFixture } from '../../agent/test/_helpers/confirmed-materialization-fixture.js';
import { confirmedLifecycleRecoveryFixture } from '../../agent/test/_helpers/confirmed-lifecycle-recovery-fixture.js';
import { readLifecycleRepairJournalFile } from '../../agent/test/_helpers/read-lifecycle-repair-journal.js';
import { resolveConfirmedGraphScopedVm } from '../../agent/src/confirmed-graph-scoped-vm-resolver.js';
import type { GraphScopedKnowledgeAssetVmPublishRequest } from '../../agent/src/internal/knowledge-asset-vm-publish-request.js';
import { getBytes } from 'ethers';
import { OXIGRAPH_VERSION } from '../src/daemon/oxigraph-binary.js';
import { startManagedOxigraph } from '../src/daemon/oxigraph-managed.js';
import { freePort, waitForCondition } from './fixtures/oxigraph-server-real-fixture.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-managed-lifecycle-'))), cacheDir = join(root, 'cache');
  if (process.env.DKG_TEST_OXIGRAPH_BINARY) {
    await mkdir(cacheDir, { recursive: true });
    await copyFile(process.env.DKG_TEST_OXIGRAPH_BINARY,
      join(cacheDir, `oxigraph-v${OXIGRAPH_VERSION}${process.platform === 'win32' ? '.exe' : ''}`));
  }
  const managed = await startManagedOxigraph({ config: { store: { backend: 'oxigraph-server',
    options: { location: join(root, 'rocksdb'), cacheDir, port: await freePort() } } },
    dataDir: root, readyTimeoutMs: 120_000 });
  expect(managed).not.toBeNull();
  const stores: TripleStore[] = [], owners: NamedKaVmLifecycleRepair[] = [];
  const source = confirmedMaterializationFixture(), { input, graph } = source;
  const storeConfig = managed!.storeConfig;
  const open = async () => { const store = await createTripleStore(storeConfig); stores.push(store);
    expect(store.commitment).toBeUndefined(); return store; };
  const host = (store: TripleStore) => ({ store, storeConfig, chain: source.chain, dataDir: root,
    writeLocks: new Map<string, Promise<void>>(), readTimeoutMs: 1000 });
  const journal = () => readLifecycleRepairJournalFile(join(root, 'named-ka-vm-lifecycle-repairs.json'));
  const verify = async (store: TripleStore) => {
    expect(store.commitment).toBeUndefined();
    expect(await store.countQuads(graph)).toBe(1);
    expect(await store.query(`ASK { GRAPH <${graph}> { <urn:payload> <urn:value> "original public payload" } }`))
      .toMatchObject({ value: true });
    expect(await resolveConfirmedGraphScopedVm(store, { contextGraphId: input.contextGraphId, ual: input.materialization!.kaUal,
      merkleRoot: getBytes(input.merkleRoot), kaId: input.packedKaId, batchId: input.packedKaId, assertionVersion: 1n }))
      .toMatchObject({ status: 'verified' });
    expect(await store.query(`ASK { GRAPH <${contextGraphMetaUri(input.contextGraphId)}> {
      <${assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name)}>
      <http://dkg.io/ontology/state> "published"; <http://dkg.io/ontology/publishedUal> ${JSON.stringify(input.publishedUal)} } }`))
      .toMatchObject({ value: true });
    expect(await store.query(`ASK { GRAPH <${contextGraphMetaUri(input.contextGraphId)}> {
      <${input.materialization!.kaUal}> <http://dkg.io/ontology/transactionHash> "0x${'34'.repeat(32)}" } }`))
      .toMatchObject({ value: true });
  };
  return { root, managed: managed!, input, graph, open, host, journal, verify, owners,
    cleanup: async () => { vi.restoreAllMocks(); for (const owner of owners) await owner.stop();
      for (const store of stores) await store.close(); await managed?.handle.stop(); await rm(root, { recursive: true, force: true }); } };
}

it('completes healthy managed HTTP repair and the queued tail without inventing a durability capability', async () => {
  const f = await fixture();
  try {
    const store = await f.open(), { input } = f;
    const agent = Object.create(DKGAgent.prototype) as DKGAgent;
    const log = { warn: vi.fn(), info: vi.fn() };
    Object.assign(agent, { config: { dataDir: f.root, storeConfig: f.managed.storeConfig }, store,
      chain: f.host(store).chain, writeLocks: new Map(), log,
      _resolveRecoveredKnowledgeAssetVmLifecycleAuthor: async () => ({ author: input.agentAddress, incomplete: false }) });
    const owner = agent.getOrCreateNamedKaVmLifecycleRepair(); f.owners.push(owner);
    expect(await owner.submit(input)).toBe('repaired'); expect((await f.journal()).size).toBe(0); await f.verify(store);
    const { publication: seed } = confirmedLifecycleRecoveryFixture(), merkleRoot = getBytes(input.merkleRoot);
    const publication = { ...seed, merkleRoot, seal: { ...seed.seal, merkleRoot } };
    const request: GraphScopedKnowledgeAssetVmPublishRequest = { intentKey: 'managed-original-job',
      shareOperationId: 'managed-original-share', contextGraphId: input.contextGraphId, name: input.name,
      agentAddress: input.agentAddress, roots: [], contentScopeVersion: 2, kaUal: input.materialization!.kaUal,
      assertionVersion: input.assertionVersion, publicTripleCount: 1, privateTripleCount: 0,
      sealMerkleRoot: input.merkleRoot, sealChainId: input.publicationDeployment.chainId,
      sealKav10Address: input.publicationDeployment.lifecycleAddress, sealFinalizedAtIso: publication.seal.finalizedAtIso,
      seal: { merkleRoot: input.merkleRoot, authorAddress: input.agentAddress, schemeVersion: 1,
        signature: { r: input.namedSeal!.authorAttestationR, vs: input.namedSeal!.authorAttestationVS } } };
    const result = await finalizeQueuedKnowledgeAssetVmPublish({ request, seal: publication.seal, result: publication,
      operationPlan: { kind: 'initial', pricingPolicy: undefined }, effectiveAuthor: input.agentAddress,
      publisherPeerId: 'test-publisher', snapshotQuads: input.materialization!.publicQuads,
      onChainCapable: false, ctx: createOperationContext('publish') }, {
      agent: { store, _repairConfirmedNamedKaVmLifecycle: agent._repairConfirmedNamedKaVmLifecycle.bind(agent),
        _writeQueuedKnowledgeAssetVmPublishReceipt: agent._writeQueuedKnowledgeAssetVmPublishReceipt.bind(agent),
        retireLegacySwmAfterVerifiedVmTwin: async () => {}, getContextGraphOnChainId: async () => undefined,
        gossip: { publish: async () => {} } },
      publisher: { clearPublishedKnowledgeAssetSwm: async () => true, clearRemainingSharedMemory: async () => {}, clearSwmShareComplete: async () => {} },
      log, observeConfirmedCatalog: async () => true,
    });
    expect(result.localFinalizationComplete).toBe(true); expect(result.lifecycleRepairPending).toBeUndefined();
    expect(await agent._stampQueuedKnowledgeAssetVmPublishedLifecycle(request, input.publishedUal, input.packedKaId)).toBe(true);
    expect((await f.journal()).size).toBe(0); await f.verify(store);
  } finally { await f.cleanup(); }
}, 180_000);

it.each(['not_started', 'indeterminate'] as const)('retains failed managed HTTP writes and retries after supervised restart: %s', async outcome => {
  const f = await fixture(); let now = 1000;
  try {
    const store = await f.open();
    const makeOwner = (leaf: TripleStore) => {
      const owner = new NamedKaVmLifecycleRepair({ dataDir: f.root, now: () => now, warn: vi.fn(),
        ...confirmedLifecycleExecutionCapabilities(f.host(leaf)) }); f.owners.push(owner); return owner;
    };
    const owner = makeOwner(store), update = store.atomicUpdate!.bind(store);
    vi.spyOn(store, 'atomicUpdate').mockImplementation(async (sparql, options) => {
      if (options?.source === 'agent.publish.confirmedLifecycleCommit') {
        if (outcome === 'indeterminate') await update(sparql, options);
        throw new StoreOperationTimeoutError({ backend: 'managed-oxigraph', operation: 'update', outcome });
      }
      return update(sparql, options);
    });
    expect(await owner.submit(f.input)).toBe('pending'); expect((await f.journal()).size).toBe(1);
    // Recovery must restore the original public payload as well as retry the stamp.
    await store.deleteByPattern({ graph: f.graph });
    await owner.stop(); await store.close(); vi.restoreAllMocks();
    const generation = f.managed.handle.getRecoveryState().generation;
    expect(f.managed.handle.requestRestart('test pending acknowledged lifecycle repair')).toBe(true);
    expect(await waitForCondition(() => { const state = f.managed.handle.getRecoveryState();
      return state.generation > generation && !state.recovering; }, 60_000)).toBe(true);
    const fresh = await f.open(), retry = makeOwner(fresh); now += 10_000;
    await retry.runDue(); expect((await f.journal()).size).toBe(0); await f.verify(fresh);
    // Only the admitted journal is retried: this host has read-only chain capabilities, no sender.
    await retry.runDue(); expect((await f.journal()).size).toBe(0);
    // Observed process restart survival does not establish stable-media durability for stock HTTP.
  } finally { await f.cleanup(); }
}, 180_000);
