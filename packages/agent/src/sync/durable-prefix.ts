// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import type { GraphScopedDurableManifestPlan } from './durable-integrity.js';

/** Positive-width graphs after a verified manifest boundary. */
export function manifestGraphsAfter(manifest: GraphScopedDurableManifestPlan, offset: number) {
  const graphs: Array<{ graph: string; rows: number }> = [];
  let boundary = 0;
  for (const descriptor of manifest.descriptors) {
    if (descriptor.publicTripleCount === 0) continue;
    boundary += descriptor.publicTripleCount;
    if (boundary > offset) graphs.push({ graph: descriptor.assertionGraph, rows: descriptor.publicTripleCount });
  }
  return graphs;
}

/**
 * Count a contiguous retained prefix once as pages arrive. The fetch budget and
 * final integrity planner use the same boundary/replay rules. This only selects
 * candidates: the integrity verifier must still authenticate every kept graph.
 */
export function createGraphScopedDurablePrefix(manifest: GraphScopedDurableManifestPlan, resumedFromOffset: number) {
  const graphs = manifestGraphsAfter(manifest, resumedFromOffset);
  const indexByGraph = new Map(graphs.map(({ graph }, index) => [graph, index]));
  const counts = Array.from({ length: graphs.length }, () => 0);
  let boundary = 0;
  let validBoundary = resumedFromOffset === 0;
  for (const descriptor of manifest.descriptors) {
    boundary += descriptor.publicTripleCount;
    if (boundary === resumedFromOffset) validBoundary = true;
  }
  let valid = validBoundary && Number.isSafeInteger(boundary) && Number.isSafeInteger(resumedFromOffset)
    && resumedFromOffset >= 0 && (resumedFromOffset === 0 || graphs.length > 0);
  let completeCount = 0;
  let completeOffset = resumedFromOffset;
  return {
    graphs,
    manifestRowCount: boundary,
    observe(quads: readonly Pick<Quad, 'graph'>[]): void {
      for (const { graph } of quads) {
        const index = indexByGraph.get(graph);
        if (index === undefined) { valid = false; continue; }
        counts[index]! += 1;
        if (index < completeCount) valid = false;
      }
      // Each graph advances the cursor once, even across millions of small pages.
      while (completeCount < graphs.length && counts[completeCount] === graphs[completeCount]!.rows) {
        completeOffset += graphs[completeCount]!.rows;
        completeCount += 1;
      }
      if (completeCount < graphs.length && counts[completeCount]! > graphs[completeCount]!.rows) valid = false;
    },
    prefix(rawNextOffset: number, phaseCompleted: boolean) {
      if (!valid || completeOffset > rawNextOffset) return null;
      let count = completeCount;
      let safeNextOffset = completeOffset;
      // An interrupted round replays its final graph at the raw stop or at EOF.
      // Filtered raw rows must never manufacture a resumable manifest-end offset.
      if (!phaseCompleted && count > 0 && (safeNextOffset === rawNextOffset || safeNextOffset === boundary)) {
        safeNextOffset -= graphs[--count]!.rows;
      }
      return { completedGraphCount: count, safeNextOffset, allGraphsComplete: completeCount === graphs.length };
    },
  };
}
