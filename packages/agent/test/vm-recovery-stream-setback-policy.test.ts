import { describe, expect, it } from 'vitest';
import {
  VM_RECOVERY_STREAM_SETBACK_LIMITS as LIMITS,
  VmRecoveryStreamSetbackPolicy,
} from '../src/vm-recovery-stream-setback-policy.js';

const CG = '0x0000000000000000000000000000000000000001/setback-policy';
const CORE = '12D3KooWSetbackCore';
const T0 = 1_000_000;

describe('what a stream setback costs its peer in one graph\'s recovery', () => {
  it('keeps the turn for a peer that answered busy, whether or not it has served, and holds it off', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    expect(policy.heldOff(CG, CORE, T0)).toBe(false);
    expect(policy.recordSetback(CG, CORE, 'responder-busy', T0)).toEqual({ keepsTurn: true, holdOffMs: LIMITS.holdOffMs });
    expect(policy.heldOff(CG, CORE, T0)).toBe(true);
    expect(policy.heldOff(CG, CORE, T0 + LIMITS.holdOffMs - 1)).toBe(true);
    expect(policy.heldOff(CG, CORE, T0 + LIMITS.holdOffMs)).toBe(false);
  });

  it('holds off only the peer and the graph of the setback', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    policy.recordSetback(CG, CORE, 'responder-busy', T0);
    expect(policy.heldOff(CG, '12D3KooWOtherPeer', T0)).toBe(false);
    expect(policy.heldOff(`${CG}-other`, CORE, T0)).toBe(false);
  });

  it('keeps answering busy inside the streak window and rotates the peer once it is over', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    policy.recordSetback(CG, CORE, 'responder-busy', T0);
    const lastKept = T0 + LIMITS.streakWindowMs;
    expect(policy.recordSetback(CG, CORE, 'responder-busy', lastKept)).toEqual({ keepsTurn: true, holdOffMs: LIMITS.holdOffMs });
    // One millisecond later the streak is too old: no kept turn and no hold-off.
    expect(policy.recordSetback(CG, CORE, 'responder-busy', lastKept + 1)).toEqual({ keepsTurn: false, holdOffMs: 0 });
    expect(policy.heldOff(CG, CORE, lastKept + 1)).toBe(false);
    // It stays rotated however often it is asked, until it serves.
    expect(policy.recordSetback(CG, CORE, 'responder-busy', lastKept + 60_000).keepsTurn).toBe(false);
    policy.recordServed(CG, CORE, lastKept + 120_000);
    expect(policy.recordSetback(CG, CORE, 'responder-busy', lastKept + 180_000).keepsTurn).toBe(true);
  });

  it('gives a broken stream no kept turn while the peer has not served this graph', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    expect(policy.recordSetback(CG, CORE, 'stream-interrupted', T0)).toEqual({ keepsTurn: false, holdOffMs: 0 });
    expect(policy.heldOff(CG, CORE, T0)).toBe(false);
    // Service for another graph is not service for this one.
    policy.recordServed(`${CG}-other`, CORE, T0);
    expect(policy.recordSetback(CG, CORE, 'stream-interrupted', T0 + 1).keepsTurn).toBe(false);
  });

  it('keeps the turn for a broken stream of a peer that has served, a bounded number of times in a row', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    policy.recordServed(CG, CORE, T0);
    for (let broken = 1; broken <= LIMITS.maxInterruptedInStreak; broken += 1) {
      expect(policy.recordSetback(CG, CORE, 'stream-interrupted', T0 + broken)).toEqual({ keepsTurn: true, holdOffMs: LIMITS.holdOffMs });
    }
    const overLimitAt = T0 + LIMITS.maxInterruptedInStreak + 1;
    expect(policy.recordSetback(CG, CORE, 'stream-interrupted', overLimitAt)).toEqual({ keepsTurn: false, holdOffMs: 0 });
    // The rotation takes over at once: the earlier hold-off no longer applies.
    expect(policy.heldOff(CG, CORE, overLimitAt)).toBe(false);
    // A complete exchange starts a new streak.
    policy.recordServed(CG, CORE, overLimitAt + 1);
    expect(policy.recordSetback(CG, CORE, 'stream-interrupted', overLimitAt + 2).keepsTurn).toBe(true);
  });

  it('does not count busy answers against the broken-stream limit', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    policy.recordServed(CG, CORE, T0);
    for (let busy = 1; busy <= LIMITS.maxInterruptedInStreak + 3; busy += 1) {
      expect(policy.recordSetback(CG, CORE, 'responder-busy', T0 + busy).keepsTurn).toBe(true);
    }
    expect(policy.recordSetback(CG, CORE, 'stream-interrupted', T0 + 100).keepsTurn).toBe(true);
  });

  it('ends the hold-off and the streak when the peer serves', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    expect(policy.inSetbackStreak(CG, CORE, T0)).toBe(false);
    policy.recordSetback(CG, CORE, 'responder-busy', T0);
    expect(policy.inSetbackStreak(CG, CORE, T0)).toBe(true);
    // The streak outlasts the hold-off: it ends with a complete exchange, not with time.
    expect(policy.inSetbackStreak(CG, CORE, T0 + LIMITS.holdOffMs)).toBe(true);
    expect(policy.inSetbackStreak(`${CG}-other`, CORE, T0)).toBe(false);
    policy.recordServed(CG, CORE, T0 + 1);
    expect(policy.heldOff(CG, CORE, T0 + 1)).toBe(false);
    expect(policy.inSetbackStreak(CG, CORE, T0 + 1)).toBe(false);
  });

  it('no longer reports a streak nobody has touched for one streak window', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    policy.recordSetback(CG, CORE, 'responder-busy', T0);
    expect(policy.inSetbackStreak(CG, CORE, T0 + LIMITS.streakWindowMs)).toBe(true);
    expect(policy.inSetbackStreak(CG, CORE, T0 + LIMITS.streakWindowMs + 1)).toBe(false);
  });

  it('forgets service older than one streak window', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    policy.recordServed(CG, CORE, T0);
    const stale = T0 + LIMITS.streakWindowMs + 1;
    expect(policy.recordSetback(CG, CORE, 'stream-interrupted', stale).keepsTurn).toBe(false);
    // Up to the window the service still counts.
    const other = new VmRecoveryStreamSetbackPolicy();
    other.recordServed(CG, CORE, T0);
    expect(other.recordSetback(CG, CORE, 'stream-interrupted', T0 + LIMITS.streakWindowMs).keepsTurn).toBe(true);
  });

  it('forgets one graph or everything, restoring the ordinary rotation', () => {
    const policy = new VmRecoveryStreamSetbackPolicy();
    policy.recordServed(CG, CORE, T0);
    policy.recordSetback(CG, CORE, 'responder-busy', T0 + 1);
    policy.recordSetback(`${CG}-other`, CORE, 'responder-busy', T0 + 1);
    policy.forgetContextGraph(CG);
    expect(policy.heldOff(CG, CORE, T0 + 2)).toBe(false);
    expect(policy.recordSetback(CG, CORE, 'stream-interrupted', T0 + 2).keepsTurn).toBe(false);
    expect(policy.heldOff(`${CG}-other`, CORE, T0 + 2)).toBe(true);
    policy.clear();
    expect(policy.heldOff(`${CG}-other`, CORE, T0 + 2)).toBe(false);
  });

  it('keeps at most the configured number of peers, dropping the least recently touched', () => {
    const policy = new VmRecoveryStreamSetbackPolicy({ ...LIMITS, maxEntries: 2 });
    policy.recordSetback(CG, 'peer-1', 'responder-busy', T0);
    policy.recordSetback(CG, 'peer-2', 'responder-busy', T0);
    // Touching peer-1 again makes peer-2 the oldest.
    policy.recordSetback(CG, 'peer-1', 'responder-busy', T0 + 1);
    policy.recordSetback(CG, 'peer-3', 'responder-busy', T0 + 2);
    expect(policy.heldOff(CG, 'peer-1', T0 + 2)).toBe(true);
    expect(policy.heldOff(CG, 'peer-2', T0 + 2)).toBe(false);
    expect(policy.heldOff(CG, 'peer-3', T0 + 2)).toBe(true);
  });
});
