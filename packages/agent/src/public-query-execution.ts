import { QueryMaterializationBudget } from '@origintrail-official/dkg-query';
import { executeUnscopedQuery } from './unscoped-query-consistency.js';
import { asQueryResultTooLargeError } from './query-result-too-large-error.js';

/** One public ceiling becomes per-response transport and cumulative decoded limits. */
export function publicQueryBudget(maxResponseBytes: number | undefined) {
  return { maxMaterializedBytes: maxResponseBytes,
    materializationBudget: maxResponseBytes === undefined ? undefined : new QueryMaterializationBudget(maxResponseBytes) };
}

/** Scoped and unscoped execution share the same public failure classification. */
export async function executePublicQuery<T>(contextGraphId: string | undefined,
  deps: Parameters<typeof executeUnscopedQuery<T>>[0]): Promise<T> {
  try { return await (contextGraphId ? deps.execute() : executeUnscopedQuery(deps)); }
  catch (error) { throw asQueryResultTooLargeError(error) ?? error; }
}
