// SPDX-License-Identifier: Apache-2.0

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  computeAuthorCatalogScopeDigestV1,
  createOperationContext,
  type AuthorCatalogScopeV1,
  type Digest32V1,
  type EvmAddressV1,
  type OperationContext,
} from '@origintrail-official/dkg-core';

import { rememberBounded } from '../bounded-map.js';
import {
  catalogRepairDiagnosticV1,
  type CatalogRepairDiagnosticV1,
} from '../rfc64/catalog-repair-diagnostics-v1.js';
import { CATALOG_FULL_RETRY_INTERVAL_MS_V1 } from '../rfc64/catalog-repair-retry-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  '../rfc64/finalized-private-placement-repair-store-v1.js';
import { findAuthorCatalogFullErrorV1 } from './author-catalog-capacity.js';

/**
 * GH#3134 — what the catalog supervisor does about an author catalog at its row cap. A full
 * catalog refuses every NEW asset the same way until a row is free, so retrying a refused
 * placement on the failure timer only repeats a read of the whole catalog. Instead:
 *
 * - a finalized-private placement refused as full keeps its durable marker and is parked. For
 *   what is parked a supervisor pass reads one applied-head row a scope: no attempt, no successor
 *   work and no catalog read;
 * - the refusal names the assets the catalog holds. A marker for one of them (a newer version, or
 *   a row placed meanwhile) is attempted as usual. A marker for any other asset of the same
 *   catalog, at the applied head the refusal read, is parked without an attempt of its own, so a
 *   restart costs one attempt a full catalog and not one a marker;
 * - parked markers are attempted again when the scope's applied head shows a free row. As a
 *   safety net one of them is attempted an interval per scope, each interval the next one in
 *   turn, and its refusal reads afresh what the catalog holds;
 * - the log names the graph and author when a scope first refuses and at most once an interval
 *   after that; status carries two counts and no identity.
 *
 * Nothing here is durable and nothing decides what a full catalog should do instead. The
 * share-time projection of a full scope is not parked here: its retry class gives a full catalog
 * the same interval, and a change of the author's inventory (which may be a removal) still gets
 * its one attempt. This object rate-limits that path's log line and counts its scope.
 */

/**
 * A full scope is attempted once an interval, and named in the log at most once an interval: the
 * interval the retry class gives the share-time projection of a full catalog.
 */
export const FULL_CATALOG_RECHECK_INTERVAL_MS_V1 = CATALOG_FULL_RETRY_INTERVAL_MS_V1;
const MAX_FULL_SCOPES_V1 = 64;
const MAX_NAMED_SCOPES_V1 = 256;

/** The applied-head row of one author catalog scope, as far as capacity reads it. */
export interface AppliedCatalogHeadRowV1 {
  readonly currentCatalogHeadDigest: string;
  /** Canonical decimal row count of the applied bucket. */
  readonly inventoryRowCount: string;
}

export interface FullCatalogParkingDependenciesV1 {
  /**
   * The applied-head row of one author catalog scope: null when the scope has none, undefined
   * when it cannot be read now. Without this reader, or while it cannot read, a parked placement
   * waits for the safety-net interval.
   */
  readonly readAppliedCatalogHead?: (
    catalogScopeDigest: Digest32V1,
    authorAddress: EvmAddressV1,
  ) => AppliedCatalogHeadRowV1 | null | undefined;
  readonly warn: (ctx: OperationContext, message: string) => void;
}

/** Aggregate, identity-free: no graph id, author or UAL. */
export interface AuthorCatalogCapacityStatusV1 {
  /** Finalized-private placements parked because their author catalog has no row for them. */
  readonly parkedPlacements: number;
  /**
   * Author catalog scopes (one graph, one author) that refused new rows for lack of room: a
   * placement, the share-time projection, or both. A catalog that is full and was asked for
   * nothing since is not counted.
   */
  readonly scopesAtCap: number;
}

/** A share-time projection repair, as far as its capacity state goes. */
type ProjectionRepairV1 = Readonly<{
  contextGraphId: string;
  authorAddress: string;
  outcome: string;
  diagnostic: Readonly<CatalogRepairDiagnosticV1> | null;
}>;

/** What the last real refusal of one exact catalog scope found. */
interface FullScopeV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly contextGraphId: string;
  readonly authorAddress: EvmAddressV1;
  readonly headDigest: string | null;
  readonly heldKaUals: ReadonlySet<string>;
  readonly rows: number;
  readonly rowCap: number;
  recheckAtMs: number;
  /** Parked markers the next safety-net attempt lets pass first, so the turn moves on. */
  turn: number;
  /** Parked markers that asked for a due safety-net attempt in the current pass. */
  asked: number;
}

export class FullCatalogParkingV1 {
  readonly #dependencies: FullCatalogParkingDependenciesV1;
  readonly #now: () => number;
  /** Full scopes, by exact catalog scope. */
  readonly #scopes = new Map<string, FullScopeV1>();
  /** Parked markers: the supervisor's marker key and the scope that has no row for it. */
  readonly #parked = new Map<string, string>();
  /** When each graph and author was last named in the log. */
  readonly #namedAtMs = new Map<string, number>();
  /** The applied head of each full scope as the current pass read it: one read a scope a pass. */
  readonly #passHeads = new Map<string, AppliedHeadV1 | null | undefined>();

  constructor(dependencies: FullCatalogParkingDependenciesV1, now: () => number = () => Date.now()) {
    this.#dependencies = dependencies;
    this.#now = now;
  }

  /** A pass listed the durable markers with these keys: forget what left the queue. */
  passStarted(listed: ReadonlySet<string>): void {
    this.#passHeads.clear();
    for (const key of this.#parked.keys()) {
      if (!listed.has(key)) this.#parked.delete(key);
    }
    const parkedScopes = new Set(this.#parked.values());
    const now = this.#now();
    for (const [scopeKey, scope] of this.#scopes) {
      // What a refusal found is not kept past its interval for a scope with nothing parked.
      if (!parkedScopes.has(scopeKey) && now >= scope.recheckAtMs) this.#scopes.delete(scopeKey);
      // No marker took the due safety-net attempt in the last pass: the turn starts over.
      if (scope.asked > 0 && now >= scope.recheckAtMs) scope.turn = 0;
      scope.asked = 0;
    }
  }

  /**
   * Whether this pass leaves the marker alone. False means "attempt it as usual", and a refusal of
   * that attempt comes back through {@link placementRefused}.
   */
  parked(key: string, repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): boolean {
    const scopeKey = this.#parked.get(key) ?? scopeKeyV1(repair);
    const scope = this.#scopes.get(scopeKey);
    if (scope !== undefined && this.#keepsParked(scopeKey, scope, key, repair)) {
      this.#parked.set(key, scopeKey);
      return true;
    }
    this.#parked.delete(key);
    return false;
  }

  /**
   * An attempt failed. True when the catalog refused it as full: the marker is parked, what the
   * catalog holds is remembered for its scope, and the caller neither logs nor retries it itself.
   */
  placementRefused(
    key: string,
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
    error: unknown,
  ): boolean {
    const full = findAuthorCatalogFullErrorV1(error);
    if (full === undefined) return false;
    let catalogScopeDigest: Digest32V1;
    try {
      catalogScopeDigest = computeAuthorCatalogScopeDigestV1({
        ...repair.inventoryScope,
        bucketCount: '1',
      } as AuthorCatalogScopeV1) as Digest32V1;
    } catch {
      // A marker whose scope cannot be named keeps the ordinary failure handling.
      return false;
    }
    const scopeKey = scopeKeyV1(repair);
    const known = this.#scopes.get(scopeKey);
    rememberBounded(this.#scopes, scopeKey, {
      catalogScopeDigest,
      contextGraphId: repair.contextGraphId,
      authorAddress: repair.authorAddress,
      headDigest: full.appliedHeadDigest,
      heldKaUals: full.heldKaUals,
      rows: full.rowCount,
      rowCap: full.rowCap,
      recheckAtMs: this.#now() + FULL_CATALOG_RECHECK_INTERVAL_MS_V1,
      turn: known?.turn ?? 0,
      asked: known?.asked ?? 0,
    }, MAX_FULL_SCOPES_V1);
    this.#parked.set(key, scopeKey);
    // The pass may have read this scope's head before the attempt, when it still showed a free row.
    this.#passHeads.delete(scopeKey);
    return true;
  }

  /** The pass is over: name the scopes that hold parked placements, each at most once an interval. */
  passEnded(): void {
    const parked = new Map<string, number>();
    for (const scopeKey of this.#parked.values()) parked.set(scopeKey, (parked.get(scopeKey) ?? 0) + 1);
    for (const [scopeKey, scope] of this.#scopes) {
      const parkedPlacements = parked.get(scopeKey);
      if (parkedPlacements !== undefined) this.#name(scope, 'placement', scope.rows, parkedPlacements);
    }
  }

  /**
   * A share-time projection failed. True when the reason is a full catalog: the scope is named in
   * the log (at most once an interval) and the caller does not log the attempt itself.
   */
  projectionRefused(
    repair: Readonly<{ contextGraphId: string; authorAddress: string }>,
    error: unknown,
  ): boolean {
    if (catalogRepairDiagnosticV1(error).kind !== 'catalog_full') return false;
    let parkedPlacements = 0;
    for (const scopeKey of this.#parked.values()) {
      const scope = this.#scopes.get(scopeKey);
      if (scope !== undefined && namedScopeV1(scope) === namedScopeV1(repair)) parkedPlacements += 1;
    }
    // The projection target's own bound reports no row count.
    this.#name(repair, 'projection', findAuthorCatalogFullErrorV1(error)?.rowCount ?? null, parkedPlacements);
    return true;
  }

  /** Supervisor status: two counts. `repairs` are the supervisor's share-time projection repairs. */
  status(repairs: readonly ProjectionRepairV1[]): Readonly<AuthorCatalogCapacityStatusV1> {
    const named = new Set<string>();
    const full = new Set<string>();
    for (const [scopeKey, scope] of this.#scopes) {
      // A scope whose applied head shows a free row is no longer at its cap; the next pass
      // attempts its markers.
      if (hasFreeRowV1(this.#appliedHead(scope), scope) === true) continue;
      full.add(scopeKey);
      named.add(namedScopeV1(scope));
    }
    for (const repair of repairs) {
      if (repair.outcome === 'failed' && repair.diagnostic?.kind === 'catalog_full') {
        named.add(namedScopeV1(repair));
      }
    }
    let parkedPlacements = 0;
    for (const scopeKey of this.#parked.values()) {
      if (full.has(scopeKey)) parkedPlacements += 1;
    }
    return Object.freeze({ parkedPlacements, scopesAtCap: named.size });
  }

  #keepsParked(
    scopeKey: string,
    scope: FullScopeV1,
    key: string,
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ): boolean {
    if (!this.#passHeads.has(scopeKey)) this.#passHeads.set(scopeKey, this.#appliedHead(scope));
    if (hasFreeRowV1(this.#passHeads.get(scopeKey), scope) === true) {
      // A row is free: every marker of the scope is attempted again.
      this.#scopes.delete(scopeKey);
      for (const [parkedKey, parkedScope] of this.#parked) {
        if (parkedScope === scopeKey) this.#parked.delete(parkedKey);
      }
      return false;
    }
    // The catalog holds a row of this asset: a newer version replaces it, an equal one is placed.
    if (scope.heldKaUals.has(repair.kaUal)) return false;
    const now = this.#now();
    if (now >= scope.recheckAtMs) {
      // The safety net: one real attempt a scope an interval, by a marker that would otherwise
      // stay parked. Its refusal reads afresh what the catalog holds. The turn moves on by one
      // marker each interval, so a marker that keeps failing for another reason cannot hold it.
      scope.asked += 1;
      if (scope.asked > scope.turn) {
        scope.turn = scope.asked;
        scope.recheckAtMs = now + FULL_CATALOG_RECHECK_INTERVAL_MS_V1;
        return false;
      }
    }
    // A marker that was not parked before is taken on the catalog's word only at the applied
    // head that word was read under, read now; at any other head it gets an attempt of its own.
    return this.#parked.has(key) || this.#appliedHead(scope)?.digest === scope.headDigest;
  }

  /** The scope's applied head, null when it has none, undefined when it cannot be read. */
  #appliedHead(scope: FullScopeV1): AppliedHeadV1 | null | undefined {
    try {
      const head = this.#dependencies.readAppliedCatalogHead?.(scope.catalogScopeDigest, scope.authorAddress);
      return head === null || head === undefined
        ? head
        : { digest: head.currentCatalogHeadDigest, rows: Number(head.inventoryRowCount) };
    } catch {
      // An unreadable head changes nothing: what is parked stays parked until the interval.
      return undefined;
    }
  }

  #name(
    scope: Readonly<{ contextGraphId: string; authorAddress: string }>,
    refused: 'placement' | 'projection',
    rows: number | null,
    parkedPlacements: number,
  ): void {
    const named = namedScopeV1(scope);
    const now = this.#now();
    const last = this.#namedAtMs.get(named);
    if (last !== undefined && now - last < FULL_CATALOG_RECHECK_INTERVAL_MS_V1) return;
    rememberBounded(this.#namedAtMs, named, now, MAX_NAMED_SCOPES_V1);
    try {
      this.#dependencies.warn(createOperationContext('system'), JSON.stringify({
        event: 'catalog_full',
        contextGraphId: scope.contextGraphId,
        authorAddress: scope.authorAddress,
        refused,
        rows,
        rowCap: MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
        parkedPlacements,
      }));
    } catch { /* Diagnostics must not alter repair state or waiter settlement. */ }
  }
}

/** The applied head of a scope, as far as parking reads it. */
type AppliedHeadV1 = Readonly<{ digest: string; rows: number }>;

/** True or false when the applied head was read; undefined when it could not be. */
function hasFreeRowV1(head: AppliedHeadV1 | null | undefined, scope: FullScopeV1): boolean | undefined {
  return head === undefined ? undefined : head === null || head.rows < scope.rowCap;
}

/** One exact author catalog scope, as a marker names it. */
function scopeKeyV1(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): string {
  const scope = repair.inventoryScope;
  return JSON.stringify([
    repair.authorAddress,
    scope.networkId,
    scope.contextGraphId,
    scope.governanceChainId,
    scope.governanceContractAddress,
    scope.ownershipTransitionDigest,
    scope.subGraphName,
    scope.era,
  ]);
}

/** One graph and author, as the log and the status count name a scope. */
function namedScopeV1(scope: Readonly<{ contextGraphId: string; authorAddress: string }>): string {
  return `${scope.contextGraphId}\n${scope.authorAddress}`;
}
