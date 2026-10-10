/**
 * GH#3134 — what the catalog supervisor does about an author catalog at its row cap, through the
 * real supervisor owner over a model of the catalogs.
 *
 * The at-cap state is built at the real cap without one placement: a modelled catalog is the set
 * of assets it holds, filled with 1,024 synthetic UALs, and its applied-head row reports that
 * count. A placement of an asset it holds commits a new head; a placement of any other asset is
 * refused with the typed error the real upsert raises, carrying what the catalog holds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  computeAuthorCatalogScopeDigestV1,
  createOperationContext,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

import { Rfc64SwmCatalogProjectionOwnerV1 } from '../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { AuthorCatalogFullErrorV1 } from '../src/internal/author-catalog-capacity.js';
import {
  FULL_CATALOG_RECHECK_INTERVAL_MS_V1,
  FullCatalogParkingV1,
} from '../src/internal/full-catalog-parking.js';
import type { CatalogRepairRevisionHintV1 } from '../src/rfc64/catalog-repair-retry-v1.js';
import { Rfc64SwmInventoryCatalogReconcilerErrorV1 } from '../src/rfc64/swm-inventory-catalog-reconciler-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from '../src/rfc64/finalized-private-placement-repair-store-v1.js';

const CAP = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1;
const HOUR = FULL_CATALOG_RECHECK_INTERVAL_MS_V1;
const FULL_GRAPH = 'full-catalog' as ContextGraphIdV1;
const OTHER_GRAPH = 'other-catalog' as ContextGraphIdV1;
const AUTHOR = `0x${'11'.repeat(20)}` as EvmAddressV1;
const ctx = createOperationContext('system');
const owners: Rfc64SwmCatalogProjectionOwnerV1[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  vi.useRealTimers();
});

type Marker = Rfc64FinalizedPrivatePlacementRepairV1;

function marker(contextGraphId: ContextGraphIdV1, kaNumber: number, assertionVersion = '1'): Marker {
  return {
    version: 1, contextGraphId, authorAddress: AUTHOR,
    inventoryScope: {
      networkId: 'otp:20430', contextGraphId, governanceChainId: null,
      governanceContractAddress: null, ownershipTransitionDigest: null,
      authorAddress: AUTHOR, subGraphName: null, era: '1',
    },
    assertionCoordinate: `asset-${kaNumber}`, assertionVersion,
    kaUal: ual(kaNumber), sealDigest: `0x${kaNumber.toString(16).padStart(64, '0')}`,
  } as Marker;
}

function ual(kaNumber: number): string {
  return `did:dkg:otp:20430/${AUTHOR}/${kaNumber}`;
}

/** The rows of a catalog at its cap: assets 1..CAP. */
function fullRows(): { seal: { kaUal: string } }[] {
  return Array.from({ length: CAP }, (_value, index) => ({ seal: { kaUal: ual(index + 1) } }));
}

function scopeDigest(repair: Marker): string {
  return computeAuthorCatalogScopeDigestV1({ ...repair.inventoryScope, bucketCount: '1' } as AuthorCatalogScopeV1);
}

/** The catalogs and durable markers of one node. They outlive a supervisor, as a restart needs. */
function node() {
  const catalogs = new Map<string, { version: number; held: Set<string> }>();
  const state = { markers: [] as Marker[], failing: new Set<string>(), attempts: [] as string[] };
  const catalogOf = (repair: Marker) => {
    const digest = scopeDigest(repair);
    let catalog = catalogs.get(digest);
    if (catalog === undefined) {
      catalog = { version: 0, held: new Set() };
      catalogs.set(digest, catalog);
    }
    return catalog;
  };
  return {
    state,
    /** Fill `repair`'s catalog to the cap with assets 1..CAP. */
    fill(repair: Marker) {
      const catalog = catalogOf(repair);
      for (let kaNumber = 1; kaNumber <= CAP; kaNumber++) catalog.held.add(ual(kaNumber));
      catalog.version += 1;
    },
    /** Remove one row, as a removal by the exact-set path would, and commit the new head. */
    free(repair: Marker, kaNumber: number) {
      const catalog = catalogOf(repair);
      expect(catalog.held.delete(ual(kaNumber))).toBe(true);
      catalog.version += 1;
    },
    rows: (repair: Marker) => catalogOf(repair).held.size,
    readAppliedCatalogHead: vi.fn((digest: string) => {
      const catalog = catalogs.get(digest);
      return catalog === undefined || catalog.version === 0 ? null : {
        currentCatalogHeadDigest: `head-${catalog.version}`,
        inventoryRowCount: String(catalog.held.size),
      };
    }),
    /** The repair body: the coverage check, then the upsert's rule for a new or a held asset. */
    place: vi.fn(async (repair: Readonly<Marker>): Promise<void> => {
      state.attempts.push(repair.kaUal);
      if (state.failing.has(repair.kaUal)) throw new Error('another failure');
      const catalog = catalogOf(repair);
      if (!catalog.held.has(repair.kaUal)) {
        if (catalog.held.size >= CAP) {
          throw new AuthorCatalogFullErrorV1(
            [...catalog.held].map((kaUal) => ({ seal: { kaUal } })),
            1,
            `head-${catalog.version}`,
          );
        }
        catalog.held.add(repair.kaUal);
      }
      catalog.version += 1;
      state.markers = state.markers.filter((candidate) => candidate.kaUal !== repair.kaUal
        || candidate.contextGraphId !== repair.contextGraphId);
    }),
  };
}

function supervisor(model: ReturnType<typeof node>, options: { readHead?: boolean } = {}) {
  let revision: CatalogRepairRevisionHintV1 = { scopeIdentity: 'scope', headRevision: 'inventory-1' };
  const warn = vi.fn();
  const reconcile = vi.fn(async (): Promise<null> => null);
  const owner = new Rfc64SwmCatalogProjectionOwnerV1({
    resolvePartition: () => ({ retryIntervalMs: 5_000, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }) as never,
    listLocalAuthorAddresses: () => [AUTHOR],
    acceptsPublicRootLane: () => true,
    acceptsFinalizedPrivateLane: () => true,
    readRepairRevision: () => revision,
    listFinalizedPrivateRepairs: () => model.state.markers,
    repairFinalizedPrivatePlacement: model.place,
    reconcile,
    ...(options.readHead === false ? {} : { readAppliedCatalogHead: model.readAppliedCatalogHead as never }),
    warn,
  });
  owners.push(owner);
  const lines = (event: string) => warn.mock.calls
    .map(([, message]) => JSON.parse(String(message)) as Record<string, unknown>)
    .filter((line) => line.event === event);
  return {
    owner, warn, reconcile, lines,
    capacity: () => owner.status()?.authorCatalogCapacity,
    /** One supervisor pass now, as a start or a new marker asks for. */
    pass: async () => { owner.start(ctx); await owner.whenIdle(); },
    advance: async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await owner.whenIdle(); },
    shareTimeRequest: () => owner.request({ contextGraphId: FULL_GRAPH, authorAddress: AUTHOR, ctx }),
    setInventoryHead: (head: string) => { revision = { scopeIdentity: 'scope', headRevision: head }; },
  };
}

const NEW_A = marker(FULL_GRAPH, CAP + 1);
const NEW_B = marker(FULL_GRAPH, CAP + 2);
const NEW_C = marker(FULL_GRAPH, CAP + 3);

describe('finalized-private placements of a full author catalog', () => {
  it('parks a refused placement: no further attempt for hours, but one a scope at the safety-net interval', async () => {
    const model = node();
    model.fill(NEW_A);
    const failingElsewhere = marker(OTHER_GRAPH, 7);
    const placedElsewhere = marker(OTHER_GRAPH, 8);
    model.state.failing.add(failingElsewhere.kaUal);
    model.state.markers = [NEW_A, failingElsewhere, NEW_B, placedElsewhere];
    const s = supervisor(model);

    await s.pass();

    // One real attempt for the full scope; its second marker is parked on what that attempt
    // found. The other scope's markers are attempted in turn within the same pass.
    expect(model.state.attempts).toEqual([NEW_A.kaUal, failingElsewhere.kaUal, placedElsewhere.kaUal]);
    expect(model.state.markers).toEqual([NEW_A, failingElsewhere, NEW_B]);
    expect(s.capacity()).toEqual({ parkedPlacements: 2, scopesAtCap: 1 });

    const fullScopeAttempts = () => model.state.attempts
      .filter((kaUal) => kaUal === NEW_A.kaUal || kaUal === NEW_B.kaUal);
    const headReadsBefore = model.readAppliedCatalogHead.mock.calls.length;
    await s.advance(HOUR - 5_000);
    // Hundreds of passes: the other scope's failing marker kept its ordinary back-off ...
    expect(model.state.attempts.filter((kaUal) => kaUal === failingElsewhere.kaUal).length).toBeGreaterThan(50);
    // ... and the two parked markers cost each of the 719 passes one applied-head row read for
    // their scope, and nothing else.
    expect(fullScopeAttempts()).toEqual([NEW_A.kaUal]);
    expect(model.readAppliedCatalogHead.mock.calls.length).toBe(headReadsBefore + 719);

    await s.advance(5_000);
    // The safety net: one attempt for the scope, by one marker; the other stays parked.
    expect(fullScopeAttempts()).toEqual([NEW_A.kaUal, NEW_A.kaUal]);
    await s.advance(HOUR - 5_000);
    expect(fullScopeAttempts()).toHaveLength(2);
    await s.advance(5_000);
    expect(fullScopeAttempts()).toEqual([NEW_A.kaUal, NEW_A.kaUal, NEW_B.kaUal]);
    expect(model.state.markers).toContain(NEW_A);
    expect(model.state.markers).toContain(NEW_B);
    expect(s.capacity()).toEqual({ parkedPlacements: 2, scopesAtCap: 1 });
  });

  it('gives the safety-net attempt to the next parked placement each interval, in turn', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A, NEW_B, NEW_C];
    const s = supervisor(model);
    await s.pass();
    expect(model.state.attempts).toEqual([NEW_A.kaUal]);

    for (const expected of [NEW_A, NEW_B, NEW_C]) {
      model.state.attempts.length = 0;
      await s.advance(HOUR);
      expect(model.state.attempts).toEqual([expected.kaUal]);
    }
    // Every marker had its turn: the next one starts over, a pass after the interval.
    model.state.attempts.length = 0;
    await s.advance(HOUR);
    expect(model.state.attempts).toEqual([]);
    await s.advance(5_000);
    expect(model.state.attempts).toEqual([NEW_A.kaUal]);
    expect(s.capacity()).toEqual({ parkedPlacements: 3, scopesAtCap: 1 });
  });

  it('does not let a placement that keeps failing for another reason hold the safety net', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A, NEW_B];
    const s = supervisor(model);
    await s.pass();
    expect(model.state.attempts).toEqual([NEW_A.kaUal]);

    // From now on the first marker fails before the catalog is asked, as an unresolvable asset does.
    model.state.failing.add(NEW_A.kaUal);
    model.state.attempts.length = 0;
    await s.advance(HOUR);
    expect(model.state.attempts).toEqual([NEW_A.kaUal]);
    expect(s.lines('catalog_private_repair_failed')).toHaveLength(1);
    // It is parked again on what the catalog was last found to hold, not retried on the timer ...
    await s.advance(HOUR - 5_000);
    expect(model.state.attempts).toEqual([NEW_A.kaUal]);
    // ... and the next interval's attempt goes to the other marker, whose refusal is a fresh read.
    await s.advance(5_000);
    expect(model.state.attempts).toEqual([NEW_A.kaUal, NEW_B.kaUal]);
    expect(s.capacity()).toEqual({ parkedPlacements: 2, scopesAtCap: 1 });
  });

  it('names the graph and author once when the scope first refuses, then at most once an hour', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A, NEW_B];
    const s = supervisor(model);

    await s.pass();
    expect(s.lines('catalog_full')).toEqual([{
      event: 'catalog_full',
      contextGraphId: FULL_GRAPH,
      authorAddress: AUTHOR,
      refused: 'placement',
      rows: CAP,
      rowCap: CAP,
      parkedPlacements: 2,
    }]);
    // The refusal is not also written as an ordinary repair failure.
    expect(s.lines('catalog_private_repair_failed')).toEqual([]);

    await s.advance(HOUR - 5_000);
    expect(s.lines('catalog_full')).toHaveLength(1);
    model.state.markers = [...model.state.markers, NEW_C];
    await s.advance(5_000);
    expect(s.lines('catalog_full')).toHaveLength(2);
    expect(s.lines('catalog_full')[1]).toMatchObject({ parkedPlacements: 3 });
    await s.advance(HOUR - 5_000);
    expect(s.lines('catalog_full')).toHaveLength(2);
  });

  it('still places a newer version of an asset the full catalog holds', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A, NEW_B];
    const s = supervisor(model);
    await s.pass();
    expect(model.state.attempts).toEqual([NEW_A.kaUal]);

    const newerVersion = marker(FULL_GRAPH, 5, '2');
    model.state.markers = [...model.state.markers, newerVersion];
    await s.pass();

    expect(model.state.attempts).toEqual([NEW_A.kaUal, newerVersion.kaUal]);
    expect(model.state.markers).toEqual([NEW_A, NEW_B]);
    expect(model.rows(NEW_A)).toBe(CAP);
    // The replacement committed a new head with the same rows: what was parked stays parked.
    await s.advance(60_000);
    expect(model.state.attempts).toEqual([NEW_A.kaUal, newerVersion.kaUal]);
    expect(s.capacity()).toEqual({ parkedPlacements: 2, scopesAtCap: 1 });

    // A marker that was never parked is not taken on a word read under an earlier head: it gets
    // its own attempt, and the one after it is parked on that fresh refusal.
    const afterReplacement = marker(FULL_GRAPH, CAP + 4);
    const afterThat = marker(FULL_GRAPH, CAP + 5);
    model.state.markers = [...model.state.markers, afterReplacement, afterThat];
    await s.pass();
    expect(model.state.attempts).toEqual([NEW_A.kaUal, newerVersion.kaUal, afterReplacement.kaUal]);
    expect(s.capacity()).toEqual({ parkedPlacements: 4, scopesAtCap: 1 });
  });

  it('attempts parked placements again once the applied head shows a free row', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A, NEW_B, NEW_C];
    const s = supervisor(model);
    await s.pass();
    expect(model.state.attempts).toEqual([NEW_A.kaUal]);

    model.free(NEW_A, 9);
    expect(s.capacity()).toEqual({ parkedPlacements: 0, scopesAtCap: 0 });
    await s.advance(5_000);

    // The first parked placement takes the free row; the second is refused afresh, and the third
    // is parked on that refusal without an attempt.
    expect(model.state.attempts).toEqual([NEW_A.kaUal, NEW_A.kaUal, NEW_B.kaUal]);
    expect(model.state.markers).toEqual([NEW_B, NEW_C]);
    expect(model.rows(NEW_A)).toBe(CAP);
    expect(s.capacity()).toEqual({ parkedPlacements: 2, scopesAtCap: 1 });
    await s.advance(60_000);
    expect(model.state.attempts).toHaveLength(3);
  });

  it('keeps placements parked across a restart: one attempt a full catalog, not one a marker', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A, NEW_B, NEW_C];
    const before = supervisor(model);
    await before.pass();
    expect(before.capacity()).toEqual({ parkedPlacements: 3, scopesAtCap: 1 });
    await before.owner.close();
    model.state.attempts.length = 0;

    const after = supervisor(model);
    await after.pass();

    expect(model.state.attempts).toEqual([NEW_A.kaUal]);
    expect(model.state.markers).toEqual([NEW_A, NEW_B, NEW_C]);
    expect(after.capacity()).toEqual({ parkedPlacements: 3, scopesAtCap: 1 });
    expect(after.lines('catalog_full')).toEqual([expect.objectContaining({ parkedPlacements: 3 })]);
    await after.advance(HOUR - 5_000);
    expect(model.state.attempts).toEqual([NEW_A.kaUal]);
  });

  it('releases a request for a parked placement without an attempt', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A, NEW_B];
    const s = supervisor(model);
    await s.pass();

    const request = s.owner.requestFinalizedPrivate({ repair: NEW_B, ctx });
    expect(request.accepted).toBe(true);
    await request.whenAttempted;
    await s.owner.whenIdle();

    expect(model.state.attempts).toEqual([NEW_A.kaUal]);
    expect(s.owner.status()?.finalizedPrivatePlacement).toMatchObject({ waiters: 0 });
  });

  it('without an applied-head reader parks only on a refusal of its own and frees by the interval', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A, NEW_B];
    const s = supervisor(model, { readHead: false });
    await s.pass();

    // No head to hold the first refusal's word against: the second marker gets its own attempt.
    expect(model.state.attempts).toEqual([NEW_A.kaUal, NEW_B.kaUal]);
    expect(s.capacity()).toEqual({ parkedPlacements: 2, scopesAtCap: 1 });
    model.free(NEW_A, 9);
    await s.advance(HOUR - 5_000);
    expect(model.state.attempts).toHaveLength(2);
    await s.advance(5_000);
    expect(model.state.attempts).toEqual([NEW_A.kaUal, NEW_B.kaUal, NEW_A.kaUal]);
    expect(model.state.markers).toEqual([NEW_B]);
  });
});

describe('share-time projection of a full author catalog', () => {
  const refusals = [
    ['the catalog has no row for a new asset', () => new AuthorCatalogFullErrorV1(fullRows(), 1), CAP],
    ['the inventory to project is larger than a catalog', () => new Rfc64SwmInventoryCatalogReconcilerErrorV1(
      'swm-catalog-reconcile-capacity', 'bounded catalog target exceeds its rows',
    ), null],
  ] as const;

  it.each(refusals)('is not retried on the failure timer when %s', async (_label, refusal, rows) => {
    const model = node();
    const s = supervisor(model);
    s.reconcile.mockImplementation(async () => { throw refusal(); });

    s.shareTimeRequest();
    await s.owner.whenIdle();
    expect(s.reconcile).toHaveBeenCalledTimes(1);
    expect(s.owner.status()?.repairs).toEqual([expect.objectContaining({
      outcome: 'failed',
      diagnostic: expect.objectContaining({ kind: 'catalog_full' }),
      nextAttemptAtMs: HOUR,
    })]);
    expect(s.capacity()).toEqual({ parkedPlacements: 0, scopesAtCap: 1 });
    expect(s.lines('catalog_full')).toEqual([{
      event: 'catalog_full', contextGraphId: FULL_GRAPH, authorAddress: AUTHOR,
      refused: 'projection', rows, rowCap: CAP, parkedPlacements: 0,
    }]);
    expect(s.lines('catalog_repair_failed')).toEqual([]);

    await s.advance(HOUR - 5_000);
    expect(s.reconcile).toHaveBeenCalledTimes(1);

    // A change of the author's inventory may be a removal or a newer version: one attempt each.
    s.setInventoryHead('inventory-2');
    s.shareTimeRequest();
    await s.owner.whenIdle();
    expect(s.reconcile).toHaveBeenCalledTimes(2);
    expect(s.lines('catalog_full')).toHaveLength(1);

    await s.advance(HOUR - 5_000);
    expect(s.reconcile).toHaveBeenCalledTimes(2);
    await s.advance(5_000);
    expect(s.reconcile).toHaveBeenCalledTimes(3);
    expect(s.lines('catalog_full')).toHaveLength(2);
  });

  it('counts a scope once when both of its paths are refused, and drops it when the projection succeeds', async () => {
    const model = node();
    model.fill(NEW_A);
    model.state.markers = [NEW_A];
    const s = supervisor(model);
    s.reconcile.mockImplementation(async () => { throw new AuthorCatalogFullErrorV1(fullRows(), 1); });
    await s.pass();
    s.shareTimeRequest();
    await s.owner.whenIdle();

    expect(s.capacity()).toEqual({ parkedPlacements: 1, scopesAtCap: 1 });
    // The scope was named for its placement a moment ago: the projection adds no second line.
    expect(s.lines('catalog_full')).toEqual([expect.objectContaining({ refused: 'placement' })]);

    model.state.markers = [];
    model.free(NEW_A, 9);
    s.reconcile.mockImplementation(async () => null);
    s.setInventoryHead('inventory-2');
    s.shareTimeRequest();
    await s.advance(5_000);
    expect(s.capacity()).toEqual({ parkedPlacements: 0, scopesAtCap: 0 });
  });
});

describe('full catalog parking', () => {
  function parking(readAppliedCatalogHead?: () => { currentCatalogHeadDigest: string; inventoryRowCount: string } | null) {
    const clock = { now: 0 };
    const warn = vi.fn();
    const parkingV1 = new FullCatalogParkingV1(
      { warn, ...(readAppliedCatalogHead === undefined ? {} : { readAppliedCatalogHead }) },
      () => clock.now,
    );
    return { parking: parkingV1, clock, warn };
  }
  const refusal = () => new AuthorCatalogFullErrorV1(fullRows(), 1, 'head-1');
  const atCap = () => ({ currentCatalogHeadDigest: 'head-1', inventoryRowCount: String(CAP) });

  it('leaves any other failure to the ordinary handling', () => {
    const { parking: p } = parking(atCap);
    expect(p.placementRefused('a', NEW_A, new Error('store timeout'))).toBe(false);
    expect(p.projectionRefused(NEW_A, new Error('store timeout'))).toBe(false);
    expect(p.parked('a', NEW_A)).toBe(false);
    expect(p.status([])).toEqual({ parkedPlacements: 0, scopesAtCap: 0 });
  });

  it('finds the refusal behind a wrapping error', () => {
    const { parking: p } = parking(atCap);
    const wrapped = new Error('repair failed', { cause: new Error('mutation failed', { cause: refusal() }) });
    expect(p.placementRefused('a', NEW_A, wrapped)).toBe(true);
    expect(p.parked('b', NEW_B)).toBe(true);
  });

  it.each([
    ['throws', () => { throw new Error('inventory database is closed'); }],
    ['has no store to read', () => undefined],
  ])('keeps what is parked when the applied-head reader %s', (_label, unreadable) => {
    const read = vi.fn<() => ReturnType<typeof atCap> | undefined>(atCap);
    const { parking: p } = parking(read as never);
    expect(p.placementRefused('a', NEW_A, refusal())).toBe(true);
    read.mockImplementation(unreadable);
    expect(p.parked('a', NEW_A)).toBe(true);
    // A marker it never parked is not taken on a head it cannot read.
    expect(p.parked('b', NEW_B)).toBe(false);
    expect(p.status([])).toEqual({ parkedPlacements: 1, scopesAtCap: 1 });
  });

  it('attempts every marker of a scope whose catalog is gone, from the next pass on', () => {
    const read = vi.fn<() => ReturnType<typeof atCap> | null>(atCap);
    const { parking: p } = parking(read);
    p.placementRefused('a', NEW_A, refusal());
    expect(p.parked('b', NEW_B)).toBe(true);
    read.mockReturnValue(null);
    // Status reads the head now; a pass keeps the one it read for the scope until it ends.
    expect(p.status([])).toEqual({ parkedPlacements: 0, scopesAtCap: 0 });
    expect(p.parked('a', NEW_A)).toBe(true);
    p.passStarted(new Set(['a', 'b']));
    expect(p.parked('a', NEW_A)).toBe(false);
    expect(p.parked('b', NEW_B)).toBe(false);
  });

  it('reads one applied-head row a scope a pass for what is parked, however many markers', () => {
    const read = vi.fn(atCap);
    const { parking: p } = parking(read);
    p.placementRefused('a', NEW_A, refusal());
    const markers = Array.from({ length: 50 }, (_value, index) => marker(FULL_GRAPH, CAP + 10 + index));
    const keys = new Set(['a', ...markers.map((_marker, index) => `m${index}`)]);

    // The pass that first sees them holds each against the head as it is now: one read each.
    p.passStarted(keys);
    read.mockClear();
    expect(p.parked('a', NEW_A)).toBe(true);
    for (const [index, parked] of markers.entries()) expect(p.parked(`m${index}`, parked)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1 + markers.length);

    // Every later pass reads the scope's row once.
    for (let pass = 0; pass < 3; pass++) {
      p.passStarted(keys);
      read.mockClear();
      expect(p.parked('a', NEW_A)).toBe(true);
      for (const [index, parked] of markers.entries()) expect(p.parked(`m${index}`, parked)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
    }
    expect(p.status([])).toEqual({ parkedPlacements: 51, scopesAtCap: 1 });
  });

  it('does not park a marker whose scope it cannot name', () => {
    const { parking: p } = parking(atCap);
    const unnamed = { ...NEW_A, inventoryScope: { ...NEW_A.inventoryScope, era: 'not-an-era' } } as never;
    expect(p.placementRefused('a', unnamed, refusal())).toBe(false);
    expect(p.status([])).toEqual({ parkedPlacements: 0, scopesAtCap: 0 });
  });

  it('forgets a marker that left the queue, and a scope with nothing parked after its interval', () => {
    const { parking: p, clock } = parking(atCap);
    p.placementRefused('a', NEW_A, refusal());
    p.passStarted(new Set(['a']));
    expect(p.status([])).toEqual({ parkedPlacements: 1, scopesAtCap: 1 });

    p.passStarted(new Set());
    expect(p.status([])).toEqual({ parkedPlacements: 0, scopesAtCap: 1 });
    // Within the interval a new marker of the scope is still parked on what the refusal found.
    expect(p.parked('b', NEW_B)).toBe(true);
    p.passStarted(new Set());
    clock.now = HOUR;
    p.passStarted(new Set());
    expect(p.status([])).toEqual({ parkedPlacements: 0, scopesAtCap: 0 });
    expect(p.parked('b', NEW_B)).toBe(false);
  });

  it('survives a log sink that throws', () => {
    const { parking: p, warn } = parking(atCap);
    warn.mockImplementation(() => { throw new Error('log sink closed'); });
    p.placementRefused('a', NEW_A, refusal());
    expect(() => p.passEnded()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(p.parked('a', NEW_A)).toBe(true);
  });
});
