import { describe, expect, it } from 'vitest';
import { RetryQueue, type RetryEntry } from '../src/retry-queue.js';

interface SamplePayload {
  who: string;
  what: string;
}

const KEY_A = 'recipient-a::msg-1';
const KEY_B = 'recipient-b::msg-1';
const PAYLOAD_A: SamplePayload = { who: 'recipient-a', what: 'msg-1' };
const PAYLOAD_B: SamplePayload = { who: 'recipient-b', what: 'msg-1' };

describe('RetryQueue construction', () => {
  it('rejects empty backoff arrays at construction time', () => {
    expect(
      () => new RetryQueue<SamplePayload>({ backoffs: [], maxAgeMs: 1000 }),
    ).toThrow(/backoffs must be non-empty/);
  });

  it('accepts a single-rung backoff (degenerate but valid)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 5000 });
    expect(q.size()).toBe(0);
  });
});

describe('RetryQueue.enqueueFailure', () => {
  it('creates a new entry on first failure with payload fields merged onto the entry', () => {
    const backoffs = [1000, 5000, 30000];
    const q = new RetryQueue<SamplePayload>({ backoffs, maxAgeMs: 60_000 });
    const entry = q.enqueueFailure(KEY_A, PAYLOAD_A, 'reset', 1_000_000);

    expect(entry.who).toBe('recipient-a');
    expect(entry.what).toBe('msg-1');
    expect(entry.attempts).toBe(1);
    expect(entry.firstFailureAt).toBe(1_000_000);
    expect(entry.lastAttemptAt).toBe(1_000_000);
    expect(entry.nextAttemptAt).toBe(1_000_000 + backoffs[0]);
    expect(entry.lastError).toBe('reset');
    expect(q.size()).toBe(1);
  });

  it('bumps attempts and pushes nextAttemptAt on repeat failure for the same key', () => {
    const backoffs = [1000, 5000, 30000];
    const q = new RetryQueue<SamplePayload>({ backoffs, maxAgeMs: 60_000 });
    const t0 = 1_000_000;
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'first', t0);
    const second = q.enqueueFailure(KEY_A, PAYLOAD_A, 'second', t0 + 2000);

    expect(second.attempts).toBe(2);
    expect(second.firstFailureAt).toBe(t0);
    expect(second.lastAttemptAt).toBe(t0 + 2000);
    expect(second.nextAttemptAt).toBe(t0 + 2000 + backoffs[1]);
    expect(second.lastError).toBe('second');
    expect(q.size()).toBe(1);
  });

  it('caps backoff at the last ladder rung once attempts exceed the ladder length', () => {
    const backoffs = [1000, 5000, 30000];
    const q = new RetryQueue<SamplePayload>({ backoffs, maxAgeMs: 60_000 });
    let now = 0;
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', now); // attempts=1 → next = +1000
    now += 1000;
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'b', now); // attempts=2 → next = +5000
    now += 5000;
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'c', now); // attempts=3 → next = +30000
    now += 30000;
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'd', now); // attempts=4 → cap at 30000
    const entry = q.getEntry(KEY_A)!;
    expect(entry.attempts).toBe(4);
    expect(entry.nextAttemptAt).toBe(now + 30000);
  });

  it('mutates existing entry in place on repeat failure (live reference stays current)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000, 2000], maxAgeMs: 60_000 });
    const first = q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0);
    const second = q.enqueueFailure(KEY_A, PAYLOAD_A, 'b', 100);

    expect(first).toBe(second);
    expect(first.attempts).toBe(2);
    expect(first.lastError).toBe('b');
  });

  it('does NOT overwrite payload fields on repeat failure (existing payload is authoritative)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, { who: 'original', what: 'first' }, 'a', 0);
    const updated = q.enqueueFailure(KEY_A, { who: 'overwritten', what: 'second' }, 'b', 100);

    expect(updated.who).toBe('original');
    expect(updated.what).toBe('first');
    expect(updated.attempts).toBe(2);
    expect(updated.lastError).toBe('b');
  });

  it('keys are case-sensitive (queue treats keys as opaque strings)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 60_000 });
    q.enqueueFailure('Recipient-A', PAYLOAD_A, 'a', 0);
    q.enqueueFailure('recipient-a', PAYLOAD_A, 'b', 0);
    expect(q.size()).toBe(2);
  });
});

describe('RetryQueue.markDelivered', () => {
  it('removes the entry and returns true when an entry was present', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'reset', 0);
    expect(q.markDelivered(KEY_A)).toBe(true);
    expect(q.size()).toBe(0);
    expect(q.getEntry(KEY_A)).toBeUndefined();
  });

  it('returns false when no entry was queued for the key', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 60_000 });
    expect(q.markDelivered(KEY_A)).toBe(false);
  });

  it('only removes the entry matching the exact key (not other entries)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0);
    q.enqueueFailure(KEY_B, PAYLOAD_B, 'b', 0);
    expect(q.markDelivered(KEY_A)).toBe(true);
    expect(q.size()).toBe(1);
    expect(q.getEntry(KEY_B)).toBeDefined();
  });
});

describe('RetryQueue.due', () => {
  it('returns only entries whose nextAttemptAt has passed', () => {
    const backoffs = [1000, 5000];
    const q = new RetryQueue<SamplePayload>({ backoffs, maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0); // next = 1000
    q.enqueueFailure(KEY_B, PAYLOAD_B, 'b', 0); // next = 1000
    q.enqueueFailure('cg2', { who: 'cg2', what: 'x' }, 'c', 500); // next = 1500

    expect(q.due(900).length).toBe(0);
    expect(q.due(1000).length).toBe(2);
    expect(q.due(1500).length).toBe(3);
  });

  it('includes an entry exactly at its nextAttemptAt boundary (inclusive)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0);
    const due = q.due(1000);
    expect(due).toHaveLength(1);
    expect(due[0].who).toBe('recipient-a');
  });

  it('returns an empty array when nothing is due', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [10_000], maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0);
    expect(q.due(5000)).toEqual([]);
  });
});

describe('RetryQueue.dropExpired', () => {
  it('evicts entries older than maxAgeMs since firstFailureAt and returns them', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 10_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0); // firstFailureAt=0
    q.enqueueFailure(KEY_B, PAYLOAD_B, 'b', 9_000); // firstFailureAt=9000
    const dropped = q.dropExpired(15_000);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].who).toBe('recipient-a');
    expect(q.size()).toBe(1);
    expect(q.getEntry(KEY_B)).toBeDefined();
  });

  it('does not evict entries at exactly maxAgeMs (strict greater-than)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 5000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0);
    expect(q.dropExpired(5000)).toHaveLength(0);
    expect(q.size()).toBe(1);
  });

  it('returns an empty array when nothing is expired', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 100_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0);
    expect(q.dropExpired(50_000)).toEqual([]);
    expect(q.size()).toBe(1);
  });

  it('uses firstFailureAt for expiry, not lastAttemptAt (caller cannot extend lifetime by retrying)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 10_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0); // firstFailureAt=0
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'b', 5_000); // lastAttemptAt=5000, but firstFailureAt still 0
    const dropped = q.dropExpired(11_000);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].firstFailureAt).toBe(0);
  });
});

describe('RetryQueue.list / getEntry / clear', () => {
  it('list() returns shallow copies, independent of internal state', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'reset', 0);
    const snap: Array<RetryEntry<SamplePayload>> = q.list();
    snap[0].attempts = 999;
    snap[0].who = 'mutated';
    expect(q.getEntry(KEY_A)!.attempts).toBe(1);
    expect(q.getEntry(KEY_A)!.who).toBe('recipient-a');
  });

  it('getEntry() returns the live reference (callers can observe mutation through it)', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000, 2000], maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0);
    const ref = q.getEntry(KEY_A)!;
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'b', 100);
    expect(ref.attempts).toBe(2);
    expect(ref.lastError).toBe('b');
  });

  it('clear() empties the queue', () => {
    const q = new RetryQueue<SamplePayload>({ backoffs: [1000], maxAgeMs: 60_000 });
    q.enqueueFailure(KEY_A, PAYLOAD_A, 'a', 0);
    q.enqueueFailure(KEY_B, PAYLOAD_B, 'b', 0);
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.list()).toEqual([]);
  });
});
