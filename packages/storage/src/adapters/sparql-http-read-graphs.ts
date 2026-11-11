import type {
  ReadGraphAdapterCapabilities,
  ReadGraphPlannedMethod,
} from '../read-graph/adapter-contract.js';
import type { QueryOptions } from '../triple-store.js';
import { refuseReadGraphOperations, withReadGraphOperationsAroundCallerUpdate } from './read-graph-request.js';

export type { ReadGraphCapableAdapter } from '../read-graph/adapter-contract.js';

/**
 * What SparqlHttpStore declares about read graphs (see
 * `read-graph/adapter-contract.ts`), and the text of the request a write sends.
 *
 * Every write of SparqlHttpStore that changes data sends that change as one
 * update request, through one dispatch path, and a plan's operations go around
 * it in the same request. That request is one transaction only on an endpoint
 * whose consistency profile says so (`atomic-update`, or `atomic-readback`,
 * which a daemon-owned Oxigraph has). A best-effort endpoint declares no
 * method, so read graphs are refused on it.
 *
 * oxigraph-server runs update requests side by side, each on its own snapshot,
 * so `serialUpdates` is false: a request whose response was lost may still be
 * running when the next one starts.
 */
const METHODS: readonly ReadGraphPlannedMethod[] = Object.freeze([
  'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix', 'dropGraph', 'replaceAssetGroup',
  'replaceGraph', 'replaceGraphAndSubject', 'replaceSubject', 'replaceSubjectAndInsert', 'rfc64AuthorCommitCasV1', 'update',
]);
const ATOMIC_UPDATES: ReadGraphAdapterCapabilities = Object.freeze({ methods: METHODS, serialUpdates: false });
const BEST_EFFORT: ReadGraphAdapterCapabilities = Object.freeze({ methods: Object.freeze([]), serialUpdates: false });

/** The capabilities of a SparqlHttpStore whose endpoint does, or does not, run a multi-operation update as one transaction. */
export function sparqlHttpReadGraphCapabilities(atomicUpdates: boolean): ReadGraphAdapterCapabilities {
  return atomicUpdates ? ATOMIC_UPDATES : BEST_EFFORT;
}

/**
 * The update request of one write, run as store operation `operation`: the
 * write's own update text, the caller's for `update`, with the plan's
 * operations around it. A plan with operations on an operation the store has
 * not declared is refused before anything is sent: `insert`, whose quads the
 * layer adds to the same call instead, and every write on a best-effort
 * endpoint.
 */
export function sparqlHttpUpdateRequest(
  update: string,
  options: QueryOptions | undefined,
  operation: string,
  capabilities: ReadGraphAdapterCapabilities,
): string {
  if (!(capabilities.methods as readonly string[]).includes(operation)) {
    refuseReadGraphOperations(options, `SparqlHttpStore.${operation}`);
  }
  return withReadGraphOperationsAroundCallerUpdate(update, options);
}
