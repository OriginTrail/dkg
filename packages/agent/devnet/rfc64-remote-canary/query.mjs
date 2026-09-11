// SPDX-License-Identifier: Apache-2.0

/** Execute an ASK against one configured context-graph view. */
export async function askConfiguredQueryV1(node, contextGraph, sparql, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql,
    contextGraphId: contextGraph.id,
    view,
  });
  return result.result?.type === 'boolean' && result.result.value === true;
}
