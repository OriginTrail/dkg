// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import * as core from '@origintrail-official/dkg-core';
import * as decisions from '../src/internal/finalized-placement-decision.js';
import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { AuthorCatalogFullErrorV1 } from '../src/internal/author-catalog-capacity.js';
import { createRfc64FinalizedPrivatePlacementRepairStoreV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import { openInventoryV1 } from '../src/rfc64/inventory-v1/index.js';
import { backlogV1, scopeBaseV1, v2MarkerV1 } from './support/parked-private-backlog-fixture.js';

it('does no per-marker encoding, decision or scope hashing on unchanged real-store warm passes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parked-warm-work-'));
  let inventory: Awaited<ReturnType<typeof openInventoryV1>> | undefined;
  let owner: Rfc64SwmCatalogProjectionOwnerV1 | undefined;
  try {
    inventory = await openInventoryV1(root);
    const filling = createRfc64FinalizedPrivatePlacementRepairStoreV1(inventory);
    const markers = backlogV1(96);
    expect(markers.some((marker) => marker.version === 2)).toBe(true);
    for (const marker of markers) await filling.put(marker);
    inventory.close();
    inventory = await openInventoryV1(root);
    const store = createRfc64FinalizedPrivatePlacementRepairStoreV1(inventory);
    const place = vi.fn(async () => {
      throw new AuthorCatalogFullErrorV1(Array.from({ length: 1024 }, (_v, index) => ({
        seal: { kaUal: `held-${index}` },
      })), 1);
    });
    owner = new Rfc64SwmCatalogProjectionOwnerV1({
      resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }) as never,
      listDurableInventoryScopes: () => [], listLocalAuthorAddresses: () => [], acceptsPublicRootLane: () => true,
      readFinalizedPlacementAuthority: (graph) => ({ status: 'active', lane: {
        kind: 'private', acceptsFinalizedVmRepair: true, scopeBase: scopeBaseV1(graph as core.ContextGraphIdV1),
      } }),
      readRepairRevision: () => null,
      listFinalizedPrivateRepairs: () => store.list(),
      listFinalizedPrivateRepairsAsync: (signal) => store.listAsync(signal),
      readPrivateFailure: (repair) => store.readFailure(repair),
      writePrivateFailures: (entries) => store.writeFailures(entries),
      repairFinalizedPrivatePlacement: place,
      readAppliedCatalogHead: () => ({ inventoryRowCount: '1024' }) as never,
      reconcile: async () => null, warn: () => {},
    });
    const pass = async () => { owner!.start(core.createOperationContext('system')); await owner!.whenIdle(); };
    // Call-through spies observe actual validation and hashing, never substitute their results.
    const work = [
      vi.spyOn(core, 'assertSwmAuthorInventoryScopeV1'),
      vi.spyOn(core, 'canonicalizeCanonicalGraphScopedAuthorSealV1'),
      vi.spyOn(core, 'computeSwmAuthorInventoryScopeDigestV1'),
      vi.spyOn(core, 'computeAuthorCatalogScopeDigestV1'),
      vi.spyOn(decisions, 'resolveFinalizedPlacementAdmissionDecisionV1'),
    ];
    await pass(); // Cold reopened SQLite rows must still validate and decide.
    for (const spy of work) expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(place).toHaveBeenCalledOnce();
    for (let repeat = 0; repeat < 3; repeat += 1) {
      for (const spy of work) spy.mockClear();
      await pass();
      for (const spy of work) expect(spy).not.toHaveBeenCalled();
      expect(owner.status()?.authorCatalogCapacity).toEqual({ parkedPlacements: 96, scopesAtCap: 1 });
      expect(owner.status()?.finalizedPrivatePlacement).toMatchObject({ pending: 96, waiters: 0 });
      expect(place).toHaveBeenCalledOnce();
    }
    // A newly durable V2 row must miss these caches and be checked, then stay parked too.
    await store.put(v2MarkerV1(10_000));
    for (const spy of work) spy.mockClear();
    await pass();
    expect(work[1]).toHaveBeenCalled();
    expect(work[4]).toHaveBeenCalledOnce();
    expect(store.list()).toHaveLength(97);
    expect(owner.status()?.authorCatalogCapacity).toEqual({ parkedPlacements: 97, scopesAtCap: 1 });
    expect(place).toHaveBeenCalledOnce();
  } finally {
    await owner?.close();
    inventory?.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
