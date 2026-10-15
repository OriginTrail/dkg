/**
 * GH#3134 — the sweep of an author's SWM inventory removes only rows whose asset is finalized at
 * or above the row's version and whose shared-memory head is gone, and counts a head as swept only
 * once it examined every row of it.
 */
import {
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventorySnapshotV1,
} from '@origintrail-official/dkg-core';
import {
  generateGraphKnowledgeAssetMetadata,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { describe, expect, it } from 'vitest';

import {
  FINALIZED_ROW_RESWEEP_INTERVAL_MS_V1,
  finalizedRowHealCountsV1,
  healFinalizedSwmInventoryRowsV1,
} from '../src/internal/finalized-row-heal.js';

const AUTHOR = `0x${'1a'.repeat(20)}` as EvmAddressV1;
const CONTEXT_GRAPH_ID = `${AUTHOR}/finalized-row-heal` as ContextGraphIdV1;
const QUADS: readonly Quad[] = [{
  subject: 'https://example.org/asset',
  predicate: 'https://schema.org/name',
  object: '"Asset"',
  graph: '',
}];

describe('the sweep of rows of finalized assets (GH#3134)', () => {
  it('removes a finalized row whose shared-memory head is gone, and keeps the rows its guards protect', async () => {
    const store = new OxigraphStore();
    const retired = row(1n, '1');
    await finalize(store, retired, '1');
    const live = row(2n, '1');
    await finalize(store, live, '1');
    await shareCopy(store, live);
    const newer = row(3n, '2');
    await finalize(store, newer, '1');
    const unfinalized = row(4n, '1');
    const inventory = fakeInventory([retired, live, newer, unfinalized]);

    await expect(healFinalizedSwmInventoryRowsV1(inventory, sweep(store, inventory))).resolves.toBe(1);
    expect(inventory.removed).toEqual([retired.kaUal]);
    expect(inventory.current.rows).toEqual([live, newer, unfinalized]);
    expect(finalizedRowHealCountsV1(inventory)).toEqual({ finalizedRowHealPasses: 1, finalizedRowsHealed: 1 });
  });

  it('examines rows that another commit adds while it waits on a removal before it counts their head as swept', async () => {
    const store = new OxigraphStore();
    const first = row(1n, '1');
    const added = row(2n, '1');
    await finalize(store, first, '1');
    await finalize(store, added, '1');
    const inventory = fakeInventory([first]);
    let release!: () => void;
    inventory.holdRemoval(first.kaUal, new Promise<void>((resolve) => { release = resolve; }), () => {
      // Another observer commits a row while the sweep waits on the first removal.
      inventory.commit([...inventory.current.rows, added]);
      release();
    });

    await expect(healFinalizedSwmInventoryRowsV1(inventory, sweep(store, inventory))).resolves.toBe(2);
    expect(inventory.removed).toEqual([first.kaUal, added.kaUal]);
    expect(inventory.current.rows).toEqual([]);

    // Every head it left behind was examined, so the next failure on it has nothing to sweep.
    await expect(healFinalizedSwmInventoryRowsV1(inventory, sweep(store, inventory))).resolves.toBe(0);
    expect(finalizedRowHealCountsV1(inventory)).toEqual({ finalizedRowHealPasses: 1, finalizedRowsHealed: 2 });
  });

  it('sweeps an unchanged head again a minute later, once its asset has been finalized meanwhile', async () => {
    const store = new OxigraphStore();
    // The shared copy is gone, and the asset has no verified copy yet.
    const waiting = row(1n, '1');
    const inventory = fakeInventory([waiting]);
    let clock = 1_000_000;
    const at = { now: () => clock };

    await expect(healFinalizedSwmInventoryRowsV1(inventory, { ...sweep(store, inventory), ...at })).resolves.toBe(0);
    expect(inventory.current.rows).toEqual([waiting]);
    // Its verified copy arrives; the inventory does not change.
    await finalize(store, waiting, '1');
    clock += FINALIZED_ROW_RESWEEP_INTERVAL_MS_V1 - 1;
    await expect(healFinalizedSwmInventoryRowsV1(inventory, { ...sweep(store, inventory), ...at })).resolves.toBe(0);
    expect(inventory.current.rows).toEqual([waiting]);
    clock += 1;
    await expect(healFinalizedSwmInventoryRowsV1(inventory, { ...sweep(store, inventory), ...at })).resolves.toBe(1);
    expect(inventory.current.rows).toEqual([]);
    expect(finalizedRowHealCountsV1(inventory)).toEqual({ finalizedRowHealPasses: 2, finalizedRowsHealed: 1 });
  });

  it('tries a removal that failed again at the next sweep of the same head', async () => {
    const store = new OxigraphStore();
    const stale = row(1n, '1');
    await finalize(store, stale, '1');
    const inventory = fakeInventory([stale]);
    // The author's signer is briefly unavailable.
    inventory.failNextRemoval(stale.kaUal);

    await expect(healFinalizedSwmInventoryRowsV1(inventory, sweep(store, inventory))).resolves.toBe(0);
    expect(inventory.current.rows).toEqual([stale]);
    // It is back: the unchanged head is swept again, and the row goes.
    await expect(healFinalizedSwmInventoryRowsV1(inventory, sweep(store, inventory))).resolves.toBe(1);
    expect(inventory.current.rows).toEqual([]);
    expect(finalizedRowHealCountsV1(inventory)).toEqual({ finalizedRowHealPasses: 2, finalizedRowsHealed: 1 });
  });
});

function row(kaNumber: bigint, assertionVersion: string): SwmAuthorInventoryRowV1 {
  return Object.freeze({
    assertionCoordinate: `asset-${kaNumber}`,
    assertionVersion,
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${kaNumber}`,
    shareOperationId: `share-${kaNumber}-${assertionVersion}`,
    sealDigest: `0x${kaNumber.toString(16).padStart(64, '0')}`,
  }) as unknown as SwmAuthorInventoryRowV1;
}

/** The asset's confirmed VM metadata at `version`, as a finalization stores it. */
async function finalize(store: OxigraphStore, asset: SwmAuthorInventoryRowV1, version: string): Promise<void> {
  const vmGraph = knowledgeAssetLayerGraphUri(
    CONTEXT_GRAPH_ID,
    MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(asset.kaUal, version),
  );
  await store.insert([
    ...QUADS.map((quad) => ({ ...quad, graph: vmGraph })),
    ...generateGraphKnowledgeAssetMetadata({
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: asset.kaUal,
      merkleRoot: new Uint8Array(32).fill(7),
      publisherPeerId: 'curator-publisher',
      accessPolicy: 'public',
      allowedPeers: [],
      timestamp: new Date('2026-10-15T10:00:00.000Z'),
      assertionVersion: version,
      authorAddress: AUTHOR,
      publicTripleCount: QUADS.length,
      privateTripleCount: 0,
      assertionGraph: vmGraph,
    }, {
      status: 'confirmed',
      confirmation: {
        kind: 'finalized-materialization',
        provenance: { batchId: 1n, materializedVersion: { blockNumber: 124, txIndex: 0 } },
      },
    }),
  ]);
}

/** The asset's live shared-memory copy at its row's version. */
async function shareCopy(store: OxigraphStore, asset: SwmAuthorInventoryRowV1): Promise<void> {
  const graphManager = new GraphManager(store);
  await storeKnowledgeAssetOperationPublicQuads({
    store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    shareOperationId: asset.shareOperationId,
    kaUal: asset.kaUal,
    assertionVersion: asset.assertionVersion,
    quads: QUADS,
    privateTripleCount: 0,
    publisherPeerId: 'member-peer',
    accessPolicy: 'public',
    agentAddress: AUTHOR,
    timestamp: new Date('2026-10-15T09:00:00.000Z'),
  });
  await storeKnowledgeAssetWorkspaceHead({
    store,
    graphManager,
    contextGraphId: CONTEXT_GRAPH_ID,
    kaUal: asset.kaUal,
    assertionVersion: asset.assertionVersion,
    shareOperationId: asset.shareOperationId,
  });
}

/** An author's inventory whose head moves with every commit, and whose removals can be held. */
function fakeInventory(rows: readonly SwmAuthorInventoryRowV1[]) {
  let heads = 0;
  const held = new Map<string, Readonly<{ until: Promise<void>; meanwhile: () => void }>>();
  const failing = new Set<string>();
  const inventory = {
    current: snapshotOf(rows, heads),
    removed: [] as string[],
    commit(next: readonly SwmAuthorInventoryRowV1[]) {
      heads += 1;
      inventory.current = snapshotOf(next, heads);
    },
    holdRemoval(kaUal: string, until: Promise<void>, meanwhile: () => void) {
      held.set(kaUal, { until, meanwhile });
    },
    failNextRemoval(kaUal: string) {
      failing.add(kaUal);
    },
    async removeRow(target: Readonly<SwmAuthorInventoryRowV1>): Promise<'applied' | 'absent' | 'failed'> {
      if (failing.delete(target.kaUal)) return 'failed';
      const hold = held.get(target.kaUal);
      if (hold !== undefined) {
        held.delete(target.kaUal);
        hold.meanwhile();
        await hold.until;
      }
      if (!inventory.current.rows.includes(target as SwmAuthorInventoryRowV1)) return 'absent' as const;
      inventory.removed.push(target.kaUal);
      inventory.commit(inventory.current.rows.filter((candidate) => candidate !== target));
      return 'applied' as const;
    },
  };
  return inventory;
}

function snapshotOf(rows: readonly SwmAuthorInventoryRowV1[], head: number): SwmAuthorInventorySnapshotV1 {
  return Object.freeze({
    head: Object.freeze({ objectDigest: `0x${head.toString(16).padStart(64, '0')}` }),
    rows: Object.freeze([...rows]),
  }) as unknown as SwmAuthorInventorySnapshotV1;
}

function sweep(store: OxigraphStore, inventory: ReturnType<typeof fakeInventory>) {
  return {
    store,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: AUTHOR,
    snapshot: inventory.current,
    removeRow: (target: Readonly<SwmAuthorInventoryRowV1>) => inventory.removeRow(target),
    readSnapshot: () => inventory.current,
  };
}
