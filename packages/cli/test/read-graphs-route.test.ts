// The node-admin read-graph routes behind `dkg store read-graphs`, on a real
// read-graph layer over embedded Oxigraph with read graphs built by the
// node's own builder.
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readGraphIri, readScope, type ReadGraphKey } from '@origintrail-official/dkg-core';
import {
  CURRENT_READ_GRAPH_VERSIONS,
  OxigraphStore,
  READ_GRAPH_PLANNED_METHODS,
  buildReadGraph,
  wrapReadGraphLayer,
  type Quad,
} from '@origintrail-official/dkg-storage';
import type { AllowedHttpAuthentication } from '../src/auth.js';
import { handleRequest, type HandleRequestInput } from '../src/daemon/handle-request.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleReadGraphRoutes } from '../src/daemon/routes/read-graphs.js';
import { READ_GRAPHS_PATH } from '../src/read-graphs-wire.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const AGENT_ADDRESS = `0x${'ab'.repeat(20)}`;
const AGENT = requestAuthentication({ kind: 'agent', agentAddress: AGENT_ADDRESS });
const OPERATOR = requestAuthentication({ kind: 'nodeOperator' });
const P = 'urn:test:p';
const CG = 'read-graphs-route';
const OTHER = 'read-graphs-other';
const root = (contextGraphId: string) => `did:dkg:context-graph:${contextGraphId}`;
const q = (subject: string, graph: string): Quad => ({ subject, predicate: P, object: `"${subject}"`, graph });

const KEYS: Readonly<Record<'vm' | 'swm' | 'codeVm' | 'wm' | 'otherVm', ReadGraphKey>> = {
  vm: { scope: readScope(CG), layer: MemoryLayer.VerifiableMemory },
  swm: { scope: readScope(CG), layer: MemoryLayer.SharedWorkingMemory },
  codeVm: { scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory },
  wm: { scope: readScope(CG), layer: MemoryLayer.WorkingMemory, agentAddress: AGENT_ADDRESS },
  otherVm: { scope: readScope(OTHER), layer: MemoryLayer.VerifiableMemory },
};
const IRI = Object.fromEntries(Object.entries(KEYS).map(([name, key]) => [name, readGraphIri(key)])) as Record<keyof typeof KEYS, string>;

/** Embedded Oxigraph that offers no write the read-graph layer would have to plan, so its read graphs are maintained. */
class InsertOnlyOxigraph extends OxigraphStore {
  readonly readGraphCapabilities = Object.freeze({ methods: Object.freeze(['update'] as const), serialUpdates: true });
  constructor() {
    super();
    for (const method of READ_GRAPH_PLANNED_METHODS.filter((name) => name !== 'update')) {
      Object.defineProperty(this, method, { value: undefined, configurable: true, writable: true });
    }
  }
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A context graph with a registered sub-graph, a second context graph, and five read graphs built over them. */
async function node() {
  const adapter = new InsertOnlyOxigraph();
  const store = wrapReadGraphLayer(adapter, { backend: 'oxigraph' });
  const dataDir = mkdtempSync(join(tmpdir(), 'read-graphs-route-'));
  dirs.push(dataDir);
  await store.insert([
    { subject: `${root(CG)}/code`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${root(CG)}/_meta` },
    { subject: `${root(CG)}/code`, predicate: 'http://schema.org/name', object: '"code"', graph: `${root(CG)}/_meta` },
    q('urn:s:vm', `${root(CG)}/_verifiable_memory/${AGENT_ADDRESS}/1`),
    q('urn:s:code', `${root(CG)}/code/_verifiable_memory/${AGENT_ADDRESS}/2`),
    q('urn:s:swm', `${root(CG)}/_shared_memory/${AGENT_ADDRESS}/3`),
    q('urn:s:wm', `${root(CG)}/_working_memory/${AGENT_ADDRESS}/4`),
    q('urn:s:other', `${root(OTHER)}/_verifiable_memory/${AGENT_ADDRESS}/5`),
  ]);
  for (const key of Object.values(KEYS)) expect(await buildReadGraph({ store, dataDir }, key)).toMatchObject({ outcome: 'done' });
  const stateOf = (readGraph: string) => store.runtime.mirror.get(readGraph)?.state;
  return { adapter, store, dataDir, stateOf };
}

function fakeReq(method: string, path: string, rawBody = '') {
  const req = Readable.from([]);
  Object.assign(req, { method, url: path, headers: { host: '127.0.0.1' }, __dkgPrebufferedBody: Buffer.from(rawBody, 'utf8') });
  return req as unknown as RequestContext['req'];
}

function fakeRes() {
  return Object.assign(new EventEmitter(), {
    statusCode: 0,
    body: '',
    writableEnded: false,
    headersSent: false,
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
    end(body?: string) { this.body = body ?? ''; this.writableEnded = true; return this; },
  });
}

async function call(
  store: unknown,
  method: string,
  target: string,
  options: { body?: unknown; authentication?: AllowedHttpAuthentication; dataDir?: string; res?: ReturnType<typeof fakeRes> } = {},
) {
  const res = options.res ?? fakeRes();
  const url = new URL(`http://127.0.0.1${target}`);
  const raw = options.body === undefined ? '' : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  const ctx = {
    req: fakeReq(method, target, raw),
    res,
    url,
    path: url.pathname,
    authentication: options.authentication ?? OPERATOR,
    agent: { store },
  } as unknown as RequestContext;
  await handleReadGraphRoutes(ctx, { dataDir: options.dataDir ?? '/no-such-dir' });
  return { handled: res.writableEnded, status: res.statusCode, body: res.body ? JSON.parse(res.body) as Record<string, unknown> : undefined };
}

const NO_STATES = { building: 0, ready: 0, dirty: 0, repairing: 0, rebuilding: 0 };

describe('GET /api/store/read-graphs', () => {
  it('lists the read graphs in IRI order with their scope, layer, state and generation', async () => {
    const { store } = await node();
    const answer = await call(store, 'GET', READ_GRAPHS_PATH);
    expect(answer.status).toBe(200);
    const listed = answer.body!.readGraphs as Array<Record<string, unknown>>;
    expect(listed.map((graph) => graph.readGraph)).toEqual(Object.values(IRI).sort());
    const generation = store.runtime.mirror.get(IRI.codeVm)!.generation;
    expect(listed.find((graph) => graph.readGraph === IRI.codeVm)).toEqual({
      readGraph: IRI.codeVm, contextGraphId: CG, subGraphName: 'code', layer: 'vm', state: 'ready', generation,
    });
    expect(listed.find((graph) => graph.readGraph === IRI.wm)).toMatchObject({ contextGraphId: CG, layer: 'wm', agentAddress: AGENT_ADDRESS });
    expect(listed.find((graph) => graph.readGraph === IRI.swm)).not.toHaveProperty('agentAddress');
    expect(listed.find((graph) => graph.readGraph === IRI.swm)).not.toHaveProperty('subGraphName');
    expect(answer.body!.states).toEqual({ ...NO_STATES, ready: 5 });
  });

  it('narrows the list to one context graph, one layer, or both', async () => {
    const { store } = await node();
    const listed = async (query: string) => ((await call(store, 'GET', `${READ_GRAPHS_PATH}?${query}`)).body!.readGraphs as Array<{ readGraph: string }>)
      .map((graph) => graph.readGraph);
    expect(await listed(`contextGraphId=${OTHER}`)).toEqual([IRI.otherVm]);
    expect(await listed('layer=vm')).toEqual([IRI.vm, IRI.codeVm, IRI.otherVm].sort());
    expect(await listed(`contextGraphId=${CG}&layer=swm`)).toEqual([IRI.swm]);
    expect(await listed('contextGraphId=no-read-graphs')).toEqual([]);
  });

  it('lists nothing on a store without the read-graph layer', async () => {
    expect(await call(new OxigraphStore(), 'GET', READ_GRAPHS_PATH)).toEqual({ handled: true, status: 200, body: { readGraphs: [], states: NO_STATES } });
    expect(await call(new OxigraphStore(), 'POST', `${READ_GRAPHS_PATH}/check`, { body: {} })).toMatchObject({ status: 200, body: { results: [] } });
  });
});

describe('the read-graph routes refuse', () => {
  it('an agent-scoped token before they read the request', async () => {
    const { store, stateOf } = await node();
    for (const [method, path] of [['GET', READ_GRAPHS_PATH], ['POST', `${READ_GRAPHS_PATH}/rebuild`], ['POST', `${READ_GRAPHS_PATH}/drop`]] as const) {
      const answer = await call(store, method, path, { body: '{not json', authentication: AGENT });
      expect(answer.status).toBe(403);
      expect(answer.body!.error).toMatch(/requires a node-level admin token/);
    }
    expect(stateOf(IRI.vm)).toBe('ready');
  });

  it.each<[string, string, unknown, RegExp]>([
    ['GET', `${READ_GRAPHS_PATH}?layer=xx`, undefined, /layer must be one of wm, swm, vm/],
    ['GET', `${READ_GRAPHS_PATH}?mode=full`, undefined, /Unknown field "mode"/],
    ['GET', `${READ_GRAPHS_PATH}?contextGraphId=`, undefined, /Invalid contextGraphId/],
    ['POST', `${READ_GRAPHS_PATH}/check`, { mode: 'deep' }, /mode must be one of full, sampled/],
    ['POST', `${READ_GRAPHS_PATH}/rebuild`, { mode: 'full' }, /Unknown field "mode"/],
    ['POST', `${READ_GRAPHS_PATH}/drop`, '{not json', /must be a JSON object/],
    ['POST', `${READ_GRAPHS_PATH}/drop`, [], /must be a JSON object/],
    ['POST', `${READ_GRAPHS_PATH}/drop`, { contextGraphId: 7 }, /contextGraphId must be a string/],
  ])('%s %s with %j as a bad request, and changes nothing', async (method, path, body, error) => {
    const { store, stateOf } = await node();
    const answer = await call(store, method, path, { body });
    expect(answer.status).toBe(400);
    expect(answer.body!.error).toMatch(error);
    expect(Object.values(IRI).map(stateOf)).toEqual(Object.values(IRI).map(() => 'ready'));
  });

  it('no path or method they do not own', async () => {
    const store = new OxigraphStore();
    for (const [method, path] of [
      ['POST', READ_GRAPHS_PATH], ['GET', `${READ_GRAPHS_PATH}/check`], ['POST', `${READ_GRAPHS_PATH}/status`],
      ['POST', `${READ_GRAPHS_PATH}/check/now`], ['GET', `${READ_GRAPHS_PATH}/`], ['GET', `${READ_GRAPHS_PATH}/status`], ['GET', '/api/store/read-graphsx'],
    ] as const) {
      expect(await call(store, method, path, { authentication: AGENT }), `${method} ${path}`).toEqual({ handled: false, status: 0, body: undefined });
    }
  });
});

describe('POST /api/store/read-graphs/check', () => {
  it('checks each read graph in full by default, and a mismatch marks it dirty', async () => {
    const { adapter, store, stateOf } = await node();
    const consistent = await call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: { contextGraphId: CG, layer: 'vm' } });
    expect(consistent).toEqual({
      handled: true, status: 200,
      body: { results: [IRI.vm, IRI.codeVm].sort().map((readGraph) => ({ readGraph, outcome: 'consistent' })) },
    });
    // A triple no member holds, written below the layer.
    await adapter.insert([q('urn:s:stray', IRI.vm)]);
    const mismatch = await call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: { contextGraphId: CG, layer: 'vm' } });
    expect(mismatch.body!.results).toContainEqual({ readGraph: IRI.vm, outcome: 'mismatch', direction: 'unheld' });
    expect(mismatch.body!.results).toContainEqual({ readGraph: IRI.codeVm, outcome: 'consistent' });
    expect(stateOf(IRI.vm)).toBe('dirty');
    expect(stateOf(IRI.codeVm)).toBe('ready');
    // A dirty read graph is not checked.
    const skipped = await call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: { contextGraphId: CG, layer: 'vm', mode: 'sampled' } });
    expect(skipped.body!.results).toContainEqual({ readGraph: IRI.vm, outcome: 'skipped' });
    expect((await call(store, 'GET', `${READ_GRAPHS_PATH}?layer=vm`)).body!.states).toEqual({ ...NO_STATES, ready: 2, dirty: 1 });
  });

  it('reports a check that fails and goes on with the next read graph', async () => {
    const { adapter, store } = await node();
    vi.spyOn(adapter, 'query').mockRejectedValueOnce(new Error('the store went away'));
    const answer = await call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: { layer: 'vm' } });
    const results = answer.body!.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ readGraph: [IRI.vm, IRI.codeVm, IRI.otherVm].sort()[0], outcome: 'error', error: 'the store went away' });
    expect(results.slice(1).map((result) => result.outcome)).toEqual(['consistent', 'consistent']);
  });
});

describe('POST /api/store/read-graphs/rebuild', () => {
  it('marks each read graph dirty for the builder, and leaves the others', async () => {
    const { dataDir, store, stateOf } = await node();
    const answer = await call(store, 'POST', `${READ_GRAPHS_PATH}/rebuild`, { body: { contextGraphId: CG, layer: 'swm' }, dataDir });
    expect(answer).toEqual({ handled: true, status: 200, body: { marked: [{ readGraph: IRI.swm, state: 'dirty' }] } });
    expect(stateOf(IRI.swm)).toBe('dirty');
    expect(stateOf(IRI.vm)).toBe('ready');
    // The builder's next pass rebuilds it.
    expect(await buildReadGraph({ store, dataDir }, KEYS.swm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
  });

  it('reports a read graph its store cannot maintain', async () => {
    const store = wrapReadGraphLayer(new OxigraphStore(), { backend: 'oxigraph' });
    store.runtime.mirror.set({ readGraph: IRI.vm, state: 'ready', generation: 1, ...CURRENT_READ_GRAPH_VERSIONS });
    const rebuilt = await call(store, 'POST', `${READ_GRAPHS_PATH}/rebuild`, { body: {} });
    expect(rebuilt.body).toEqual({ marked: [{ readGraph: IRI.vm, error: expect.stringMatching(/cannot maintain read graphs/) }] });
    expect(store.runtime.mirror.get(IRI.vm)?.state).toBe('ready');
    // Such a read graph can still be dropped.
    const dropped = await call(store, 'POST', `${READ_GRAPHS_PATH}/drop`, { body: {} });
    expect(dropped.body).toEqual({ removed: [{ readGraph: IRI.vm, outcome: 'current' }] });
    expect(store.runtime.mirror.get(IRI.vm)).toBeUndefined();
  });
});

describe('POST /api/store/read-graphs/drop', () => {
  it('removes each read graph, its contents and its row', async () => {
    const { adapter, dataDir, store, stateOf } = await node();
    const answer = await call(store, 'POST', `${READ_GRAPHS_PATH}/drop`, { body: { contextGraphId: OTHER }, dataDir });
    expect(answer).toEqual({ handled: true, status: 200, body: { removed: [{ readGraph: IRI.otherVm, outcome: 'done' }] } });
    expect(stateOf(IRI.otherVm)).toBeUndefined();
    const left = await adapter.query(`SELECT ?s WHERE { GRAPH <${IRI.otherVm}> { ?s ?p ?o } }`);
    expect(left.type === 'bindings' ? left.bindings : undefined).toEqual([]);
    expect(((await call(store, 'GET', READ_GRAPHS_PATH)).body!.readGraphs as unknown[])).toHaveLength(4);
  });

  it('starts no other read graph once the caller has gone away', async () => {
    const { adapter, dataDir, store, stateOf } = await node();
    const res = fakeRes();
    const update = adapter.update.bind(adapter);
    vi.spyOn(adapter, 'update').mockImplementation(async (sparql, options) => {
      await update(sparql, options);
      res.emit('close');
    });
    const answer = await call(store, 'POST', `${READ_GRAPHS_PATH}/rebuild`, { body: { contextGraphId: CG }, dataDir, res });
    const [first, ...rest] = [IRI.vm, IRI.swm, IRI.codeVm, IRI.wm].sort();
    expect((answer.body!.marked as Array<{ readGraph: string }>).map((marked) => marked.readGraph)).toEqual([first]);
    expect(rest.map(stateOf)).toEqual(rest.map(() => 'ready'));
  });
});

describe('the daemon dispatch', () => {
  it('routes the read-graph paths, behind the node-admin gate', async () => {
    const { store } = await node();
    const dispatch = async (authentication: AllowedHttpAuthentication) => {
      const res = fakeRes();
      await handleRequest({
        req: fakeReq('GET', `${READ_GRAPHS_PATH}?contextGraphId=${OTHER}`),
        res,
        agent: { store, resolveAgentAddress: () => AGENT_ADDRESS },
        authentication,
      } as unknown as HandleRequestInput);
      return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
    };
    expect((await dispatch(AGENT)).status).toBe(403);
    const answer = await dispatch(OPERATOR);
    expect(answer.status).toBe(200);
    expect((answer.body.readGraphs as Array<{ readGraph: string }>).map((graph) => graph.readGraph)).toEqual([IRI.otherVm]);
  });
});
