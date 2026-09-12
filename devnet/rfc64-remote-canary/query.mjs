// SPDX-License-Identifier: Apache-2.0

/** Execute an ASK against one configured context-graph view. */
/**
 * @param {import('./domain-contract.js').NormalizedCanaryNodeV1} node
 * @param {import('./domain-contract.js').NormalizedCanaryContextGraphV1} contextGraph
 * @param {string} sparql
 * @param {'shared-working-memory' | 'verifiable-memory'} view
 * @param {import('./domain-contract.js').CanaryRequesterV1} request
 */
export async function askConfiguredQueryV1(node, contextGraph, sparql, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql,
    contextGraphId: contextGraph.id,
    view,
  });
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  const queryResult = /** @type {Record<string, unknown>} */ (result).result;
  return queryResult !== null
    && typeof queryResult === 'object'
    && !Array.isArray(queryResult)
    && /** @type {Record<string, unknown>} */ (queryResult).type === 'boolean'
    && /** @type {Record<string, unknown>} */ (queryResult).value === true;
}
