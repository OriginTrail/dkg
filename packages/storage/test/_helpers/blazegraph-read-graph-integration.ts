import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
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
 * procedure, the delta forms of the deletes, and the insert quads. Each case
 * has its own context graph, whose member graphs share one IRI prefix. After
 * every write the read graph R must equal the union of the member graphs.
 * Operations sent at the wrong point of the request leave R stale, and a
 * request that fails changes neither the data nor R.
 */
export function blazegraphReadGraphWriteTests(url: string): void {
describe('Blazegraph read-graph operations in the write request (live server)', () => {
  const P = 'urn:rg-int:p';
  const render = ADAPTER_SPARQL_TERM_POLICY.renderer({ adapter: 'blazegraph', operation: 'delete' }, () => {});
  const statements = sparqlStatements('blazegraph');
  const q = (s: string, o: string, graph: string): Quad => ({ subject: `urn:rg-int:${s}`, predicate: P, object: `"${o}"`, graph });
  const planned = (p: ReadGraphWritePlan): ReadGraphWriteOptions => ({ readGraphPlan: p });

  let store: BlazegraphStore;
  let sent: string[] = [];

  async function triples(query: string): Promise<string[]> {
    const result = await store.query(query);
    if (result.type !== 'bindings') throw new Error('Expected bindings');
    return result.bindings.map((b) => `${b.s} ${b.p} ${b.o}`).sort();
  }
  const graph = (g: string) => triples(`SELECT ?s ?p ?o WHERE { GRAPH <${g}> { ?s ?p ?o } }`);

  /**
   * A fresh context graph: members G1 to G7, its read graph, a graph of another
   * context graph and its `_meta`. Seeded with two members and the other graph
   * holding "shared", and R built from the members.
   */
  async function scenario() {
    const cg = `rgint${randomUUID().slice(0, 8)}`;
    const base = `did:dkg:context-graph:${cg}`;
    const member = `${base}/_shared_memory/`;
    const R = readGraphIri({ scope: readScope(cg), layer: MemoryLayer.SharedWorkingMemory });
    const target: ReadGraphTarget = { readGraph: R, membership: { kind: 'prefix', prefix: member } };
    const [G1, G2, G3, G4, G5, G6, G7] = ['1', '2', '3', '4', '5', '6', '7'].map((n) => `${member}0xaa/${n}`);
    // Another context graph holds a copy of "shared"; it must not keep the triple in R.
    const OUTSIDE = `did:dkg:context-graph:${cg}x/_shared_memory/0xbb/1`;
    const META = `${base}/_meta`, SCRATCH = `${base}/_private/scratch`;
    const plan = (before: string[], after: string[]): ReadGraphWritePlan => ({ readGraphs: [R], before, after });
    const reference = (...touched: string[]): ReadGraphWritePlan => {
      const members = touched.filter((g) => g.startsWith(member));
      const { before, after } = readGraphReferenceProcedure(target, members, members);
      return plan(before, after);
    };
    const readGraph = () => graph(R);
    const union = () => triples(
      `SELECT DISTINCT ?s ?p ?o WHERE { GRAPH ?h { ?s ?p ?o } FILTER(STRSTARTS(STR(?h), "${member}")) }`);
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
    const drop = (graphs: readonly string[]) => store.update(graphs.map((g) => `DROP SILENT GRAPH <${g}>`).join(' ;\n'));
    await store.insert([
      q('a', 'shared', G1), q('a', 'one', G1),
      q('a', 'shared', G2), q('b', 'two', G2),
      q('a', 'shared', OUTSIDE), q('c', 'outside', OUTSIDE),
    ]);
    await store.update([readGraphCopy(R, G1), readGraphCopy(R, G2)].join(' ;\n'));
    const cleanup = () => drop([R, OUTSIDE, META, SCRATCH, G1, G2, G3, G4, G5, G6, G7]);
    return { base, member, R, target, G1, G2, G3, G4, G5, G6, G7, OUTSIDE, META, SCRATCH,
      plan, reference, readGraph, union, maintained, drop, cleanup };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;
  async function inScenario(body: (s: Scenario) => Promise<void>): Promise<void> {
    const s = await scenario();
    try { await body(s); } finally { await s.cleanup(); }
  }
  const has = (rows: readonly string[], object: string) => rows.some((t) => t.endsWith(`"${object}"`));
  /** Wait until Blazegraph's status page lists a running request whose text holds `marker`. */
  async function untilRunningOnServer(marker: string): Promise<void> {
    const status = `${url.replace(/\/namespace\/[^/]+\/sparql\/?$/, '')}/status?showQueries`;
    const deadline = performance.now() + 10_000;
    while (!(await (await fetch(status)).text()).includes(marker)) {
      if (performance.now() > deadline) throw new Error('The first update never showed as running on the server');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  beforeAll(() => {
    store = new BlazegraphStore(url, { timeout: 30_000 });
    const transport = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (typeof init?.body === 'string') sent.push(init.body);
      return transport(input, init);
    });
  });

  afterAll(async () => {
    vi.mocked(globalThis.fetch).mockRestore();
    await store.close();
  });

  it('starts from a read graph that equals the union of its members', () => inScenario(async (s) => {
    expect(await s.readGraph()).toEqual(await s.union());
    expect(await s.readGraph()).toHaveLength(3);
  }));

  it('replaceGraph: a triple only the replaced graph held leaves R, one another member holds stays', () =>
    inScenario(async (s) => {
      await s.maintained(s.reference(s.G1), (o) => store.replaceGraph(s.G1, [q('a', 'one-v2', s.G1), q('d', 'four', s.G1)], o));
      expect(has(await s.readGraph(), 'shared')).toBe(true);
      expect(has(await s.readGraph(), 'one')).toBe(false);
      expect(has(await s.readGraph(), 'four')).toBe(true);
    }));

  it('insert: the read-graph quads go in the same N-Quads call', () => inScenario(async (s) => {
    const quads = [q('e', 'five', s.G3)];
    sent = [];
    await store.insert([...quads, ...readGraphInsertQuads(s.R, quads)]);
    expect(sent).toHaveLength(1);
    expect(await s.readGraph()).toEqual(await s.union());
  }));

  it('an insert that needs operations goes as INSERT DATA in one update', () => inScenario(async (s) => {
    // As for a registry fact: the request that writes the quads also copies a joining graph.
    await s.maintained(s.plan([], [readGraphCopy(s.R, s.G7)]), (o) => store.update(
      statements.insertData([q('m', 'thirteen', s.G7), q('b', 'two', s.G7)]).update, { ...o, touchedGraphs: [s.G7] }));
    expect(await graph(s.G7)).toHaveLength(2);
  }));

  it('delete with the delete delta: a triple stays while a member holds it, and another context graph does not keep it', () =>
    inScenario(async (s) => {
      const deleteDelta = (quads: Quad[]) => s.plan([], [readGraphDeltaDelete(s.target, quads, render)!]);
      await s.maintained(deleteDelta([q('a', 'shared', s.G2)]), (o) => store.delete([q('a', 'shared', s.G2)], o));
      expect(has(await s.readGraph(), 'shared')).toBe(true);
      await s.maintained(deleteDelta([q('a', 'shared', s.G1)]), (o) => store.delete([q('a', 'shared', s.G1)], o));
      expect(has(await s.readGraph(), 'shared')).toBe(false);
      expect(await graph(s.OUTSIDE)).toHaveLength(2);
    }));

  it('deleteByPattern, deleteByPatternWithoutCount and deleteBySubjectPrefix with their delete deltas', () =>
    inScenario(async (s) => {
      const subject = { subject: 'urn:rg-int:a' };
      expect(await s.maintained(s.plan([readGraphDeltaDeleteMatching(s.target, s.G1, subject, render)], []),
        (o) => store.deleteByPattern({ graph: s.G1, ...subject }, o))).toBe(2);
      expect(has(await s.readGraph(), 'shared')).toBe(true);
      await s.maintained(s.plan([readGraphDeltaDeleteMatching(s.target, s.G2, { predicate: P }, render)], []),
        (o) => store.deleteByPatternWithoutCount({ graph: s.G2, predicate: P }, o));
      expect(has(await s.readGraph(), 'shared')).toBe(false);
      const prefixed = [q('d', 'four', s.G3), q('dd', 'five', s.G3)];
      await store.insert([...prefixed, ...readGraphInsertQuads(s.R, prefixed)]);
      expect(await s.maintained(s.plan([readGraphDeltaDeleteBySubjectPrefix(s.target, s.G3, 'urn:rg-int:d', render)], []),
        (o) => store.deleteBySubjectPrefix(s.G3, 'urn:rg-int:d', o))).toBe(2);
      expect(await s.readGraph()).toEqual([]);
    }));

  it('update with declared graphs, also when the caller text opens with a prologue', () => inScenario(async (s) => {
    await s.maintained(s.reference(s.G3), (o) => store.update(
      `INSERT DATA { GRAPH <${s.G3}> { <urn:rg-int:f> <${P}> "six" . <urn:rg-int:b> <${P}> "two" } }`,
      { ...o, touchedGraphs: [s.G3] }));
    // The operations come before the caller's own prologue, which then opens its operation.
    await s.maintained(s.reference(s.G3), (o) => store.update(
      `PREFIX rg: <urn:rg-int:> INSERT DATA { GRAPH <${s.G3}> { rg:n <${P}> "fourteen" } } ; # done`,
      { ...o, touchedGraphs: [s.G3] }));
    expect(await graph(s.G3)).toHaveLength(3);
  }));

  it('replaceAssetGroup through the bulk plan and through one direct update', () => inScenario(async (s) => {
    const asset = (objects: string[]): AtomicAssetReplacement => ({
      graphUri: s.G4, graphQuads: objects.map((object) => ({ ...q('g', 'x', s.G4), object })),
      metaGraphUri: s.META, metadataSubject: `${s.base}/asset/4`,
      metadataQuads: [{ subject: `${s.base}/asset/4`, predicate: P, object: '"meta"', graph: s.META }],
    });
    await s.maintained(s.reference(s.G4, s.META), (o) => store.replaceAssetGroup([asset(['"seven"', '"two"'])], o));
    expect(await graph(s.G4)).toHaveLength(2);
    // Two literals Blazegraph may store as one term select the direct update.
    await s.maintained(s.reference(s.G4, s.META), (o) => store.replaceAssetGroup([asset(['"eight"@en', '"eight"@EN'])], o));
    expect((await graph(s.G4)).some((t) => t.includes('seven'))).toBe(false);
  }));

  it('replaceGraphAndSubject, and replaceSubject and replaceSubjectAndInsert with the subject procedure', () =>
    inScenario(async (s) => {
      const subject = `${s.base}/asset/5`;
      await s.maintained(s.reference(s.G5, s.META), (o) => store.replaceGraphAndSubject(s.G5,
        [q('h', 'nine', s.G5), q('b', 'two', s.G5)], s.META, subject, [{ subject, predicate: P, object: '"v1"', graph: s.META }], o));
      const replaced = 'urn:rg-int:h';
      const forSubject = readGraphReferenceProcedure(s.target, [s.G5], [s.G5], { subject: replaced, render });
      await s.maintained(s.plan(forSubject.before, forSubject.after),
        (o) => store.replaceSubject(s.G5, replaced, [q('h', 'ten', s.G5)], o));
      // The companion rows are added, so they are copied into R as well.
      await s.maintained(
        s.plan(forSubject.before, [...forSubject.after, readGraphCopy(s.R, s.G5, { subject: 'urn:rg-int:i', render })]),
        (o) => store.replaceSubjectAndInsert(s.G5, replaced, [q('h', 'eleven', s.G5)], [q('i', 'twelve', s.G5)], o));
      expect(await graph(s.G5)).toHaveLength(3);
    }));

  it('rfc64AuthorCommitCasV1: a winning commit and a losing one', () => inScenario(async (s) => {
    const input = JSON.parse(JSON.stringify(authorCommitInput())
      .replaceAll('did:dkg:context-graph:rfc64/_shared_memory', s.G6)
      .replaceAll('urn:test:rfc64:', `${s.base}/_meta/rfc64/`)) as Rfc64AuthorCommitCasSemanticInputV1;
    const guards = [input.currentHead, input.subgraphMutationGeneration, input.contextGraphMutationGeneration, input.appliedSet];
    const graphs = [...new Set([...guards.map((guard) => guard.graphUri), input.authorSealGraph])];
    try {
      await store.insert([...guards.flatMap((guard) => guard.expectedQuads ?? []), q('j', 'old', s.G6), q('b', 'two', s.G6)]);
      await store.update(readGraphCopy(s.R, s.G6));
      expect(await s.maintained(s.reference(s.G6), (o) => store.rfc64AuthorCommitCasV1(input, o))).toBe('committed');
      expect(await graph(s.G6)).toHaveLength(2);
      const before = await s.readGraph();
      expect(await s.maintained(s.reference(s.G6), (o) => store.rfc64AuthorCommitCasV1(input, o))).toBe('conflict');
      expect(await s.readGraph()).toEqual(before);
    } finally {
      await s.drop(graphs);
    }
  }));

  it('dropGraph', () => inScenario(async (s) => {
    await s.maintained(s.reference(s.G2), (o) => store.dropGraph(s.G2, o));
    expect(await graph(s.G2)).toEqual([]);
    expect(has(await s.readGraph(), 'shared')).toBe(true);
    expect(has(await s.readGraph(), 'two')).toBe(false);
  }));

  it('a request that fails after the data change commits neither the data nor R', () => inScenario(async (s) => {
    const before = { data: await graph(s.G1), read: await s.readGraph() };
    const procedure = s.reference(s.G1);
    // CREATE on a graph that holds triples fails at execution, after every other operation ran.
    const failing = s.plan(procedure.before, [...procedure.after, `CREATE GRAPH <${s.OUTSIDE}>`]);
    await expect(store.replaceGraph(s.G1, [q('k', 'lost', s.G1)], planned(failing))).rejects.toThrow();
    expect(await graph(s.G1)).toEqual(before.data);
    expect(await s.readGraph()).toEqual(before.read);
  }));

  it('runs one update request at a time: concurrent removals of the last two copies leave R right', () =>
    inScenario(async (s) => {
      for (let round = 0; round < 3; round += 1) {
        const shared = q(`shared-${round}`, 'last', s.G1);
        const copy = { ...shared, graph: s.G3 };
        await store.insert([shared, copy, ...readGraphInsertQuads(s.R, [shared])]);
        // A slow first operation keeps the first request running; its marker shows it on the status page.
        const marker = `overlap${randomUUID().replaceAll('-', '')}`;
        const slow = `INSERT { GRAPH <${s.SCRATCH}> { ?a <${P}> ?b } } WHERE { `
          + `VALUES ?a { ${Array.from({ length: 400 }, (_, i) => `"${marker}${i}"`).join(' ')} } `
          + `VALUES ?b { ${Array.from({ length: 400 }, (_, i) => `"b${i}"`).join(' ')} } }`;
        const finished: string[] = [];
        const firstWrite = store.delete([shared], planned(s.plan([slow], [readGraphDeltaDelete(s.target, [shared], render)!])))
          .then(() => { finished.push('first'); });
        // The second request is sent only once the server shows the first one running.
        await untilRunningOnServer(marker);
        // Sent past the adapter's own scheduler, so only the server can make it wait.
        const secondWrite = fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/sparql-update; charset=utf-8' },
          body: [statements.deleteData([copy])!.update, readGraphDeltaDelete(s.target, [copy], render)!].join('\n;\n'),
        }).then(async (response) => {
          const text = await response.text();
          if (!response.ok) throw new Error(`second request failed (${response.status}): ${text.slice(0, 200)}`);
          finished.push('second');
        });
        await Promise.all([firstWrite, secondWrite]);
        // The short second request still finished after the long first one.
        expect(finished).toEqual(['first', 'second']);
        expect((await s.readGraph()).some((t) => t.startsWith(`urn:rg-int:shared-${round} `))).toBe(false);
        expect(await s.readGraph()).toEqual(await s.union());
        await store.dropGraph(s.SCRATCH);
      }
    }), 60_000);

  it('query does not run an update', () => inScenario(async (s) => {
    await expect(store.query(`INSERT DATA { GRAPH <${s.G1}> { <urn:rg-int:z> <${P}> "via-query" } }`)).rejects.toThrow();
    expect(has(await graph(s.G1), 'via-query')).toBe(false);
  }));
});
}
