// SPDX-License-Identifier: Apache-2.0

import type { Logger, OperationContext } from '@origintrail-official/dkg-core';

/**
 * GH#3081 — where a confirmed publication waits for its RFC-64 catalog placement. Observation
 * only: no repair, admission or retry decision reads anything recorded here, every entry point
 * swallows its own failure, and the output is one log line per slow observer call plus an
 * aggregate, identity-free view of the finalized-private queue for `/api/status`.
 *
 * The supervisor binds the records to the work it already owns. Each accepted waiter gets a
 * record when it is registered (its request time and the cooldown skips it waits through); an
 * admitted attempt gets a record that the repair body charges its phases to (the coverage check
 * and asset resolution in the projection; the locked state read, successor production,
 * applied-head CAS and announcement in the upsert); and when the supervisor releases a key's
 * waiters after an attempt, it attaches that attempt's record to each of them. An observer call
 * finds its waiter through the promise it awaits, so its line describes exactly the attempt that
 * released it. The line splits the call's wait into the time to request the repair (the asset lock
 * and the durable marker write), the time queued in the supervisor (earlier markers, cooldown,
 * the next pass) and the attempt, broken down by phase; `otherMs` is the attempt time no phase
 * claims (lock waits, lane and inventory reads, marker deletion). Per-send announcement timing is
 * not measured: the announce phase is the whole sequential fan-out, with peer and failure counts.
 */

/** An observer wait at or above this writes its line; shorter waits write nothing. */
export const CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS = 5_000;
const MAX_TRACKED_ENTRIES = 512;
const POLICY_DENIED_ERROR_PREFIX = '[catalog-transport-policy-denied]';

export const CATALOG_PLACEMENT_PHASES = [
  /** `rfc64CatalogCoversConfirmedSwmRowV1`: a verified applied-state load outside the lock. */
  'coverage',
  /** Resolving the catalog asset from the inventory row, workspace or finalized VM graph. */
  'asset',
  /** The catalog mutation lock and the verified state read (or genesis) under it. */
  'state',
  /** Building, signing and staging the successor. */
  'successor',
  /** The applied-head compare-and-swap. */
  'cas',
  /** Best-effort announcement of the committed head to every selected peer, in sequence. */
  'announce',
] as const;

export type CatalogPlacementPhase = typeof CATALOG_PLACEMENT_PHASES[number];

/** The asset a placement is for. Only the canonical UAL and version are ever logged. */
export interface CatalogPlacementAssetV1 {
  readonly kaUal: string;
  readonly assertionVersion: string;
}

export interface CatalogPlacementDeliveryV1 {
  readonly announcedPeers: readonly unknown[];
  readonly failedPeers: readonly Readonly<{ readonly error: string }>[];
}

/** What the supervisor holds for the attempt it admitted. */
export interface CatalogPlacementAdmissionV1 {
  end(outcome: 'completed' | 'failed'): void;
}

/** What the repair body charges its phases to: the attempt in flight for its marker, or nothing. */
export interface CatalogPlacementAttemptV1 {
  now(): number;
  phase(phase: CatalogPlacementPhase, startedAt: number): void;
  covered(covered: boolean, startedAt: number): void;
  announced(delivery: CatalogPlacementDeliveryV1, startedAt: number): void;
}

/** One observer call's wait. */
export interface CatalogPlacementWaitV1 {
  /** The observer asked the supervisor for a placement and waits on `whenAttempted`. */
  requested(whenAttempted: Promise<void> | null): void;
  /** The observer is returning: write the line when the wait reached the threshold. */
  end(log: Pick<Logger, 'info'>): void;
}

/** Aggregate finalized-private queue evidence; no UAL, author or graph id. */
export interface FinalizedPrivatePlacementQueueStatusV1 {
  /** Markers the most recent supervisor pass listed (never a fresh read). */
  readonly depth: number;
  readonly waiters: number;
  readonly oldestWaiterAgeMs: number | null;
  readonly passRunning: boolean;
  readonly lastPassDurationMs: number | null;
  /** Markers a pass skipped because their retry cooldown had not elapsed (cumulative). */
  readonly cooldownSkips: number;
}

export interface CatalogPlacementTimingSourcesV1 {
  /** Monotonic milliseconds. */
  readonly clock: () => number;
  readonly logThresholdMs: number;
}

const DEFAULT_SOURCES: CatalogPlacementTimingSourcesV1 = {
  clock: () => performance.now(),
  logThresholdMs: CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS,
};

interface PlacementAttemptRecordV1 {
  readonly admittedAt: number;
  endedAt?: number;
  failed?: boolean;
  covered?: boolean;
  readonly phaseMs: Record<CatalogPlacementPhase, number>;
  peers: number;
  failedPeers: number;
  deniedPeers: number;
}

/** One supervisor waiter: when it was accepted, what it waited through, and what released it. */
interface PlacementWaiterRecordV1 {
  readonly requestedAt: number;
  cooldownSkips: number;
  attempt?: PlacementAttemptRecordV1;
}

export const INERT_CATALOG_PLACEMENT_ATTEMPT_V1: CatalogPlacementAttemptV1 = Object.freeze({
  now: () => 0,
  phase: () => {},
  covered: () => {},
  announced: () => {},
});

const INERT_ADMISSION: CatalogPlacementAdmissionV1 = Object.freeze({ end: () => {} });
const INERT_WAIT: CatalogPlacementWaitV1 = Object.freeze({ requested: () => {}, end: () => {} });

function boundedSet<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  while (map.size >= MAX_TRACKED_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(key, value);
}

function observe(callback: () => void): void {
  try {
    callback();
  } catch { /* observation only */ }
}

function ms(value: number): string {
  return Number.isFinite(value) ? String(Math.max(0, Math.round(value))) : '-';
}

/** Canonical UALs, versions, ids and numbers print bare; anything else is quoted. */
function logfmtValue(value: string): string {
  return /^[\w.:/@+-]+$/.test(value) ? value : JSON.stringify(value);
}

/** One agent's placement timing and finalized-private queue evidence. */
export class CatalogPlacementTimingV1 {
  readonly #sources: CatalogPlacementTimingSourcesV1;
  /** Each accepted waiter's record, keyed by its settle callback and by the promise it settles. */
  readonly #waiters = new WeakMap<object, PlacementWaiterRecordV1>();
  readonly #admissions = new WeakMap<CatalogPlacementAdmissionV1, PlacementAttemptRecordV1>();
  readonly #observerCalls = new Map<string, number>();
  #inFlight: Readonly<{ repair: object; record: PlacementAttemptRecordV1 }> | undefined;
  #depth = 0;
  #passStartedAt: number | undefined;
  #lastPassDurationMs: number | null = null;
  #cooldownSkips = 0;

  constructor(sources: Partial<CatalogPlacementTimingSourcesV1> = {}) {
    this.#sources = { ...DEFAULT_SOURCES, ...sources };
  }

  /** Supervisor: a waiter was accepted; its record lives exactly as long as the waiter does. */
  waiterAdded(settle: object, whenAttempted: object): void {
    observe(() => {
      const record: PlacementWaiterRecordV1 = { requestedAt: this.#sources.clock(), cooldownSkips: 0 };
      this.#waiters.set(settle, record);
      this.#waiters.set(whenAttempted, record);
    });
  }

  /** Supervisor: one attempt for `repair`, the exact marker the pass listed, starts now. */
  admit(repair: object): CatalogPlacementAdmissionV1 {
    try {
      const record: PlacementAttemptRecordV1 = {
        admittedAt: this.#sources.clock(),
        phaseMs: Object.fromEntries(CATALOG_PLACEMENT_PHASES.map((phase) => [phase, 0])) as
          Record<CatalogPlacementPhase, number>,
        peers: 0,
        failedPeers: 0,
        deniedPeers: 0,
      };
      this.#inFlight = Object.freeze({ repair, record });
      const admission: CatalogPlacementAdmissionV1 = {
        end: (outcome) => observe(() => {
          record.endedAt = this.#sources.clock();
          record.failed = outcome === 'failed';
          if (this.#inFlight?.record === record) this.#inFlight = undefined;
        }),
      };
      this.#admissions.set(admission, record);
      return admission;
    } catch {
      return INERT_ADMISSION;
    }
  }

  /** Supervisor: a pass skipped these waiters' repair because its retry cooldown had not elapsed. */
  cooldownSkipped(waiters: Iterable<object> | undefined): void {
    observe(() => {
      this.#cooldownSkips += 1;
      for (const waiter of waiters ?? []) {
        const record = this.#waiters.get(waiter);
        if (record !== undefined) record.cooldownSkips += 1;
      }
    });
  }

  /**
   * Supervisor: these waiters are being released. When an attempt released them, each one is
   * bound to that attempt's record; a key that left the queue without one binds nothing.
   */
  waitersSettled(waiters: Iterable<object> | undefined, admission?: CatalogPlacementAdmissionV1): void {
    observe(() => {
      const attempt = admission === undefined ? undefined : this.#admissions.get(admission);
      if (attempt === undefined) return;
      for (const waiter of waiters ?? []) {
        const record = this.#waiters.get(waiter);
        if (record !== undefined) record.attempt = attempt;
      }
    });
  }

  /** Supervisor: a pass listed `depth` durable markers. */
  passStarted(depth: number): void {
    observe(() => {
      this.#depth = depth;
      this.#passStartedAt = this.#sources.clock();
    });
  }

  /** Supervisor: the pass, successful or not, is over. */
  passEnded(): void {
    observe(() => {
      if (this.#passStartedAt === undefined) return;
      this.#lastPassDurationMs = Math.max(0, Math.round(this.#sources.clock() - this.#passStartedAt));
      this.#passStartedAt = undefined;
    });
  }

  /** Supervisor status: aggregates only, from the waiters the supervisor holds. */
  queueStatus(
    waiters: ReadonlyMap<string, ReadonlySet<object>>,
    passRunning: boolean,
  ): Readonly<FinalizedPrivatePlacementQueueStatusV1> {
    let waiterCount = 0;
    let oldestRequestedAt: number | undefined;
    let now = Number.NaN;
    try {
      now = this.#sources.clock();
      for (const settles of waiters.values()) {
        waiterCount += settles.size;
        for (const settle of settles) {
          const requestedAt = this.#waiters.get(settle)?.requestedAt;
          if (requestedAt !== undefined && (oldestRequestedAt === undefined || requestedAt < oldestRequestedAt)) {
            oldestRequestedAt = requestedAt;
          }
        }
      }
    } catch { /* observation only */ }
    const oldestWaiterAgeMs = oldestRequestedAt === undefined || !Number.isFinite(now)
      ? null
      : Math.max(0, Math.round(now - oldestRequestedAt));
    return Object.freeze({
      depth: this.#depth,
      waiters: waiterCount,
      oldestWaiterAgeMs,
      passRunning,
      lastPassDurationMs: this.#lastPassDurationMs,
      cooldownSkips: this.#cooldownSkips,
    });
  }

  /** Repair body: the attempt in flight for this exact marker, or an inert one. */
  attemptFor(repair: object): CatalogPlacementAttemptV1 {
    try {
      const inFlight = this.#inFlight;
      if (inFlight === undefined || inFlight.repair !== repair || inFlight.record.endedAt !== undefined) {
        return INERT_CATALOG_PLACEMENT_ATTEMPT_V1;
      }
      const { record } = inFlight;
      const elapsedSince = (startedAt: number): number => {
        const elapsed = this.#sources.clock() - startedAt;
        return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
      };
      return {
        now: () => {
          try {
            return this.#sources.clock();
          } catch {
            return Number.NaN;
          }
        },
        phase: (phase, startedAt) => observe(() => {
          record.phaseMs[phase] += elapsedSince(startedAt);
        }),
        covered: (covered, startedAt) => observe(() => {
          record.phaseMs.coverage += elapsedSince(startedAt);
          record.covered = covered;
        }),
        announced: (delivery, startedAt) => observe(() => {
          record.phaseMs.announce += elapsedSince(startedAt);
          record.peers += delivery.announcedPeers.length + delivery.failedPeers.length;
          record.failedPeers += delivery.failedPeers.length;
          record.deniedPeers += delivery.failedPeers.filter(
            ({ error }) => error.startsWith(POLICY_DENIED_ERROR_PREFIX),
          ).length;
        }),
      };
    } catch {
      return INERT_CATALOG_PLACEMENT_ATTEMPT_V1;
    }
  }

  /** Observer: one post-confirmation observer call for `asset` starts now. */
  beginWait(asset: CatalogPlacementAssetV1, ctx: OperationContext): CatalogPlacementWaitV1 {
    try {
      const key = `${asset.kaUal}@${asset.assertionVersion}`;
      const observerCall = (this.#observerCalls.get(key) ?? 0) + 1;
      boundedSet(this.#observerCalls, key, observerCall);
      const startedAt = this.#sources.clock();
      let requested: Readonly<{ at: number; whenAttempted: object | null }> | undefined;
      return {
        requested: (whenAttempted) => observe(() => {
          requested = { at: this.#sources.clock(), whenAttempted };
        }),
        end: (log) => observe(() => {
          const totalMs = this.#sources.clock() - startedAt;
          if (!(totalMs >= this.#sources.logThresholdMs)) return;
          const waiter = requested?.whenAttempted ? this.#waiters.get(requested.whenAttempted) : undefined;
          log.info(ctx, describeWaitV1({
            asset,
            ctx,
            observerCall,
            startedAt,
            totalMs,
            requestedAt: waiter?.requestedAt ?? requested?.at,
            waiter,
          }));
        }),
      };
    } catch {
      return INERT_WAIT;
    }
  }
}

/**
 * The `rfc64_catalog_placement_wait` line. `requestedAt` is undefined on the public lane, which
 * never asks for a placement; `waiter` is undefined when the supervisor did not accept the request.
 */
function describeWaitV1(wait: Readonly<{
  asset: CatalogPlacementAssetV1;
  ctx: OperationContext;
  observerCall: number;
  startedAt: number;
  totalMs: number;
  requestedAt: number | undefined;
  waiter: PlacementWaiterRecordV1 | undefined;
}>): string {
  const { requestedAt } = wait;
  const attempt = wait.waiter?.attempt;
  const outcome = requestedAt === undefined
    ? 'not-awaited'
    : attempt === undefined ? 'no-attempt' : attempt.failed === true ? 'failed' : 'completed';
  const attemptEndedAt = attempt?.endedAt;
  const phaseTotal = attempt === undefined
    ? 0
    : CATALOG_PLACEMENT_PHASES.reduce((sum, phase) => sum + attempt.phaseMs[phase], 0);
  const fields: Array<[string, string]> = [
    ['ual', wait.asset.kaUal],
    ['version', wait.asset.assertionVersion],
    ['lane', requestedAt === undefined ? 'public' : 'finalized-private'],
    ['source', wait.ctx.sourceOperationId ?? '-'],
    ['observerCall', String(wait.observerCall)],
    ['outcome', outcome],
    ['totalMs', ms(wait.totalMs)],
    ['requestMs', requestedAt === undefined ? '-' : ms(requestedAt - wait.startedAt)],
    // A waiter that joined an attempt already in flight queued for nothing: queueMs clamps to 0
    // and its attemptMs counts from its own request.
    ['queueMs', attempt === undefined || requestedAt === undefined
      ? '-' : ms(attempt.admittedAt - requestedAt)],
    ['attemptMs', attempt === undefined || attemptEndedAt === undefined || requestedAt === undefined
      ? '-' : ms(attemptEndedAt - Math.max(attempt.admittedAt, requestedAt))],
    ...CATALOG_PLACEMENT_PHASES.map((phase): [string, string] => [
      `${phase}Ms`,
      attempt === undefined ? '-' : ms(attempt.phaseMs[phase]),
    ]),
    ['otherMs', attempt === undefined || attemptEndedAt === undefined
      ? '-' : ms(attemptEndedAt - attempt.admittedAt - phaseTotal)],
    ['peers', attempt === undefined ? '-' : String(attempt.peers)],
    ['failedPeers', attempt === undefined ? '-' : String(attempt.failedPeers)],
    ['deniedPeers', attempt === undefined ? '-' : String(attempt.deniedPeers)],
    ['covered', attempt?.covered === undefined ? '-' : String(attempt.covered)],
    ['cooldownSkips', requestedAt === undefined ? '-' : String(wait.waiter?.cooldownSkips ?? 0)],
  ];
  return `rfc64_catalog_placement_wait ${fields
    .map(([key, value]) => `${key}=${logfmtValue(value)}`)
    .join(' ')}`;
}

const TIMINGS_V1 = new WeakMap<object, CatalogPlacementTimingV1>();
const SHARED_OWNERS_V1 = new WeakMap<object, object>();

/** The placement timing of one agent, created on first use; an alias resolves to its owner. */
export function catalogPlacementTimingV1(owner: object): CatalogPlacementTimingV1 {
  const resolved = SHARED_OWNERS_V1.get(owner) ?? owner;
  let timing = TIMINGS_V1.get(resolved);
  if (timing === undefined) {
    timing = new CatalogPlacementTimingV1();
    TIMINGS_V1.set(resolved, timing);
  }
  return timing;
}

/** Make `alias` (for example the agent's projection owner) record into `owner`'s timing. */
export function shareCatalogPlacementTimingV1(alias: object, owner: object): void {
  SHARED_OWNERS_V1.set(alias, owner);
}

/** Replace `owner`'s timing, for example with an injected clock or threshold. */
export function installCatalogPlacementTimingV1(owner: object, timing: CatalogPlacementTimingV1): void {
  TIMINGS_V1.set(owner, timing);
}
