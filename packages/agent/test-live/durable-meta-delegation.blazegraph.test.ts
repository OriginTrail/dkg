// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlazegraphStore,
  BlazegraphNamespaceManager,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '@origintrail-official/dkg-storage';
import { durableMetaDelegationSubjectAdmissionExpression } from '../src/sync/responder/durable-meta-admission.js';
import { durableMetaDelegations } from '../test/_helpers/durable-meta-delegations.js';
import { linesFromNquads, registerTestSyncHandler } from '../test/_helpers/sync-responder.js';

const contextGraphId = `delegation-admission-${randomUUID()}`;
const fixture = durableMetaDelegations(contextGraphId);

describe('active member delegation admission (live Blazegraph, #3186)', () => {
  let store: BlazegraphStore;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>>;

  beforeAll(async () => {
    const endpoint = process.env.BLAZEGRAPH_TEST_URL;
    if (!endpoint) throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint),
    });
    handles = await manager.acquireMany([contextGraphId]);
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 15_000 });
    await store.insert(fixture.quads);
  });

  afterAll(async () => {
    if (store) await store.close();
    if (handles) await manager.disposeAll(handles);
  });

  it('admits allowed and participant delegates while enforcing revocation and graph scope', async () => {
    const result = await store.query(`
      SELECT DISTINCT ?s WHERE {
        VALUES ?g { <${fixture.metaGraph}> }
        GRAPH ?g { ?s ?p ?o }
        FILTER(${durableMetaDelegationSubjectAdmissionExpression(contextGraphId)})
      }
    `);
    expect(result.type).toBe('bindings');
    expect(result.type === 'bindings' ? new Set(result.bindings.map((row) => row['s'])) : null)
      .toEqual(fixture.admittedSubjects);
  });

  it('serves every active delegation through the real paged responder, matching the snapshot lane', async () => {
    const snapshot = registerTestSyncHandler(store, { syncPageSize: 100 });
    const paged = registerTestSyncHandler(store, {
      syncPageSize: 2,
      snapshotBudget: {
        maxRows: 1_000_000,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const common = { contextGraphId, includeSharedMemory: false, phase: 'meta' as const };
    const canonical = linesFromNquads(await snapshot.invoke({
      ...common, offset: 0, limit: 100, syncSessionId: 'snapshot',
    }));
    const received: string[] = [];
    let completed = false;
    for (let offset = 0; offset < 100; offset += 2) {
      const page = linesFromNquads(await paged.invoke({
        ...common, offset, limit: 2, syncSessionId: 'paged',
      }));
      received.push(...page);
      if (page.length < 2) { completed = true; break; }
    }
    expect(completed).toBe(true);
    // Subject-atomic pages can overlap an offset boundary; compare their union.
    const receivedRows = new Set(received);
    expect(receivedRows).toEqual(new Set(canonical));
    expect(receivedRows.size).toBe(fixture.admittedRows.length);
    for (const row of fixture.admittedRows) {
      expect(received).toContain(`<${row.subject}> <${row.predicate}> ${row.object} <${row.graph}> .`);
    }
  });
});
