// SPDX-License-Identifier: Apache-2.0
import type { Quad } from '@origintrail-official/dkg-storage';
import { graphScopedDurableManifestPrefixAtOffset, type GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import type { DurableSyncContext } from './durable-sync.js';

interface ManifestSettlementCheckpoint {
  readonly numericAdvance: boolean;
}

/**
 * Advance only across a contiguous prefix of graph descriptors whose exact
 * assets have finished the chain-authentication + atomic-materialization
 * boundary. A numeric offset can cover adjacent zero-public descriptors, so
 * the canonical prefix helper (not DATA row counts alone) decides when the
 * prefix is persistable.
 */
export function createManifestSettlementCheckpointer(options: {
  manifest: GraphScopedDurableManifestPlan;
  checkpointKey: string;
  resumedFromOffset: number;
  rawResumedFromOffset: number;
  maximumOffset: number;
  dataQuads: readonly Quad[];
  quadRawOffsets?: readonly number[];
  setCheckpoint: DurableSyncContext['setCheckpoint'];
}): (assertionGraph: string) => ManifestSettlementCheckpoint | undefined {
  const {
    manifest,
    checkpointKey,
    resumedFromOffset,
    rawResumedFromOffset,
    maximumOffset,
    dataQuads,
    quadRawOffsets,
    setCheckpoint,
  } = options;
  const descriptorByGraph = new Map(
    manifest.descriptors.map((descriptor) => [descriptor.assertionGraph, descriptor] as const),
  );
  const resumedPrefix = resumedFromOffset > 0
    ? graphScopedDurableManifestPrefixAtOffset(manifest, resumedFromOffset)
    : null;
  if (resumedFromOffset > 0 && !resumedPrefix) {
    throw new Error(
      `Cannot continue manifest settlement from non-boundary offset ${resumedFromOffset}`,
    );
  }

  let descriptorIndex = resumedPrefix?.descriptorCount ?? 0;
  let safeOffset = resumedFromOffset;
  let persistedDescriptorCount = descriptorIndex;
  let persistedOffset = resumedFromOffset;
  const settledGraphs = new Set<string>();

  return (assertionGraph: string): ManifestSettlementCheckpoint | undefined => {
    if (!descriptorByGraph.has(assertionGraph)) {
      throw new Error(
        `Refusing to checkpoint graph ${assertionGraph}: it is absent from the verified manifest`,
      );
    }
    settledGraphs.add(assertionGraph);
    while (
      descriptorIndex < manifest.descriptors.length
      && settledGraphs.has(manifest.descriptors[descriptorIndex]!.assertionGraph)
    ) {
      safeOffset += manifest.descriptors[descriptorIndex]!.publicTripleCount;
      descriptorIndex += 1;
    }
    if (!Number.isSafeInteger(safeOffset) || safeOffset > maximumOffset) {
      throw new Error(
        `Refusing to checkpoint settled durable prefix ${safeOffset} beyond verified offset ${maximumOffset}`,
      );
    }

    const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, safeOffset);
    // The prefix helper includes every adjacent zero-public descriptor. Wait
    // until all of those descriptors have settled before binding this offset.
    if (!prefix || prefix.descriptorCount !== descriptorIndex) return undefined;
    // Only a completed phase checkpoints the manifest's end, as terminal: no
    // graph starts there for a non-terminal checkpoint to resume from.
    if (safeOffset === manifest.manifestRowCount) return undefined;
    if (
      safeOffset === persistedOffset
      && descriptorIndex === persistedDescriptorCount
    ) return undefined;

    const numericAdvance = safeOffset > persistedOffset;
    const settledRowCount = safeOffset - resumedFromOffset;
    if (
      dataQuads.length < settledRowCount
      || dataQuads.slice(0, settledRowCount).some(
        (quad) => !settledGraphs.has(quad.graph),
      )
    ) {
      // A responder may legally return exact graph partitions out of manifest
      // order. Do not bind the raw session after a manifest prefix when doing
      // so would skip an as-yet-unsettled graph that appeared earlier on wire.
      return undefined;
    }
    const responderSessionOffset = settledRowCount === 0
      ? rawResumedFromOffset
      : quadRawOffsets
        ? quadRawOffsets[settledRowCount - 1]! + 1
        : rawResumedFromOffset + settledRowCount;
    if (!Number.isSafeInteger(responderSessionOffset)) {
      throw new Error(
        `Refusing to checkpoint settled durable prefix ${safeOffset}: responder coordinate is unavailable`,
      );
    }
    setCheckpoint(checkpointKey, {
      offset: safeOffset,
      responderSessionOffset,
      binding: {
        manifestDigest: manifest.manifestDigest,
        manifestPrefixDigest: prefix.prefixDigest,
        terminal: false,
      },
    });
    persistedOffset = safeOffset;
    persistedDescriptorCount = descriptorIndex;
    return { numericAdvance };
  };
}



/** Fetching can advance a responder cursor ahead of the still-stored prefix. Keep both coordinates aligned until settlement advances it. */
export function preserveResumedManifestCheckpoint(
  manifest: GraphScopedDurableManifestPlan,
  result: { checkpointKey: string; resumedFromOffset: number; rawResumedFromOffset?: number },
  setCheckpoint: DurableSyncContext['setCheckpoint'],
): void {
  const prefix = graphScopedDurableManifestPrefixAtOffset(manifest, result.resumedFromOffset);
  if (!prefix) throw new Error('Cannot preserve a non-boundary stored prefix');
  setCheckpoint(result.checkpointKey, {
    offset: result.resumedFromOffset,
    responderSessionOffset: result.rawResumedFromOffset ?? result.resumedFromOffset,
    binding: { manifestDigest: manifest.manifestDigest, manifestPrefixDigest: prefix.prefixDigest, terminal: false },
  });
}
