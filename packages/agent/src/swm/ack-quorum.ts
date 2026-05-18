/**
 * SWM ack-quorum overlay (rc.9 PR-D, RFC-003 §4.2 + §5).
 *
 * Sits beside `executeSubstrateFanOut` (PR-C) and the
 * `publishWorkspaceGossip` egress point. Closes the per-recipient
 * visibility gap that PR-C left open for the gossip path: substrate
 * fan-out gets per-peer confirmation for free (each
 * `messenger.sendReliable` returns a `delivered` flag), but the
 * gossip leg of every share is fire-and-forget. For curated CGs
 * (PR-C codex R2 made gossip the universal baseline) and for
 * public CGs with members above `maxSubstrateMembers`, this
 * component is what surfaces "who got the share" at the protocol
 * level.
 *
 * Design choices, in order of importance:
 *
 *   1. **Substrate-acked peers pre-populate the `acked` set.**
 *      A share that goes out via gossip + substrate ends up with
 *      the substrate-delivered peers already counted as acked,
 *      so the gossip-side `SwmShareAck` arrivals only fill in the
 *      gossip-only-delivery-path subset of expectedMembers. This
 *      gives one unified per-share quorum number that's not
 *      double-counted across the two transports.
 *
 *   2. **No own timer.** The component exposes `tick(nowMs)` and
 *      the caller (DKGAgent) wires it to a `setInterval`. Keeps
 *      this module clock-pure for testing — every state
 *      transition is deterministic on `track` / `onAck` / `tick`
 *      inputs.
 *
 *   3. **Watchdog fires once per re-arm window.** The first `tick`
 *      after `watchdogArmedAtMs + watchdogMs` AND quorum-not-yet-met
 *      dispatches the substrate top-up. Subsequent ticks before
 *      the next re-arm don't re-fire — if the top-up's wire
 *      layer succeeded (`delivered` or permanent `rejected`)
 *      there's no signal that further top-ups would help, and
 *      hammering at every interval just amplifies wire-load for
 *      no benefit (the substrate outbox owns retry for
 *      `queued` / `inFlight` outcomes).
 *
 *      The PR-H exception: when the receiver returns the
 *      `FANOUT_RESPONSE_RETRYABLE` (0x02) sentinel — meaning
 *      "transient apply error, retry later" — the outbox sees
 *      `delivered: true` at the wire level and WON'T retry.
 *      For those outcomes the caller (DKGAgent.swmSubstrateTopUp)
 *      explicitly calls {@link rearmWatchdog} so the next tick
 *      fires another top-up `watchdogMs` later, giving upstream
 *      state more time to converge. The hard deadline
 *      (`startedAtMs + deadlineHardMs`) is immutable — re-arming
 *      doesn't extend the total tracking lifetime.
 *
 *   4. **Deadline reaps records.** At `startedAtMs + deadlineHardMs`,
 *      a record is dropped from tracking regardless of ack state.
 *      Offline peers fall through to `runSyncOnConnect` (the
 *      catch-up safety net that PR-E migrated onto the reliable
 *      substrate). Bounds in-memory state size per share: a record
 *      lives for at most `deadlineHardMs` (default 5 minutes).
 *
 *   5. **In-memory only in PR-D.** No SQLite journal. A daemon
 *      crash mid-share loses the tracking state but NOT the share
 *      itself — the gossip publish already went out, the
 *      substrate sends already enqueued into the outbox. The
 *      worst case post-restart is "we don't run the watchdog
 *      top-up for shares that were in flight at crash time" —
 *      `runSyncOnConnect` covers those receivers when they next
 *      connect. Persistent journaling is RFC §5.2 future work
 *      (likely PR-G or PR-H), gated on whether the soak shows
 *      crash-loss is a material reliability hit.
 *
 *   6. **Caller owns ack-emission policy.** This component does
 *      NOT send `SwmShareAck` itself — the receiver-side wiring
 *      in `SharedMemoryHandler` is what calls
 *      `messenger.sendReliable(authorPeer, PROTOCOL_SWM_SHARE_ACK, ...)`
 *      after a successful gossip apply. Decoupled because the
 *      receiver doesn't have an `SwmAckQuorum` instance — it's a
 *      sender-side concept.
 */

import type { CGMemberEnumeration } from './enumerate-cg-members.js';

/**
 * Top-up callback. Invoked when the watchdog fires (gossip-only
 * delivery quorum not met within `watchdogMs`). The component
 * supplies the SAME wire bytes the original share fanned out with,
 * plus the residual peer set (`expectedMembers \ acked`), and the
 * caller is expected to fan those out via the substrate exactly
 * like PR-C's `executeSubstrateFanOut`.
 *
 * MUST not throw — implementations should swallow + log so a
 * misbehaving top-up dispatch doesn't crash the periodic tick.
 * (We swallow internally too, as a belt-and-braces.)
 */
export type SubstrateTopUp = (input: {
  shareOperationId: string;
  cgId: string;
  payload: Uint8Array;
  missingPeers: readonly string[];
}) => void | Promise<void>;

/** Optional observability hooks. All callbacks are best-effort and must not throw. */
export interface SwmAckQuorumObservers {
  onQuorumCompleted?: (input: {
    shareOperationId: string;
    cgId: string;
    ackedCount: number;
    expectedCount: number;
    ackPct: number;
  }) => void;
  onWatchdogFired?: (input: {
    shareOperationId: string;
    cgId: string;
    missingCount: number;
    expectedCount: number;
  }) => void;
  onDeadlineExpired?: (input: {
    shareOperationId: string;
    cgId: string;
    ackedCount: number;
    expectedCount: number;
    ackPct: number;
  }) => void;
}

export interface SwmAckQuorumDeps {
  substrateTopUp: SubstrateTopUp;
  observers?: SwmAckQuorumObservers;
  /** Defaults to `Date.now`; override in tests for deterministic timing. */
  now?: () => number;
}

/**
 * Input to {@link SwmAckQuorum.track}. The caller (DKGAgent's
 * `publishWorkspaceGossip`) bundles everything the component
 * needs to drive a single share to completion or deadline.
 */
export interface TrackInput {
  shareOperationId: string;
  cgId: string;
  /**
   * The full enumerated recipient set for the gossip leg. The
   * component does NOT mutate this set; it lives as the
   * authoritative denominator for the quorum calculation. Empty
   * sets are rejected (`track` is a no-op) — there's nothing to
   * wait for.
   */
  expectedMembers: readonly string[];
  /**
   * Peers the substrate fan-out (PR-C) already delivered to. These
   * are pre-populated into the `acked` set so the gossip-side
   * acks only need to cover the gap. Empty when the plan was
   * gossip-only (public CG above `maxSubstrateMembers`, or
   * `source: 'none'`).
   */
  preAckedFromSubstrate?: readonly string[];
  /**
   * The wire bytes that went out via gossip. Held in the tracking
   * record so the watchdog can pass them to {@link SubstrateTopUp}
   * verbatim — receivers are idempotent on (shareOperationId,
   * payload), so a top-up with the same payload as the original
   * gossip is the explicit design.
   */
  payload: Uint8Array;
  /**
   * Fraction of `expectedMembers` that must ack before the share
   * is considered "complete" and the record removed. Default
   * 0.9 per RFC-003 §5.1. Clamped to [0, 1] on track.
   */
  quorumThreshold?: number;
  /**
   * Milliseconds after `track()` before the watchdog fires
   * substrate top-up for non-acked peers. Default 30_000 per
   * RFC-003 §5.2.
   */
  watchdogMs?: number;
  /**
   * Hard cap on a record's tracking lifetime. After this elapses,
   * the record is reaped regardless of ack state and offline peers
   * fall through to `runSyncOnConnect`. Default 5 * 60_000 per
   * RFC-003 §5.2.
   */
  deadlineHardMs?: number;
  /**
   * Enumeration source that produced `expectedMembers`. Surfaced
   * on the observer callbacks so /api/slo can break down
   * completion / watchdog / deadline counts by allowlist vs
   * topic-subscribers vs none. Mirrors PR-C's
   * `FanOutPlan.enumerationSource`.
   */
  enumerationSource: CGMemberEnumeration['source'];
}

/** Snapshot returned by {@link SwmAckQuorum.stats}. */
export interface SwmAckQuorumStats {
  /** Total `track()` calls since construction (cumulative). */
  tracked: number;
  /** Records that reached quorum (cumulative). */
  completed: number;
  /** Watchdog dispatch count (cumulative — at most one per record). */
  watchdogFired: number;
  /** Records reaped at `deadlineHardMs` without reaching quorum (cumulative). */
  deadlineExpired: number;
  /** Currently-tracked record count (gauge — instantaneous). */
  pending: number;
}

/**
 * In-memory ack-quorum tracker. Construct ONE per `DKGAgent` and
 * route every gossip-fanned-out share through it. Pure — `now()`
 * is the only injectable side, and {@link tick} is the only entry
 * that advances time-driven state.
 */
export interface SwmAckQuorum {
  track(input: TrackInput): void;
  onAck(shareOperationId: string, fromPeerId: string): void;
  tick(nowMs?: number): void;
  stats(): SwmAckQuorumStats;
  /** Test/debug helper: snapshot a single record by id (or undefined if not tracked). */
  inspect(shareOperationId: string): TrackedRecordSnapshot | undefined;
  /**
   * Re-arm the watchdog for an existing record so it can fire
   * another substrate top-up after `watchdogMs` elapses from
   * NOW. No-op if the record is unknown (already completed or
   * expired). Intended for the caller's substrate top-up
   * handler to invoke when peers returned a non-terminal outcome
   * (`retryable` sentinel, or `queued` / `inFlight` whose
   * eventual completion the substrate outbox owns but does not
   * surface back to this quorum). The hard deadline
   * (`startedAtMs + deadlineHardMs`) is unaffected — re-arming
   * does NOT extend total tracking lifetime; it only resets
   * the per-tick watchdog timer.
   */
  rearmWatchdog(shareOperationId: string, nowMs?: number): void;
  /**
   * Drop a peer from a record's `expectedMembers` and re-evaluate
   * quorum. Intended for terminal failure outcomes (`rejected`
   * sentinel, `failed`) where retrying won't help — the peer is
   * permanently out of this share's recipient set, and waiting
   * on its ack would block quorum completion until
   * `deadlineHardMs`. Removing it from `expectedMembers` shrinks
   * both the watchdog top-up's `missingPeers` (so future ticks
   * don't keep retrying the rejected peer) AND the quorum
   * denominator (so the share can complete on the remaining
   * acks). Idempotent: no-op if the peer was already dropped
   * or never in the expected set. No-op if the record is
   * unknown.
   *
   * PR-H round 2 (codex feedback on #582 bug 2): the pre-round-2
   * `rearmWatchdog` re-armed the whole record, so the next
   * watchdog tick rebuilt `missingPeers` from every non-acked
   * member — including peers we'd already seen reject with the
   * `FANOUT_RESPONSE_REJECTED` sentinel. That meant a mixed
   * batch (retryable + rejected) kept resending permanently-bad
   * payloads at every interval. This method lets the caller
   * persist the rejection signal so future ticks skip the
   * rejected peers.
   */
  dropPeer(shareOperationId: string, peerId: string): void;
}

/** Read-only snapshot returned by {@link SwmAckQuorum.inspect}. */
export interface TrackedRecordSnapshot {
  shareOperationId: string;
  cgId: string;
  expectedMembers: readonly string[];
  acked: readonly string[];
  ackPct: number;
  watchdogFired: boolean;
  startedAtMs: number;
  watchdogArmedAtMs: number;
  watchdogMs: number;
  deadlineHardMs: number;
  enumerationSource: CGMemberEnumeration['source'];
}

const DEFAULT_QUORUM_THRESHOLD = 0.9;
const DEFAULT_WATCHDOG_MS = 30_000;
const DEFAULT_DEADLINE_HARD_MS = 5 * 60_000;

interface TrackedRecord {
  shareOperationId: string;
  cgId: string;
  expectedMembers: Set<string>;
  acked: Set<string>;
  payload: Uint8Array;
  quorumThreshold: number;
  watchdogMs: number;
  deadlineHardMs: number;
  /** Immutable creation timestamp — reference for `deadlineHardMs` reap. */
  startedAtMs: number;
  /**
   * Mutable watchdog timer reference. Equals `startedAtMs` on
   * `track()`; updated to the current time on `rearmWatchdog()`
   * (PR-H bug 1 — retryable top-ups). The next watchdog fire is
   * `watchdogArmedAtMs + watchdogMs`. The hard deadline is
   * always computed from `startedAtMs`, so re-arming does not
   * extend total tracking lifetime.
   */
  watchdogArmedAtMs: number;
  watchdogFired: boolean;
  enumerationSource: CGMemberEnumeration['source'];
}

export function createSwmAckQuorum(deps: SwmAckQuorumDeps): SwmAckQuorum {
  const now = deps.now ?? (() => Date.now());
  const observers = deps.observers ?? {};
  const records = new Map<string, TrackedRecord>();

  let trackedCount = 0;
  let completedCount = 0;
  let watchdogFiredCount = 0;
  let deadlineExpiredCount = 0;

  function ackPctOf(record: TrackedRecord): number {
    if (record.expectedMembers.size === 0) return 1;
    return record.acked.size / record.expectedMembers.size;
  }

  /**
   * Mark a record complete + invoke the observer + delete it from
   * the tracking map. Idempotent on `shareOperationId` (the
   * `records.delete` is the gate).
   */
  function completeRecord(record: TrackedRecord): void {
    if (!records.delete(record.shareOperationId)) return;
    completedCount += 1;
    safeInvoke(() => observers.onQuorumCompleted?.({
      shareOperationId: record.shareOperationId,
      cgId: record.cgId,
      ackedCount: record.acked.size,
      expectedCount: record.expectedMembers.size,
      ackPct: ackPctOf(record),
    }));
  }

  function expireRecord(record: TrackedRecord): void {
    if (!records.delete(record.shareOperationId)) return;
    deadlineExpiredCount += 1;
    safeInvoke(() => observers.onDeadlineExpired?.({
      shareOperationId: record.shareOperationId,
      cgId: record.cgId,
      ackedCount: record.acked.size,
      expectedCount: record.expectedMembers.size,
      ackPct: ackPctOf(record),
    }));
  }

  function fireWatchdog(record: TrackedRecord): void {
    record.watchdogFired = true;
    watchdogFiredCount += 1;
    const missingPeers: string[] = [];
    for (const peer of record.expectedMembers) {
      if (!record.acked.has(peer)) missingPeers.push(peer);
    }
    safeInvoke(() => observers.onWatchdogFired?.({
      shareOperationId: record.shareOperationId,
      cgId: record.cgId,
      missingCount: missingPeers.length,
      expectedCount: record.expectedMembers.size,
    }));
    safeInvoke(() => {
      const r = deps.substrateTopUp({
        shareOperationId: record.shareOperationId,
        cgId: record.cgId,
        payload: record.payload,
        missingPeers,
      });
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => { /* swallowed; caller logs */ });
      }
    });
  }

  return {
    track(input: TrackInput): void {
      if (input.expectedMembers.length === 0) return;
      if (records.has(input.shareOperationId)) return;

      const threshold = clamp01(input.quorumThreshold ?? DEFAULT_QUORUM_THRESHOLD);
      const expectedMembers = new Set(input.expectedMembers);
      const acked = new Set<string>();
      for (const p of input.preAckedFromSubstrate ?? []) {
        if (expectedMembers.has(p)) acked.add(p);
      }

      const startedAtMs = now();
      const record: TrackedRecord = {
        shareOperationId: input.shareOperationId,
        cgId: input.cgId,
        expectedMembers,
        acked,
        payload: input.payload,
        quorumThreshold: threshold,
        watchdogMs: Math.max(0, input.watchdogMs ?? DEFAULT_WATCHDOG_MS),
        deadlineHardMs: Math.max(0, input.deadlineHardMs ?? DEFAULT_DEADLINE_HARD_MS),
        startedAtMs,
        watchdogArmedAtMs: startedAtMs,
        watchdogFired: false,
        enumerationSource: input.enumerationSource,
      };
      records.set(record.shareOperationId, record);
      trackedCount += 1;

      if (ackPctOf(record) >= record.quorumThreshold) {
        completeRecord(record);
      }
    },

    onAck(shareOperationId: string, fromPeerId: string): void {
      const record = records.get(shareOperationId);
      if (!record) return;
      if (!record.expectedMembers.has(fromPeerId)) return;
      if (record.acked.has(fromPeerId)) return;
      record.acked.add(fromPeerId);

      if (ackPctOf(record) >= record.quorumThreshold) {
        completeRecord(record);
      }
    },

    tick(nowMs?: number): void {
      const t = nowMs ?? now();
      for (const record of [...records.values()]) {
        const age = t - record.startedAtMs;
        if (age >= record.deadlineHardMs) {
          expireRecord(record);
          continue;
        }
        // PR-H bug 1: watchdog timer is keyed off
        // `watchdogArmedAtMs` (mutable on rearm), NOT
        // `startedAtMs`. After a retryable top-up, the caller
        // calls `rearmWatchdog()` which resets this; the next
        // watchdog fire is `watchdogMs` from rearm. Hard
        // deadline above still uses `startedAtMs` so re-arming
        // does not extend total lifetime.
        const watchdogAge = t - record.watchdogArmedAtMs;
        if (!record.watchdogFired && watchdogAge >= record.watchdogMs) {
          if (ackPctOf(record) < record.quorumThreshold) {
            fireWatchdog(record);
          }
        }
      }
    },

    stats(): SwmAckQuorumStats {
      return {
        tracked: trackedCount,
        completed: completedCount,
        watchdogFired: watchdogFiredCount,
        deadlineExpired: deadlineExpiredCount,
        pending: records.size,
      };
    },

    inspect(shareOperationId: string): TrackedRecordSnapshot | undefined {
      const record = records.get(shareOperationId);
      if (!record) return undefined;
      return {
        shareOperationId: record.shareOperationId,
        cgId: record.cgId,
        expectedMembers: [...record.expectedMembers],
        acked: [...record.acked],
        ackPct: ackPctOf(record),
        watchdogFired: record.watchdogFired,
        startedAtMs: record.startedAtMs,
        watchdogArmedAtMs: record.watchdogArmedAtMs,
        watchdogMs: record.watchdogMs,
        deadlineHardMs: record.deadlineHardMs,
        enumerationSource: record.enumerationSource,
      };
    },

    rearmWatchdog(shareOperationId: string, nowMs?: number): void {
      const record = records.get(shareOperationId);
      if (!record) return;
      record.watchdogArmedAtMs = nowMs ?? now();
      record.watchdogFired = false;
    },

    dropPeer(shareOperationId: string, peerId: string): void {
      const record = records.get(shareOperationId);
      if (!record) return;
      if (!record.expectedMembers.delete(peerId)) return;
      // PR-H round 2 (codex feedback on #582 round 2): special-case
      // the "all-rejected, nobody accepted" terminal. Without this,
      // dropPeer'ing the LAST remaining recipient when no acks have
      // arrived would empty `expectedMembers`, `ackPctOf` would
      // return 1 (its `size === 0 → 1` happy-path guard), and
      // `completeRecord` would fire — converting an all-rejected
      // share into a false success and skewing the
      // `shareAckQuorum.completed` SLO metric. Treat it as a
      // deadline-expiry instead: same observer the hard-deadline
      // path uses, so operators see one consistent "share failed"
      // signal regardless of whether failure came from time-out or
      // unanimous rejection.
      if (record.expectedMembers.size === 0 && record.acked.size === 0) {
        expireRecord(record);
        return;
      }
      // Normal path: dropping a peer may have shrunken the
      // denominator past the quorum threshold. Mirror the `onAck`
      // / `track` paths' completion check.
      if (ackPctOf(record) >= record.quorumThreshold) {
        completeRecord(record);
      }
    },
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_QUORUM_THRESHOLD;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function safeInvoke(fn: () => void): void {
  try {
    fn();
  } catch {
    // observers/top-up callbacks are best-effort; never let them
    // crash the periodic tick — operator metrics matter more than
    // strict propagation.
  }
}
