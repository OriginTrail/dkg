import oxigraph from 'oxigraph';
import type {
  ReadGraphAdapterCapabilities,
  ReadGraphPlannedMethod,
  ReadGraphWriteOptions,
} from '../read-graph/adapter-contract.js';
import type { Quad, QueryOptions, UpdateOptions } from '../triple-store.js';
import { isBlankNodeTerm } from './blank-node-safe-delete.js';
import { operationsOf, withReadGraphOperations } from './read-graph-request.js';
import { sparqlStatements } from './sparql-statements.js';

export type { ReadGraphCapableAdapter } from '../read-graph/adapter-contract.js';

/**
 * Read graphs on embedded Oxigraph (see `read-graph/adapter-contract.ts`):
 * what OxigraphStore and OxigraphWorkerStore declare, the one-update forms of
 * `delete` and `deleteByPattern`, and the plan a worker call carries.
 *
 * Every other write already changes its data with one `update` of the engine,
 * and the plan's operations go around it. `delete` and `deleteByPattern` make
 * one engine call per quad; with a plan they send one update instead, so that
 * the data change and the read graphs commit together. Without a plan they
 * keep their per-quad calls. The engine runs one call at a time, in process
 * and in the worker.
 *
 * A planned `delete` of a quad with a blank node is refused before anything
 * changes. The engine deletes a stored blank node by its identity, but SPARQL
 * can name one only by its shape, which may match other blank nodes and named
 * subjects; one update could not delete exactly what the caller asked for.
 */
const METHODS: readonly ReadGraphPlannedMethod[] = Object.freeze([
  'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix', 'dropGraph', 'replaceAssetGroup',
  'replaceGraph', 'replaceGraphAndSubject', 'replaceSubject', 'replaceSubjectAndInsert', 'rfc64AuthorCommitCasV1', 'update',
]);
export const OXIGRAPH_READ_GRAPH_CAPABILITIES: ReadGraphAdapterCapabilities = Object.freeze({
  methods: METHODS, serialUpdates: true, plansBlankNodeDeletes: false,
});
/** The worker store has no `replaceAssetGroup`. */
export const OXIGRAPH_WORKER_READ_GRAPH_CAPABILITIES: ReadGraphAdapterCapabilities = Object.freeze({
  methods: Object.freeze(METHODS.filter((method) => method !== 'replaceAssetGroup')),
  serialUpdates: true,
  plansBlankNodeDeletes: false,
});

const statements = sparqlStatements('oxigraph');
type Engine = InstanceType<typeof oxigraph.Store>;

/**
 * The one-update forms are written only with terms the engine has parsed: it
 * refuses an invalid IRI and escapes a literal when it prints it, so text in a
 * caller's term cannot end the statement or add an operation.
 */
function deleteDataUpdate(quads: readonly oxigraph.Quad[]): string {
  const byGraph = new Map<string, string[]>();
  for (const quad of quads) {
    const graph = quad.graph.termType === 'DefaultGraph' ? '' : String(quad.graph);
    let triples = byGraph.get(graph);
    if (!triples) byGraph.set(graph, triples = []);
    triples.push(`${String(quad.subject)} ${String(quad.predicate)} ${String(quad.object)} .`);
  }
  const blocks = [...byGraph].map(([graph, triples]) => (graph ? `GRAPH ${graph} { ${triples.join(' ')} }` : triples.join(' ')));
  return `DELETE DATA { ${blocks.join(' ')} }`;
}

/**
 * Delete `quads`. With a plan: one `DELETE DATA` of the quads the engine
 * parsed, with the plan's operations around it, and a quad with a blank node
 * refused before anything changes. Without a plan: one engine call per quad,
 * as before. Either way a quad the engine cannot parse names no stored quad,
 * and is skipped.
 */
export function deleteQuads(
  writable: () => Engine,
  quads: Quad[],
  options: QueryOptions | undefined,
  toEngineQuad: (quad: Quad) => oxigraph.Quad | null,
): void {
  if (!operationsOf(options)) {
    for (const quad of quads) {
      const engineQuad = toEngineQuad(quad);
      if (engineQuad) writable().delete(engineQuad);
    }
    return;
  }
  if (quads.some((quad) => isBlankNodeTerm(quad.subject) || isBlankNodeTerm(quad.object))) {
    throw new Error('OxigraphStore.delete cannot send read-graph operations with a quad that has a blank node: '
      + 'SPARQL names a stored blank node only by its shape, which may match other data');
  }
  const engineQuads = quads.map(toEngineQuad).filter((quad): quad is oxigraph.Quad => quad !== null);
  if (engineQuads.length > 0) writable().update(withReadGraphOperations(deleteDataUpdate(engineQuads), options));
}

/** The engine terms of a pattern delete, `null` for a term that matches anything: subject, predicate, object, graph. */
export type EnginePattern = readonly [oxigraph.Term | null, oxigraph.Term | null, oxigraph.Term | null, oxigraph.Term | null];

/**
 * Delete what matches `pattern`. With a plan: one update that deletes every
 * matching quad, written with the pattern's engine terms, with the plan's
 * operations around it; a blank node in the pattern is refused, as a DELETE
 * template cannot hold one. Without a plan: one engine call per quad of
 * `matches`, as before. Returns whether anything was sent that may have
 * changed the store.
 */
export function deleteMatching(
  writable: () => Engine,
  pattern: EnginePattern,
  matches: readonly oxigraph.Quad[],
  options: QueryOptions | undefined,
): boolean {
  if (!operationsOf(options)) {
    for (const match of matches) writable().delete(match);
    return matches.length > 0;
  }
  if (pattern.some((term) => term?.termType === 'BlankNode')) {
    throw new Error('OxigraphStore.deleteByPattern cannot send read-graph operations with a blank node in its pattern');
  }
  const [subject, predicate, object, graph] = pattern.map((term, i) => (term ? String(term) : ['?s', '?p', '?o', '?g'][i]));
  const triple = `${subject} ${predicate} ${object}`;
  writable().update(withReadGraphOperations(`DELETE { GRAPH ${graph} { ${triple} } } WHERE { GRAPH ${graph} { ${triple} } }`, options));
  return true;
}

/**
 * Run `update` and return how many quads it removed: counted in the whole
 * store without a plan, as before, and in `graph` alone with one, because the
 * plan's operations change the read graphs in the same update.
 */
export function quadsRemoved(engine: Engine, graph: string, options: QueryOptions | undefined, update: () => void): number {
  const count = operationsOf(options)
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
  const plan = operationsOf(options);
  return plan ? [{ readGraphPlan: plan }] : [];
}

/** An update's argument for the worker: its read-graph plan, and a deferred snapshot (`UpdateOptions.snapshot`), each only when set. */
export function readGraphUpdateArgs(options: UpdateOptions | undefined): [] | [ReadGraphWriteOptions & Pick<UpdateOptions, 'snapshot'>] {
  const [plan] = readGraphPlanArgs(options);
  return options?.snapshot === 'deferred' ? [{ ...plan, snapshot: 'deferred' }] : plan ? [plan] : [];
}
