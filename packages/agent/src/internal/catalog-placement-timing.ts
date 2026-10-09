// SPDX-License-Identifier: Apache-2.0

import type { Logger, OperationContext } from '@origintrail-official/dkg-core';

/**
 * GH#3081 — where a confirmed publication waits for its RFC-64 catalog placement. Observation
 * only: no repair, admission or retry decision reads anything recorded here, every entry point
 * swallows its own failure, and the output is one log line per slow observer call plus an
 * aggregate, identity-free view of the finalized-private queue for `/api/status`.
 *
 * The finalized-private supervisor admits one repair at a time, so an agent has at most one
 * attempt in flight; the repair body charges its phases to it (the coverage check and asset
 * resolution in the projection; the locked state read, successor production, applied-head CAS and
 * announcement in the upsert). An observer call waits from its entry until the next attempt for its
 * asset ends. Its line splits that wait into the time to request the repair (the asset lock and the
 * durable marker write), the time queued in the supervisor (earlier markers, cooldown, the next
 * pass) and the attempt, which is broken down by phase; `otherMs` is the attempt time no phase
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

/** What the repair body charges its phases to: the in-flight attempt for its asset, or nothing. */
export interface CatalogPlacementAttemptV1 {
  now(): number;
  phase(phase: CatalogPlacementPhase, startedAt: number): void;
  covered(covered: boolean, startedAt: number): void;
  announced(delivery: CatalogPlacementDeliveryV1, startedAt: number): void;
}

/** One observer call's wait. */
export interface CatalogPlacementWaitV1 {
  /** The observer has asked the supervisor to place the asset and will wait for the attempt. */
  requested(): void;
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
  readonly asset: string;
  readonly admittedAt: number;
  endedAt?: number;
  failed?: boolean;
  covered?: boolean;
  readonly phaseMs: Record<CatalogPlacementPhase, number>;
  peers: number;
  failedPeers: number;
  deniedPeers: number;
}

export const INERT_CATALOG_PLACEMENT_ATTEMPT_V1: CatalogPlacementAttemptV1 = Object.freeze({
  now: () => 0,
  phase: () => {},
  covered: () => {},
  announced: () => {},
});

const INERT_ADMISSION: CatalogPlacementAdmissionV1 = Object.freeze({ end: () => {} });
const INERT_WAIT: CatalogPlacementWaitV1 = Object.freeze({ requested: () => {}, end: () => {} });

function assetKeyV1(asset: CatalogPlacementAssetV1): string {
  return `${asset.kaUal}@${asset.assertionVersion}`;
}

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
  readonly #attempts = new Map<string, PlacementAttemptRecordV1>();
  readonly #cooldownSkipsByAsset = new Map<string, number>();
  readonly #observerCalls = new Map<string, number>();
  readonly #waitingSince = new Map<string, number>();
  #current: PlacementAttemptRecordV1 | undefined;
  #depth = 0;
  #passStartedAt: number | undefined;
  #lastPassDurationMs: number | null = null;
  #cooldownSkips = 0;

  constructor(sources: Partial<CatalogPlacementTimingSourcesV1> = {}) {
    this.#sources = { ...DEFAULT_SOURCES, ...sources };
  }

  /** Supervisor: one attempt for `repair` starts now; it is this agent's attempt in flight. */
  admit(repair: CatalogPlacementAssetV1): CatalogPlacementAdmissionV1 {
    try {
      const record: PlacementAttemptRecordV1 = {
        asset: assetKeyV1(repair),
        admittedAt: this.#sources.clock(),
        phaseMs: Object.fromEntries(CATALOG_PLACEMENT_PHASES.map((phase) => [phase, 0])) as
          Record<CatalogPlacementPhase, number>,
        peers: 0,
        failedPeers: 0,
        deniedPeers: 0,
      };
      boundedSet(this.#attempts, record.asset, record);
      this.#current = record;
      return {
        end: (outcome) => observe(() => {
          record.endedAt = this.#sources.clock();
          record.failed = outcome === 'failed';
          if (this.#current === record) this.#current = undefined;
        }),
      };
    } catch {
      return INERT_ADMISSION;
    }
  }

  /** Supervisor: a pass skipped `repair` because its retry cooldown had not elapsed. */
  cooldownSkipped(repair: CatalogPlacementAssetV1): void {
    observe(() => {
      const asset = assetKeyV1(repair);
      boundedSet(this.#cooldownSkipsByAsset, asset, (this.#cooldownSkipsByAsset.get(asset) ?? 0) + 1);
      this.#cooldownSkips += 1;
    });
  }

  /** Supervisor: a waiter was accepted for `key`; the first one opens the key's wait. */
  waiterAdded(key: string, first: boolean): void {
    observe(() => {
      if (first || !this.#waitingSince.has(key)) boundedSet(this.#waitingSince, key, this.#sources.clock());
    });
  }

  /** Supervisor: every waiter for `key` was released. */
  waitersSettled(key: string): void {
    observe(() => {
      this.#waitingSince.delete(key);
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

  /** Supervisor status: aggregates only, from waiters the supervisor already holds. */
  queueStatus(
    waiters: ReadonlyMap<string, ReadonlySet<unknown>>,
    passRunning: boolean,
  ): Readonly<FinalizedPrivatePlacementQueueStatusV1> {
    let waiterCount = 0;
    let oldestWaitingSince: number | undefined;
    let now = Number.NaN;
    try {
      now = this.#sources.clock();
      for (const [key, settles] of waiters) {
        waiterCount += settles.size;
        const since = this.#waitingSince.get(key);
        if (since !== undefined && (oldestWaitingSince === undefined || since < oldestWaitingSince)) {
          oldestWaitingSince = since;
        }
      }
    } catch { /* observation only */ }
    const oldestWaiterAgeMs = oldestWaitingSince === undefined || !Number.isFinite(now)
      ? null
      : Math.max(0, Math.round(now - oldestWaitingSince));
    return Object.freeze({
      depth: this.#depth,
      waiters: waiterCount,
      oldestWaiterAgeMs,
      passRunning,
      lastPassDurationMs: this.#lastPassDurationMs,
      cooldownSkips: this.#cooldownSkips,
    });
  }

  /** Repair body: the attempt in flight for `asset`, or an inert one outside a supervisor attempt. */
  attemptFor(asset: CatalogPlacementAssetV1): CatalogPlacementAttemptV1 {
    try {
      const record = this.#current;
      if (record === undefined || record.endedAt !== undefined || record.asset !== assetKeyV1(asset)) {
        return INERT_CATALOG_PLACEMENT_ATTEMPT_V1;
      }
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
      const key = assetKeyV1(asset);
      const observerCall = (this.#observerCalls.get(key) ?? 0) + 1;
      boundedSet(this.#observerCalls, key, observerCall);
      const startedAt = this.#sources.clock();
      let requestedAt: number | undefined;
      let skipsAtRequest = 0;
      return {
        requested: () => observe(() => {
          requestedAt = this.#sources.clock();
          skipsAtRequest = this.#cooldownSkipsByAsset.get(key) ?? 0;
        }),
        end: (log) => observe(() => {
          const totalMs = this.#sources.clock() - startedAt;
          if (!(totalMs >= this.#sources.logThresholdMs)) return;
          log.info(ctx, this.#describeWait({
            asset,
            key,
            ctx,
            observerCall,
            startedAt,
            requestedAt,
            totalMs,
            cooldownSkips: (this.#cooldownSkipsByAsset.get(key) ?? 0) - skipsAtRequest,
          }));
        }),
      };
    } catch {
      return INERT_WAIT;
    }
  }

  #describeWait(wait: Readonly<{
    asset: CatalogPlacementAssetV1;
    key: string;
    ctx: OperationContext;
    observerCall: number;
    startedAt: number;
    requestedAt: number | undefined;
    totalMs: number;
    cooldownSkips: number;
  }>): string {
    const { requestedAt } = wait;
    const record = requestedAt === undefined ? undefined : this.#attempts.get(wait.key);
    // Only an attempt that ended after this request settled this waiter: a record left by an
    // earlier observer call for the same asset (the detached path calls twice) is not this wait's.
    const attempt = record?.endedAt !== undefined && requestedAt !== undefined && record.endedAt >= requestedAt
      ? record
      : undefined;
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
      ['cooldownSkips', requestedAt === undefined ? '-' : String(Math.max(0, wait.cooldownSkips))],
    ];
    return `rfc64_catalog_placement_wait ${fields
      .map(([key, value]) => `${key}=${logfmtValue(value)}`)
      .join(' ')}`;
  }
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
