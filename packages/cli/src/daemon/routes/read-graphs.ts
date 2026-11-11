import { MemoryLayer, compareCodePoint, parseReadGraphIri } from '@origintrail-official/dkg-core';
import {
  READ_GRAPH_STATES,
  markReadGraphDirty,
  readGraphLayerOf,
  removeReadGraph,
  withReadGraphBackgroundSlot,
  type ReadGraphJobContext,
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
 *   rebuilds at its next pass;
 * - `POST …/drop`: remove each read graph, its contents and its state row, in
 *   the background slot.
 *
 * `status`, `rebuild` and `drop` take an optional `contextGraphId` and `layer`
 * (wm, swm, vm), as query parameters for `status` and in the JSON body for the
 * others, and work on the read graphs that have a row in the node's state, in
 * IRI order; a read graph that fails is reported and the others go on. A
 * caller that goes away ends the work: the running read graph stops at its
 * next store call and no other one starts.
 */
export async function handleReadGraphRoutes(ctx: RequestContext, options: { dataDir?: string } = {}): Promise<void> {
  const { req, res, path } = ctx;
  const action = path === READ_GRAPHS_PATH
    ? 'status'
    : READ_GRAPHS_ACTIONS.find((name) => name !== 'status' && path === `${READ_GRAPHS_PATH}/${name}`);
  if (action === undefined) return;
  const method = action === 'status' ? 'GET' : 'POST';
  if (req.method !== method) return;
  if (!requireNodeAdmin(actorFromRequestContext(ctx).authentication, res, `${method} ${path}`, DESCRIPTIONS[action])) return;

  const gone = new AbortController();
  res.once('close', () => gone.abort());
  const raw = action === 'status' ? Object.fromEntries(ctx.url.searchParams) : jsonOf(await readBody(req, SMALL_BODY_BYTES));
  const parsed = parseReadGraphsRequest(action, raw);
  if ('error' in parsed) return jsonResponse(res, 400, { error: parsed.error });

  if (action === 'check') {
    return jsonResponse(res, 200, await ctx.agent.checkReadGraphsV1({ mode: parsed.request.mode ?? 'full', signal: gone.signal }));
  }
  const store = ctx.agent.store;
  const layer = readGraphLayerOf(store);
  if (action === 'status') {
    const status = ctx.agent.readGraphStatusV1();
    const rows = selected(status?.readGraphs ?? layer?.runtime.mirror.rows() ?? [], parsed.request);
    return jsonResponse(res, 200, {
      readGraphs: rows.map(view),
      states: Object.fromEntries(READ_GRAPH_STATES.map((state) => [state, rows.filter((row) => row.state === state).length])),
      ...(status?.builder ? { builder: status.builder } : {}),
      checking: status?.checking ?? false,
      ...(status?.lastCheck ? { lastCheck: status.lastCheck } : {}),
    });
  }

  const job: ReadGraphJobContext = { store, dataDir: options.dataDir ?? dkgDir(), signal: gone.signal, source: `api.readGraphs.${action}` };
  const answers: Record<string, unknown>[] = [];
  for (const { readGraph } of selected(layer?.runtime.mirror.rows() ?? [], parsed.request)) {
    if (gone.signal.aborted) break;
    try {
      if (action === 'rebuild') {
        const after = await markReadGraphDirty(job, readGraph);
        answers.push({ readGraph, ...(after ? { state: after.state } : {}) });
      } else {
        const result = await withReadGraphBackgroundSlot(layer!.runtime, () => removeReadGraph(job, readGraph));
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

/** The rows of the read graphs a request names, in IRI order. */
function selected<Row extends ReadGraphRow>(rows: readonly Row[], request: ReadGraphsRequest): Row[] {
  return rows.filter((row) => {
    const key = parseReadGraphIri(row.readGraph);
    if (!key) return false;
    if (request.contextGraphId !== undefined && key.scope.contextGraphId !== request.contextGraphId) return false;
    return request.layer === undefined || LAYER_LABELS[key.layer] === request.layer;
  }).sort((left, right) => compareCodePoint(left.readGraph, right.readGraph));
}

function view(row: ReadGraphRow): ReadGraphView {
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
