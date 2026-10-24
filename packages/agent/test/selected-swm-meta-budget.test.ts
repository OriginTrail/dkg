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

  // The cases below are about a lease that has to wait for the pool. Every
  // fetch reserves a whole prefix allowance before it starts, so a pool of
  // three allowances admits three fetches at once however little they retain.
  const pool = (allowances: number) => createSelectedSwmMetaRetentionBudget({
    maxRows: 2 * allowances,
    maxBytesEstimate: 200 * allowances,
    maxPrefixRows: 2,
    maxPrefixBytesEstimate: 200,
  });
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  it('grants a waiting lease its whole allowance once the fetch in flight has committed', async () => {
    const budget = pool(1);
    const holder = budget.lease();
    const inFlight = holder.reserve();
    const second = budget.lease();
    const contended = second.reserve();
    expect(contended).toEqual(expect.objectContaining({ exhaustion: 'shared' }));
    contended.release();

    let granted: unknown;
    const waiting = second.reserveWholeAllowance(60_000).then((reservation) => {
      granted = reservation;
      return reservation;
    });
    await turn();
    expect(granted).toBeUndefined();

    inFlight.commitReplace(0, 0);
    const reservation = await waiting;
    // The grant is a reservation: the lease does not have to ask again, and
    // nobody else can take the allowance in between.
    expect(reservation).toEqual(expect.objectContaining({
      maxRows: 2,
      maxBytesEstimate: 200,
      exhaustion: null,
    }));
    expect(holder.reserve()).toEqual(expect.objectContaining({ exhaustion: 'shared' }));
    reservation!.release();
    holder.release();
    second.release();
  });

  it('never grants a share of an allowance: it waits on, or reports that nothing is left to wait for', async () => {
    const budget = pool(2);
    const first = budget.lease();
    const other = budget.lease();
    const firstFetch = first.reserve();
    const otherFetch = other.reserve();
    const waiter = budget.lease();

    let settled = false;
    const waiting = waiter.reserveWholeAllowance(60_000).finally(() => { settled = true; });
    // One row of the first allowance is kept, three are free while the other
    // fetch is still in flight: less than a whole allowance, so no grant, and
    // something is still in flight, so no refusal either.
    firstFetch.commitReplace(1, 100);
    await turn();
    expect(settled).toBe(false);

    // The other fetch keeps a prefix too. Two rows are free, which is a whole
    // allowance, but not with the row each of the two unfinished transfers
    // could still go on to claim. Nothing is in flight any more, so the wait
    // ends without a grant.
    otherFetch.commitReplace(1, 100);
    await expect(waiting).resolves.toBeNull();
    first.release();
    other.release();
    waiter.release();
  });

  it('keeps no room for a prefix that is a whole manifest', async () => {
    const budget = pool(2);
    const first = budget.lease();
    const other = budget.lease();
    const firstFetch = first.reserve();
    const otherFetch = other.reserve();
    const waiter = budget.lease();
    const waiting = waiter.reserveWholeAllowance(60_000);

    // Both peers answer with their whole manifest, one row each. Neither
    // transfer will fetch more, so the two rows that are free are a whole
    // allowance for the lease that waited.
    firstFetch.commitReplace(1, 100, true);
    otherFetch.commitReplace(1, 100, true);
    const reservation = await waiting;
    expect(reservation).toEqual(expect.objectContaining({ maxRows: 2, maxBytesEstimate: 200 }));
    reservation!.release();
    first.release();
    other.release();
    waiter.release();
  });

  it('keeps no room for a prefix whose round has ended', async () => {
    // Two allowances and one row more.
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 5,
      maxBytesEstimate: 500,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const stale = budget.lease();
    const fetching = budget.lease();
    const staleFetch = stale.reserve();
    const inFlight = fetching.reserve();
    const waiter = budget.lease();
    const waiting = waiter.reserveWholeAllowance(60_000);
    let granted = false;
    void waiting.then(() => { granted = true; });

    // One row of an unfinished manifest is kept. Its transfer is between two
    // passes, and one of the two rows that are free is the one it comes back
    // for: the waiting lease is not let through.
    staleFetch.commitReplace(1, 100);
    await turn();
    expect(granted).toBe(false);

    // The round ends with the manifest unfinished. The prefix is kept for a
    // later round, which may never come, and holds no room meanwhile.
    stale.endRound();
    const reservation = await waiting;
    expect(reservation).toEqual(expect.objectContaining({ maxRows: 2, maxBytesEstimate: 200 }));
    // Ending the round twice, or on a lease that kept nothing, changes nothing.
    stale.endRound();
    waiter.endRound();
    reservation!.release();

    // The next round's fetch makes it a transfer between two passes again.
    stale.reserve().commitReplace(1, 100);
    const again = waiter.reserveWholeAllowance(60_000);
    let grantedAgain = false;
    void again.then(() => { grantedAgain = true; });
    await turn();
    expect(grantedAgain).toBe(false);
    stale.endRound();
    (await again)!.release();
    inFlight.release();
    for (const lease of [stale, fetching, waiter]) lease.release();
    // A released lease has no round to end.
    stale.endRound();
  });

  it('grants a lease that holds a prefix the whole rest of its own allowance', async () => {
    const budget = pool(1);
    const continuing = budget.lease();
    continuing.reserve().commitReplace(1, 100);
    const other = budget.lease();
    const inFlight = other.reserve();
    expect(inFlight).toEqual(expect.objectContaining({ maxRows: 1, maxBytesEstimate: 100 }));

    // Its own prefix is no claim against itself: the row that comes free is
    // the whole rest of its allowance.
    const waiting = continuing.reserveWholeAllowance(60_000);
    inFlight.release();
    const reservation = await waiting;
    expect(reservation).toEqual(expect.objectContaining({ maxRows: 1, maxBytesEstimate: 100 }));
    reservation!.commitReplace(2, 200, true);
    continuing.release();
    other.release();
  });

  it('restarts a prefix with a fresh allowance before a waiting lease decides', async () => {
    const budget = pool(2);
    const restarting = budget.lease();
    restarting.reserve().commitReplace(2, 200);
    // Its prefix came from an earlier round: nothing is kept for it.
    restarting.endRound();
    const failed = restarting.reserve();
    expect(failed).toEqual(expect.objectContaining({ maxRows: 0, exhaustion: 'prefix' }));
    const other = budget.lease();
    const inFlight = other.reserve();
    const waiter = budget.lease();
    const waiting = waiter.reserveWholeAllowance(60_000);
    let granted = false;
    void waiting.then((reservation) => { granted = reservation !== null; });

    // The restart frees a whole allowance and takes it again in one step. A
    // waiting lease that was handed it in between would leave the restarted
    // transfer nothing to start over with.
    const fresh = restarting.restart();
    expect(fresh).toEqual(expect.objectContaining({
      maxRows: 2,
      maxBytesEstimate: 200,
      exhaustion: null,
    }));
    await turn();
    expect(granted).toBe(false);
    // The reservation of the failed fetch went with the restart: releasing it
    // afterwards gives nothing back twice.
    failed.release();
    expect(budget.lease().reserve()).toEqual(expect.objectContaining({ maxRows: 0 }));

    fresh.commitReplace(0, 0, true);
    (await waiting)!.release();
    inFlight.release();
    restarting.release();
    expect(() => restarting.restart()).toThrow(/released/);
    for (const lease of [other, waiter]) lease.release();
  });

  it('grants only what leaves a lease that holds a prefix the room it could still claim', async () => {
    const budget = pool(3);
    const continuing = budget.lease();
    const firstSlice = continuing.reserve();
    const fetching = [budget.lease().reserve(), budget.lease().reserve()];
    const waiter = budget.lease();
    const waiting = waiter.reserveWholeAllowance(60_000);
    let granted = false;
    void waiting.then(() => { granted = true; });

    // The transfer keeps one row of a manifest it has not finished. The row
    // it did not use is free again, and belongs to its next pass.
    firstSlice.commitReplace(1, 100);
    await turn();
    expect(granted).toBe(false);
    const nextPass = continuing.reserve();
    expect(nextPass).toEqual(expect.objectContaining({ maxRows: 1, exhaustion: null }));
    nextPass.release();

    // An empty answer frees a whole allowance. Granting it still leaves the
    // continuing transfer its row.
    fetching[0]!.commitReplace(0, 0);
    const reservation = await waiting;
    expect(reservation).toEqual(expect.objectContaining({ maxRows: 2, maxBytesEstimate: 200 }));
    expect(continuing.reserve()).toEqual(expect.objectContaining({ maxRows: 1, exhaustion: null }));
    reservation!.release();
    fetching[1]!.release();
    continuing.release();
    waiter.release();
  });

  it('counts the room of a transfer that is fetching its next pass only once', async () => {
    const budget = pool(2);
    const continuing = budget.lease();
    continuing.reserve().commitReplace(1, 100);
    // Its next pass has the rest of its allowance reserved.
    const nextPass = continuing.reserve();
    expect(nextPass).toEqual(expect.objectContaining({ maxRows: 1, maxBytesEstimate: 100 }));
    const other = budget.lease();
    const inFlight = other.reserve();
    const waiter = budget.lease();
    const waiting = waiter.reserveWholeAllowance(60_000);
    let granted = false;
    void waiting.then(() => { granted = true; });
    await turn();
    expect(granted).toBe(false);

    // An empty answer frees a whole allowance. Room kept beside the
    // reservation of the pass in flight would keep the waiting lease out.
    inFlight.commitReplace(0, 0, true);
    await turn();
    expect(granted).toBe(true);
    (await waiting)!.release();
    nextPass.release();
    for (const lease of [continuing, other, waiter]) lease.release();
  });

  // Rows to spare and bytes for two allowances: here the bytes decide.
  const byteBound = () => createSelectedSwmMetaRetentionBudget({
    maxRows: 10,
    maxBytesEstimate: 400,
    maxPrefixRows: 2,
    maxPrefixBytesEstimate: 200,
  });

  it('grants a whole allowance only when its bytes are free as well as its rows', async () => {
    const budget = byteBound();
    const first = budget.lease();
    const other = budget.lease();
    const firstFetch = first.reserve();
    const otherFetch = other.reserve();
    const waiter = budget.lease();
    // Six rows are free, and no bytes.
    const refused = waiter.reserve();
    expect(refused).toEqual(expect.objectContaining({
      maxRows: 2,
      maxBytesEstimate: 0,
      exhaustion: 'shared',
    }));
    refused.release();
    const waiting = waiter.reserveWholeAllowance(60_000);
    let granted = false;
    void waiting.then(() => { granted = true; });

    // A whole manifest of one row and 150 bytes is kept. Seven rows are free
    // but only 50 bytes: a manifest that fits an allowance would not fit
    // them, so the waiting lease stays in line.
    firstFetch.commitReplace(1, 150, true);
    await turn();
    expect(granted).toBe(false);

    // The other fetch keeps nothing. Its 200 bytes make the allowance whole.
    otherFetch.commitReplace(0, 0, true);
    const reservation = await waiting;
    expect(reservation).toEqual(expect.objectContaining({
      maxRows: 2,
      maxBytesEstimate: 200,
      exhaustion: null,
    }));
    reservation!.release();
    for (const lease of [first, other, waiter]) lease.release();
  });

  it('leaves a transfer between two passes the bytes of its allowance', async () => {
    const budget = byteBound();
    const continuing = budget.lease();
    const other = budget.lease();
    const firstPass = continuing.reserve();
    const otherFetch = other.reserve();
    const waiter = budget.lease();
    const waiting = waiter.reserveWholeAllowance(60_000);

    // One row and 100 bytes of an unfinished manifest are kept: the next pass
    // comes back for the other 100 bytes. The second fetch keeps a whole
    // manifest of 50 bytes. 250 bytes are free, which is an allowance, but
    // not an allowance and the 100 bytes of the next pass. Rows were never
    // short: eight of ten are free.
    firstPass.commitReplace(1, 100);
    otherFetch.commitReplace(1, 50, true);
    await expect(waiting).resolves.toBeNull();

    // With the 50 bytes given back there is room for both.
    other.release();
    const reservation = await waiter.reserveWholeAllowance(60_000);
    expect(reservation).toEqual(expect.objectContaining({ maxRows: 2, maxBytesEstimate: 200 }));
    expect(continuing.reserve()).toEqual(expect.objectContaining({
      maxRows: 1,
      maxBytesEstimate: 100,
      exhaustion: null,
    }));
    reservation!.release();
    for (const lease of [continuing, waiter]) lease.release();
  });

  it('grants in the order the leases started to wait', async () => {
    const budget = pool(1);
    const holder = budget.lease();
    let inFlight = holder.reserve();
    const order: string[] = [];
    const leases = ['first', 'second', 'third'].map((name) => ({ name, lease: budget.lease() }));
    const waits = leases.map(({ name, lease }) => lease.reserveWholeAllowance(60_000)
      .then((reservation) => {
        order.push(name);
        return reservation;
      }));

    for (const wait of waits) {
      inFlight.commitReplace(0, 0);
      // One allowance, one grant: the others stay in line behind the fetch
      // that the grant starts.
      inFlight = (await wait)!;
      await turn();
    }
    expect(order).toEqual(['first', 'second', 'third']);
    inFlight.release();
    holder.release();
    for (const { lease } of leases) lease.release();
  });

  it('does not wait when nothing bounded would free the pool', async () => {
    const budget = pool(1);
    const holder = budget.lease();
    const waiter = budget.lease();

    // A pool held by a retained prefix: only its owner or the retention clock
    // gives it back, and neither is bounded by a fetch.
    holder.replace(2, 200);
    await expect(waiter.reserveWholeAllowance(60_000)).resolves.toBeNull();
    holder.replace(0, 0);

    // A whole allowance that is free is handed out at once.
    const free = await waiter.reserveWholeAllowance(60_000);
    expect(free).toEqual(expect.objectContaining({ maxRows: 2, maxBytesEstimate: 200 }));
    // The lease's own reservation is not a sibling's fetch.
    await expect(waiter.reserveWholeAllowance(60_000)).resolves.toBeNull();
    free!.release();

    // No time left, an aborted signal and a released lease never start a wait.
    const inFlight = holder.reserve();
    await expect(waiter.reserveWholeAllowance(0)).resolves.toBeNull();
    await expect(waiter.reserveWholeAllowance(Number.NaN)).resolves.toBeNull();
    await expect(waiter.reserveWholeAllowance(60_000, AbortSignal.abort())).resolves.toBeNull();
    waiter.release();
    await expect(waiter.reserveWholeAllowance(60_000)).resolves.toBeNull();
    inFlight.release();
    holder.release();
  });

  it('ends a wait at its timeout, when its signal aborts and when its lease is released', async () => {
    const budget = pool(1);
    const holder = budget.lease();
    const inFlight = holder.reserve();

    const timedOut = budget.lease();
    await expect(timedOut.reserveWholeAllowance(5)).resolves.toBeNull();

    const revoked = budget.lease();
    const recovery = new AbortController();
    const removeListener = vi.spyOn(recovery.signal, 'removeEventListener');
    const parked = revoked.reserveWholeAllowance(60_000, recovery.signal);
    recovery.abort();
    await expect(parked).resolves.toBeNull();
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));

    const dropped = budget.lease();
    const abandoned = dropped.reserveWholeAllowance(60_000);
    dropped.release();
    await expect(abandoned).resolves.toBeNull();

    // None of the three is still in line: the allowance that comes free goes
    // to a lease that asks now.
    inFlight.release();
    const next = budget.lease();
    await expect(next.reserveWholeAllowance(60_000))
      .resolves.toEqual(expect.objectContaining({ maxRows: 2, maxBytesEstimate: 200 }));
    for (const lease of [holder, timedOut, revoked, next]) lease.release();
  });

  it('decides again when a lease is dropped mid-fetch, a prefix is handed back or a probe at a ceiling settles', async () => {
    const budget = pool(1);
    const waiter = budget.lease();

    const dropped = budget.lease();
    dropped.reserve();
    const afterDrop = waiter.reserveWholeAllowance(60_000);
    dropped.release();
    (await afterDrop)!.release();

    // A lease at its own ceiling still sends a fetch, with a reservation that
    // admits nothing. It is a fetch in flight all the same: when the answer
    // restarts its prefix from nothing, the pool is free.
    const atCeiling = budget.lease();
    atCeiling.replace(2, 200);
    const probe = atCeiling.reserve();
    expect(probe).toEqual(expect.objectContaining({ maxRows: 0, exhaustion: 'prefix' }));
    const afterProbe = waiter.reserveWholeAllowance(60_000);
    let decided = false;
    void afterProbe.then(() => { decided = true; });
    await turn();
    expect(decided).toBe(false);
    probe.commitReplace(0, 0);
    (await afterProbe)!.release();

    // Handing a prefix back frees room too, while another fetch is still in
    // flight.
    const wide = pool(2);
    const retained = wide.lease();
    retained.replace(2, 200);
    const stillFetching = wide.lease().reserve();
    const queued = wide.lease();
    const afterHandBack = queued.reserveWholeAllowance(60_000);
    let handedOver = false;
    void afterHandBack.then(() => { handedOver = true; });
    await turn();
    expect(handedOver).toBe(false);
    retained.replace(0, 0);
    await turn();
    expect(handedOver).toBe(true);
    (await afterHandBack)!.release();
    stillFetching.release();
    for (const lease of [waiter, atCeiling, retained, queued]) lease.release();
  });

  it('holds nothing for a waiting lease, so waiting leases cannot keep each other waiting', async () => {
    // Rows and bytes are pooled separately: with the rows taken a plain
    // reservation would still be handed bytes. A lease that waits takes
    // neither, and ends its wait with the last fetch in flight.
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 400,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 200,
    });
    const holder = budget.lease();
    const inFlight = holder.reserve();
    const first = budget.lease();
    const second = budget.lease();
    const outcomes: unknown[] = [];
    const waits = [first, second].map((lease) => lease.reserveWholeAllowance(60_000)
      .then((reservation) => outcomes.push(reservation)));
    await turn();
    expect(outcomes).toEqual([]);
    // The bytes a third lease could still be handed are all there.
    const third = budget.lease().reserve();
    expect(third).toEqual(expect.objectContaining({ maxRows: 0, maxBytesEstimate: 200 }));
    third.release();
    await turn();
    expect(outcomes).toEqual([]);

    // The fetch keeps its two rows. No allowance is free and nothing is in
    // flight: both waits end, in one decision, without a grant.
    inFlight.commitReplace(2, 200);
    await Promise.all(waits);
    expect(outcomes).toEqual([null, null]);
    for (const lease of [holder, first, second]) lease.release();
  });
});
