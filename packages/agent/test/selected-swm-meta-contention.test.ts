import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { createSelectedSwmMetaFetcher } from '../src/sync/selected-swm-meta-fetcher.js';
import { createSelectedSwmMetaRetentionBudget } from '../src/sync/selected-swm-meta-budget.js';
import { SyncPageAccumulationLimitError } from '../src/sync/requester/page-fetch.js';

const testContext = {
  operationId: 'selected-meta-contention-test',
  operationName: 'sync',
} as OperationContext;

const request = (contextGraphId: string, remotePeerId: string) => ({
  ctx: testContext,
  remotePeerId,
  contextGraphId,
  graphUri: 'urn:meta',
  deadline: Date.now() + 60_000,
});

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

  // The four cases below are about a pool that is reserved by fetches still in
  // flight, not held by retained prefixes. Every fetch reserves a whole prefix
  // allowance before it starts, so with the default limits the pool admits
  // three transfers at once however little they go on to retain.
  const emptyPage = (contextGraphId: string) => ({
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `${contextGraphId}:checkpoint`,
    completed: true,
    timedOut: false,
  });

  /** A holder whose one fetch stays in flight until `settle` is called. */
  const holderInFlight = (
    budget: ReturnType<typeof createSelectedSwmMetaRetentionBudget>,
    page: (contextGraphId: string) => ReturnType<typeof emptyPage> | ReturnType<typeof row>[],
  ) => {
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => { settle = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const holder = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-holder',
      requesterScope: 'selected-swm-meta:retained:holder',
      retentionBudget: budget,
      deleteCheckpoint: vi.fn(),
      fetchPage: async (req: { contextGraphId: string }) => {
        signalStarted();
        await gate;
        const served = page(req.contextGraphId);
        return Array.isArray(served)
          ? {
            quads: served,
            bytesReceived: served.length,
            resumedFromOffset: 0,
            nextOffset: served.length,
            checkpointKey: `${req.contextGraphId}:checkpoint`,
            completed: false,
            timedOut: true,
          }
          : served;
      },
    });
    const outcome = holder.strategy.fetch(request('cg-holder', 'peer-holder'));
    return { outcome, started, settle };
  };

  it('asks its peer once the fetch in flight has settled instead of reporting a timed-out page', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const holder = holderInFlight(budget, emptyPage);
    await holder.started;

    const waiterFetch = vi.fn(async (req: { contextGraphId: string; maxAcceptedQuads: number }) => (
      emptyPage(req.contextGraphId)
    ));
    const waiter = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-waiter',
      requesterScope: 'selected-swm-meta:retained:waiter',
      retentionBudget: budget,
      deleteCheckpoint: vi.fn(),
      fetchPage: waiterFetch,
    });
    let settled = false;
    const waiting = waiter.strategy.fetch(request('cg-waiter', 'peer-waiter'))
      .finally(() => { settled = true; });
    // The pool is reserved, not full: the waiter neither spends a fetch that
    // could accept nothing nor gives up on a peer it has not asked.
    await new Promise((resolve) => setImmediate(resolve));
    expect(waiterFetch).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    holder.settle();
    const outcome = await waiting;

    expect(waiterFetch).toHaveBeenCalledTimes(1);
    expect(waiterFetch.mock.calls[0]![0]!.maxAcceptedQuads).toBe(2);
    expect(outcome.continuationYielded).toBe(false);
    expect(outcome.result.completed).toBe(true);
    expect(outcome.result.timedOut).toBe(false);
    await holder.outcome;
  });

  it('lets several waiting transfers through one after another', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const holder = holderInFlight(budget, emptyPage);
    await holder.started;

    let fetching = 0;
    let mostAtOnce = 0;
    const waiterFetch = vi.fn(async (req: { contextGraphId: string }) => {
      fetching += 1;
      mostAtOnce = Math.max(mostAtOnce, fetching);
      await new Promise((resolve) => setImmediate(resolve));
      fetching -= 1;
      return emptyPage(req.contextGraphId);
    });
    const waiting = ['a', 'b', 'c'].map((name) => createSelectedSwmMetaFetcher({
      remotePeerId: `peer-waiter-${name}`,
      requesterScope: `selected-swm-meta:retained:waiter-${name}`,
      retentionBudget: budget,
      deleteCheckpoint: vi.fn(),
      fetchPage: waiterFetch,
    }).strategy.fetch(request(`cg-waiter-${name}`, `peer-waiter-${name}`)));
    // Waiters that woke each other would spin here and starve the fetch in
    // flight; a macrotask getting its turn shows that they are parked.
    await new Promise((resolve) => setImmediate(resolve));
    expect(waiterFetch).not.toHaveBeenCalled();

    holder.settle();
    const outcomes = await Promise.all(waiting);

    expect(waiterFetch).toHaveBeenCalledTimes(3);
    // The pool admits one whole allowance: the waiters take it in turn.
    expect(mostAtOnce).toBe(1);
    for (const outcome of outcomes) {
      expect(outcome.continuationYielded).toBe(false);
      expect(outcome.result.completed).toBe(true);
    }
    await holder.outcome;
  });

  it('still yields when the fetch in flight leaves the pool full of its prefix', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const holder = holderInFlight(
      budget,
      (contextGraphId) => [row(contextGraphId), row(contextGraphId)],
    );
    await holder.started;

    const waiterFetch = vi.fn(async (req: { contextGraphId: string }) => emptyPage(req.contextGraphId));
    const waiter = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-waiter',
      requesterScope: 'selected-swm-meta:retained:waiter',
      retentionBudget: budget,
      deleteCheckpoint: vi.fn(),
      fetchPage: waiterFetch,
    });
    const waiting = waiter.strategy.fetch(request('cg-waiter', 'peer-waiter'));
    holder.settle();
    const outcome = await waiting;

    // Nothing is in flight any more and the sibling kept everything it had
    // reserved: that is the retained-prefix contention the yield exists for.
    expect(waiterFetch).not.toHaveBeenCalled();
    expect(outcome.continuationYielded).toBe(true);
    expect(outcome.result.completed).toBe(false);
    expect(outcome.result.timedOut).toBe(true);
    await holder.outcome;
  });

  it('stops waiting at the deadline of its own round', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 2,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
    const holder = holderInFlight(budget, emptyPage);
    await holder.started;

    const waiterFetch = vi.fn(async (req: { contextGraphId: string }) => emptyPage(req.contextGraphId));
    const waiter = createSelectedSwmMetaFetcher({
      remotePeerId: 'peer-waiter',
      requesterScope: 'selected-swm-meta:retained:waiter',
      retentionBudget: budget,
      deleteCheckpoint: vi.fn(),
      fetchPage: waiterFetch,
    });

    const outcome = await waiter.strategy.fetch({
      ...request('cg-waiter', 'peer-waiter'),
      deadline: Date.now() + 20,
    });

    expect(waiterFetch).not.toHaveBeenCalled();
    expect(outcome.continuationYielded).toBe(true);
    expect(outcome.result.timedOut).toBe(true);
    holder.settle();
    await holder.outcome;
  });

  it('does not make a transfer that already holds a prefix wait for the fetch in flight', async () => {
    const budget = createSelectedSwmMetaRetentionBudget({
      maxRows: 3,
      maxBytesEstimate: 1024 * 1024,
      maxPrefixRows: 2,
      maxPrefixBytesEstimate: 1024 * 1024,
    });
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
      deleteCheckpoint: vi.fn(),
      fetchPage: waiterFetch,
    });
    await waiter.strategy.fetch(request('cg-waiter', 'peer-waiter'));
    expect(waiter.continuation('cg-waiter').progress).toBe(1);
    waiterFetch.mockClear();

    const holder = holderInFlight(budget, emptyPage);
    await holder.started;

    // Resolves while the sibling is still fetching: the prefix and its cursor
    // are what the yield protects, and the ledger grants this round a retry.
    const outcome = await waiter.strategy.fetch(request('cg-waiter', 'peer-waiter'));

    expect(waiterFetch).not.toHaveBeenCalled();
    expect(outcome.continuationYielded).toBe(true);
    expect(outcome.result.resumedFromOffset).toBe(1);
    expect(outcome.result.timedOut).toBe(true);
    holder.settle();
    await holder.outcome;
  });

  it('never gives up on an unasked peer while a fetch is in flight, whatever the order of events', async () => {
    // Seeded schedules: transfers start and fetches settle in a drawn order,
    // against pools of one to three allowances, with peers that serve nothing,
    // a complete manifest or a prefix that stays retained. Two properties
    // must hold in every schedule. Every transfer ends once nothing is in
    // flight any more (no waiter is left parked), and a transfer ends without
    // having asked its peer only when no fetch was in flight at that moment:
    // the pool was then held by retained prefixes, which is what the yield is
    // for.
    const seeded = (seed: number) => {
      let state = seed;
      return () => {
        state += 0x6D2B79F5;
        let mixed = Math.imul(state ^ (state >>> 15), state | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
      };
    };
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    const allowanceRows = 4;
    const allowanceBytes = 1024 * 1024;
    let waitedForCapacity = 0;

    for (let seed = 1; seed <= 80; seed += 1) {
      const next = seeded(seed);
      const pick = (count: number) => Math.floor(next() * count);
      const poolAllowances = 1 + pick(3);
      const budget = createSelectedSwmMetaRetentionBudget({
        maxRows: allowanceRows * poolAllowances,
        maxBytesEstimate: allowanceBytes * poolAllowances,
        maxPrefixRows: allowanceRows,
        maxPrefixBytesEstimate: allowanceBytes,
      });
      const inFlight = new Map<number, () => void>();
      const ended: Array<{ askedPeer: boolean; inFlightWhenEnded: number }> = [];
      const transfers = 3 + pick(8);

      const start = (transfer: number) => {
        const servedRows = [0, 0, 0, 1, 2, allowanceRows][pick(6)]!;
        const completed = servedRows === 0 || pick(2) === 0;
        let askedPeer = false;
        const startedWith = inFlight.size;
        const fetcher = createSelectedSwmMetaFetcher({
          remotePeerId: `peer-${transfer}`,
          requesterScope: `selected-swm-meta:retained:${transfer}`,
          retentionBudget: budget,
          deleteCheckpoint: vi.fn(),
          fetchPage: async (req: { contextGraphId: string; maxAcceptedQuads: number }) => {
            askedPeer = true;
            await new Promise<void>((resolve) => { inFlight.set(transfer, resolve); });
            // The page fetcher refuses rows beyond what the reservation admits.
            if (servedRows > req.maxAcceptedQuads) {
              throw new SyncPageAccumulationLimitError('quads', servedRows, req.maxAcceptedQuads);
            }
            return {
              quads: Array.from({ length: servedRows }, () => row(req.contextGraphId)),
              bytesReceived: servedRows,
              resumedFromOffset: 0,
              nextOffset: servedRows,
              checkpointKey: `${req.contextGraphId}:checkpoint`,
              completed,
              timedOut: !completed,
            };
          },
        });
        const end = () => {
          if (askedPeer && startedWith >= poolAllowances) waitedForCapacity += 1;
          ended.push({ askedPeer, inFlightWhenEnded: inFlight.size });
        };
        void fetcher.strategy.fetch(request(`cg-${transfer}`, `peer-${transfer}`)).then(end, end);
      };

      let started = 0;
      // Each step starts one transfer or settles one fetch, so the loop ends
      // after at most two steps a transfer.
      for (let step = 0; step < 2 * transfers && (started < transfers || inFlight.size > 0); step += 1) {
        if (started < transfers && (inFlight.size === 0 || pick(2) === 0)) {
          start(started);
          started += 1;
        } else {
          const fetching = [...inFlight.keys()];
          const settled = fetching[pick(fetching.length)]!;
          const settle = inFlight.get(settled)!;
          inFlight.delete(settled);
          settle();
        }
        await turn();
      }
      await turn();

      expect(inFlight.size, `seed ${seed}`).toBe(0);
      expect(ended, `seed ${seed}`).toHaveLength(transfers);
      for (const transfer of ended) {
        if (!transfer.askedPeer) expect(transfer.inFlightWhenEnded, `seed ${seed}`).toBe(0);
      }
    }
    // The schedules do exercise the wait: transfers that started against a
    // pool reserved by fetches in flight went on to ask their peer.
    expect(waitedForCapacity).toBeGreaterThan(20);
  });
});
