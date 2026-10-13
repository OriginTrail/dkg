import { describe, expect, it, vi } from 'vitest';
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

  it('waits for a sibling fetch in flight and resumes once it has committed', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 200,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const holder = budget.lease();
    const waiter = budget.lease();

    // Every fetch reserves a whole prefix allowance before it starts, so one
    // fetch in flight leaves the pool with nothing to hand out.
    const inFlight = holder.reserve();
    const contended = waiter.reserve();
    expect(contended.exhaustion).toBe('shared');
    contended.release();

    let woken = false;
    const waiting = waiter.waitForSharedCapacity(60_000).then((capacityFreed) => {
      woken = true;
      return capacityFreed;
    });
    await Promise.resolve();
    expect(woken).toBe(false);

    inFlight.commitReplace(1, 100);
    await expect(waiting).resolves.toBe(true);
    // The waiter runs after the commit is applied: it sees what the sibling
    // kept, not the allowance the sibling had reserved.
    const admitted = waiter.reserve();
    expect(admitted).toEqual(expect.objectContaining({
      maxRows: 1,
      maxBytesEstimate: 100,
      exhaustion: null,
    }));
    admitted.release();
    holder.release();
    waiter.release();
  });

  it('wakes a waiter when a fetch is abandoned, its lease is dropped, or a prefix is handed back', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 3,
      maxBytesEstimate: 300,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const retained = budget.lease();
    retained.replace(1, 100);
    const waiter = budget.lease();

    const abandoned = budget.lease().reserve();
    const afterAbandon = waiter.waitForSharedCapacity(60_000);
    abandoned.release();
    await expect(afterAbandon).resolves.toBe(true);

    const dropped = budget.lease();
    dropped.reserve();
    const afterDrop = waiter.waitForSharedCapacity(60_000);
    dropped.release();
    await expect(afterDrop).resolves.toBe(true);

    // A sibling still fetching keeps the waiter waiting; another lease that
    // gives its rows back frees capacity in the meantime.
    const stillFetching = budget.lease().reserve();
    const afterHandBack = waiter.waitForSharedCapacity(60_000);
    retained.replace(0, 0);
    await expect(afterHandBack).resolves.toBe(true);
    const admitted = waiter.reserve();
    expect(admitted).toEqual(expect.objectContaining({ maxRows: 1, exhaustion: null }));
    admitted.release();
    stillFetching.release();
    retained.release();
    waiter.release();
  });

  it('does not wait when nothing bounded would free capacity', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 200,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const holder = budget.lease();
    const waiter = budget.lease();

    // A pool held by a retained prefix: only its owner or the retention clock
    // gives it back, and neither is bounded by a fetch.
    holder.replace(2, 200);
    const contended = waiter.reserve();
    expect(contended.exhaustion).toBe('shared');
    contended.release();
    await expect(waiter.waitForSharedCapacity(60_000)).resolves.toBe(false);

    // A reservation that admits nothing frees nothing when it settles. The
    // holder is at its own ceiling, and the waiter's own reservation is not a
    // sibling's.
    const ownCeiling = holder.reserve();
    expect(ownCeiling).toEqual(expect.objectContaining({ maxRows: 0, exhaustion: 'prefix' }));
    await expect(waiter.waitForSharedCapacity(60_000)).resolves.toBe(false);
    ownCeiling.release();
    holder.release();

    const own = waiter.reserve();
    expect(own.exhaustion).toBeNull();
    await expect(waiter.waitForSharedCapacity(60_000)).resolves.toBe(false);
    own.release();

    // No time left, and a lease that was released, never start a wait.
    const inFlight = budget.lease().reserve();
    await expect(waiter.waitForSharedCapacity(0)).resolves.toBe(false);
    await expect(waiter.waitForSharedCapacity(Number.NaN)).resolves.toBe(false);
    waiter.release();
    await expect(waiter.waitForSharedCapacity(60_000)).resolves.toBe(false);
    inFlight.release();
  });

  it('stops waiting at its timeout and is not woken afterwards', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 200,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const holder = budget.lease();
    const waiter = budget.lease();
    const inFlight = holder.reserve();

    const outcomes: boolean[] = [];
    await waiter.waitForSharedCapacity(5).then((capacityFreed) => outcomes.push(capacityFreed));
    expect(outcomes).toEqual([false]);

    // The fetch settles later: the expired wait must not resolve a second time
    // and a new wait starts from the pool as it is then.
    inFlight.release();
    await Promise.resolve();
    expect(outcomes).toEqual([false]);
    await expect(waiter.waitForSharedCapacity(60_000)).resolves.toBe(false);
    holder.release();
    waiter.release();
  });

  it('ends a wait when its signal aborts, and does not start one for an aborted signal', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 200,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const inFlight = budget.lease().reserve();
    const waiter = budget.lease();

    const revoked = new AbortController();
    const outcomes: boolean[] = [];
    const waiting = waiter.waitForSharedCapacity(60_000, revoked.signal)
      .then((capacityFreed) => outcomes.push(capacityFreed));
    await Promise.resolve();
    expect(outcomes).toEqual([]);
    revoked.abort();
    await waiting;
    expect(outcomes).toEqual([false]);

    await expect(waiter.waitForSharedCapacity(60_000, revoked.signal)).resolves.toBe(false);

    // A wait that ended on capacity no longer listens to its signal.
    const later = new AbortController();
    const removeListener = vi.spyOn(later.signal, 'removeEventListener');
    const woken = waiter.waitForSharedCapacity(60_000, later.signal);
    inFlight.release();
    await expect(woken).resolves.toBe(true);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    waiter.release();
  });

  it('does not let waiting leases wake each other while the fetch is still in flight', async () => {
    // Rows and bytes are pooled separately. A lease that retries while the
    // rows are taken can still be handed bytes, and gives them straight back.
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 400,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const inFlight = budget.lease().reserve();
    const first = budget.lease();
    const second = budget.lease();

    let wakes = 0;
    const firstWait = first.waitForSharedCapacity(60_000).then(() => { wakes += 1; });
    const retry = second.reserve();
    expect(retry).toEqual(expect.objectContaining({
      maxRows: 0,
      maxBytesEstimate: 200,
      exhaustion: 'shared',
    }));
    retry.release();
    const secondWait = second.waitForSharedCapacity(60_000).then(() => { wakes += 1; });
    await new Promise((resolve) => setImmediate(resolve));
    // Nothing a fetch could use was freed, so nobody was woken: two waiters
    // that woke each other would never let the fetch in flight finish.
    expect(wakes).toBe(0);

    inFlight.release();
    await Promise.all([firstWait, secondWait]);
    expect(wakes).toBe(2);
    first.release();
    second.release();
  });
});
