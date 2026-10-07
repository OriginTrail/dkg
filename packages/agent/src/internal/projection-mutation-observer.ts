// SPDX-License-Identifier: Apache-2.0

import { isSafeIri } from '@origintrail-official/dkg-core';
import type { ContextGraphMetaProjection } from '../context-graph-meta-projection.js';
import type { StoreMutation, StoreMutationObserver } from './store-mutation.js';

/** What the metadata projection must learn from a write that changed something. */
function notifyProjection(projection: ContextGraphMetaProjection, mutation: StoreMutation): void {
  // A quad whose predicate is not a bare IRI may be stored under another one, so no classification
  // of its predicate holds.
  if (mutation.everything || mutation.quads?.some((quad) => !isSafeIri(quad.predicate))) {
    projection.markAllDirty();
    return;
  }
  for (const { graph, subject, predicate } of mutation.removals ?? []) {
    // #1863 — a single-graph destructive mutation names its TARGET GRAPH so
    // deleted facts are fenced, while replacement quads cover inserted ones. A graph
    // that is not a bare IRI names nothing provable (some adapters read an empty
    // one as a wildcard), so it is a write that may have changed anything.
    if (graph === undefined || !isSafeIri(graph)) projection.markAllDirty();
    else projection.markDirtyForGraph(graph, subject, predicate);
  }
  if (mutation.quads) projection.markDirtyFromQuads(mutation.quads);
}

/** How the agent's store wrapper tells the metadata projection what a write is about to change and did change. */
export function createProjectionMutationObserver(
  getProjection: () => ContextGraphMetaProjection | undefined,
): StoreMutationObserver {
  return {
    begin(mutation) {
      const projection = getProjection();
      const release = projection?.recipientKeyRouteFence.begin(mutation);
      return (outcome) => {
        try {
          if (outcome !== 'unchanged' && projection) notifyProjection(projection, mutation);
        } finally {
          release?.(outcome);
        }
      };
    },
  };
}
