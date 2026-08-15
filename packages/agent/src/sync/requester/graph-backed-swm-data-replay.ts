import type { Quad } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';

const PUBLIC_SNAPSHOT_GRAPH = 'http://dkg.io/ontology/publicSnapshotGraph';

export interface BoundedGraphBackedSwmDataPage {
  readonly completeGraphs: ReadonlySet<string>;
  readonly safeNextOffset: number;
  readonly safeRawNextOffset: number;
  readonly rewound: boolean;
}

export interface IndexedGraphBackedSwmDataPage {
  readonly dataByGraph: Map<string, Quad[]>;
  readonly rawStartByGraph: ReadonlyMap<string, number>;
}

/**
 * Raw advertisement terms are used only to partition aggregate DATA away from
 * the permissive legacy-root verifier. Descriptor parsing remains the sole
 * authority for identity, materialization, and completion.
 */
export function collectAdvertisedGraphBackedSnapshotGraphs(
  metaQuads: readonly Quad[],
): ReadonlySet<string> {
  return new Set(
    metaQuads
      .filter((quad) => quad.predicate === PUBLIC_SNAPSHOT_GRAPH)
      .map((quad) => stripLiteral(quad.object)?.trim())
      .filter((graph): graph is string => Boolean(graph)),
  );
}

/** Index one aggregate DATA page once, preserving its responder coordinates. */
export function indexGraphBackedSwmDataPage(params: {
  readonly quads: readonly Quad[];
  readonly advertisedGraphs: ReadonlySet<string>;
  readonly resumedFromOffset: number;
  readonly rawResumedFromOffset?: number;
  readonly quadRawOffsets?: readonly number[];
}): IndexedGraphBackedSwmDataPage {
  const dataByGraph = new Map<string, Quad[]>();
  const rawStartByGraph = new Map<string, number>();
  const rawStart = params.rawResumedFromOffset ?? params.resumedFromOffset;
  for (const [quadIndex, quad] of params.quads.entries()) {
    if (!params.advertisedGraphs.has(quad.graph)) continue;
    if (!rawStartByGraph.has(quad.graph)) {
      rawStartByGraph.set(
        quad.graph,
        params.quadRawOffsets?.[quadIndex] ?? rawStart + quadIndex,
      );
    }
    const rows = dataByGraph.get(quad.graph);
    if (rows) rows.push(quad);
    else dataByGraph.set(quad.graph, [quad]);
  }
  return { dataByGraph, rawStartByGraph };
}

/**
 * Project a possibly interrupted aggregate SWM DATA response onto whole
 * immutable snapshot graphs. The responder emits graph-backed snapshots as
 * contiguous graph groups before legacy root data; only a full count-bound
 * group may be materialized or skipped by the next requester cursor.
 */
export function planBoundedGraphBackedSwmDataPage(params: {
  readonly quads: readonly Quad[];
  readonly descriptors: readonly GraphScopedSwmRecoveryDescriptor[];
  readonly resumedFromOffset: number;
  readonly rawResumedFromOffset?: number;
  readonly nextOffset: number;
  readonly rawNextOffset?: number;
  readonly quadRawOffsets?: readonly number[];
  readonly completed: boolean;
}): BoundedGraphBackedSwmDataPage | null {
  const expectedByGraph = new Map<string, number>();
  for (const descriptor of params.descriptors) {
    const graph = descriptor.publicSnapshotGraph;
    if (!graph) continue;
    const existing = expectedByGraph.get(graph);
    if (existing !== undefined && existing !== descriptor.publicQuadsCount) return null;
    expectedByGraph.set(graph, descriptor.publicQuadsCount);
  }
  const rawResumed = params.rawResumedFromOffset ?? params.resumedFromOffset;
  const rawNext = params.rawNextOffset ?? params.nextOffset;
  if (expectedByGraph.size === 0) {
    return {
      completeGraphs: new Set(),
      safeNextOffset: params.nextOffset,
      safeRawNextOffset: rawNext,
      rewound: false,
    };
  }
  const rawOffsets = params.quadRawOffsets === undefined
    ? rawNext - rawResumed === params.quads.length
      ? params.quads.map((_, index) => rawResumed + index)
      : null
    : [...params.quadRawOffsets];
  if (
    rawOffsets === null
    || rawOffsets.length !== params.quads.length
    || rawOffsets.some((offset, index) => !Number.isSafeInteger(offset)
      || offset < rawResumed
      || offset >= rawNext
      || (index > 0 && offset <= rawOffsets[index - 1]!))
  ) return null;

  const completeGraphs = new Set<string>();
  const seenGraphs = new Set<string>();
  let index = 0;
  let sawLegacyRows = false;
  while (index < params.quads.length) {
    const graph = params.quads[index]!.graph;
    const expected = expectedByGraph.get(graph);
    if (expected === undefined) {
      sawLegacyRows = true;
      index += 1;
      continue;
    }
    if (sawLegacyRows || seenGraphs.has(graph)) return null;
    seenGraphs.add(graph);
    const groupStart = index;
    while (index < params.quads.length && params.quads[index]!.graph === graph) index += 1;
    const observed = index - groupStart;
    if (observed > expected) return null;
    if (observed === expected) {
      completeGraphs.add(graph);
      continue;
    }
    if (params.completed || index !== params.quads.length) return null;
    const safeRawNextOffset = rawOffsets[groupStart]!;
    return {
      completeGraphs,
      safeNextOffset: safeRawNextOffset,
      safeRawNextOffset,
      rewound: safeRawNextOffset < rawNext,
    };
  }
  return {
    completeGraphs,
    safeNextOffset: params.nextOffset,
    safeRawNextOffset: rawNext,
    rewound: false,
  };
}

function stripLiteral(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[-A-Za-z0-9]+|\^\^<[^>]+>)?$/);
  if (!match) return value;
  return match[1]
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
