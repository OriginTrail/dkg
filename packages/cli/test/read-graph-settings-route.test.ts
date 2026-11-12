// The node-admin settings of search across assets per context graph: GET and PUT /api/store/read-graphs/settings and
// the `readGraphs` field of a context graph's creation, over a real settings table and a real read-graph layer.
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  READ_GRAPH_PLANNED_METHODS,
  applyReadGraphModes,
  readGraphModeOfLayer,
  readGraphRuntimeOf,
  viewSemanticsOf,
  wrapReadGraphLayer,
  type ReadGraphModeChange,
  type ReadGraphModes,
  type TripleStore,
  type ViewSemanticsSettings,
} from '@origintrail-official/dkg-storage';
import type { AllowedHttpAuthentication } from '../src/auth.js';
import { ReadGraphSettingsControl, readGraphSettingsOnCreate, type ReadGraphSettingsAgent } from '../src/daemon/read-graph-settings-control.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { handleReadGraphSettingsRoutes } from '../src/daemon/routes/read-graph-settings.js';
import { ReadGraphRequests } from '../src/daemon/read-graph-requests.js';
import { checkDaemonQuerySection, prepareDaemonReadGraphSettings } from '../src/read-graph-settings-start.js';
import { resolveQuerySection } from '../src/read-graphs-config.js';
import { SqliteReadGraphSettingsStore } from '../src/read-graph-settings-store.js';
import { READ_GRAPH_SETTINGS_PATH } from '../src/read-graph-settings-wire.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const CG = 'settings-route';
const OTHER = 'settings-route-other';
const OPERATOR = requestAuthentication({ kind: 'nodeOperator' });
const AGENT = requestAuthentication({ kind: 'agent', agentAddress: `0x${'ab'.repeat(20)}` });

let home: string;
let previousHome: string | undefined;
let dashboard: DashboardDB;
/** The settings table over the node's database, as the daemon composes it. */
let table: SqliteReadGraphSettingsStore;

beforeEach(async () => {
  previousHome = process.env.DKG_HOME;
  home = await mkdtemp(join(tmpdir(), 'dkg-read-graph-settings-route-'));
  process.env.DKG_HOME = home;
  dashboard = new DashboardDB({ dataDir: home });
  table = new SqliteReadGraphSettingsStore(dashboard);
});

afterEach(async () => {
  vi.restoreAllMocks();
  dashboard.close();
  if (previousHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

/** A read-graph layer over embedded Oxigraph, maintained or (with `capable: false`) on an adapter that cannot keep read graphs. */
function layeredStore(capable = true): TripleStore {
  const adapter = capable
    ? Object.assign(new OxigraphStore(), { readGraphCapabilities: { methods: READ_GRAPH_PLANNED_METHODS, serialUpdates: true } })
    : Object.assign(new OxigraphStore(), { readGraphCapabilities: { methods: [], serialUpdates: true } });
  return wrapReadGraphLayer(adapter, { backend: 'oxigraph-worker', options: { path: join(home, `store-${Math.random()}`) } });
}

/** A context graph's rows as stored, with when and by whom each changed. */
const rowsOf = (contextGraphId: string) => table.rowsOf(contextGraphId);

function agentOf(store: TripleStore, overrides: Partial<ReadGraphSettingsAgent> = {}): ReadGraphSettingsAgent {
  return {
    store,
    applyReadGraphModesV1: (next: ReadGraphModes, options?: { signal?: AbortSignal; viewSemantics?: ViewSemanticsSettings }) =>
      applyReadGraphModes(store, next, options ?? {}),
    readGraphStatusV1: () => undefined,
    ...overrides,
  } as ReadGraphSettingsAgent;
}

/** A control over the settings table in the node's database. */
function controlOf(options: { query?: unknown; agent?: ReadGraphSettingsAgent; checkpoint?: boolean; log?: string[] } = {}) {
  const { policy } = resolveQuerySection(options.query);
  const agent = options.agent ?? agentOf(layeredStore());
  const control = new ReadGraphSettingsControl({
    settings: { policy, effective: { readGraphs: {}, viewSemantics: {} }, storeSettings: undefined },
    table, agent, role: 'edge', checkpoint: options.checkpoint ?? false, log: (line) => { options.log?.push(line); },
  });
  return { control, table, agent };
}

function fakeReq(method: string, target: string, body: string, headers: Record<string, string>) {
  const req = Readable.from([]);
  Object.assign(req, { method, url: target, headers: { host: '127.0.0.1', ...headers }, __dkgPrebufferedBody: Buffer.from(body, 'utf8') });
  return req as unknown as RequestContext['req'];
}

function fakeRes() {
  return Object.assign(new EventEmitter(), {
    statusCode: 0, body: '', writableEnded: false, headersSent: false,
    writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; },
    end(body?: string) { this.body = body ?? ''; this.writableEnded = true; return this; },
  });
}

async function call(control: ReadGraphSettingsControl | undefined, method: string, target: string, options: {
  body?: unknown; authentication?: AllowedHttpAuthentication; headers?: Record<string, string>;
} = {}) {
  const res = fakeRes();
  const url = new URL(`http://127.0.0.1${target}`);
  const raw = options.body === undefined ? '' : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  const ctx = {
    req: fakeReq(method, target, raw, options.headers ?? {}), res, url, path: url.pathname,
    authentication: options.authentication ?? OPERATOR, readGraphSettings: control,
  } as unknown as RequestContext;
  await handleReadGraphSettingsRoutes(ctx);
  return { handled: res.writableEnded, status: res.statusCode, body: res.body ? JSON.parse(res.body) as Record<string, any> : undefined };
}

const put = (control: ReadGraphSettingsControl | undefined, body: unknown, headers?: Record<string, string>) =>
  call(control, 'PUT', READ_GRAPH_SETTINGS_PATH, { body, ...(headers ? { headers } : {}) });

describe('GET /api/store/read-graphs/settings', () => {
  it('is for the node admin only, and answers the policy, the node\'s own modes and each context graph', async () => {
    const { control, table } = controlOf({ query: { readGraphs: { layers: { 'shared-working-memory': 'build' } }, viewSemantics: 'merged' } });
    table.set(CG, { layers: { 'verifiable-memory': 'serve' }, viewSemantics: 'per-asset' }, 'cli');
    const refused = await call(control, 'GET', READ_GRAPH_SETTINGS_PATH, { authentication: AGENT });
    expect(refused.status).toBe(403);
    expect(refused.body!.error).toContain('requires a node-level admin token');
    // The token comes first: a caller without it learns nothing from what it asks about or how it asks.
    for (const target of [`${READ_GRAPH_SETTINGS_PATH}?contextGraphId=${CG}`, `${READ_GRAPH_SETTINGS_PATH}?contextGraphId=_meta`]) {
      expect(await call(control, 'GET', target, { authentication: AGENT })).toEqual(refused);
    }
    expect((await call(control, 'PUT', READ_GRAPH_SETTINGS_PATH, { body: '{', authentication: AGENT })).status).toBe(403);
    expect((await call(undefined, 'GET', READ_GRAPH_SETTINGS_PATH, { authentication: AGENT })).status).toBe(403);
    const answer = await call(control, 'GET', READ_GRAPH_SETTINGS_PATH);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      policy: { enabled: true, layers: ['working-memory', 'shared-working-memory', 'verifiable-memory'] },
      node: { layers: { 'working-memory': 'off', 'shared-working-memory': 'build', 'verifiable-memory': 'off' }, viewSemantics: 'merged' },
      contextGraphs: [{
        contextGraphId: CG,
        layers: { 'verifiable-memory': 'serve' },
        viewSemantics: 'per-asset',
        // Nothing has been applied to this node's store yet: what is in force is what its runtime holds.
        effective: { layers: { 'working-memory': 'off', 'shared-working-memory': 'off', 'verifiable-memory': 'off' }, viewSemantics: 'per-asset' },
        readGraphs: [],
      }],
    });
    // Another route, or another method, is not this one.
    expect((await call(control, 'POST', READ_GRAPH_SETTINGS_PATH)).handled).toBe(false);
    expect((await call(control, 'GET', `${READ_GRAPH_SETTINGS_PATH}/x`)).handled).toBe(false);
  });

  it('answers one context graph when asked, with its read graphs and what their builds found', async () => {
    const store = layeredStore();
    const vm = readGraphIri({ scope: readScope(CG), layer: MemoryLayer.VerifiableMemory });
    const code = readGraphIri({ scope: readScope(CG, 'code'), layer: MemoryLayer.VerifiableMemory });
    const other = readGraphIri({ scope: readScope(OTHER), layer: MemoryLayer.VerifiableMemory });
    const { control } = controlOf({ agent: agentOf(store, {
      readGraphStatusV1: () => ({
        readGraphs: [
          { readGraph: vm, state: 'ready', generation: 3, triples: 120, members: 7 },
          { readGraph: code, state: 'building', generation: 1 },
          { readGraph: other, state: 'ready', generation: 1 },
        ],
        builder: { running: true, building: code, progress: 0.25, pending: 1, removing: 0, retrying: [] },
        checking: false, lastCheck: undefined,
      }) as unknown as ReturnType<ReadGraphSettingsAgent['readGraphStatusV1']>,
    }) });
    const answer = await call(control, 'GET', `${READ_GRAPH_SETTINGS_PATH}?contextGraphId=${CG}`);
    expect(answer.body!.contextGraphs).toEqual([{
      contextGraphId: CG,
      layers: {},
      effective: { layers: { 'working-memory': 'off', 'shared-working-memory': 'off', 'verifiable-memory': 'off' }, viewSemantics: 'per-asset' },
      readGraphs: [
        { readGraph: vm, contextGraphId: CG, layer: 'vm', state: 'ready', generation: 3, triples: 120, members: 7 },
        { readGraph: code, contextGraphId: CG, subGraphName: 'code', layer: 'vm', state: 'building', generation: 1, progress: 0.25 },
      ],
    }]);
    // Every context graph with settings of its own or read graphs, without one asked for.
    expect((await call(control, 'GET', READ_GRAPH_SETTINGS_PATH)).body!.contextGraphs.map((entry: { contextGraphId: string }) => entry.contextGraphId))
      .toEqual([CG, OTHER]);
    expect((await call(control, 'GET', `${READ_GRAPH_SETTINGS_PATH}?contextGraphId=_meta`)).status).toBe(400);
  });

  it('says when the node can switch nothing on, and why', async () => {
    const disabled = controlOf({ query: { readGraphsPolicy: { enabled: false } } }).control;
    expect((await call(disabled, 'GET', READ_GRAPH_SETTINGS_PATH)).body!.refused).toMatchObject({ code: 'READ_GRAPHS_DISABLED' });
    const none = controlOf({ query: { readGraphsPolicy: { layers: [] } } }).control;
    expect((await call(none, 'GET', READ_GRAPH_SETTINGS_PATH)).body!.refused).toMatchObject({ code: 'READ_GRAPHS_LAYER_NOT_ALLOWED' });
    const unsupported = controlOf({ agent: agentOf(layeredStore(false)) }).control;
    expect((await call(unsupported, 'GET', READ_GRAPH_SETTINGS_PATH)).body!.refused).toMatchObject({ code: 'READ_GRAPHS_UNSUPPORTED' });
    expect((await call(undefined, 'GET', READ_GRAPH_SETTINGS_PATH)).status).toBe(503);
  });
});

describe('PUT /api/store/read-graphs/settings', () => {
  it('writes the context graph\'s rows, applies the settings in force to the running node, and answers them', async () => {
    const lines: string[] = [];
    const { control, table, agent } = controlOf({ query: { viewSemantics: 'per-asset' }, log: lines });
    const answer = await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build' }, viewSemantics: 'merged' }, { 'x-dkg-actor': 'cli' });
    expect(answer.status).toBe(200);
    expect(answer.body!.contextGraphs).toEqual([expect.objectContaining({
      contextGraphId: CG,
      layers: { 'verifiable-memory': 'build' },
      viewSemantics: 'merged',
      effective: { layers: { 'working-memory': 'off', 'shared-working-memory': 'off', 'verifiable-memory': 'build' }, viewSemantics: 'merged' },
    })]);
    expect(answer.body!.changes).toContainEqual({ contextGraphId: CG, layer: 'verifiable-memory', from: 'off', to: 'build', outcome: 'applied' });
    const runtime = readGraphRuntimeOf(agent.store)!;
    expect(readGraphModeOfLayer(runtime.modes, CG, MemoryLayer.VerifiableMemory)).toBe('build');
    expect(viewSemanticsOf(runtime.viewSemantics, CG)).toBe('merged');
    expect(rowsOf(CG).modes).toEqual([{ layer: 'verifiable-memory', mode: 'build', updatedAt: expect.any(Number), updatedBy: 'cli' }]);
    expect(lines).toEqual([`[read-graphs] cli changed the settings of ${CG}: verifiable-memory off -> build, view semantics merged.`]);
    // The agent tools name themselves, and the table records it.
    expect((await put(control, { contextGraphId: OTHER, layers: { 'shared-working-memory': 'build' } }, { 'x-dkg-actor': 'agent:mcp' })).status).toBe(200);
    expect(rowsOf(OTHER).modes).toEqual([{ layer: 'shared-working-memory', mode: 'build', updatedAt: expect.any(Number), updatedBy: 'agent:mcp' }]);
    // Without the header the change is the API's; a view-semantics default alone applies too, and null removes it.
    const semantics = await put(control, { contextGraphId: CG, viewSemantics: null });
    expect(semantics.status).toBe(200);
    expect(viewSemanticsOf(runtime.viewSemantics, CG)).toBe('per-asset');
    expect(table.get(CG)).toEqual({ layers: { 'verifiable-memory': 'build' } });
  });

  it('refuses a body or an actor it cannot take, and changes nothing', async () => {
    const { control, table } = controlOf();
    for (const body of ['{', [], { contextGraphId: CG }, { contextGraphId: CG, layers: { vm: 'build' } }, { contextGraphId: '_private', layers: { 'verifiable-memory': 'build' } },
      { contextGraphId: CG, layers: { 'verifiable-memory': 'on' } }, { contextGraphId: CG, viewSemantics: 'joined' }, { contextGraphId: CG, layers: {}, extra: 1 }]) {
      const answer = await put(control, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.body!.code).toBe('READ_GRAPH_SETTINGS_INVALID');
    }
    const actor = await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build' } }, { 'x-dkg-actor': 'someone' });
    expect(actor.status).toBe(400);
    // A format character, such as a bidi override, is no part of an actor's name either.
    expect((await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build' } }, { 'x-dkg-actor': 'agent:mcp\u202e' })).status).toBe(400);
    expect((await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build' } })).status).toBe(200);
    expect(table.list().map((entry) => entry.contextGraphId)).toEqual([CG]);
    const agentCall = await call(control, 'PUT', READ_GRAPH_SETTINGS_PATH, { body: { contextGraphId: OTHER, layers: { 'verifiable-memory': 'build' } }, authentication: AGENT });
    expect(agentCall.status).toBe(403);
    expect(table.get(OTHER)).toEqual({ layers: {} });
  });

  it('switches nothing on that the policy does not allow, in plain words, and always lets a layer switch off', async () => {
    const { control, table } = controlOf({ query: { readGraphsPolicy: { layers: ['verifiable-memory'] } } });
    const refused = await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build', 'working-memory': 'build' } });
    expect(refused).toMatchObject({ status: 409, body: { code: 'READ_GRAPHS_LAYER_NOT_ALLOWED' } });
    expect(refused.body!.error).toBe('Search across assets can\'t be turned on for private drafts on this node: query.readGraphsPolicy.layers in its config.json leaves it out.');
    expect(table.get(CG)).toEqual({ layers: {} });
    expect((await put(control, { contextGraphId: CG, layers: { 'working-memory': 'off', 'verifiable-memory': 'serve' } })).status).toBe(200);
    const closed = controlOf({ query: { readGraphsPolicy: { enabled: false } } }).control;
    expect((await put(closed, { contextGraphId: OTHER, layers: { 'verifiable-memory': 'build' } })).body).toMatchObject({ code: 'READ_GRAPHS_DISABLED' });
    expect((await put(closed, { contextGraphId: OTHER, layers: { 'verifiable-memory': 'off' } })).status).toBe(200);
    // A table that cannot be written takes no change, and says so.
    vi.spyOn(table, 'set').mockImplementationOnce(() => { throw new Error('disk I/O error'); });
    expect((await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'off' } })).body)
      .toMatchObject({ code: 'READ_GRAPH_SETTINGS_UNAVAILABLE', error: 'This node\'s search-across-assets settings can\'t be changed now: disk I/O error.' });
  });

  it('switches nothing on where the store, a public checkpoint start or the rollback target refuses, and lets the rest through', async () => {
    const unsupported = controlOf({ agent: agentOf(layeredStore(false)) }).control;
    expect((await put(unsupported, { contextGraphId: CG, layers: { 'verifiable-memory': 'build' } })).body).toMatchObject({ code: 'READ_GRAPHS_UNSUPPORTED' });
    expect((await put(unsupported, { contextGraphId: CG, viewSemantics: 'merged' })).status).toBe(200);

    const checkpoint = controlOf({ checkpoint: true }).control;
    expect(await put(checkpoint, { contextGraphId: CG, layers: { 'verifiable-memory': 'off' } }))
      .toMatchObject({ status: 409, body: { code: 'READ_GRAPHS_CHECKPOINT_NODE' } });

    await writeFile(join(home, 'previous-version'), '10.1.1\n');
    const { control, table } = controlOf();
    const older = await put(control, { contextGraphId: CG, layers: { 'shared-working-memory': 'serve' } });
    expect(older).toMatchObject({
      status: 409,
      body: {
        code: 'READ_GRAPHS_ROLLBACK_TARGET_OLDER',
        rollbackTarget: { source: join(home, 'previous-version'), version: '10.1.1' },
        firstRecognizingRelease: '10.1.2',
      },
    });
    expect(older.body!.error).toBe('Search across assets can be turned on after this node\'s next update: the release it would roll back to (10.1.1) '
      + 'doesn\'t support it, and 10.1.2 is the first that does.');
    expect((await put(control, { contextGraphId: CG, layers: { 'shared-working-memory': 'off' } })).status).toBe(200);
    expect(table.get(CG).layers).toEqual({ 'shared-working-memory': 'off' });
  });

  it('puts the context graph\'s rows back exactly when the apply refuses or fails', async () => {
    const refusedChange: ReadGraphModeChange = { contextGraphId: CG, layer: 'verifiable-memory', from: 'off', to: 'build', outcome: { refused: 'the store refused' } };
    const store = layeredStore();
    const apply = vi.fn<ReadGraphSettingsAgent['applyReadGraphModesV1']>()
      .mockResolvedValueOnce([refusedChange])
      .mockRejectedValueOnce(new Error('stored rows unreadable'));
    const { control, table } = controlOf({ agent: agentOf(store, { applyReadGraphModesV1: apply }) });
    table.set(CG, { layers: { 'working-memory': 'build' }, viewSemantics: 'merged' }, 'ui');
    const before = rowsOf(CG);
    const refused = await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build', 'working-memory': 'off' }, viewSemantics: null });
    expect(refused).toMatchObject({ status: 409, body: { code: 'READ_GRAPHS_APPLY_REFUSED', changes: [refusedChange] } });
    expect(refused.body!.error).toBe(`Search across assets couldn't be changed for ${CG}, so its previous settings are back: the store refused.`);
    expect(rowsOf(CG)).toEqual(before);
    // The apply got the whole settings in force with the change written.
    expect(readGraphModeOfLayer(apply.mock.calls[0]![0], CG, MemoryLayer.VerifiableMemory)).toBe('build');
    const failed = await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'serve' } });
    expect(failed).toMatchObject({ status: 409, body: { code: 'READ_GRAPHS_APPLY_REFUSED' } });
    expect(failed.body!.error).toContain('stored rows unreadable');
    expect(rowsOf(CG)).toEqual(before);
    // A store that cannot keep the settings refuses them as the store's own refusal.
    apply.mockRejectedValueOnce(Object.assign(new Error('the adapter cannot maintain read graphs'), { code: 'READ_GRAPHS_UNSUPPORTED' }));
    const unsupported = await put(control, { contextGraphId: CG, viewSemantics: 'per-asset' });
    expect(unsupported).toMatchObject({ status: 409, body: { code: 'READ_GRAPHS_UNSUPPORTED' } });
    expect(unsupported.body!.error).toBe('This node\'s store can\'t search across assets (the adapter cannot maintain read graphs).');
    expect(rowsOf(CG)).toEqual(before);
  });

  it('says so when the rows of a change the node did not apply cannot be put back, and the running node keeps its settings', async () => {
    const lines: string[] = [];
    const apply = vi.fn<ReadGraphSettingsAgent['applyReadGraphModesV1']>().mockRejectedValueOnce(new Error('apply refused'));
    const { control, agent } = controlOf({ agent: agentOf(layeredStore(), { applyReadGraphModesV1: apply }), log: lines });
    vi.spyOn(table, 'restore').mockImplementationOnce(() => { throw new Error('disk I/O error'); });
    const answer = await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build' } });
    expect(answer).toMatchObject({ status: 503, body: { code: 'READ_GRAPH_SETTINGS_UNAVAILABLE' } });
    expect(answer.body!.error).toBe(`Search across assets wasn't changed for ${CG} now, but the change is still saved (disk I/O error), so the next change or a `
      + 'restart puts it in force: set the previous settings again to undo it.');
    expect(lines).toEqual([`[read-graphs] The previous settings of ${CG} could not be put back after a change the node did not apply: disk I/O error`]);
    expect(readGraphModeOfLayer(readGraphRuntimeOf(agent.store)!.modes, CG, MemoryLayer.VerifiableMemory)).toBe('off');
  });

  it('refuses a change once the node shuts down, and ends a running one before it changes anything', async () => {
    const requests = new ReadGraphRequests();
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const apply = vi.fn(async (_next: ReadGraphModes, options?: { signal?: AbortSignal }) => {
      started();
      await new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
      return [];
    });
    const { control } = controlOf({ agent: agentOf(layeredStore(), { applyReadGraphModesV1: apply }) });
    table.set(CG, { layers: { 'working-memory': 'build' } }, 'ui');
    const before = rowsOf(CG);
    const res = fakeRes();
    const url = new URL(`http://127.0.0.1${READ_GRAPH_SETTINGS_PATH}`);
    const ctx = {
      req: fakeReq('PUT', READ_GRAPH_SETTINGS_PATH, JSON.stringify({ contextGraphId: CG, layers: { 'verifiable-memory': 'build' } }), {}),
      res, url, path: url.pathname, authentication: OPERATOR, readGraphSettings: control,
    } as unknown as RequestContext;
    const running = handleReadGraphSettingsRoutes(ctx, { requests });
    await waiting;
    requests.end();
    await running;
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'NODE_SHUTTING_DOWN' });
    expect(rowsOf(CG)).toEqual(before);
    // A change still saved after a failed put-back keeps its own answer, even during shutdown.
    const saved = new ReadGraphRequests();
    const failing = vi.fn(async (_next: ReadGraphModes, options?: { signal?: AbortSignal }) => {
      queueMicrotask(() => saved.end());
      await new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
      return [];
    });
    const putBackFails = controlOf({ agent: agentOf(layeredStore(), { applyReadGraphModesV1: failing }) }).control;
    vi.spyOn(table, 'restore').mockImplementationOnce(() => { throw new Error('disk I/O error'); });
    const kept = fakeRes();
    await handleReadGraphSettingsRoutes({ ...ctx, res: kept, readGraphSettings: putBackFails,
      req: fakeReq('PUT', READ_GRAPH_SETTINGS_PATH, JSON.stringify({ contextGraphId: 'settings-route-third', layers: { 'verifiable-memory': 'build' } }), {}) } as unknown as RequestContext,
      { requests: saved });
    expect(kept.statusCode).toBe(503);
    expect(JSON.parse(kept.body)).toMatchObject({ code: 'READ_GRAPH_SETTINGS_UNAVAILABLE' });
    // A change after that is refused at once.
    const refused = fakeRes();
    await handleReadGraphSettingsRoutes({ ...ctx, res: refused, req: fakeReq('PUT', READ_GRAPH_SETTINGS_PATH, JSON.stringify({ contextGraphId: CG, viewSemantics: 'merged' }), {}) } as unknown as RequestContext, { requests });
    expect(refused.statusCode).toBe(503);
    expect(apply).toHaveBeenCalledTimes(1);
    // A creation's setting is refused too, and the context graph keeps none.
    expect(await readGraphSettingsOnCreate(control, { contextGraphId: OTHER, layers: { 'verifiable-memory': 'build' }, canAdminister: true, actor: 'api' }, requests))
      .toMatchObject({ code: 'NODE_SHUTTING_DOWN' });
    expect(table.get(OTHER)).toEqual({ layers: {} });
  });

  it('keeps a change to an imported setting through a restart: the next start puts it in force', async () => {
    const query = { readGraphs: { contextGraphs: { [CG]: 'build' } } };
    const start = async () => prepareDaemonReadGraphSettings({
      query, section: await checkDaemonQuerySection({ query, role: 'edge', checkpoint: false }), table, role: 'edge', checkpoint: false, log: () => undefined,
    });
    // The first start imports config.json's rule.
    expect(readGraphModeOfLayer((await start()).effective.readGraphs, CG, MemoryLayer.VerifiableMemory)).toBe('build');
    const { control } = controlOf();
    expect((await put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'serve' } })).status).toBe(200);
    const restarted = await start();
    expect(readGraphModeOfLayer(restarted.effective.readGraphs, CG, MemoryLayer.VerifiableMemory)).toBe('serve');
    expect(readGraphModeOfLayer(restarted.effective.readGraphs, CG, MemoryLayer.WorkingMemory)).toBe('build');
  });

  it('runs changes one at a time, each applying the settings with every earlier change in them', async () => {
    const store = layeredStore();
    const seen: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const apply = vi.fn(async (next: ReadGraphModes) => {
      seen.push(['verifiable-memory', 'shared-working-memory'].map((view) =>
        readGraphModeOfLayer(next, CG, view === 'verifiable-memory' ? MemoryLayer.VerifiableMemory : MemoryLayer.SharedWorkingMemory)).join('/'));
      if (seen.length === 1) await first;
      return [];
    });
    const { control } = controlOf({ agent: agentOf(store, { applyReadGraphModesV1: apply }) });
    const one = put(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build' } });
    const two = put(control, { contextGraphId: CG, layers: { 'shared-working-memory': 'serve' } });
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    release();
    expect((await one).status).toBe(200);
    expect((await two).status).toBe(200);
    expect(seen).toEqual(['build/off', 'build/serve']);
  });
});

describe('the readGraphs field of a context graph\'s creation', () => {
  it('applies with the checks of a change, and is refused without the node admin or a running control', async () => {
    const { control } = controlOf();
    expect(await readGraphSettingsOnCreate(control, { contextGraphId: CG, layers: { 'verifiable-memory': 'build' }, canAdminister: true, actor: 'agent:0xabc' }))
      .toMatchObject({ applied: true, changes: expect.arrayContaining([expect.objectContaining({ contextGraphId: CG, to: 'build', outcome: 'applied' })]) });
    expect(rowsOf(CG).modes[0]).toMatchObject({ mode: 'build', updatedBy: 'agent:0xabc' });
    expect(await readGraphSettingsOnCreate(control, { contextGraphId: OTHER, layers: { 'verifiable-memory': 'build' }, canAdminister: false, actor: 'api' }))
      .toEqual({ code: 'NODE_ADMIN_REQUIRED', refused: 'Only the node admin can turn on search across assets; the context graph was created without it.' });
    expect(await readGraphSettingsOnCreate(undefined, { contextGraphId: OTHER, layers: { 'verifiable-memory': 'build' }, canAdminister: true, actor: 'api' }))
      .toMatchObject({ code: 'READ_GRAPH_SETTINGS_UNAVAILABLE' });
    expect(await readGraphSettingsOnCreate(undefined, { contextGraphId: OTHER, layers: undefined, canAdminister: false, actor: 'api' }))
      .toMatchObject({ code: 'NODE_ADMIN_REQUIRED' });
    const vmOnly = controlOf({ query: { readGraphsPolicy: { layers: ['verifiable-memory'] } } }).control;
    expect(await readGraphSettingsOnCreate(vmOnly, { contextGraphId: OTHER, layers: { 'working-memory': 'build' }, canAdminister: true, actor: 'api' }))
      .toMatchObject({ code: 'READ_GRAPHS_LAYER_NOT_ALLOWED' });
  });

  it('is answered by POST /api/context-graph/create, which creates the context graph whatever the setting does', async () => {
    const { control, agent: agentOfControl, table } = controlOf();
    const createContextGraph = vi.fn(async (_options: unknown): Promise<void> => undefined);
    const agent = { createContextGraph, getSubscribedContextGraphs: () => new Map(), getDefaultAgentAddress: () => `0x${'ab'.repeat(20)}` };
    const post = async (body: unknown, authentication: AllowedHttpAuthentication) => {
      const path = '/api/context-graph/create';
      const server = createServer(async (req, res) => {
        try {
          await handleContextGraphRoutes({ req, res, agent, path, url: new URL(path, 'http://localhost'), requestAgentAddress: `0x${'ab'.repeat(20)}`,
            authentication, config: {}, readGraphSettings: control, catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() } } as never);
        } catch (error) { res.statusCode = 500; res.end(String(error)); }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('server did not bind');
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
        });
        return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
      } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    };
    // A context graph that exists already is refused before any setting is applied.
    createContextGraph.mockRejectedValueOnce(new Error(`Context graph "${CG}" already exists`));
    const apply = vi.spyOn(agentOfControl, 'applyReadGraphModesV1');
    const existing = await post({ id: CG, name: CG, readGraphs: { layers: { 'verifiable-memory': 'build' } } }, OPERATOR);
    expect(existing.status).toBe(409);
    expect(apply).not.toHaveBeenCalled();
    expect(table.get(CG)).toEqual({ layers: {} });
    const created = await post({ id: CG, name: CG, readGraphs: { layers: { 'verifiable-memory': 'build' } } }, OPERATOR);
    expect(created).toMatchObject({ status: 200, body: { created: CG, readGraphs: { applied: true } } });
    const byAgent = await post({ id: OTHER, name: OTHER, readGraphs: { layers: { 'verifiable-memory': 'build' } } }, AGENT);
    expect(byAgent).toMatchObject({ status: 200, body: { created: OTHER, readGraphs: { code: 'NODE_ADMIN_REQUIRED' } } });
    // Without the token the option alone is refused, unread: its shape does not matter, and the context graph is created.
    const unread = await post({ id: 'fifth', name: 'fifth', readGraphs: { layers: { vm: 'build' } } }, AGENT);
    expect(unread).toMatchObject({ status: 200, body: { created: 'fifth', readGraphs: { code: 'NODE_ADMIN_REQUIRED' } } });
    const malformed = await post({ id: 'third', name: 'third', readGraphs: { layers: { vm: 'build' } } }, OPERATOR);
    expect(malformed).toMatchObject({ status: 400, body: { code: 'READ_GRAPH_SETTINGS_INVALID' } });
    expect(createContextGraph).toHaveBeenCalledTimes(4);
    // Without the field, the answer is as before.
    expect((await post({ id: 'fourth', name: 'fourth' }, OPERATOR)).body).toEqual({ created: 'fourth', uri: 'did:dkg:context-graph:fourth' });
  });
});
