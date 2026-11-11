import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import oxigraph from 'oxigraph';
import { afterAll, expect, it, vi } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { OxigraphWorkerStore } from '../src/adapters/oxigraph-worker.js';
import { readGraphCopy, readGraphDeltaDelete, readGraphDeltaDeleteMatching, readGraphInsertQuads } from '../src/read-graph/statements.js';
import {
  P,
  planned,
  q,
  readGraphWriteSuite,
  type ReadGraphTestStore,
  type ReadGraphWriteContext,
  type SentRequests,
} from './_helpers/read-graph-write-suite.js';

/**
 * OxigraphStore and OxigraphWorkerStore send a write's read-graph operations
 * in the same engine update as its data change (see
 * `_helpers/read-graph-write-suite.ts`).
 */

/** Records the text of every update and load OxigraphStore sends its engine. */
function sentToEngine(): SentRequests {
  const sent: string[] = [];
  const spies: { mockRestore(): void }[] = [];
  return {
    start() {
      const engine = oxigraph.Store.prototype;
      for (const call of ['update', 'load'] as const) {
        const original = engine[call] as (...args: unknown[]) => unknown;
        spies.push(vi.spyOn(engine, call).mockImplementation(function (this: unknown, ...args: unknown[]) {
          sent.push(String(args[0]));
          return original.apply(this, args);
        } as never));
      }
    },
    sent: () => sent.splice(0),
    stop: () => { for (const spy of spies.splice(0)) spy.mockRestore(); },
  };
}

/** Records every message OxigraphWorkerStore posts to its worker, as the strings its arguments hold. */
function sentToWorker(): SentRequests {
  const sent: string[] = [];
  let spy: { mockRestore(): void } | undefined;
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
      : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  return {
    start() {
      const original = Worker.prototype.postMessage as (...args: unknown[]) => void;
      spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message: unknown, ...rest: unknown[]) {
        sent.push(strings((message as { args?: unknown }).args).join('\n'));
        return original.call(this, message, ...rest);
      } as never);
    },
    sent: () => sent.splice(0),
    stop: () => spy?.mockRestore(),
  };
}

/**
 * The engine deletes a stored blank node by its identity. A planned delete of
 * one is refused before anything changes, because SPARQL could name it only by
 * shape; without a plan it deletes exactly that node, as before.
 */
function blankNodeDeletes({ store, inScenario, graph }: ReadGraphWriteContext<ReadGraphTestStore>): void {
  it('refuses a planned delete of a stored blank node, and deletes exactly that node without a plan', () =>
    inScenario(async (s) => {
      // Two blank nodes and a named subject with the same predicate and object.
      await store().insert(['_:a', '_:b', 'urn:rg-int:other'].map((subject) => ({ subject, predicate: P, object: '"one"', graph: s.G3 })));
      await store().update(readGraphCopy(s.R, s.G3));
      const stored = await store().query(`SELECT ?s WHERE { GRAPH <${s.G3}> { ?s <${P}> "one" FILTER(isBlank(?s)) } }`);
      if (stored.type !== 'bindings' || stored.bindings.length !== 2) throw new Error('Expected two stored blank nodes');
      const quad = { subject: stored.bindings[0]!['s']!, predicate: P, object: '"one"', graph: s.G3 };
      const before = { data: await graph(s.G3), read: await s.readGraph() };
      await expect(store().delete([quad], planned(s.reference(s.G3)))).rejects.toThrow(/blank node/);
      expect(await graph(s.G3)).toEqual(before.data);
      expect(await s.readGraph()).toEqual(before.read);
      await store().delete([quad]);
      expect(await graph(s.G3)).toEqual(before.data.filter((t) => !t.startsWith(`${quad.subject} `)));
      expect(await graph(s.G3)).toHaveLength(2);
    }));
}

/** A planned delete is written only with the terms the engine parsed, so text in a caller's term cannot add an operation. */
function injectedTermsChangeNothing({ store, inScenario, graph }: ReadGraphWriteContext<ReadGraphTestStore>): void {
  it('writes a planned delete only with the terms the engine parsed: text in a term adds no operation', () =>
    inScenario(async (s) => {
      const before = { member: await graph(s.G1), other: await graph(s.OUTSIDE), read: await s.readGraph() };
      const injected = `"missing" . } } ; CLEAR ALL ; DELETE DATA { GRAPH <${s.G1}> { <urn:rg-int:a> <${P}> "missing"`;
      await store().delete([{ subject: 'urn:rg-int:a', predicate: P, object: injected, graph: s.G1 }], planned(s.reference(s.G1)));
      await expect(store().deleteByPattern({ graph: `${s.G1}> } } ; CLEAR ALL ; #`, subject: 'urn:rg-int:a' },
        planned(s.reference(s.G1)))).rejects.toThrow();
      expect(await graph(s.G1)).toEqual(before.member);
      expect(await graph(s.OUTSIDE)).toEqual(before.other);
      expect(await s.readGraph()).toEqual(before.read);
    }));
}

/**
 * A planned delete of quads in several graphs goes as one DELETE DATA, grouped by graph. Every quad must leave its own
 * graph, a sibling graph keeps its triples, and the read graph equals the union of what the members still hold.
 */
function multiGraphDeletes({ store, inScenario, graph, render }: ReadGraphWriteContext<ReadGraphTestStore>): void {
  it('deletes quads of several graphs in one planned request, each from its own graph', () => inScenario(async (s) => {
    const sibling = [q('c', 'three', s.G3)];
    await store().insert([...sibling, ...readGraphInsertQuads(s.R, sibling)]);
    // The graphs interleave, so a quad grouped under the wrong graph, or dropped after the first, would stay.
    const targets = [q('a', 'one', s.G1), q('b', 'two', s.G2), q('a', 'shared', s.G1), q('a', 'shared', s.G2)];
    await s.maintained(s.plan([], [readGraphDeltaDelete(s.target, targets, render)!]), (o) => store().delete(targets, o));
    expect(await graph(s.G1)).toEqual([]);
    expect(await graph(s.G2)).toEqual([]);
    expect(await graph(s.G3)).toEqual([`urn:rg-int:c ${P} "three"`]);
    expect(await s.readGraph()).toEqual([`urn:rg-int:c ${P} "three"`]);
    expect(await graph(s.OUTSIDE)).toHaveLength(2);
  }));
}

/** Literals whose text, language or datatype a planned delete must carry exactly, each with a sibling that must stay. */
const LITERALS = [
  { name: 'escaped', target: '"line1\\nline2 \\"quoted\\" \\\\ tab\\tend"', sibling: '"line1"' },
  { name: 'language-tagged', target: '"bonjour"@fr', sibling: '"bonjour"@en' },
  { name: 'typed', target: '"42"^^<http://www.w3.org/2001/XMLSchema#integer>', sibling: '"42"' },
  { name: 'custom-datatype', target: '"x"^^<urn:test:datatype>', sibling: '"x"^^<urn:test:other>' },
];

/**
 * A planned delete writes the literal the engine printed back into SPARQL. For each kind of literal: the term read back
 * from the store is deleted, by a planned delete and then by an object-bound planned pattern delete; the target goes,
 * its sibling stays, and the read graph equals what the members still hold. The stored data is checked, not the
 * count the pattern delete returns, which comes from the matches it found first.
 */
function literalRoundTrips({ store, inScenario, graph, render }: ReadGraphWriteContext<ReadGraphTestStore>): void {
  for (const literal of LITERALS) {
    it(`deletes a read-back ${literal.name} literal with a planned delete and a planned pattern delete`, () => inScenario(async (s) => {
      const subject = 'urn:rg-int:lit';
      const add = (object: string) => {
        const quads = [{ subject, predicate: P, object, graph: s.G3 }];
        return store().insert([...quads, ...readGraphInsertQuads(s.R, quads)]);
      };
      await add(literal.target);
      const read = await store().query(`SELECT ?o WHERE { GRAPH <${s.G3}> { <${subject}> <${P}> ?o } }`);
      if (read.type !== 'bindings' || read.bindings.length !== 1) throw new Error('Expected the stored target literal');
      const stored = read.bindings[0]!['o']!;
      await add(literal.sibling);
      expect(await graph(s.G3)).toHaveLength(2);
      const target = { subject, predicate: P, object: stored, graph: s.G3 };

      await s.maintained(s.plan([], [readGraphDeltaDelete(s.target, [target], render)!]), (o) => store().delete([target], o));
      const left = await graph(s.G3);
      expect(left).toHaveLength(1);
      expect(left[0]).not.toBe(`${subject} ${P} ${stored}`);

      await add(literal.target);
      const pattern = { subject, predicate: P, object: stored };
      await s.maintained(s.plan([readGraphDeltaDeleteMatching(s.target, s.G3, pattern, render)], []),
        (o) => store().deleteByPattern({ graph: s.G3, ...pattern }, o));
      expect(await graph(s.G3)).toEqual(left);
    }));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dkg-read-graph-writes-'));
const persistPath = join(dir, 'store.nq');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

readGraphWriteSuite({
  name: 'OxigraphStore (embedded, persisted)',
  adapter: 'oxigraph',
  open: async () => new OxigraphStore(persistPath),
  requests: sentToEngine(),
}, (context) => {
  const { store, inScenario } = context;
  blankNodeDeletes(context);
  injectedTermsChangeNothing(context);
  multiGraphDeletes(context);
  literalRoundTrips(context);
  it('a store reopened from what it flushed holds the same read graph', () => inScenario(async (s) => {
    await s.maintained(s.reference(s.G1), (o) => store().replaceGraph(s.G1, [q('r', 'reopened', s.G1)], o));
    await store().flush();
    const reopened = new OxigraphStore(persistPath, { readOnly: true });
    try {
      const rows = async (query: string) => {
        const result = await reopened.query(query);
        if (result.type !== 'bindings') throw new Error('Expected bindings');
        return result.bindings.map((b) => `${b.s} ${b.p} ${b.o}`).sort();
      };
      const readGraph = await rows(`SELECT ?s ?p ?o WHERE { GRAPH <${s.R}> { ?s ?p ?o } }`);
      expect(readGraph).toEqual(await s.readGraph());
      expect(readGraph).toEqual(await rows(
        `SELECT DISTINCT ?s ?p ?o WHERE { GRAPH ?h { ?s ?p ?o } FILTER(STRSTARTS(STR(?h), "${s.member}")) }`));
    } finally {
      await reopened.close();
    }
  }));
});

readGraphWriteSuite({
  name: 'OxigraphWorkerStore',
  adapter: 'oxigraph',
  open: async () => new OxigraphWorkerStore(),
  requests: sentToWorker(),
  replaceAssetGroup: false,
}, (context) => {
  blankNodeDeletes(context);
  injectedTermsChangeNothing(context);
  multiGraphDeletes(context);
  literalRoundTrips(context);
});
