import { describe, it, expect, vi } from 'vitest';
import {
  createSwmAckQuorum,
  type SwmAckQuorum,
  type SubstrateTopUp,
  type SwmAckQuorumObservers,
} from '../src/swm/ack-quorum.js';

const PAYLOAD = new TextEncoder().encode('share-bytes');

interface TopUpCall {
  shareOperationId: string;
  cgId: string;
  missingPeers: readonly string[];
}

function makeTopUp(): { calls: TopUpCall[]; fn: SubstrateTopUp } {
  const calls: TopUpCall[] = [];
  const fn: SubstrateTopUp = (input) => {
    calls.push({
      shareOperationId: input.shareOperationId,
      cgId: input.cgId,
      missingPeers: [...input.missingPeers],
    });
  };
  return { calls, fn };
}

function makeQuorum(opts: {
  now?: () => number;
  topUp?: SubstrateTopUp;
  observers?: SwmAckQuorumObservers;
} = {}): SwmAckQuorum {
  return createSwmAckQuorum({
    substrateTopUp: opts.topUp ?? (() => {}),
    now: opts.now,
    observers: opts.observers,
  });
}

describe('createSwmAckQuorum: track + onAck happy path', () => {
  it('reaches quorum when 100% of expected members ack', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-1',
      cgId: 'cg-1',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 0.9,
    });

    expect(q.stats().pending).toBe(1);
    q.onAck('op-1', 'p1');
    expect(q.stats().pending).toBe(1);
    q.onAck('op-1', 'p2');
    expect(q.stats().pending).toBe(1);
    q.onAck('op-1', 'p3');

    expect(q.stats().pending).toBe(0);
    expect(q.stats().completed).toBe(1);
    expect(q.stats().tracked).toBe(1);
    expect(q.inspect('op-1')).toBeUndefined();
  });

  it('reaches quorum at exactly the threshold (0.9 of 10 = 9 acks)', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-th',
      cgId: 'cg-th',
      expectedMembers: ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      quorumThreshold: 0.9,
    });

    for (let i = 1; i <= 8; i++) q.onAck('op-th', `p${i}`);
    expect(q.stats().completed).toBe(0);
    expect(q.inspect('op-th')?.ackPct).toBeCloseTo(0.8);

    q.onAck('op-th', 'p9');
    expect(q.stats().completed).toBe(1);
    expect(q.inspect('op-th')).toBeUndefined();
  });

  it('pre-acked substrate peers count toward the quorum at track time', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-pre',
      cgId: 'cg-pre',
      expectedMembers: ['p1', 'p2', 'p3', 'p4', 'p5'],
      preAckedFromSubstrate: ['p1', 'p2', 'p3', 'p4'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 0.9,
    });

    expect(q.inspect('op-pre')?.acked.sort()).toEqual(['p1','p2','p3','p4']);
    expect(q.inspect('op-pre')?.ackPct).toBeCloseTo(0.8);

    q.onAck('op-pre', 'p5');
    expect(q.stats().completed).toBe(1);
  });

  it('pre-completes at track time if substrate alone meets the threshold', () => {
    const observers: SwmAckQuorumObservers = {
      onQuorumCompleted: vi.fn(),
    };
    const q = makeQuorum({ observers });
    q.track({
      shareOperationId: 'op-substrate-only',
      cgId: 'cg-curated',
      expectedMembers: ['p1', 'p2', 'p3'],
      preAckedFromSubstrate: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 0.9,
    });

    expect(q.stats().tracked).toBe(1);
    expect(q.stats().completed).toBe(1);
    expect(q.stats().pending).toBe(0);
    expect(observers.onQuorumCompleted).toHaveBeenCalledTimes(1);
  });

  it('substrate pre-acks outside expectedMembers are filtered out', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-filter',
      cgId: 'cg-filter',
      expectedMembers: ['p1', 'p2'],
      preAckedFromSubstrate: ['p1', 'pNotInRoster', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      quorumThreshold: 1.0,
    });

    expect(q.inspect('op-filter')).toBeUndefined();
    expect(q.stats().completed).toBe(1);
  });
});

describe('createSwmAckQuorum: track idempotency / edge cases', () => {
  it('empty expectedMembers is a no-op (nothing to wait for)', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-empty',
      cgId: 'cg-empty',
      expectedMembers: [],
      payload: PAYLOAD,
      enumerationSource: 'none',
    });

    expect(q.stats().tracked).toBe(0);
    expect(q.stats().completed).toBe(0);
    expect(q.stats().pending).toBe(0);
  });

  it('duplicate track for the same shareOperationId is ignored', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-dup',
      cgId: 'cg-dup',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
    });
    q.track({
      shareOperationId: 'op-dup',
      cgId: 'cg-dup',
      expectedMembers: ['pOther'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
    });

    expect(q.stats().tracked).toBe(1);
    expect(q.inspect('op-dup')?.expectedMembers.sort()).toEqual(['p1', 'p2']);
  });

  it('clamps quorumThreshold to [0, 1]', () => {
    const q = makeQuorum();

    q.track({
      shareOperationId: 'op-low',
      cgId: 'cg',
      expectedMembers: ['p1'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: -5,
    });
    expect(q.stats().completed).toBe(1);

    q.track({
      shareOperationId: 'op-high',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 99,
    });
    q.onAck('op-high', 'p1');
    expect(q.stats().completed).toBe(1);
    q.onAck('op-high', 'p2');
    expect(q.stats().completed).toBe(2);
  });

  it('falls back to default threshold for non-finite values (NaN)', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-nan',
      cgId: 'cg',
      expectedMembers: ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      quorumThreshold: Number.NaN,
    });

    for (let i = 1; i <= 8; i++) q.onAck('op-nan', `p${i}`);
    expect(q.stats().completed).toBe(0);

    q.onAck('op-nan', 'p9');
    expect(q.stats().completed).toBe(1);
  });

  it('falls back to default threshold for +Infinity (locks !Number.isFinite over Number.isNaN)', () => {
    // Defends against a regression that swapped clamp01's
    // `!Number.isFinite(n)` for `Number.isNaN(n)`. Both
    // correctly handle NaN, but `Number.isNaN(Infinity)` is
    // false → would reach `n > 1 → return 1` and silently
    // change default-threshold behaviour to "wait for 100%".
    // This test pins the DEFAULT (0.9) path: 8/10 = 80%
    // does NOT complete; 9/10 = 90% does. Under the broken
    // regression both would route through threshold=1.0
    // and the 9/10 case would also fail to complete.
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-pos-inf',
      cgId: 'cg',
      expectedMembers: ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      quorumThreshold: Number.POSITIVE_INFINITY,
    });
    for (let i = 1; i <= 8; i++) q.onAck('op-pos-inf', `p${i}`);
    expect(q.stats().completed).toBe(0);
    q.onAck('op-pos-inf', 'p9');
    expect(q.stats().completed).toBe(1);
  });

  it('falls back to default threshold for -Infinity (negative non-finite path)', () => {
    // Mirror of the +Infinity test — `-Infinity` also hits
    // `!Number.isFinite` and returns DEFAULT (NOT 0). A
    // regression that handled negatives via `n < 0 → return
    // 0` BEFORE the finite check would silently change this
    // to threshold=0 (everything completes immediately on
    // track), which the `expect(completed).toBe(0)` after
    // track but before any ack would catch.
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-neg-inf',
      cgId: 'cg',
      expectedMembers: ['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      quorumThreshold: Number.NEGATIVE_INFINITY,
    });
    // Default 0.9: 0/10 = 0 < 0.9, NOT completed. Under the
    // pre-finite-check-clamp regression, -Inf would have
    // routed to 0 and completed=1 here.
    expect(q.stats().completed).toBe(0);
    for (let i = 1; i <= 9; i++) q.onAck('op-neg-inf', `p${i}`);
    expect(q.stats().completed).toBe(1);
  });
});

describe('createSwmAckQuorum: onAck filtering / dedup', () => {
  it('onAck for unknown shareOperationId is a no-op (stale ack arriving after deadline)', () => {
    const q = makeQuorum();
    q.onAck('op-never-tracked', 'p1');
    expect(q.stats().completed).toBe(0);
    expect(q.stats().pending).toBe(0);
  });

  it('onAck from a peer NOT in expectedMembers is dropped', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-stranger',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 1.0,
    });

    q.onAck('op-stranger', 'pStranger');
    expect(q.inspect('op-stranger')?.acked).toEqual([]);

    q.onAck('op-stranger', 'p1');
    q.onAck('op-stranger', 'p2');
    expect(q.stats().completed).toBe(1);
  });

  it('duplicate onAck from the same peer is idempotent', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-dup-ack',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 1.0,
    });

    q.onAck('op-dup-ack', 'p1');
    q.onAck('op-dup-ack', 'p1');
    q.onAck('op-dup-ack', 'p1');
    expect(q.inspect('op-dup-ack')?.acked).toEqual(['p1']);
    expect(q.stats().completed).toBe(0);
  });
});

describe('createSwmAckQuorum: tick + watchdog + deadline', () => {
  it('tick before watchdogMs does NOT fire top-up', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });

    q.track({
      shareOperationId: 'op-early',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3', 'p4'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 25_000;
    q.tick();

    expect(calls).toEqual([]);
    expect(q.stats().watchdogFired).toBe(0);
    expect(q.inspect('op-early')?.watchdogFired).toBe(false);
  });

  it('tick AT watchdogMs (and quorum not met) fires top-up exactly once with missing peers', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const onWatchdogFired = vi.fn();
    const q = makeQuorum({
      now: () => nowMs,
      topUp: fn,
      observers: { onWatchdogFired },
    });

    q.track({
      shareOperationId: 'op-watch',
      cgId: 'cg-watch',
      expectedMembers: ['p1', 'p2', 'p3', 'p4'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    q.onAck('op-watch', 'p1');
    q.onAck('op-watch', 'p2');

    nowMs += 30_000;
    q.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      shareOperationId: 'op-watch',
      cgId: 'cg-watch',
      missingPeers: expect.arrayContaining(['p3', 'p4']),
    });
    expect(calls[0]!.missingPeers).toHaveLength(2);

    expect(q.stats().watchdogFired).toBe(1);
    expect(onWatchdogFired).toHaveBeenCalledOnce();
    expect(onWatchdogFired).toHaveBeenCalledWith({
      shareOperationId: 'op-watch',
      cgId: 'cg-watch',
      missingCount: 2,
      expectedCount: 4,
    });

    // Subsequent ticks before deadline must NOT re-fire.
    nowMs += 30_000;
    q.tick();
    nowMs += 60_000;
    q.tick();
    expect(calls).toHaveLength(1);
    expect(q.stats().watchdogFired).toBe(1);
  });

  it('watchdog does NOT fire if quorum was met before watchdogMs elapsed', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });

    q.track({
      shareOperationId: 'op-quick',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3', 'p4'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
      quorumThreshold: 0.5,
    });

    q.onAck('op-quick', 'p1');
    q.onAck('op-quick', 'p2');
    expect(q.stats().completed).toBe(1);

    nowMs += 60_000;
    q.tick();

    expect(calls).toEqual([]);
    expect(q.stats().watchdogFired).toBe(0);
  });

  it('tick at deadlineHardMs reaps the record and fires onDeadlineExpired', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const onDeadlineExpired = vi.fn();
    const q = makeQuorum({
      now: () => nowMs,
      topUp: fn,
      observers: { onDeadlineExpired },
    });

    q.track({
      shareOperationId: 'op-dead',
      cgId: 'cg-dead',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    q.onAck('op-dead', 'p1');

    nowMs += 30_000;
    q.tick();
    expect(calls).toHaveLength(1);

    nowMs += 5 * 60_000;
    q.tick();

    expect(q.stats().deadlineExpired).toBe(1);
    expect(q.stats().pending).toBe(0);
    expect(q.inspect('op-dead')).toBeUndefined();
    expect(onDeadlineExpired).toHaveBeenCalledWith({
      shareOperationId: 'op-dead',
      cgId: 'cg-dead',
      ackedCount: 1,
      expectedCount: 3,
      ackPct: 1 / 3,
    });
  });

  it('multiple records advance independently in a single tick', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });

    q.track({
      shareOperationId: 'op-a',
      cgId: 'cg-a',
      expectedMembers: ['pA1', 'pA2'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 10_000;
    q.track({
      shareOperationId: 'op-b',
      cgId: 'cg-b',
      expectedMembers: ['pB1', 'pB2', 'pB3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    q.onAck('op-b', 'pB1');
    q.onAck('op-b', 'pB2');
    q.onAck('op-b', 'pB3');

    nowMs += 20_000;
    q.tick();

    expect(q.stats().completed).toBe(1);
    expect(q.stats().watchdogFired).toBe(1);
    const aTopUps = calls.filter(c => c.shareOperationId === 'op-a');
    const bTopUps = calls.filter(c => c.shareOperationId === 'op-b');
    expect(aTopUps).toHaveLength(1);
    expect(bTopUps).toHaveLength(0);
  });
});

describe('createSwmAckQuorum: rearmWatchdog (PR-H bug 1)', () => {
  it('re-arms the watchdog so it can fire again after another watchdogMs', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });

    q.track({
      shareOperationId: 'op-rearm',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 30_000;
    q.tick();
    expect(calls).toHaveLength(1);
    expect(q.stats().watchdogFired).toBe(1);
    expect(q.inspect('op-rearm')?.watchdogFired).toBe(true);

    nowMs += 60_000;
    q.tick();
    expect(calls).toHaveLength(1);

    q.rearmWatchdog('op-rearm');
    expect(q.inspect('op-rearm')?.watchdogFired).toBe(false);
    expect(q.inspect('op-rearm')?.watchdogArmedAtMs).toBe(nowMs);

    nowMs += 20_000;
    q.tick();
    expect(calls).toHaveLength(1);

    nowMs += 10_000;
    q.tick();
    expect(calls).toHaveLength(2);
    expect(q.stats().watchdogFired).toBe(2);
  });

  it('rearm does NOT extend the hard deadline (deadline reference is the original startedAtMs)', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const onDeadlineExpired = vi.fn();
    const q = makeQuorum({
      now: () => nowMs,
      topUp: fn,
      observers: { onDeadlineExpired },
    });

    q.track({
      shareOperationId: 'op-rearm-dl',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 2 * 60_000,
    });

    nowMs += 30_000;
    q.tick();
    expect(calls).toHaveLength(1);

    nowMs += 60_000;
    q.rearmWatchdog('op-rearm-dl');

    nowMs += 31_000;
    q.tick();

    expect(q.stats().deadlineExpired).toBe(1);
    expect(q.inspect('op-rearm-dl')).toBeUndefined();
    expect(onDeadlineExpired).toHaveBeenCalledTimes(1);
  });

  it('rearm on an unknown shareOperationId is a no-op (does not throw)', () => {
    const q = makeQuorum();
    expect(() => q.rearmWatchdog('op-unknown')).not.toThrow();
    expect(q.stats()).toMatchObject({ pending: 0 });
  });

  it('rearm before the first watchdog fire pushes the first fire out by the elapsed gap', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });

    q.track({
      shareOperationId: 'op-early-rearm',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 10_000;
    q.rearmWatchdog('op-early-rearm');

    nowMs += 25_000;
    q.tick();
    expect(calls).toHaveLength(0);

    nowMs += 10_000;
    q.tick();
    expect(calls).toHaveLength(1);
  });
});

/**
 * PR-H round 2 (codex feedback on #582 bug 2): `dropPeer` removes
 * a peer from `expectedMembers` so future watchdog ticks don't
 * keep resending to permanently-rejected peers AND the shrunken
 * denominator lets quorum complete on the remaining acks instead
 * of waiting out `deadlineHardMs`.
 */
describe('createSwmAckQuorum: dropPeer (PR-H bug 2)', () => {
  it('removes the peer from missingPeers on subsequent watchdog fires', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });
    q.track({
      shareOperationId: 'op-drop',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 30_001;
    q.tick();
    expect(calls).toHaveLength(1);
    expect([...calls[0].missingPeers].sort()).toEqual(['p1', 'p2', 'p3']);

    q.dropPeer('op-drop', 'p2');
    q.rearmWatchdog('op-drop');

    nowMs += 30_001;
    q.tick();
    expect(calls).toHaveLength(2);
    expect([...calls[1].missingPeers].sort()).toEqual(['p1', 'p3']);
  });

  it('completes quorum when dropping a peer pushes ackPct past threshold', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-drop-complete',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 0.9,
    });

    q.onAck('op-drop-complete', 'p1');
    q.onAck('op-drop-complete', 'p2');
    expect(q.stats().pending).toBe(1);
    expect(q.stats().completed).toBe(0);

    q.dropPeer('op-drop-complete', 'p3');

    expect(q.stats().pending).toBe(0);
    expect(q.stats().completed).toBe(1);
  });

  it('is idempotent for repeated drops of the same peer', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-drop-idem',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
    });

    q.dropPeer('op-drop-idem', 'p1');
    q.dropPeer('op-drop-idem', 'p1');
    q.dropPeer('op-drop-idem', 'p1');

    const snap = q.inspect('op-drop-idem');
    expect(snap?.expectedMembers).toEqual(['p2']);
  });

  it('is a no-op when peer is not in expectedMembers', () => {
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-drop-noop',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
    });

    expect(() => q.dropPeer('op-drop-noop', 'pX')).not.toThrow();
    const snap = q.inspect('op-drop-noop');
    expect([...(snap?.expectedMembers ?? [])].sort()).toEqual(['p1', 'p2']);
  });

  it('is a no-op for an unknown shareOperationId', () => {
    const q = makeQuorum();
    expect(() => q.dropPeer('op-unknown', 'p1')).not.toThrow();
  });

  /**
   * PR-H round 2 (codex feedback on #582 round 2): if dropPeer
   * empties `expectedMembers` while `acked` is also empty
   * (all-rejected, nobody accepted), the share MUST surface as
   * a deadline-expiry — NOT a completion. The naive
   * implementation would let `ackPctOf` return 1 (the empty-set
   * guard) and fire `completeRecord`, converting an
   * all-rejection into a false success and skewing the SLO
   * metric.
   */
  it('treats an all-rejected share (no acks) as deadline-expired, NOT completed', () => {
    let expiredCalls = 0;
    let completedCalls = 0;
    const q = makeQuorum({
      observers: {
        onDeadlineExpired: () => { expiredCalls += 1; },
        onQuorumCompleted: () => { completedCalls += 1; },
      },
    });
    q.track({
      shareOperationId: 'op-all-rejected',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
    });

    q.dropPeer('op-all-rejected', 'p1');
    q.dropPeer('op-all-rejected', 'p2');

    expect(completedCalls).toBe(0);
    expect(expiredCalls).toBe(1);
    expect(q.stats().completed).toBe(0);
    expect(q.stats().deadlineExpired).toBe(1);
    expect(q.stats().pending).toBe(0);
    expect(q.inspect('op-all-rejected')).toBeUndefined();
  });

  /**
   * Companion to the all-rejected test: when SOME peers acked
   * before all remaining peers rejected, dropPeer'ing the last
   * non-acked peer is a legitimate completion (the share got
   * acks from everyone it possibly could). Pins the
   * "expectedMembers empty BUT acked non-empty" branch as
   * complete, not expired.
   */
  it('completes when dropPeer empties expected but acked has at least one entry', () => {
    let expiredCalls = 0;
    let completedCalls = 0;
    const q = makeQuorum({
      observers: {
        onDeadlineExpired: () => { expiredCalls += 1; },
        onQuorumCompleted: () => { completedCalls += 1; },
      },
    });
    q.track({
      shareOperationId: 'op-partial-then-drop',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
    });

    q.onAck('op-partial-then-drop', 'p1');
    q.dropPeer('op-partial-then-drop', 'p2');

    expect(completedCalls).toBe(1);
    expect(expiredCalls).toBe(0);
  });
});

describe('createSwmAckQuorum: error isolation', () => {
  it('throwing observer does not crash the tick', () => {
    let nowMs = 1_000_000;
    const q = makeQuorum({
      now: () => nowMs,
      topUp: () => {},
      observers: {
        onWatchdogFired: () => { throw new Error('observer boom'); },
        onDeadlineExpired: () => { throw new Error('observer boom'); },
        onQuorumCompleted: () => { throw new Error('observer boom'); },
      },
    });

    q.track({
      shareOperationId: 'op-throw',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'topic-subscribers',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 30_000;
    expect(() => q.tick()).not.toThrow();
    expect(q.stats().watchdogFired).toBe(1);

    nowMs += 5 * 60_000;
    expect(() => q.tick()).not.toThrow();
    expect(q.stats().deadlineExpired).toBe(1);

    q.track({
      shareOperationId: 'op-throw-2',
      cgId: 'cg',
      expectedMembers: ['p1'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 1.0,
    });
    expect(() => q.onAck('op-throw-2', 'p1')).not.toThrow();
    expect(q.stats().completed).toBe(1);
  });

  it('throwing substrateTopUp does not crash the tick OR mark the record dropped', () => {
    let nowMs = 1_000_000;
    const q = makeQuorum({
      now: () => nowMs,
      topUp: () => { throw new Error('top-up boom'); },
    });

    q.track({
      shareOperationId: 'op-tu-throw',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 30_000;
    expect(() => q.tick()).not.toThrow();
    expect(q.stats().watchdogFired).toBe(1);
    expect(q.inspect('op-tu-throw')?.watchdogFired).toBe(true);
  });

  it('async substrateTopUp rejection is swallowed', async () => {
    let nowMs = 1_000_000;
    const q = makeQuorum({
      now: () => nowMs,
      topUp: async () => { throw new Error('async top-up boom'); },
    });

    q.track({
      shareOperationId: 'op-tu-async',
      cgId: 'cg',
      expectedMembers: ['p1'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 1.0,
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 30_000;
    q.tick();
    await new Promise((r) => setTimeout(r, 10));
    expect(q.stats().watchdogFired).toBe(1);
  });
});

describe('createSwmAckQuorum: time-bound boundary edge cases', () => {
  it('watchdogMs = 0 fires the top-up on the very first tick (degenerate-zero allowed)', () => {
    // Math.max(0, ...) allows zero watchdog. The SLO endpoint exposes
    // this as a minimum; a regression that flipped to `> 0` would
    // never fire the watchdog on a zero-window track.
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });
    q.track({
      shareOperationId: 'op-zero-watchdog',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 0,
      deadlineHardMs: 5 * 60_000,
    });
    q.tick(); // nowMs unchanged → watchdogAge = 0 ≥ 0 fires.
    expect(calls).toHaveLength(1);
    expect(q.stats().watchdogFired).toBe(1);
  });

  it('deadlineHardMs = 0 reaps the record on the very next tick', () => {
    // Mirror of the watchdog zero-window: a zero hard deadline reaps
    // on next tick. Defends operators from configuration footguns —
    // the system must not crash and must not silently treat 0 as
    // "default".
    let nowMs = 1_000_000;
    const onDeadlineExpired = vi.fn();
    const q = makeQuorum({
      now: () => nowMs,
      observers: { onDeadlineExpired },
    });
    q.track({
      shareOperationId: 'op-zero-deadline',
      cgId: 'cg',
      expectedMembers: ['p1'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      deadlineHardMs: 0,
    });
    q.tick();
    expect(q.stats().deadlineExpired).toBe(1);
    expect(onDeadlineExpired).toHaveBeenCalledOnce();
    expect(q.inspect('op-zero-deadline')).toBeUndefined();
  });

  it('negative watchdogMs / deadlineHardMs are clamped to 0 (Math.max guard)', () => {
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });
    q.track({
      shareOperationId: 'op-neg',
      cgId: 'cg',
      expectedMembers: ['p1'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: -1_000,
      deadlineHardMs: -1_000,
    });
    // Tick first reaches the deadline branch (age 0 ≥ 0) — record
    // expires before the watchdog can fire.
    q.tick();
    expect(q.stats().deadlineExpired).toBe(1);
    expect(calls).toEqual([]);
  });

  it('tick(nowMs) explicit override drives state without consulting the now() injectable', () => {
    // The signature `tick(nowMs?: number)` lets the caller pass an
    // explicit timestamp. Locks that path; a regression that
    // ignored the override would silently de-sync the SLO ticker
    // from the wall clock the agent runs against.
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });
    q.track({
      shareOperationId: 'op-nowMs-override',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });
    // Inject a future-now into tick directly, leaving the underlying
    // `now()` at startedAtMs. The tick must still fire the watchdog.
    q.tick(nowMs + 30_000);
    expect(calls).toHaveLength(1);
    expect(q.stats().watchdogFired).toBe(1);
  });
});

describe('createSwmAckQuorum: snapshot immutability + ordering', () => {
  it('inspect() returns arrays whose mutation does NOT corrupt internal state', () => {
    // Defends the encapsulation contract: `inspect` is a debug
    // helper, callers must not be able to mutate the live record
    // by tampering with the returned snapshot.
    const q = makeQuorum();
    q.track({
      shareOperationId: 'op-snap',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 1.0,
    });
    const snap = q.inspect('op-snap')!;
    // Cast off readonly to attempt the mutation we're guarding against.
    (snap.expectedMembers as string[]).push('intruder');
    (snap.acked as string[]).push('p1');
    // After tampering, the live record must still expose the
    // original 3-member expected set and zero acks.
    const fresh = q.inspect('op-snap')!;
    expect([...fresh.expectedMembers].sort()).toEqual(['p1', 'p2', 'p3']);
    expect(fresh.acked).toEqual([]);
    // And no acks were silently injected — quorum still pending.
    expect(q.stats().pending).toBe(1);
  });

  it('dropPeer + rearmWatchdog combo: the next watchdog top-up excludes the dropped peer (no resurrection)', () => {
    // Tests the documented PR-H bug 2 fix end-to-end: after a
    // rejected peer is dropped AND we re-arm, the next watchdog
    // fire's `missingPeers` must NOT include the rejected peer.
    // A regression where rearmWatchdog re-derived missing peers
    // from a stale set would re-include the rejection.
    let nowMs = 1_000_000;
    const { calls, fn } = makeTopUp();
    const q = makeQuorum({ now: () => nowMs, topUp: fn });
    q.track({
      shareOperationId: 'op-drop-rearm-combo',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      watchdogMs: 30_000,
      deadlineHardMs: 5 * 60_000,
    });

    nowMs += 30_001;
    q.tick();
    expect(calls).toHaveLength(1);
    expect([...calls[0].missingPeers].sort()).toEqual(['p1', 'p2', 'p3']);

    // p2 returned the rejected sentinel — caller drops + rearms.
    q.dropPeer('op-drop-rearm-combo', 'p2');
    q.rearmWatchdog('op-drop-rearm-combo');
    expect(q.inspect('op-drop-rearm-combo')?.watchdogFired).toBe(false);

    nowMs += 30_001;
    q.tick();
    expect(calls).toHaveLength(2);
    // Crucial: the second top-up does NOT include p2.
    expect([...calls[1].missingPeers].sort()).toEqual(['p1', 'p3']);
    expect(calls[1].missingPeers).not.toContain('p2');
  });

  it('preAck + onAck combined exactly at threshold completes on the onAck (boundary semantic)', () => {
    // Probes the equality branch in `ackPctOf >= quorumThreshold`.
    // 4 expected, 3 pre-acked = 0.75 < 0.9, then onAck pushes to
    // 4/4 = 1.0 ≥ 0.9 → complete. Locks the inclusive-equality
    // semantic (not strict-greater-than which would block at
    // exactly-0.9 thresholds).
    const onQuorumCompleted = vi.fn();
    const q = makeQuorum({ observers: { onQuorumCompleted } });
    q.track({
      shareOperationId: 'op-boundary',
      cgId: 'cg',
      expectedMembers: ['p1', 'p2', 'p3', 'p4'],
      preAckedFromSubstrate: ['p1', 'p2', 'p3'],
      payload: PAYLOAD,
      enumerationSource: 'allowlist',
      quorumThreshold: 0.9,
    });
    expect(q.stats().completed).toBe(0);
    expect(q.inspect('op-boundary')?.ackPct).toBeCloseTo(0.75);

    q.onAck('op-boundary', 'p4');
    expect(q.stats().completed).toBe(1);
    expect(onQuorumCompleted).toHaveBeenCalledOnce();
    expect(onQuorumCompleted.mock.calls[0][0]).toMatchObject({
      shareOperationId: 'op-boundary',
      ackedCount: 4,
      expectedCount: 4,
      ackPct: 1,
    });
  });
});
