// SPDX-License-Identifier: Apache-2.0

import type { Logger, OperationContext } from '@origintrail-official/dkg-core';

import { rememberBounded } from '../bounded-map.js';
import type { Rfc64PublicCatalogTransportErrorCodeV1 } from '../rfc64/public-catalog-transport-v1.js';

/**
 * GH#3081 — how long a confirmed publication's RFC-64 catalog placement takes, and how many
 * placements are owed. Observation only: no repair, admission or retry decision reads anything
 * recorded here, every entry point swallows its own failure, and the output is one log line per
 * slow placement request plus an aggregate, identity-free view of the finalized-private queue for
 * `/api/status`.
 *
 * Nothing waits for a placement. The post-confirmation observer stores the durable marker, asks
 * the supervisor for the placement and returns; the publication is terminal from there. The line
 * is therefore written when the supervisor releases the request after its first attempt, not when
 * the observer returns, and the backlog is counted from the markers that are owed, not from callers.
 *
 * Everything travels explicitly with the work the supervisor already owns. An observer call hands
 * its wait's `observer` to the supervisor with its request; the supervisor keeps it beside the
 * waiter's settle callback and tells it about the cooldown skips the request sits through and the
 * attempt that releases it. An admitted attempt returns a recorder that the supervisor passes to
 * the repair body beside the data-only marker, and the body charges its phases to it (the coverage
 * check and asset resolution in the projection; the locked state read, successor production,
 * applied-head CAS and announcement in the upsert). Nothing is matched by object identity or relies
 * on how many repairs run at once; a repair run outside the supervisor reports to the inert
 * recorder, so a line describes exactly the attempt that released its call's request. It splits
 * the time from the observer call to the end of that attempt into the time to request the
 * placement (the durable marker write), the time queued in the supervisor (earlier markers,
 * cooldown, the next pass) and the attempt, broken down by phase; `otherMs` is the attempt time no
 * phase claims (lock waits, lane and inventory reads, marker deletion). Per-send announcement
 * timing is not measured: the announce phase is the whole sequential fan-out, with peer and
 * failure counts.
 */

/** A placement request that takes this long or longer writes its line; shorter ones write nothing. */
export const CATALOG_PLACEMENT_WAIT_LOG_THRESHOLD_MS = 5_000;
const MAX_TRACKED_ENTRIES = 512;
/** Owed markers remembered between supervisor passes; a pass replaces them with what it listed. */
const MAX_OWED_BETWEEN_PASSES = 4_096;
const POLICY_DENIED_CODE: Rfc64PublicCatalogTransportErrorCodeV1 = 'catalog-transport-policy-denied';

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

/** An announcement's delivery; a failure's `code` is the transport's own typed classification. */
export interface CatalogPlacementDeliveryV1 {
  readonly announcedPeers: readonly unknown[];
  readonly failedPeers: readonly Readonly<{ readonly code?: Rfc64PublicCatalogTransportErrorCodeV1 }>[];
}

/** What one admitted attempt recorded, read by the waiters it releases. */
export interface CatalogPlacementAttemptRecordV1 {
  readonly admittedAt: number;
  endedAt?: number;
  failed?: boolean;
  covered?: boolean;
  readonly phaseMs: Record<CatalogPlacementPhase, number>;
  peers: number;
  failedPeers: number;
  deniedPeers: number;
}

/** What the supervisor holds for the attempt it admitted. */
export interface CatalogPlacementAdmissionV1 {
  /** The recorder the supervisor passes to the repair body, beside the data-only marker. */
  readonly attempt: CatalogPlacementAttemptV1;
  /** What the attempt recorded; absent when observation itself failed, which reads as no attempt. */
  readonly record?: Readonly<CatalogPlacementAttemptRecordV1>;
  /** `completed` means the marker is gone: the placement is no longer owed. */
  end(outcome: 'completed' | 'failed'): void;
}

/** What the supervisor tells the observer call that requested a waiter about that waiter. */
export interface CatalogPlacementWaiterObserverV1 {
  /** A pass skipped the waiter's repair because its retry cooldown had not elapsed. */
  cooldownSkipped(): void;
  /**
   * The supervisor released the request: after `admission`'s attempt, or with none (its marker
   * left the queue, the supervisor closed, or it refused the request outright).
   */
  released(admission?: CatalogPlacementAdmissionV1): void;
}

/** What the repair body charges its phases to: its admitted attempt, or the inert recorder. */
export interface CatalogPlacementAttemptV1 {
  now(): number;
  /**
   * Await `work` as `phase`, charging the time since `startedAt` (default: now) to it whether the
   * work resolves or rejects. What `work` returns or throws passes through unchanged.
   */
  measure<T>(phase: CatalogPlacementPhase, work: () => Promise<T>, startedAt?: number): Promise<T>;
  /** The coverage check's answer, apart from its duration. */
  covered(covered: boolean): void;
  /** The announcement's delivery counts, apart from its duration. */
  announced(delivery: CatalogPlacementDeliveryV1): void;
}

/** One observer call, and the placement request it made. */
export interface CatalogPlacementWaitV1 {
  /** Handed to the supervisor with this call's request; told about the waiter it registers. */
  readonly observer: CatalogPlacementWaiterObserverV1;
  /** The observer is asking the supervisor for a placement now, with this wait's `observer`. */
  requested(): void;
  /**
   * The observer is returning. A request the supervisor still holds writes its line when the
   * supervisor releases it; any other call writes it now. Either way only at the threshold.
   */
  end(log: Pick<Logger, 'info'>): void;
}

/** Aggregate finalized-private queue evidence; no UAL, author or graph id. */
export interface FinalizedPrivatePlacementQueueStatusV1 {
  /** Markers the most recent supervisor pass listed (never a fresh read). */
  readonly depth: number;
  /**
   * Placements owed right now: the markers the latest pass listed and has not placed, and the
   * markers stored since. This is the backlog; no caller waits on it.
   */
  readonly pending: number;
  /**
   * How long this process has known of the oldest pending placement, from its request or from
   * the first pass that listed it; a marker that survived a restart counts from that pass.
   */
  readonly oldestPendingAgeMs: number | null;
  /** Accepted requests whose first attempt has not ended. */
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

export const INERT_CATALOG_PLACEMENT_ATTEMPT_V1: CatalogPlacementAttemptV1 = Object.freeze({
  now: () => 0,
  measure: <T>(_phase: unknown, work: () => Promise<T>) => work(),
  covered: () => {},
  announced: () => {},
});

const INERT_ADMISSION: CatalogPlacementAdmissionV1 = Object.freeze({
  attempt: INERT_CATALOG_PLACEMENT_ATTEMPT_V1,
  end: () => {},
});
const INERT_WAIT: CatalogPlacementWaitV1 = Object.freeze({
  observer: Object.freeze({ cooldownSkipped: () => {}, released: () => {} }),
  requested: () => {},
  end: () => {},
});

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
  readonly #observerCalls = new Map<string, number>();
  /** When this process first knew of each placement still owed, by the supervisor's marker key. */
  readonly #owedSince = new Map<string, number>();
  #depth = 0;
  #passStartedAt: number | undefined;
  #lastPassDurationMs: number | null = null;
  #cooldownSkips = 0;

  constructor(sources: Partial<CatalogPlacementTimingSourcesV1> = {}) {
    this.#sources = { ...DEFAULT_SOURCES, ...sources };
  }

  /** The timing clock, for the supervisor's waiter request times; NaN when it fails. */
  now(): number {
    try {
      return this.#sources.clock();
    } catch {
      return Number.NaN;
    }
  }

  /** Supervisor: a durable marker exists for `key`, whether or not its request is then accepted. */
  owed(key: string): void {
    observe(() => {
      if (this.#owedSince.has(key) || this.#owedSince.size >= MAX_OWED_BETWEEN_PASSES) return;
      this.#owedSince.set(key, this.#sources.clock());
    });
  }

  /**
   * Supervisor: one attempt at the marker `key` starts now; its recorder travels to the repair
   * body explicitly.
   */
  admit(key?: string): CatalogPlacementAdmissionV1 {
    try {
      const record: CatalogPlacementAttemptRecordV1 = {
        admittedAt: this.#sources.clock(),
        phaseMs: Object.fromEntries(CATALOG_PLACEMENT_PHASES.map((phase) => [phase, 0])) as
          Record<CatalogPlacementPhase, number>,
        peers: 0,
        failedPeers: 0,
        deniedPeers: 0,
      };
      const admission: CatalogPlacementAdmissionV1 = {
        attempt: this.#recorder(record),
        record,
        end: (outcome) => observe(() => {
          record.failed = outcome === 'failed';
          if (outcome === 'completed' && key !== undefined) this.#owedSince.delete(key);
          record.endedAt = this.#sources.clock();
        }),
      };
      return Object.freeze(admission);
    } catch {
      return INERT_ADMISSION;
    }
  }

  /** Supervisor: a pass skipped a marker because its retry cooldown had not elapsed. */
  cooldownSkipped(): void {
    observe(() => {
      this.#cooldownSkips += 1;
    });
  }

  /** Supervisor: a pass listed the durable markers with these keys; exactly they are owed now. */
  passStarted(listed: ReadonlySet<string>): void {
    observe(() => {
      this.#depth = listed.size;
      const now = this.#sources.clock();
      this.#passStartedAt = now;
      for (const key of this.#owedSince.keys()) {
        if (!listed.has(key)) this.#owedSince.delete(key);
      }
      for (const key of listed) {
        if (!this.#owedSince.has(key)) this.#owedSince.set(key, now);
      }
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

  /** Supervisor status: aggregates only, from the markers owed and the requests the supervisor holds. */
  queueStatus(
    waiters: Readonly<{ count: number; oldestRequestedAt: number | undefined }>,
    passRunning: boolean,
  ): Readonly<FinalizedPrivatePlacementQueueStatusV1> {
    const now = this.now();
    const ageMs = (since: number | undefined): number | null => (
      since === undefined || !Number.isFinite(now - since) ? null : Math.max(0, Math.round(now - since))
    );
    let oldestOwedSince: number | undefined;
    for (const since of this.#owedSince.values()) {
      if (oldestOwedSince === undefined || since < oldestOwedSince) oldestOwedSince = since;
    }
    return Object.freeze({
      depth: this.#depth,
      pending: this.#owedSince.size,
      oldestPendingAgeMs: ageMs(oldestOwedSince),
      waiters: waiters.count,
      oldestWaiterAgeMs: ageMs(waiters.oldestRequestedAt),
      passRunning,
      lastPassDurationMs: this.#lastPassDurationMs,
      cooldownSkips: this.#cooldownSkips,
    });
  }

  /** The repair body's view of one admitted attempt: it charges phases to that record only. */
  #recorder(record: CatalogPlacementAttemptRecordV1): CatalogPlacementAttemptV1 {
    const elapsedSince = (startedAt: number): number => {
      const elapsed = this.#sources.clock() - startedAt;
      return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
    };
    const recorder: CatalogPlacementAttemptV1 = {
      now: () => {
        try {
          return this.#sources.clock();
        } catch {
          return Number.NaN;
        }
      },
      measure: async (phase, work, startedAt) => {
        const start = startedAt ?? recorder.now();
        try {
          return await work();
        } finally {
          observe(() => {
            record.phaseMs[phase] += elapsedSince(start);
          });
        }
      },
      covered: (covered) => observe(() => {
        record.covered = covered;
      }),
      announced: (delivery) => observe(() => {
        record.peers += delivery.announcedPeers.length + delivery.failedPeers.length;
        record.failedPeers += delivery.failedPeers.length;
        record.deniedPeers += delivery.failedPeers.filter(({ code }) => code === POLICY_DENIED_CODE).length;
      }),
    };
    return Object.freeze(recorder);
  }

  /** Observer: one post-confirmation observer call for `asset` starts now. */
  beginWait(asset: CatalogPlacementAssetV1, ctx: OperationContext): CatalogPlacementWaitV1 {
    try {
      const key = `${asset.kaUal}@${asset.assertionVersion}`;
      const observerCall = (this.#observerCalls.get(key) ?? 0) + 1;
      rememberBounded(this.#observerCalls, key, observerCall, MAX_TRACKED_ENTRIES);
      const startedAt = this.#sources.clock();
      let requestedAt: number | undefined;
      let cooldownSkips = 0;
      let attempt: Readonly<CatalogPlacementAttemptRecordV1> | undefined;
      // The observer does not wait for the placement: the supervisor usually still holds the
      // request when the observer returns, and the line is then written at the release.
      let released = false;
      let held = false;
      let logAtRelease: Pick<Logger, 'info'> | undefined;
      const writeLine = (log: Pick<Logger, 'info'>): void => {
        const totalMs = this.#sources.clock() - startedAt;
        if (!(totalMs >= this.#sources.logThresholdMs)) return;
        log.info(ctx, describeWaitV1({
          asset, ctx, observerCall, startedAt, totalMs, requestedAt, cooldownSkips, attempt,
        }));
      };
      return Object.freeze({
        observer: Object.freeze({
          cooldownSkipped: () => observe(() => {
            cooldownSkips += 1;
          }),
          released: (admission?: CatalogPlacementAdmissionV1) => observe(() => {
            if (admission?.record !== undefined) attempt = admission.record;
            released = true;
            held = false;
            const log = logAtRelease;
            logAtRelease = undefined;
            if (log !== undefined) writeLine(log);
          }),
        }),
        requested: () => observe(() => {
          held = !released;
          requestedAt = this.#sources.clock();
        }),
        end: (log: Pick<Logger, 'info'>) => observe(() => {
          if (held) logAtRelease = log;
          else writeLine(log);
        }),
      });
    } catch {
      return INERT_WAIT;
    }
  }
}

/**
 * The `rfc64_catalog_placement_wait` line: the time from one observer call to the end of the
 * attempt that released its request. `requestedAt` is undefined on the public lane, which never
 * asks for a placement; `attempt` is undefined when no attempt released the call's waiter.
 */
function describeWaitV1(wait: Readonly<{
  asset: CatalogPlacementAssetV1;
  ctx: OperationContext;
  observerCall: number;
  startedAt: number;
  totalMs: number;
  requestedAt: number | undefined;
  cooldownSkips: number;
  attempt: Readonly<CatalogPlacementAttemptRecordV1> | undefined;
}>): string {
  const { requestedAt, attempt } = wait;
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
    ['cooldownSkips', requestedAt === undefined ? '-' : String(wait.cooldownSkips)],
  ];
  return `rfc64_catalog_placement_wait ${fields
    .map(([key, value]) => `${key}=${logfmtValue(value)}`)
    .join(' ')}`;
}

const TIMINGS_V1 = new WeakMap<object, CatalogPlacementTimingV1>();

/** The placement timing of one agent (or standalone supervisor), created on first use. */
export function catalogPlacementTimingV1(owner: object): CatalogPlacementTimingV1 {
  let timing = TIMINGS_V1.get(owner);
  if (timing === undefined) {
    timing = new CatalogPlacementTimingV1();
    TIMINGS_V1.set(owner, timing);
  }
  return timing;
}

/** Replace `owner`'s timing, for example with an injected clock or threshold. */
export function installCatalogPlacementTimingV1(owner: object, timing: CatalogPlacementTimingV1): void {
  TIMINGS_V1.set(owner, timing);
}
