import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { OxigraphStore, PrivateContentStore, GraphManager, StoreOperationTimeoutError, StoreSchedulerBusyError, StoreReadTransportFailure, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/index.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';
import { CG, AGENT, NAME, SCHEMA, DKG, ENTITY_1, ENTITY_2, ENTITY_3, makePublisher, q, key, seedDirtyDraft, seedShared, registerSubGraph, cleanupPullFixtures } from './_helpers/assertion-pull.js';

afterEach(async () => { vi.restoreAllMocks(); await cleanupPullFixtures(); });

describe('source-pinned exact WM recovery (#3350)', () => {
  const privateQuads = [q(ENTITY_1, 'urn:secret', '"PRIVATE_SENTINEL_3350"')];
  const make = async () => {
    const { publisher, store } = await makePublisher();
    const source = await seedShared(publisher, store, { privateQuads });
    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    return { publisher, store, source, recoverExact: {
      kaUal: source.kaUal, assertionVersion: source.assertionVersion, merkleRoot: source.merkleRoot,
    } };
  };
  const snapshot = async (store: TripleStore) => {
    const result = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
    return JSON.stringify(result.type === 'bindings' ? result.bindings.map(row => JSON.stringify(row)).sort() : result);
  };

  it('returns bound commitments without payload or writes; ordinary retry still rejects', async () => {
    const { publisher, store, source, recoverExact } = await make();
    const before = await snapshot(store);
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm'))
      .rejects.toMatchObject({ code: 'WM_DRAFT_CONFLICT' });
    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { recoverExact });
    expect(result).toMatchObject({ recovered: true, kaUal: source.kaUal,
      draftEvidence: { contextGraphId: CG, name: NAME, agentAddress: AGENT,
        kaUal: source.kaUal, assertionVersion: source.assertionVersion,
        publicTripleCount: 2, privateTripleCount: 1,
        merkleRoot: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        privateMerkleRoot: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL_3350');
    expect(await snapshot(store)).toBe(before);
  });

  it.each(['missing-private', 'wrong-private', 'wrong-public', 'missing-draft', 'missing-source-private'])(
    'refuses %s without changing storage or leaking payload', async damage => {
      const { publisher, store, recoverExact, source } = await make();
      const privateStore = new PrivateContentStore(store, new GraphManager(store));
      if (damage === 'missing-private' || damage === 'wrong-private') {
        await privateStore.deleteKnowledgeAssetPrivateDraft(CG, AGENT, NAME);
        if (damage === 'wrong-private') await privateStore.storeKnowledgeAssetPrivateDraftTriples(
          CG, AGENT, NAME, [q(ENTITY_1, 'urn:secret', '"WRONG_PRIVATE_SENTINEL_3350"')]);
      }
      if (damage === 'wrong-public') {
        const graph = await publisher.wmGraphUri(CG, AGENT, NAME);
        await store.dropGraph(graph);
        await seedDirtyDraft(publisher, store, [q(ENTITY_1, SCHEMA, '"Wrong"'), q(ENTITY_2, SCHEMA, '"Bob"')]);
      }
      if (damage === 'missing-draft') await publisher.assertionDiscard(CG, NAME, AGENT);
      if (damage === 'missing-source-private') await privateStore.deleteKnowledgeAssetPrivateTriples(
        CG, createGraphKnowledgeAssetScope(source.kaUal, source.assertionVersion));
      const before = await snapshot(store);
      const error = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { recoverExact }).catch(e => e);
      expect(error).toMatchObject({ code: expect.stringMatching(/^WM_(DRAFT_NOT_EXACT|RECOVERY_SOURCE_UNAVAILABLE)$/) });
      expect(String(error)).not.toMatch(/PRIVATE_SENTINEL|WRONG_PRIVATE_SENTINEL/);
      expect(await snapshot(store)).toBe(before);
    });

  it.each(['timeout', 'busy', 'transport'])(
    'keeps source %s retryable without leaking private store errors', async kind => {
      const { publisher, store, recoverExact } = await make();
      const before = await snapshot(store);
      const error = kind === 'timeout'
        ? new StoreOperationTimeoutError({ backend: 'test', operation: 'query', message: 'PRIVATE_SENTINEL_3350' })
        : kind === 'busy' ? new StoreSchedulerBusyError('queue_full', 'normal', 'PRIVATE_SENTINEL_3350')
        : new StoreReadTransportFailure(new Error('PRIVATE_SENTINEL_3350'));
      vi.spyOn(PrivateContentStore.prototype, 'getKnowledgeAssetPrivateTriples').mockRejectedValueOnce(error);
      const failure = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { recoverExact }).catch(e => e);
      expect(failure).toMatchObject({ retryable: true, code: kind === 'timeout' ? 'STORE_OPERATION_TIMEOUT'
        : kind === 'busy' ? 'STORE_SCHEDULER_BUSY' : 'WM_RECOVERY_UNAVAILABLE' });
      expect(String(failure)).not.toContain('PRIVATE_SENTINEL');
      expect(failure.cause).toBeUndefined();
      expect(await snapshot(store)).toBe(before);
    });

  it('refuses stray private WM for a public-only source', async () => {
    const { publisher, store } = await makePublisher();
    const source = await seedShared(publisher, store);
    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    await publisher.assertionWritePrivate(CG, NAME, AGENT, privateQuads);
    const before = await snapshot(store);
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { recoverExact: source }))
      .rejects.toMatchObject({ code: 'WM_DRAFT_NOT_EXACT' });
    expect(await snapshot(store)).toBe(before);
  });

  it.each(['actor', 'context', 'subgraph', 'ka', 'version'])(
    'refuses the wrong %s', async scope => {
      const { publisher, store, recoverExact } = await make();
      const before = await snapshot(store);
      await expect(publisher.assertionPullFrom(scope === 'context' ? 'other' : CG, NAME,
        scope === 'actor' ? '0x00000000000000000000000000000000000000b2' : AGENT, 'swm', {
          recoverExact: { ...recoverExact, ...(scope === 'ka' ? { kaUal: recoverExact.kaUal.replace(/\/\d+$/, '/999') } : {}),
            ...(scope === 'version' ? { assertionVersion: '999' } : {}) },
          ...(scope === 'subgraph' ? { subGraphName: 'other' } : {}),
        })).rejects.toBeDefined();
      expect(await snapshot(store)).toBe(before);
    });

  it('refuses an archived source superseded by a newer finalized assertion', async () => {
    const { publisher, store, recoverExact } = await make();
    await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG,
      name: NAME, agentAddress: AGENT, assertionVersion: '2' });
    const before = await snapshot(store);
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { recoverExact }))
      .rejects.toMatchObject({ code: 'WM_RECOVERY_SOURCE_UNAVAILABLE' });
    expect(await snapshot(store)).toBe(before);
  });

  it('refuses a wrong root even when KA and version match', async () => {
    const { publisher, store, recoverExact } = await make();
    const before = await snapshot(store);
    await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', {
      recoverExact: { ...recoverExact, merkleRoot: `0x${'ab'.repeat(32)}` },
    })).rejects.toMatchObject({ code: 'WM_RECOVERY_SOURCE_UNAVAILABLE' });
    expect(await snapshot(store)).toBe(before);
  });

  it.each(['public-only', 'private-only', 'subgraph', 'vm'])(
    'recovers exact %s partitions', async mode => {
      const { publisher, store } = await makePublisher();
      if (mode === 'subgraph') await registerSubGraph(store, 'secret');
      const subGraphName = mode === 'subgraph' ? 'secret' : undefined;
      const source = await seedShared(publisher, store, { subGraphName,
        publicQuads: mode === 'private-only' ? [] : undefined,
        privateQuads: mode === 'public-only' ? [] : privateQuads });
      if (mode === 'vm') {
        const scope = createGraphKnowledgeAssetScope(source.kaUal, source.assertionVersion);
        const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope);
        await store.insert(source.publicQuads.map(quad => ({ ...quad, graph })));
      }
      const layer = mode === 'vm' ? 'vm' : 'swm';
      await publisher.assertionPullFrom(CG, NAME, AGENT, layer, { subGraphName });
      const before = await snapshot(store);
      const result = await publisher.assertionPullFrom(CG, NAME, AGENT, layer, { subGraphName, recoverExact: source });
      expect(result).toMatchObject({ recovered: true, draftEvidence: { fromLayer: layer,
        publicTripleCount: source.publicQuads.length, privateTripleCount: source.privateQuads.length } });
      expect(result.draftEvidence?.privateMerkleRoot === null).toBe(mode === 'public-only');
      expect(await snapshot(store)).toBe(before);
    });

  it('snapshots nested source options and rejects concurrent draft changes', async () => {
    const { publisher, recoverExact } = await make();
    const opts = { recoverExact: { ...recoverExact } };
    const pending = publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', opts);
    opts.recoverExact.assertionVersion = '999';
    await expect(pending).resolves.toMatchObject({ recovered: true });
    // Both calls select the same lifecycle lock; the earlier write must be visible.
    const write = publisher.assertionWritePrivate(CG, NAME, AGENT, [q(ENTITY_2, 'urn:secret', '"changed"')]);
    const recovery = publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { recoverExact });
    await write;
    await expect(recovery).rejects.toMatchObject({ code: 'WM_DRAFT_NOT_EXACT' });
  });

  it.each([false, true])('distinguishes partial=%s after store/publisher restart', async partial => {
    const directory = await mkdtemp(join(tmpdir(), 'dkg-3350-'));
    const path = join(directory, 'store.nq');
    let store = new OxigraphStore(path);
    const create = async () => new DKGPublisher({ store, chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
    try {
      let publisher = await create();
      const source = await seedShared(publisher, store, { privateQuads });
      if (partial) {
        vi.spyOn(PrivateContentStore.prototype, 'storeKnowledgeAssetPrivateDraftTriples').mockRejectedValueOnce(new Error('injected private write interruption'));
        await expect(publisher.assertionPullFrom(CG, NAME, AGENT, 'swm')).rejects.toThrow('injected');
      } else await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
      await store.close();
      store = new OxigraphStore(path);
      publisher = await create();
      const recovery = publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { recoverExact: source });
      if (partial) await expect(recovery).rejects.toMatchObject({ code: 'WM_DRAFT_NOT_EXACT' });
      else await expect(recovery).resolves.toMatchObject({ recovered: true, seededPrivate: 1 });
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
