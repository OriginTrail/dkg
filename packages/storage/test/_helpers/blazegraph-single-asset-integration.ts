import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import type { Quad } from '../../src/triple-store.js';

/** Registered by the existing live-server suite and its required hosted lane. */
export function singleAssetTransactionTests(url: string): void {
describe('Blazegraph single asset transaction (live server)', () => {
  const scope = `urn:single-asset:${randomUUID()}`;
  const graph = `${scope}:data`, meta = `${scope}:meta`, subject = `${scope}:asset`;
  let store: BlazegraphStore;
  const rows = (version: string, count: number): Quad[] => Array.from({ length: count }, (_, i) => ({
    graph, subject: `${scope}:item:${i}`, predicate: 'urn:value', object: JSON.stringify(`${version}: café 😀:${i}`),
  }));
  const metadata = (version: string): Quad[] => [{ graph: meta, subject, predicate: 'urn:version', object: JSON.stringify(version) }];
  const sentinel: Quad = { graph: meta, subject: `${scope}:unrelated`, predicate: 'urn:value', object: '"keep"' };
  const read = async () => {
    const result = await store.query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o }
      FILTER(?g IN (<${graph}>, <${meta}>)) }`);
    if (result.type !== 'bindings') throw new Error('Expected complete bindings');
    return result.bindings.map(row => JSON.stringify(row)).sort();
  };
  const expected = (data: Quad[], properties: Quad[]) => [...data, ...properties, sentinel]
    .map(q => JSON.stringify({ g: q.graph, s: q.subject, p: q.predicate, o: q.object })).sort();
  const replace = (data: Quad[], properties: Quad[]) => store.replaceGraphAndSubject(graph, data, meta, subject, properties);

  beforeAll(async () => {
    store = new BlazegraphStore(url);
    await store.insert([sentinel]);
  });
  afterAll(async () => {
    await store.update(`DROP SILENT GRAPH <${graph}>; DROP SILENT GRAPH <${meta}>`);
    await store.close();
  });

  it('replaces stale rows, replays exactly, and clears only its own destinations', async () => {
    await replace(rows('old', 5), metadata('old'));
    const data = rows('new', 300), properties = metadata('new');
    await replace(data, properties);
    expect(await read()).toEqual(expected(data, properties));
    await replace(data, properties);
    expect(await read()).toEqual(expected(data, properties));
    await replace([], []);
    expect(await read()).toEqual(expected([], []));
  });

  it('rolls back data and metadata when the last statement fails at execution', async () => {
    await replace(rows('old', 300), metadata('old'));
    const before = await read(), transport = globalThis.fetch;
    let injected = false;
    const intercept = vi.spyOn(globalThis, 'fetch').mockImplementation((request, init) => {
      if (!injected && new Headers(init?.headers).get('content-type')?.includes('sparql-update')) {
        injected = true;
        // The nonempty metadata graph exists. This fails after the replacement
        // statements have executed, rather than rejecting parsing up front.
        return transport(request, { ...init, body: `${init!.body}; CREATE GRAPH <${meta}>` });
      }
      return transport(request, init);
    });
    try {
      await expect(replace(rows('rejected', 1000), metadata('rejected'))).rejects.toThrow();
      expect(injected).toBe(true);
      expect(await read()).toEqual(before);
    } finally { intercept.mockRestore(); }
  });

  it('exposes old or new data and metadata together to concurrent readers', async () => {
    const oldData = rows('before', 300), oldMeta = metadata('before');
    const newData = rows('after', 3000), newMeta = metadata('after');
    await replace(oldData, oldMeta);
    const before = expected(oldData, oldMeta), after = expected(newData, newMeta);
    const seen = [await read()];
    let settled = false;
    const writing = replace(newData, newMeta).finally(() => { settled = true; });
    // Attach rejection handling immediately; assertion/teardown still awaits it.
    writing.catch(() => undefined);
    try {
      do { seen.push(await read()); } while (!settled);
      await writing;
      seen.push(await read());
      expect(seen[0]).toEqual(before);
      expect(seen.at(-1)).toEqual(after);
      for (const snapshot of seen) {
        expect([JSON.stringify(before), JSON.stringify(after)]).toContain(JSON.stringify(snapshot));
      }
    } finally { await writing; }
  });
});
}
