// SPDX-License-Identifier: Apache-2.0

/** Execute an ASK against one context-graph view. */
/**
 * @param {import('./domain-contract.js').NormalizedCanaryNodeV1} node
 * @param {string} contextGraphId
 * @param {string} sparql
 * @param {'shared-working-memory' | 'verifiable-memory'} view
 * @param {import('./domain-contract.js').CanaryNodeClientV1} client
 */
export function askQueryV1(node, contextGraphId, sparql, view, client) {
  return client.askQuery(node, {
    sparql,
    contextGraphId,
    view,
  });
}
