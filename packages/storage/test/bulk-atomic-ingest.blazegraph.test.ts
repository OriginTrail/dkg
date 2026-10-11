/** Opt-in native-engine contract checks; supply an owned BLAZEGRAPH_TEST_URL. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import type { Quad } from '../src/triple-store.js';

const endpoint = process.env.BLAZEGRAPH_TEST_URL;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture() {
  const prefix = `urn:bulk-native-test:${randomUUID()}:`;
  const graph = prefix + 'data', meta = prefix + 'meta', subject = prefix + 'asset';
  const legacy = new SparqlHttpStore({ queryEndpoint: endpoint!, consistencyProfile: 'atomic-readback' });
  const bulk = new SparqlHttpStore({ queryEndpoint: endpoint!, consistencyProfile: 'atomic-readback', bulkAtomicIngest: { format: 'blazegraph-n-quads' } });
  cleanup.push(async () => {
    await legacy.update(`DROP SILENT GRAPH <${graph}>; DROP SILENT GRAPH <${meta}>`);
    await bulk.close();
    await legacy.close();
  });
  const quad = (object: string, g = graph): Quad => ({ subject, predicate: 'urn:p', object, graph: g });
  const replace = (store: SparqlHttpStore, objects: string[], marker: string) => store.replaceGraphAndSubject(
    graph, objects.map(o => quad(o)), meta, subject, [quad(`"${marker}"`, meta)],
  );
  const read = () => legacy.query(`SELECT ?g ?o WHERE { VALUES ?g { <${graph}> <${meta}> } GRAPH ?g { <${subject}> <urn:p> ?o } } ORDER BY ?g ?o`);
  return { legacy, bulk, replace, read };
}
const publication = (init?: RequestInit) => String(init?.body).startsWith('DELETE ');

describe.skipIf(!endpoint)('bulk atomic ingestion on native Blazegraph', () => {
  it('round-trips Unicode, typed values and escaped duplicates like the SPARQL path', async () => {
    const { legacy, bulk, replace, read } = await fixture();
    const objects = ['"é😀"', '"bonjour"@fr', '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', '"quote\\\" slash\\\\"', 'urn:iri:é'];
    await replace(legacy, objects, 'new-meta');
    const expected = await read();
    await replace(legacy, ['"old"'], 'old-meta');
    const before = await read();
    const fetchOriginal = globalThis.fetch;
    let checkedOld = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (publication(init)) { expect(await read()).toEqual(before); checkedOld = true; }
      return fetchOriginal(input, init);
    });
    // Blazegraph SPARQL itself rejects the long UCHAR form; the bulk wire
    // dialect supports it and deduplicates it with the equivalent raw literal.
    await replace(bulk, [...objects, '"\\u00E9\\U0001F600"'], 'new-meta');
    expect(checkedOld).toBe(true);
    expect(await read()).toEqual(expected);
  });

  it('does not acknowledge a disappeared stage even when the engine would silently accept MOVE', async () => {
    const { legacy, bulk, replace, read } = await fixture();
    await replace(legacy, ['"old"'], 'old-meta');
    const before = await read();
    const fetchOriginal = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (publication(init)) {
        const stage = /AS \?dataCount\) WHERE \{ GRAPH <([^>]+)>/.exec(String(init!.body))![1];
        const response = await fetchOriginal(input, { ...init, body: `DROP GRAPH <${stage}>` });
        expect(response.ok).toBe(true);
        await response.text();
      }
      return fetchOriginal(input, init);
    });
    await expect(replace(bulk, ['"new"'], 'new-meta')).rejects.toThrow(/receipt missing/);
    expect(await read()).toEqual(before);
  });

  it('surfaces a lost publication response as an error while preserving a coherent committed pair', async () => {
    const { legacy, bulk, replace, read } = await fixture();
    await replace(legacy, ['"new"'], 'new-meta');
    const expected = await read();
    await replace(legacy, ['"old"'], 'old-meta');
    const fetchOriginal = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const response = await fetchOriginal(input, init);
      if (publication(init)) { await response.text(); throw new Error('lost commit response'); }
      return response;
    });
    await expect(replace(bulk, ['"new"'], 'new-meta')).rejects.toThrow('lost commit response');
    expect(await read()).toEqual(expected);
  });
});
