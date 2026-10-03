// SPDX-License-Identifier: Apache-2.0

import { rememberBounded } from './bounded-map.js';
import type { ExactBatchStreamSetback } from './sync/requester/exact-recovery-transport.js';

export interface VmRecoveryStreamSetbackLimits {
  /** How long a peer is left alone after a stream attempt that gave no verdict. */
  readonly holdOffMs: number;
  /**
   * How long one run of such attempts may go on keeping targets' turns open.
   * Past it the peer is rotated like any other until it completes an exchange.
   */
  readonly streakWindowMs: number;
  /** Broken streams in one run that keep the turn. Busy answers are not counted. */
  readonly maxInterruptedInStreak: number;
  readonly maxEntries: number;
}

export const VM_RECOVERY_STREAM_SETBACK_LIMITS: VmRecoveryStreamSetbackLimits = Object.freeze({
  holdOffMs: 15_000,
  streakWindowMs: 30 * 60_000,
  maxInterruptedInStreak: 2,
  maxEntries: 1_024,
});

export interface VmRecoveryStreamSetbackDecision {
  /**
   * The targets of the attempt keep their turn at this peer, and the peer is
   * asked again once `holdOffMs` has passed. False rotates them as before.
   */
  readonly keepsTurn: boolean;
  readonly holdOffMs: number;
}

interface StreamPeerState {
  /** The peer completed a stream exchange for this graph while this entry lived. */
  served: boolean;
  /** Start of the current run of attempts without a verdict. */
  streakStartedAt: number | undefined;
  interruptedInStreak: number;
  /** The peer is not asked again before this time. */
  retryAt: number;
  touchedAt: number;
}

/**
 * What a stream attempt that ended without a verdict on the peer's data costs
 * that peer in one graph's recovery.
 *
 * A peer that answered BUSY is alive and said so: the assets asked for keep
 * their turn at it. A stream that broke keeps the turn only for a peer that
 * has already completed a stream exchange for this graph, and only a couple of
 * times in a row, so an asset the peer aborts on every time is rotated like
 * before. Either way the peer is left alone for a short hold-off, which is
 * what bounds how often it is asked.
 *
 * Process-local transport history on the caller's monotonic clock. It never
 * says an asset is present or absent anywhere, and forgetting it only restores
 * the ordinary rotation.
 */
export class VmRecoveryStreamSetbackPolicy {
  private readonly entries = new Map<string, StreamPeerState>();

  constructor(private readonly limits: VmRecoveryStreamSetbackLimits = VM_RECOVERY_STREAM_SETBACK_LIMITS) {}

  /** A stream exchange with this peer delivered everything it was asked for. */
  recordServed(localCgId: string, peerId: string, now: number): void {
    const state = this.touch(localCgId, peerId, now);
    state.served = true;
    state.streakStartedAt = undefined;
    state.interruptedInStreak = 0;
    state.retryAt = 0;
  }

  recordSetback(
    localCgId: string,
    peerId: string,
    kind: ExactBatchStreamSetback,
    now: number,
  ): VmRecoveryStreamSetbackDecision {
    const state = this.touch(localCgId, peerId, now);
    state.streakStartedAt ??= now;
    if (kind === 'stream-interrupted') state.interruptedInStreak += 1;
    const keepsTurn = now - state.streakStartedAt <= this.limits.streakWindowMs
      && (kind === 'responder-busy'
        || (state.served && state.interruptedInStreak <= this.limits.maxInterruptedInStreak));
    state.retryAt = keepsTurn ? now + this.limits.holdOffMs : 0;
    return { keepsTurn, holdOffMs: keepsTurn ? this.limits.holdOffMs : 0 };
  }

  /** Whether the peer is still inside the hold-off of its last setback. */
  heldOff(localCgId: string, peerId: string, now: number): boolean {
    const state = this.entries.get(this.key(localCgId, peerId));
    return state !== undefined && now < state.retryAt;
  }

  /** Whether the peer's last stream attempt for this graph was a setback, with no complete exchange since. */
  inSetbackStreak(localCgId: string, peerId: string, now: number): boolean {
    const state = this.entries.get(this.key(localCgId, peerId));
    return state !== undefined && state.streakStartedAt !== undefined
      && now - state.touchedAt <= this.limits.streakWindowMs;
  }

  forgetContextGraph(localCgId: string): void {
    const prefix = `${localCgId}\0`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private touch(localCgId: string, peerId: string, now: number): StreamPeerState {
    const key = this.key(localCgId, peerId);
    let state = this.entries.get(key);
    // History older than one streak window is not "the current recovery".
    if (state !== undefined && now - state.touchedAt > this.limits.streakWindowMs) state = undefined;
    state ??= { served: false, streakStartedAt: undefined, interruptedInStreak: 0, retryAt: 0, touchedAt: now };
    state.touchedAt = now;
    rememberBounded(this.entries, key, state, this.limits.maxEntries);
    return state;
  }

  private key(localCgId: string, peerId: string): string {
    return `${localCgId}\0${peerId}`;
  }
}
