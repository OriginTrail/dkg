// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { contextGraphWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, BlazegraphNamespaceManager, blazegraphNamespaceApiUrlFromSparqlEndpoint, type Quad } from '@origintrail-official/dkg-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSwmMetaPage } from '../src/sync/responder/graph-plan.js';
import { createGraphMembershipSnapshot } from '../src/sync/graph-membership-snapshot.js';

const URL = process.env.BLAZEGRAPH_TEST_URL;
const CG = `swm-meta-live-${randomUUID()}`;
const GRAPH = contextGraphWorkspaceMetaGraphUri(CG);
const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const CUTOFF = '2026-09-01T00:00:00.000Z';

function asset(index: number, timestamp: string): Quad[] {
  const ual = `did:dkg:evm:31337/0x1111111111111111111111111111111111111111/${index}`;
  const share = `share-${index}`;
  const op = `urn:dkg:share:${CG}:${share}`;
  const head = `${ual}#dkg-swm-head`;
  return [
    { subject: op, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation` },
    { subject: op, predicate: `${DKG}publishedAt`, object: `"${timestamp}"^^<${XSD}dateTime>` },
    ...[op, head].flatMap((subject) => [
      { subject, predicate: `${DKG}contentScopeVersion`, object: `"2"^^<${XSD}integer>` },
      { subject, predicate: `${DKG}kaUal`, object: ual },
      { subject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD}integer>` },
      { subject, predicate: `${DKG}shareOperationId`, object: `"${share}"` },
    ]),
    { subject: head, predicate: `${DKG}assertionGraph`, object: `did:dkg:context-graph:${CG}/_shared_memory/0x1111111111111111111111111111111111111111/${index}` },
  ].map((quad) => ({ ...quad, graph: GRAPH }));
}

describe('TTL shared-memory metadata (live Blazegraph)', () => {
  let store: BlazegraphStore;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>>;
  const fresh = [...asset(1, '2026-10-01T00:00:00.000Z'), ...asset(2, '2026-10-02T00:00:00.000Z')];
  const stale = asset(3, '2026-08-01T00:00:00.000Z');

  beforeAll(async () => {
    if (!URL) throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(URL) });
    handles = await manager.acquireMany([CG]);
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 15_000 });
    await store.insert([...fresh, ...stale]);
  });

  afterAll(async () => {
    if (store) {
      await store.close();
    }
    if (handles) await manager.disposeAll(handles);
  });

  it('serves every fresh operation and selected head, excluding expired assets', async () => {
    const rows = await readSwmMetaPage({
      store,
      graphMembership: createGraphMembershipSnapshot([GRAPH]),
      registeredSubGraphNames: [],
      contextGraphId: CG,
      cutoffIso: CUTOFF,
      offset: 0,
      limit: 100,
    });
    expect(rows).toHaveLength(fresh.length);
    expect(new Set(rows.map(({ s, p, o, g }) => JSON.stringify([s, p, o, g]))))
      .toEqual(new Set(fresh.map(({ subject, predicate, object, graph }) => JSON.stringify([subject, predicate, object, graph]))));
  });
});
