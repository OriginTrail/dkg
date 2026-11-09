import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { activeDefaultStoreWorkPriority, controlStoreOptions, withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import { AsyncLiftJournalCompletion, type JournalOperation, type JournalSection } from '../src/async-lift-journal-completion.js';
import { withKeyedLocks } from '../src/keyed-lock.js';
import type { AdmissionJournalEntry } from '../src/lift-job.js';
import { DEFAULT_JOURNAL_GRAPH_URI, JOURNAL_AT, JOURNAL_JOB_ID, JOURNAL_KIND, JOURNAL_SEQ, parseIntegerLiteral, parseLiteral } from '../src/async-lift-control-plane.js';
import { completesWithin, fixture, gate, observe } from './_helpers/journal-completion.js';
import { resolveLane } from './_helpers/queue-boundary-oracle.js';

function facts(jobId: string, lineageKey = 'test-lineage'): Omit<AdmissionJournalEntry, 'seq' | 'at'> {
  return { jobId, lineageKey, kind: 'admission' };
}

function runCanonical<T>(completion: AsyncLiftJournalCompletion, work: (section: JournalSection) => Promise<T>): Promise<T> {
  return completion.runPublicOperation((operation) => operation.runCanonical(work));
}

describe('journal completion ownership boundaries', () => {
  it('registers synchronously and exposes settlement only after canonical release and journal completion', async () => {
    const f = fixture();
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:registration');
    const canonical = gate();
    const journal = gate();
    f.hooks.read = journal.wait;
    let settled!: Promise<void>;
    let joined!: Promise<void>;
    const operation = runCanonical(completion, async (section) => {
      const ticket = section.append(facts('job'), () => {});
      expect(ticket).not.toHaveProperty('then');
      settled = ticket.settled;
      joined = section.joinJob('job').settled;
      await canonical.wait();
      return 'result';
    });
    try {
      await canonical.reached;
      expect(f.journalReads).not.toHaveBeenCalled();
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

  it('refuses closed operation and section capabilities synchronously, including a missing-job join', async () => {
    const f = fixture();
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:required-scope');
    const journal = gate();
    let section!: JournalSection;
    let owner!: JournalOperation;
    let invoked = false;
    f.hooks.read = journal.wait;
    const operation = completion.runPublicOperation((operation) => {
      owner = operation;
      return operation.runCanonical(async (current) => {
        section = current;
        section.append(facts('existing'), () => {});
      });
    });
    try {
      await journal.reached;
      expect(() => section.append(facts('new'), () => { invoked = true; })).toThrow('closed');
      for (const job of ['existing', 'missing']) {
        expect(() => section.joinJob(job, () => { invoked = true; })).toThrow('closed');
      }
      expect(() => owner.runCanonical(async () => { invoked = true; })).toThrow('closed');
      expect(invoked).toBe(false);
      expect(f.journalReads).toHaveBeenCalledOnce();
    } finally { journal.release(); await operation; }
    await completion.drain();
  });

  it('keeps join-miss callbacks synchronous and preserves their business error', async () => {
    const completion = new AsyncLiftJournalCompletion(fixture().store, 'urn:test:join-miss');
    const failure = new Error('join bookkeeping failed');
    const order: string[] = [];
    await expect(runCanonical(completion, async (section) => {
      section.joinJob('missing', () => { order.push('callback'); throw failure; });
      order.push('after');
    })).rejects.toBe(failure);
    expect(order).toEqual(['callback']);
    await completion.drain();
  });

  it('reports successful settlement only after journals and contains observer faults without reporting business errors as success', async () => {
    const f = fixture();
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:observation');
    const journal = gate();
    const observed: string[] = [];
    f.hooks.read = journal.wait;
    const work = runCanonical(completion, async (section) => {
      section.append(facts('job'), () => {});
      section.afterSuccessfulJobSettlement('job', () => { observed.push('success'); throw new Error('observer'); });
      return 'result';
    });
    try {
      await journal.reached;
      expect(observed).toEqual([]);
    } finally { journal.release(); }
    await expect(work).resolves.toBe('result');
    expect(observed).toEqual(['success']);
    const failure = new Error('authoritative failure');
    await expect(runCanonical(completion, async (section) => {
      section.afterSuccessfulJobSettlement('job', () => { observed.push('false-success'); });
      throw failure;
    })).rejects.toBe(failure);
    expect(observed).toEqual(['success']);
  });

  it('observes job A settlement while a later job B in the same operation still awaits its journal', async () => {
    const f = fixture();
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:per-job');
    const heldB = gate();
    const seen: string[] = [];
    f.hooks.insert = async ({ jobId }) => { if (jobId === 'B') await heldB.wait(); };
    const operation = completion.runPublicOperation(async (owner) => {
      for (const jobId of ['A', 'B']) await owner.runCanonical(async (section) => {
        section.append(facts(jobId), () => {});
        section.afterSuccessfulJobSettlement(jobId, () => { seen.push(jobId); });
      });
    });
    try {
      await heldB.reached;
      await expect.poll(() => [...seen], { timeout: 500 }).toEqual(['A']);
    } finally { heldB.release(); await operation; }
    expect(seen).toEqual(['A', 'B']);
  });

  it('releases the outer canonical section before dispatching work registered under a nested job lock', async () => {
    const f = fixture();
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:scope');
    const outer = gate();
    const dispatched = gate();
    const locks = new Map<string, Promise<void>>();
    f.hooks.read = dispatched.wait;
    const operation = runCanonical(completion, (section) => withKeyedLocks(locks, ['claim'], async () => {
      await withKeyedLocks(locks, ['job'], async () => { section.append(facts('job'), () => {}); });
      await outer.wait();
    }));
    try {
      await outer.reached;
      expect(locks.has('job')).toBe(false);
      expect(locks.has('claim')).toBe(true);
      expect(await completesWithin(dispatched.reached, 30)).toBe(false);
      outer.release();
      expect(await completesWithin(dispatched.reached)).toBe(true);
      expect(locks.size).toBe(0);
    } finally { outer.release(); dispatched.release(); await operation; }
  });

  it('explicitly creates a fresh owner despite inherited closed diagnostic context', async () => {
    const f = fixture();
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:closed');
    const startLater = gate();
    const journal = gate();
    f.hooks.read = journal.wait;
    let later!: Promise<void>;
    await runCanonical(completion, async () => {
      later = (async () => {
        await startLater.wait();
        await runCanonical(completion, async (section) => {
          section.append(facts('late'), () => {});
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
    const initial = runCanonical(first, async (section) => { section.append(facts('job'), bookkeeping.wait); });
    await bookkeeping.reached;
    const later = observe(runCanonical(second, async (section) => { section.append(facts('job'), () => {}); }));
    const duplicate = observe(runCanonical(second, async (section) => { section.joinJob('job'); }));
    try {
      await expect.poll(() => f.journalInserts.length, { timeout: 500 }).toBe(2);
      expect(await completesWithin(later.promise, 30)).toBe(false);
      expect(duplicate.settled()).toBe(false);
    } finally {
      bookkeeping.release(); await Promise.all([initial, later.promise, duplicate.promise]);
    }
  });

  it.each(['shared', 'distinct'] as const)('reserves same-lineage FIFO across %s completion domains before canonical release', async (domains) => {
    const firstStore = fixture();
    const secondStore = domains === 'shared' ? firstStore : fixture();
    const first = new AsyncLiftJournalCompletion(firstStore.store, 'urn:test:fifo-first');
    const second = new AsyncLiftJournalCompletion(secondStore.decoratedStore(),
      domains === 'shared' ? 'urn:test:fifo-first' : 'urn:test:fifo-second');
    const canonical = gate();
    const order: string[] = [];
    firstStore.hooks.insert = async ({ jobId }) => { order.push(jobId); };
    if (domains === 'distinct') secondStore.hooks.insert = async ({ jobId }) => { order.push(jobId); };
    const initial = runCanonical(first, async (section) => {
      section.append(facts('first', 'fifo-lineage'), () => {});
      await canonical.wait();
    });
    const pending: Promise<unknown>[] = [initial];
    try {
      await canonical.reached;
      const successor = runCanonical(second, async (section) => {
        section.append(facts('second', 'fifo-lineage'), () => {});
      });
      pending.push(successor);
      const independent = runCanonical(second, async (section) => {
        section.append(facts('independent', 'other-lineage'), () => {});
      });
      pending.push(independent);
      expect(await completesWithin(independent)).toBe(true);
      expect(firstStore.journalReads.mock.calls.length).toBe(domains === 'shared' ? 1 : 0);
      expect(secondStore.journalReads).toHaveBeenCalledOnce();
      expect(order).toEqual(['independent']);
      expect(await completesWithin(successor, 30)).toBe(false);
    } finally {
      canonical.release(); await Promise.all(pending);
    }
    expect(order).toEqual(['independent', 'first', 'second']);
  });

  it('captures facts at registration and timestamps the append only after MAX settles', async () => {
    const f = fixture();
    let now = 100;
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:capture', () => now);
    const max = gate();
    f.hooks.read = max.wait;
    const captured = { ...facts('before', 'capture-lineage') };
    const operation = runCanonical(completion, async (section) => {
      section.append(captured, () => {});
      captured.jobId = 'after';
      captured.kind = 'claimed';
      captured.lineageKey = 'changed-lineage';
    });
    try {
      await max.reached;
      expect(f.journalInserts).toHaveLength(0);
      now = 900;
    } finally { max.release(); await operation; }
    const rows = await f.inner.query(
      `SELECT ?job ?kind ?at ?seq WHERE { GRAPH <${DEFAULT_JOURNAL_GRAPH_URI}> { ?e <${JOURNAL_JOB_ID}> ?job ; <${JOURNAL_KIND}> ?kind ; <${JOURNAL_AT}> ?at ; <${JOURNAL_SEQ}> ?seq } }`,
    );
    if (rows.type !== 'bindings') throw new Error('Expected journal bindings');
    expect(rows.bindings.map((row) => ({
      jobId: parseLiteral(row['job']!), kind: parseLiteral(row['kind']!),
      at: parseIntegerLiteral(row['at']!), seq: parseIntegerLiteral(row['seq']!),
    }))).toEqual([{ jobId: 'before', kind: 'admission', at: 900, seq: 0 }]);
  });

  it('preserves business rejection and successor progress after synchronous and asynchronous auxiliary faults', async () => {
    const f = fixture();
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:errors');
    const original = new Error('authoritative operation failed');
    let reads = 0;
    f.hooks.read = () => {
      if (++reads === 1) throw new Error('MAX hook failed synchronously');
      return Promise.reject(new Error('MAX hook failed asynchronously'));
    };
    let completed = 0;
    const failed = runCanonical(completion, async (section) => {
      section.append(facts('job'), () => { completed++; throw new Error('bookkeeping failed'); });
      section.append(facts('job'), () => { completed++; });
      throw original;
    });
    await expect(failed).rejects.toBe(original);
    expect(reads).toBe(2);
    expect(completed).toBe(2);
    f.hooks.read = undefined;
    await expect(runCanonical(completion, async (section) => {
      section.append(facts('job'), () => {});
      return 'next';
    })).resolves.toBe('next');
    expect(f.journalInserts).toHaveLength(1);
    await completion.drain();
  });

  // OT-RFC-73 S1 (D-4, #3286): the journal's two store calls run after canonical release, in the caller's own async
  // context. The caller's async-local storage and ambient lane still flow into that deferred dispatch (with the
  // control path OFF the ambient lane is what decides, exactly as before), but the queue tag no longer depends on
  // them: both calls carry the control options explicitly, so with the path ON they resolve to the publisher's
  // control path whatever lane the caller, or the code that released the section, was running in.
  it('carries the control options explicitly across deferred dispatch and retains the caller context for the path-off lane', async () => {
    const f = fixture();
    const completion = new AsyncLiftJournalCompletion(f.store, 'urn:test:priority');
    const context = new AsyncLocalStorage<string>();
    const gateHeld = gate();
    const seen: unknown[] = [];
    f.hooks.read = async (options) => { seen.push('MAX', context.getStore(), activeDefaultStoreWorkPriority(), options); };
    f.hooks.insert = async (_entry, options) => { seen.push('INSERT', context.getStore(), activeDefaultStoreWorkPriority(), options); };
    const operation = context.run('request', () => withDefaultStoreWorkPriority('background', () =>
      runCanonical(completion, async (section) => {
        section.append(facts('job'), () => {});
        await gateHeld.wait();
      })));
    await gateHeld.reached;
    withDefaultStoreWorkPriority('ack', gateHeld.release);
    await operation;
    const max = controlStoreOptions('publisher', 'publisher.asyncLift.allocateJournalSeq');
    const insert = controlStoreOptions('publisher', 'publisher.asyncLift.appendJournalEntry');
    expect(seen).toEqual(['MAX', 'request', 'background', max, 'INSERT', 'request', 'background', insert]);
    // The exact options set no priority, and the lane they resolve to is the queue's, not the ambient one.
    expect(max).toEqual({ source: 'publisher.asyncLift.allocateJournalSeq', controlQueue: 'publisher' });
    expect(insert).toEqual({ source: 'publisher.asyncLift.appendJournalEntry', controlQueue: 'publisher' });
    for (const options of [max, insert]) {
      expect(resolveLane({ options, ambient: 'background' }, true)).toBe('control:publisher');
      expect(resolveLane({ options, ambient: 'background' }, false)).toBe('background');
    }
  });
});
