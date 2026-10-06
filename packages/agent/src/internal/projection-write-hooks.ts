// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';
import type { ContextGraphMetaProjection } from '../context-graph-meta-projection.js';
import type { StoreMutationScope } from './context-graph-cache-invalidating-store.js';

/** How the agent's store wrapper tells the metadata projection what a write changed or is about to add. */
export function createProjectionWriteHooks(getProjection: () => ContextGraphMetaProjection | undefined) {
  return {
    markDirty(
      quads?: readonly Quad[],
      targetGraph?: string,
      targetSubject?: string,
      scope?: StoreMutationScope,
    ): void {
      const projection = getProjection();
      if (!projection) return;
      // #1863 — a single-graph destructive mutation (replaceSubject) passes its
      // TARGET GRAPH so deleted facts are fenced, while replacement quads
      // cover inserted authority facts.
      if (targetGraph !== undefined) {
        projection.markDirtyForGraph(targetGraph, targetSubject, scope);
        if (quads) projection.markDirtyFromQuads(quads);
        return;
      }
      if (quads) projection.markDirtyFromQuads(quads);
      else projection.markAllDirty();
    },
    anticipate(quads?: readonly Quad[]): void {
      getProjection()?.recipientKeyRouteFence.anticipate(quads);
    },
  };
}
