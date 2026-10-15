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
 *   catalog is parked without an attempt of its own while the applied head shows no free row. A
 *   restart therefore costs one attempt a full catalog, not one a marker, and a further new
 *   asset published into a catalog known to be full costs none;
 * - parked markers are attempted again when the scope's applied head shows a free row;
 * - one parked marker a scope is attempted an interval as a safety net, because rows may have
 *   been swapped at the same count. It is the marker parked longest; it goes to the back and
 *   stays parked unless that attempt places it. Its refusal reads afresh what the catalog holds,
 *   and markers whose asset is then found there are attempted. When the attempt places its
 *   marker, the catalog held a row the refusal did not name, so the next parked marker follows
 *   in the next pass, and so on until one is refused. No other refusal moves that interval;
 * - the log names the graph and author when a scope first refuses and at most once an interval
 *   after that, for a refused placement and for a refused projection each on its own; status
 *   carries two counts and no identity.
 *
 * A scope is identified by its canonical catalog scope digest. Nothing here is durable, and
 * nothing decides what a full catalog should do instead. What is kept is bounded by the durable
 * marker queue: a scope is known only while it has parked markers or for an interval after its
 * refusal. The list of what a catalog holds is kept for a bounded number of scopes; a scope
 * without it keeps its markers parked and gives a new marker one attempt of its own.
 *
 * The share-time projection of a full scope is not parked here: its retry class gives a full
 * catalog the same interval, and a change of the author's inventory (which may be a removal)
 * still gets its one attempt. This object rate-limits that path's log line and counts its scope.
 */

/**
 * A full scope is attempted once an interval, and named in the log at most once an interval: the
 * interval the retry class gives the share-time projection of a full catalog.
 */
export const FULL_CATALOG_RECHECK_INTERVAL_MS_V1 = CATALOG_FULL_RETRY_INTERVAL_MS_V1;
/** Scopes whose list of held assets is kept; a list is at most a catalog's rows of UALs. */
export const MAX_FULL_CATALOG_DETAILED_SCOPES_V1 = 64;
/** Named scopes above which times that no longer suppress a log line are dropped. */
export const FULL_CATALOG_NAMED_SCOPES_SWEEP_V1 = 256;

/** The applied-head row of one author catalog scope, as far as capacity reads it. */
export interface AppliedCatalogHeadRowV1 {
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

/** The applied head of a scope, as far as parking reads it. */
type AppliedHeadV1 = Readonly<{ rows: number }>;

/** One full catalog scope: what its last refusal read, and when it is attempted again. */
interface FullScopeV1 {
  readonly catalogScopeDigest: Digest32V1;
  readonly contextGraphId: string;
  readonly authorAddress: EvmAddressV1;
  readonly rows: number;
  readonly rowCap: number;
  /** When the scope's next safety-net attempt is due. */
  recheckAtMs: number;
  /** The marker the last safety-net attempt went to, until a pass no longer lists it. */
  attempted: string | undefined;
  /** The parked marker the current pass attempts as the safety net, when one is due. */
  dueMarker: string | undefined;
}

export class FullCatalogParkingV1 {
  readonly #dependencies: FullCatalogParkingDependenciesV1;
  readonly #now: () => number;
  /** Full scopes by canonical catalog scope digest, for as long as they hold anything back. */
  readonly #scopes = new Map<string, FullScopeV1>();
  /** The assets a scope's catalog held at its last refusal, for the scopes refused most recently. */
  readonly #held = new Map<string, ReadonlySet<string>>();
  /** Parked markers and their scope, by the supervisor's marker key, the longest parked first. */
  readonly #parked = new Map<string, string>();
  /** When each graph and author was last named in the log, for each of the two refused paths. */
  readonly #namedAtMs = new Map<string, number>();
  /** The applied head of each full scope as the current pass read it: one read a scope a pass. */
  readonly #passHeads = new Map<string, AppliedHeadV1 | null | undefined>();

  constructor(dependencies: FullCatalogParkingDependenciesV1, now: () => number = () => Date.now()) {
    this.#dependencies = dependencies;
    this.#now = now;
  }

  /**
   * A pass listed the durable markers with these keys. Forget what left the queue, and choose
   * for each scope whose safety-net attempt is due the marker that gets it in this pass.
   */
  passStarted(listed: ReadonlySet<string>): void {
    this.#passHeads.clear();
    const now = this.#now();
    const due = new Set<string>();
    for (const [scopeKey, scope] of this.#scopes) {
      scope.dueMarker = undefined;
      if (scope.attempted !== undefined && !listed.has(scope.attempted)) {
        // The marker the last safety-net attempt went to was placed: the catalog held a row
        // the refusal did not name. What it found is out of date, and the next attempt does
        // not wait for the interval.
        scope.attempted = undefined;
        scope.recheckAtMs = now;
      }
      if (now >= scope.recheckAtMs) due.add(scopeKey);
    }
    for (const [key, scopeKey] of this.#parked) {
      if (!listed.has(key)) {
        this.#parked.delete(key);
        continue;
      }
      // The marker parked longest. A marker goes to the back when it gets the attempt, so one
      // that keeps failing for another reason cannot hold the safety net.
      const scope = due.delete(scopeKey) ? this.#scopes.get(scopeKey) : undefined;
      if (scope !== undefined) scope.dueMarker = key;
    }
    for (const [scopeKey, scope] of this.#scopes) {
      // What a refusal found is not kept past its interval for a scope with nothing parked.
      if (scope.dueMarker === undefined && now >= scope.recheckAtMs) this.#forget(scopeKey);
    }
  }

  /**
   * Decide one listed marker for this pass, and record the decision. True: it is parked, and the
   * pass leaves it alone. False: attempt it now; a refusal of that attempt comes back through
   * {@link placementRefused}. Asked once a marker a pass.
   */
  park(key: string, repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): boolean {
    // No full scope is known: nothing is parked, and no marker needs its scope named.
    if (this.#scopes.size === 0) return false;
    const scopeKey = this.#parked.get(key) ?? catalogScopeDigestV1(repair);
    const scope = scopeKey === undefined ? undefined : this.#scopes.get(scopeKey);
    const decision = scopeKey === undefined || scope === undefined
      ? 'attempt'
      : this.#decide(scopeKey, scope, key, repair);
    if (scopeKey === undefined || decision === 'attempt') {
      this.#parked.delete(key);
      return false;
    }
    // The safety-net marker goes to the back, and stays parked: whatever its attempt fails on,
    // it is not retried on the failure timer. A marker its attempt places leaves the queue.
    if (decision === 'safety-net') this.#parked.delete(key);
    this.#parked.set(key, scopeKey);
    return decision === 'parked';
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
    const scopeKey = catalogScopeDigestV1(repair);
    // A marker whose scope cannot be named keeps the ordinary failure handling.
    if (scopeKey === undefined) return false;
    const known = this.#scopes.get(scopeKey);
    this.#scopes.set(scopeKey, {
      catalogScopeDigest: scopeKey,
      contextGraphId: repair.contextGraphId,
      authorAddress: repair.authorAddress,
      rows: full.rowCount,
      rowCap: full.rowCap,
      // A refusal brings what the catalog holds now. It does not move the safety net of a scope
      // already known: the attempt a new marker gets of its own, where the list was dropped,
      // would otherwise postpone the hour of what has been parked longer, for ever.
      recheckAtMs: known?.recheckAtMs ?? this.#now() + FULL_CATALOG_RECHECK_INTERVAL_MS_V1,
      attempted: undefined,
      dueMarker: undefined,
    });
    // The lists of the scopes refused most recently are kept; a scope whose list is dropped
    // stays known, so its markers stay parked.
    rememberBounded(this.#held, scopeKey, full.heldKaUals, MAX_FULL_CATALOG_DETAILED_SCOPES_V1);
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

  #decide(
    scopeKey: string,
    scope: FullScopeV1,
    key: string,
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ): 'attempt' | 'safety-net' | 'parked' {
    // One read a scope a pass, when its first marker is decided or after its refusal in this pass.
    if (!this.#passHeads.has(scopeKey)) this.#passHeads.set(scopeKey, this.#appliedHead(scope));
    if (hasFreeRowV1(this.#passHeads.get(scopeKey), scope) === true) {
      // A row is free: every marker of the scope is attempted again.
      this.#forget(scopeKey);
      for (const [parkedKey, parkedScope] of this.#parked) {
        if (parkedScope === scopeKey) this.#parked.delete(parkedKey);
      }
      return 'attempt';
    }
    // The catalog holds a row of this asset: a newer version replaces it, an equal one is placed.
    const held = this.#held.get(scopeKey);
    if (held?.has(repair.kaUal) === true) return 'attempt';
    if (scope.dueMarker === key) {
      // The safety net: one real attempt for the scope, by the marker this pass chose. Its
      // refusal reads afresh what the catalog holds.
      scope.dueMarker = undefined;
      scope.attempted = key;
      scope.recheckAtMs = this.#now() + FULL_CATALOG_RECHECK_INTERVAL_MS_V1;
      return 'safety-net';
    }
    if (this.#parked.has(key)) return 'parked';
    // A marker that was not parked before is taken on the catalog's word while that word is kept
    // and the applied head, as this pass read it, shows no free row. A head that moved on at the
    // same count is no reason for an attempt: a newer version of a held asset moves it too, and
    // the safety net is what refreshes the list. Otherwise it gets an attempt of its own.
    return held !== undefined && hasFreeRowV1(this.#passHeads.get(scopeKey), scope) === false
      ? 'parked'
      : 'attempt';
  }

  #forget(scopeKey: string): void {
    this.#scopes.delete(scopeKey);
    this.#held.delete(scopeKey);
  }

  /** The scope's applied head, null when it has none, undefined when it cannot be read. */
  #appliedHead(scope: FullScopeV1): AppliedHeadV1 | null | undefined {
    try {
      const head = this.#dependencies.readAppliedCatalogHead?.(scope.catalogScopeDigest, scope.authorAddress);
      return head === null || head === undefined
        ? head
        : { rows: Number(head.inventoryRowCount) };
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
    // Each path has its line and its hour. A share is refused before its publication is
    // confirmed, so the projection's line comes first and says nothing is parked yet: it must
    // not swallow the line for the first parked placement.
    const named = `${namedScopeV1(scope)}\n${refused}`;
    const now = this.#now();
    const last = this.#namedAtMs.get(named);
    if (last !== undefined && now - last < FULL_CATALOG_RECHECK_INTERVAL_MS_V1) return;
    if (this.#namedAtMs.size >= FULL_CATALOG_NAMED_SCOPES_SWEEP_V1) {
      // A time older than the interval suppresses nothing. Every newer one stays, however many
      // there are: a path of a scope named within the interval is not named again in it.
      for (const [other, namedAt] of this.#namedAtMs) {
        if (now - namedAt >= FULL_CATALOG_RECHECK_INTERVAL_MS_V1) this.#namedAtMs.delete(other);
      }
    }
    this.#namedAtMs.set(named, now);
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

/** True or false when the applied head was read; undefined when it could not be. */
function hasFreeRowV1(head: AppliedHeadV1 | null | undefined, scope: FullScopeV1): boolean | undefined {
  return head === undefined ? undefined : head === null || head.rows < scope.rowCap;
}

/** The canonical digest of the author catalog scope a marker names, or undefined when it names none. */
function catalogScopeDigestV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): Digest32V1 | undefined {
  try {
    return computeAuthorCatalogScopeDigestV1({
      ...repair.inventoryScope,
      bucketCount: '1',
    } as AuthorCatalogScopeV1) as Digest32V1;
  } catch {
    return undefined;
  }
}

/** One graph and author, as the log and the status count name a scope. */
function namedScopeV1(scope: Readonly<{ contextGraphId: string; authorAddress: string }>): string {
  return `${scope.contextGraphId}\n${scope.authorAddress}`;
}
