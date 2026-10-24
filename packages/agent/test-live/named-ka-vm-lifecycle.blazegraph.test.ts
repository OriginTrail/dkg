import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint, createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { applyPublishedNamedKaVmLifecycle, createPublishedNamedKaVmLifecycleWriter, type PublishedNamedKaVmLifecycleWriter } from '../src/named-ka-vm-lifecycle.js';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';

// This explicit backend suite requires its CI/local lane to provide a Blazegraph endpoint.
describe('named KA lifecycle scoped update (live Blazegraph)', () => {
  const namespace = `agent-lifecycle-${randomUUID()}`;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  let store: TripleStore | undefined;
  let composed: TripleStore;
  let writer: PublishedNamedKaVmLifecycleWriter;
  let directory: string | undefined;

  beforeAll(async () => {
    const endpoint = process.env.BLAZEGRAPH_TEST_URL;
    if (!endpoint) throw new Error('BLAZEGRAPH_TEST_URL is required');
    manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint), requestTimeoutMs: 10_000 });
    expect(new URL(manager.sparqlUrl(namespace)).pathname).not.toBe(new URL(endpoint).pathname);
    handles = await manager.acquireMany([namespace]);
    directory = await mkdtemp(join(tmpdir(), 'named-ka-lifecycle-'));
    composed = await createTripleStore({
      backend: 'blazegraph', options: { url: handles[0]!.sparqlUrl, timeout: 10_000 },
      graphSetIndex: true, changelog: true,
      largeLiteralStorage: { enabled: true, directory, thresholdBytes: 4096 },
    });
    const executeMutation = createObservedStoreMutation(() => {});
    store = createMutationObservedStore(composed, executeMutation);
    writer = createPublishedNamedKaVmLifecycleWriter({ updateStore: composed, fallbackStore: store, executeMutation });
  });
  afterAll(async () => {
    try { await store?.close(); } finally {
      try { if (handles.length) await manager.disposeAll(handles); }
      finally { if (directory) await rm(directory, { recursive: true, force: true }); }
    }
  });

  it.each([true, false])('equals ordered fallback through all decorators (packed=%s)', async packed => {
    const value = {
      contextGraphId: `urn:test:lifecycle-${randomUUID()}`, agentAddress: '0x1111111111111111111111111111111111111111',
      name: 'asset', subGraphName: 'scope', merkleRoot: 'ab'.repeat(32),
      publishedUal: 'did:test:quote"\\slash\nline', packedKaId: packed ? 42n : undefined,
    };
    const graph = contextGraphMetaUri(value.contextGraphId);
    const subject = assertionLifecycleUri(value.contextGraphId, value.agentAddress, value.name, value.subGraphName);
    const seed = ['"old-a"', '"old-b"'].map(object => ({ graph, subject, predicate: 'http://dkg.io/ontology/state', object }));
    seed.push({ graph, subject, predicate: 'http://dkg.io/ontology/assertionVersion', object: '"19"' });
    seed.push({ graph, subject, predicate: 'http://dkg.io/ontology/assertionGraph', object: 'urn:retained:pointer' });
    const read = async () => {
      const result = await store!.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
      if (result.type !== 'bindings') throw new Error('Expected bindings');
      return result.bindings.map(row => JSON.stringify([row.s, row.p, row.o])).sort();
    };
    await store!.insert(seed);
    const update = vi.spyOn(composed, 'update');
    await writer(value);
    expect(update).toHaveBeenCalledTimes(1);
    const fast = await read();
    expect(fast).toHaveLength(packed ? 8 : 7);
    update.mockRestore();
    await store!.dropGraph(graph); await store!.insert(seed);
    const fallback = new Proxy(store!, { get(target, property) {
      if (property === 'update') return undefined;
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    } });
    await applyPublishedNamedKaVmLifecycle(fallback, value);
    expect(await read()).toEqual(fast);
    await writer(value);
    expect(await read()).toEqual(fast);
    expect(await store!.listGraphs()).toContain(graph);
  });
});
