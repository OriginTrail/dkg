// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3134 — rows of an author's SWM inventory whose asset is finalized and whose shared-memory
 * copy the node already retired. Until the retirement removed such rows, a node kept them, and on
 * a public lane each one fails every projection of the author's catalog. A projection failure of
 * that kind sweeps them out, once per inventory head: one pass over the rows, one exact removal,
 * and so one inventory successor, per row.
 */
import type {
  ContextGraphIdV1,
  EvmAddressV1,
  SwmAuthorInventoryRowV1,
  SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';
import {
  KnowledgeAssetWorkspaceHeadCorruptError,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
  resolvePublishedKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';

/** Since the node started: the sweeps run, and the rows they removed. */
export interface FinalizedRowHealCountsV1 {
  readonly finalizedRowHealPasses: number;
  readonly finalizedRowsHealed: number;
}

interface FinalizedRowHealStateV1 {
  passes: number;
  rows: number;
  /** Per graph and author, the inventory head that the last completed sweep left behind. */
  readonly sweptHeads: Map<string, string>;
}

const STATES_V1 = new WeakMap<object, FinalizedRowHealStateV1>();

export function finalizedRowHealCountsV1(owner: object): FinalizedRowHealCountsV1 {
  const state = STATES_V1.get(owner);
  return Object.freeze({
    finalizedRowHealPasses: state?.passes ?? 0,
    finalizedRowsHealed: state?.rows ?? 0,
  });
}

/**
 * The supervisor status with the sweep counts added to its author-catalog capacity counts, once
 * this node has run a sweep. A node that never needed one reports the capacity counts alone.
 */
export function withFinalizedRowHealCountsV1<T extends { readonly authorCatalogCapacity?: object }>(
  owner: object,
  status: Readonly<T> | null,
): Readonly<T> | null {
  if (status === null || status.authorCatalogCapacity === undefined || STATES_V1.get(owner) === undefined) {
    return status;
  }
  return Object.freeze({
    ...status,
    authorCatalogCapacity: Object.freeze({
      ...status.authorCatalogCapacity,
      ...finalizedRowHealCountsV1(owner),
    }),
  });
}

/**
 * Sweep one author's inventory unless its head was swept before: remove each row whose asset is
 * finalized at or above the row's version and has no shared-memory head left. Answers how many
 * rows went.
 */
export async function healFinalizedSwmInventoryRowsV1(
  owner: object,
  input: Readonly<{
    store: TripleStore;
    contextGraphId: ContextGraphIdV1;
    authorAddress: EvmAddressV1;
    snapshot: SwmAuthorInventorySnapshotV1;
    signal?: AbortSignal;
    /** One exact removal: the row, if it is still the inventory's, goes in its own successor. */
    removeRow: (row: Readonly<SwmAuthorInventoryRowV1>) => Promise<'applied' | 'absent'>;
    readHeadDigest: () => string | null;
  }>,
): Promise<number> {
  let state = STATES_V1.get(owner);
  if (state === undefined) {
    state = { passes: 0, rows: 0, sweptHeads: new Map() };
    STATES_V1.set(owner, state);
  }
  const key = `${input.contextGraphId}\n${input.authorAddress}`;
  if (state.sweptHeads.get(key) === input.snapshot.head.objectDigest) return 0;
  state.passes += 1;
  const graphManager = new GraphManager(input.store);
  let removed = 0;
  try {
    for (const row of input.snapshot.rows) {
      input.signal?.throwIfAborted();
      if (!await finalizedAtOrAboveV1(input.store, input.contextGraphId, row)) continue;
      if (!await sharedCopyRetiredV1(input.store, graphManager, input.contextGraphId, row)) continue;
      if (await input.removeRow(row) === 'applied') removed += 1;
    }
  } finally {
    state.rows += removed;
  }
  // A later failure on the head this sweep leaves behind has nothing new to find.
  state.sweptHeads.set(key, input.readHeadDigest() ?? input.snapshot.head.objectDigest);
  return removed;
}

async function finalizedAtOrAboveV1(
  store: TripleStore,
  contextGraphId: ContextGraphIdV1,
  row: Readonly<SwmAuthorInventoryRowV1>,
): Promise<boolean> {
  const stored = await readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, {
    contextGraphId,
    ual: row.kaUal,
  });
  return stored.state === 'confirmed'
    && stored.envelope.subGraphName === undefined
    && BigInt(stored.envelope.assertionVersion) >= BigInt(row.assertionVersion);
}

async function sharedCopyRetiredV1(
  store: TripleStore,
  graphManager: GraphManager,
  contextGraphId: ContextGraphIdV1,
  row: Readonly<SwmAuthorInventoryRowV1>,
): Promise<boolean> {
  try {
    const head = await resolvePublishedKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId,
      kaUal: row.kaUal,
    });
    return head === undefined;
  } catch (error) {
    // A torn head is not a retired copy; the finalized twin's own step removes such heads.
    if (error instanceof KnowledgeAssetWorkspaceHeadCorruptError) return false;
    throw error;
  }
}
