import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  missingReadGraphMethods,
  readGraphCapabilitiesOf,
  type ReadGraphWriteOptions,
  type ReadGraphWritePlan,
} from '../src/read-graph/adapter-contract.js';
import {
  newSparqlHttpTestStore,
  recordSparqlHttpWrite,
  SPARQL_HTTP_WRITE_CASES,
} from './helpers/sparql-http-write-requests.js';

/**
 * The requests SparqlHttpStore sends for each write method, recorded on the
 * base of this change with `recordSparqlHttpWrite`. A write that carries no
 * read-graph operations must keep sending exactly these requests.
 */
const TODAY: Readonly<Record<string, readonly string[]>> = JSON.parse(
  readFileSync(new URL('./fixtures/sparql-http-write-requests.json', import.meta.url), 'utf8'),
);

describe('SparqlHttpStore write requests', () => {
  it('records every write case once', () => {
    expect(Object.keys(TODAY).sort()).toEqual(SPARQL_HTTP_WRITE_CASES.map((c) => c.name).sort());
  });

  it.each(SPARQL_HTTP_WRITE_CASES)('$name sends the recorded requests', async (writeCase) => {
    const { requests, error } = await recordSparqlHttpWrite((store) => writeCase.run(store));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY[writeCase.name]);
  });
});

const PLAN: ReadGraphWritePlan = {
  readGraphs: ['urn:test:rg:read'],
  before: [
    'DELETE DATA { GRAPH <urn:test:rg:read> { <urn:test:rg:s> <urn:test:rg:p> "before-1" } }',
    'DELETE DATA { GRAPH <urn:test:rg:read> { <urn:test:rg:s> <urn:test:rg:p> "before-2" } }',
  ],
  after: ['INSERT DATA { GRAPH <urn:test:rg:read> { <urn:test:rg:s> <urn:test:rg:p> "after-1" } }'],
};
const planned = (plan: ReadGraphWritePlan): ReadGraphWriteOptions => ({ readGraphPlan: plan });

/** A recorded update request with the plan's operations around its own text. */
function carrying(request: string, plan: ReadGraphWritePlan = PLAN): string {
  const [type, ...body] = request.split('\n');
  return `${type}\n${[...plan.before, body.join('\n'), ...plan.after].join('\n;\n')}`;
}

describe('SparqlHttpStore write requests with read-graph operations', () => {
  // The layer adds an insert's read-graph quads to the same call; insert refuses operations (below).
  const plannedCases = SPARQL_HTTP_WRITE_CASES.filter((c) => c.name !== 'insert');
  const plannedMethods = [...new Set(plannedCases.map((c) => c.name.split(' ')[0]!))].sort();

  it.each(plannedCases)('$name sends them in the request that changes the data, and every other request as before',
    async (writeCase) => {
      const { requests, error } = await recordSparqlHttpWrite((store) => writeCase.run(store, planned(PLAN)));
      expect(error).toBeUndefined();
      expect(requests).toEqual(TODAY[writeCase.name]!.map((request, index) =>
        index === writeCase.dataRequest ? carrying(request) : request));
    });

  it('sends only one side when the plan has only that side', async () => {
    const replaceSubject = SPARQL_HTTP_WRITE_CASES.find((c) => c.name === 'replaceSubject')!;
    for (const plan of [{ ...PLAN, after: [] }, { ...PLAN, before: [] }]) {
      const { requests } = await recordSparqlHttpWrite((store) => replaceSubject.run(store, planned(plan)));
      expect(requests).toEqual([carrying(TODAY.replaceSubject![0]!, plan)]);
    }
  });

  it.each(SPARQL_HTTP_WRITE_CASES)('$name sends the recorded requests for a plan without operations', async (writeCase) => {
    const { requests, error } = await recordSparqlHttpWrite((store) =>
      writeCase.run(store, planned({ readGraphs: [], before: [], after: [] })));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY[writeCase.name]);
  });

  it('insert refuses operations before it sends anything', async () => {
    const insert = SPARQL_HTTP_WRITE_CASES.find((c) => c.name === 'insert')!;
    const { requests, error } = await recordSparqlHttpWrite((store) => insert.run(store, planned(PLAN)));
    expect(String(error)).toMatch(/SparqlHttpStore\.insert cannot send read-graph operations in its request/);
    expect(requests).toEqual([]);
  });

  it('replaceGraph sends its cleanup after a failed update without the operations', async () => {
    const replaceGraph = SPARQL_HTTP_WRITE_CASES.find((c) => c.name === 'replaceGraph')!;
    const { requests, error } = await recordSparqlHttpWrite(
      (store) => replaceGraph.run(store, planned(PLAN)),
      { fail: (request) => request.body.includes('MOVE SILENT GRAPH') || request.body.includes('MOVE GRAPH') },
    );
    expect(String(error)).toMatch(/500/);
    expect(requests).toEqual([
      carrying(TODAY.replaceGraph![0]!),
      'application/sparql-update\nDROP SILENT GRAPH <urn:dkg:internal:atomic-graph-replace:{uuid-1}>',
    ]);
  });

  it.each([
    ['a final separator', 'DROP SILENT GRAPH <urn:test:g> ;  \n', 'DROP SILENT GRAPH <urn:test:g>   \n'],
    ['a final separator before a comment', 'DROP SILENT GRAPH <urn:test:g>; # done', 'DROP SILENT GRAPH <urn:test:g> # done'],
    ['a separator only inside a string', 'INSERT DATA { <urn:test:s> <urn:test:p> "a ;" }', 'INSERT DATA { <urn:test:s> <urn:test:p> "a ;" }'],
    ['a separator only inside an IRI', 'DROP SILENT GRAPH <urn:test:g;>', 'DROP SILENT GRAPH <urn:test:g;>'],
    ['a separator only inside a comment', 'DROP SILENT GRAPH <urn:test:g> # done;', 'DROP SILENT GRAPH <urn:test:g> # done;'],
  ])('a caller update with %s stays one valid request', async (_case, sparql, own) => {
    const { requests } = await recordSparqlHttpWrite((store) => store.update(sparql, planned(PLAN)));
    expect(requests).toEqual([carrying(`application/sparql-update\n${own}`)]);
    // Without operations the caller's text goes out exactly as it is.
    expect((await recordSparqlHttpWrite((store) => store.update(sparql))).requests)
      .toEqual([`application/sparql-update\n${sparql}`]);
  });

  it.each([
    ['an escaped semicolon ending a prefixed name', ' DROP SILENT GRAPH ex:member\\;', ' DROP SILENT GRAPH ex:member\\;'],
    ['a final separator after an escaped semicolon', ' DROP SILENT GRAPH ex:member\\; ;', ' DROP SILENT GRAPH ex:member\\; '],
  ])('a caller update with %s keeps its prologue first and stays one valid request', async (_case, operations, own) => {
    const prologue = 'PREFIX ex: <urn:test:>';
    const { requests } = await recordSparqlHttpWrite((store) => store.update(`${prologue}${operations}`, planned(PLAN)));
    expect(requests).toEqual([`application/sparql-update\n${prologue}\n${[...PLAN.before, own, ...PLAN.after].join('\n;\n')}`]);
  });

  it.each([
    ['one declaration', 'PREFIX ex: <urn:test:ex:>', ' INSERT DATA { ex:s ex:p "o" }'],
    ['declarations, comments and a base',
      '# replace\nprefix ex:<urn:test:ex:#> # two\nBASE <urn:test:base/>\nPREFIX : <urn:test:default:>', '\nINSERT DATA { :s ex:p <o> }'],
    ['a comment inside a declaration', 'PREFIX ex: # namespace\n<urn:test:ex:>', ' INSERT DATA { ex:s ex:p "o" }'],
    ['long whitespace after it', 'PREFIX ex: <urn:test:ex:>', `${' '.repeat(100_000)}INSERT DATA { ex:s ex:p "o" }`],
  ])('a caller update that opens with a prologue keeps it at the start: %s', async (_case, prologue, operations) => {
    const { requests } = await recordSparqlHttpWrite((store) => store.update(`${prologue}${operations}`, planned(PLAN)));
    expect(requests).toEqual([`application/sparql-update\n${prologue}\n${carrying(`x\n${operations}`).slice(2)}`]);
  });

  it.each([
    ['a prologue later in the caller text', 'DROP SILENT GRAPH <urn:test:g> ; PREFIX ex: <urn:test:ex:> INSERT DATA { ex:s ex:p "o" }'],
    ['long whitespace before an update with no prologue', `${' '.repeat(100_000)}DROP SILENT GRAPH <urn:test:g>`],
  ])('%s stays where it is', async (_case, sparql) => {
    const startedAt = performance.now();
    const { requests } = await recordSparqlHttpWrite((store) => store.update(sparql, planned(PLAN)));
    expect(requests).toEqual([carrying(`application/sparql-update\n${sparql}`)]);
    // One linear scan of the text: no backtracking over whitespace.
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it('counts the read graphs a planned write maintains among the graphs it writes', async () => {
    const replaceSubject = SPARQL_HTTP_WRITE_CASES.find((c) => c.name === 'replaceSubject')!;
    const [readGraph] = PLAN.readGraphs;
    const { error } = await recordSparqlHttpWrite(async (store) => {
      const before = store.getWriteRevision(readGraph!);
      await replaceSubject.run(store);
      expect(store.getWriteRevision(readGraph!)).toEqual(before);
      await replaceSubject.run(store, planned(PLAN));
      const after = store.getWriteRevision(readGraph!);
      expect(after.generation).not.toEqual(before.generation);
      expect(after.stable).toBe(true);
    });
    expect(error).toBeUndefined();
  });

  it('declares every write it sends with operations on an atomic endpoint, and that updates may run side by side', () => {
    for (const profile of ['atomic-update', 'atomic-readback'] as const) {
      const store = newSparqlHttpTestStore(profile);
      expect(missingReadGraphMethods(store, readGraphCapabilitiesOf(store))).toEqual([]);
      expect([...store.readGraphCapabilities.methods].sort()).toEqual(plannedMethods);
      expect(store.readGraphCapabilities.serialUpdates).toBe(false);
    }
  });

  it('declares nothing on a best-effort endpoint, and refuses operations there before it sends anything', async () => {
    const store = newSparqlHttpTestStore('best-effort');
    expect(store.readGraphCapabilities.methods).toEqual([]);
    expect(missingReadGraphMethods(store, readGraphCapabilitiesOf(store)).sort()).toEqual(plannedMethods);
    for (const name of ['delete', 'deleteByPatternWithoutCount', 'dropGraph', 'update']) {
      const writeCase = SPARQL_HTTP_WRITE_CASES.find((c) => c.name === name)!;
      const { requests, error } = await recordSparqlHttpWrite((s) => writeCase.run(s, planned(PLAN)), { profile: 'best-effort' });
      expect(String(error)).toMatch(/cannot send read-graph operations in its request/);
      expect(requests).toEqual([]);
      // Without a plan the best-effort endpoint gets today's requests.
      expect((await recordSparqlHttpWrite((s) => writeCase.run(s), { profile: 'best-effort' })).requests).toEqual(TODAY[name]);
    }
  });
});
