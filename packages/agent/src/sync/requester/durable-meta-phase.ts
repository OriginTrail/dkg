// SPDX-License-Identifier: Apache-2.0
import { createGraphScopedDurableManifestPlan, type GraphScopedDurableManifestPlan } from '../durable-integrity.js';
import type { ExactAssetSelection } from '../exact-assets.js';
import { filterExactAssetDurablePayload } from './exact-durable-fetch.js';
import type { SyncPageResult } from './page-fetch.js';
import type { DurableMetaContinuationState } from './durable-meta-continuation.js';

export interface PreparedDurableMeta {
  readonly metaForManifest: SyncPageResult;
  readonly manifestPlan: GraphScopedDurableManifestPlan | null;
  readonly exactDescriptorCoverageComplete: boolean;
  readonly exactMismatchedDescriptorUals: readonly string[];
  readonly forceFreshUnboundDataSession: boolean;
}

function prepareDurableMeta(input: {
  readonly contextGraphId: string;
  readonly rawMetaResult: SyncPageResult;
  readonly exactAssetSelection?: ExactAssetSelection;
  readonly buildsManifest: boolean;
}): PreparedDurableMeta {
  const exact = input.exactAssetSelection === undefined
    ? undefined
    : filterExactAssetDurablePayload(
        [],
        input.rawMetaResult.quads,
        input.exactAssetSelection,
      );
  const metaForManifest = exact
    ? { ...input.rawMetaResult, quads: exact.metaQuads }
    : input.rawMetaResult;
  const manifestPlan = input.buildsManifest
    ? createGraphScopedDurableManifestPlan(
        metaForManifest.quads,
        input.contextGraphId,
      )
    : null;
  return {
    metaForManifest,
    manifestPlan,
    exactDescriptorCoverageComplete: exact?.descriptorCoverageComplete ?? true,
    exactMismatchedDescriptorUals: exact?.mismatchedDescriptorUals ?? [],
    forceFreshUnboundDataSession: input.buildsManifest && manifestPlan === null,
  };
}


export type DurableMetaPhaseResult =
  | { readonly kind: 'ready'; readonly preparedMeta: PreparedDurableMeta; readonly metaResult: SyncPageResult }
  | { readonly kind: 'retained'; readonly state: DurableMetaContinuationState }
  | { readonly kind: 'rejected'; readonly discardCheckpoints: readonly string[]; readonly error: Error };

/** Pure META preparation. The execution scope applies checkpoint, continuation and telemetry effects. */
export function prepareDurableMetaPhase(input: {
  contextGraphId: string; rawMetaResult: SyncPageResult; buildsManifest: boolean;
  exactAssetSelection?: ExactAssetSelection; retainPrefix: boolean; retained?: DurableMetaContinuationState;
}): DurableMetaPhaseResult {
  const { contextGraphId, rawMetaResult, retained } = input;
  let metaResult = rawMetaResult;
  if (input.retainPrefix) {
    if (retained) {
      if (retained.checkpointKey !== rawMetaResult.checkpointKey
        || rawMetaResult.resumedFromOffset !== retained.nextOffset
        || (rawMetaResult.rawResumedFromOffset ?? rawMetaResult.resumedFromOffset) !== retained.rawNextOffset) {
        return { kind: 'rejected', discardCheckpoints: [retained.checkpointKey],
          error: Object.assign(new Error(`Discarding retained META prefix for "${contextGraphId}": responder continuation changed`),
            { code: 'SYNC_META_CONTINUATION_MISMATCH' }) };
      }
      const rawOffsets = retained.quadRawOffsets && rawMetaResult.quadRawOffsets
        ? [...retained.quadRawOffsets, ...rawMetaResult.quadRawOffsets] : undefined;
      metaResult = { ...rawMetaResult, quads: [...retained.quads, ...rawMetaResult.quads],
        quadRawOffsets: rawOffsets, bytesReceived: retained.bytesReceived + rawMetaResult.bytesReceived,
        resumedFromOffset: 0, rawResumedFromOffset: 0 };
    }
    if (!rawMetaResult.completed || rawMetaResult.timedOut) {
      return { kind: 'retained', state: { checkpointKey: rawMetaResult.checkpointKey,
        quads: metaResult.quads, quadRawOffsets: metaResult.quadRawOffsets,
        bytesReceived: metaResult.bytesReceived, nextOffset: rawMetaResult.nextOffset,
        rawNextOffset: rawMetaResult.rawNextOffset ?? rawMetaResult.nextOffset } };
    }
  }
  if (input.buildsManifest && (!metaResult.completed || metaResult.timedOut || metaResult.resumedFromOffset !== 0)) {
    return { kind: 'rejected', discardCheckpoints: metaResult.resumedFromOffset !== 0 ? [metaResult.checkpointKey] : [],
      error: Object.assign(new Error(`Cannot authorize durable DATA continuation for "${contextGraphId}": META did not complete from offset zero`),
        { code: 'SYNC_DATA_MANIFEST_INCOMPLETE' }) };
  }
  const preparedMeta = prepareDurableMeta({ contextGraphId, rawMetaResult: metaResult,
    buildsManifest: input.buildsManifest, exactAssetSelection: input.exactAssetSelection });
  if (input.exactAssetSelection?.kind === 'challenge-pinned' && preparedMeta.exactMismatchedDescriptorUals.length > 0) {
    return { kind: 'rejected', discardCheckpoints: [],
      error: Object.assign(new Error(`Exact durable response for "${contextGraphId}" does not match the requested selection`),
        { code: 'SYNC_EXACT_DESCRIPTOR_MISMATCH' }) };
  }
  return { kind: 'ready', preparedMeta, metaResult };
}
