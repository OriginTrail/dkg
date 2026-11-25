import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BlazegraphNamespaceManager, BlazegraphStore, blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PROMOTE_PAYLOAD, PROMOTE_STATE, jobSubject, serializeJobRecord } from '../src/async-promote-queue-utils.js';
import { mk, STARTED } from '../test/_helpers/share-retention-fixtures.js';

describe('operator retirement on Blazegraph', () => {
  let store: BlazegraphStore;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];

  beforeAll(async () => {
    const endpoint = process.env.BLAZEGRAPH_TEST_URL;
    if (!endpoint) throw new Error('BLAZEGRAPH_TEST_URL is required');
    manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint) });
    handles = await manager.acquireMany([`retirement-${randomUUID()}`]);
    store = new BlazegraphStore(handles[0]!.sparqlUrl);
  }, 60_000);

  afterAll(async () => {
    try { await store?.close(); } finally { if (handles.length) await manager.disposeAll(handles); }
  }, 60_000);

  async function seed(graph: string) {
    const id = 'failed-job';
    const job = mk(id, 'failed', { bound: true, commitMarker: STARTED,
      attempt: { count: 1, maxRetries: 5, lastError: { classification: 'fatal', retryable: false,
        recordedAt: 1_900_000_000_000, message: 'Write acknowledgment timed out' } } });
    await store.insert(serializeJobRecord(job, graph).jobQuads);
    const queue = new TripleStoreAsyncPromoteQueue(store, { graphUri: graph });
    const preview = await queue.retireFailedJob(id);
    if (preview.outcome !== 'eligible') throw new Error(`Unexpected preview: ${preview.outcome}`);
    return { id, queue, approval: { expectedJobSha256: preview.jobSha256, acceptUnknownEffects: true as const } };
  }

  async function objects(graph: string, subject: string, predicate: string) {
    const result = await store.query(`SELECT ?value WHERE { GRAPH <${graph}> { <${subject}> <${predicate}> ?value } }`);
    if (result.type !== 'bindings') throw new Error('Expected RDF bindings');
    return result.bindings.map(row => row.value);
  }

  it('archives the exact original payload and removes the active job', async () => {
    const graph = 'urn:test:retirement:success';
    const { id, queue, approval } = await seed(graph);
    const original = await objects(graph, jobSubject(id), PROMOTE_PAYLOAD);
    expect(original).toHaveLength(1);
    expect(await queue.retireFailedJob(id, approval)).toMatchObject({ outcome: 'retired' });
    expect(await objects(graph, jobSubject(id), PROMOTE_PAYLOAD)).toEqual([]);
    expect(await objects(`${graph}:retirements`, `urn:dkg:promote-queue:abandoned-job:${id}`,
      'urn:dkg:promote-queue:abandoned:originalFailedPayload')).toEqual(original);
    expect(await queue.clearTerminalJob(id)).toEqual({ outcome: 'already_absent' });
  });

  it('leaves the original in place if its index changes just before the atomic move', async () => {
    const graph = 'urn:test:retirement:changed';
    const { id, queue, approval } = await seed(graph);
    const original = await objects(graph, jobSubject(id), PROMOTE_PAYLOAD);
    const update = store.update.bind(store);
    const changing = vi.spyOn(store, 'update').mockImplementationOnce(async (query, options) => {
      await update(`INSERT DATA { GRAPH <${graph}> { <${jobSubject(id)}> <${PROMOTE_STATE}> "running" } }`);
      await update(query, options);
    });
    try {
      expect(await queue.retireFailedJob(id, approval)).toMatchObject({ outcome: 'stale' });
    } finally { changing.mockRestore(); }
    expect(await objects(graph, jobSubject(id), PROMOTE_PAYLOAD)).toEqual(original);
    expect(await objects(`${graph}:retirements`, `urn:dkg:promote-queue:abandoned-job:${id}`,
      'urn:dkg:promote-queue:abandoned:originalFailedPayload')).toEqual([]);
  });
});
