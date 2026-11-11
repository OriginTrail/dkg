import { MemoryLayer, compareCodePoint, parseReadGraphIri } from '@origintrail-official/dkg-core';
import {
  READ_GRAPH_STATES,
  checkReadGraph,
  markReadGraphDirty,
  readGraphLayerOf,
  removeReadGraph,
  withReadGraphBackgroundSlot,
  type ReadGraphJobContext,
  type ReadGraphStateRow,
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

/** The field of each action's answer that lists one entry per read graph. */
const ANSWER_FIELDS = { check: 'results', rebuild: 'marked', drop: 'removed' } as const;

/**
 * Node-admin read-graph commands (`dkg store read-graphs`):
 *
 * - `GET /api/store/read-graphs`: the read graphs the node holds, with their
 *   state and generation;
 * - `POST …/check`: check each one against its member graphs (`full`, or
 *   `sampled`), one at a time in the node's read-graph background slot;
 * - `POST …/rebuild`: mark each one dirty, which the node's builder rebuilds
 *   at its next pass;
 * - `POST …/drop`: remove each one, its contents and its state row, in the
 *   background slot.
 *
 * Each takes an optional `contextGraphId` and `layer` (wm, swm, vm) that
 * narrow it, as query parameters for `status` and in the JSON body for the
 * others. They work on the read graphs that have a row in the node's state,
 * in IRI order; a read graph that fails is reported and the others go on. A
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

  const store = ctx.agent.store;
  const layer = readGraphLayerOf(store);
  const rows = (layer?.runtime.mirror.rows() ?? [])
    .filter((row) => matches(row, parsed.request))
    .sort((left, right) => compareCodePoint(left.readGraph, right.readGraph));
  if (action === 'status') {
    const states = Object.fromEntries(READ_GRAPH_STATES.map((state) => [state, rows.filter((row) => row.state === state).length]));
    return jsonResponse(res, 200, { readGraphs: rows.map(view), states });
  }

  const job: ReadGraphJobContext = { store, dataDir: options.dataDir ?? dkgDir(), signal: gone.signal, source: `api.readGraphs.${action}` };
  const mode = parsed.request.mode ?? 'full';
  const answers: Record<string, unknown>[] = [];
  for (const { readGraph } of rows) {
    if (gone.signal.aborted) break;
    try {
      if (action === 'rebuild') {
        const after = await markReadGraphDirty(job, readGraph);
        answers.push({ readGraph, ...(after ? { state: after.state } : {}) });
      } else if (action === 'check') {
        const result = await withReadGraphBackgroundSlot(layer!.runtime, () => checkReadGraph(store, readGraph, mode, { signal: gone.signal }));
        answers.push({ readGraph, outcome: result.outcome, ...(result.direction ? { direction: result.direction } : {}) });
      } else {
        const result = await withReadGraphBackgroundSlot(layer!.runtime, () => removeReadGraph(job, readGraph));
        answers.push({ readGraph, outcome: result.outcome });
      }
    } catch (error) {
      answers.push({ readGraph, ...(action === 'rebuild' ? {} : { outcome: 'error' }), error: error instanceof Error ? error.message : String(error) });
    }
  }
  jsonResponse(res, 200, { [ANSWER_FIELDS[action]]: answers });
}

/** A body that is no JSON at all becomes `undefined`, which the parser refuses as it refuses any non-object. */
function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body.trim() === '' ? '{}' : body);
  } catch {
    return undefined;
  }
}

function matches(row: ReadGraphStateRow, request: ReadGraphsRequest): boolean {
  const key = parseReadGraphIri(row.readGraph);
  if (!key) return false;
  if (request.contextGraphId !== undefined && key.scope.contextGraphId !== request.contextGraphId) return false;
  return request.layer === undefined || LAYER_LABELS[key.layer] === request.layer;
}

function view(row: ReadGraphStateRow): ReadGraphView {
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
