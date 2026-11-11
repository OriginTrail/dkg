import oxigraph from 'oxigraph';
import type {
  ReadGraphAdapterCapabilities,
  ReadGraphPlannedMethod,
  ReadGraphWriteOptions,
} from '../read-graph/adapter-contract.js';
import type { Quad, QueryOptions } from '../triple-store.js';
import { withReadGraphOperations } from './read-graph-request.js';
import { sparqlStatements } from './sparql-statements.js';

export type { ReadGraphCapableAdapter } from '../read-graph/adapter-contract.js';

/**
 * Read graphs on embedded Oxigraph (see `read-graph/adapter-contract.ts`):
 * what OxigraphStore and OxigraphWorkerStore declare, the one-update forms of
 * `delete` and `deleteByPattern`, and the plan a worker call carries.
 *
 * Every other write already changes its data with one `update` of the engine,
 * and the plan's operations go around it. `delete` and `deleteByPattern` make
 * one engine call per quad; with a plan they send one update instead, built as
 * the HTTP adapters build theirs, so that the data change and the read graphs
 * commit together. Without a plan they keep their per-quad calls. The engine
 * runs one call at a time, in process and in the worker.
 */
const METHODS: readonly ReadGraphPlannedMethod[] = Object.freeze([
  'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix', 'dropGraph', 'replaceAssetGroup',
  'replaceGraph', 'replaceGraphAndSubject', 'replaceSubject', 'replaceSubjectAndInsert', 'rfc64AuthorCommitCasV1', 'update',
]);
export const OXIGRAPH_READ_GRAPH_CAPABILITIES: ReadGraphAdapterCapabilities = Object.freeze({ methods: METHODS, serialUpdates: true });
/** The worker store has no `replaceAssetGroup`. */
export const OXIGRAPH_WORKER_READ_GRAPH_CAPABILITIES: ReadGraphAdapterCapabilities = Object.freeze({
  methods: Object.freeze(METHODS.filter((method) => method !== 'replaceAssetGroup')),
  serialUpdates: true,
});

const statements = sparqlStatements('oxigraph');
type Engine = InstanceType<typeof oxigraph.Store>;

function planOf(options: QueryOptions | undefined): ReadGraphWriteOptions['readGraphPlan'] {
  const plan = (options as ReadGraphWriteOptions | undefined)?.readGraphPlan;
  return plan && plan.before.length + plan.after.length > 0 ? plan : undefined;
}

/**
 * Delete `quads`. With a plan: one update with the plan's operations around
 * it, `DELETE DATA` for the ground quads and, for quads with a blank node, a
 * `DELETE … WHERE` by shape, the only form SPARQL has for them. Without a
 * plan: one engine call per quad, as before.
 */
export function deleteQuads(
  writable: () => Engine,
  quads: Quad[],
  options: QueryOptions | undefined,
  toEngineQuad: (quad: Quad) => oxigraph.Quad | null,
): void {
  const update = planOf(options) ? statements.deleteData(quads)?.update : undefined;
  if (update !== undefined) {
    writable().update(withReadGraphOperations(update, options));
    return;
  }
  for (const quad of quads) {
    const engineQuad = toEngineQuad(quad);
    if (engineQuad) writable().delete(engineQuad);
  }
}

/**
 * Delete what matches `pattern`. With a plan: one update that deletes every
 * matching quad, with the plan's operations around it. Without a plan: one
 * engine call per quad of `matches`, as before. Returns whether anything was
 * sent that may have changed the store.
 */
export function deleteMatching(
  writable: () => Engine,
  pattern: Partial<Quad>,
  matches: readonly oxigraph.Quad[],
  options: QueryOptions | undefined,
): boolean {
  if (planOf(options)) {
    writable().update(withReadGraphOperations(statements.deleteByPattern(pattern).update, options));
    return true;
  }
  for (const match of matches) writable().delete(match);
  return matches.length > 0;
}

/**
 * Run `update` and return how many quads it removed: counted in the whole
 * store without a plan, as before, and in `graph` alone with one, because the
 * plan's operations change the read graphs in the same update.
 */
export function quadsRemoved(engine: Engine, graph: string, options: QueryOptions | undefined, update: () => void): number {
  const count = planOf(options)
    ? () => Number((engine.query(statements.countQuads(graph).sparql) as Map<string, oxigraph.Term>[])[0]!.get('c')!.value)
    : () => engine.size;
  const before = count();
  update();
  return before - count();
}

/**
 * The plan of a write sent to the worker, as one more argument, only when it
 * has operations: without one the worker gets exactly today's message.
 */
export function readGraphPlanArgs(options: QueryOptions | undefined): [] | [ReadGraphWriteOptions] {
  const plan = planOf(options);
  return plan ? [{ readGraphPlan: plan }] : [];
}
