import { afterEach, expect, it, vi } from 'vitest';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import { buildBulkAtomicIngestPlan } from '../src/adapters/bulk-atomic-ingest.js';
import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '../src/atomic-graph-replace.js';
import { StorePriorityScheduler } from '../src/store-priority-scheduler.js';
import { asGraphWriteRevisionSource } from '../src/graph-write-gen.js';
import { startOxigraphSparqlEndpoint, type OxigraphSparqlEndpoint } from './helpers/oxigraph-sparql-endpoint.js';
import type { Quad } from '../src/triple-store.js';

const graph = 'urn:bulk:data';
const meta = 'urn:bulk:meta';
const subject = 'urn:bulk:asset';
const quad = (object: string, g = graph, s = subject): Quad => ({ subject: s, predicate: 'urn:p', object, graph: g });
const data = [quad('"new"')];
const metadata = [quad('"confirmed"', meta)];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function setup() {
  const endpoint = await startOxigraphSparqlEndpoint();
  cleanups.push(endpoint.close);
  endpoint.store.update(`INSERT DATA { GRAPH <${graph}> { <${subject}> <urn:p> "old" } GRAPH <${meta}> { <${subject}> <urn:p> "old-meta" . <urn:other> <urn:p> "keep" } }`);
  const store = new SparqlHttpStore({ ...endpoint, consistencyProfile: 'atomic-readback', bulkAtomicIngest: { format: 'n-quads' } });
  cleanups.push(() => store.close());
  return { endpoint, store };
}
function visible(endpoint: OxigraphSparqlEndpoint) {
  return endpoint.store.match().filter(q => [graph, meta].includes(q.graph.value))
    .map(q => [q.graph.value, q.subject.value, q.object.value].join(' ')).sort();
}
function staging(endpoint: OxigraphSparqlEndpoint) {
  return endpoint.store.match().filter(q => q.graph.value.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX));
}
function intercept(hook: (init: RequestInit, forward: () => Promise<Response>) => Promise<Response>) {
  const fetchOriginal = globalThis.fetch;
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => hook(init!, () => fetchOriginal(input, init)));
}
const contentType = (init: RequestInit) => (init.headers as Record<string, string>)['Content-Type']?.split(';')[0];
const publishing = (init: RequestInit) => String(init.body).startsWith('DELETE ');
const replace = (store: SparqlHttpStore, d = data, m = metadata, signal?: AbortSignal) => store.replaceGraphAndSubject(graph, d, meta, subject, m, { signal });

it('loads hidden RDF, validates counts, and atomically publishes data + metadata', async () => {
  const { endpoint, store } = await setup();
  const before = visible(endpoint);
  const requests: string[] = [];
  intercept(async (init, forward) => {
    requests.push(contentType(init));
    if (publishing(init)) {
      expect(visible(endpoint)).toEqual(before);
      expect(staging(endpoint)).toHaveLength(2);
      expect(String(init.body)).not.toContain('INSERT DATA');
      expect(asGraphWriteRevisionSource(store)?.getWriteRevision('urn:bulk:').stable).toBe(false);
    }
    return forward();
  });
  await replace(store);
  expect(requests).toEqual(['application/n-quads', 'application/sparql-update', 'application/sparql-query', 'application/sparql-update']);
  expect(visible(endpoint)).toEqual([
    `${graph} ${subject} new`, `${meta} ${subject} confirmed`, `${meta} urn:other keep`,
  ].sort());
  expect(staging(endpoint)).toHaveLength(0);
  expect(asGraphWriteRevisionSource(store)?.getWriteRevision('urn:bulk:').stable).toBe(true);
  expect(await store.listGraphs()).toEqual(expect.arrayContaining([graph, meta]));
});

it('preserves Unicode, escape variants, language tags, datatypes and duplicate RDF terms', async () => {
  const { endpoint, store } = await setup();
  const objects = ['"é😀"', '"\\u00E9\\U0001F600"', '"é😀"^^<http://www.w3.org/2001/XMLSchema#string>', '"bonjour"@fr', '"0042"^^<urn:custom>', '"quote\\\" slash\\\\"', 'urn:iri:é'];
  await replace(store, objects.map(o => quad(o)));
  expect(endpoint.store.match().filter(q => q.graph.value === graph)).toHaveLength(5);
  expect(staging(endpoint)).toHaveLength(0);
});

it('uses the certified Blazegraph ASCII dialect only when explicitly selected', () => {
  const plan = buildBulkAtomicIngestPlan(graph, [quad('"é😀"')], meta, subject, metadata, 'blazegraph-n-quads')!;
  expect(plan.nquads).toContain('\\u00E9\\uD83D\\uDE00');
  expect(plan.nquads).not.toMatch(/[^\x00-\x7f]/);
});

it('uses existing atomic SPARQL for empty data and backend-ambiguous value aliases', async () => {
  const { endpoint, store } = await setup();
  const requests: string[] = [];
  intercept(async (init, forward) => { requests.push(contentType(init)); return forward(); });
  await replace(store, [quad('"01"^^<http://www.w3.org/2001/XMLSchema#integer>'), quad('"1"^^<http://www.w3.org/2001/XMLSchema#integer>')]);
  await replace(store, [], []);
  expect(requests).toEqual(['application/sparql-update', 'application/sparql-update']);
  expect(visible(endpoint)).toEqual([`${meta} urn:other keep`]);
});

it('allows empty metadata while replacing data', async () => {
  const { endpoint, store } = await setup();
  await replace(store, data, []);
  expect(visible(endpoint)).toEqual([`${graph} ${subject} new`, `${meta} urn:other keep`].sort());
});

it('falls back before upload when the bounded staging buffer would overflow', () => {
  const large = Array.from({ length: 40 }, (_, i) => quad(`"${'a'.repeat(1024 * 1024)}${i}"`));
  expect(buildBulkAtomicIngestPlan(graph, large, meta, subject, metadata, 'n-quads')).toBeNull();
});

it.each(['best-effort', 'atomic-update'] as const)('does not grant bulk ingestion to %s endpoints', consistencyProfile => {
  expect(() => new SparqlHttpStore({ queryEndpoint: 'http://localhost', consistencyProfile, bulkAtomicIngest: { format: 'n-quads' } })).toThrow(/requires atomic-readback/);
});

it('does not enable RDF loading without the option', async () => {
  const { endpoint } = await setup();
  const store = new SparqlHttpStore({ ...endpoint, consistencyProfile: 'atomic-readback' });
  cleanups.push(() => store.close());
  const requests: string[] = [];
  intercept(async (init, forward) => { requests.push(contentType(init)); return forward(); });
  await replace(store);
  expect(requests).toEqual(['application/sparql-update']);
});

it.each([
  [quad('"bad"', 'urn:wrong')],
  [{ ...quad('"bad"'), subject: '_:blank' }],
  [quad('"unterminated')],
  [quad('"' + 'x'.repeat(65536) + '"')],
])('rejects invalid input before any HTTP request (%#)', async invalid => {
  const { store } = await setup();
  const spy = vi.spyOn(globalThis, 'fetch');
  await expect(replace(store, invalid)).rejects.toThrow();
  expect(spy).not.toHaveBeenCalled();
});

it.each([202, 400, 500, 302])('does not publish or fall back after bulk HTTP %s', async status => {
  const { endpoint, store } = await setup();
  const before = visible(endpoint);
  const requests: RequestInit[] = [];
  intercept(async (init, forward) => {
    requests.push(init);
    return contentType(init) === 'application/n-quads' ? new Response('refused', { status }) : forward();
  });
  await expect(replace(store)).rejects.toThrow();
  expect(visible(endpoint)).toEqual(before);
  expect(requests.some(publishing)).toBe(false);
  expect(requests.filter(i => String(i.body).startsWith('DROP SILENT'))).toHaveLength(1);
});

it.each(['partial', 'bad-json', 'missing-receipt', 'too-large'])('refuses %s staging evidence and cleans only owned staging graphs', async failure => {
  const { endpoint, store } = await setup();
  const orphan = ATOMIC_GRAPH_REPLACE_STAGING_PREFIX + 'unrelated-operation';
  endpoint.store.update(`INSERT DATA { GRAPH <${orphan}> { <urn:s> <urn:p> "keep" } }`);
  const before = visible(endpoint);
  let published = false;
  intercept(async (init, forward) => {
    published ||= publishing(init);
    if (contentType(init) === 'application/n-quads') {
      endpoint.store.load(String(init.body).split('\n')[0], { format: 'application/n-quads' });
      return new Response('');
    }
    if (String(init.body).startsWith('ASK') && failure !== 'partial') {
      if (failure === 'bad-json') return new Response('{');
      if (failure === 'too-large') return new Response('x'.repeat(65537));
      return new Response(JSON.stringify({ boolean: false }));
    }
    return forward();
  });
  await expect(replace(store)).rejects.toThrow();
  expect(published).toBe(true); // Guarded update was dispatched, but its count guard forbids publication.
  expect(visible(endpoint)).toEqual(before);
  expect(staging(endpoint)).toHaveLength(1);
  expect(staging(endpoint)[0].graph.value).toBe(orphan);
  expect(await store.listGraphs()).not.toContain(orphan);
});

it('treats a lost publication response as indeterminate, never a retry-safe refusal', async () => {
  const { endpoint, store } = await setup();
  intercept(async (init, forward) => {
    const response = await forward();
    if (publishing(init)) throw new Error('connection lost after commit');
    return response;
  });
  await expect(replace(store)).rejects.toThrow('connection lost after commit');
  expect(visible(endpoint)).toContain(`${graph} ${subject} new`);
  expect(asGraphWriteRevisionSource(store)?.getWriteRevision('urn:bulk:').stable).toBe(false);
  expect(staging(endpoint)).toHaveLength(0);
});

it('does not publish if aborted after staging and before publication', async () => {
  const { endpoint, store } = await setup();
  const before = visible(endpoint);
  const controller = new AbortController();
  let published = false;
  intercept(async (init, forward) => {
    published ||= publishing(init);
    const response = await forward();
    if (contentType(init) === 'application/n-quads') controller.abort(new Error('cancelled'));
    return response;
  });
  await expect(replace(store, data, metadata, controller.signal)).rejects.toThrow();
  expect(published).toBe(false);
  expect(visible(endpoint)).toEqual(before);
});

it('does not fall back or publish after a refused final transaction', async () => {
  const { endpoint, store } = await setup();
  const before = visible(endpoint);
  let publications = 0;
  intercept(async (init, forward) => {
    if (publishing(init)) { publications++; return new Response('transaction refused', { status: 500 }); }
    return forward();
  });
  await expect(replace(store)).rejects.toThrow('transaction refused');
  expect(publications).toBe(1);
  expect(visible(endpoint)).toEqual(before);
  expect(staging(endpoint)).toHaveLength(0);
});

it('requires the complete publication response, not merely successful headers', async () => {
  const { endpoint, store } = await setup();
  intercept(async (init, forward) => {
    const response = await forward();
    if (publishing(init)) return new Response(new ReadableStream({ start(controller) {
      controller.error(new Error('publication body interrupted'));
    } }));
    return response;
  });
  await expect(replace(store)).rejects.toThrow('publication body interrupted');
  expect(visible(endpoint)).toContain(`${graph} ${subject} new`);
  expect(asGraphWriteRevisionSource(store)?.getWriteRevision('urn:bulk:').stable).toBe(false);
});

it('guards stage counts inside the transaction when staging disappears after upload', async () => {
  const { endpoint, store } = await setup();
  const before = visible(endpoint);
  intercept(async (init, forward) => {
    if (publishing(init)) {
      const stage = /AS \?dataCount\) WHERE \{ GRAPH <([^>]+)>/.exec(String(init.body))![1];
      endpoint.store.update(`DROP GRAPH <${stage}>`);
    }
    return forward();
  });
  await expect(replace(store)).rejects.toThrow(/receipt missing/);
  expect(visible(endpoint)).toEqual(before);
  expect(staging(endpoint)).toHaveLength(0);
});

it('uses one scheduler slot and signal for upload, publication, receipt, and cleanup', async () => {
  const { endpoint } = await setup();
  const scheduler = new StorePriorityScheduler({ maxConcurrent: 1, ackReservedSlots: 0, healthReservedSlots: 0 });
  const store = new SparqlHttpStore({ ...endpoint, scheduler, consistencyProfile: 'atomic-readback', bulkAtomicIngest: { format: 'n-quads' } });
  cleanups.push(() => store.close());
  const signals = new Set<AbortSignal | null | undefined>();
  intercept(async (init, forward) => {
    signals.add(init.signal);
    expect(scheduler.snapshot.normalInflight).toBe(1);
    return forward();
  });
  await replace(store);
  expect(signals.size).toBe(1);
  expect(scheduler.snapshot.normalInflight).toBe(0);
});
