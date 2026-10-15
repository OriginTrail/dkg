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

import type { Rfc64SwmAuthorInventoryShadowMutationResultV1 } from '../rfc64/swm-inventory-shadow-runtime-v1.js';

/** Since the node started: the sweeps run, and the rows they removed. */
export interface FinalizedRowHealCountsV1 {
  readonly finalizedRowHealPasses: number;
  readonly finalizedRowsHealed: number;
}

/**
 * An unchanged inventory head is swept again after this long: whether a row may go also depends on
 * its asset's verified copy and shared copy, which change without the inventory changing.
 */
export const FINALIZED_ROW_RESWEEP_INTERVAL_MS_V1 = 60_000;

interface FinalizedRowHealStateV1 {
  passes: number;
  rows: number;
  /** Per graph and author, the last inventory head whose every row a sweep examined, and when. */
  readonly sweptHeads: Map<string, Readonly<{ head: string; atMs: number }>>;
}

const STATES_V1 = new WeakMap<object, FinalizedRowHealStateV1>();

/** The counts once this node has run a sweep; until then there are none. */
export function finalizedRowHealCountsV1(owner: object): FinalizedRowHealCountsV1 | undefined {
  const state = STATES_V1.get(owner);
  return state === undefined ? undefined : Object.freeze({
    finalizedRowHealPasses: state.passes,
    finalizedRowsHealed: state.rows,
  });
}

/**
 * One pass over one inventory snapshot, unless its head was swept less than
 * `FINALIZED_ROW_RESWEEP_INTERVAL_MS_V1` ago: remove each row whose asset is finalized at or above
 * the row's version and has no shared-memory head left. The head counts as swept once every row
 * was examined and every eligible one removed, so a failed removal is tried again by the next
 * sweep. Rows that other work commits meanwhile belong to a newer head, which the caller's next
 * attempt sweeps. Answers how many rows went.
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
    removeRow: (row: Readonly<SwmAuthorInventoryRowV1>) => Promise<Rfc64SwmAuthorInventoryShadowMutationResultV1['status']>;
    now?: () => number;
  }>,
): Promise<number> {
  let state = STATES_V1.get(owner);
  if (state === undefined) {
    state = { passes: 0, rows: 0, sweptHeads: new Map() };
    STATES_V1.set(owner, state);
  }
  const key = `${input.contextGraphId}\n${input.authorAddress}`;
  const now = input.now ?? Date.now;
  const head = input.snapshot.head.objectDigest;
  const swept = state.sweptHeads.get(key);
  if (swept?.head === head && now() - swept.atMs < FINALIZED_ROW_RESWEEP_INTERVAL_MS_V1) return 0;
  state.passes += 1;
  const graphManager = new GraphManager(input.store);
  let removed = 0;
  let failed = false;
  try {
    for (const row of input.snapshot.rows) {
      input.signal?.throwIfAborted();
      if (!await finalizedAtOrAboveV1(input.store, input.contextGraphId, row)) continue;
      if (!await sharedCopyRetiredV1(input.store, graphManager, input.contextGraphId, row, input.signal)) continue;
      const outcome = await input.removeRow(row);
      if (outcome === 'applied') removed += 1;
      else if (outcome === 'failed') failed = true;
    }
  } finally {
    state.rows += removed;
  }
  // A head with an eligible row that could not be removed stays eligible for the next sweep.
  if (!failed) state.sweptHeads.set(key, Object.freeze({ head, atMs: now() }));
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
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    const head = await resolvePublishedKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId,
      kaUal: row.kaUal,
      queryOptions: {
        source: 'agent.rfc64.finalizedRowHeal.workspaceHead',
        priority: 'background',
        ...(signal === undefined ? {} : { signal }),
      },
    });
    return head === undefined;
  } catch (error) {
    // A torn head is not a retired copy; the finalized twin's own step removes such heads.
    if (error instanceof KnowledgeAssetWorkspaceHeadCorruptError) return false;
    throw error;
  }
}
