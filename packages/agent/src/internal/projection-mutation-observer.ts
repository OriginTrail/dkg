// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphMetaProjection } from '../context-graph-meta-projection.js';
import type { StoreMutation, StoreMutationObserver } from './store-mutation.js';

/** What the metadata projection must learn from a write that changed something. */
function notifyProjection(projection: ContextGraphMetaProjection, mutation: StoreMutation): void {
  if (mutation.everything) {
    projection.markAllDirty();
    return;
  }
  for (const { graph, subject, predicate } of mutation.removals ?? []) {
    // #1863 — a single-graph destructive mutation names its TARGET GRAPH so
    // deleted facts are fenced, while replacement quads cover inserted ones.
    if (graph === undefined) projection.markAllDirty();
    else projection.markDirtyForGraph(graph, subject, predicate);
  }
  if (mutation.quads) projection.markDirtyFromQuads(mutation.quads);
  if (mutation.unseenPayload) projection.recipientKeyRouteFence.noteUnscopedWrite();
}

/** How the agent's store wrapper tells the metadata projection what a write is about to change and did change. */
export function createProjectionMutationObserver(
  getProjection: () => ContextGraphMetaProjection | undefined,
): StoreMutationObserver {
  return {
    begin(mutation) {
      const projection = getProjection();
      const release = projection?.recipientKeyRouteFence.begin(mutation);
      return (changed) => {
        try {
          if (changed && projection) notifyProjection(projection, mutation);
        } finally {
          release?.();
        }
      };
    },
  };
}
