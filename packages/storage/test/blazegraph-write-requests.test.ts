import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import {
  missingReadGraphMethods,
  readGraphCapabilitiesOf,
  type ReadGraphWriteOptions,
  type ReadGraphWritePlan,
} from '../src/read-graph/adapter-contract.js';
import {
  BLAZEGRAPH_WRITE_CASES,
  recordBlazegraphWrite,
} from './helpers/blazegraph-write-requests.js';

/**
 * The requests BlazegraphStore sends for each write method, recorded on the
 * base of this change with `recordBlazegraphWrite`. A write that carries no
 * read-graph operations must keep sending exactly these requests.
 */
const TODAY: Readonly<Record<string, readonly string[]>> = JSON.parse(
  readFileSync(new URL('./fixtures/blazegraph-write-requests.json', import.meta.url), 'utf8'),
);

describe('BlazegraphStore write requests', () => {
  it('records every write case once', () => {
    expect(Object.keys(TODAY).sort()).toEqual(BLAZEGRAPH_WRITE_CASES.map((c) => c.name).sort());
  });

  it.each(BLAZEGRAPH_WRITE_CASES)('$name sends the recorded requests', async (writeCase) => {
    const { requests, error } = await recordBlazegraphWrite((store) => writeCase.run(store));
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

describe('BlazegraphStore write requests with read-graph operations', () => {
  // An N-Quads insert cannot carry operations; it refuses them (below).
  const plannedCases = BLAZEGRAPH_WRITE_CASES.filter((c) => c.name !== 'insert');

  it.each(plannedCases)('$name sends them in the request that changes the data, and every other request as before',
    async (writeCase) => {
      const { requests, error } = await recordBlazegraphWrite((store) => writeCase.run(store, planned(PLAN)));
      expect(error).toBeUndefined();
      expect(requests).toEqual(TODAY[writeCase.name]!.map((request, index) =>
        index === writeCase.dataRequest ? carrying(request) : request));
    });

  it('sends only one side when the plan has only that side', async () => {
    const replaceSubject = BLAZEGRAPH_WRITE_CASES.find((c) => c.name === 'replaceSubject')!;
    for (const plan of [{ ...PLAN, after: [] }, { ...PLAN, before: [] }]) {
      const { requests } = await recordBlazegraphWrite((store) => replaceSubject.run(store, planned(plan)));
      expect(requests).toEqual([carrying(TODAY.replaceSubject![0]!, plan)]);
    }
  });

  it.each(BLAZEGRAPH_WRITE_CASES)('$name sends the recorded requests for a plan without operations', async (writeCase) => {
    const { requests, error } = await recordBlazegraphWrite((store) =>
      writeCase.run(store, planned({ readGraphs: [], before: [], after: [] })));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY[writeCase.name]);
  });

  it('insert refuses operations before it sends anything, also for no quads', async () => {
    for (const quads of [[{ subject: 'urn:test:s', predicate: 'urn:test:p', object: '"o"', graph: 'urn:test:g' }], []]) {
      const { requests, error } = await recordBlazegraphWrite((store) => store.insert(quads, planned(PLAN)));
      expect(String(error)).toMatch(/BlazegraphStore\.insert cannot send read-graph operations in its request/);
      expect(requests).toEqual([]);
    }
  });

  it('replaceGraph sends its cleanup after a failed update without the operations', async () => {
    const replaceGraph = BLAZEGRAPH_WRITE_CASES.find((c) => c.name === 'replaceGraph')!;
    const { requests, error } = await recordBlazegraphWrite(
      (store) => replaceGraph.run(store, planned(PLAN)),
      (request) => request.body.includes('MOVE GRAPH'),
    );
    expect(String(error)).toMatch(/Blazegraph update failed \(500\)/);
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
    const { requests } = await recordBlazegraphWrite((store) => store.update(sparql, planned(PLAN)));
    expect(requests).toEqual([carrying(`application/sparql-update\n${own}`)]);
    // Without operations the caller's text goes out exactly as it is.
    expect((await recordBlazegraphWrite((store) => store.update(sparql))).requests)
      .toEqual([`application/sparql-update\n${sparql}`]);
  });

  it.each([
    ['an escaped semicolon ending a prefixed name', ' DROP SILENT GRAPH ex:member\\;', ' DROP SILENT GRAPH ex:member\\;'],
    ['a final separator after an escaped semicolon', ' DROP SILENT GRAPH ex:member\\; ;', ' DROP SILENT GRAPH ex:member\\; '],
  ])('a caller update with %s keeps its prologue first and stays one valid request', async (_case, operations, own) => {
    const prologue = 'PREFIX ex: <urn:test:>';
    const { requests } = await recordBlazegraphWrite((store) => store.update(`${prologue}${operations}`, planned(PLAN)));
    expect(requests).toEqual([`application/sparql-update\n${prologue}\n${[...PLAN.before, own, ...PLAN.after].join('\n;\n')}`]);
  });

  it('declares every write it sends with operations, and that the engine runs one update at a time', () => {
    const store = new BlazegraphStore('http://blazegraph.invalid/sparql');
    expect(missingReadGraphMethods(store, readGraphCapabilitiesOf(store))).toEqual([]);
    expect([...store.readGraphCapabilities.methods].sort()).toEqual(plannedCases
      .map((c) => c.name.split(' ')[0]!).filter((name, i, all) => all.indexOf(name) === i).sort());
    expect(store.readGraphCapabilities.serialUpdates).toBe(true);
  });
});
