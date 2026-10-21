import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY, contextGraphDataUri, contextGraphMetaUri, assertionLifecycleUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, BlazegraphStore, BlazegraphNamespaceManager } from '@origintrail-official/dkg-storage';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { createPublishedNamedKaVmLifecycleWriter } from '../src/named-ka-vm-lifecycle.js';

const CG = 'lifecycle-cache';
const GRAPH = contextGraphMetaUri(CG);
const AUTHOR = '0x1111111111111111111111111111111111111111';
const SUBJECT = assertionLifecycleUri(CG, AUTHOR, 'asset');
const MARKER = 'http://dkg.io/ontology/swmShareComplete';
const stores: Array<OxigraphStore | BlazegraphStore> = [];
const namespaces: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); for (const dispose of namespaces.splice(0)) await dispose(); });
async function open() {
  const url = process.env.DKG_CLEANUP_BLAZEGRAPH_URL;
  let raw: OxigraphStore | BlazegraphStore;
  if (url) {
    const manager = new BlazegraphNamespaceManager({ namespaceApiUrl: `${url}/namespace` });
    const handles = await manager.acquireMany([`lifecycle-${randomUUID()}`]);
    namespaces.push(() => manager.disposeAll(handles));
    raw = new BlazegraphStore(handles[0]!.sparqlUrl);
  } else raw = new OxigraphStore();
  stores.push(raw);
  return raw;
}
async function stack() {
  const raw = await open();
  await raw.insert([{ graph: GRAPH, subject: contextGraphDataUri(CG), predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${AUTHOR}"` }]);
  const projection = new ContextGraphMetaProjection(raw);
  const execute = createObservedStoreMutation(() => {}, createProjectionMutationObserver(() => projection));
  const store = createMutationObservedStore(raw, execute);
  const lifecycle = createPublishedNamedKaVmLifecycleWriter({ updateStore: raw, fallbackStore: store, executeMutation: execute });
  const cached = await projection.get(CG);
  return { raw, store, projection, lifecycle, cached };
}

describe('publication lifecycle projection reuse', () => {
  it('writes required VM stamps and clears the share marker without reloading unchanged authority', async () => {
    const { raw, store, projection, lifecycle, cached } = await stack();
    const revision = projection.readContextGraphAuthorityFactsRevision(CG);
    const query = vi.spyOn(raw, 'query');
    await lifecycle({ contextGraphId: CG, agentAddress: AUTHOR, name: 'asset',
      publishedUal: `did:dkg:base:84532/${AUTHOR}/1`, merkleRoot: 'ab'.repeat(32),
      packedKaId: (BigInt(AUTHOR) << 96n) | 1n });
    await store.deleteByPatternWithoutCount!({ graph: GRAPH, subject: SUBJECT, predicate: MARKER });
    expect(projection.readContextGraphAuthorityFactsRevision(CG)).toBe(revision);
    expect(await projection.get(CG)).toEqual(cached);
    expect(query).not.toHaveBeenCalled();
    expect(await raw.query(`ASK { GRAPH <${GRAPH}> { <${SUBJECT}> <http://dkg.io/ontology/state> "published" } }`))
      .toEqual({ type: 'boolean', value: true });
  });
  it('invalidates real roster and delegation removals even on a lifecycle-shaped subject', async () => {
    const { raw, store, projection } = await stack();
    await store.insert([{ graph: GRAPH, subject: SUBJECT,
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: `"${AUTHOR}"` }]);
    projection.markDirty(CG);
    expect((await projection.get(CG)).delegations).toHaveLength(1);
    await store.deleteByPatternWithoutCount!({ graph: GRAPH, subject: SUBJECT,
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT });
    expect((await projection.get(CG)).delegations).toHaveLength(0);
    await store.deleteByPatternWithoutCount!({ graph: GRAPH, subject: contextGraphDataUri(CG),
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT });
    expect((await projection.get(CG)).allowedAgents).toHaveLength(0);
    expect(await raw.query(`ASK { GRAPH <${GRAPH}> { <${SUBJECT}> <${DKG_ONTOLOGY.DKG_DELEGATION_AGENT}> ?agent } }`))
      .toEqual({ type: 'boolean', value: false });
  });

  it('invalidates absence proofs for any predicate on the CG subject', async () => {
    const raw = await open();
    const projection = new ContextGraphMetaProjection(raw);
    const execute = createObservedStoreMutation(() => {}, createProjectionMutationObserver(() => projection));
    const store = createMutationObservedStore(raw, execute);
    await raw.insert([{ graph: GRAPH, subject: contextGraphDataUri(CG), predicate: MARKER, object: '"anything"' }]);
    const snapshot = await projection.prepareReadAuthorityFactsSnapshot([CG]);
    expect(snapshot.isAbsent(CG)).toBe(false);
    await store.deleteByPatternWithoutCount!({ graph: GRAPH, subject: contextGraphDataUri(CG), predicate: MARKER });
    expect(snapshot.assertCurrent()).toBe(false);
    expect((await projection.prepareReadAuthorityFactsSnapshot([CG])).isAbsent(CG)).toBe(true);
  });

  it.each([
    { subject: undefined, predicate: MARKER },
    { subject: SUBJECT, predicate: undefined },
    { subject: '_:wildcard', predicate: MARKER },
    { subject: '<urn:wrapped>', predicate: MARKER },
    { subject: '', predicate: MARKER },
    { subject: SUBJECT, predicate: '<urn:wrapped>' },
    { subject: SUBJECT, predicate: '' },
    { subject: SUBJECT, predicate: DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY },
    { subject: SUBJECT, predicate: DKG_ONTOLOGY.RDF_TYPE },
    { subject: SUBJECT, predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER },
  ])('keeps ambiguous or relevant removals conservative: %j', async removal => {
    const { projection } = await stack();
    const before = projection.readContextGraphAuthorityFactsRevision(CG);
    projection.invalidateStoreMutation({ removals: [{ graph: GRAPH, ...removal }] });
    expect(projection.readContextGraphAuthorityFactsRevision(CG)).not.toBe(before);
  });

  it.each([false, true])('does not turn an unrelated uncertain lifecycle write into authority invalidation (committed=%s)', async committed => {
    const { raw, projection, lifecycle, cached } = await stack();
    const before = projection.readContextGraphAuthorityFactsRevision(CG);
    const update = raw.update.bind(raw);
    vi.spyOn(raw, 'update').mockImplementation(async (...args) => {
      if (committed) await update(...args);
      throw new Error('lost lifecycle response');
    });
    await expect(lifecycle({ contextGraphId: CG, agentAddress: AUTHOR, name: 'asset',
      publishedUal: `did:dkg:base:84532/${AUTHOR}/1`, merkleRoot: 'ab'.repeat(32) })).rejects.toThrow('lost lifecycle response');
    expect(projection.readContextGraphAuthorityFactsRevision(CG)).toBe(before);
    const query = vi.spyOn(raw, 'query');
    expect(await projection.get(CG)).toEqual(cached);
    expect(query).not.toHaveBeenCalled();
  });

});
