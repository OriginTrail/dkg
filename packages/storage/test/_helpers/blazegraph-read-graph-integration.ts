import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BlazegraphStore } from '../../src/adapters/blazegraph.js';
import type { ReadGraphWriteOptions, ReadGraphWritePlan } from '../../src/adapters/read-graph-request.js';
import { sparqlStatements } from '../../src/adapters/sparql-statements.js';
import type { AtomicAssetReplacement } from '../../src/atomic-asset-group.js';
import type { Rfc64AuthorCommitCasSemanticInputV1 } from '../../src/rfc64-author-commit-cas.js';
import type { Quad } from '../../src/triple-store.js';
import { authorCommitInput } from '../rfc64-author-commit-cas-harness.js';

/**
 * Live checks that BlazegraphStore sends a write's read-graph operations in
 * the same request as its data change, at the right points of that request.
 *
 * The operations are the reference procedure of the read-graph design,
 * written here for the test: before the change, remove from the read graph R
 * each triple of the touched member graphs T that no other member holds;
 * after the change, copy T into R. Member graphs share one IRI prefix. After
 * every write R must equal the union of the member graphs. Operations sent at
 * the wrong point of the request leave R stale, and a request that fails
 * changes neither the data nor R.
 */
export function blazegraphReadGraphWriteTests(url: string): void {
describe('Blazegraph read-graph operations in the write request (live server)', () => {
  const run = randomUUID();
  const member = `urn:rg-int:${run}:member:`;
  const R = `urn:rg-int:${run}:read`;
  const OUTSIDE = `urn:rg-int:${run}:outside`;
  const META = `urn:rg-int:${run}:meta`;
  const [G1, G2, G3, G4, G5, G6, G7] = [1, 2, 3, 4, 5, 6, 7].map((n) => `${member}${n}`);
  const TERMS = `urn:rg-int:${run}:terms`, MEMBER_TERMS = `${member}terms`;
  const P = 'urn:rg-int:p';
  const q = (s: string, o: string, graph: string): Quad => ({ subject: `urn:rg-int:${s}`, predicate: P, object: `"${o}"`, graph });
  const isMember = (variable: string) => `STRSTARTS(STR(${variable}), "${member}")`;
  const values = (graphs: readonly string[]) => graphs.map((g) => `<${g}>`).join(' ');

  const retract = (touched: readonly string[]) =>
    `DELETE { GRAPH <${R}> { ?s ?p ?o } } WHERE { VALUES ?t { ${values(touched)} } GRAPH ?t { ?s ?p ?o } `
    + `FILTER NOT EXISTS { GRAPH ?h { ?s ?p ?o } FILTER(?h NOT IN (${touched.map((g) => `<${g}>`).join(', ')}) && ${isMember('?h')}) } }`;
  const copy = (touched: readonly string[]) =>
    `INSERT { GRAPH <${R}> { ?s ?p ?o } } WHERE { VALUES ?t { ${values(touched)} } GRAPH ?t { ?s ?p ?o } }`;
  /** The reference procedure over the touched graphs that are members. */
  const reference = (...touched: string[]): ReadGraphWritePlan => {
    const members = touched.filter((graph) => graph.startsWith(member));
    return { readGraphs: [R], before: [retract(members)], after: [copy(members)] };
  };
  const planned = (plan: ReadGraphWritePlan): ReadGraphWriteOptions => ({ readGraphPlan: plan });
  const statements = sparqlStatements('blazegraph');

  let store: BlazegraphStore;
  let sent: string[] = [];

  async function triples(query: string): Promise<string[]> {
    const result = await store.query(query);
    if (result.type !== 'bindings') throw new Error('Expected bindings');
    return result.bindings.map((b) => `${b.s} ${b.p} ${b.o}`).sort();
  }
  const readGraph = () => triples(`SELECT ?s ?p ?o WHERE { GRAPH <${R}> { ?s ?p ?o } }`);
  const union = () => triples(`SELECT DISTINCT ?s ?p ?o WHERE { GRAPH ?h { ?s ?p ?o } FILTER(${isMember('?h')}) }`);
  const graph = (g: string) => triples(`SELECT ?s ?p ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`);

  /** Run one write with a plan; exactly one request carries every operation, and R equals the union after it. */
  async function maintained<T>(plan: ReadGraphWritePlan, write: (options: ReadGraphWriteOptions) => Promise<T>): Promise<T> {
    sent = [];
    const result = await write(planned(plan));
    const operations = [...plan.before, ...plan.after];
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
    // Two members and a non-member hold "shared"; a non-member alone holds "outside".
    await store.insert([
      q('a', 'shared', G1), q('a', 'one', G1),
      q('a', 'shared', G2), q('b', 'two', G2),
      q('a', 'shared', OUTSIDE), q('c', 'outside', OUTSIDE),
    ]);
    await store.update(copy([G1, G2]));
  });

  afterAll(async () => {
    vi.mocked(globalThis.fetch).mockRestore();
    await store.update([R, OUTSIDE, META, G1, G2, G3, G4, G5, G6, G7, TERMS, MEMBER_TERMS]
      .map((g) => `DROP SILENT GRAPH <${g}>`).join(' ;\n'));
    await store.close();
  });

  it('starts from a read graph that equals the union of its members', async () => {
    expect(await readGraph()).toEqual(await union());
    expect(await readGraph()).toHaveLength(3);
  });

  it('replaceGraph: a triple only the replaced graph held leaves R, one another member holds stays', async () => {
    await maintained(reference(G1), (o) => store.replaceGraph(G1, [q('a', 'one-v2', G1), q('d', 'four', G1)], o));
    expect(await readGraph()).toEqual(expect.arrayContaining([expect.stringContaining('"shared"')]));
    expect((await readGraph()).some((t) => t.endsWith('"one"'))).toBe(false);
  });

  it('insert: the layer adds the read-graph quads to the same call', async () => {
    sent = [];
    await store.insert([q('e', 'five', G3), q('e', 'five', R)]);
    expect(sent).toHaveLength(1);
    expect(await readGraph()).toEqual(await union());
  });

  it('insert data that needs operations goes as INSERT DATA in one update', async () => {
    // As for a registry fact: the request that writes the quads also copies a joining graph.
    await maintained({ readGraphs: [R], before: [], after: [copy([G7])] }, (o) => store.update(
      statements.insertData([q('m', 'thirteen', G7), q('b', 'two', G7)]).update, { ...o, touchedGraphs: [G7] }));
    expect(await graph(G7)).toHaveLength(2);
  });

  it('INSERT DATA in an update stores the same terms as an N-Quads insert', async () => {
    const objects = ['"café 😀𠜎"', '"esc\\U0001F600ape"', '"bmp\\U000000E9"', '"lit\\\\U0001F600"',
      '"quoted \\"text\\" and \\n newline \\t tab"', '"001"^^<http://www.w3.org/2001/XMLSchema#integer>',
      '"one"@EN', '"1.0"^^<http://www.w3.org/2001/XMLSchema#decimal>', '<http://ex.org/café>',
      '"2026-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'];
    const rows = (graphUri: string): Quad[] => objects.map((object, i) => ({
      subject: `urn:rg-int:${run}:term:${i}`, predicate: P, object, graph: graphUri }));
    await store.insert(rows(TERMS));
    await maintained(reference(MEMBER_TERMS), (o) => store.update(
      statements.insertData(rows(MEMBER_TERMS)).update, { ...o, touchedGraphs: [MEMBER_TERMS] }));
    const onlyIn = (a: string, b: string) =>
      store.query(`SELECT ?s ?o WHERE { GRAPH <${a}> { ?s ?p ?o } FILTER NOT EXISTS { GRAPH <${b}> { ?s ?p ?o } } }`);
    expect(await onlyIn(TERMS, MEMBER_TERMS)).toMatchObject({ bindings: [] });
    expect(await onlyIn(MEMBER_TERMS, TERMS)).toMatchObject({ bindings: [] });
    expect(await store.countQuads(MEMBER_TERMS)).toBe(objects.length);
  });

  it('delete: the last member copy of a triple leaves R; a non-member copy does not keep it', async () => {
    await maintained(reference(G2), (o) => store.delete([q('a', 'shared', G2)], o));
    expect((await readGraph()).some((t) => t.endsWith('"shared"'))).toBe(false);
    expect(await graph(OUTSIDE)).toHaveLength(2);
  });

  it('deleteByPattern, deleteByPatternWithoutCount and deleteBySubjectPrefix', async () => {
    expect(await maintained(reference(G1), (o) => store.deleteByPattern({ graph: G1, subject: 'urn:rg-int:a' }, o))).toBe(1);
    await maintained(reference(G3), (o) => store.deleteByPatternWithoutCount({ graph: G3, predicate: P }, o));
    expect(await maintained(reference(G1), (o) => store.deleteBySubjectPrefix(G1, 'urn:rg-int:d', o))).toBe(1);
    expect(await graph(G1)).toEqual([]);
    expect(await graph(G3)).toEqual([]);
  });

  it('update with declared graphs', async () => {
    await maintained(reference(G1), (o) => store.update(
      `INSERT DATA { GRAPH <${G1}> { <urn:rg-int:f> <${P}> "six" . <urn:rg-int:b> <${P}> "two" } }`,
      { ...o, touchedGraphs: [G1] }));
    expect(await graph(G1)).toHaveLength(2);
    // The operations come before the caller's own prologue, which then opens its operation.
    await maintained(reference(G1), (o) => store.update(
      `PREFIX rg: <urn:rg-int:> INSERT DATA { GRAPH <${G1}> { rg:n <${P}> "fourteen" } }`, { ...o, touchedGraphs: [G1] }));
    expect(await graph(G1)).toHaveLength(3);
  });

  it('replaceAssetGroup through the bulk plan and through one direct update', async () => {
    const asset = (objects: string[]): AtomicAssetReplacement => ({
      graphUri: G4, graphQuads: objects.map((o) => ({ ...q('g', 'x', G4), object: o })),
      metaGraphUri: META, metadataSubject: `urn:rg-int:${run}:asset`,
      metadataQuads: [{ subject: `urn:rg-int:${run}:asset`, predicate: P, object: '"meta"', graph: META }],
    });
    await maintained(reference(G4, META), (o) => store.replaceAssetGroup([asset(['"seven"', '"two"'])], o));
    expect(await graph(G4)).toHaveLength(2);
    // Two literals Blazegraph may store as one term select the direct update.
    await maintained(reference(G4, META), (o) => store.replaceAssetGroup([asset(['"eight"@en', '"eight"@EN'])], o));
    expect((await graph(G4)).some((t) => t.includes('seven'))).toBe(false);
  });

  it('replaceGraphAndSubject, replaceSubject and replaceSubjectAndInsert', async () => {
    const subject = `urn:rg-int:${run}:asset:5`;
    await maintained(reference(G5, META), (o) => store.replaceGraphAndSubject(G5, [q('h', 'nine', G5), q('b', 'two', G5)],
      META, subject, [{ subject, predicate: P, object: '"v1"', graph: META }], o));
    await maintained(reference(G5), (o) => store.replaceSubject(G5, 'urn:rg-int:h', [q('h', 'ten', G5)], o));
    await maintained(reference(G5), (o) => store.replaceSubjectAndInsert(G5, 'urn:rg-int:h', [q('h', 'eleven', G5)],
      [q('i', 'twelve', G5)], o));
    expect(await graph(G5)).toHaveLength(3);
  });

  it('rfc64AuthorCommitCasV1: a winning commit and a losing one', async () => {
    const input = JSON.parse(JSON.stringify(authorCommitInput())
      .replaceAll('did:dkg:context-graph:rfc64/_shared_memory', G6)
      .replaceAll('urn:test:rfc64:', `urn:rg-int:${run}:rfc64:`)) as Rfc64AuthorCommitCasSemanticInputV1;
    const guards = [input.currentHead, input.subgraphMutationGeneration, input.contextGraphMutationGeneration, input.appliedSet];
    await store.insert([...guards.flatMap((guard) => guard.expectedQuads ?? []), q('j', 'old', G6), q('b', 'two', G6)]);
    await store.update(copy([G6]));
    expect(await maintained(reference(G6), (o) => store.rfc64AuthorCommitCasV1(input, o))).toBe('committed');
    expect(await graph(G6)).toHaveLength(2);
    const before = await readGraph();
    expect(await maintained(reference(G6), (o) => store.rfc64AuthorCommitCasV1(input, o))).toBe('conflict');
    expect(await readGraph()).toEqual(before);
    await store.update(guards.map((guard) => `DROP SILENT GRAPH <${guard.graphUri}>`)
      .concat(`DROP SILENT GRAPH <${input.authorSealGraph}>`).join(' ;\n'));
  });

  it('dropGraph', async () => {
    await maintained(reference(G2), (o) => store.dropGraph(G2, o));
    expect(await graph(G2)).toEqual([]);
  });

  it('a request that fails after the data change commits neither the data nor R', async () => {
    const before = { data: await graph(G1), read: await readGraph() };
    const plan = reference(G1);
    // CREATE on a graph that holds triples fails at execution, after every other operation ran.
    const failing = { ...plan, after: [...plan.after, `CREATE GRAPH <${OUTSIDE}>`] };
    await expect(store.replaceGraph(G1, [q('k', 'lost', G1)], planned(failing))).rejects.toThrow();
    expect(await graph(G1)).toEqual(before.data);
    expect(await readGraph()).toEqual(before.read);
  });

  it('runs two maintained requests one after the other: concurrent removals of the last two copies leave R right', async () => {
    for (let round = 0; round < 3; round += 1) {
      const shared = q(`shared-${round}`, 'last', G1);
      await store.insert([shared, { ...shared, graph: G3 }, { ...shared, graph: R }]);
      // A slow first operation keeps the first request running while the second one is sent.
      const slow = `INSERT { GRAPH <urn:rg-int:${run}:scratch> { ?a <${P}> ?b } } WHERE { `
        + `VALUES ?a { ${Array.from({ length: 300 }, (_, i) => `"a${i}"`).join(' ')} } `
        + `VALUES ?b { ${Array.from({ length: 300 }, (_, i) => `"b${i}"`).join(' ')} } }`;
      const first = reference(G1);
      const finished: string[] = [];
      const firstWrite = store.delete([shared], planned({ ...first, before: [slow, ...first.before] }))
        .then(() => { finished.push('first'); });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Sent past the adapter's own scheduler, so only the engine can make it wait.
      const secondWrite = fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/sparql-update; charset=utf-8' },
        body: [retract([G3]), `DELETE DATA { GRAPH <${G3}> { <${shared.subject}> <${P}> "last" } }`, copy([G3])].join('\n;\n'),
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
      await store.dropGraph(`urn:rg-int:${run}:scratch`);
    }
  });

  it('query does not run an update', async () => {
    await expect(store.query(`INSERT DATA { GRAPH <${G1}> { <urn:rg-int:z> <${P}> "via-query" } }`)).rejects.toThrow();
    expect((await graph(G1)).some((t) => t.includes('via-query'))).toBe(false);
  });
});
}
