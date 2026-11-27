/**
 * OT-RFC-73 P9a (AC6): interleaved mutation on the publisher queue.
 *
 * The queue keeps running while a client walks the listing: jobs are admitted, claimed, finalized, cancelled and
 * cleared between two pages. The contract of a walk:
 *
 *   - no job is returned twice;
 *   - every job that matched the filter for the WHOLE walk (at every page read, and at its end) is returned exactly once;
 *   - nothing is returned that never matched (each job returned was a match when its page was read);
 *   - the keys come out strictly increasing, so a page never goes back behind its own cursor.
 *
 * `complete` says no further row followed the last page when it was read, not that the queue is empty.
 *
 * The mutations run through the real publisher (a second instance over the same store, as the daemon's admission and
 * runtime instances are), including the ones the plan names: an insert with `acceptedAt` equal to the cursor's and a
 * LOWER job id (it sorts behind the cursor, so this walk never sees it), the same with a HIGHER id (ahead of it, so the
 * walk sees it once), a state change of an emitted and of a not yet emitted job, and the removal of the job the cursor
 * points at.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { compareLiftJobPageKeys, decodeLiftJobPageCursor, type LiftJobPageKey } from '../src/lift-job-page.js';
import type { LiftJobState } from '../src/lift-job-states.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';
import type { JobFilter } from './_helpers/lift-job-inventory.js';

const opened: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((store) => store.close()));
});

/** Two publisher instances over one store with a settable clock: admission stamps `acceptedAt` from it. */
function createQueue() {
  const store = new OxigraphStore();
  opened.push(store);
  const clock = { now: 1_000_000, nextId: 'unset', tick: 0 };
  const config = { now: () => clock.now, idGenerator: () => clock.nextId } as const;
  const lister = new TripleStoreAsyncLiftPublisher(store, config);
  const writer = new TripleStoreAsyncLiftPublisher(store, config);
  let wallets = 0;
  const later = (): void => { clock.now = 1_000_000 + ++clock.tick; };
  return {
    store,
    lister,
    writer,
    /** Admit a job accepted at `acceptedAt` with id `id`. */
    async enqueue(id: string, acceptedAt: number, contextGraphId = 'cg-a'): Promise<void> {
      clock.nextId = id;
      clock.now = acceptedAt;
      try {
        await writer.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
          contextGraphId,
          name: `name-${id}`,
          shareOperationId: `op-${id}`,
          intentKey: `sha256:${createHash('sha256').update(id).digest('hex')}`,
        }));
      } finally {
        later();
      }
    },
    async claim(): Promise<string | undefined> {
      later();
      return (await writer.claimNext(`wallet-${++wallets}`))?.jobId;
    },
    async validate(jobId: string): Promise<void> {
      later();
      await writer.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    },
    async finalize(jobId: string): Promise<void> {
      later();
      await writer.update(jobId, 'finalized', { finalization: { mode: 'local' } });
    },
    async cancel(jobId: string): Promise<void> {
      later();
      await writer.cancel(jobId);
    },
    async clearFinalized(): Promise<void> {
      later();
      await writer.clear('finalized');
    },
    async idsIn(status: LiftJobState): Promise<string[]> {
      return (await writer.list({ status })).map((job) => job.jobId);
    },
  };
}
type Queue = ReturnType<typeof createQueue>;

interface WalkReport {
  readonly seen: string[];
  readonly pages: number;
  readonly stable: Set<string>;
}

/**
 * Walk `filter` page by page, running `between` after every page that has a successor, and check the contract of a
 * walk against the queue as it stood at every page read and at the end.
 */
async function interleavedWalk(
  queue: Queue,
  filter: JobFilter,
  limit: number,
  between: (pageIndex: number, cursor: LiftJobPageKey, returnedSoFar: readonly string[]) => Promise<void>,
): Promise<WalkReport> {
  const snapshots: Array<Set<string>> = [];
  const seen: string[] = [];
  const keys = new Map<string, LiftJobPageKey>();
  const matching = async (): Promise<Set<string>> => new Set((await queue.lister.list(filter)).map((job) => job.jobId));
  let cursor: string | undefined;
  let previous: LiftJobPageKey | undefined;
  let pages = 0;
  for (;;) {
    const atRead = await matching();
    snapshots.push(atRead);
    const page = await queue.lister.listPage({ ...filter, limit, ...(cursor === undefined ? {} : { cursor }) });
    pages += 1;
    for (const job of page.jobs) {
      expect(atRead.has(job.jobId), `${job.jobId} was returned but did not match when its page was read`).toBe(true);
      const key = { acceptedAt: job.timestamps.acceptedAt, jobId: job.jobId };
      if (previous !== undefined) expect(compareLiftJobPageKeys(previous, key), `${job.jobId} went back behind the cursor`).toBeLessThan(0);
      previous = key;
      keys.set(job.jobId, key);
      seen.push(job.jobId);
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    await between(pages - 1, decodeLiftJobPageCursor(cursor), seen);
    if (pages > 100) throw new Error('the walk did not end');
  }
  snapshots.push(await matching());
  expect(new Set(seen).size, `a job was returned twice: ${seen.join(',')}`).toBe(seen.length);
  const stable = new Set([...snapshots[0]!].filter((id) => snapshots.every((snapshot) => snapshot.has(id))));
  for (const id of stable) expect(seen, `${id} matched the filter for the whole walk and was not returned`).toContain(id);
  return { seen, pages, stable };
}

async function seedTied(queue: Queue, ids: readonly string[], acceptedAt: number): Promise<void> {
  for (const id of ids) await queue.enqueue(id, acceptedAt);
}

describe('publisher job page: interleaved mutation (scripted)', () => {
  it('an insert with the cursor\'s acceptedAt and a lower id lands behind the cursor; a higher id lands ahead of it, once', async () => {
    const queue = createQueue();
    await queue.enqueue('k00', 90);
    await seedTied(queue, ['k10', 'k20', 'k30', 'k40', 'k50'], 100);
    await queue.enqueue('k99', 110);
    const initial = ['k00', 'k10', 'k20', 'k30', 'k40', 'k50', 'k99'];
    const walk = await interleavedWalk(queue, {}, 2, async (index, cursor) => {
      if (index === 1) {
        // The second page ended at k30 @100. Tie the cursor on time: three ids that sort below it, two above.
        expect(cursor).toEqual({ acceptedAt: 100, jobId: 'k30' });
        for (const id of ['a-below', 'k15', 'k25', 'k35', 'z-above']) await queue.enqueue(id, 100);
      }
    });
    expect(walk.seen).toEqual(['k00', 'k10', 'k20', 'k30', 'k35', 'k40', 'k50', 'z-above', 'k99']);
    for (const id of initial) expect(walk.seen.filter((seen) => seen === id)).toHaveLength(1);
    for (const id of ['a-below', 'k15', 'k25']) expect(walk.seen).not.toContain(id);
    // A fresh walk sees everything, in key order: the late inserts behind the cursor are not lost, just not part of that walk.
    const fresh = await interleavedWalk(queue, {}, 3, async () => undefined);
    expect(fresh.seen).toEqual(['k00', 'a-below', 'k10', 'k15', 'k20', 'k25', 'k30', 'k35', 'k40', 'k50', 'z-above', 'k99']);
  });

  it('an insert with the cursor\'s acceptedAt on the very first boundary behaves the same (cursor in the middle of a tie)', async () => {
    const queue = createQueue();
    await seedTied(queue, ['m1', 'm3', 'm5'], 40);
    const walk = await interleavedWalk(queue, {}, 1, async (index, cursor) => {
      if (index === 0) {
        expect(cursor).toEqual({ acceptedAt: 40, jobId: 'm1' });
        await queue.enqueue('m0', 40);
        await queue.enqueue('m2', 40);
      }
    });
    expect(walk.seen).toEqual(['m1', 'm2', 'm3', 'm5']);
  });

  it('state transitions between pages neither repeat nor lose a job in an unfiltered walk', async () => {
    const queue = createQueue();
    await seedTied(queue, ['t1', 't2', 't3', 't4', 't5', 't6'], 20);
    const walk = await interleavedWalk(queue, {}, 2, async (index) => {
      if (index === 0) {
        // The oldest accepted job is the first one, already emitted: it moves to claimed and on to finalized.
        const claimed = await queue.claim();
        expect(claimed).toBe('t1');
        await queue.validate('t1');
        await queue.finalize('t1');
        // A job not yet emitted moves too.
        await queue.cancel('t5');
      }
      if (index === 1) {
        const claimed = await queue.claim();
        expect(claimed).toBe('t2');
      }
    });
    expect(walk.seen).toEqual(['t1', 't2', 't3', 't4', 't6']);
    expect(walk.stable).toEqual(new Set(['t1', 't2', 't3', 't4', 't6']));
  });

  it('a status-filtered walk returns a job that left the filter only if it had not yet been passed, and never twice', async () => {
    const queue = createQueue();
    await seedTied(queue, ['s1', 's2', 's3', 's4', 's5'], 30);
    const walk = await interleavedWalk(queue, { status: 'accepted' }, 2, async (index) => {
      if (index === 0) {
        // s1 and s2 were emitted. Claiming moves the oldest accepted job (s1) out of the filter after it was returned.
        expect(await queue.claim()).toBe('s1');
        // s3 leaves before its page is read: it must not appear.
        expect(await queue.claim()).toBe('s2');
        expect(await queue.claim()).toBe('s3');
      }
    });
    expect(walk.seen).toEqual(['s1', 's2', 's4', 's5']);
    expect(walk.stable).toEqual(new Set(['s4', 's5']));
  });

  it('removing the job the cursor points at, or emptying the tail, ends the walk cleanly', async () => {
    const queue = createQueue();
    await seedTied(queue, ['c1', 'c2', 'c3', 'c4'], 15);
    const walk = await interleavedWalk(queue, {}, 2, async (index, cursor) => {
      if (index === 0) {
        expect(cursor.jobId).toBe('c2');
        await queue.cancel('c2');
        await queue.cancel('c4');
      }
    });
    expect(walk.seen).toEqual(['c1', 'c2', 'c3']);
    const empty = await interleavedWalk(queue, {}, 1, async (index) => {
      if (index === 0) {
        await queue.cancel('c3');
      }
    });
    expect(empty.seen).toEqual(['c1']);
  });

  it('clearing finalized jobs between pages leaves the rest of the walk intact', async () => {
    const queue = createQueue();
    await seedTied(queue, ['f1', 'f2', 'f3', 'f4'], 12);
    for (const id of ['f1', 'f2']) {
      expect(await queue.claim()).toBe(id);
      await queue.validate(id);
      await queue.finalize(id);
    }
    const walk = await interleavedWalk(queue, {}, 1, async (index) => {
      if (index === 0) await queue.clearFinalized();
    });
    expect(walk.seen).toEqual(['f1', 'f3', 'f4']);
  });

  it('is unaffected by a graph-scoped admission into another context graph', async () => {
    const queue = createQueue();
    await seedTied(queue, ['g1', 'g2', 'g3'], 5);
    const walk = await interleavedWalk(queue, { contextGraphId: 'cg-a' }, 1, async (index) => {
      if (index === 0) await queue.enqueue('other', 5, 'cg-b');
    });
    expect(walk.seen).toEqual(['g1', 'g2', 'g3']);
  });
});

describe('publisher job page: interleaved mutation (property)', () => {
  type Op =
    | { readonly kind: 'insert'; readonly at: 'cursor' | 'earlier' | 'later'; readonly side: 'below' | 'above' }
    | { readonly kind: 'claim' }
    | { readonly kind: 'validate'; readonly pick: number }
    | { readonly kind: 'finalize'; readonly pick: number }
    | { readonly kind: 'cancel'; readonly pick: number }
    | { readonly kind: 'clear' };

  const op: fc.Arbitrary<Op> = fc.oneof(
    { weight: 5, arbitrary: fc.record({ kind: fc.constant('insert' as const), at: fc.constantFrom('cursor' as const, 'cursor' as const, 'earlier' as const, 'later' as const), side: fc.constantFrom('below' as const, 'above' as const) }) },
    { weight: 3, arbitrary: fc.constant({ kind: 'claim' as const }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('validate' as const), pick: fc.nat(9) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant('finalize' as const), pick: fc.nat(9) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant('cancel' as const), pick: fc.nat(9) }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'clear' as const }) },
  );
  const scenarios = fc.record({
    initial: fc.array(fc.record({ time: fc.integer({ min: 10, max: 14 }), name: fc.integer({ min: 0, max: 99 }) }), { minLength: 2, maxLength: 8 }),
    status: fc.constantFrom<LiftJobState | undefined>(undefined, undefined, 'accepted', 'claimed'),
    limit: fc.constantFrom(1, 2, 3),
    between: fc.array(fc.array(op, { maxLength: 4 }), { minLength: 1, maxLength: 5 }),
  });
  const stats = { cases: 0, walks: 0, multiPage: 0, tieBelow: 0, tieAbove: 0, removedEmitted: 0, lateSeen: 0, filtered: 0 };

  it('no job twice, every job that matched throughout exactly once, nothing foreign, keys ascending', async () => {
    const options = propertyOptions();
    await fc.assert(fc.asyncProperty(scenarios, async (scenario) => {
      const queue = createQueue();
      let fresh = 0;
      const unique = new Set<string>();
      for (const spec of scenario.initial) {
        const id = `k${String(spec.name).padStart(2, '0')}`;
        if (unique.has(id)) continue;
        unique.add(id);
        await queue.enqueue(id, spec.time);
      }
      const filter: JobFilter = scenario.status ? { status: scenario.status } : {};
      if (filter.status !== undefined) stats.filtered += 1;
      const walk = await interleavedWalk(queue, filter, scenario.limit, async (index, cursor, returnedSoFar) => {
        // Mutation stops after the listed rounds: a producer that adds a job behind every page would never let the walk end.
        const ops = scenario.between[index] ?? [];
        for (const step of ops) {
          if (step.kind === 'insert') {
            const acceptedAt = step.at === 'cursor' ? cursor.acceptedAt : step.at === 'earlier' ? 9 : 15;
            // Ids that sort below every k-id ('a...') or above ('z...'), made fresh so no id repeats.
            const id = `${step.side === 'below' ? 'a' : 'z'}${++fresh}`;
            await queue.enqueue(id, acceptedAt);
            if (step.at === 'cursor') {
              if (compareLiftJobPageKeys({ acceptedAt, jobId: id }, cursor) < 0) stats.tieBelow += 1;
              else stats.tieAbove += 1;
            }
          } else if (step.kind === 'claim') {
            await queue.claim();
          } else if (step.kind === 'clear') {
            await queue.clearFinalized();
          } else {
            const from = step.kind === 'validate' ? 'claimed' : step.kind === 'finalize' ? 'validated' : 'accepted';
            const candidates = await queue.idsIn(from);
            const target = candidates[step.pick % Math.max(candidates.length, 1)];
            if (target === undefined) continue;
            if (step.kind === 'validate') await queue.validate(target);
            else if (step.kind === 'finalize') await queue.finalize(target);
            else {
              if (returnedSoFar.includes(target)) stats.removedEmitted += 1;
              await queue.cancel(target);
            }
          }
        }
      });
      stats.walks += 1;
      stats.cases += 1;
      if (walk.pages > 1) stats.multiPage += 1;
      stats.lateSeen += walk.seen.filter((id) => /^[az]\d+$/.test(id)).length;
      await queue.store.close();
      opened.pop();
    }), options);
    // Positive controls: the mutations the plan names actually happened during walks.
    expect(stats.cases).toBe(options.numRuns);
    expect(stats.multiPage).toBeGreaterThan(options.numRuns / 2);
    expect(stats.tieBelow).toBeGreaterThan(0);        // inserted with acceptedAt = cursor and a lower job id
    expect(stats.tieAbove).toBeGreaterThan(0);        // ... and a higher one
    expect(stats.removedEmitted).toBeGreaterThan(0);  // a job removed after the walk passed it
    expect(stats.lateSeen).toBeGreaterThan(0);        // inserts ahead of the cursor were seen by the walk in progress
    expect(stats.filtered).toBeGreaterThan(0);
  }, 300_000);
});
