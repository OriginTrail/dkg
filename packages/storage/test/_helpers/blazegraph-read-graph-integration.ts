import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import { sparqlStatements } from '../../src/adapters/sparql-statements.js';
import { ADAPTER_SPARQL_TERM_POLICY } from '../../src/adapters/sparql-term-policy.js';
import type { AtomicAssetReplacement } from '../../src/atomic-asset-group.js';
import type { ReadGraphWriteOptions, ReadGraphWritePlan } from '../../src/read-graph/adapter-contract.js';
import {
  readGraphCopy,
  readGraphDeltaDelete,
  readGraphDeltaDeleteBySubjectPrefix,
  readGraphDeltaDeleteMatching,
  readGraphInsertQuads,
  readGraphReferenceProcedure,
  type ReadGraphTarget,
} from '../../src/read-graph/statements.js';
import type { Rfc64AuthorCommitCasSemanticInputV1 } from '../../src/rfc64-author-commit-cas.js';
import type { Quad } from '../../src/triple-store.js';
import { authorCommitInput } from '../rfc64-author-commit-cas-harness.js';

/**
 * Live checks that BlazegraphStore sends a write's read-graph operations in
 * the same request as its data change, at the right points of that request.
 *
 * The operations come from the read-graph statements: the reference
 * procedure, the delta forms of the deletes, and the insert quads. Member
 * graphs share one IRI prefix in a test context graph. After every write the
 * read graph R must equal the union of the member graphs. Operations sent at
 * the wrong point of the request leave R stale, and a request that fails
 * changes neither the data nor R.
 */
export function blazegraphReadGraphWriteTests(url: string): void {
describe('Blazegraph read-graph operations in the write request (live server)', () => {
  const cg = `rgint${randomUUID().slice(0, 8)}`;
  const base = `did:dkg:context-graph:${cg}`;
  const member = `${base}/_shared_memory/`;
  const R = readGraphIri({ scope: readScope(cg), layer: MemoryLayer.SharedWorkingMemory });
  const target: ReadGraphTarget = { readGraph: R, membership: { kind: 'prefix', prefix: member } };
  // Another context graph holds a copy of a shared triple; it must not keep the triple in R.
  const OUTSIDE = `did:dkg:context-graph:${cg}x/_shared_memory/0xbb/1`;
  const META = `${base}/_meta`;
  const [G1, G2, G3, G4, G5, G6, G7] = ['1', '2', '3', '4', '5', '6', '7'].map((n) => `${member}0xaa/${n}`);
  const P = 'urn:rg-int:p';
  const q = (s: string, o: string, graph: string): Quad => ({ subject: `urn:rg-int:${s}`, predicate: P, object: `"${o}"`, graph });
  const render = ADAPTER_SPARQL_TERM_POLICY.renderer({ adapter: 'blazegraph', operation: 'delete' }, () => {});
  const statements = sparqlStatements('blazegraph');

  const plan = (before: string[], after: string[]): ReadGraphWritePlan => ({ readGraphs: [R], before, after });
  /** The reference procedure over the touched graphs that are members. */
  const reference = (...touched: string[]): ReadGraphWritePlan => {
    const members = touched.filter((graph) => graph.startsWith(member));
    const { before, after } = readGraphReferenceProcedure(target, members, members);
    return plan(before, after);
  };
  const planned = (p: ReadGraphWritePlan): ReadGraphWriteOptions => ({ readGraphPlan: p });

  let store: BlazegraphStore;
  let sent: string[] = [];

  async function triples(query: string): Promise<string[]> {
    const result = await store.query(query);
    if (result.type !== 'bindings') throw new Error('Expected bindings');
    return result.bindings.map((b) => `${b.s} ${b.p} ${b.o}`).sort();
  }
  const readGraph = () => triples(`SELECT ?s ?p ?o WHERE { GRAPH <${R}> { ?s ?p ?o } }`);
  const union = () => triples(
    `SELECT DISTINCT ?s ?p ?o WHERE { GRAPH ?h { ?s ?p ?o } FILTER(STRSTARTS(STR(?h), "${member}")) }`);
  const graph = (g: string) => triples(`SELECT ?s ?p ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`);

  /** Run one write with a plan; exactly one request carries every operation, and R equals the union after it. */
  async function maintained<T>(p: ReadGraphWritePlan, write: (options: ReadGraphWriteOptions) => Promise<T>): Promise<T> {
    sent = [];
    const result = await write(planned(p));
    const operations = [...p.before, ...p.after];
    expect(sent.filter((body) => operations.some((operation) => body.includes(operation)))).toHaveLength(1);
    expect(sent.filter((body) => operations.every((operation) => body.includes(operation)))).toHaveLength(1);
    expect(await readGraph()).toEqual(await union());
    return result;
  }

  beforeAll(async () => {
    store = new BlazegraphStore(url, { timeout: 30_000 });
    const transport = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (typeof init?.body === 'string') sent.push(init.body);
      return transport(input, init);
    });
    // Two members and a graph of another context graph hold "shared"; that graph alone holds "outside".
    await store.insert([
      q('a', 'shared', G1), q('a', 'one', G1),
      q('a', 'shared', G2), q('b', 'two', G2),
      q('a', 'shared', OUTSIDE), q('c', 'outside', OUTSIDE),
    ]);
    await store.update([readGraphCopy(R, G1), readGraphCopy(R, G2)].join(' ;\n'));
  });

  afterAll(async () => {
    vi.mocked(globalThis.fetch).mockRestore();
    await store.update([R, OUTSIDE, META, G1, G2, G3, G4, G5, G6, G7]
      .map((g) => `DROP SILENT GRAPH <${g}>`).join(' ;\n'));
    await store.close();
  });

  it('starts from a read graph that equals the union of its members', async () => {
    expect(await readGraph()).toEqual(await union());
    expect(await readGraph()).toHaveLength(3);
  });

  it('replaceGraph: a triple only the replaced graph held leaves R, one another member holds stays', async () => {
    await maintained(reference(G1), (o) => store.replaceGraph(G1, [q('a', 'one-v2', G1), q('d', 'four', G1)], o));
    expect((await readGraph()).some((t) => t.endsWith('"shared"'))).toBe(true);
    expect((await readGraph()).some((t) => t.endsWith('"one"'))).toBe(false);
  });

  it('insert: the read-graph quads go in the same N-Quads call', async () => {
    const quads = [q('e', 'five', G3)];
    sent = [];
    await store.insert([...quads, ...readGraphInsertQuads(R, quads)]);
    expect(sent).toHaveLength(1);
    expect(await readGraph()).toEqual(await union());
  });

  it('an insert that needs operations goes as INSERT DATA in one update', async () => {
    // As for a registry fact: the request that writes the quads also copies a joining graph.
    await maintained(plan([], [readGraphCopy(R, G7)]), (o) => store.update(
      statements.insertData([q('m', 'thirteen', G7), q('b', 'two', G7)]).update, { ...o, touchedGraphs: [G7] }));
    expect(await graph(G7)).toHaveLength(2);
  });

  it('delete with the delete delta: the last member copy leaves R, another context graph does not keep it', async () => {
    const deleted = [q('a', 'shared', G2)];
    await maintained(plan([], [readGraphDeltaDelete(target, deleted, render)!]), (o) => store.delete(deleted, o));
    expect((await readGraph()).some((t) => t.endsWith('"shared"'))).toBe(false);
    expect(await graph(OUTSIDE)).toHaveLength(2);
  });

  it('deleteByPattern, deleteByPatternWithoutCount and deleteBySubjectPrefix with their delete deltas', async () => {
    const subject = { subject: 'urn:rg-int:a' };
    expect(await maintained(plan([readGraphDeltaDeleteMatching(target, G1, subject, render)], []),
      (o) => store.deleteByPattern({ graph: G1, ...subject }, o))).toBe(1);
    await maintained(plan([readGraphDeltaDeleteMatching(target, G3, { predicate: P }, render)], []),
      (o) => store.deleteByPatternWithoutCount({ graph: G3, predicate: P }, o));
    expect(await maintained(plan([readGraphDeltaDeleteBySubjectPrefix(target, G1, 'urn:rg-int:d', render)], []),
      (o) => store.deleteBySubjectPrefix(G1, 'urn:rg-int:d', o))).toBe(1);
    expect(await graph(G1)).toEqual([]);
    expect(await graph(G3)).toEqual([]);
  });

  it('update with declared graphs, also when the caller text opens with a prologue', async () => {
    await maintained(reference(G1), (o) => store.update(
      `INSERT DATA { GRAPH <${G1}> { <urn:rg-int:f> <${P}> "six" . <urn:rg-int:b> <${P}> "two" } }`,
      { ...o, touchedGraphs: [G1] }));
    // The operations come before the caller's own prologue, which then opens its operation.
    await maintained(reference(G1), (o) => store.update(
      `PREFIX rg: <urn:rg-int:> INSERT DATA { GRAPH <${G1}> { rg:n <${P}> "fourteen" } }`, { ...o, touchedGraphs: [G1] }));
    expect(await graph(G1)).toHaveLength(3);
  });

  it('replaceAssetGroup through the bulk plan and through one direct update', async () => {
    const asset = (objects: string[]): AtomicAssetReplacement => ({
      graphUri: G4, graphQuads: objects.map((object) => ({ ...q('g', 'x', G4), object })),
      metaGraphUri: META, metadataSubject: `${base}/asset/4`,
      metadataQuads: [{ subject: `${base}/asset/4`, predicate: P, object: '"meta"', graph: META }],
    });
    await maintained(reference(G4, META), (o) => store.replaceAssetGroup([asset(['"seven"', '"two"'])], o));
    expect(await graph(G4)).toHaveLength(2);
    // Two literals Blazegraph may store as one term select the direct update.
    await maintained(reference(G4, META), (o) => store.replaceAssetGroup([asset(['"eight"@en', '"eight"@EN'])], o));
    expect((await graph(G4)).some((t) => t.includes('seven'))).toBe(false);
  });

  it('replaceGraphAndSubject, and replaceSubject and replaceSubjectAndInsert with the subject procedure', async () => {
    const subject = `${base}/asset/5`;
    await maintained(reference(G5, META), (o) => store.replaceGraphAndSubject(G5, [q('h', 'nine', G5), q('b', 'two', G5)],
      META, subject, [{ subject, predicate: P, object: '"v1"', graph: META }], o));
    const replaced = 'urn:rg-int:h';
    const forSubject = readGraphReferenceProcedure(target, [G5], [G5], { subject: replaced, render });
    await maintained(plan(forSubject.before, forSubject.after),
      (o) => store.replaceSubject(G5, replaced, [q('h', 'ten', G5)], o));
    // The companion rows are added, so they are copied into R as well.
    await maintained(plan(forSubject.before, [...forSubject.after, readGraphCopy(R, G5, { subject: 'urn:rg-int:i', render })]),
      (o) => store.replaceSubjectAndInsert(G5, replaced, [q('h', 'eleven', G5)], [q('i', 'twelve', G5)], o));
    expect(await graph(G5)).toHaveLength(3);
  });

  it('rfc64AuthorCommitCasV1: a winning commit and a losing one', async () => {
    const input = JSON.parse(JSON.stringify(authorCommitInput())
      .replaceAll('did:dkg:context-graph:rfc64/_shared_memory', G6)
      .replaceAll('urn:test:rfc64:', `urn:rg-int:${cg}:rfc64:`)) as Rfc64AuthorCommitCasSemanticInputV1;
    const guards = [input.currentHead, input.subgraphMutationGeneration, input.contextGraphMutationGeneration, input.appliedSet];
    await store.insert([...guards.flatMap((guard) => guard.expectedQuads ?? []), q('j', 'old', G6), q('b', 'two', G6)]);
    await store.update(readGraphCopy(R, G6));
    expect(await maintained(reference(G6), (o) => store.rfc64AuthorCommitCasV1(input, o))).toBe('committed');
    expect(await graph(G6)).toHaveLength(2);
    const before = await readGraph();
    expect(await maintained(reference(G6), (o) => store.rfc64AuthorCommitCasV1(input, o))).toBe('conflict');
    expect(await readGraph()).toEqual(before);
    await store.update([...new Set([...guards.map((guard) => guard.graphUri), input.authorSealGraph])]
      .map((g) => `DROP SILENT GRAPH <${g}>`).join(' ;\n'));
  });

  it('dropGraph', async () => {
    await maintained(reference(G2), (o) => store.dropGraph(G2, o));
    expect(await graph(G2)).toEqual([]);
  });

  it('a request that fails after the data change commits neither the data nor R', async () => {
    const before = { data: await graph(G1), read: await readGraph() };
    const procedure = reference(G1);
    // CREATE on a graph that holds triples fails at execution, after every other operation ran.
    const failing = plan(procedure.before, [...procedure.after, `CREATE GRAPH <${OUTSIDE}>`]);
    await expect(store.replaceGraph(G1, [q('k', 'lost', G1)], planned(failing))).rejects.toThrow();
    expect(await graph(G1)).toEqual(before.data);
    expect(await readGraph()).toEqual(before.read);
  });

  it('runs one update at a time: concurrent removals of the last two copies leave R right', async () => {
    for (let round = 0; round < 3; round += 1) {
      const shared = q(`shared-${round}`, 'last', G1);
      const copy = { ...shared, graph: G3 };
      await store.insert([shared, copy, ...readGraphInsertQuads(R, [shared])]);
      // A slow first operation keeps the first request running while the second one is sent.
      const slow = `INSERT { GRAPH <${base}/_private/scratch> { ?a <${P}> ?b } } WHERE { `
        + `VALUES ?a { ${Array.from({ length: 300 }, (_, i) => `"a${i}"`).join(' ')} } `
        + `VALUES ?b { ${Array.from({ length: 300 }, (_, i) => `"b${i}"`).join(' ')} } }`;
      const finished: string[] = [];
      const firstWrite = store.delete([shared], planned(plan([slow], [readGraphDeltaDelete(target, [shared], render)!])))
        .then(() => { finished.push('first'); });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Sent past the adapter's own scheduler, so only the engine can make it wait.
      const secondWrite = fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/sparql-update; charset=utf-8' },
        body: [statements.deleteData([copy])!.update, readGraphDeltaDelete(target, [copy], render)!].join('\n;\n'),
      }).then(async (response) => {
        const text = await response.text();
        if (!response.ok) throw new Error(`second request failed (${response.status}): ${text.slice(0, 200)}`);
        finished.push('second');
      });
      await Promise.all([firstWrite, secondWrite]);
      // The short second request waited for the long first one.
      expect(finished).toEqual(['first', 'second']);
      expect((await readGraph()).some((t) => t.startsWith(`urn:rg-int:shared-${round} `))).toBe(false);
      expect(await readGraph()).toEqual(await union());
      await store.dropGraph(`${base}/_private/scratch`);
    }
  });

  it('query does not run an update', async () => {
    await expect(store.query(`INSERT DATA { GRAPH <${G1}> { <urn:rg-int:z> <${P}> "via-query" } }`)).rejects.toThrow();
    expect((await graph(G1)).some((t) => t.includes('via-query'))).toBe(false);
  });
});
}
