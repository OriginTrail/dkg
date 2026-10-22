import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { createSelectedSwmMetaFetcher } from '../src/sync/selected-swm-meta-fetcher.js';
import { createSelectedSwmMetaRetentionBudget } from '../src/sync/selected-swm-meta-budget.js';
import { SelectedSwmMetaTransferCoordinator } from '../src/sync/selected-swm-meta-transfer-coordinator.js';
import { SyncPageAccumulationLimitError } from '../src/sync/requester/page-fetch.js';
import { composeSyncWorkAdmission, createSyncWorkAdmission } from '../src/sync/work-admission.js';

const testContext = {
  operationId: 'selected-meta-contention-test',
  operationName: 'sync',
} as OperationContext;

const request = (contextGraphId: string, remotePeerId: string) => {
  const deadline = Date.now() + 60_000;
  return {
    ctx: testContext,
    remotePeerId,
    contextGraphId,
    graphUri: 'urn:meta',
    deadline,
    // As the requester composes it: the round deadline is the work allowance.
    workAdmission: composeSyncWorkAdmission({ deadline }),
  };
};

const row = (contextGraphId: string) => ({
  subject: `urn:${contextGraphId}`,
  predicate: 'urn:p',
  object: '"o"',
  graph: 'urn:meta',
});

describe('selected SWM metadata retention contention', () => {
  it('yields the retained prefix instead of spending a zero-allowance fetch', async () => {
    // One row for the whole process: the holder takes it, so the waiter's
    // reservation admits nothing through no fault of its own prefix.
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 1,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 4,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const deleteCheckpoint = vi.fn();
    const holderFetch = vi.fn(async (req: { contextGraphId: string }) => ({
      quads: [row(req.contextGraphId)],
      bytesReceived: 1,
      resumedFromOffset: 0,
      nextOffset: 1,
      checkpointKey: `${req.contextGraphId}:checkpoint`,
      completed: false,
      timedOut: true,
    }));
    const holder = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-holder',
      requesterScope: 'selected-swm-meta:retained:holder',
      retentionBudget: budget,
      deleteCheckpoint,
      fetchPage: holderFetch,
    });
    await holder.strategy.fetch(request('cg-holder', 'peer-holder'));
    expect(holder.continuation('cg-holder').progress).toBe(1);

    const waiterFetch = vi.fn(async (req: { contextGraphId: string }) => ({
      quads: [row(req.contextGraphId)],
      bytesReceived: 1,
      resumedFromOffset: 0,
      nextOffset: 1,
      checkpointKey: `${req.contextGraphId}:checkpoint`,
      completed: false,
      timedOut: true,
    }));
    const waiter = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-waiter',
      requesterScope: 'selected-swm-meta:retained:waiter',
      retentionBudget: budget,
      deleteCheckpoint,
      fetchPage: waiterFetch,
    });

    const outcome = await waiter.strategy.fetch(request('cg-waiter', 'peer-waiter'));

    // No request may cross the wire: a zero allowance rejects the first row the
    // responder returns, and that fail-closed throw would also drop the prefix.
    expect(waiterFetch).not.toHaveBeenCalled();
    expect(outcome.continuationYielded).toBe(true);
    expect(outcome.result.quads).toEqual([]);
    expect(outcome.result.bytesReceived).toBe(0);
    expect(outcome.result.completed).toBe(false);
    // A voluntary yield is accounted like the timed-out page it stands in for,
    // which is the shape `classifySelectedSwmRoundFreshness` treats as
    // recoverable rather than as a peer failure.
    expect(outcome.result.timedOut).toBe(true);
    expect(deleteCheckpoint).not.toHaveBeenCalledWith('cg-waiter:checkpoint');
  });

  it('preserves an already retained prefix when the shared pool is exhausted', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 4,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const deleteCheckpoint = vi.fn();
    const page = async (req: { contextGraphId: string }) => ({
      quads: [row(req.contextGraphId)],
      bytesReceived: 1,
      resumedFromOffset: 0,
      nextOffset: 1,
      checkpointKey: `${req.contextGraphId}:checkpoint`,
      completed: false,
      timedOut: true,
    });
    const waiterFetch = vi.fn(page);
    const waiter = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-waiter',
      requesterScope: 'selected-swm-meta:retained:waiter',
      retentionBudget: budget,
      deleteCheckpoint,
      fetchPage: waiterFetch,
    });
    // The waiter earns one retained row first, then a sibling takes the rest.
    await waiter.strategy.fetch(request('cg-waiter', 'peer-waiter'));
    expect(waiter.continuation('cg-waiter').progress).toBe(1);

    const holder = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-holder',
      requesterScope: 'selected-swm-meta:retained:holder',
      retentionBudget: budget,
      deleteCheckpoint,
      fetchPage: vi.fn(page),
    });
    await holder.strategy.fetch(request('cg-holder', 'peer-holder'));

    waiterFetch.mockClear();
    const outcome = await waiter.strategy.fetch(request('cg-waiter', 'peer-waiter'));

    expect(waiterFetch).not.toHaveBeenCalled();
    expect(outcome.result.resumedFromOffset).toBe(1);
    expect(outcome.result.nextOffset).toBe(1);
    // The exact prefix and its responder cursor survive the yield, so the next
    // pass resumes instead of refetching from offset zero.
    expect(waiter.continuation('cg-waiter').progress).toBe(1);
    expect(deleteCheckpoint).not.toHaveBeenCalledWith('cg-waiter:checkpoint');
  });

  it('returns a stalled prefix to the pool so a saturated sibling can advance', async () => {
    // Yielding frees the reservation, never the committed prefix — and the
    // prefix is what occupies the pool. With every lease below its own ceiling
    // and the pool full of retained prefixes, waiting is a mutual stall that
    // only the retention TTL would break. A bounded number of yields is
    // absorbed; after that this lease hands its rows back.
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 4,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const deleteCheckpoint = vi.fn();
    const page = async (req: { contextGraphId: string }) => ({
      quads: [row(req.contextGraphId)],
      bytesReceived: 1,
      resumedFromOffset: 0,
      nextOffset: 1,
      checkpointKey: `${req.contextGraphId}:checkpoint`,
      completed: false,
      timedOut: true,
    });
    const stalledFetch = vi.fn(page);
    const stalled = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-stalled',
      requesterScope: 'selected-swm-meta:retained:stalled',
      retentionBudget: budget,
      deleteCheckpoint,
      fetchPage: stalledFetch,
    });
    const holderFetch = vi.fn(page);
    const holder = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-holder',
      requesterScope: 'selected-swm-meta:retained:holder',
      retentionBudget: budget,
      deleteCheckpoint,
      fetchPage: holderFetch,
    });

    // Both leases earn one row: the pool is now saturated by retained prefixes
    // while each lease still has three rows of its own headroom left.
    await stalled.strategy.fetch(request('cg-stalled', 'peer-stalled'));
    await holder.strategy.fetch(request('cg-holder', 'peer-holder'));
    expect(stalled.continuation('cg-stalled').progress).toBe(1);
    expect(holder.continuation('cg-holder').progress).toBe(1);
    stalledFetch.mockClear();
    holderFetch.mockClear();
    deleteCheckpoint.mockClear();

    // Transient contention is absorbed first: the prefix survives, exactly as
    // it must when a sibling is mid-transfer and about to commit.
    for (let pass = 0; pass < 2; pass += 1) {
      await stalled.strategy.fetch(request('cg-stalled', 'peer-stalled'));
      expect(stalled.continuation('cg-stalled').progress).toBe(1);
    }
    expect(stalledFetch).not.toHaveBeenCalled();
    expect(deleteCheckpoint).not.toHaveBeenCalledWith('cg-stalled:checkpoint');

    // The next yield gives the rows back instead of freezing both leases.
    const outcome = await stalled.strategy.fetch(request('cg-stalled', 'peer-stalled'));
    expect(stalledFetch).not.toHaveBeenCalled();
    expect(outcome.result.quads).toEqual([]);
    expect(outcome.result.nextOffset).toBe(0);
    expect(outcome.result.timedOut).toBe(true);
    expect(stalled.continuation('cg-stalled').progress).toBe(0);
    expect(deleteCheckpoint).toHaveBeenCalledWith('cg-stalled:checkpoint');

    // The freed row admits the sibling on its very next pass.
    await holder.strategy.fetch(request('cg-holder', 'peer-holder'));
    expect(holderFetch).toHaveBeenCalledTimes(1);
  });

  it('names the retained-prefix ceiling when the lease is at its own limit', async () => {
    // The responder rejecting a zero allowance is the symptom; the operator
    // needs the local limit that caused it.
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 8,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 1,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const fetchPage = vi.fn(async (req: { contextGraphId: string; maxAcceptedQuads: number }) => {
      if (req.maxAcceptedQuads === 0) {
        throw new SyncPageAccumulationLimitError('quads', 1, 0);
      }
      return {
        quads: [row(req.contextGraphId)],
        bytesReceived: 1,
        resumedFromOffset: 0,
        nextOffset: 1,
        checkpointKey: `${req.contextGraphId}:checkpoint`,
        completed: false,
        timedOut: true,
      };
    });
    const fetcher = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-ceiling-message',
      requesterScope: 'selected-swm-meta:retained:ceiling-message',
      retentionBudget: budget,
      deleteCheckpoint: vi.fn(),
      fetchPage,
    });

    await fetcher.strategy.fetch(request('cg-ceiling-message', 'peer-ceiling-message'));
    await expect(fetcher.strategy.fetch(request('cg-ceiling-message', 'peer-ceiling-message')))
      .rejects.toThrowError(expect.objectContaining({
        code: 'SYNC_PAGE_ACCUMULATION_LIMIT',
        message: expect.stringContaining('per-Context-Graph ceiling (1 rows'),
      }));
    await expect(fetcher.strategy.fetch(request('cg-ceiling-message', 'peer-ceiling-message')))
      .resolves.toBeDefined();
  });

  it('keeps failing closed when the lease is at its own prefix ceiling', async () => {
    // Own-ceiling exhaustion is not transient: yielding would loop forever, so
    // the fetch still goes out and the accumulation limit stays authoritative.
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 8,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 1,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const deleteCheckpoint = vi.fn();
    const fetchPage = vi.fn(async (req: { contextGraphId: string; maxAcceptedQuads: number }) => {
      if (req.maxAcceptedQuads === 0) {
        throw new SyncPageAccumulationLimitError('quads', 1, 0);
      }
      return {
        quads: [row(req.contextGraphId)],
        bytesReceived: 1,
        resumedFromOffset: 0,
        nextOffset: 1,
        checkpointKey: `${req.contextGraphId}:checkpoint`,
        completed: false,
        timedOut: true,
      };
    });
    const fetcher = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-ceiling',
      requesterScope: 'selected-swm-meta:retained:ceiling',
      retentionBudget: budget,
      deleteCheckpoint,
      fetchPage,
    });

    await fetcher.strategy.fetch(request('cg-ceiling', 'peer-ceiling'));
    expect(fetcher.continuation('cg-ceiling').progress).toBe(1);

    fetchPage.mockClear();
    await expect(fetcher.strategy.fetch(request('cg-ceiling', 'peer-ceiling')))
      .rejects.toThrowError(expect.objectContaining({ code: 'SYNC_PAGE_ACCUMULATION_LIMIT' }));
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage.mock.calls[0]![0]!.maxAcceptedQuads).toBe(0);
  });

  // The cases below are about a pool that is reserved by fetches still in
  // flight, not held by retained prefixes. Every fetch reserves a whole prefix
  // allowance before it starts, so with the default limits the pool admits
  // three transfers at once however little they go on to retain.
  const ALLOWANCE = 2;
  const pool = (allowances: number) => createSelectedSwmMetaRetentionBudget({
    maxRows: ALLOWANCE * allowances,
    maxBytesEstimate: 1024 * 1024 * allowances,
    maxPrefixRows: ALLOWANCE,
    maxPrefixBytesEstimate: 1024 * 1024,
  });
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  interface Page {
    readonly rows: number;
    readonly completed: boolean;
  }
  const EMPTY: Page = { rows: 0, completed: true };

  /**
   * One peer's transfer. Each call of `pass()` is one metadata fetch of the
   * transfer; it stays in flight until `answer()` is called and then serves
   * the next of `pages`, resuming after the rows the transfer already holds.
   */
  const transfer = (
    budget: ReturnType<typeof createSelectedSwmMetaRetentionBudget>,
    name: string,
    pages: readonly Page[] = [EMPTY],
  ) => {
    const asked: number[] = [];
    const answers: Array<() => void> = [];
    let held = 0;
    const fetcher = createSelectedSwmMetaFetcher({
      remotePeerId: `peer-${name}`,
      requesterScope: `selected-swm-meta:retained:${name}`,
      retentionBudget: budget,
      deleteCheckpoint: vi.fn(),
      fetchPage: async (req: { contextGraphId: string; maxAcceptedQuads: number }) => {
        const page = pages[asked.length]!;
        asked.push(req.maxAcceptedQuads);
        await new Promise<void>((resolve) => { answers.push(resolve); });
        // The page fetcher refuses rows beyond what the reservation admits.
        if (page.rows > req.maxAcceptedQuads) {
          throw new SyncPageAccumulationLimitError('quads', page.rows, req.maxAcceptedQuads);
        }
        const resumedFromOffset = held;
        held += page.rows;
        return {
          quads: Array.from({ length: page.rows }, () => row(req.contextGraphId)),
          bytesReceived: page.rows,
          resumedFromOffset,
          nextOffset: held,
          checkpointKey: `${req.contextGraphId}:checkpoint`,
          completed: page.completed,
          timedOut: !page.completed,
        };
      },
    });
    return {
      fetcher,
      /** What each fetch of this transfer was allowed to accept. */
      asked,
      pass: (overrides: Record<string, unknown> = {}) => fetcher.strategy.fetch({
        ...request(`cg-${name}`, `peer-${name}`),
        ...overrides,
      }),
      answer: () => answers.shift()!(),
    };
  };

  it('asks its peer once the fetch in flight has settled instead of reporting a timed-out page', async () => {
    const budget = pool(1);
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();
    const waiter = transfer(budget, 'waiter');
    let settled = false;
    const waiting = waiter.pass().finally(() => { settled = true; });
    // The pool is reserved, not full: the waiter neither spends a fetch that
    // could accept nothing nor gives up on a peer it has not asked.
    await turn();
    expect(waiter.asked).toEqual([]);
    expect(settled).toBe(false);

    holder.answer();
    await turn();
    expect(waiter.asked).toEqual([ALLOWANCE]);
    waiter.answer();
    const outcome = await waiting;

    expect(outcome.continuationYielded).toBe(false);
    expect(outcome.result.completed).toBe(true);
    expect(outcome.result.timedOut).toBe(false);
    await holding;
  });

  it('lets waiting transfers through in turn, each with a whole allowance', async () => {
    const budget = pool(1);
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();
    const waiters = ['a', 'b', 'c'].map((name) => transfer(budget, `waiter-${name}`));
    const waiting = waiters.map((waiter) => waiter.pass());
    await turn();
    expect(waiters.map((waiter) => waiter.asked)).toEqual([[], [], []]);

    let previous = holder;
    for (const [index, waiter] of waiters.entries()) {
      previous.answer();
      await turn();
      // The pool admits one allowance: the next in line has it, the rest wait.
      expect(waiters.map((each) => each.asked.length))
        .toEqual(waiters.map((_, position) => (position <= index ? 1 : 0)));
      expect(waiter.asked).toEqual([ALLOWANCE]);
      previous = waiter;
    }
    previous.answer();
    for (const outcome of await Promise.all(waiting)) {
      expect(outcome.continuationYielded).toBe(false);
      expect(outcome.result.completed).toBe(true);
    }
    await holding;
  });

  it('still yields when the fetch in flight leaves the pool full of its prefix', async () => {
    const budget = pool(1);
    const holder = transfer(budget, 'holder', [{ rows: ALLOWANCE, completed: false }]);
    const holding = holder.pass();
    const waiter = transfer(budget, 'waiter');
    const waiting = waiter.pass();
    holder.answer();
    const outcome = await waiting;

    // Nothing is in flight any more and the sibling kept everything it had
    // reserved: that is the retained-prefix contention the yield exists for.
    expect(waiter.asked).toEqual([]);
    expect(outcome.continuationYielded).toBe(true);
    expect(outcome.result.completed).toBe(false);
    expect(outcome.result.timedOut).toBe(true);
    await holding;
  });

  it('leaves a transfer that is still fetching its manifest the room for its next pass', async () => {
    // Three fetches hold the pool and a fourth transfer waits. The first
    // fetch returns one row of a longer manifest. The row of its allowance
    // that it did not use is free again, and its next pass needs it: a
    // waiting transfer that took it would leave that pass with nothing, and
    // the continuation loop would then stop on a pass without progress.
    const budget = pool(3);
    const continuing = transfer(budget, 'continuing', [
      { rows: 1, completed: false },
      { rows: 1, completed: true },
    ]);
    const firstPass = continuing.pass();
    const others = [transfer(budget, 'other-a'), transfer(budget, 'other-b')];
    const otherPasses = others.map((other) => other.pass());
    const waiter = transfer(budget, 'waiter');
    const waiting = waiter.pass();

    continuing.answer();
    expect((await firstPass).continuationYielded).toBe(true);
    await turn();
    expect(waiter.asked).toEqual([]);

    const nextPass = continuing.pass();
    await turn();
    expect(continuing.asked).toEqual([ALLOWANCE, ALLOWANCE - 1]);
    continuing.answer();
    expect((await nextPass).result.completed).toBe(true);
    // The manifest is complete and the waiter is still in line: two rows are
    // retained, two fetches are in flight, and no whole allowance is free.
    expect(waiter.asked).toEqual([]);

    others[0]!.answer();
    await turn();
    expect(waiter.asked).toEqual([ALLOWANCE]);
    waiter.answer();
    others[1]!.answer();
    expect((await waiting).result.completed).toBe(true);
    await Promise.all(otherPasses);
  });

  it('keeps a waiting transfer in line for a whole allowance instead of starting it on a share', async () => {
    // Two fetches hold the pool and a third transfer waits. The first fetch
    // keeps one row, so one row is free while the other is still in flight.
    // A waiting transfer that was let through on that row would fail closed
    // on any longer manifest, after a real download, and so would the next
    // one in line.
    const budget = pool(2);
    const first = transfer(budget, 'first', [{ rows: 1, completed: true }]);
    const firstPass = first.pass();
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();
    const waiter = transfer(budget, 'waiter', [{ rows: ALLOWANCE, completed: true }]);
    const waiting = waiter.pass();

    first.answer();
    await firstPass;
    await turn();
    expect(waiter.asked).toEqual([]);

    holder.answer();
    await turn();
    expect(waiter.asked).toEqual([ALLOWANCE]);
    waiter.answer();
    expect((await waiting).result.completed).toBe(true);
    await holding;
  });

  it('ends a wait without a grant as it ended before, and leaves what is free to the transfer between two passes', async () => {
    // One allowance. The holder returns one row of a longer manifest: the
    // other row is free, nothing is in flight, and the row is what the
    // holder's next pass comes back for. The transfer that waited is not
    // granted it, and must not reserve it for itself either.
    const budget = pool(1);
    const holder = transfer(budget, 'holder', [
      { rows: 1, completed: false },
      { rows: 1, completed: true },
    ]);
    const firstPass = holder.pass();
    const waiter = transfer(budget, 'waiter', [{ rows: 1, completed: true }]);
    const waiting = waiter.pass();

    holder.answer();
    await firstPass;
    const outcome = await waiting;
    expect(waiter.asked).toEqual([]);
    expect(outcome.continuationYielded).toBe(true);
    expect(outcome.result.timedOut).toBe(true);

    const nextPass = holder.pass();
    expect(holder.asked).toEqual([ALLOWANCE, ALLOWANCE - 1]);
    holder.answer();
    expect((await nextPass).result.completed).toBe(true);
  });

  it('keeps no room for a prefix whose invocation has ended', async () => {
    // A transfer ends its invocation with one row of an unfinished manifest.
    // The prefix is kept for a later invocation, for minutes, and that one
    // may never come. Room kept for it meanwhile would keep every waiting
    // transfer out, on graphs that have nothing to do with it.
    const budget = pool(2);
    const coordinator = new SelectedSwmMetaTransferCoordinator();
    const stale = transfer(budget, 'stale', [{ rows: 1, completed: false }]);
    try {
      const invocation = coordinator.run('peer-stale', () => stale.fetcher, () => stale.pass());
      await turn();
      stale.answer();
      expect((await invocation).continuationYielded).toBe(true);
      expect(stale.fetcher.continuation('cg-stale').progress).toBe(1);

      // Three rows are free. A whole allowance and the one row that is left
      // are in flight, and a third transfer waits.
      const first = transfer(budget, 'first');
      const firstPass = first.pass();
      const second = transfer(budget, 'second');
      const secondPass = second.pass();
      expect([first.asked, second.asked]).toEqual([[ALLOWANCE], [1]]);
      const waiter = transfer(budget, 'waiter');
      const waiting = waiter.pass();
      await turn();
      expect(waiter.asked).toEqual([]);

      // The first answer frees a whole allowance while the second fetch is
      // still in flight.
      first.answer();
      await turn();
      expect(waiter.asked).toEqual([ALLOWANCE]);
      waiter.answer();
      second.answer();
      expect((await waiting).result.completed).toBe(true);
      await Promise.all([firstPass, secondPass]);
    } finally {
      await coordinator.close();
    }
  });

  it('lets a transfer whose responder started over keep its allowance while another one waits', async () => {
    const budget = pool(2);
    const asked: number[] = [];
    const gates: Array<() => void> = [];
    const gate = () => new Promise<void>((resolve) => { gates.push(resolve); });
    const page = (rows: number, resumedFromOffset: number, completed: boolean) => ({
      quads: Array.from({ length: rows }, () => row('cg-restarting')),
      bytesReceived: rows,
      resumedFromOffset,
      nextOffset: resumedFromOffset + rows,
      checkpointKey: 'cg-restarting:checkpoint',
      completed,
      timedOut: !completed,
    });
    const restarting = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-restarting',
      requesterScope: 'selected-swm-meta:retained:restarting',
      retentionBudget: budget,
      deleteCheckpoint: vi.fn(),
      fetchPage: async (req: { maxAcceptedQuads: number }) => {
        asked.push(req.maxAcceptedQuads);
        if (asked.length === 1) return page(1, 0, false);
        await gate();
        if (asked.length === 2) {
          // The responder replaced its row list: the whole manifest again,
          // which the rest of the allowance cannot take.
          const error = new SyncPageAccumulationLimitError('quads', 2, req.maxAcceptedQuads);
          error.responderSessionStartedFresh = true;
          throw error;
        }
        return page(2, 0, true);
      },
    });
    const pass = () => restarting.strategy.fetch(request('cg-restarting', 'peer-restarting'));

    await pass();
    const secondPass = pass();
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();
    const waiter = transfer(budget, 'waiter');
    const waiting = waiter.pass();
    await turn();
    expect(asked).toEqual([ALLOWANCE, 1]);
    expect(waiter.asked).toEqual([]);

    // Starting over frees the prefix and the failed reservation, a whole
    // allowance together, and takes it again at once. The waiting transfer
    // is not handed it in between.
    gates.shift()!();
    await turn();
    expect(asked).toEqual([ALLOWANCE, 1, ALLOWANCE]);
    expect(waiter.asked).toEqual([]);

    gates.shift()!();
    expect((await secondPass).result.completed).toBe(true);
    holder.answer();
    await turn();
    expect(waiter.asked).toEqual([ALLOWANCE]);
    waiter.answer();
    expect((await waiting).result.completed).toBe(true);
    await holding;
  });

  it('waits no longer than ten seconds, however much of its work allowance is left', async () => {
    const waits: number[] = [];
    const inner = pool(1);
    const budget = {
      lease: () => {
        const lease = inner.lease();
        const { reserveWholeAllowance } = lease;
        lease.reserveWholeAllowance = (timeoutMs, signal) => {
          waits.push(timeoutMs);
          return reserveWholeAllowance(timeoutMs, signal);
        };
        return lease;
      },
    };
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();

    // A minute of work allowance: half of it would keep the transfer in the
    // sync queues for thirty seconds behind a slow fetch.
    const recovery = new AbortController();
    const parked = transfer(budget, 'parked').pass({ signal: recovery.signal });
    await turn();
    expect(waits).toEqual([10_000]);
    recovery.abort(new Error('recovery authority was revoked'));
    await expect(parked).rejects.toThrow('revoked');

    // A short allowance still bounds the wait by its half.
    const deadline = Date.now() + 5_000;
    const brief = new AbortController();
    const short = transfer(budget, 'short').pass({
      deadline,
      workAdmission: composeSyncWorkAdmission({ deadline }),
      signal: brief.signal,
    });
    await turn();
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(2_000);
    expect(waits[1]).toBeLessThanOrEqual(2_500);
    brief.abort(new Error('recovery authority was revoked'));
    await expect(short).rejects.toThrow('revoked');
    holder.answer();
    await holding;
  });

  it('does not make a transfer wait that is handed a share of the pool at its start', async () => {
    // One row of the pool is retained and one fetch is in flight, so one row
    // is free. Only a pool that admits nothing made a transfer give up
    // without asking: this one starts on the row at once, as it always did.
    const budget = pool(2);
    const retained = transfer(budget, 'retained', [{ rows: 1, completed: true }]);
    const retaining = retained.pass();
    retained.answer();
    await retaining;
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();

    const arriving = transfer(budget, 'arriving', [{ rows: 1, completed: true }]);
    const arrival = arriving.pass();
    expect(arriving.asked).toEqual([1]);
    arriving.answer();
    expect((await arrival).result.completed).toBe(true);
    holder.answer();
    await holding;
  });

  it('starts on what the pool has when nothing is in flight, as before', async () => {
    const budget = pool(2);
    const retained = transfer(budget, 'retained', [{ rows: ALLOWANCE, completed: true }]);
    const retaining = retained.pass();
    retained.answer();
    await retaining;
    const partial = transfer(budget, 'partial', [{ rows: 1, completed: true }]);
    const first = partial.pass();
    partial.answer();
    await first;

    // One row is free and no fetch will free more. Waiting has no end that a
    // fetch bounds, so the transfer starts on the row, as it always did.
    const arriving = transfer(budget, 'arriving', [{ rows: 1, completed: true }]);
    const arrival = arriving.pass();
    await turn();
    expect(arriving.asked).toEqual([1]);
    arriving.answer();
    expect((await arrival).result.completed).toBe(true);
  });

  it('gives up waiting halfway through the work allowance of its own round', async () => {
    const budget = pool(1);
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();

    const farDeadline = Date.now() + 60_000;
    const allowances = [
      // The round deadline itself is near.
      composeSyncWorkAdmission({ deadline: Date.now() + 40 }),
      // The deadline is far, but the job window around the round is not.
      composeSyncWorkAdmission({
        deadline: farDeadline,
        window: createSyncWorkAdmission(() => 40),
      }),
    ];
    for (const [index, workAdmission] of allowances.entries()) {
      const waiter = transfer(budget, `waiter-${index}`);
      const startedAt = Date.now();
      const outcome = await waiter.pass({ deadline: farDeadline, workAdmission });

      // Half of it is kept for the fetch that a grant would start.
      expect(Date.now() - startedAt).toBeLessThan(35);
      expect(waiter.asked).toEqual([]);
      expect(outcome.continuationYielded).toBe(true);
      expect(outcome.result.timedOut).toBe(true);
    }
    holder.answer();
    await holding;
  });

  it('ends a parked transfer at once when its recovery is revoked, without asking its peer', async () => {
    const budget = pool(1);
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();

    const revoked = transfer(budget, 'revoked');
    const recovery = new AbortController();
    let ended = false;
    const parked = revoked.pass({ signal: recovery.signal });
    void parked.then(() => { ended = true; }, () => { ended = true; });
    await turn();
    expect(ended).toBe(false);

    // The sibling is still fetching. The revoked transfer must not stay in
    // its peer's queue until that fetch, or its own wait, ends.
    const revocation = new Error('recovery authority was revoked');
    recovery.abort(revocation);
    await turn();
    expect(ended).toBe(true);
    await expect(parked).rejects.toBe(revocation);
    expect(revoked.asked).toEqual([]);

    // It left nothing behind in the pool: the next transfer takes the whole
    // allowance once the fetch in flight has settled.
    const next = transfer(budget, 'next');
    const waiting = next.pass();
    holder.answer();
    await turn();
    expect(next.asked).toEqual([ALLOWANCE]);
    next.answer();
    await expect(waiting).resolves.toMatchObject({ continuationYielded: false });
    await holding;
  });

  it('releases an allowance that is granted in the same turn as the revocation', async () => {
    const budget = pool(1);
    // A fetch of another lease holds the pool. Its reservation is settled by
    // hand, so that the grant and the revocation fall into one turn.
    const inFlight = budget.lease().reserve();
    const revoked = transfer(budget, 'revoked');
    const recovery = new AbortController();
    const parked = revoked.pass({ signal: recovery.signal });
    await turn();

    // The budget grants the allowance when the reservation settles. The
    // transfer resumes on a later turn and finds its recovery gone.
    inFlight.release();
    const revocation = new Error('recovery authority was revoked');
    recovery.abort(revocation);
    await expect(parked).rejects.toBe(revocation);
    expect(revoked.asked).toEqual([]);

    // The grant did not stay behind: the next transfer starts at once.
    const next = transfer(budget, 'next');
    const following = next.pass();
    await turn();
    expect(next.asked).toEqual([ALLOWANCE]);
    next.answer();
    await following;
  });

  it('does not make a transfer that already holds a prefix wait for the fetch in flight', async () => {
    const budget = pool(1);
    const waiter = transfer(budget, 'waiter', [
      { rows: 1, completed: false },
      { rows: 1, completed: true },
    ]);
    const firstPass = waiter.pass();
    waiter.answer();
    await firstPass;

    // A second transfer starts on the row that is left, with nothing in
    // flight, and so takes the room of the first one's next pass.
    const holder = transfer(budget, 'holder');
    const holding = holder.pass();
    await turn();
    expect(holder.asked).toEqual([1]);

    // Resolves at once, while the sibling is still fetching: the prefix and
    // its cursor are what the yield protects, and the ledger grants this
    // round a retry.
    let ended = false;
    const yielding = waiter.pass();
    void yielding.then(() => { ended = true; }, () => { ended = true; });
    await turn();
    expect(ended).toBe(true);
    const outcome = await yielding;

    expect(waiter.asked).toEqual([ALLOWANCE]);
    expect(outcome.continuationYielded).toBe(true);
    expect(outcome.result.resumedFromOffset).toBe(1);
    expect(outcome.result.timedOut).toBe(true);
    holder.answer();
    await holding;
  });

  it('keeps the pool rules over seeded schedules of starts, answers and further passes', async () => {
    // Transfers start, their fetches are answered and unfinished manifests
    // are continued in a drawn order, against pools of one to three
    // allowances. Peers serve nothing, a whole manifest, or a first part and
    // then the rest. The test keeps its own count of the pool and checks, in
    // every schedule:
    //  1. Nothing stays parked: once no fetch is in flight, every pass ended.
    //  2. A transfer that holds nothing ends without having asked its peer
    //     only when no fetch was in flight for it to wait for.
    //  3. A transfer that waited asks its peer only with a whole allowance,
    //     and the pool then still holds the rest of the allowance of every
    //     transfer with an unfinished manifest.
    //  4. So the next pass of an unfinished manifest is handed the whole rest
    //     of its allowance. This holds until a transfer is handed a share of
    //     the pool at its start: that one takes what there is, as it always
    //     did.
    const seeded = (seed: number) => {
      let state = seed;
      return () => {
        state += 0x6D2B79F5;
        let mixed = Math.imul(state ^ (state >>> 15), state | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
      };
    };
    const allowanceRows = 4;
    const exercised = { waitedThenAsked: 0, nextPassesChecked: 0, endedUnasked: 0 };
    // A rule is checked while a fetch or a pass of the fetcher is under way,
    // where a thrown assertion would be taken for a failed fetch. So broken
    // rules are collected and reported at the end of their schedule.
    const broken: string[] = [];
    const hold = (rule: boolean, what: string) => {
      if (!rule) broken.push(what);
    };

    for (let seed = 1; seed <= 400; seed += 1) {
      const next = seeded(seed);
      const pick = (count: number) => Math.floor(next() * count);
      const allowances = 1 + pick(3);
      const budget = createSelectedSwmMetaRetentionBudget({
        maxRows: allowanceRows * allowances,
        maxBytesEstimate: 1024 * 1024 * allowances,
        maxPrefixRows: allowanceRows,
        maxPrefixBytesEstimate: 1024 * 1024,
      });
      const at = (what: string) => `seed ${seed}: ${what}`;

      // The test's own count of the pool.
      interface Counted {
        held: number;
        complete: boolean;
        fetching: number | null;
        passing: boolean;
        resumes: number;
        gone: boolean;
        pass(): void;
      }
      const counted: Counted[] = [];
      const answers = new Map<number, { answer(): void; startedInStep: number }>();
      let step = 0;
      let passesUnderWay = 0;
      let tookWhatThereWas = false;
      const free = () => allowanceRows * allowances - counted.reduce(
        (sum, each) => sum + each.held + (each.fetching ?? 0),
        0,
      );
      const unfinishedRooms = (except: Counted) => counted.reduce(
        (sum, each) => (
          each === except || each.gone || each.complete || each.held === 0 || each.fetching !== null
            ? sum
            : sum + allowanceRows - each.held
        ),
        0,
      );

      const start = (index: number) => {
        const firstRows = [0, 0, 0, 1, 2, allowanceRows][pick(6)]!;
        const firstIsAll = firstRows === 0 || pick(2) === 0;
        const pages: Page[] = firstIsAll
          ? [{ rows: firstRows, completed: true }]
          : [
            { rows: firstRows, completed: false },
            { rows: pick(allowanceRows - firstRows + 1), completed: true },
          ];
        let served = 0;
        let calledAtOnce = false;
        const fetcher = createSelectedSwmMetaFetcher({
          remotePeerId: `peer-${index}`,
          requesterScope: `selected-swm-meta:retained:${index}`,
          retentionBudget: budget,
          deleteCheckpoint: vi.fn(),
          fetchPage: async (req: { contextGraphId: string; maxAcceptedQuads: number }) => {
            const page = pages[served]!;
            served += 1;
            const freeBefore = free();
            if (self.held === 0) {
              if (!calledAtOnce) {
                hold(
                  req.maxAcceptedQuads === allowanceRows,
                  at(`transfer ${index} waited and started on ${req.maxAcceptedQuads} row(s)`),
                );
                hold(
                  freeBefore - allowanceRows >= unfinishedRooms(self),
                  at(`transfer ${index} waited and took the room of an unfinished manifest`),
                );
                exercised.waitedThenAsked += 1;
              } else if (
                req.maxAcceptedQuads < allowanceRows
                || freeBefore - req.maxAcceptedQuads < unfinishedRooms(self)
              ) {
                tookWhatThereWas = true;
              }
            } else if (!tookWhatThereWas) {
              hold(
                req.maxAcceptedQuads === allowanceRows - self.held,
                at(`the next pass of transfer ${index} was handed ${req.maxAcceptedQuads} row(s)`),
              );
              exercised.nextPassesChecked += 1;
            }
            self.fetching = req.maxAcceptedQuads;
            await new Promise<void>((resolve) => {
              answers.set(index, { answer: resolve, startedInStep: step });
            });
            self.fetching = null;
            // The page fetcher refuses rows beyond what the reservation admits,
            // and the transfer then fails closed and gives its rows back.
            if (page.rows > req.maxAcceptedQuads) {
              self.held = 0;
              self.gone = true;
              throw new SyncPageAccumulationLimitError('quads', page.rows, req.maxAcceptedQuads);
            }
            const resumedFromOffset = self.held;
            self.held += page.rows;
            self.complete = page.completed;
            return {
              quads: Array.from({ length: page.rows }, () => row(req.contextGraphId)),
              bytesReceived: page.rows,
              resumedFromOffset,
              nextOffset: self.held,
              checkpointKey: `${req.contextGraphId}:checkpoint`,
              completed: page.completed,
              timedOut: !page.completed,
            };
          },
        });
        const self: Counted = {
          held: 0,
          complete: false,
          fetching: null,
          passing: false,
          resumes: 0,
          gone: false,
          pass: () => {
            const servedBefore = served;
            const heldBefore = self.held;
            self.passing = true;
            passesUnderWay += 1;
            calledAtOnce = true;
            const ended = () => {
              self.passing = false;
              passesUnderWay -= 1;
              if (served !== servedBefore) return;
              if (heldBefore === 0) {
                // It never asked. Whatever is in flight now started in this
                // very step, after the wait had ended for want of a fetch.
                exercised.endedUnasked += 1;
                for (const other of answers.values()) {
                  hold(
                    other.startedInStep === step,
                    at(`transfer ${index} gave up beside a fetch in flight`),
                  );
                }
              } else {
                hold(tookWhatThereWas, at(`the next pass of transfer ${index} found no room`));
              }
            };
            const passing = fetcher.strategy.fetch(request(`cg-${index}`, `peer-${index}`));
            calledAtOnce = false;
            void passing.then(ended, ended);
          },
        };
        counted.push(self);
        self.pass();
      };

      const transfers = 3 + pick(8);
      // A transfer takes at most one start, two answers and two further
      // passes, so the loop is bounded by six steps a transfer.
      for (step = 1; step <= 6 * transfers; step += 1) {
        const fetching = [...answers.keys()];
        const unfinished = counted.filter((each) => (
          !each.gone && !each.complete && each.held > 0 && !each.passing && each.resumes < 2
        ));
        const choices = [
          ...(counted.length < transfers ? ['start'] : []),
          ...(fetching.length > 0 ? ['answer'] : []),
          ...(unfinished.length > 0 ? ['continue'] : []),
        ];
        if (choices.length === 0) break;
        const choice = choices[pick(choices.length)]!;
        if (choice === 'start') {
          start(counted.length);
        } else if (choice === 'answer') {
          const answered = fetching[pick(fetching.length)]!;
          const { answer } = answers.get(answered)!;
          answers.delete(answered);
          answer();
        } else {
          const continued = unfinished[pick(unfinished.length)]!;
          continued.resumes += 1;
          continued.pass();
        }
        await turn();
      }

      expect(broken).toEqual([]);
      expect(answers.size, at('fetches left in flight')).toBe(0);
      expect(passesUnderWay, at('passes left parked')).toBe(0);
      expect(counted, at('transfers started')).toHaveLength(transfers);
    }
    // The schedules reach the cases the rules are about.
    expect(exercised.waitedThenAsked).toBeGreaterThan(200);
    expect(exercised.nextPassesChecked).toBeGreaterThan(150);
    expect(exercised.endedUnasked).toBeGreaterThan(300);
  });
});
