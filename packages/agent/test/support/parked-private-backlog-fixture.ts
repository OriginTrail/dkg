/**
 * GH#3134 — a backlog of finalized-private placement markers parked on a full author catalog, for
 * the supervisor's pass-cost tests. Markers are the frozen snapshots the repair store lists, in the
 * proportions 3,406 V1 to 128 V2. V2 seals are well formed but unsigned:
 * nothing on the supervisor's path checks an author signature.
 */
import { vi } from 'vitest';
import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  computeAuthorCatalogScopeDigestV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  createOperationContext,
  type AuthorCatalogScopeV1,
  type CanonicalGraphScopedAuthorSealV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

import { Rfc64SwmCatalogProjectionOwnerV1 } from '../../src/dkg-agent-rfc64-swm-catalog-projection-supervisor.js';
import { AuthorCatalogFullErrorV1 } from '../../src/internal/author-catalog-capacity.js';
import type { FinalizedPlacementAuthorityV1 } from '../../src/internal/finalized-placement-decision.js';
import {
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
} from '../../src/rfc64/finalized-private-placement-repair-store-v1.js';
import type { PrivatePlacementFailureStateV1 } from '../../src/rfc64/private-placement-failure-state-v1.js';

export type Marker = Readonly<Rfc64FinalizedPrivatePlacementRepairV1>;

export const BACKLOG_GRAPH = 'parked-private-backlog' as ContextGraphIdV1;
export const BACKLOG_AUTHOR = `0x${'ab'.repeat(20)}` as EvmAddressV1;
export const CATALOG_CAP = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1;
export const ctx = createOperationContext('system');

export function ualV1(kaNumber: number): string {
  return `did:dkg:otp:20430/${BACKLOG_AUTHOR}/${kaNumber}`;
}

export function scopeBaseV1(contextGraphId: ContextGraphIdV1, era = '1') {
  return Object.freeze({
    networkId: 'otp:20430', contextGraphId, governanceChainId: null, governanceContractAddress: null,
    ownershipTransitionDigest: null, subGraphName: null, era,
  });
}

export function v1MarkerV1(kaNumber: number, contextGraphId = BACKLOG_GRAPH, era = '1'): Marker {
  return snapshotRfc64FinalizedPrivatePlacementRepairV1({
    version: 1, contextGraphId, authorAddress: BACKLOG_AUTHOR,
    inventoryScope: { ...scopeBaseV1(contextGraphId, era), authorAddress: BACKLOG_AUTHOR },
    assertionCoordinate: `asset-${kaNumber}`, assertionVersion: '1', kaUal: ualV1(kaNumber),
    sealDigest: `0x${kaNumber.toString(16).padStart(64, '0')}`,
  } as Rfc64FinalizedPrivatePlacementRepairV1);
}

function sealV1(kaNumber: number): CanonicalGraphScopedAuthorSealV1 {
  return {
    assertionMerkleRoot: `0x${'01'.repeat(32)}`, authorAddress: BACKLOG_AUTHOR,
    authorAttestationR: `0x${'02'.repeat(32)}`, authorAttestationVS: `0x${'03'.repeat(32)}`,
    authorSchemeVersion: '1', assertedAtChainId: '20430', assertedAtKav10Address: `0x${'44'.repeat(20)}`,
    reservedKaId: ((BigInt(BACKLOG_AUTHOR) << 96n) | BigInt(kaNumber)).toString(),
    assertionFinalizedAt: '2026-07-19T12:34:56.789Z', contentScopeVersion: '2', kaUal: ualV1(kaNumber),
    assertionVersion: '1', publicTripleCount: '2', privateTripleCount: '0', privateMerkleRoot: null,
  } as unknown as CanonicalGraphScopedAuthorSealV1;
}

export function v2MarkerV1(kaNumber: number, contextGraphId = BACKLOG_GRAPH): Marker {
  const seal = sealV1(kaNumber);
  return snapshotRfc64FinalizedPrivatePlacementRepairV1({
    version: 2, contextGraphId, authorAddress: BACKLOG_AUTHOR, inventoryScope: null, subGraphName: null,
    assertionCoordinate: `asset-${kaNumber}`, assertionVersion: '1', kaUal: seal.kaUal,
    sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal), seal,
  } as Rfc64FinalizedPrivatePlacementRepairV1);
}

/** `size` markers of one graph, numbered from `first`, V2 in that proportion. */
export function backlogV1(size: number, first = 1, contextGraphId = BACKLOG_GRAPH): Marker[] {
  const v2 = Math.round((size * 128) / 3534);
  return Array.from({ length: size }, (_value, index) => (
    index < size - v2 ? v1MarkerV1(first + index, contextGraphId) : v2MarkerV1(first + index, contextGraphId)
  ));
}

/** The catalog scope a marker of `contextGraphId` places into under `era`. */
export function catalogScopeDigestV1(contextGraphId: ContextGraphIdV1, era = '1'): string {
  return computeAuthorCatalogScopeDigestV1({
    ...scopeBaseV1(contextGraphId, era), authorAddress: BACKLOG_AUTHOR, bucketCount: '1',
  } as AuthorCatalogScopeV1);
}

/**
 * The catalogs and durable markers of one node, and a supervisor over them that counts what a
 * pass costs. A catalog listed in `full` holds CATALOG_CAP assets none of the markers place; any
 * other accepts every placement. A placed marker leaves the queue.
 */
export function parkedBacklogNodeV1(markers: Marker[], options: { full?: readonly string[] } = {}) {
  const held = Array.from({ length: CATALOG_CAP }, (_value, index) => ({ seal: { kaUal: ualV1(9_000_000 + index) } }));
  const full = new Set(options.full ?? [catalogScopeDigestV1(BACKLOG_GRAPH)]);
  const failures = new Map<string, PrivatePlacementFailureStateV1>();
  const state = {
    markers, era: '1', active: true, unavailable: undefined as Error | undefined,
    attempts: [] as Marker[], listings: 0,
    /** Called at each applied-head read, which a pass makes once a full scope. */
    onHeadRead: undefined as (() => void) | undefined,
  };
  const scopeOf = (repair: Marker): string => (repair.version === 1
    ? catalogScopeDigestV1(repair.contextGraphId, repair.inventoryScope.era)
    : catalogScopeDigestV1(repair.contextGraphId, state.era));
  const calls = {
    authority: vi.fn((contextGraphId: string): FinalizedPlacementAuthorityV1 => {
      if (state.unavailable !== undefined) return { status: 'unavailable', error: state.unavailable };
      if (!state.active) return { status: 'inactive' };
      return { status: 'active', lane: { kind: 'private', acceptsFinalizedVmRepair: true,
        scopeBase: scopeBaseV1(contextGraphId as ContextGraphIdV1, state.era) } };
    }),
    head: vi.fn((scopeDigest: string) => {
      state.onHeadRead?.();
      return full.has(scopeDigest) ? { inventoryRowCount: String(CATALOG_CAP) } : null;
    }),
    failureReads: vi.fn((repair: Marker) => failures.get(repair.kaUal) ?? null),
    failureWrites: vi.fn((entries: readonly { repair: Marker; state: PrivatePlacementFailureStateV1 }[]) => {
      for (const entry of entries) failures.set(entry.repair.kaUal, entry.state);
    }),
    place: vi.fn(async (repair: Marker): Promise<void> => {
      state.attempts.push(repair);
      if (full.has(scopeOf(repair))) throw new AuthorCatalogFullErrorV1(held, 1);
      state.markers = state.markers.filter((candidate) => candidate !== repair);
    }),
  };
  const owner = new Rfc64SwmCatalogProjectionOwnerV1({
    resolvePartition: () => ({ retryIntervalMs: 0, track2Policies: [], track2Targets: [], recoveryProviderPeerIds: [] }) as never,
    listDurableInventoryScopes: () => [],
    listLocalAuthorAddresses: () => [],
    acceptsPublicRootLane: () => true,
    readFinalizedPlacementAuthority: calls.authority,
    readRepairRevision: () => null,
    listFinalizedPrivateRepairs: () => state.markers,
    listFinalizedPrivateRepairsAsync: async () => { state.listings += 1; return state.markers; },
    readPrivateFailure: calls.failureReads,
    writePrivateFailures: calls.failureWrites,
    repairFinalizedPrivatePlacement: calls.place,
    reconcile: async () => null,
    readAppliedCatalogHead: calls.head as never,
    warn: () => {},
  });
  const clear = () => {
    for (const spy of Object.values(calls)) spy.mockClear();
    state.attempts.length = 0;
  };
  return {
    owner, state, calls, failures, full, clear,
    /** One pass, as a start asks for it. */
    pass: async () => { owner.start(ctx); await owner.whenIdle(); },
    /** One pass, as a placement request for an already-owed marker asks for it. */
    request: async (repair: Marker) => {
      const request = owner.requestFinalizedPrivate({ repair, ctx });
      await owner.whenIdle();
      return request;
    },
    capacity: () => owner.status()?.authorCatalogCapacity,
  };
}
