/**
 * A bound share replay after its admitted version was published to Verified
 * Memory and then superseded there by a confirmed update. The per-asset VM
 * graph is keyed by author and number, not by version, so the update replaces
 * the graph the replay would check against the admitted seal. Backed by an
 * in-memory store and a mock chain.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION, LEGACY_ROOT_CONTENT_SCOPE_VERSION, TypedEventBus, assertionLifecycleUri,
  contextGraphMetaUri, createGraphKnowledgeAssetScope, generateEd25519Keypair, type AssertionSeal,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, PrivateContentStore, StoreSchedulerBusyError, type TripleStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher, computeFlatKCRootV10, computePrivateRootV10, generateGraphKnowledgeAssetMetadata, skolemizeKnowledgeAssetParts } from '../src/index.js';
import { confirmedVmSupersedesSeal } from '../src/completed-legacy-promote.js';
import { SWM_SHARE_COMPLETE_PRED } from '../src/shared-memory-author-seal.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';

const CG = 'vm-supersession-cg';
const NAME = 'superseded-asset';
const AGENT = '0x1234567890abcdef1234567890abcdef12345678';
const PEER = '12D3KooWSupersession';
const MEMORY_LAYER = 'http://dkg.io/ontology/memoryLayer';
const UPDATED = [{ subject: 'urn:asset', predicate: 'https://schema.org/name', object: '"updated"', graph: '' }];

type Update = 'superseding' | 'equal-version' | 'different-root' | 'missing-vm' | 'unconfirmed-envelope';
/** Where the update's private triples are stored: the newer version's scope, nowhere, or only the admitted scope. */
type PrivateUpdate = 'newer-scope' | 'missing' | 'admitted-scope';
const secret = (value: string) => ({ subject: 'urn:asset', predicate: 'https://schema.org/secret', object: `"${value}"`, graph: '' });

async function graphContent(store: TripleStore, graph: string) {
  return store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
}

/** A bound share committed to SWM whose admitted version was then confirmed in VM. */
async function publishedBoundShare(withPrivate = false) {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({ store, chain: new MockChainAdapter(), eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
  await publisher.assertionCreate(CG, NAME, AGENT);
  await publisher.assertionWrite(CG, NAME, AGENT, [{ subject: 'urn:asset', predicate: 'https://schema.org/name', object: '"original"' }]);
  if (withPrivate) await publisher.assertionWritePrivate(CG, NAME, AGENT, [secret('admitted')]);
  const finalized = await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AGENT });
  const opts = { publisherPeerId: PEER };
  const binding = await publisher.prepareAssertionPromoteRecovery(CG, NAME, AGENT, opts, true);
  if ('completedResult' in binding) throw new Error('expected a new recovery binding');
  expect(await publisher.assertionPromote(CG, NAME, AGENT, { ...opts, recoveryBinding: binding })).toMatchObject({ promotedCount: withPrivate ? 2 : 1 });
  const vm = finalized.sharedGraphUri.replace('/_shared_memory/', '/_verifiable_memory/');
  const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
  await store.insert(finalized.publicQuads.map(q => ({ ...q, graph: vm })));
  await store.deleteByPattern({ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: MEMORY_LAYER });
  await store.insert([{ graph: contextGraphMetaUri(CG), subject: lifecycle, predicate: MEMORY_LAYER, object: '"VM"' }]);
  await publisher.clearSwmShareComplete(CG, NAME, AGENT);
  const seal = { contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: finalized.kaUal,
    assertionVersion: finalized.assertionVersion } as AssertionSeal;
  const host = { store, privateStore: new PrivateContentStore(store, new GraphManager(store)),
    scopedQuads: (graph: string) => (publisher as any).assertionScopedQuads(graph) };
  return { store, publisher, finalized, binding, opts, vm, seal, host };
}

/**
 * A later update replaces the per-asset VM graph and records its newer version's envelope.
 * A private update commits different private triples, which the private store keys by version.
 */
async function confirmUpdate(fixture: Awaited<ReturnType<typeof publishedBoundShare>>, kind: Update, privateUpdate?: PrivateUpdate) {
  const { store, finalized, vm, host } = fixture;
  await store.deleteByPattern({ graph: vm });
  if (kind !== 'missing-vm') await store.insert(UPDATED.map(q => ({ ...q, graph: vm })));
  const rootQuads = kind === 'different-root' ? finalized.publicQuads.map(q => ({ ...q, graph: '' })) : UPDATED;
  const normalized = await skolemizeKnowledgeAssetParts(rootQuads, privateUpdate ? [secret('updated')] : [], { allowCanonicalSkolemTerms: true });
  const privateMerkleRoot = computePrivateRootV10(normalized.privateQuads);
  const admitted = BigInt(finalized.assertionVersion);
  const version = kind === 'equal-version' ? admitted : admitted + 1n;
  if (privateUpdate === 'newer-scope' || privateUpdate === 'admitted-scope') {
    await host.privateStore.replaceKnowledgeAssetPrivateTriples(CG,
      createGraphKnowledgeAssetScope(finalized.kaUal, privateUpdate === 'newer-scope' ? version : admitted), normalized.privateQuads);
  }
  await store.insert(generateGraphKnowledgeAssetMetadata({ ual: finalized.kaUal, contextGraphId: CG,
    merkleRoot: computeFlatKCRootV10(normalized.publicQuads, privateMerkleRoot ? [privateMerkleRoot] : []), publisherPeerId: PEER,
    accessPolicy: 'public', timestamp: new Date(0), assertionVersion: version, publicTripleCount: 1, assertionGraph: vm,
    ...(privateMerkleRoot ? { privateMerkleRoot, privateTripleCount: normalized.privateQuads.length } : {}),
  }, kind === 'unconfirmed-envelope' ? { status: 'tentative' } : { status: 'confirmed', confirmation: { kind: 'transaction',
    provenance: { txHash: `0x${'ab'.repeat(32)}`, blockNumber: 1, blockTimestamp: 1, publisherAddress: AGENT, batchId: 7n, chainId: '31337' } } }));
  return graphContent(store, vm);
}

/** Every private triple of the asset's admitted and newer versions. */
async function privateContent(fixture: Awaited<ReturnType<typeof publishedBoundShare>>) {
  const { host, finalized } = fixture;
  const admitted = BigInt(finalized.assertionVersion);
  return Promise.all([admitted, admitted + 1n].map(version =>
    host.privateStore.getKnowledgeAssetPrivateTriples(CG, createGraphKnowledgeAssetScope(finalized.kaUal, version))));
}

describe('bound replay after a confirmed VM update', () => {
  it('accepts a proven, strictly newer confirmed version of the same VM graph, writing only the marker clear', async () => {
    const fixture = await publishedBoundShare();
    const { store, publisher, binding, opts, vm, seal, host } = fixture;
    const updated = await confirmUpdate(fixture, 'superseding');
    const meta = await graphContent(store, contextGraphMetaUri(CG));
    expect(await confirmedVmSupersedesSeal(host, CG, seal)).toBe(true);
    // A stale share-complete marker is cleared by the failed exact check, as on the VM no-op; nothing else changes.
    await publisher.markSwmShareComplete(CG, NAME, AGENT);
    expect(await publisher.assertionPromote(CG, NAME, AGENT, { ...opts, recoveryBinding: binding }))
      .toEqual({ promotedCount: 0, promotedAllRoots: false });
    expect(await graphContent(store, vm)).toEqual(updated);
    expect(await graphContent(store, contextGraphMetaUri(CG))).toEqual(meta);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(false);
    await store.close();
  });

  it('keeps the bound replay failing while a stale share-complete marker cannot be cleared, then completes', async () => {
    const fixture = await publishedBoundShare();
    const { store, publisher, binding, opts, vm, seal, host } = fixture;
    const updated = await confirmUpdate(fixture, 'superseding');
    expect(await confirmedVmSupersedesSeal(host, CG, seal)).toBe(true);
    await publisher.markSwmShareComplete(CG, NAME, AGENT);
    const busy = new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test.markerDelete', { storeOperation: 'deleteByPattern' });
    const remove = store.deleteByPatternWithoutCount.bind(store);
    const markerDelete = vi.spyOn(store, 'deleteByPatternWithoutCount').mockImplementation(async pattern => {
      if (pattern.predicate === SWM_SHARE_COMPLETE_PRED) throw busy;
      return remove(pattern);
    });
    // The proven newer version must not turn a failed marker deletion into a successful no-op.
    await expect(publisher.assertionPromote(CG, NAME, AGENT, { ...opts, recoveryBinding: binding })).rejects.toBe(busy);
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(true);
    markerDelete.mockRestore();
    expect(await publisher.assertionPromote(CG, NAME, AGENT, { ...opts, recoveryBinding: binding }))
      .toEqual({ promotedCount: 0, promotedAllRoots: false });
    expect(await publisher.hasSwmShareComplete(CG, NAME, AGENT)).toBe(false);
    expect(await graphContent(store, vm)).toEqual(updated);
    await store.close();
  });

  it('keeps the exact VM check for an unbound promotion of the same asset', async () => {
    const fixture = await publishedBoundShare();
    await confirmUpdate(fixture, 'superseding');
    await expect(fixture.publisher.assertionPromote(CG, NAME, AGENT, fixture.opts)).rejects.toThrow(/Merkle mismatch/);
    await fixture.store.close();
  });

  it.each(['equal-version', 'different-root', 'missing-vm', 'unconfirmed-envelope'] as const)(
    'rethrows the original mismatch when the replacement is unproven (%s)', async kind => {
      const fixture = await publishedBoundShare();
      const { store, publisher, binding, opts, vm, seal, host } = fixture;
      const replaced = await confirmUpdate(fixture, kind);
      expect(await confirmedVmSupersedesSeal(host, CG, seal)).toBe(false);
      const failure = await publisher.assertionPromote(CG, NAME, AGENT, { ...opts, recoveryBinding: binding }).catch(e => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.code).toBeUndefined();
      expect(failure.message).toMatch(kind === 'missing-vm' ? /triple-count mismatch/ : /Merkle mismatch/);
      expect(await graphContent(store, vm)).toEqual(replaced);
      await store.close();
    });

  it('proves nothing for another sub-graph, a legacy seal or an asset without a confirmed envelope', async () => {
    const fixture = await publishedBoundShare();
    const { store, seal, host } = fixture;
    expect(await confirmedVmSupersedesSeal(host, CG, seal)).toBe(false);
    await confirmUpdate(fixture, 'superseding');
    expect(await confirmedVmSupersedesSeal(host, CG, seal, 'notes')).toBe(false);
    expect(await confirmedVmSupersedesSeal(host, CG, { ...seal, contentScopeVersion: LEGACY_ROOT_CONTENT_SCOPE_VERSION })).toBe(false);
    expect(await confirmedVmSupersedesSeal(host, CG, { ...seal, kaUal: undefined })).toBe(false);
    await store.close();
  });

  it('proves a private update from the newer version\'s private triples, not the admitted version\'s', async () => {
    const fixture = await publishedBoundShare(true);
    const { store, publisher, binding, opts, vm, seal, host } = fixture;
    expect(seal.assertionVersion).toBe(fixture.finalized.assertionVersion);
    const [admittedSecret] = await privateContent(fixture);
    expect(admittedSecret.map(q => q.object)).toEqual(['"admitted"']);
    const updated = await confirmUpdate(fixture, 'superseding', 'newer-scope');
    const privateBefore = await privateContent(fixture);
    expect(privateBefore.map(quads => quads.map(q => q.object))).toEqual([['"admitted"'], ['"updated"']]);
    expect(await confirmedVmSupersedesSeal(host, CG, seal)).toBe(true);
    expect(await publisher.assertionPromote(CG, NAME, AGENT, { ...opts, recoveryBinding: binding }))
      .toEqual({ promotedCount: 0, promotedAllRoots: false });
    expect(await graphContent(store, vm)).toEqual(updated);
    expect(await privateContent(fixture)).toEqual(privateBefore);
    await store.close();
  });

  it.each(['missing', 'admitted-scope'] as const)(
    'rethrows the original mismatch when the newer version\'s private triples are not under its scope (%s)', async privateUpdate => {
      const fixture = await publishedBoundShare(true);
      const { store, publisher, binding, opts, vm, seal, host } = fixture;
      const replaced = await confirmUpdate(fixture, 'superseding', privateUpdate);
      const privateBefore = await privateContent(fixture);
      const meta = await graphContent(store, contextGraphMetaUri(CG));
      expect(await confirmedVmSupersedesSeal(host, CG, seal)).toBe(false);
      const failure = await publisher.assertionPromote(CG, NAME, AGENT, { ...opts, recoveryBinding: binding }).catch(e => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.code).toBeUndefined();
      expect(failure.message).toMatch(privateUpdate === 'admitted-scope' ? /private Merkle mismatch/ : /Merkle mismatch/);
      expect(await graphContent(store, vm)).toEqual(replaced);
      expect(await privateContent(fixture)).toEqual(privateBefore);
      expect(await graphContent(store, contextGraphMetaUri(CG))).toEqual(meta);
      await store.close();
    });

  it('propagates a store failure while proving from a bound replay and logs the original mismatch', async () => {
    const fixture = await publishedBoundShare(true);
    const { store, publisher, binding, opts, finalized } = fixture;
    await confirmUpdate(fixture, 'superseding', 'newer-scope');
    const busy = new StoreSchedulerBusyError('queue_wait_timeout', 'normal', 'test.privateRead', { storeOperation: 'query' });
    const privateStore = (publisher as any).privateStore as PrivateContentStore;
    const read = privateStore.getKnowledgeAssetPrivateTriples.bind(privateStore);
    // The exact check reads the admitted version; only the proof reads the newer one.
    vi.spyOn(privateStore, 'getKnowledgeAssetPrivateTriples').mockImplementation(async (cg, scope, ...rest) => {
      if (scope.assertionVersion !== finalized.assertionVersion) throw busy;
      return read(cg, scope, ...rest);
    });
    const warn = vi.spyOn((publisher as any).log, 'warn');
    await expect(publisher.assertionPromote(CG, NAME, AGENT, { ...opts, recoveryBinding: binding })).rejects.toBe(busy);
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/Merkle mismatch/));
    await store.close();
  });

  it('propagates a store failure while proving, so the replay stays retryable', async () => {
    const fixture = await publishedBoundShare();
    const { store, seal, host } = fixture;
    await confirmUpdate(fixture, 'superseding');
    const unavailable = new Error('store unavailable');
    const failing = { ...host, scopedQuads: async () => { throw unavailable; } };
    await expect(confirmedVmSupersedesSeal(failing, CG, seal)).rejects.toBe(unavailable);
    await store.close();
  });
});
