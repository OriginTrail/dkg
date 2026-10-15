import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { activeDefaultStoreWorkPriority, withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { AsyncLiftJournalCompletion } from '../src/async-lift-journal-completion.js';
import { completesWithin, fixture, gate, observe } from './_helpers/journal-completion.js';

describe('journal completion ownership boundaries', () => {
  it('registers synchronously and exposes settlement only after canonical release and journal completion', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:registration');
    const canonical = gate();
    const journal = gate();
    let reserved = false;
    let settled!: Promise<void>;
    let joined!: Promise<void>;
    const operation = completion.runPublicOperation(() => completion.runCriticalSection(async () => {
      const ticket = completion.registerJournal('job', async (released) => {
        reserved = true;
        await released;
        await journal.wait();
      });
      expect(reserved).toBe(true);
      expect(ticket).not.toHaveProperty('then');
      settled = ticket.settled;
      joined = completion.registerJobJoin('job').settled;
      await canonical.wait();
      return 'result';
    }));
    try {
      await canonical.reached;
      expect(await completesWithin(journal.reached, 30)).toBe(false);
      expect(await completesWithin(settled, 30)).toBe(false);
      canonical.release();
      await journal.reached;
      expect(await completesWithin(settled, 30)).toBe(false);
      expect(await completesWithin(joined, 30)).toBe(false);
    } finally {
      canonical.release(); journal.release(); await operation;
    }
    await expect(settled).resolves.toBeUndefined();
    await expect(joined).resolves.toBeUndefined();
    await expect(operation).resolves.toBe('result');
  });

  it('refuses out-of-scope registration and joins synchronously, including a missing job', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:required-scope');
    const journal = gate();
    let invoked = false;
    const operation = completion.runPublicOperation(async () => {
      completion.registerJournal('existing', () => journal.wait());
    });
    try {
      await journal.reached;
      expect(() => completion.registerJournal('new', async () => { invoked = true; }))
        .toThrow('requires an open publisher completion scope');
      for (const job of ['existing', 'missing']) {
        expect(() => completion.registerJobJoin(job, () => { invoked = true; }))
          .toThrow('requires an open publisher completion scope');
      }
      expect(invoked).toBe(false);
    } finally { journal.release(); await operation; }
    await completion.drain();
  });

  it('keeps join-miss callbacks synchronous and preserves their business error', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:join-miss');
    const failure = new Error('join bookkeeping failed');
    const order: string[] = [];
    await expect(completion.runPublicOperation(async () => {
      completion.registerJobJoin('missing', () => { order.push('callback'); throw failure; });
      order.push('after');
    })).rejects.toBe(failure);
    expect(order).toEqual(['callback']);
    await completion.drain();
  });

  it('reports successful settlement only after journals and contains observer faults without reporting business errors as success', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:observation');
    const journal = gate();
    const observed: string[] = [];
    const work = completion.runCriticalSection(async () => {
      completion.registerJournal('job', async (released) => { await released; await journal.wait(); });
      completion.afterSuccessfulJobSettlement('job', () => { observed.push('success'); throw new Error('observer'); });
      return 'result';
    });
    try {
      await journal.reached;
      expect(observed).toEqual([]);
    } finally { journal.release(); }
    await expect(work).resolves.toBe('result');
    expect(observed).toEqual(['success']);
    const failure = new Error('authoritative failure');
    await expect(completion.runCriticalSection(async () => {
      completion.afterSuccessfulJobSettlement('job', () => { observed.push('false-success'); });
      throw failure;
    })).rejects.toBe(failure);
    expect(observed).toEqual(['success']);
  });

  it('observes job A settlement while a later job B in the same operation still awaits its journal', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:per-job');
    const heldB = gate();
    const seen: string[] = [];
    const operation = completion.runPublicOperation(async () => {
      for (const jobId of ['A', 'B']) await completion.runCriticalSection(async () => {
        completion.registerJournal(jobId, async (released) => { await released; if (jobId === 'B') await heldB.wait(); });
        completion.afterSuccessfulJobSettlement(jobId, () => { seen.push(jobId); });
      });
    });
    try {
      await heldB.reached;
      await expect.poll(() => [...seen], { timeout: 500 }).toEqual(['A']);
    } finally { heldB.release(); await operation; }
    expect(seen).toEqual(['A', 'B']);
  });

  it('releases the outer canonical section before dispatching nested journal work', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:scope');
    const outer = gate();
    const dispatched = gate();
    const operation = completion.runCriticalSection(async () => {
      await completion.runCriticalSection(async () => {
        completion.registerJournal('job', async (released) => { await released; await dispatched.wait(); });
      });
      await outer.wait();
    });
    try {
      await outer.reached;
      expect(await completesWithin(dispatched.reached, 30)).toBe(false);
      outer.release();
      expect(await completesWithin(dispatched.reached)).toBe(true);
    } finally {
      outer.release(); dispatched.release(); await operation;
    }
  });

  it('creates a fresh owner from inherited closed operation and section contexts', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:closed');
    const startLater = gate();
    const journal = gate();
    let later!: Promise<void>;
    await completion.runCriticalSection(async () => {
      later = (async () => {
        await startLater.wait();
        await completion.runCriticalSection(async () => {
          completion.registerJournal('late', async (released) => { await released; await journal.wait(); });
        });
      })();
    });
    startLater.release();
    const observed = observe(later);
    let drain: Promise<void> | undefined;
    try {
      expect(await completesWithin(journal.reached)).toBe(true);
      drain = completion.drain();
      expect(await completesWithin(drain, 30)).toBe(false);
      expect(observed.settled()).toBe(false);
    } finally {
      journal.release(); await later; await drain;
    }
  });

  it('joins previous same-job bookkeeping even when the newer journal settles first', async () => {
    const f = fixture();
    const first = new AsyncLiftJournalCompletion(f.store, 'urn:test:tail');
    const second = new AsyncLiftJournalCompletion(f.decoratedStore(), 'urn:test:tail');
    const bookkeeping = gate();
    const initial = first.runPublicOperation(async () => { first.registerJournal('job', () => bookkeeping.wait()); });
    await bookkeeping.reached;
    const later = observe(second.runPublicOperation(async () => { second.registerJournal('job', async () => {}); }));
    const duplicate = observe(second.runPublicOperation(async () => { second.registerJobJoin('job'); }));
    try {
      expect(await completesWithin(later.promise, 30)).toBe(false);
      expect(duplicate.settled()).toBe(false);
    } finally {
      bookkeeping.release(); await Promise.all([initial, later.promise, duplicate.promise]);
    }
  });

  it('preserves business rejection and successor progress after synchronous and asynchronous auxiliary faults', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:errors');
    const original = new Error('authoritative operation failed');
    const failed = completion.runCriticalSection(async () => {
      completion.registerJournal('job', () => { throw new Error('reservation observer failed'); });
      completion.registerJournal('job', async (released) => { await released; throw new Error('journal write failed'); });
      throw original;
    });
    await expect(failed).rejects.toBe(original);
    await expect(completion.runCriticalSection(async () => {
      completion.registerJournal('job', async (released) => { await released; });
      return 'next';
    })).resolves.toBe('next');
    await completion.drain();
  });

  it('retains caller async-local storage and store priority across deferred dispatch', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:priority');
    const context = new AsyncLocalStorage<string>();
    const gateHeld = gate();
    const seen: unknown[] = [];
    const operation = context.run('request', () => withDefaultStoreWorkPriority('background', () =>
      completion.runCriticalSection(async () => {
        completion.registerJournal('job', async (released) => {
          await released;
          seen.push(context.getStore(), activeDefaultStoreWorkPriority());
        });
        await gateHeld.wait();
      })));
    await gateHeld.reached;
    withDefaultStoreWorkPriority('ack', gateHeld.release);
    await operation;
    expect(seen).toEqual(['request', 'background']);
  });
});
