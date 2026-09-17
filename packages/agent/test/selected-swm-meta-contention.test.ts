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
});
