import { describe, expect, it } from 'vitest';
import {
  createSelectedSwmMetaRetentionBudget,
} from '../src/sync/selected-swm-meta-budget.js';

describe('selected SWM metadata retention budget', () => {
  it('accounts retained prefixes across Context Graphs and overlapping invocations', () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 3,
      maxBytesEstimate: 300,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const first = budget.lease();
    const second = budget.lease();

    first.replace(2, 200);
    const remaining = second.reserve();
    expect(remaining).toEqual(expect.objectContaining({
      maxRows: 1,
      maxBytesEstimate: 100,
    }));
    remaining.release();
    expect(() => second.replace(2, 200)).toThrowError(expect.objectContaining({
      code: 'SELECTED_SWM_META_RETENTION_LIMIT',
      dimension: 'rows',
      actual: 4,
      limit: 3,
    }));

    second.replace(1, 100);
    const exhausted = second.reserve();
    expect(exhausted).toEqual(expect.objectContaining({
      maxRows: 0,
      maxBytesEstimate: 0,
    }));
    exhausted.release();
    first.release();
    const restored = second.reserve();
    expect(restored).toEqual(expect.objectContaining({
      maxRows: 1,
      maxBytesEstimate: 100,
    }));
    restored.release();
    second.release();
  });

  it('atomically replaces a restarted generation instead of double-counting it', () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 10,
      maxBytesEstimate: 1_000,
      maxPrefixRows: 10,
      maxPrefixBytesEstimate: 1_000,
    });
    const lease = budget.lease();

    lease.replace(8, 800);
    // The conservative pre-fetch allowance is append-only.
    const remaining = lease.reserve();
    expect(remaining).toEqual(expect.objectContaining({
      maxRows: 2,
      maxBytesEstimate: 200,
    }));
    remaining.release();
    // Once the responder restart is known, replacement frees the old prefix.
    lease.replace(2, 200);
    const restarted = lease.reserve();
    expect(restarted).toEqual(expect.objectContaining({
      maxRows: 8,
      maxBytesEstimate: 800,
    }));
    restarted.release();
    lease.release();
  });

  it('reserves global capacity before overlapping fetches start', () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 3,
      maxBytesEstimate: 300,
      maxPrefixRows: 3,
      maxPrefixBytesEstimate: 300,
    });
    const first = budget.lease();
    const second = budget.lease();

    const firstFetch = first.reserve();
    expect(firstFetch).toEqual(expect.objectContaining({
      maxRows: 3,
      maxBytesEstimate: 300,
    }));
    const concurrentFetch = second.reserve();
    expect(concurrentFetch).toEqual(expect.objectContaining({
      maxRows: 0,
      maxBytesEstimate: 0,
    }));

    firstFetch.commitReplace(2, 200);
    concurrentFetch.release();
    const afterCommit = second.reserve();
    expect(afterCommit).toEqual(expect.objectContaining({
      maxRows: 1,
      maxBytesEstimate: 100,
    }));
    afterCommit.release();
    first.release();
    second.release();
  });

  it('separates a lease-own prefix ceiling from shared-pool contention', () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 4,
      maxBytesEstimate: 400,
      maxPrefixRows: 1,
      maxPrefixBytesEstimate: 100,
    });
    const lease = budget.lease();

    const admittedFirst = lease.reserve();
    expect(admittedFirst.exhaustion).toBeNull();
    admittedFirst.release();

    // At this lease's OWN per-prefix ceiling while the shared pool still has
    // room: no later pass can widen it, so the caller must keep failing closed
    // instead of waiting for capacity that is already its own limit.
    lease.replace(1, 100);
    const ownCeiling = lease.reserve();
    expect(ownCeiling).toEqual(expect.objectContaining({
      maxRows: 0,
      exhaustion: 'prefix',
    }));
    ownCeiling.release();
    lease.release();

    // Below its own ceiling but blocked by rows the pool already handed to a
    // sibling: transient, and therefore reported as a different exhaustion.
    const shared = createSelectedSwmMetaRetentionBudget({
      maxRows: 1,
      maxBytesEstimate: 400,
      maxPrefixRows: 4,
      maxPrefixBytesEstimate: 400,
    });
    const holder = shared.lease();
    const waiter = shared.lease();
    holder.replace(1, 100);
    const contended = waiter.reserve();
    expect(contended).toEqual(expect.objectContaining({
      maxRows: 0,
      exhaustion: 'shared',
    }));
    contended.release();

    // Releasing the holder restores capacity, so the waiter is admitted again.
    holder.release();
    const admitted = waiter.reserve();
    expect(admitted.exhaustion).toBeNull();
    expect(admitted.maxRows).toBe(1);
    admitted.release();
    waiter.release();
  });
});
