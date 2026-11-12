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
  checkReadGraph,
  readGraphLayerOf,
  withReadGraphBackgroundSlot,
  wrapReadGraphLayer,
  type Quad,
  type ReadGraphCheckResult,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import type { AllowedHttpAuthentication } from '../src/auth.js';
import { handleRequest, type HandleRequestInput } from '../src/daemon/handle-request.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { ReadGraphRequests, handleReadGraphRoutes } from '../src/daemon/routes/read-graphs.js';
import { beginGracefulShutdown } from '../src/daemon/teardown.js';
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

/** An embedded store that declares no read-graph capabilities, whatever its class declares. */
function undeclared(store: OxigraphStore): OxigraphStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'readGraphCapabilities') return undefined;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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

interface CheckReport { readonly mode: 'full' | 'sampled'; readonly at: number; readonly results: readonly ReadGraphCheckResult[] }

/**
 * The agent methods the routes call, answered as the agent's read-graph
 * workload answers them while its builder does not run: the status of the
 * rows in the state mirror, and a check of every ready read graph, one at a
 * time in the background slot, kept for the status.
 */
function workloadAgent(store: TripleStore) {
  let lastCheck: CheckReport | undefined;
  return {
    store,
    readGraphStatusV1: () => ({
      readGraphs: (readGraphLayerOf(store)?.runtime.mirror.rows() ?? []).map(({ readGraph, state, generation }) => ({ readGraph, state, generation })),
      builder: undefined,
      checking: false,
      lastCheck,
    }),
    checkReadGraphsV1: vi.fn(async (options: { mode?: 'full' | 'sampled'; signal?: AbortSignal } = {}): Promise<CheckReport> => {
      const layer = readGraphLayerOf(store);
      const mode = options.mode ?? 'full';
      const results: ReadGraphCheckResult[] = [];
      const ready = (layer?.runtime.mirror.rows() ?? []).filter((row) => row.state === 'ready').map((row) => row.readGraph).sort();
      for (const readGraph of ready) {
        results.push(await withReadGraphBackgroundSlot(layer!.runtime, () => checkReadGraph(store, readGraph, mode, options.signal ? { signal: options.signal } : {})));
      }
      lastCheck = { mode, at: Date.now(), results };
      return lastCheck;
    }),
  };
}

/** The agent with its builder started and idle, as when read graphs are switched on. */
function buildingAgent(store: TripleStore) {
  const agent = agentOf(store);
  return { ...agent, readGraphStatusV1: () => ({ ...agent.readGraphStatusV1(), builder: { running: false, pending: 0, retrying: [] } }) };
}

const agents = new WeakMap<object, ReturnType<typeof workloadAgent>>();
/** One agent per store, so a check and a later status meet. */
function agentOf(store: TripleStore): ReturnType<typeof workloadAgent> {
  let agent = agents.get(store);
  if (!agent) agents.set(store, agent = workloadAgent(store));
  return agent;
}

async function triplesOf(adapter: TripleStore, graph: string): Promise<string[]> {
  const result = await adapter.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return (result.type === 'bindings' ? result.bindings : []).map((row) => `${row.s} ${row.p} ${row.o}`).sort();
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
  store: TripleStore,
  method: string,
  target: string,
  options: {
    body?: unknown; authentication?: AllowedHttpAuthentication; dataDir?: string; res?: ReturnType<typeof fakeRes>; agent?: object; requests?: ReadGraphRequests;
  } = {},
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
    agent: options.agent ?? agentOf(store),
  } as unknown as RequestContext;
  await handleReadGraphRoutes(ctx, { dataDir: options.dataDir ?? '/no-such-dir', requests: options.requests ?? new ReadGraphRequests() });
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
    // No builder runs, and no check has run on request.
    expect(answer.body!.checking).toBe(false);
    expect(answer.body).not.toHaveProperty('builder');
    expect(answer.body).not.toHaveProperty('lastCheck');
  });

  it('shows what the builder does and whether the checks run, and lists the mirror where the agent has no workload', async () => {
    const { store } = await node();
    const builder = { running: true, building: IRI.swm, pending: 2, retrying: [], lastJob: { readGraph: IRI.vm, kind: 'build', outcome: 'done', batches: 1, durationMs: 5 } };
    const busy = { ...agentOf(store), readGraphStatusV1: () => ({ ...agentOf(store).readGraphStatusV1(), builder, checking: true }) };
    expect((await call(store, 'GET', READ_GRAPHS_PATH, { agent: busy })).body).toMatchObject({ builder, checking: true });
    const none = { store, readGraphStatusV1: () => undefined };
    const listed = (await call(store, 'GET', `${READ_GRAPHS_PATH}?layer=swm`, { agent: none })).body!;
    expect(listed).toEqual({ readGraphs: [expect.objectContaining({ readGraph: IRI.swm, state: 'ready' })], states: { ...NO_STATES, ready: 1 }, checking: false });
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
    expect(await call(new OxigraphStore(), 'GET', READ_GRAPHS_PATH))
      .toEqual({ handled: true, status: 200, body: { readGraphs: [], states: NO_STATES, checking: false } });
    expect(await call(new OxigraphStore(), 'POST', `${READ_GRAPHS_PATH}/check`, { body: {} })).toMatchObject({ status: 200, body: { mode: 'full', results: [] } });
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
    ['POST', `${READ_GRAPHS_PATH}/check`, { contextGraphId: CG }, /Unknown field "contextGraphId" for check; it takes mode/],
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
  it('checks every ready read graph through the agent, in full by default, and a mismatch marks it dirty', async () => {
    const { adapter, store, stateOf } = await node();
    const consistent = await call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: {} });
    expect(agentOf(store).checkReadGraphsV1).toHaveBeenLastCalledWith({ mode: 'full', signal: expect.any(AbortSignal) });
    expect(consistent.body).toEqual({
      mode: 'full', at: expect.any(Number),
      results: Object.values(IRI).sort().map((readGraph) => ({ readGraph, mode: 'full', outcome: 'consistent' })),
    });
    // A triple no member holds, written below the layer.
    await adapter.insert([q('urn:s:stray', IRI.vm)]);
    const mismatch = await call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: { mode: 'full' } });
    expect(mismatch.body!.results).toContainEqual({ readGraph: IRI.vm, mode: 'full', outcome: 'mismatch', direction: 'unheld' });
    expect(stateOf(IRI.vm)).toBe('dirty');
    expect(stateOf(IRI.codeVm)).toBe('ready');
    // The next check leaves the dirty read graph out, and the status shows the last check.
    const sampled = await call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: { mode: 'sampled' } });
    expect(agentOf(store).checkReadGraphsV1).toHaveBeenLastCalledWith({ mode: 'sampled', signal: expect.any(AbortSignal) });
    expect((sampled.body!.results as Array<{ readGraph: string }>).map((result) => result.readGraph))
      .toEqual(Object.values(IRI).filter((readGraph) => readGraph !== IRI.vm).sort());
    const status = (await call(store, 'GET', READ_GRAPHS_PATH)).body!;
    expect(status.lastCheck).toEqual(sampled.body);
    expect(status.states).toEqual({ ...NO_STATES, ready: 4, dirty: 1 });
  });

  it('passes a failed check on to the daemon, which answers it', async () => {
    const { adapter, store } = await node();
    vi.spyOn(adapter, 'query').mockRejectedValueOnce(new Error('the store went away'));
    await expect(call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: {} })).rejects.toThrow('the store went away');
  });
});

describe('POST /api/store/read-graphs/rebuild', () => {
  it('is refused while the node\'s builder does not run, and marks nothing', async () => {
    const { dataDir, store, stateOf } = await node();
    const answer = await call(store, 'POST', `${READ_GRAPHS_PATH}/rebuild`, { body: { contextGraphId: CG }, dataDir });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: 'READ_GRAPH_BUILDER_NOT_RUNNING', error: expect.stringMatching(/builder does not run/) });
    expect(Object.values(IRI).map(stateOf)).toEqual(Object.values(IRI).map(() => 'ready'));
  });

  it('marks each read graph dirty for the builder, and leaves the others', async () => {
    const { dataDir, store, stateOf } = await node();
    const answer = await call(store, 'POST', `${READ_GRAPHS_PATH}/rebuild`, { body: { contextGraphId: CG, layer: 'swm' }, dataDir, agent: buildingAgent(store) });
    expect(answer).toEqual({ handled: true, status: 200, body: { marked: [{ readGraph: IRI.swm, state: 'dirty' }] } });
    expect(stateOf(IRI.swm)).toBe('dirty');
    expect(stateOf(IRI.vm)).toBe('ready');
    // The builder's next pass rebuilds it.
    expect(await buildReadGraph({ store, dataDir }, KEYS.swm)).toMatchObject({ outcome: 'done', row: { state: 'ready' } });
  });

  it('reports a read graph its store cannot maintain', async () => {
    const store = wrapReadGraphLayer(undeclared(new OxigraphStore()), { backend: 'oxigraph' });
    store.runtime.mirror.set({ readGraph: IRI.vm, state: 'ready', generation: 1, ...CURRENT_READ_GRAPH_VERSIONS });
    const rebuilt = await call(store, 'POST', `${READ_GRAPHS_PATH}/rebuild`, { body: {}, agent: buildingAgent(store) });
    expect(rebuilt.body).toEqual({ marked: [{ readGraph: IRI.vm, error: expect.stringMatching(/cannot maintain read graphs/) }] });
    expect(store.runtime.mirror.get(IRI.vm)?.state).toBe('ready');
    // Such a read graph can still be dropped.
    const dropped = await call(store, 'POST', `${READ_GRAPHS_PATH}/drop`, { body: {} });
    expect(dropped.body).toEqual({ removed: [{ readGraph: IRI.vm, outcome: 'current' }] });
    expect(store.runtime.mirror.get(IRI.vm)).toBeUndefined();
  });

  it('starts no other read graph once the caller has gone away', async () => {
    const { adapter, dataDir, store, stateOf } = await node();
    const res = fakeRes();
    const update = adapter.update.bind(adapter);
    vi.spyOn(adapter, 'update').mockImplementation(async (sparql, options) => {
      await update(sparql, options);
      res.emit('close');
    });
    const answer = await call(store, 'POST', `${READ_GRAPHS_PATH}/rebuild`, { body: { contextGraphId: CG }, dataDir, res, agent: buildingAgent(store) });
    const [first, ...rest] = [IRI.vm, IRI.swm, IRI.codeVm, IRI.wm].sort();
    expect((answer.body!.marked as Array<{ readGraph: string }>).map((marked) => marked.readGraph)).toEqual([first]);
    expect(rest.map(stateOf)).toEqual(rest.map(() => 'ready'));
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

  it('stops the running removal when the caller goes away, starts no other, and lists it for a later drop that ends it', async () => {
    const { adapter, dataDir, store, stateOf } = await node();
    const [first, second] = [IRI.vm, IRI.codeVm].sort();
    const res = fakeRes();
    const afterClose: string[] = [];
    let closed = false;
    const query = adapter.query.bind(adapter);
    const querySpy = vi.spyOn(adapter, 'query').mockImplementation(async (sparql, options) => {
      // The caller goes away once the removal has taken the first read graph out of the mirror, before any of it is deleted.
      if (!closed && sparql === `ASK { GRAPH <${first}> { ?s ?p ?o } }`) {
        closed = true;
        res.emit('close');
      }
      return query(sparql, options);
    });
    const update = adapter.update.bind(adapter);
    const updateSpy = vi.spyOn(adapter, 'update').mockImplementation(async (sparql, options) => {
      if (closed) afterClose.push(sparql);
      return update(sparql, options);
    });
    const answer = await call(store, 'POST', `${READ_GRAPHS_PATH}/drop`, { body: { contextGraphId: CG, layer: 'vm' }, dataDir, res });
    expect(closed).toBe(true);
    expect(answer.body).toEqual({ removed: [{ readGraph: first, outcome: 'error', error: expect.any(String) }] });
    // Nothing was sent after the caller left: the read graph keeps its triples, out of the mirror; the next one was not started.
    expect(afterClose).toEqual([]);
    expect(await triplesOf(adapter, first)).not.toEqual([]);
    expect(stateOf(first)).toBeUndefined();
    expect(stateOf(second)).toBe('ready');
    querySpy.mockRestore();
    updateSpy.mockRestore();
    // The store still holds its dirty row: the status lists it, and the next drop ends the removal.
    const listed = (await call(store, 'GET', `${READ_GRAPHS_PATH}?contextGraphId=${CG}&layer=vm`)).body!.readGraphs;
    expect(listed).toEqual([expect.objectContaining({ readGraph: first, state: 'dirty' }), expect.objectContaining({ readGraph: second, state: 'ready' })]);
    const again = await call(store, 'POST', `${READ_GRAPHS_PATH}/drop`, { body: { contextGraphId: CG, layer: 'vm' }, dataDir });
    expect(again.body).toEqual({ removed: [first, second].map((readGraph) => ({ readGraph, outcome: 'done' })) });
    expect(await triplesOf(adapter, first)).toEqual([]);
    expect((await call(store, 'GET', `${READ_GRAPHS_PATH}?contextGraphId=${CG}&layer=vm`)).body!.readGraphs).toEqual([]);
  });
});

describe('graceful shutdown', () => {
  it('ends a running drop at its next store call before HTTP drains, and refuses later read-graph work', async () => {
    const { adapter, dataDir, store, stateOf } = await node();
    const requests = new ReadGraphRequests();
    const [first, second] = [IRI.vm, IRI.codeVm].sort();
    let reached!: () => void;
    const atFirstProbe = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const query = adapter.query.bind(adapter);
    const spy = vi.spyOn(adapter, 'query').mockImplementation(async (sparql, options) => {
      // The removal of the first read graph waits here, before its first delete, while the node begins to shut down.
      if (sparql === `ASK { GRAPH <${first}> { ?s ?p ?o } }`) {
        reached();
        await held;
      }
      return query(sparql, options);
    });
    const drop = call(store, 'POST', `${READ_GRAPHS_PATH}/drop`, { body: { contextGraphId: CG, layer: 'vm' }, dataDir, requests });
    await atFirstProbe;
    const logged: string[] = [];
    await beginGracefulShutdown({
      state: { catchupAcceptingJobs: true }, removeApiPort: async () => {}, log: (message) => logged.push(message),
      endReadGraphRequests: () => requests.end(),
    });
    release();
    expect((await drop).body).toEqual({ removed: [{ readGraph: first, outcome: 'error', error: 'The node is shutting down' }] });
    expect(await triplesOf(adapter, first)).not.toEqual([]);
    expect(stateOf(second)).toBe('ready');
    spy.mockRestore();
    for (const action of ['check', 'rebuild', 'drop']) {
      expect(await call(store, 'POST', `${READ_GRAPHS_PATH}/${action}`, { body: {}, requests }), action)
        .toMatchObject({ status: 503, body: { code: 'NODE_SHUTTING_DOWN', retryable: true } });
    }
    // A status still answers.
    expect((await call(store, 'GET', READ_GRAPHS_PATH, { requests })).status).toBe(200);
  });

  it('answers a check that shutdown ended with a retryable 503', async () => {
    const { store } = await node();
    const requests = new ReadGraphRequests();
    const agent = {
      ...agentOf(store),
      checkReadGraphsV1: vi.fn(async (options: { signal?: AbortSignal } = {}) => {
        requests.end();
        options.signal?.throwIfAborted();
        return { mode: 'full', at: 0, results: [] };
      }),
    };
    expect(await call(store, 'POST', `${READ_GRAPHS_PATH}/check`, { body: {}, agent, requests }))
      .toMatchObject({ status: 503, body: { code: 'NODE_SHUTTING_DOWN', retryable: true } });
  });

  it('is ended before the first await of the shutdown, and a failure there does not stop it', async () => {
    const order: string[] = [];
    const logged: string[] = [];
    await beginGracefulShutdown({
      state: { catchupAcceptingJobs: true },
      removeApiPort: async () => { order.push('removeApiPort'); },
      log: (message) => logged.push(message),
      endReadGraphRequests: () => {
        order.push('endReadGraphRequests');
        throw new Error('ended twice');
      },
    });
    expect(order).toEqual(['endReadGraphRequests', 'removeApiPort']);
    expect(logged).toContain('Read-graph request stop error: ended twice');
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
        agent: { ...agentOf(store), resolveAgentAddress: () => AGENT_ADDRESS },
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
