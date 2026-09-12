// SPDX-License-Identifier: Apache-2.0

import { mapCanaryPhaseDrainedV1 } from './phase-helpers.mjs';

/** @typedef {import('./domain-contract.js').CanaryNodeClientV1} CanaryNodeClientV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryContextGraphV1} NormalizedCanaryContextGraphV1 */

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

/**
 * Execute one source and one receiver ASK per configured graph under a single
 * phase-scoped cap on individual remote requests. Results remain in graph order.
 * @param {readonly NormalizedCanaryContextGraphV1[]} contextGraphs
 * @param {'vmAskSparql' | 'catalogSwmAskSparql'} queryField
 * @param {'shared-working-memory' | 'verifiable-memory'} view
 * @param {CanaryNodeClientV1} client
 * @returns {Promise<readonly (Readonly<{ source: boolean, receiver: boolean }> | null)[]>}
 */
export async function askContextGraphPairsV1(contextGraphs, queryField, view, client) {
  const requests = contextGraphs.flatMap((contextGraph, contextGraphIndex) => {
    const sparql = contextGraph[queryField];
    return sparql === undefined ? [] : [
      Object.freeze({
        contextGraphIndex,
        side: /** @type {const} */ ('source'),
        node: contextGraph.source,
        sparql,
      }),
      Object.freeze({
        contextGraphIndex,
        side: /** @type {const} */ ('receiver'),
        node: contextGraph.receiver,
        sparql,
      }),
    ];
  });
  const responses = await mapCanaryPhaseDrainedV1(requests, async (request) => Object.freeze({
    contextGraphIndex: request.contextGraphIndex,
    side: request.side,
    passed: await askQueryV1(
      request.node,
      contextGraphs[request.contextGraphIndex].id,
      request.sparql,
      view,
      client,
    ),
  }));
  /** @type {Map<number, Partial<Record<'source' | 'receiver', boolean>>>} */
  const responseByGraph = new Map();
  for (const response of responses) {
    const previous = responseByGraph.get(response.contextGraphIndex) ?? {};
    responseByGraph.set(
      response.contextGraphIndex,
      Object.freeze({ ...previous, [response.side]: response.passed }),
    );
  }
  return Object.freeze(contextGraphs.map((contextGraph, index) => {
    if (contextGraph[queryField] === undefined) return null;
    const response = responseByGraph.get(index);
    if (
      response === undefined
      || typeof response.source !== 'boolean'
      || typeof response.receiver !== 'boolean'
    ) throw new TypeError('paired-query-result-missing');
    return Object.freeze({ source: response.source, receiver: response.receiver });
  }));
}
