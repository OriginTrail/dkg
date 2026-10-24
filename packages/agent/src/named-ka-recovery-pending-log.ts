// SPDX-License-Identifier: Apache-2.0

/**
 * The `Named KA recovery ... remains pending` warning, rate-limited.
 *
 * A confirmed publish whose local finalization is deferred is asked again on
 * every recovery tick for as long as the cause lasts. One line per tick and
 * asset buries that cause, and when the cause is a chain endpoint nothing told
 * the operator that the remedy is theirs.
 *
 * Per asset: one line when a reason first appears or changes. Per reason,
 * across assets: a summary every {@link NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS}
 * while it keeps deferring. And once per uninterrupted run of deferrals that
 * the chain endpoints are named for: one line for the operator, saying what is
 * not finalizing, why, and what to do.
 *
 * It decides which lines are logged and nothing else: the caller rethrows the
 * recovery's own error whatever happens here. What a deferral is about comes
 * from the fields the recovery sets (named-ka-recovery-diagnostics.ts), not
 * from its message.
 */

import { rememberBounded } from './bounded-map.js';
import {
  namedKaRecoveryDiagnostics,
  versionViewBlockingEndpoints,
} from './named-ka-recovery-diagnostics.js';

/** Summary cadence per reason. The chain layer's failover log uses the same window. */
export const NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS = 5 * 60_000;

/**
 * How long the chain endpoints must be the named cause of every deferral of the
 * assets they hold, whatever each failed with, and with no version view read in
 * between, before the operator is told to act.
 *
 * Recovery is asked again at the active reconciliation cadence (5 s by
 * default), so five minutes is dozens of failed reads in a row: longer than a
 * provider's rate-limit window or restart, and as long as the chain layer's
 * failover log window. The publish is already confirmed on chain, so the wait
 * loses nothing; the remedy is usually a configuration change and a restart,
 * which is not something to ask for on a blip.
 */
export const NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_AFTER_MS = 5 * 60_000;

/**
 * And at least this many deferrals in the run, counted once per recovery tick
 * however many assets the tick defers, so that two samples either side of a
 * suspended process cannot stand in for a sustained one.
 */
export const NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_MIN_DEFERRALS = 12;

/** Ceilings, not working sizes: an asset leaves when it finalizes, and the oldest entry goes first. */
const MAX_TRACKED_ASSETS = 4_096;
const MAX_TRACKED_REASONS = 256;

export interface NamedKaRecoveryPendingAsset {
  readonly contextGraphId: string;
  readonly name: string;
  readonly subGraphName?: string;
}

export interface NamedKaRecoveryPendingLogOptions {
  /** Clock (ms). Injected for deterministic tests. */
  now?: () => number;
  summaryIntervalMs?: number;
  escalateAfterMs?: number;
  escalateMinDeferrals?: number;
}

interface AssetEntry {
  reason: string;
  lastAt: number;
  /** Whether the endpoints were named as the cause of its latest deferral. */
  endpointsNamed: boolean;
}

interface ReasonEntry {
  /** First and latest deferral of this run, and how many it holds. */
  since: number;
  lastAt: number;
  deferrals: number;
  /** When a summary (or the operator line) last reported it. */
  reportedAt: number;
  /** The endpoints named as the cause, when the reason names any. */
  blockedBy?: string;
}

/**
 * The run of deferrals the chain endpoints are named for, across assets and whatever each
 * endpoint failed with: each failure is a reason of its own, with its own summaries, but an
 * outage whose failure changes from one tick to the next is one run and one operator line.
 * A version view read ends it, and so does an asset it held deferring for something else.
 */
interface EndpointRun {
  /** First and latest deferral of the run. */
  since: number;
  lastAt: number;
  /** Recovery ticks with a deferral in the run, and the assets the latest of them deferred. */
  ticks: number;
  tickAssets: Set<string>;
  escalated: boolean;
}

export class NamedKaRecoveryPendingLog {
  readonly #now: () => number;
  readonly #summaryIntervalMs: number;
  readonly #escalateAfterMs: number;
  readonly #escalateMinDeferrals: number;
  readonly #assets = new Map<string, AssetEntry>();
  readonly #reasons = new Map<string, ReasonEntry>();
  #endpointRun: EndpointRun | undefined;

  constructor(options: NamedKaRecoveryPendingLogOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#summaryIntervalMs = options.summaryIntervalMs ?? NAMED_KA_RECOVERY_PENDING_SUMMARY_INTERVAL_MS;
    this.#escalateAfterMs = options.escalateAfterMs ?? NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_AFTER_MS;
    this.#escalateMinDeferrals = options.escalateMinDeferrals
      ?? NAMED_KA_RECOVERY_ENDPOINT_ESCALATION_MIN_DEFERRALS;
  }

  /** A recovery of `asset` was deferred with `error`. Logs what is due through `warn`. */
  deferred(asset: NamedKaRecoveryPendingAsset, error: unknown, warn: (line: string) => void): void {
    const message = error instanceof Error ? error.message : String(error);
    const line = `Named KA recovery for "${asset.name}" remains pending: ${message}`;
    let due: string[];
    try {
      due = this.#due(asset, error, message, line);
    } catch {
      // The warning matters more than its rate limit.
      due = [line];
    }
    for (const text of due) warn(text);
  }

  /** A recovery of `asset` finalized. Never throws: the finalization stands whatever happens here. */
  finalized(asset: NamedKaRecoveryPendingAsset): void {
    if (this.#assets.size === 0) return;
    try {
      this.#assets.delete(assetKey(asset));
    } catch {
      // Bookkeeping for a log line.
    }
  }

  /**
   * A recovery read a version view: an endpoint answered. A run of deferrals
   * that the endpoints were named for is over, and the next one counts from its
   * own start. A finalization alone does not show this (evidence that predates
   * the position check settles without a view), so it is reported separately.
   */
  versionViewRead(): void {
    this.#endpointRun = undefined;
    if (this.#reasons.size === 0) return;
    for (const [reason, entry] of this.#reasons) {
      if (entry.blockedBy !== undefined) this.#reasons.delete(reason);
    }
  }

  #due(
    asset: NamedKaRecoveryPendingAsset,
    error: unknown,
    message: string,
    line: string,
  ): string[] {
    const now = this.#now();
    const diagnostics = namedKaRecoveryDiagnostics(error);
    // The recovery's own reason is the same for every asset one cause holds, so they share
    // a summary. An error from elsewhere has only its message.
    const reason = diagnostics.pendingReason ?? message;
    const blockedBy = versionViewBlockingEndpoints(diagnostics.versionViewUnavailable);
    const due: string[] = [];

    const key = assetKey(asset);
    const seen = this.#assets.get(key);
    if (seen === undefined || seen.reason !== reason || now - seen.lastAt > this.#summaryIntervalMs) {
      due.push(line);
    }
    const endpointsNamed = blockedBy !== undefined;
    rememberBounded(this.#assets, key, { reason, lastAt: now, endpointsNamed }, MAX_TRACKED_ASSETS);

    let entry = this.#reasons.get(reason);
    // A reason not seen for a summary interval is a new run, not a continuation.
    if (entry === undefined || now - entry.lastAt > this.#summaryIntervalMs) {
      entry = {
        since: now,
        lastAt: now,
        deferrals: 0,
        reportedAt: now,
        blockedBy,
      };
    }
    entry.lastAt = now;
    entry.deferrals += 1;
    rememberBounded(this.#reasons, reason, entry, MAX_TRACKED_REASONS);

    let run: EndpointRun | undefined;
    if (endpointsNamed) {
      run = this.#continueEndpointRun(key, now);
    } else if (seen?.endpointsNamed === true) {
      // An asset the endpoints were named for now defers for something else (a deadline, the
      // node's own request budget): they are not the cause of every deferral, and their run is
      // over. An asset they were never named for says nothing about them either way.
      this.#endpointRun = undefined;
    }

    if (
      run !== undefined
      && !run.escalated
      && now - run.since >= this.#escalateAfterMs
      && run.ticks >= this.#escalateMinDeferrals
    ) {
      run.escalated = true;
      const pending = this.#pending(now, (tracked) => tracked.endpointsNamed);
      due.push(
        'Operator action needed: publishes confirmed on chain are not finalizing on this node '
        + `(${pending} pending, ${minutesSince(run.since, now)} min). No configured chain endpoint `
        + `supplies the current version at one pinned block: ${blockedBy}. Fix an endpoint `
        + 'named here, or replace it in the chain RPC configuration (rpcUrl / rpcUrls) and '
        + 'restart the node; the pending publishes then finalize without being sent again.',
      );
    } else if (now - entry.reportedAt >= this.#summaryIntervalMs) {
      const pending = this.#pending(now, (tracked) => tracked.reason === reason);
      due.push(
        `Named KA recovery remains pending for ${pending} asset(s) after `
        + `${minutesSince(entry.since, now)} min (${entry.deferrals} deferrals): ${reason}`,
      );
    } else {
      return due;
    }
    entry.reportedAt = now;
    return due;
  }

  /**
   * The endpoints' run, one deferral longer. One not extended for a summary interval is over,
   * as a reason's is.
   */
  #continueEndpointRun(key: string, now: number): EndpointRun {
    let run = this.#endpointRun;
    if (run === undefined || now - run.lastAt > this.#summaryIntervalMs) {
      run = { since: now, lastAt: now, ticks: 1, tickAssets: new Set(), escalated: false };
      this.#endpointRun = run;
    }
    // The minimum counts recovery ticks, not deferrals: one tick defers every pending asset, so
    // a burst across many of them is one sample. A tick asks each asset once, so an asset the
    // current tick has deferred, deferring again, opens the next one. That holds at any cadence,
    // where spacing the samples in time would have to assume one.
    if (run.tickAssets.has(key)) {
      run.ticks += 1;
      run.tickAssets.clear();
    }
    // Past the ceiling an asset is not remembered; those that are still open the next tick.
    if (run.tickAssets.size < MAX_TRACKED_ASSETS) run.tickAssets.add(key);
    run.lastAt = now;
    return run;
  }

  /** Assets deferred within the last summary interval whose latest deferral `held` accepts. */
  #pending(now: number, held: (asset: AssetEntry) => boolean): number {
    let count = 0;
    for (const entry of this.#assets.values()) {
      if (held(entry) && now - entry.lastAt <= this.#summaryIntervalMs) count += 1;
    }
    return count;
  }
}

function assetKey(asset: NamedKaRecoveryPendingAsset): string {
  return JSON.stringify([asset.contextGraphId, asset.subGraphName ?? '', asset.name]);
}

function minutesSince(since: number, now: number): number {
  return Math.round((now - since) / 60_000);
}
