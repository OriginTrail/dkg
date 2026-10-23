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
 * metadata is not whole, is empty, or does not parse. When it fetches it, the
 * graphs that graph-scoped shares travel in stay out of the root-entity check;
 * they are verified per asset, and the check only counted them as dropped.
 * Nothing changes on the wire: an older responder is asked less, never
 * differently.
 */

import type { Quad } from '@origintrail-official/dkg-storage';
import { getSyncCheckpointKey } from '../checkpoint/state.js';
import {
  parseGraphScopedSwmRecoveryDescriptors,
  type GraphScopedSwmRecoveryDescriptor,
} from '../graph-scoped-swm-recovery.js';
import { sharedMemoryCompletionFields } from '../shared-memory-completion.js';
import type { SyncPageResult } from './page-fetch.js';

const DKG_ROOT_ENTITY = 'http://dkg.io/ontology/rootEntity';

/** What the gate reads of the round's verification of the metadata alone. */
interface MetadataVerification {
  readonly verifiedMeta: Quad[];
  /** The legacy roots the metadata names, with their creators. */
  readonly entityCreators: readonly unknown[];
}

export interface PublicSwmDataPhaseInput<Verified extends MetadataVerification> {
  readonly contextGraphId: string;
  readonly remotePeerId: string;
  /** The round's metadata, in its scope. */
  readonly metaQuads: Quad[];
  /** The metadata phase completed from its start: its quads are the responder's whole metadata. */
  readonly metaWhole: boolean;
  readonly registeredSubGraphNames?: readonly string[];
  readonly excludedSubGraphNames?: readonly string[];
  /** The round's verifier, run here on the metadata alone. */
  readonly verifyMetadata: (metaQuads: Quad[]) => Promise<Verified>;
  /** Fetch the data phase. */
  readonly fetch: () => Promise<SyncPageResult>;
}

export interface PublicSwmDataPhase<Verified> {
  readonly result: SyncPageResult;
  /** The round's verification when the data phase was not fetched: the metadata's alone. */
  readonly metadataOnly?: Verified;
  /** The graph-scoped descriptors the metadata parsed to, when it was parsed. */
  readonly descriptors?: GraphScopedSwmRecoveryDescriptor[];
  /** The data quads that go to the root-entity check: those of graph-scoped shares left out. */
  readonly legacyQuads: (quads: Quad[]) => Quad[];
}

const allQuads = (quads: Quad[]): Quad[] => quads;

export async function fetchPublicSwmDataPhase<Verified extends MetadataVerification>(
  input: PublicSwmDataPhaseInput<Verified>,
): Promise<PublicSwmDataPhase<Verified>> {
  if (!input.metaWhole || input.metaQuads.length === 0) return { result: await input.fetch(), legacyQuads: allQuads };
  const metadataOnly = await input.verifyMetadata(input.metaQuads);
  let descriptors: GraphScopedSwmRecoveryDescriptor[];
  try {
    descriptors = parseGraphScopedSwmRecoveryDescriptors({
      contextGraphId: input.contextGraphId,
      metaQuads: metadataOnly.verifiedMeta,
      ...(input.registeredSubGraphNames ? { registeredSubGraphNames: input.registeredSubGraphNames } : {}),
      ...(input.excludedSubGraphNames ? { excludedSubGraphNames: input.excludedSubGraphNames } : {}),
    });
  } catch {
    // The round parses them again for the snapshot phase and reports it there.
    return { result: await input.fetch(), legacyQuads: allQuads };
  }
  const legacyRoots = metadataOnly.entityCreators.length > 0
    || input.metaQuads.some((quad) => quad.predicate === DKG_ROOT_ENTITY);
  const graphBacked = descriptors.some(({ snapshotSource }) => snapshotSource.locator.kind === 'graph');
  if (!legacyRoots && !graphBacked) {
    return { result: skippedDataPhase(input.remotePeerId, input.contextGraphId), metadataOnly, descriptors, legacyQuads: allQuads };
  }
  const transportGraphs = new Set(descriptors.flatMap(({ assertionGraph, snapshotSource: { locator } }) => (
    locator.kind === 'graph' ? [assertionGraph, locator.graph] : [assertionGraph]
  )));
  return {
    result: await input.fetch(),
    descriptors,
    legacyQuads: (quads) => quads.filter((quad) => !transportGraphs.has(quad.graph)),
  };
}

/** The data phase of a round that does not need it: complete and empty. */
function skippedDataPhase(remotePeerId: string, contextGraphId: string): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: getSyncCheckpointKey(remotePeerId, contextGraphId, true, 'data'),
    ...sharedMemoryCompletionFields('completed'),
  };
}
