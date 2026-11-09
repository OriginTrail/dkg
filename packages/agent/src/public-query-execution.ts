import { QueryMaterializationBudget } from '@origintrail-official/dkg-query';
import { asQueryResultTooLargeError } from './query-result-too-large-error.js';

/** One public ceiling becomes per-response transport and cumulative decoded limits. */
export function publicQueryBudget(maxResponseBytes: number | undefined) {
  return { maxMaterializedBytes: maxResponseBytes,
    materializationBudget: maxResponseBytes === undefined ? undefined : new QueryMaterializationBudget(maxResponseBytes) };
}

/** Scoped and unscoped execution share the same public failure classification. */
export async function executePublicQuery<T>(execute: () => Promise<T>): Promise<T> {
  try { return await execute(); }
  catch (error) { throw asQueryResultTooLargeError(error) ?? error; }
}
