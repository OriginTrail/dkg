// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint, type Quad } from '@origintrail-official/dkg-storage';
import { compactSyncedPrivateRosterGenerations, readPrivateRosterGeneration,
  RFC64_PRIVATE_ROSTER_VERSION_PREDICATE_V1 as predicate } from '../src/private-roster-version.js';

const contextGraphId = `roster-generation-${randomUUID()}`;
const subject = contextGraphDataGraphUri(contextGraphId);
const graph = contextGraphMetaGraphUri(contextGraphId);
const generation = (value: string): Quad => ({ subject, graph, predicate,
  object: `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>` });

describe('private roster generation compaction (live Blazegraph, #3245)', () => {
  let store: BlazegraphStore;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>>;

  beforeAll(async () => {
    const endpoint = process.env.BLAZEGRAPH_TEST_URL;
    if (!endpoint) throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint) });
    handles = await manager.acquireMany([contextGraphId]);
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 15_000 });
  });
  afterAll(async () => {
    if (store) await store.close();
    if (handles) await manager.disposeAll(handles);
  });

  it('keeps only the newest value after generation 1, 2, 3 and a stale replay of 2', async () => {
    for (const value of ['1', '2', '3', '2']) {
      const page = [generation(value)];
      await store.insert(page);
      await compactSyncedPrivateRosterGenerations(store, page);
    }
    const rows = await store.query(`SELECT ?v WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?v } }`);
    expect(rows.type === 'bindings' ? rows.bindings : []).toHaveLength(1);
    expect(await readPrivateRosterGeneration(store, contextGraphId)).toBe('3');
  });

  it('bounds accumulated history without hiding malformed values or touching another graph or subject', async () => {
    const foreign = { ...generation('1'), graph: `${graph}-foreign` };
    const another = { ...generation('1'), subject: `${subject}/another` };
    const invalid = { ...generation('1'), object: '"bad"' };
    const language = { ...generation('2'), object: '"2"@en' };
    const history = Array.from({ length: 200 }, (_, i) => generation(String(i)));
    await store.insert([...history, foreign, another, invalid, language]);
    await compactSyncedPrivateRosterGenerations(store, [generation('199')]);
    const rows = await store.query(`SELECT ?s ?g ?v WHERE { GRAPH ?g { ?s <${predicate}> ?v } }`);
    expect(rows.type === 'bindings' ? rows.bindings : []).toHaveLength(5);
    await expect(readPrivateRosterGeneration(store, contextGraphId)).rejects.toThrow('not canonical');
    expect(await store.hasGraph(foreign.graph)).toBe(true);
  });
});
