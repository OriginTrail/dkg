import { describe, expect, it } from 'vitest';
import {
  JoinApprovalRetryQueue,
  joinApprovalRetryKey,
  DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS,
  DEFAULT_JOIN_APPROVAL_RETRY_MAX_AGE_MS,
} from '../src/join-approval-retry-queue.js';

const CG = '0xC541F50f734E01d10dAF1bC1aEc3891fb3eA372E/chatt-test';
const AGENT = '0x3D6b4dee92805715cFfbE2A6C79D842f7Dce6b81';

describe('joinApprovalRetryKey', () => {
  it('lowercases the agent address but preserves the context graph id case', () => {
    expect(joinApprovalRetryKey(CG, AGENT)).toBe(
      `${CG}::${AGENT.toLowerCase()}`,
    );
  });

  it('matches across mixed-case agent inputs', () => {
    const upper = joinApprovalRetryKey(CG, AGENT.toUpperCase());
    const lower = joinApprovalRetryKey(CG, AGENT.toLowerCase());
    expect(upper).toBe(lower);
  });
});

describe('JoinApprovalRetryQueue.enqueueFailure', () => {
  it('creates a new entry on first failure and schedules using backoffs[0]', () => {
    const backoffs = [1000, 5000, 30000];
    const q = new JoinApprovalRetryQueue({ backoffs });
    const now = 1_000_000;
    const entry = q.enqueueFailure(CG, AGENT, 'reset', now);
    expect(entry).toMatchObject({
      contextGraphId: CG,
      agentAddress: AGENT,
      attempts: 1,
      firstFailureAt: now,
      lastAttemptAt: now,
      nextAttemptAt: now + backoffs[0],
      lastError: 'reset',
    });
    expect(q.size()).toBe(1);
  });

  it('bumps attempts and pushes nextAttemptAt for repeat failures on the same (cg, agent)', () => {
    const backoffs = [1000, 5000, 30000];
    const q = new JoinApprovalRetryQueue({ backoffs });
    const t0 = 1_000_000;
    q.enqueueFailure(CG, AGENT, 'first', t0);
    const second = q.enqueueFailure(CG, AGENT, 'second', t0 + 2000);
    expect(second.attempts).toBe(2);
    expect(second.firstFailureAt).toBe(t0);
    expect(second.lastAttemptAt).toBe(t0 + 2000);
    expect(second.nextAttemptAt).toBe(t0 + 2000 + backoffs[1]);
    expect(second.lastError).toBe('second');
    expect(q.size()).toBe(1);
  });

  it('caps backoff at the last ladder rung once attempts exceed the ladder length', () => {
    const backoffs = [1000, 5000, 30000];
    const q = new JoinApprovalRetryQueue({ backoffs });
    let now = 0;
    q.enqueueFailure(CG, AGENT, 'a', now); // attempts=1 → next = +1000
    now += 1000;
    q.enqueueFailure(CG, AGENT, 'b', now); // attempts=2 → next = +5000
    now += 5000;
    q.enqueueFailure(CG, AGENT, 'c', now); // attempts=3 → next = +30000
    now += 30000;
    q.enqueueFailure(CG, AGENT, 'd', now); // attempts=4 → cap at 30000
    const entry = q.getEntry(CG, AGENT)!;
    expect(entry.attempts).toBe(4);
    expect(entry.nextAttemptAt).toBe(now + 30000);
  });

  it('treats agent address case as insignificant', () => {
    const q = new JoinApprovalRetryQueue();
    q.enqueueFailure(CG, AGENT.toUpperCase(), 'first', 100);
    const second = q.enqueueFailure(CG, AGENT.toLowerCase(), 'second', 200);
    expect(second.attempts).toBe(2);
    expect(q.size()).toBe(1);
  });

  it('rejects empty backoff arrays at construction time', () => {
    expect(() => new JoinApprovalRetryQueue({ backoffs: [] })).toThrow(
      /backoffs must be non-empty/,
    );
  });
});

describe('JoinApprovalRetryQueue.markDelivered', () => {
  it('removes the entry and returns true when an entry was present', () => {
    const q = new JoinApprovalRetryQueue();
    q.enqueueFailure(CG, AGENT, 'reset', 0);
    expect(q.markDelivered(CG, AGENT)).toBe(true);
    expect(q.size()).toBe(0);
    expect(q.getEntry(CG, AGENT)).toBeUndefined();
  });

  it('returns false when no entry was queued for the pair', () => {
    const q = new JoinApprovalRetryQueue();
    expect(q.markDelivered(CG, AGENT)).toBe(false);
  });

  it('treats agent address case as insignificant', () => {
    const q = new JoinApprovalRetryQueue();
    q.enqueueFailure(CG, AGENT.toLowerCase(), 'reset', 0);
    expect(q.markDelivered(CG, AGENT.toUpperCase())).toBe(true);
    expect(q.size()).toBe(0);
  });
});

describe('JoinApprovalRetryQueue.due', () => {
  it('returns only entries whose nextAttemptAt has passed', () => {
    const backoffs = [1000, 5000];
    const q = new JoinApprovalRetryQueue({ backoffs });
    q.enqueueFailure(CG, AGENT, 'a', 0); // next = 1000
    q.enqueueFailure(CG, '0xabc', 'b', 0); // next = 1000
    q.enqueueFailure('cg2', '0xdef', 'c', 500); // next = 1500

    expect(q.due(900).length).toBe(0);
    expect(q.due(1000).length).toBe(2);
    expect(q.due(1500).length).toBe(3);
  });

  it('includes an entry exactly at its nextAttemptAt boundary (inclusive)', () => {
    const q = new JoinApprovalRetryQueue({ backoffs: [1000] });
    q.enqueueFailure(CG, AGENT, 'a', 0);
    const due = q.due(1000);
    expect(due).toHaveLength(1);
    expect(due[0].contextGraphId).toBe(CG);
  });
});

describe('JoinApprovalRetryQueue.dropExpired', () => {
  it('evicts entries older than maxAgeMs since firstFailureAt and returns them', () => {
    const q = new JoinApprovalRetryQueue({ backoffs: [1000], maxAgeMs: 10_000 });
    q.enqueueFailure(CG, AGENT, 'a', 0); // firstFailureAt=0
    q.enqueueFailure('cg-young', AGENT, 'b', 9_000); // firstFailureAt=9000
    const dropped = q.dropExpired(15_000);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].contextGraphId).toBe(CG);
    expect(q.size()).toBe(1);
    expect(q.getEntry('cg-young', AGENT)).toBeDefined();
  });

  it('does not evict entries at exactly maxAgeMs (strict greater-than)', () => {
    const q = new JoinApprovalRetryQueue({ backoffs: [1000], maxAgeMs: 5000 });
    q.enqueueFailure(CG, AGENT, 'a', 0);
    expect(q.dropExpired(5000)).toHaveLength(0);
    expect(q.size()).toBe(1);
  });

  it('returns an empty array when nothing is expired', () => {
    const q = new JoinApprovalRetryQueue({ backoffs: [1000], maxAgeMs: 100_000 });
    q.enqueueFailure(CG, AGENT, 'a', 0);
    expect(q.dropExpired(50_000)).toEqual([]);
    expect(q.size()).toBe(1);
  });
});

describe('JoinApprovalRetryQueue defaults', () => {
  it('uses 8-rung backoff ladder when no options provided', () => {
    expect(DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS.length).toBe(8);
    expect(DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS[0]).toBe(10_000);
  });

  it('default maxAgeMs is 24 hours', () => {
    expect(DEFAULT_JOIN_APPROVAL_RETRY_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('default queue follows documented behaviour at first failure', () => {
    const q = new JoinApprovalRetryQueue();
    const entry = q.enqueueFailure(CG, AGENT, 'reset', 1000);
    expect(entry.nextAttemptAt).toBe(1000 + DEFAULT_JOIN_APPROVAL_RETRY_BACKOFFS_MS[0]);
  });
});

describe('JoinApprovalRetryQueue.list / clear', () => {
  it('list() returns shallow copies, independent of internal state', () => {
    const q = new JoinApprovalRetryQueue();
    q.enqueueFailure(CG, AGENT, 'reset', 0);
    const snap = q.list();
    snap[0].attempts = 999;
    expect(q.getEntry(CG, AGENT)!.attempts).toBe(1);
  });

  it('clear() empties the queue', () => {
    const q = new JoinApprovalRetryQueue();
    q.enqueueFailure(CG, AGENT, 'a', 0);
    q.enqueueFailure('cg2', AGENT, 'b', 0);
    q.clear();
    expect(q.size()).toBe(0);
  });
});
