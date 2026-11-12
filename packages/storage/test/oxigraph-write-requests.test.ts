import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { OxigraphWorkerStore } from '../src/adapters/oxigraph-worker.js';
import {
  missingReadGraphMethods,
  readGraphCapabilitiesOf,
  type ReadGraphWriteOptions,
  type ReadGraphWritePlan,
} from '../src/read-graph/adapter-contract.js';
import {
  OXIGRAPH_WRITE_CASES,
  recordOxigraphWorkerWrite,
  recordOxigraphWrite,
  type OxigraphWriteCase,
} from './helpers/oxigraph-write-requests.js';
import { G, P, S } from './helpers/write-request-recording.js';

/**
 * What embedded Oxigraph is asked to do for each write method, recorded on the
 * base of this change: OxigraphStore's engine calls, and the messages
 * OxigraphWorkerStore posts to its worker. A write that carries no read-graph
 * operations must keep making exactly these.
 */
const TODAY: Readonly<Record<'embedded' | 'worker', Readonly<Record<string, readonly string[]>>>> = JSON.parse(
  readFileSync(new URL('./fixtures/oxigraph-write-requests.json', import.meta.url), 'utf8'),
);
const WORKER_CASES = OXIGRAPH_WRITE_CASES.filter((c) => c.worker !== false);

describe('OxigraphStore engine calls', () => {
  it('records every write case once', () => {
    expect(Object.keys(TODAY.embedded).sort()).toEqual(OXIGRAPH_WRITE_CASES.map((c) => c.name).sort());
  });

  it.each(OXIGRAPH_WRITE_CASES)('$name makes the recorded engine calls', async (writeCase) => {
    const { requests, error } = await recordOxigraphWrite((store) => writeCase.run(store));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY.embedded[writeCase.name]);
  });
});

describe('OxigraphWorkerStore worker messages', () => {
  it('records every write case of the worker store once', () => {
    expect(Object.keys(TODAY.worker).sort()).toEqual(WORKER_CASES.map((c) => c.name).sort());
  });

  it.each(WORKER_CASES)('$name posts the recorded messages', async (writeCase) => {
    const { requests, error } = await recordOxigraphWorkerWrite((store) => writeCase.run(store));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY.worker[writeCase.name]);
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

/** An engine `update` call with the plan's operations around `own`. */
const carrying = (own: string, plan: ReadGraphWritePlan = PLAN) => `update\n${[...plan.before, own, ...plan.after].join('\n;\n')}`;
// insert refuses operations, and so does a delete of a quad with a blank node (below).
const plannedCases = OXIGRAPH_WRITE_CASES.filter((c) => c.name !== 'insert' && c.name !== 'delete with a blank node');
const plannedMethods = (cases: readonly OxigraphWriteCase[]) => [...new Set(cases.map((c) => c.name.split(' ')[0]!))].sort();

/**
 * With a plan, `delete` and `deleteByPattern` replace their per-quad engine
 * calls with one update; every other write keeps its calls and its data update
 * carries the operations.
 */
const ONE_UPDATE: Readonly<Record<string, string>> = {
  'delete': `DELETE DATA { GRAPH <${G}> { <${S}> <${P}> "one" . } }`,
  'deleteByPattern': `DELETE { GRAPH <${G}> { <${S}> ?p ?o } } WHERE { GRAPH <${G}> { <${S}> ?p ?o } }`,
  'deleteByPatternWithoutCount': `DELETE { GRAPH <${G}> { ?s <${P}> ?o } } WHERE { GRAPH <${G}> { ?s <${P}> ?o } }`,
};

describe('OxigraphStore engine calls with read-graph operations', () => {
  it.each(plannedCases)('$name sends them in the update that changes the data, and makes every other call as before',
    async (writeCase) => {
      const { requests, error } = await recordOxigraphWrite((store) => writeCase.run(store, planned(PLAN)));
      expect(error).toBeUndefined();
      const oneUpdate = ONE_UPDATE[writeCase.name];
      expect(requests).toEqual(oneUpdate !== undefined
        ? [carrying(oneUpdate)]
        : TODAY.embedded[writeCase.name]!.map((call, index) =>
          index === writeCase.dataRequest ? carrying(call.slice('update\n'.length)) : call));
    });

  it.each(OXIGRAPH_WRITE_CASES)('$name makes the recorded engine calls for a plan without operations', async (writeCase) => {
    const { requests, error } = await recordOxigraphWrite((store) =>
      writeCase.run(store, planned({ readGraphs: [], before: [], after: [] })));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY.embedded[writeCase.name]);
  });

  it('a delete of a quad with a blank node refuses operations before it changes anything', async () => {
    const blankNode = OXIGRAPH_WRITE_CASES.find((c) => c.name === 'delete with a blank node')!;
    const { requests, error } = await recordOxigraphWrite((store) => blankNode.run(store, planned(PLAN)));
    expect(String(error)).toMatch(/OxigraphStore\.delete cannot send read-graph operations with a quad that has a blank node/);
    expect(requests).toEqual([]);
  });

  it('a pattern delete with a blank node in its pattern refuses operations before it changes anything', async () => {
    const { requests, error } = await recordOxigraphWrite((store) => store.deleteByPattern({ graph: G, object: '_:b1' }, planned(PLAN)));
    expect(String(error)).toMatch(/OxigraphStore\.deleteByPattern cannot send read-graph operations with a blank node in its pattern/);
    expect(requests).toEqual([]);
  });

  it('insert refuses operations before it changes anything', async () => {
    const insert = OXIGRAPH_WRITE_CASES.find((c) => c.name === 'insert')!;
    const { requests, error } = await recordOxigraphWrite((store) => insert.run(store, planned(PLAN)));
    expect(String(error)).toMatch(/OxigraphStore\.insert cannot send read-graph operations in its request/);
    expect(requests).toEqual([]);
  });

  it('a caller update that opens with a prologue keeps it at the start', async () => {
    const sparql = `PREFIX ex: <urn:test:ex:> INSERT DATA { GRAPH <${G}> { ex:s ex:p "o" } } ;`;
    const { requests, error } = await recordOxigraphWrite((store) => store.update(sparql, planned(PLAN)));
    expect(error).toBeUndefined();
    expect(requests).toEqual([`update\nPREFIX ex: <urn:test:ex:>\n${carrying(` INSERT DATA { GRAPH <${G}> { ex:s ex:p "o" } } `).slice('update\n'.length)}`]);
  });

  it('declares every planned method, and that the engine runs one update at a time', () => {
    const store = new OxigraphStore();
    expect(missingReadGraphMethods(store, readGraphCapabilitiesOf(store))).toEqual([]);
    expect([...store.readGraphCapabilities.methods].sort()).toEqual(plannedMethods(plannedCases));
    expect(store.readGraphCapabilities.serialUpdates).toBe(true);
    // A planned delete of a quad with a blank node is refused (above), and the store says so.
    expect(store.readGraphCapabilities.plansBlankNodeDeletes).toBe(false);
  });
});

describe('OxigraphWorkerStore worker messages with read-graph operations', () => {
  const workerPlannedCases = WORKER_CASES.filter((c) => c.name !== 'insert' && c.name !== 'delete with a blank node');

  it.each(workerPlannedCases)('$name posts the plan with its write, and nothing else changes', async (writeCase) => {
    const { requests, error } = await recordOxigraphWorkerWrite((store) => writeCase.run(store, planned(PLAN)));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY.worker[writeCase.name]!.map((message, index) => {
      if (index !== writeCase.dataRequest) return message;
      const [method, args] = [message.slice(0, message.indexOf('\n')), message.slice(message.indexOf('\n') + 1)];
      return `${method}\n${JSON.stringify([...JSON.parse(args) as unknown[], { readGraphPlan: PLAN }])}`;
    }));
  });

  it.each(WORKER_CASES)('$name posts the recorded message for a plan without operations', async (writeCase) => {
    const { requests, error } = await recordOxigraphWorkerWrite((store) =>
      writeCase.run(store, planned({ readGraphs: [], before: [], after: [] })));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY.worker[writeCase.name]);
  });

  it('a delete of a quad with a blank node posts its plan, and the worker refuses it before it changes anything', async () => {
    const blankNode = WORKER_CASES.find((c) => c.name === 'delete with a blank node')!;
    const { requests, error } = await recordOxigraphWorkerWrite((store) => blankNode.run(store, planned(PLAN)));
    expect(String(error)).toMatch(/OxigraphStore\.delete cannot send read-graph operations with a quad that has a blank node/);
    const [message] = TODAY.worker[blankNode.name]!;
    expect(requests).toEqual([`delete\n${JSON.stringify([...JSON.parse(message!.slice('delete\n'.length)) as unknown[], { readGraphPlan: PLAN }])}`]);
  });

  it('insert refuses operations before it posts anything', async () => {
    const insert = WORKER_CASES.find((c) => c.name === 'insert')!;
    const { requests, error } = await recordOxigraphWorkerWrite((store) => insert.run(store, planned(PLAN)));
    expect(String(error)).toMatch(/OxigraphWorkerStore\.insert cannot send read-graph operations in its request/);
    expect(requests).toEqual([]);
  });

  it('declares every planned method it has, and that its worker runs one update at a time', async () => {
    const store = new OxigraphWorkerStore();
    try {
      expect(missingReadGraphMethods(store, readGraphCapabilitiesOf(store))).toEqual([]);
      expect([...store.readGraphCapabilities.methods].sort()).toEqual(plannedMethods(workerPlannedCases));
      expect(store.readGraphCapabilities.serialUpdates).toBe(true);
      expect(store.readGraphCapabilities.plansBlankNodeDeletes).toBe(false);
    } finally {
      await store.close();
    }
  });
});

describe('the read graphs of a planned write count among the graphs it writes', () => {
  it.each([
    ['OxigraphStore', () => new OxigraphStore()],
    ['OxigraphWorkerStore', () => new OxigraphWorkerStore()],
  ] as const)('%s moves their write revision, and a write without a plan does not', async (_name, open) => {
    const replaceSubject = OXIGRAPH_WRITE_CASES.find((c) => c.name === 'replaceSubject')!;
    const [readGraph] = PLAN.readGraphs;
    const store = open();
    try {
      const before = store.getWriteRevision(readGraph!);
      await replaceSubject.run(store);
      expect(store.getWriteRevision(readGraph!)).toEqual(before);
      await replaceSubject.run(store, planned(PLAN));
      const after = store.getWriteRevision(readGraph!);
      expect(after.generation).not.toEqual(before.generation);
      expect(after.stable).toBe(true);
    } finally {
      await store.close();
    }
  });
});
