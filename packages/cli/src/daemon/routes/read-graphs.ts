import { MemoryLayer, compareCodePoint, parseReadGraphIri } from '@origintrail-official/dkg-core';
import {
  READ_GRAPH_STATES,
  markReadGraphDirty,
  parseReadGraphStateRows,
  readGraphLayerOf,
  readGraphStateRowsQuery,
  removeReadGraph,
  type ReadGraphJobContext,
  type ReadGraphStore,
} from '@origintrail-official/dkg-storage';
import { dkgDir } from '../../config.js';
import {
  READ_GRAPHS_ACTIONS,
  READ_GRAPHS_PATH,
  parseReadGraphsRequest,
  type ReadGraphLayerLabel,
  type ReadGraphView,
  type ReadGraphsAction,
  type ReadGraphsRequest,
} from '../../read-graphs-wire.js';
import { jsonResponse, readBody, SMALL_BODY_BYTES } from '../http-utils.js';
import { requireNodeAdmin } from '../node-admin-guard.js';
import { actorFromRequestContext, type RequestContext } from './context.js';

const LAYER_LABELS: Readonly<Record<MemoryLayer, ReadGraphLayerLabel>> = {
  [MemoryLayer.WorkingMemory]: 'wm',
  [MemoryLayer.SharedWorkingMemory]: 'swm',
  [MemoryLayer.VerifiableMemory]: 'vm',
};

const DESCRIPTIONS: Readonly<Record<ReadGraphsAction, string>> = {
  status: 'list the read graphs of the node',
  check: 'check the read graphs of the node',
  rebuild: 'rebuild the read graphs of the node',
  drop: 'drop the read graphs of the node',
};

/**
 * The read-graph requests a daemon runs. Graceful shutdown ends them at once
 * ({@link end}), before the HTTP server drains: each stops at its next store
 * call and answers, and a later check, rebuild or drop is refused.
 */
export class ReadGraphRequests {
  #ending = false;
  readonly #running = new Set<AbortController>();

  get ending(): boolean {
    return this.#ending;
  }

  /** Track a request until the returned function is called. */
  track(request: AbortController): () => void {
    this.#running.add(request);
    return () => {
      this.#running.delete(request);
    };
  }

  end(): void {
    this.#ending = true;
    for (const request of this.#running) request.abort(new Error('The node is shutting down'));
  }
}

/** The daemon's read-graph requests, which its graceful shutdown ends. */
export const daemonReadGraphRequests = new ReadGraphRequests();

const SHUTTING_DOWN = { code: 'NODE_SHUTTING_DOWN', error: 'The node is shutting down; try again once it is back.', retryable: true } as const;

interface ReadGraphRow {
  readonly readGraph: string;
  readonly state: string;
  readonly generation: number;
}

/**
 * Node-admin read-graph commands (`dkg store read-graphs`):
 *
 * - `GET /api/store/read-graphs`: the read graphs the node holds, with their
 *   state and generation, what the builder does, whether the background
 *   checks run, and the last check run on request;
 * - `POST …/check`: check every ready read graph now, `full` or `sampled`, in
 *   the node's read-graph background slot, through the agent's read-graph
 *   workload, which keeps the result for the status;
 * - `POST …/rebuild`: mark each read graph dirty, which the node's builder
 *   rebuilds at its next pass; refused with 409 while the builder does not
 *   run, since nothing would rebuild them;
 * - `POST …/drop`: remove each read graph, its contents and its state row; a
 *   removal takes the backend's background slot, as the builder's jobs do.
 *
 * `status`, `rebuild` and `drop` take an optional `contextGraphId` and `layer`
 * (wm, swm, vm), as query parameters for `status` and in the JSON body for the
 * others, and work on the read graphs that have a state row, in the state
 * mirror or in the store, in IRI order. A removal that stopped part way has
 * taken its read graph out of the mirror but left its dirty row in the store,
 * so it is listed and dropped again. A read graph that fails is reported and
 * the others go on. A caller that goes away ends the work: the running read
 * graph stops at its next store call and no other one starts. Graceful
 * shutdown ends a running request the same way, before the HTTP server
 * drains, and refuses a later check, rebuild or drop with a retryable 503.
 */
export async function handleReadGraphRoutes(
  ctx: RequestContext,
  options: { dataDir?: string; requests?: ReadGraphRequests } = {},
): Promise<void> {
  const { req, res, path } = ctx;
  const action = path === READ_GRAPHS_PATH
    ? 'status'
    : READ_GRAPHS_ACTIONS.find((name) => name !== 'status' && path === `${READ_GRAPHS_PATH}/${name}`);
  if (action === undefined) return;
  const method = action === 'status' ? 'GET' : 'POST';
  if (req.method !== method) return;
  if (!requireNodeAdmin(actorFromRequestContext(ctx).authentication, res, `${method} ${path}`, DESCRIPTIONS[action])) return;

  const requests = options.requests ?? daemonReadGraphRequests;
  if (action !== 'status' && requests.ending) return jsonResponse(res, 503, SHUTTING_DOWN, undefined, { 'Retry-After': '30' });
  const gone = new AbortController();
  res.once('close', () => gone.abort());
  const untrack = requests.track(gone);
  try {
    await answer(ctx, action, gone.signal, options.dataDir);
  } catch (error) {
    if (!gone.signal.aborted || !requests.ending) throw error;
    jsonResponse(res, 503, SHUTTING_DOWN, undefined, { 'Retry-After': '30' });
  } finally {
    untrack();
  }
}

async function answer(ctx: RequestContext, action: ReadGraphsAction, signal: AbortSignal, dataDir: string | undefined): Promise<void> {
  const { req, res } = ctx;
  const raw = action === 'status' ? Object.fromEntries(ctx.url.searchParams) : jsonOf(await readBody(req, SMALL_BODY_BYTES));
  const parsed = parseReadGraphsRequest(action, raw);
  if ('error' in parsed) return jsonResponse(res, 400, { error: parsed.error });

  if (action === 'check') {
    return jsonResponse(res, 200, await ctx.agent.checkReadGraphsV1({ mode: parsed.request.mode ?? 'full', signal }));
  }
  if (action === 'rebuild' && ctx.agent.readGraphStatusV1()?.builder === undefined) {
    return jsonResponse(res, 409, {
      code: 'READ_GRAPH_BUILDER_NOT_RUNNING',
      error: 'The node\'s read-graph builder does not run, so nothing would rebuild these read graphs. Switch read graphs on for this node first, or drop them.',
    });
  }
  const store = ctx.agent.store;
  const layer = readGraphLayerOf(store);
  const stored = layer ? await storedRows(layer, signal) : [];
  if (action === 'status') {
    const status = ctx.agent.readGraphStatusV1();
    const rows = selected(withStored(status?.readGraphs ?? layer?.runtime.mirror.rows() ?? [], stored), parsed.request);
    return jsonResponse(res, 200, {
      readGraphs: rows.map(readGraphViewOf),
      states: Object.fromEntries(READ_GRAPH_STATES.map((state) => [state, rows.filter((row) => row.state === state).length])),
      ...(status?.builder ? { builder: status.builder } : {}),
      checking: status?.checking ?? false,
      ...(status?.lastCheck ? { lastCheck: status.lastCheck } : {}),
    });
  }

  const job: ReadGraphJobContext = { store, dataDir: dataDir ?? dkgDir(), signal, source: `api.readGraphs.${action}` };
  const answers: Record<string, unknown>[] = [];
  for (const { readGraph } of selected(withStored(layer?.runtime.mirror.rows() ?? [], stored), parsed.request)) {
    if (signal.aborted) break;
    try {
      if (action === 'rebuild') {
        const after = await markReadGraphDirty(job, readGraph);
        answers.push({ readGraph, ...(after ? { state: after.state } : {}) });
      } else {
        // A removal takes the backend's background slot itself.
        const result = await removeReadGraph(job, readGraph);
        answers.push({ readGraph, outcome: result.outcome });
      }
    } catch (error) {
      answers.push({ readGraph, ...(action === 'drop' ? { outcome: 'error' } : {}), error: error instanceof Error ? error.message : String(error) });
    }
  }
  jsonResponse(res, 200, action === 'rebuild' ? { marked: answers } : { removed: answers });
}

/** A body that is no JSON at all becomes `undefined`, which the parser refuses as it refuses any non-object. */
function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body.trim() === '' ? '{}' : body);
  } catch {
    return undefined;
  }
}

/** The state rows the store holds, read below the read-graph layer. */
async function storedRows(layer: ReadGraphStore, signal: AbortSignal): Promise<ReadGraphRow[]> {
  const result = await layer.innerStore.query(readGraphStateRowsQuery(), { priority: 'background', signal, source: 'api.readGraphs.rows' });
  return parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows;
}

/** The rows of the mirror, and the stored rows of read graphs the mirror does not hold. */
function withStored(mirrored: readonly ReadGraphRow[], stored: readonly ReadGraphRow[]): ReadGraphRow[] {
  const rows = new Map(stored.map((row) => [row.readGraph, row]));
  for (const row of mirrored) rows.set(row.readGraph, row);
  return [...rows.values()];
}

/** The rows of the read graphs a request names, in IRI order. */
function selected<Row extends ReadGraphRow>(rows: readonly Row[], request: ReadGraphsRequest): Row[] {
  return rows.filter((row) => {
    const key = parseReadGraphIri(row.readGraph);
    if (!key) return false;
    if (request.contextGraphId !== undefined && key.scope.contextGraphId !== request.contextGraphId) return false;
    return request.layer === undefined || LAYER_LABELS[key.layer] === request.layer;
  }).sort((left, right) => compareCodePoint(left.readGraph, right.readGraph));
}

/** One read graph as the read-graph routes list it. */
export function readGraphViewOf(row: ReadGraphRow): ReadGraphView {
  const key = parseReadGraphIri(row.readGraph)!;
  return {
    readGraph: row.readGraph,
    contextGraphId: key.scope.contextGraphId,
    ...(key.scope.kind === 'sub-graph' ? { subGraphName: key.scope.subGraphName } : {}),
    layer: LAYER_LABELS[key.layer],
    ...(key.layer === MemoryLayer.WorkingMemory ? { agentAddress: key.agentAddress } : {}),
    state: row.state,
    generation: row.generation,
  };
}
