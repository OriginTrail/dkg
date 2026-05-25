import { describe, expect, it } from 'vitest';
import { DiscoveryRateLimit } from '../../src/swm/discovery-rate-limit.js';

const EOA_A = '0x0000000000000000000000000000000000000001';
const EOA_B = '0x0000000000000000000000000000000000000002';

function makeClock(startMs: number) {
  let now = startMs;
  return {
    now: () => now,
    advance: (deltaMs: number) => { now += deltaMs; },
  };
}

describe('DiscoveryRateLimit', () => {
  it('admits writes within the per-curator-per-minute budget', () => {
    const clock = makeClock(1_700_000_000_000);
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 1024,
      perCuratorBytesPerHour: 10 * 1024,
      coreAggregateBytes: 1024 * 1024,
      now: clock.now,
    });

    expect(rl.admit(EOA_A, 512).admit).toBe(true);
    expect(rl.admit(EOA_A, 512).admit).toBe(true);

    const denied = rl.admit(EOA_A, 1);
    expect(denied.admit).toBe(false);
    expect(denied.reason).toMatch(/per-minute/);
  });

  it('the per-minute window slides cleanly after 60 seconds', () => {
    const clock = makeClock(1_700_000_000_000);
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 1024,
      perCuratorBytesPerHour: 10 * 1024,
      coreAggregateBytes: 1024 * 1024,
      now: clock.now,
    });

    expect(rl.admit(EOA_A, 1024).admit).toBe(true);
    expect(rl.admit(EOA_A, 1).admit).toBe(false);

    clock.advance(61_000);
    expect(rl.admit(EOA_A, 1024).admit).toBe(true);
  });

  it('enforces the per-hour window independently of the per-minute window', () => {
    const clock = makeClock(1_700_000_000_000);
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 1024,
      perCuratorBytesPerHour: 2048,
      coreAggregateBytes: 1024 * 1024,
      now: clock.now,
    });

    expect(rl.admit(EOA_A, 1024).admit).toBe(true);
    clock.advance(61_000);
    expect(rl.admit(EOA_A, 1024).admit).toBe(true);
    clock.advance(61_000);
    const denied = rl.admit(EOA_A, 1);
    expect(denied.admit).toBe(false);
    expect(denied.reason).toMatch(/per-hour/);
  });

  it('per-curator budgets are isolated between curators', () => {
    const clock = makeClock(1_700_000_000_000);
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 1024,
      perCuratorBytesPerHour: 10 * 1024,
      coreAggregateBytes: 1024 * 1024,
      now: clock.now,
    });

    expect(rl.admit(EOA_A, 1024).admit).toBe(true);
    expect(rl.admit(EOA_A, 1).admit).toBe(false);
    expect(rl.admit(EOA_B, 1024).admit).toBe(true);
  });

  it('enforces the per-core aggregate budget and rejects without mutating per-curator counters', () => {
    const clock = makeClock(1_700_000_000_000);
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 1024,
      perCuratorBytesPerHour: 10 * 1024,
      coreAggregateBytes: 1024,
      now: clock.now,
    });

    expect(rl.admit(EOA_A, 512).admit).toBe(true);
    expect(rl.admit(EOA_B, 512).admit).toBe(true);
    const denied = rl.admit(EOA_A, 1);
    expect(denied.admit).toBe(false);
    expect(denied.reason).toMatch(/core aggregate/);

    const snapshot = rl.snapshot();
    expect(snapshot.curators[EOA_A].minuteBytes).toBe(512);
    expect(snapshot.coreAggregateBytes).toBe(1024);
  });

  it('rejected writes do not consume any per-curator-window budget', () => {
    const clock = makeClock(1_700_000_000_000);
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 1024,
      perCuratorBytesPerHour: 10 * 1024,
      coreAggregateBytes: 1024 * 1024,
      now: clock.now,
    });

    expect(rl.admit(EOA_A, 1024).admit).toBe(true);
    const denied = rl.admit(EOA_A, 256);
    expect(denied.admit).toBe(false);
    expect(denied.state.curatorBytesThisMinute).toBe(1024);

    clock.advance(61_000);
    expect(rl.admit(EOA_A, 1024).admit).toBe(true);
  });

  it('releaseAggregate frees core-aggregate budget without unwinding per-curator history', () => {
    const clock = makeClock(1_700_000_000_000);
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 1024,
      perCuratorBytesPerHour: 10 * 1024,
      coreAggregateBytes: 1024,
      now: clock.now,
    });

    expect(rl.admit(EOA_A, 1024).admit).toBe(true);
    expect(rl.admit(EOA_B, 1).admit).toBe(false);

    rl.releaseAggregate(1024);
    expect(rl.snapshot().coreAggregateBytes).toBe(0);
    expect(rl.snapshot().curators[EOA_A].minuteBytes).toBe(1024);
    expect(rl.admit(EOA_B, 1).admit).toBe(true);
  });

  it('seedAggregate primes the core-aggregate counter on restart', () => {
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 10 * 1024 * 1024,
      perCuratorBytesPerHour: 100 * 1024 * 1024,
      coreAggregateBytes: 1024,
    });

    rl.seedAggregate(1024);
    expect(rl.admit(EOA_A, 1).admit).toBe(false);
    rl.releaseAggregate(1024);
    expect(rl.admit(EOA_A, 1).admit).toBe(true);
  });

  it('curator address is normalized to lowercase for budget bookkeeping', () => {
    const clock = makeClock(1_700_000_000_000);
    const rl = new DiscoveryRateLimit({
      perCuratorBytesPerMinute: 1024,
      perCuratorBytesPerHour: 10 * 1024,
      coreAggregateBytes: 1024 * 1024,
      now: clock.now,
    });

    expect(rl.admit('0x' + 'A'.repeat(40), 512).admit).toBe(true);
    expect(rl.admit('0x' + 'a'.repeat(40), 512).admit).toBe(true);
    const denied = rl.admit('0x' + 'A'.repeat(40), 1);
    expect(denied.admit).toBe(false);
  });

  it('clamps releaseAggregate to zero (no negative aggregate state)', () => {
    const rl = new DiscoveryRateLimit({ coreAggregateBytes: 1024 });
    rl.releaseAggregate(1_000_000);
    expect(rl.snapshot().coreAggregateBytes).toBe(0);
  });
});
