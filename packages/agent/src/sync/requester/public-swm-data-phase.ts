// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a public shared-memory sync round fetches the aggregate data phase
 * (#3421). The private recovery lane has the same gate (`swm-recovery.ts`).
 *
 * The data phase pages a graph's shared-memory data graphs. Only legacy
 * shares, rooted at a `dkg:rootEntity`, and old graph-backed snapshots are
 * read from it. A graph-scoped share has no root entity: its content arrives
 * in the snapshot phase, while the responder sends its per-asset graph in the
 * data phase whole and the requester drops it as subjects outside any root.
 * So on a graph of such shares every pull moved the whole graph for nothing,
 * and a transport failure in the data phase ended the round before the
 * snapshot phase that delivers them.
 *
 * The round now fetches the data phase only when the metadata it fetched
 * names a root entity or a graph-backed snapshot, or cannot tell: when the
 * metadata is not whole, is empty, or does not parse. The gate reads the
 * metadata as fetched, so the round still verifies it once, with whatever
 * data it fetched. When the data phase is fetched, the graphs that
 * graph-scoped shares travel in stay out of the root-entity check; they are
 * verified per asset, and the check only counted them as dropped. Nothing
 * changes on the wire: a responder is asked for less, never differently.
 */

import { DKG_ENTITY, DKG_ROOT_ENTITY_LEGACY } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { getSyncCheckpointKey } from '../checkpoint/state.js';
import { parseGraphScopedSwmRecoveryDescriptors } from '../graph-scoped-swm-recovery.js';
import { sharedMemoryCompletionFields } from '../shared-memory-completion.js';
import type { SyncPageResult } from './page-fetch.js';

export interface PublicSwmMetadata {
  readonly contextGraphId: string;
  /** The round's metadata, in its scope, as fetched. */
  readonly metaQuads: readonly Quad[];
  /** The metadata phase completed from its start: its quads are the responder's whole metadata. */
  readonly metaWhole: boolean;
  readonly registeredSubGraphNames?: readonly string[];
  readonly excludedSubGraphNames?: readonly string[];
}

/** What a round's metadata asks of its data phase. */
export interface PublicSwmDataPhasePlan {
  readonly fetch: boolean;
  /** The graphs graph-scoped shares travel in: kept out of the root-entity check. */
  readonly transportGraphs: ReadonlySet<string>;
}

/** Whether the round needs its data phase, from its metadata alone. Never throws. */
export function planPublicSwmDataPhase(metadata: PublicSwmMetadata): PublicSwmDataPhasePlan {
  const fetchAll: PublicSwmDataPhasePlan = { fetch: true, transportGraphs: new Set() };
  if (!metadata.metaWhole || metadata.metaQuads.length === 0) return fetchAll;
  let descriptors: ReturnType<typeof parseGraphScopedSwmRecoveryDescriptors>;
  try {
    descriptors = parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: metadata.contextGraphId,
      metaQuads: metadata.metaQuads,
      ...(metadata.registeredSubGraphNames ? { registeredSubGraphNames: metadata.registeredSubGraphNames } : {}),
      ...(metadata.excludedSubGraphNames ? { excludedSubGraphNames: metadata.excludedSubGraphNames } : {}),
    });
  } catch {
    // The round parses its verified metadata again for the snapshot phase and reports a failure there.
    return fetchAll;
  }
  return {
    fetch: metadata.metaQuads.some((quad) => quad.predicate === DKG_ROOT_ENTITY_LEGACY || quad.predicate === DKG_ENTITY)
      || descriptors.some(({ snapshotSource }) => snapshotSource.locator.kind === 'graph'),
    transportGraphs: new Set(descriptors.flatMap(({ assertionGraph, snapshotSource: { locator } }) => (
      locator.kind === 'graph' ? [assertionGraph, locator.graph] : [assertionGraph]
    ))),
  };
}

export interface PublicSwmDataPhase {
  readonly result: SyncPageResult;
  /** The data quads that go to the root-entity check: those of graph-scoped shares left out. */
  readonly legacyQuads: (quads: Quad[]) => Quad[];
}

/** The round's data phase: fetched when its metadata needs it, complete and empty otherwise. */
export async function fetchPublicSwmDataPhase(
  input: PublicSwmMetadata & { readonly remotePeerId: string; readonly fetch: () => Promise<SyncPageResult> },
): Promise<PublicSwmDataPhase> {
  const plan = planPublicSwmDataPhase(input);
  const legacyQuads = (quads: Quad[]): Quad[] => quads.filter((quad) => !plan.transportGraphs.has(quad.graph));
  if (plan.fetch) return { result: await input.fetch(), legacyQuads };
  return {
    result: {
      quads: [],
      bytesReceived: 0,
      resumedFromOffset: 0,
      nextOffset: 0,
      checkpointKey: getSyncCheckpointKey(input.remotePeerId, input.contextGraphId, true, 'data'),
      ...sharedMemoryCompletionFields('completed'),
    },
    legacyQuads,
  };
}
