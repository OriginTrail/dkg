// SPDX-License-Identifier: Apache-2.0

const CONTEXT_GRAPH_URI_PREFIX = "did:dkg:context-graph:";

export function normalizeContextGraphIdOrUri(contextGraphId: string): string {
  return contextGraphId.startsWith(CONTEXT_GRAPH_URI_PREFIX)
    ? contextGraphId.slice(CONTEXT_GRAPH_URI_PREFIX.length)
    : contextGraphId;
}

