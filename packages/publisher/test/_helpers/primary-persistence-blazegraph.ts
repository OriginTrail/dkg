import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  BlazegraphNamespaceManager,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
  createTripleStore,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../../src/async-lift-publisher-impl.js';
import {
  CONTROL_PAYLOAD,
  DEFAULT_JOURNAL_GRAPH_URI,
  jobSubject,
  requestSubject,
  serializeJobRecord,
} from '../../src/async-lift-control-plane.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../../scripts/testing/ka-vm-publish.js';

export function registerPrimaryPersistenceBlazegraphCases({
  endpoint, decorateStore, proofPrefix,
}: {
  endpoint: string;
  decorateStore: (store: TripleStore) => TripleStore;
  proofPrefix: 'publisher' | 'agent';
}): void {
  const namespace = `${proofPrefix}-primary-${randomUUID()}`;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  let store: TripleStore | undefined;
  let directory: string | undefined;

  beforeAll(async () => {
    manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint), requestTimeoutMs: 10_000,
    });
    expect(new URL(manager.sparqlUrl(namespace)).pathname).not.toBe(new URL(endpoint).pathname);
    handles = await manager.acquireMany([namespace]);
  }, 30_000);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'publisher-primary-'));
    const composed = await createTripleStore({
      backend: 'blazegraph', options: { url: handles[0]!.sparqlUrl, timeout: 10_000 },
      graphSetIndex: true, changelog: true,
      largeLiteralStorage: { enabled: true, directory, thresholdBytes: 128 },
    });
    expect(composed.constructor.name).toBe('ChangelogStore');
    store = decorateStore(composed);
    expect(typeof store.replaceSubjectAndInsert).toBe('function');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try { await store?.close(); } finally {
      store = undefined;
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  afterAll(async () => {
    if (handles.length > 0) {
      expect(handles).toHaveLength(1);
      expect(handles[0]!.namespace).toBe(namespace);
      expect(handles[0]!.sparqlUrl).toBe(manager.sparqlUrl(namespace));
      await manager.disposeAll(handles);
    }
  }, 30_000);

  async function prepared() {
    const id = randomUUID();
    // A shared-memory-shaped owned graph exercises actual large-literal externalization.
    const graph = `urn:test:publisher-primary:${id}/_shared_memory`;
    let sequence = 0;
    let now = 1_000;
    const publisher = new TripleStoreAsyncLiftPublisher(store!, {
      graphUri: graph, journalWrites: true, autoRetryEnabled: false,
      now: () => ++now, idGenerator: () => `${id}-${++sequence}`,
    });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ name: id }));
    await publisher.claimNext(`wallet-${id}`);
    const job = (await publisher.getStatus(jobId))!;
    const request = serializeJobRecord(job, graph).requestQuads;
    const extra = { graph, subject: requestSubject(jobId), predicate: 'urn:test:extra', object: '"retained"' };
    await store!.insert([extra, { ...extra, subject: `urn:test:unrelated:${id}` }]);
    const fullRequest = await rows(store!, graph, requestSubject(jobId));
    expect(await store!.deleteByPattern({ graph, subject: requestSubject(jobId), predicate: request[0]!.predicate })).toBe(1);
    const damagedRequest = await rows(store!, graph, requestSubject(jobId));
    expect(damagedRequest).toHaveLength(fullRequest.length - 1);
    const work = vi.fn();
    publisher.reconciliationScheduling.attachScheduler({
      onWorkAvailable: work, onWalletRelease() {}, onReconciliationDemand() {},
    });
    return { publisher, jobId, graph, fullRequest, damagedRequest, work };
  }

  // Forward the real transport, altering ONLY the exact publisher primary update when armed.
  // No production fault-injection interface and no synthetic server response is introduced.
  function observePrimary(graph: string, jobId: string, mode: 'success' | 'parse' | 'rollback', witness: string) {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const responses: Array<{ status: number; text: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body;
      const contentType = new Headers(init?.headers).get('content-type') ?? '';
      const isPrimary = url === handles[0]!.sparqlUrl && contentType.includes('application/sparql-update')
        && typeof body === 'string' && body.includes(`<${graph}>`) && body.includes(`<${jobSubject(jobId)}>`)
        && body.includes(`<${CONTROL_PAYLOAD}>`);
      if (!isPrimary) return originalFetch(input, init);
      requests.push(body);
      // Never contaminate an accidental replay: record it, then send the real unmodified body.
      if (requests.length !== 1) return originalFetch(input, init);
      const tail = mode === 'parse' ? '\n; THIS IS NOT SPARQL'
        : mode === 'rollback'
          ? `\n; INSERT DATA { GRAPH <${witness}> { <${witness}:s> <urn:test:p> "witness" } }; CREATE GRAPH <${witness}>`
          : '';
      const augmentedUpdate = body + tail;
      const response = await originalFetch(input, { ...init, body: augmentedUpdate });
      const responseBody = await response.clone().text();
      responses.push({ status: response.status, text: responseBody });
      const proofDirectory = process.env.BLAZEGRAPH_PROOF_DIR;
      if (proofDirectory) {
        const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
        // The caller creates a fresh local evidence directory. Fixed mode filenames and wx
        // preserve earlier attempts; only synthetic UPDATEs and the server response are stored.
        await writeFile(join(proofDirectory, `${proofPrefix}-${mode}.json`), JSON.stringify({
          schemaVersion: 1, layer: proofPrefix, mode,
          originalUpdate: body, augmentedUpdate,
          httpStatus: response.status, responseBody,
          sha256: {
            originalUpdate: sha256(body), augmentedUpdate: sha256(augmentedUpdate),
            responseBody: sha256(responseBody),
          },
        }, null, 2) + '\n', { flag: 'wx' });
      }
      return response;
    });
    return { requests, responses };
  }

  it('uses the complete composed capability and repairs request RDF in one primary update', async () => {
    const f = await prepared();
    const unrelatedBefore = (await rows(store!, f.graph)).filter((row) => row.includes('urn:test:unrelated:'));
    const compound = vi.spyOn(store!, 'replaceSubjectAndInsert');
    const insert = vi.spyOn(store!, 'insert');
    const observed = observePrimary(f.graph, f.jobId, 'success', `urn:test:unused:${randomUUID()}`);
    await f.publisher.update(f.jobId, 'validated', { validation: KA_VM_VALIDATION });
    expect(compound).toHaveBeenCalledOnce();
    expect(compound.mock.calls[0]?.[4]).toMatchObject({ source: 'publisher.asyncLift.writeJob' });
    expect(observed.requests).toHaveLength(1);
    expect(observed.requests[0]).toContain('http://dkg.io/ontology/externalLiteralRef');
    expect(observed.responses[0]?.status).toBeLessThan(300);
    expect(insert.mock.calls.some(([quads]) => quads.some((quad) => quad.subject === requestSubject(f.jobId)))).toBe(false);
    expect(await rows(store!, f.graph, requestSubject(f.jobId))).toEqual(f.fullRequest);
    expect((await rows(store!, f.graph)).filter((row) => row.includes('urn:test:unrelated:'))).toEqual(unrelatedBefore);
    const job = (await f.publisher.getStatus(f.jobId))!;
    expect(job).toMatchObject({ status: 'validated', validation: KA_VM_VALIDATION });
    const raw = await store!.query(`SELECT ?payload WHERE { GRAPH <${f.graph}> { <${jobSubject(f.jobId)}> <${CONTROL_PAYLOAD}> ?payload } }`);
    expect(raw.type === 'bindings' && raw.bindings[0]?.['payload']).toBe(
      serializeJobRecord(job, f.graph).jobQuads.find((q) => q.predicate === CONTROL_PAYLOAD)!.object,
    );
    expect(await store!.listGraphs()).toContain(f.graph);
    expect((await f.publisher.readJournalByJob(f.jobId)).entries.map((entry) => entry.kind)).toEqual(['admission', 'claimed', 'validated']);
  });

  it.each(['parse', 'rollback'] as const)('preserves exact primary RDF after settled %s rejection, without replay', async (mode) => {
    const f = await prepared();
    const witness = `urn:test:rollback-witness:${randomUUID()}`;
    expect(await store!.hasGraph(witness)).toBe(false);
    const primaryBefore = await rows(store!, f.graph);
    const journalBefore = await rows(store!, DEFAULT_JOURNAL_GRAPH_URI);
    const compound = vi.spyOn(store!, 'replaceSubjectAndInsert');
    const fallback = vi.spyOn(store!, 'replaceSubject');
    const insert = vi.spyOn(store!, 'insert');
    const observed = observePrimary(f.graph, f.jobId, mode, witness);
    await expect(f.publisher.update(f.jobId, 'validated', { validation: KA_VM_VALIDATION })).rejects.toThrow();
    expect(compound).toHaveBeenCalledOnce();
    expect(observed.requests).toHaveLength(1);
    expect(observed.responses).toHaveLength(1);
    expect(observed.responses[0]!.status).toBeGreaterThanOrEqual(400);
    if (mode === 'rollback') {
      // This settled execution error is distinct from syntax rejection or a transport timeout:
      // INSERT creates the fresh graph, CREATE then fails, and the whole request rolls back.
      expect(observed.responses[0]!.text).toMatch(/GraphExistsException/);
    } else {
      expect(observed.responses[0]!.text).toMatch(/MalformedQueryException|ParseException/);
      expect(observed.responses[0]!.text).not.toMatch(/GraphExistsException/);
    }
    expect(fallback).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(await rows(store!, f.graph)).toEqual(primaryBefore);
    expect(await rows(store!, f.graph, requestSubject(f.jobId))).toEqual(f.damagedRequest);
    expect(await rows(store!, DEFAULT_JOURNAL_GRAPH_URI)).toEqual(journalBefore);
    expect(await store!.hasGraph(witness)).toBe(false);
    expect(await rows(store!, witness)).toEqual([]);
    expect((await f.publisher.getStatus(f.jobId))?.status).toBe('claimed');
    expect(f.work).not.toHaveBeenCalled();
  });
}

async function rows(store: TripleStore, graph: string, subject?: string) {
  const pattern = subject ? `<${subject}> ?p ?o` : '?s ?p ?o';
  const result = await store.query(`SELECT * WHERE { GRAPH <${graph}> { ${pattern} } }`);
  if (result.type !== 'bindings') throw new Error('Expected RDF bindings');
  return result.bindings.map((row) => JSON.stringify(Object.entries(row).sort())).sort();
}
