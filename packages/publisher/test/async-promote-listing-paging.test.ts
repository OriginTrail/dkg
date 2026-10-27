/**
 * Paged and aggregate reads of the share queue (OT-RFC-73 P8a, AC6). The keyset page behind the public listing and the post-commit
 * sweep, the complete listing served as key reads and payload batches, the COUNT statistics and the key-scoped lookup of the durable share path:
 *
 *   - static paging: every job exactly once, in `(enqueuedAt, jobId)` code point order, for every page size and filter;
 *   - interleaved mutations: a job inserted at the cursor's timestamp with a lower job id, a state change between pages, and a
 *     randomized model-based walk. No job is duplicated and every job that matched for the whole walk appears exactly once;
 *   - the queries: bounded, no OFFSET, payloads read for the page's rows only, values only through literal(), failing closed when
 *     a store returns rows in another order;
 *   - the complete listing: one ordered scan per key page and a mutex release between every key read and payload batch, a `limit` that
 *     stops early without changing which jobs it keeps (checked against the full sort, retry times before and after the enqueue
 *     times), the filter re-check after the payload read, and a record with two state triples;
 *   - COUNT statistics, the sweep and the selector lookup against independent oracles over generated populations.
 *
 * Characterization of the unchanged behavior is in async-promote-listing-characterization.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@origintrail-official/dkg-core';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PromoteListRequestError } from '../src/promote-list-cursor.js';
import {
  PromoteJobConflictError, type AsyncPromoteQueueConfig, type PromoteJob, type PromoteJobPage, type PromoteJobState, type PromoteListFilter,
} from '../src/async-promote-queue-types.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_STATE, comparePromoteJobs, jobSubject, serializeJobRecord, uniquenessLookupKeys } from '../src/async-promote-queue-utils.js';
import { isAutomaticallyRecoverablePostCommitFailure, promoteFailureTransition } from '../src/async-promote-recovery-policy.js';
import { POST_COMMIT_MARKERS } from '../src/promote-post-commit-sweep.js';
import { PROMOTE_POST_COMMIT_FAILURE_MESSAGE } from '../src/promote-replay-safety.js';
import {
  LANES, POST_COMMIT_ERRORS, SPELLINGS, STATES, expectedSweep, failedPopulation, population, respell, selectorPopulation, tiedContenders, walkPages,
} from './_helpers/share-listing-models.js';
import {
  ROW_AGENT, ROW_NOW as NOW, deleteShareRow, keysetOrder, mulberry32, putShareRow, randomJobId, readEveryShareJob, seedShareRows, seedUnreadableRow,
  shareRow, type ShareRowSpec,
} from './_helpers/share-job-rows.js';
import { tapStore, type TappedCall } from './_helpers/store-tap.js';

const ids = (jobs: readonly Pick<PromoteJob, 'jobId'>[]) => jobs.map((job) => job.jobId);
const stores: OxigraphStore[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const store of stores.splice(0)) await store.close(); });

function openStore(): OxigraphStore { const store = new OxigraphStore(); stores.push(store); return store; }

function queueOver(store: TripleStore, config: Partial<AsyncPromoteQueueConfig> = {}, clock = NOW) {
  let now = clock;
  const queue = new TripleStoreAsyncPromoteQueue(store, { now: () => now, claimTokenGenerator: () => 't', backoff: () => 1_000, idGenerator: () => `gen-${now}`, ...config });
  return { queue, setNow: (value: number) => { now = value; } };
}

async function seeded(specs: readonly ShareRowSpec[], config: Partial<AsyncPromoteQueueConfig> = {}) {
  const store = openStore();
  await seedShareRows(store, specs);
  return { store, ...queueOver(store, config) };
}

const walked = (pages: readonly PromoteJobPage[]) => pages.flatMap((page) => ids(page.jobs));

/** The listing reads of a call, in order: `keys`, `retry` (the retry-time read a `limit` makes before it stops), or `payloads:<subjects asked for>`. */
const listingReads = (calls: ReadonlyArray<{ method: string; source?: string; text?: string }>) => calls
  .filter((call) => call.method === 'query' && call.source?.startsWith('publisher.asyncPromote.list'))
  .map((call) => (call.source!.endsWith('.payloads')
    ? `payloads:${[...call.text!.matchAll(/<urn:dkg:promote-queue:job:[^>]+>/g)].length}`
    : call.text!.includes('ORDER BY') ? 'keys' : 'retry'));

describe('the keyset page, static', () => {
  it.each([1, 7, 100, 237, 1_000])('walks 237 jobs with tied timestamps and mixed-case ids once each, in (enqueuedAt, jobId) code point order, page size %i', async (pageSize) => {
    const { queue, store } = await seeded(population(237, mulberry32(11)));
    const expected = ids((await readEveryShareJob(store)).sort(keysetOrder));
    expect(expected).toHaveLength(237);
    const pages = await walkPages(queue, {}, pageSize);
    expect(walked(pages)).toEqual(expected);
    expect(new Set(walked(pages)).size).toBe(237);
    // Every page but the last is full and says so; the last is complete and carries no cursor.
    for (const page of pages.slice(0, -1)) { expect(page.jobs).toHaveLength(pageSize); expect(page.complete).toBe(false); }
    expect(pages.at(-1)!.complete).toBe(true);
    expect(pages.at(-1)!.nextCursor).toBeUndefined();
    expect(pages).toHaveLength(Math.max(1, Math.ceil(237 / pageSize)));
  });

  it('orders ties on the timestamp by code point, which is not the locale order of the complete listing', async () => {
    const { queue } = await seeded([
      { id: 'a-low', state: 'queued', enqueuedAt: NOW }, { id: 'B-up', state: 'queued', enqueuedAt: NOW },
      { id: 'job-10', state: 'queued', enqueuedAt: NOW }, { id: 'job-2', state: 'queued', enqueuedAt: NOW },
      { id: '9-first', state: 'queued', enqueuedAt: NOW }, { id: 'z-old', state: 'queued', enqueuedAt: NOW - 5 },
    ]);
    expect(walked(await walkPages(queue, {}, 4))).toEqual(['z-old', '9-first', 'B-up', 'a-low', 'job-10', 'job-2']);
    expect(ids(await queue.list())).toEqual(['z-old', '9-first', 'a-low', 'B-up', 'job-10', 'job-2']);
  });

  it('applies the state and the context graph filter, alone and together', async () => {
    const { queue, store } = await seeded(population(300, mulberry32(12), { contexts: ['cg-a', 'cg-b', 'cg-c'] }));
    const all = (await readEveryShareJob(store)).sort(keysetOrder);
    const cases: Array<Omit<PromoteListFilter, 'limit'>> = [
      { state: ['queued'] }, { state: ['running', 'failed_retrying'] }, { state: ['queued', 'queued'] }, { state: [] },
      { contextGraphId: 'cg-b' }, { contextGraphId: 'cg-c', state: ['succeeded', 'failed'] }, { contextGraphId: 'cg-none' },
    ];
    for (const filter of cases) {
      const expected = all.filter((job) => (!filter.state?.length || filter.state.includes(job.state)) && (!filter.contextGraphId || job.request.contextGraphId === filter.contextGraphId));
      for (const pageSize of [3, 50]) expect(walked(await walkPages(queue, filter, pageSize)), JSON.stringify(filter)).toEqual(ids(expected));
    }
  });

  it('answers an empty queue with one empty complete page', async () => {
    const { queue } = await seeded([]);
    expect(await queue.listPage()).toEqual({ jobs: [], complete: true });
    expect(await queue.listPage({ state: ['queued'] }, { pageSize: 1 })).toEqual({ jobs: [], complete: true });
  });

  it('does not follow a last full page with an empty one, and does continue after a page that happens to be full', async () => {
    const { queue } = await seeded(Array.from({ length: 6 }, (_, i) => ({ id: `j-${i}`, state: 'queued' as const, enqueuedAt: NOW + i })));
    const pages = await walkPages(queue, {}, 3);
    expect(pages.map((page) => page.jobs.length)).toEqual([3, 3]);
    expect(pages.map((page) => page.complete)).toEqual([false, true]);
    expect(walked(await walkPages(queue, {}, 5)).length).toBe(6);
  });

  it('returns the whole stored job and reads on from the position of a cursor whose job has since been removed', async () => {
    const { queue, store } = await seeded(Array.from({ length: 5 }, (_, i) => ({ id: `j-${i}`, state: 'queued' as const, enqueuedAt: NOW + i })));
    const first = await queue.listPage({}, { pageSize: 2 });
    expect(first.jobs[0]).toEqual(shareRow({ id: 'j-0', state: 'queued', enqueuedAt: NOW }));
    await deleteShareRow(store, 'j-1');
    expect(ids((await queue.listPage({}, { pageSize: 10, cursor: first.nextCursor })).jobs)).toEqual(['j-2', 'j-3', 'j-4']);
  });

  it('leaves out rows it cannot use without losing the rows after them or its place', async () => {
    const store = openStore();
    await seedShareRows(store, [
      { id: 'a', state: 'queued', enqueuedAt: NOW }, { id: 'odd-state', state: 'bogus' as PromoteJobState, enqueuedAt: NOW + 1 },
      { id: 'b', state: 'queued', enqueuedAt: NOW + 2 }, { id: 'c', state: 'queued', enqueuedAt: NOW + 4 },
    ]);
    await seedUnreadableRow(store, 'broken', 'queued');
    await store.insert([
      { subject: 'urn:foreign:thing', predicate: 'urn:dkg:promote-queue:state', object: '"queued"', graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI },
      { subject: 'urn:foreign:thing', predicate: 'urn:dkg:promote-queue:enqueuedAt', object: `"${NOW + 3}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI },
    ]);
    const { queue } = queueOver(store);
    for (const pageSize of [1, 2, 3, 10]) {
      const pages = await walkPages(queue, {}, pageSize).catch((error: unknown) => error);
      if (pages instanceof Error) {
        // A page made only of rows that are not share jobs has no place to continue from, and the walk says so instead of looping.
        expect(pageSize).toBe(1);
        expect(pages.message).toMatch(/held no share job to continue from/);
      } else expect(walked(pages as PromoteJobPage[]), `page size ${pageSize}`).toEqual(['a', 'b', 'c']);
    }
  });
});

describe('the request is checked before anything is read', () => {
  it('refuses a malformed cursor and a bad page size with the typed error, and makes no store call', async () => {
    const tapped = tapStore(openStore());
    const { queue } = queueOver(tapped.store);
    for (const request of [{ cursor: 'v1.nope' }, { cursor: '' }, { cursor: 'v2.x' }, { pageSize: 0 }, { pageSize: 1_001 }, { pageSize: 2.5 }]) {
      await expect(queue.listPage({}, request as never)).rejects.toMatchObject({ name: 'PromoteListRequestError' });
    }
    expect(tapped.calls).toEqual([]);
  });

  it('refuses a malformed cursor with the cursor code and a bad page size with the page-size code', async () => {
    const { queue } = await seeded([{ id: 'a', state: 'queued' }]);
    await expect(queue.listPage({}, { cursor: 'junk' })).rejects.toMatchObject({ code: 'PROMOTE_LIST_CURSOR_INVALID' });
    await expect(queue.listPage({}, { pageSize: 5_000 })).rejects.toMatchObject({ code: 'PROMOTE_LIST_PAGE_SIZE_INVALID' });
  });

  it('defaults a page to 100 jobs', async () => {
    const { queue } = await seeded(Array.from({ length: 130 }, (_, i) => ({ id: `j-${String(i).padStart(3, '0')}`, state: 'queued' as const, enqueuedAt: NOW + i })));
    const first = await queue.listPage();
    expect(first.jobs).toHaveLength(100);
    expect(first.complete).toBe(false);
    expect((await queue.listPage({}, { cursor: first.nextCursor })).jobs).toHaveLength(30);
  });
});

describe('the page queries', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ id: `j-${String(i).padStart(2, '0')}`, state: (i % 3 === 0 ? 'queued' : 'succeeded') as PromoteJobState, enqueuedAt: NOW + i }));

  it('reads the keys with LIMIT n + 1 and no OFFSET and no payload, then the payloads of the page\'s own rows by subject', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, rows);
    const { queue } = queueOver(tapped.store);
    await queue.listPage({ state: ['queued'] }, { pageSize: 4 });
    const queries = tapped.calls.filter((call) => call.method === 'query');
    expect(queries.map((call) => call.source)).toEqual(['publisher.asyncPromote.list', 'publisher.asyncPromote.list.payloads']);
    const [keys, payloads] = queries.map((call) => call.text!) as [string, string];
    expect(keys).toContain('LIMIT 5');
    expect(keys).toContain('ORDER BY ?enq ?job');
    expect(keys).toContain('VALUES ?state { "queued" }');
    expect(keys).not.toMatch(/OFFSET/i);
    expect(keys).not.toContain('payload');
    expect(keys).not.toContain('?payload');
    // Four subjects, not five: the extra key only says that more follow.
    expect([...payloads.matchAll(/<urn:dkg:promote-queue:job:[^>]+>/g)]).toHaveLength(4);
    expect(payloads).not.toMatch(/LIMIT|OFFSET/i);
    expect(queries.every((call) => call.options?.controlQueue === 'share')).toBe(true);
  });

  it('adds the cursor as a typed integer and a string literal, and reads no payload for an empty page', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, rows);
    const { queue } = queueOver(tapped.store);
    const first = await queue.listPage({}, { pageSize: 2 });
    tapped.calls.length = 0;
    await queue.listPage({}, { pageSize: 2, cursor: first.nextCursor });
    const keys = tapped.calls.find((call) => call.method === 'query')!.text!;
    expect(keys).toContain(`FILTER (?enq >= "${NOW + 1}"^^<http://www.w3.org/2001/XMLSchema#integer>)`);
    expect(keys).toContain('STR(?job) > "urn:dkg:promote-queue:job:j-01"');
    tapped.calls.length = 0;
    expect((await queue.listPage({ contextGraphId: 'cg-none' }, { pageSize: 2 })).jobs).toEqual([]);
    expect(tapped.calls.filter((call) => call.method === 'query')).toHaveLength(1);
  });

  it('puts every filter value through literal(), so a hostile value cannot leave its string', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, rows);
    const { queue } = queueOver(tapped.store);
    const hostile = 'cg"} } DROP GRAPH <urn:x> #';
    const page = await queue.listPage({ contextGraphId: hostile, state: ['queued", "x" } } #' as never] }, { pageSize: 3 });
    expect(page).toEqual({ jobs: [], complete: true });
    const keys = tapped.calls.find((call) => call.method === 'query')!.text!;
    expect(keys).toContain(JSON.stringify(hostile));
    expect(keys).toContain(JSON.stringify('queued", "x" } } #'));
    // Outside its string literals the query holds nothing of either value.
    const outsideLiterals = keys.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(outsideLiterals).not.toMatch(/DROP|[{}]\s*#/);
    expect(outsideLiterals).toContain('VALUES ?state { "" } ?job <urn:dkg:promote-queue:contextGraphId> "" . }');
    expect(await queue.list()).toHaveLength(30);
  });

  it('serves the complete listing as one key read and payload reads in batches of subjects, one hold each', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, rows.slice(0, 8));
    const { queue } = queueOver(tapped.store, { listPageSize: 3 });
    expect(await queue.list()).toHaveLength(8);
    // The ordered scan runs once; only the payloads are fetched in pieces (3 + 3 + 2).
    expect(listingReads(tapped.calls)).toEqual(['keys', 'payloads:3', 'payloads:3', 'payloads:2']);
    const keys = tapped.calls.find((call) => call.source === 'publisher.asyncPromote.list')!.text!;
    expect(keys).toContain('LIMIT 10001');
    expect(keys).not.toMatch(/OFFSET/i);
    expect(keys).not.toContain('?payload');
  });

  it('reads the keys in pages of at most listKeyPageSize, each page once, so the ordered scans number ceil(rows / key page) and not ceil(rows / batch)', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, rows.slice(0, 8));
    const { queue } = queueOver(tapped.store, { listPageSize: 3, listKeyPageSize: 5 });
    expect(await queue.list()).toHaveLength(8);
    // A batch never spans two key pages: the second key page's three rows are one batch.
    expect(listingReads(tapped.calls)).toEqual(['keys', 'payloads:3', 'payloads:2', 'keys', 'payloads:3']);
    const keyReads = tapped.calls.filter((call) => call.source === 'publisher.asyncPromote.list').map((call) => call.text!);
    expect(keyReads[0]).toContain('LIMIT 6');
    expect(keyReads[1]).toContain('LIMIT 6');
    expect(keyReads[1]).toContain('STR(?job) > "urn:dkg:promote-queue:job:j-04"');

    // At a larger scale: 600 rows read 20 payloads at a time and 300 keys at a time are 2 ordered scans, where the page loop made 30.
    const big = tapStore(openStore());
    await seedShareRows(big.store, Array.from({ length: 600 }, (_, i) => ({ id: `b-${String(i).padStart(3, '0')}`, state: 'succeeded' as const, enqueuedAt: NOW + i })));
    const bigQueue = queueOver(big.store, { listPageSize: 20, listKeyPageSize: 300 }).queue;
    expect(await bigQueue.list()).toHaveLength(600);
    const reads = listingReads(big.calls);
    expect(reads.filter((read) => read === 'keys')).toHaveLength(2);
    expect(reads.filter((read) => read.startsWith('payloads'))).toHaveLength(30);
  });

  it('fails closed when a store returns the keys in another order, or ignores the cursor, instead of skipping or repeating a job', async () => {
    const reverse = tapStore(openStore(), { after: (call, result) => (call.source === 'publisher.asyncPromote.list' && result.type === 'bindings' ? { ...result, bindings: [...result.bindings].reverse() } : result) });
    await seedShareRows(reverse.store, rows.slice(0, 6));
    await expect(queueOver(reverse.store).queue.listPage({}, { pageSize: 5 })).rejects.toThrow(/out of order/);

    let firstKeys: unknown;
    const stuck = tapStore(openStore(), { after: (call, result) => {
      if (call.source !== 'publisher.asyncPromote.list') return result;
      firstKeys ??= result;
      return firstKeys as typeof result;
    } });
    await seedShareRows(stuck.store, rows.slice(0, 6));
    const { queue } = queueOver(stuck.store);
    const first = await queue.listPage({}, { pageSize: 2 });
    await expect(queue.listPage({}, { pageSize: 2, cursor: first.nextCursor })).rejects.toThrow(/out of order or at\/before the cursor/);
  });
});

describe('a record with two state triples is listed once (corruption only; the queue never writes one)', () => {
  const specs: ShareRowSpec[] = [
    { id: 'a', state: 'queued', enqueuedAt: NOW }, { id: 'dup', state: 'queued', enqueuedAt: NOW + 1 },
    { id: 'c', state: 'running', enqueuedAt: NOW + 2 }, { id: 'd', state: 'queued', enqueuedAt: NOW + 3 }, { id: 'e', state: 'failed', enqueuedAt: NOW + 4 },
  ];
  async function withDuplicateState() {
    const fixture = await seeded(specs, { listPageSize: 2 });
    // The same job under a second state: the key read joins both triples and used to return the job's key twice.
    await fixture.store.insert([{ subject: jobSubject('dup'), predicate: PROMOTE_STATE, object: JSON.stringify('running'), graph: DEFAULT_PROMOTE_CONTROL_GRAPH_URI }]);
    return fixture;
  }

  it.each([1, 2, 3, 100])('walks every job once, the duplicated one included, at page size %i', async (pageSize) => {
    const { queue } = await withDuplicateState();
    expect(walked(await walkPages(queue, {}, pageSize))).toEqual(['a', 'dup', 'c', 'd', 'e']);
  });

  it('lists it once under a filter that matches both of its states, and by the state its payload says', async () => {
    const { queue } = await withDuplicateState();
    expect(walked(await walkPages(queue, { state: ['queued', 'running'] }, 2))).toEqual(['a', 'dup', 'c', 'd']);
    expect(walked(await walkPages(queue, { state: ['running'] }, 2))).toEqual(['c']); // 'dup' matches the key read as running; its payload says queued
    expect(walked(await walkPages(queue, { state: ['queued'] }, 2))).toEqual(['a', 'dup', 'd']);
  });

  it('serves the complete listing and the post-commit sweep over it', async () => {
    const { queue } = await withDuplicateState();
    expect(ids(await queue.list())).toEqual(['a', 'dup', 'c', 'd', 'e']);
    expect(ids(await queue.list({ limit: 3 }))).toEqual(['a', 'dup', 'c']);
    expect(await queue.recoverPostCommitFailures()).toEqual([]);
  });

  it('still fails closed on a genuine reordering, which is a different fault from a repeated key', async () => {
    const reorder = tapStore(openStore(), { after: (call, result) => {
      if (call.source !== 'publisher.asyncPromote.list' || result.type !== 'bindings' || result.bindings.length < 3) return result;
      const [first, second, ...rest] = result.bindings;
      return { ...result, bindings: [second!, first!, ...rest] };
    } });
    await seedShareRows(reorder.store, specs);
    await expect(queueOver(reorder.store).queue.listPage({}, { pageSize: 4 })).rejects.toThrow(/out of order or at\/before the cursor/);
  });
});

describe('interleaved mutations between pages (AC6)', () => {
  const at = (n: number) => NOW + n;

  it('does not return a job inserted at the cursor\'s timestamp with a lower job id, and returns one with a higher id once', async () => {
    const { queue, store } = await seeded([
      { id: 'm-1', state: 'queued', enqueuedAt: at(10) }, { id: 'm-2', state: 'queued', enqueuedAt: at(10) },
      { id: 'm-3', state: 'queued', enqueuedAt: at(10) }, { id: 'm-4', state: 'queued', enqueuedAt: at(20) },
    ]);
    const pages = await walkPages(queue, {}, 2, async (page, index) => {
      if (index !== 0) return;
      expect(ids(page.jobs)).toEqual(['m-1', 'm-2']); // the cursor is (at(10), m-2)
      await putShareRow(store, { id: 'm-0', state: 'queued', enqueuedAt: at(10) }); // lower id at the cursor's timestamp: behind the cursor
      await putShareRow(store, { id: 'A-low', state: 'queued', enqueuedAt: at(10) }); // code point order puts it before 'm-...' as well
      await putShareRow(store, { id: 'm-2b', state: 'queued', enqueuedAt: at(10) }); // higher id at the cursor's timestamp: ahead
      await putShareRow(store, { id: 'zz-early', state: 'queued', enqueuedAt: at(5) }); // earlier timestamp: behind
    });
    expect(walked(pages)).toEqual(['m-1', 'm-2', 'm-2b', 'm-3', 'm-4']);
    expect(await queue.list()).toHaveLength(8); // the rows behind the cursor exist; the walk had already passed their position
  });

  it('returns the jobs that matched for the whole walk once, whatever happens to the others between pages', async () => {
    const queued = (n: number): ShareRowSpec => ({ id: `q-${n}`, state: 'queued', enqueuedAt: at(n * 10) });
    const { queue, store } = await seeded([...[1, 2, 3, 4, 5, 6, 7, 8].map(queued), { id: 's-35', state: 'succeeded', enqueuedAt: at(35) }, { id: 's-95', state: 'succeeded', enqueuedAt: at(95) }]);
    const pages = await walkPages(queue, { state: ['queued'] }, 2, async (_page, index) => {
      if (index === 0) {
        await putShareRow(store, { id: 'q-1', state: 'running', enqueuedAt: at(10) }); // already returned, no longer matches
        await putShareRow(store, { id: 'q-4', state: 'running', enqueuedAt: at(40) }); // ahead, stops matching: may be missed
        await putShareRow(store, { id: 's-35', state: 'queued', enqueuedAt: at(35) }); // ahead, starts matching: appears once
        await putShareRow(store, { id: 's-95', state: 'queued', enqueuedAt: at(95) }); // ahead, starts matching: appears once
      }
      if (index === 1) await putShareRow(store, { id: 'q-6', state: 'failed', enqueuedAt: at(60) }); // ahead, stops matching
    });
    const seen = walked(pages);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(['q-1', 'q-2', 'q-3', 's-35', 'q-5', 'q-7', 'q-8', 's-95']);
    for (const stable of ['q-2', 'q-3', 'q-5', 'q-7', 'q-8']) expect(seen.filter((id) => id === stable)).toHaveLength(1);
    expect(pages.flatMap((page) => page.jobs).every((job) => job.state === 'queued')).toBe(true);
  });

  it('keeps returning the right rows when jobs are claimed through the queue between pages', async () => {
    const { queue } = await seeded(Array.from({ length: 6 }, (_, i) => ({ id: `w-${i}`, state: 'queued' as const, enqueuedAt: at(i), name: `asset-${i}` })));
    const pages = await walkPages(queue, { state: ['queued'] }, 2, async () => { await queue.claimNext('worker'); });
    // w-0 and w-1 are returned before they are claimed; each later claim takes the oldest queued job, which is ahead of the cursor
    // only until the walk reaches it, so the walk sees the jobs the claims left behind it, never one twice.
    const seen = walked(pages);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 2)).toEqual(['w-0', 'w-1']);
    expect(seen).toContain('w-5');
  });

  it.each(Array.from({ length: 40 }, (_, seed) => seed))('a randomized walk, seed %i: every page is what the model says, nothing repeats, the stable jobs all appear', async (seed) => {
    const rand = mulberry32(90_000 + seed);
    const store = openStore();
    const { queue } = queueOver(store);
    const model = new Map<string, ShareRowSpec>();
    const insert = async (spec: ShareRowSpec) => { model.set(spec.id, spec); await putShareRow(store, spec); };
    for (const spec of population(30 + Math.floor(rand() * 30), rand, { tieGroup: 1 + Math.floor(rand() * 6), contexts: ['cg-a', 'cg-b'] })) await insert(spec);
    const filters: Array<Omit<PromoteListFilter, 'limit'>> = [{}, { state: ['queued', 'running'] }, { contextGraphId: 'cg-a' }, { state: ['succeeded'], contextGraphId: 'cg-b' }];
    const filter = filters[seed % filters.length]!;
    const matches = (spec: ShareRowSpec) => (!filter.state?.length || filter.state.includes(spec.state)) && (!filter.contextGraphId || spec.contextGraphId === filter.contextGraphId);
    const pageSize = 1 + Math.floor(rand() * 9);
    const stable = new Set([...model.values()].filter(matches).map((spec) => spec.id));
    const seen: string[] = [];
    let cursorKey: { enqueuedAt: number; jobId: string } | undefined, cursor: string | undefined;
    for (let guard = 0; guard < 500; guard++) {
      const ahead = [...model.values()].filter(matches).map((spec) => ({ jobId: spec.id, enqueuedAt: spec.enqueuedAt! }))
        .filter((key) => !cursorKey || keysetOrder(key, cursorKey) > 0).sort(keysetOrder);
      const page = await queue.listPage(filter, { pageSize, ...(cursor ? { cursor } : {}) });
      expect(ids(page.jobs), `seed ${seed} page ${guard}`).toEqual(ahead.slice(0, pageSize).map((key) => key.jobId));
      expect(page.complete).toBe(ahead.length <= pageSize);
      seen.push(...ids(page.jobs));
      if (page.complete) break;
      cursor = page.nextCursor;
      cursorKey = { jobId: page.jobs.at(-1)!.jobId, enqueuedAt: page.jobs.at(-1)!.enqueuedAt };
      for (let k = Math.floor(rand() * 5); k > 0; k--) {
        const roll = rand(), existing = [...model.keys()];
        if (roll < 0.4 || existing.length === 0) {
          // A new job at, just before or just after the cursor's timestamp, or anywhere.
          const stamp = rand() < 0.7 ? cursorKey.enqueuedAt + Math.floor(rand() * 3) - 1 : NOW + Math.floor(rand() * 40);
          let id = randomJobId(rand);
          while (model.has(id)) id = randomJobId(rand);
          await insert({ id, state: STATES[Math.floor(rand() * STATES.length)]!, enqueuedAt: stamp, contextGraphId: rand() < 0.5 ? 'cg-a' : 'cg-b' });
        } else if (roll < 0.85) {
          const old = model.get(existing[Math.floor(rand() * existing.length)]!)!;
          await insert({ ...old, state: STATES[Math.floor(rand() * STATES.length)]! });
        } else {
          const id = existing[Math.floor(rand() * existing.length)]!;
          model.delete(id);
          await deleteShareRow(store, id);
        }
      }
      for (const id of stable) { const spec = model.get(id); if (!spec || !matches(spec)) stable.delete(id); } // deleting the visited entry of a Set is safe
    }
    expect(new Set(seen).size, `seed ${seed}: no job twice`).toBe(seen.length);
    for (const id of stable) expect(seen.filter((seenId) => seenId === id), `seed ${seed}: ${id} matched for the whole walk`).toHaveLength(1);
  });
});

describe('the complete listing releases the mutex between its key reads and its payload batches', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `q-${String(i).padStart(2, '0')}`, state: 'queued' as const, enqueuedAt: NOW + i * 10 }));

  it.each([
    ['the key read and the first payload batch', 'publisher.asyncPromote.list', ['keys', 'write', 'payloads']],
    ['two payload batches', 'publisher.asyncPromote.list.payloads', ['keys', 'payloads', 'write', 'payloads']],
  ])('lets another queue operation run between %s of a listing', async (_name, trigger, expected) => {
    let started = false;
    const tapped = tapStore(openStore(), { before: (call) => {
      if (call.source === trigger && !started) {
        started = true;
        void queue.enqueue({ contextGraphId: 'cg-rows', assertionName: 'newcomer', entities: 'all', agentAddress: ROW_AGENT });
      }
    } });
    await seedShareRows(tapped.store, rows);
    const { queue } = queueOver(tapped.store, { listPageSize: 4 });
    expect(await queue.list()).toHaveLength(10);
    const order = tapped.calls.flatMap((call) => {
      if (call.source === 'publisher.asyncPromote.list') return ['keys'];
      if (call.source === 'publisher.asyncPromote.list.payloads') return ['payloads'];
      return call.method === 'replaceSubject' ? ['write'] : [];
    });
    // The enqueue arrived during the listing's hold and ran before the listing's next hold: the mutex was not kept for the whole listing,
    // not between the key read and the payloads and not between two payload batches.
    expect(order.slice(0, expected.length)).toEqual(expected);
    expect(ids(await queue.list({ state: ['queued'] }))).toContain(`gen-${NOW}`);
  });

  /** A read of 10 queued jobs whose first payload batch is followed by writes from outside this process. */
  async function listingWithWritesAfterFirstBatch(config: Partial<AsyncPromoteQueueConfig>) {
    const raw = openStore();
    let payloadReads = 0;
    const tapped = tapStore(raw, { after: async (call, result) => {
      if (call.source === 'publisher.asyncPromote.list.payloads' && ++payloadReads === 1) {
        await putShareRow(raw, { id: 'ahead', state: 'queued', enqueuedAt: NOW + 75 }); // between q-07 and q-08: ahead of the cursor
        await putShareRow(raw, { id: 'behind', state: 'queued', enqueuedAt: NOW + 5 }); // behind the cursor: never returned
        await putShareRow(raw, { id: 'q-09', state: 'running', enqueuedAt: NOW + 90 }); // ahead, stops matching
        await putShareRow(raw, { id: 'q-00', state: 'running', enqueuedAt: NOW }); // already read as queued: stays in the result as read
      }
      return result;
    } });
    await seedShareRows(raw, rows);
    return queueOver(tapped.store, config).queue.list({ state: ['queued'] });
  }

  it('is not a snapshot: a job that arrives or changes ahead of the walk is seen as it is when its key page is read, a job behind it is not', async () => {
    const listing = await listingWithWritesAfterFirstBatch({ listPageSize: 4, listKeyPageSize: 4 });
    // The write after the first batch lands before the third key page is read: 'ahead' is in it, q-09 no longer matches, 'behind' is behind the cursor.
    expect(ids(listing)).toEqual(['q-00', 'q-01', 'q-02', 'q-03', 'q-04', 'q-05', 'q-06', 'q-07', 'ahead', 'q-08']);
    expect(listing.find((job) => job.jobId === 'q-00')!.state).toBe('queued');
    expect(new Set(ids(listing)).size).toBe(listing.length);
  });

  it('does not see a job that arrives inside a key page that was already read, and drops one whose payload no longer matches', async () => {
    const listing = await listingWithWritesAfterFirstBatch({ listPageSize: 4 }); // one key page for all ten
    // Every key was read before the writes: 'ahead' and 'behind' are not in it. q-09's payload is read after the write and no longer matches the filter.
    expect(ids(listing)).toEqual(['q-00', 'q-01', 'q-02', 'q-03', 'q-04', 'q-05', 'q-06', 'q-07', 'q-08']);
    expect(listing.find((job) => job.jobId === 'q-00')!.state).toBe('queued');
  });

  it('leaves out a job that stopped matching between the key read and the payload read of its page, and still continues after it', async () => {
    const raw = openStore();
    let keyReads = 0;
    const tapped = tapStore(raw, { after: async (call, result) => {
      if (call.source === 'publisher.asyncPromote.list' && ++keyReads === 1) await putShareRow(raw, { id: 'q-01', state: 'running', enqueuedAt: NOW + 10 }); // a writer outside this process
      return result;
    } });
    await seedShareRows(raw, rows);
    const { queue } = queueOver(tapped.store, { listPageSize: 4 });
    expect(ids(await queue.list({ state: ['queued'] }))).toEqual(['q-00', 'q-02', 'q-03', 'q-04', 'q-05', 'q-06', 'q-07', 'q-08', 'q-09']);
    keyReads = -1000;
    const page = await queue.listPage({ state: ['queued'] }, { pageSize: 2 });
    expect(page.jobs.every((job) => job.state === 'queued')).toBe(true);
  });

  it('leaves out a job whose context graph was rewritten between the key read and the payload read, in a page and in a complete listing', async () => {
    // The state re-check has its own test above; this one is the context graph's. The key read matched 'c-1' by the context graph triple it had then.
    const mine = Array.from({ length: 4 }, (_, i): ShareRowSpec => ({ id: `c-${i}`, state: 'queued', enqueuedAt: NOW + i, contextGraphId: 'cg-a' }));
    for (const read of ['page', 'complete'] as const) {
      const raw = openStore();
      let keyReads = 0;
      const tapped = tapStore(raw, { after: async (call, result) => {
        if (call.source === 'publisher.asyncPromote.list' && ++keyReads === 1) await putShareRow(raw, { id: 'c-1', state: 'queued', enqueuedAt: NOW + 1, contextGraphId: 'cg-b' }); // a writer outside this process
        return result;
      } });
      await seedShareRows(raw, mine);
      const { queue } = queueOver(tapped.store, { listPageSize: 2 });
      const jobs = read === 'page' ? (await queue.listPage({ contextGraphId: 'cg-a' }, { pageSize: 10 })).jobs : await queue.list({ contextGraphId: 'cg-a' });
      expect(ids(jobs), read).toEqual(['c-0', 'c-2', 'c-3']);
      expect(jobs.every((job) => job.request.contextGraphId === 'cg-a')).toBe(true);
    }
  });

  it('applies limit after the ready-time sort of the whole listing, whatever the page size', async () => {
    const specs: ShareRowSpec[] = [
      { id: 'retry', state: 'failed_retrying', enqueuedAt: NOW, nextRetryAt: NOW + 500 },
      ...Array.from({ length: 9 }, (_, i) => ({ id: `q-${i}`, state: 'queued' as const, enqueuedAt: NOW + 10 + i })),
    ];
    for (const listPageSize of [1, 2, 4, 1_000]) {
      const { queue } = await seeded(specs, { listPageSize });
      expect(ids(await queue.list({ limit: 3 }))).toEqual(['q-0', 'q-1', 'q-2']);
      expect(ids(await queue.list())).toEqual([...Array.from({ length: 9 }, (_, i) => `q-${i}`), 'retry']);
    }
  });

  it('matches a direct complete read of the same rows, in value and in order, for every filter and page size', async () => {
    const { store } = await seeded(population(200, mulberry32(31), { contexts: ['cg-a', 'cg-b'], tieGroup: 4 }));
    const all = await readEveryShareJob(store);
    const filters: PromoteListFilter[] = [{}, { state: ['queued'] }, { state: ['failed', 'succeeded'], contextGraphId: 'cg-a' }, { contextGraphId: 'cg-b', limit: 7 }, { limit: 1 }];
    for (const listPageSize of [1, 3, 64, 1_000]) {
      const { queue } = queueOver(store, { listPageSize });
      for (const filter of filters) {
        const expected = all.filter((job) => (!filter.state?.length || filter.state.includes(job.state)) && (!filter.contextGraphId || job.request.contextGraphId === filter.contextGraphId)).sort(comparePromoteJobs);
        expect(await queue.list(filter), `${listPageSize} ${JSON.stringify(filter)}`).toEqual(filter.limit ? expected.slice(0, filter.limit) : expected);
      }
    }
  });

  /** A queue over its own graph, so the warning's once-a-minute memory is not shared with another test. */
  async function warnFixture(count: number, graphName: string, clock = NOW) {
    const graphUri = `urn:test:warn:${graphName}`, store = openStore();
    await seedShareRows(store, Array.from({ length: count }, (_, i) => ({ id: `q-${i}`, state: 'queued' as const, enqueuedAt: NOW + i })), graphUri);
    return queueOver(store, { graphUri, listWarnRows: 10, listPageSize: 4 }, clock);
  }

  it('warns when a listing without a cursor reads more rows than the threshold, once a minute, and never at or below it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const exact = await warnFixture(10, 'exact');
    expect(await exact.queue.list()).toHaveLength(10);
    expect(warn).not.toHaveBeenCalled();
    const over = await warnFixture(11, 'over');
    expect(await over.queue.list()).toHaveLength(11);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toMatch(/async_promote_list_complete rows=11 threshold=10/);
    expect(String(warn.mock.calls[0]![1])).toMatch(/page it with a cursor/);
    await over.queue.list(); // the same minute: no second line
    expect(warn).toHaveBeenCalledTimes(1);
    await over.queue.listPage({}, { pageSize: 5 }); // a paged call is what the warning asks for and never warns
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns again a minute later', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { queue, setNow } = await warnFixture(11, 'again', 1_000_000);
    await queue.list();
    setNow(1_000_000 + 59_000);
    await queue.list();
    expect(warn).toHaveBeenCalledTimes(1);
    setNow(1_000_000 + 61_000);
    await queue.list();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('refuses a page size for the complete listing that the page query cannot take', () => {
    for (const listPageSize of [0, -1, 1_001, 2.5, Number.NaN]) {
      expect(() => new TripleStoreAsyncPromoteQueue(openStore(), { listPageSize })).toThrow(/listPageSize must be an integer from 1 to 1000/);
    }
  });

  it('refuses a warning threshold that is not a finite number of at least one, which would silence the warning or fire it on every listing', () => {
    for (const listWarnRows of [Number.NaN, 0, -1, 0.5, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, '5000' as never]) {
      expect(() => new TripleStoreAsyncPromoteQueue(openStore(), { listWarnRows }), String(listWarnRows)).toThrow(/listWarnRows must be a finite number of at least 1/);
    }
    for (const listWarnRows of [1, 10, 5_000, 1e9]) expect(() => new TripleStoreAsyncPromoteQueue(openStore(), { listWarnRows })).not.toThrow();
  });

  it('answers a stored row that cannot be put in a cursor with an internal error, not the client\'s typed request error', async () => {
    // A record the queue could not have written (a negative enqueue time): the page that ends on it cannot name its cursor. The caller did nothing wrong.
    const { queue } = await seeded([{ id: 'neg', state: 'queued', enqueuedAt: -5 }, { id: 'later', state: 'queued', enqueuedAt: NOW }]);
    const failure = await queue.listPage({}, { pageSize: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PromoteListRequestError);
    expect((failure as Error).message).toMatch(/cannot be encoded as a cursor/);
    // A page that does not end on it, and the complete listing (which never encodes a cursor), are unaffected.
    expect(ids((await queue.listPage({}, { pageSize: 2 })).jobs)).toEqual(['neg', 'later']);
    expect(ids(await queue.list())).toEqual(['neg', 'later']);
  });

  it('shows the admission coordinator the jobs of a page and only those', async () => {
    const { queue } = await seeded([
      { id: 'on-page', state: 'queued', enqueuedAt: NOW, name: 'first-asset' },
      { id: 'next-page', state: 'queued', enqueuedAt: NOW + 1, name: 'second-asset' },
    ]);
    await queue.listPage({}, { pageSize: 1 });
    const request = (assertionName: string) => ({ contextGraphId: 'cg-rows', assertionName, entities: 'all' as const, agentAddress: ROW_AGENT });
    const seen = await queue.enqueue(request('first-asset')).catch((error: unknown) => error);
    expect(seen).toBeInstanceOf(PromoteJobConflictError);
    expect(seen).toMatchObject({ existingJobId: 'on-page', observedAdmission: true });
    expect(await queue.enqueue(request('second-asset')).catch((error: unknown) => error)).toMatchObject({ existingJobId: 'next-page', observedAdmission: false });
  });
});

describe('limit ends a complete listing as soon as no unread job can rank among its first rows', () => {
  const pad = (n: number) => String(n).padStart(4, '0');
  const queuedRun = (count: number): ShareRowSpec[] => Array.from({ length: count }, (_, i) => ({ id: `q-${pad(i)}`, state: 'queued' as const, enqueuedAt: NOW + i }));

  it('reads one batch of limit payloads for the first rows of a long queue, and no payload of the rest', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, queuedRun(3_000));
    const { queue } = queueOver(tapped.store, { listPageSize: 100 });
    tapped.calls.length = 0;
    expect(ids(await queue.list({ limit: 5 }))).toEqual(['q-0000', 'q-0001', 'q-0002', 'q-0003', 'q-0004']);
    expect(listingReads(tapped.calls)).toEqual(['keys', 'payloads:5', 'retry']); // the retry times are read when that batch could end the walk, not before it
    tapped.calls.length = 0;
    expect(await queue.list()).toHaveLength(3_000);
    expect(listingReads(tapped.calls)).toEqual(['keys', ...Array.from({ length: 30 }, () => 'payloads:100')]); // no retry read without a limit
    expect(await queue.list({ limit: 0.5 })).toEqual([]);
  });

  it('keeps reading while a job that is ready later than the rows read so far sits among them, and stops once the rest are later', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, [...queuedRun(20), { id: 'later', state: 'failed_retrying', enqueuedAt: NOW + 2, nextRetryAt: NOW + 500 }]);
    const { queue } = queueOver(tapped.store, { listPageSize: 100 });
    tapped.calls.length = 0;
    // 'later' was enqueued early but is ready at +500, so the first three rows read (q-0, q-1, later) are not yet the three earliest to be ready.
    // The enqueue bound alone blocks the stop there, so no retry time is read at all.
    expect(ids(await queue.list({ limit: 3 }))).toEqual(['q-0000', 'q-0001', 'q-0002']);
    expect(listingReads(tapped.calls)).toEqual(['keys', 'payloads:3', 'payloads:18']);
  });

  it('does not stop before an unread job whose retry time is earlier than its enqueue time, which a walk in enqueue order cannot see coming', async () => {
    // a-x was enqueued at +1000 but is due at +1 (the clock stepped back between its enqueue and its failure): it ranks second, ahead of q-0001.
    const { queue } = await seeded([...queuedRun(20), { id: 'a-x', state: 'failed_retrying', enqueuedAt: NOW + 1_000, nextRetryAt: NOW + 1 }], { listPageSize: 100 });
    expect(ids(await queue.list({ limit: 3 }))).toEqual(['q-0000', 'a-x', 'q-0001']);
    expect(ids(await queue.list({ limit: 1 }))).toEqual(['q-0000']);
  });

  it.each(Array.from({ length: 20 }, (_, seed) => seed))('returns exactly the first limit jobs of the sorted complete listing, retry times before and after their enqueue times, seed %i', async (seed) => {
    const rand = mulberry32(31_000 + seed);
    const specs = population(60 + Math.floor(rand() * 140), rand, { tieGroup: 1 + Math.floor(rand() * 6), contexts: ['cg-a', 'cg-b'] })
      .map((spec): ShareRowSpec => (spec.state === 'failed_retrying' ? { ...spec, nextRetryAt: spec.enqueuedAt! + Math.floor(rand() * 90) - 30 } : spec));
    const store = openStore();
    await seedShareRows(store, specs);
    const all = await readEveryShareJob(store);
    const filters: Array<Omit<PromoteListFilter, 'limit'>> = [{}, { state: ['queued', 'failed_retrying'] }, { contextGraphId: 'cg-a' }, { state: ['failed_retrying'], contextGraphId: 'cg-b' }];
    // The smallest batches are the costliest to run, so they take the small limits, where the stop rule is decided within a few batches.
    for (const { config, limits } of [
      { config: { listPageSize: 1, listKeyPageSize: 3 }, limits: [1, 3] },
      { config: { listPageSize: 5, listKeyPageSize: 11 }, limits: [2, 7, 40] },
      { config: { listPageSize: 1_000 }, limits: [1, 500] },
    ]) {
      const { queue } = queueOver(store, config);
      for (const filter of filters) {
        const matching = all.filter((job) => (!filter.state?.length || filter.state.includes(job.state)) && (!filter.contextGraphId || job.request.contextGraphId === filter.contextGraphId)).sort(comparePromoteJobs);
        for (const limit of limits) {
          expect(await queue.list({ ...filter, limit }), `${JSON.stringify(config)} ${JSON.stringify(filter)} limit ${limit}`).toEqual(matching.slice(0, limit));
        }
      }
    }
  });

  describe('a retry time written while the walk runs', () => {
    // The stop rule rests on the retry times of the unread jobs. They change while a listing runs (a failing job gets one, a clock step
    // puts one before its job's enqueue time), so no stop may rest on a value read before the hold that decides it.
    const isKeyRead = (call: TappedCall) => call.source === 'publisher.asyncPromote.list' && call.text!.includes('ORDER BY');
    const isRetryRead = (call: TappedCall) => call.source === 'publisher.asyncPromote.list' && !call.text!.includes('ORDER BY');
    const isBatchRead = (call: TappedCall) => call.source === 'publisher.asyncPromote.list.payloads';
    const fullSort = async (store: TripleStore, limit: number) => (await readEveryShareJob(store)).sort(comparePromoteJobs).slice(0, limit);
    const q: ShareRowSpec = { id: 'q', state: 'queued', enqueuedAt: NOW + 100 };
    const x: ShareRowSpec = { id: 'x', state: 'failed_retrying', enqueuedAt: NOW + 1_000, nextRetryAt: NOW + 2_000 };

    /** A listing of `specs` where `write` runs, as a writer outside this process, at the point `at` picks out (once). */
    async function listingWithWrite(specs: readonly ShareRowSpec[], config: Partial<AsyncPromoteQueueConfig>, limit: number,
      at: { when: 'before' | 'after'; call: (call: TappedCall) => boolean; nth?: number }, write: (store: OxigraphStore) => Promise<void>) {
      const raw = openStore();
      let seen = 0, written = false;
      const hook = async (call: TappedCall) => {
        if (written || !at.call(call) || ++seen < (at.nth ?? 1)) return;
        written = true;
        await write(raw);
      };
      const tapped = tapStore(raw, { before: at.when === 'before' ? hook : undefined, after: at.when === 'after' ? async (call, result) => { await hook(call); return result; } : undefined });
      await seedShareRows(raw, specs);
      const { queue } = queueOver(tapped.store, config);
      tapped.calls.length = 0;
      const listing = await queue.list({ limit });
      expect(written, 'the write ran').toBe(true);
      return { listing, raw, reads: listingReads(tapped.calls) };
    }

    it.each([
      ['before its key read', 'before', isKeyRead],
      ['after its key read', 'after', isKeyRead],
      ['after its first payload batch', 'after', isBatchRead],
    ] as const)('returns an unread job whose retry time moves ahead of the rows read, written %s', async (_name, when, call) => {
      // x was due at +2000 and then at +50, ahead of q (+100). It is unread when the walk would stop at q.
      const { listing, raw } = await listingWithWrite([q, x], { listPageSize: 100 }, 1, { when, call },
        (store) => putShareRow(store, { ...x, nextRetryAt: NOW + 50 }));
      expect(ids(listing)).toEqual(['x']);
      expect(listing).toEqual(await fullSort(raw, 1));
    });

    it('returns the job that failed with a retry time before the rows read when the clock stepped back before its key read', async () => {
      // A is queued at +150000. B is running (enqueued at +200000); it fails with a clock stepped back, so its retry is due at +110000, ahead of A.
      const a: ShareRowSpec = { id: 'A', state: 'queued', enqueuedAt: NOW + 150_000 };
      const b: ShareRowSpec = { id: 'B', state: 'running', enqueuedAt: NOW + 200_000 };
      const { listing, raw } = await listingWithWrite([a, b], { listPageSize: 100 }, 1, { when: 'before', call: isKeyRead }, async (store) => {
        // Another process, whose clock is behind, records the failure: the transition the queue's own fail() writes.
        const failure = { message: 'store busy', retryable: true, classification: 'transient' as const, recordedAt: NOW + 109_000 };
        const { job } = promoteFailureTransition(shareRow(b), failure, NOW + 109_000, () => 1_000);
        await deleteShareRow(store, 'B');
        await store.insert(serializeJobRecord(job, DEFAULT_PROMOTE_CONTROL_GRAPH_URI).jobQuads);
      });
      expect((await readEveryShareJob(raw)).find((job) => job.jobId === 'B')).toMatchObject({ state: 'failed_retrying', attempt: { nextRetryAt: NOW + 110_000 } });
      expect(ids(listing)).toEqual(['B']);
      expect(listing).toEqual(await fullSort(raw, 1));
    });

    it('decides a later stop on retry times read in the hold that decides it, not on the ones that blocked an earlier stop', async () => {
      // q0 is due first. x1 (due at -5) blocks the first stop; x2, queued then, becomes due at -9 right after that decision, ahead of x1.
      const rows: ShareRowSpec[] = [
        { id: 'q0', state: 'queued', enqueuedAt: NOW }, { id: 'q1', state: 'queued', enqueuedAt: NOW + 1 },
        { id: 'x1', state: 'failed_retrying', enqueuedAt: NOW + 10, nextRetryAt: NOW - 5 }, { id: 'x2', state: 'queued', enqueuedAt: NOW + 20 },
      ];
      const { listing, raw } = await listingWithWrite(rows, { listPageSize: 1 }, 1, { when: 'after', call: isRetryRead },
        (store) => putShareRow(store, { id: 'x2', state: 'failed_retrying', enqueuedAt: NOW + 20, nextRetryAt: NOW - 9 }));
      expect(ids(listing)).toEqual(['x2']);
      expect(listing).toEqual(await fullSort(raw, 1));
    });

    it('reads the retry times when it is about to stop and not again while an unread one blocks the stop', async () => {
      const rows: ShareRowSpec[] = [...queuedRun(6), { id: 'x', state: 'failed_retrying', enqueuedAt: NOW + 100, nextRetryAt: NOW - 1 }];
      const tapped = tapStore(openStore());
      await seedShareRows(tapped.store, rows);
      const { queue } = queueOver(tapped.store, { listPageSize: 2 });
      tapped.calls.length = 0;
      expect(ids(await queue.list({ limit: 1 }))).toEqual(['x']);
      // One read of the retry times, at the first batch that could end the walk; the cached value blocks every later stop until x is read.
      expect(listingReads(tapped.calls)).toEqual(['keys', 'payloads:1', 'retry', 'payloads:2', 'payloads:2', 'payloads:2']);
    });

    it('ends the walk at the read that confirmed the bound: a retry time written after it comes after the walk', async () => {
      const { listing, reads, raw } = await listingWithWrite([q, x], { listPageSize: 100 }, 1, { when: 'after', call: isRetryRead },
        (store) => putShareRow(store, { ...x, nextRetryAt: NOW + 50 }));
      expect(ids(listing)).toEqual(['q']);
      expect(reads).toEqual(['keys', 'payloads:1', 'retry']);
      expect(ids(await fullSort(raw, 1))).toEqual(['x']); // the store has moved on; the listing, which finished before it did, has not
    });
  });
});

describe('getStats() is one COUNT ... GROUP BY ?state', () => {
  /** The statistics before P8a: every job parsed from its payload, counted by the state in it. */
  const oldStats = async (store: TripleStore) => {
    const stats = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<PromoteJobState, number>;
    for (const job of await readEveryShareJob(store)) stats[job.state] += 1;
    return stats;
  };

  it.each(Array.from({ length: 12 }, (_, seed) => seed))('counts exactly what the previous statistics counted, generated population %i', async (seed) => {
    const rand = mulberry32(5_000 + seed);
    const specs = population(seed === 0 ? 0 : 20 + Math.floor(rand() * 400), rand, { contexts: ['cg-a', 'cg-b', 'cg-c'] });
    const { queue, store } = await seeded(specs);
    await seedShareRows(store, [{ id: 'unknown-state', state: 'bogus' as PromoteJobState }]); // not counted before, not counted now
    expect(await queue.getStats()).toEqual(await oldStats(store));
    expect(await queue.getStats()).toEqual(Object.fromEntries(STATES.map((state) => [state, specs.filter((spec) => spec.state === state).length])));
  });

  it('is a single control read with no payload in it', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, population(50, mulberry32(3)));
    const { queue } = queueOver(tapped.store);
    tapped.calls.length = 0;
    await queue.getStats();
    const queries = tapped.calls.filter((call) => call.method === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.source).toBe('publisher.asyncPromote.stats');
    expect(queries[0]!.options?.controlQueue).toBe('share');
    expect(queries[0]!.text).toMatch(/COUNT\(\?job\)/);
    expect(queries[0]!.text).toMatch(/GROUP BY \?state/);
    expect(queries[0]!.text).not.toContain('payload');
  });

  it('counts a history of 20,000 jobs from the state triples alone', async () => {
    const store = openStore();
    const specs: ShareRowSpec[] = Array.from({ length: 20_000 }, (_, i) => ({ id: `h-${i}`, state: i % 10 === 0 ? 'failed' : 'succeeded', enqueuedAt: NOW + i }));
    for (let i = 0; i < specs.length; i += 2_000) await seedShareRows(store, specs.slice(i, i + 2_000));
    expect(await queueOver(store).queue.getStats()).toEqual({ queued: 0, running: 0, succeeded: 18_000, failed: 2_000, failed_retrying: 0 });
  }, 60_000);

  it('documented narrowing, corrupt rows only: a row is counted by its state triple, not by its payload', async () => {
    const store = openStore();
    await seedShareRows(store, [{ id: 'fine', state: 'queued' }]);
    await seedUnreadableRow(store, 'unreadable', 'failed'); // its payload cannot be decoded: the old statistics skipped it
    const { queue } = queueOver(store);
    expect(await queue.getStats()).toEqual({ queued: 1, running: 0, succeeded: 0, failed: 1, failed_retrying: 0 });
    expect(await oldStats(store)).toEqual({ queued: 1, running: 0, succeeded: 0, failed: 0, failed_retrying: 0 });
  });
});

describe('the post-commit sweep reads only its candidates and decides them as before', () => {
  const { code, other } = POST_COMMIT_ERRORS;

  it.each(Array.from({ length: 16 }, (_, seed) => seed))('produces the events and the final rows of the previous sweep, generated population %i', async (seed) => {
    const rand = mulberry32(7_000 + seed);
    const specs = failedPopulation(rand, seed % 4 === 0 ? 160 : 40 + Math.floor(rand() * 60)); // 160 spans several sweep pages
    const { queue, store, setNow } = await seeded(specs);
    const now = NOW + 123_456;
    setNow(now);
    const expected = expectedSweep(specs, now);
    expect(expected.events.length).toBeGreaterThan(0);
    expect(await queue.recoverPostCommitFailures()).toEqual(expected.events);
    const stored = new Map((await readEveryShareJob(store)).map((job) => [job.jobId, job]));
    for (const [id, job] of expected.finals) expect(stored.get(id), `seed ${seed} ${id}`).toEqual(JSON.parse(JSON.stringify(job)));
    expect(await queue.recoverPostCommitFailures()).toEqual([]); // nothing left to decide
  });

  it('has a pre-filter that no job the recovery policy accepts can fail: every such payload names the code or the message', () => {
    const rand = mulberry32(4_242);
    let accepted = 0;
    for (const spec of failedPopulation(rand, 2_000)) {
      const job = shareRow(spec);
      if (!isAutomaticallyRecoverablePostCommitFailure(job)) continue;
      accepted++;
      expect(POST_COMMIT_MARKERS.some((marker) => JSON.stringify(job).includes(marker)), spec.id).toBe(true);
    }
    expect(accepted).toBeGreaterThan(100);
    // A message JSON would escape is still matched through its escaped spelling.
    expect(POST_COMMIT_MARKERS).toContain(JSON.stringify(PROMOTE_POST_COMMIT_FAILURE_MESSAGE).slice(1, -1));
  });

  it('reads one page per fifty candidates and no failed job that names neither marker', async () => {
    const tapped = tapStore(openStore());
    const specs: ShareRowSpec[] = [];
    for (let i = 0; i < 130; i++) specs.push({ id: `pc-${String(i).padStart(3, '0')}`, state: 'failed', enqueuedAt: NOW + i, name: `a-${i}`, lastError: code, attemptCount: 1, maxRetries: 3 });
    for (let i = 0; i < 400; i++) specs.push({ id: `x-${i}`, state: i % 2 ? 'failed' : 'succeeded', enqueuedAt: NOW - 10_000 + i, lastError: other });
    await seedShareRows(tapped.store, specs);
    const { queue } = queueOver(tapped.store);
    tapped.calls.length = 0;
    expect(await queue.recoverPostCommitFailures()).toHaveLength(130);
    const reads = tapped.calls.filter((call) => call.source === 'publisher.asyncPromote.recoverPostCommit');
    expect(reads).toHaveLength(3); // 50 + 50 + 30
    expect(reads[0]!.text).toContain('LIMIT 51');
    expect(reads[0]!.text).toContain('VALUES ?state { "failed" }');
    expect(reads[0]!.text).toContain('CONTAINS(STR(?payload), "PROMOTE_POST_COMMIT_FAILURE")');
    expect(reads[0]!.text).not.toMatch(/OFFSET/i);
    expect(reads.every((call) => call.options?.controlQueue === 'share')).toBe(true);
    expect(tapped.calls.some((call) => call.source === 'publisher.asyncPromote.list')).toBe(false);
    // Its candidates are then decided 50 at a time, each in a hold of its own that reads the rows it is about to judge by subject.
    const decided = tapped.calls.filter((call) => call.source === 'publisher.asyncPromote.recoverPostCommit.payloads');
    expect(decided.map((call) => [...call.text!.matchAll(/<urn:dkg:promote-queue:job:[^>]+>/g)].length)).toEqual([50, 50, 30]);
    expect(decided.every((call) => call.options?.controlQueue === 'share')).toBe(true);
  });

  describe('decides its candidates in the queue\'s own order, ties included', () => {
    const failed = (id: string, at: number, over: Partial<ShareRowSpec> = {}): ShareRowSpec =>
      ({ id, state: 'failed', enqueuedAt: NOW + at, lastError: code, attemptCount: 1, maxRetries: 3, ...over });
    const sweepOf = async (specs: readonly ShareRowSpec[]) => {
      const { queue, store, setNow } = await seeded(specs);
      const now = NOW + 77_000;
      setNow(now);
      return { queue, store, now, expected: expectedSweep(specs, now) };
    };
    const storedAs = async (store: TripleStore, id: string) => (await readEveryShareJob(store)).find((job) => job.jobId === id)!;

    it('requeues the localeCompare-first of two tied jobs that share an assertion and defers the other, though code point order puts it second', async () => {
      // 'a' < 'B' by locale, 'B' < 'a' by code point: the order the previous sweep decided in (comparePromoteJobs) is what picks the winner.
      expect('a'.localeCompare('B')).toBeLessThan(0);
      const specs = [failed('B', 10, { name: 'asset' }), failed('a', 10, { name: 'asset' })];
      const { queue, store, now } = await sweepOf(specs);
      expect(await queue.recoverPostCommitFailures()).toEqual([{ jobId: 'a', action: 'requeued', attempt: 1, maxAttempts: 3, nextRetryAt: now + 1_000 }]);
      expect(await storedAs(store, 'a')).toMatchObject({ state: 'failed_retrying' });
      expect(await storedAs(store, 'B')).toEqual(shareRow(specs[0]!)); // deferred: untouched, left for a later sweep
    });

    it.each([0, 1, 2, 25, 49])('decides a block of 120 tied jobs exactly as the previous sweep did when %i earlier candidates put the first page boundary inside it', async (earlier) => {
      // 120 recoverable jobs at one enqueue time, three to an assertion, behind `earlier` jobs of their own: the page boundaries (every 50 candidates) cut through tied jobs and assertions.
      const specs = [...Array.from({ length: earlier }, (_, i) => failed(`early-${i}`, -1_000 + i, { name: `early-asset-${i}` })), ...tiedContenders(mulberry32(90 + earlier), 120)];
      const { queue, store, expected } = await sweepOf(specs);
      // Not vacuous: in some assertion the job the locale order picks is not the one code point order picks.
      const winner = (group: readonly ShareRowSpec[], order: (a: string, b: string) => number) => [...group].sort((x, y) => order(x.id, y.id))[0]!.id;
      const groups = new Map<string, ShareRowSpec[]>();
      for (const spec of specs.filter((spec) => spec.id.includes('-tie'))) groups.set(spec.name!, [...(groups.get(spec.name!) ?? []), spec]);
      const differing = [...groups.values()].filter((group) => winner(group, (a, b) => a.localeCompare(b)) !== winner(group, (a, b) => (a < b ? -1 : 1)));
      expect(differing.length).toBeGreaterThan(3);
      expect(expected.events).toHaveLength(earlier + 40);
      expect(await queue.recoverPostCommitFailures()).toEqual(expected.events);
      const stored = new Map((await readEveryShareJob(store)).map((job) => [job.jobId, job]));
      for (const [id, job] of expected.finals) expect(stored.get(id), id).toEqual(JSON.parse(JSON.stringify(job)));
    });

    it('orders a failed row that carries a retry time by that time, as the previous sweep did, not by its enqueue time', async () => {
      // The queue never leaves a retry time on a failed row, but the payload format allows it (an older release, a repaired record). X was enqueued first and is due at +1000; Y is due at +500.
      const specs = [failed('X', 1, { name: 'asset', nextRetryAt: NOW + 1_000 }), failed('Y', 500, { name: 'asset' })];
      const { queue, store, now, expected } = await sweepOf(specs);
      expect(expected.events.map((event) => event['jobId'])).toEqual(['Y']);
      expect(await queue.recoverPostCommitFailures()).toEqual([{ jobId: 'Y', action: 'requeued', attempt: 1, maxAttempts: 3, nextRetryAt: now + 1_000 }]);
      expect(await storedAs(store, 'X')).toEqual(shareRow(specs[0]!));
      expect(await storedAs(store, 'Y')).toMatchObject({ state: 'failed_retrying' });
    });

    it('judges a candidate on the row as it is when its turn comes: one that left the failed state since it was found is not touched', async () => {
      const raw = openStore();
      const operator = { ...failed('moved', 2, { name: 'asset-2' }), state: 'queued' as const, lastError: undefined };
      let moved = 0;
      const tapped = tapStore(raw, { before: async (call) => {
        if (call.source !== 'publisher.asyncPromote.recoverPostCommit.payloads') return;
        moved++;
        await putShareRow(raw, operator); // an operator recovered the job after the sweep found it
      } });
      await seedShareRows(tapped.store, [failed('stays', 1, { name: 'asset-1' }), failed('moved', 2, { name: 'asset-2' }), failed('last', 3, { name: 'asset-3' })]);
      const { queue, setNow } = queueOver(tapped.store);
      setNow(NOW + 5_000);
      expect((await queue.recoverPostCommitFailures()).map((event) => event.jobId)).toEqual(['stays', 'last']);
      expect(moved).toBeGreaterThan(0);
      expect(await storedAs(raw, 'moved')).toEqual(shareRow(operator));
    });
  });
});

describe('the key-scoped lookup of the durable share path', () => {
  it.each(Array.from({ length: 12 }, (_, seed) => seed))('returns every job the context-graph-wide listing filtered by the selector returns, and nothing outside the selector\'s keys, generated population %i', async (seed) => {
    const rand = mulberry32(2_000 + seed);
    const store = openStore();
    const specs = selectorPopulation(rand);
    await seedShareRows(store, specs);
    const storedKey = new Map<string, string>();
    for (const spec of specs) storedKey.set(spec.id, await respell(store, spec, SPELLINGS[Math.floor(rand() * SPELLINGS.length)]!));
    const { queue } = queueOver(store);
    const everything = await queue.list();
    expect(everything).toHaveLength(90);
    for (const lane of LANES) for (const name of ['alpha', 'beta']) for (const subGraphName of [undefined, 'sg']) {
      const selector = { contextGraphId: 'cg-rows', assertionName: name, agentAddress: lane, subGraphName };
      const exact = everything.filter((job) => job.request.contextGraphId === 'cg-rows' && job.request.assertionName === name
        && job.request.agentAddress === lane && job.request.subGraphName === subGraphName);
      const got = await queue.listForSelector(selector);
      expect(ids(got), `${name} ${lane} ${subGraphName}: in list order`).toEqual(ids([...got].sort(comparePromoteJobs)));
      const gotIds = new Set(ids(got));
      for (const job of exact) expect(gotIds.has(job.jobId), `${job.jobId} is missing`).toBe(true);
      // Nothing from outside the selector's own keys: every returned row is stored under one of the spellings the lookup names.
      const keys = new Set(uniquenessLookupKeys(selector));
      for (const job of got) expect(keys.has(storedKey.get(job.jobId)!), `${job.jobId} stored as ${JSON.stringify(storedKey.get(job.jobId))}`).toBe(true);
    }
  });

  it('reads the jobs of one selector in any state while the rest of the history stays unread', async () => {
    const tapped = tapStore(openStore());
    const specs: ShareRowSpec[] = [
      { id: 'mine-done', state: 'succeeded', name: 'mine', enqueuedAt: NOW }, { id: 'mine-failed', state: 'failed', name: 'mine', enqueuedAt: NOW + 1 },
      { id: 'mine-live', state: 'queued', name: 'mine', enqueuedAt: NOW + 2 },
      ...Array.from({ length: 300 }, (_, i) => ({ id: `other-${i}`, state: 'succeeded' as const, name: `other-${i}`, enqueuedAt: NOW - 1_000 + i })),
    ];
    await seedShareRows(tapped.store, specs);
    const { queue } = queueOver(tapped.store);
    tapped.calls.length = 0;
    const jobs = await queue.listForSelector({ contextGraphId: 'cg-rows', assertionName: 'mine', agentAddress: ROW_AGENT });
    expect(ids(jobs)).toEqual(['mine-done', 'mine-failed', 'mine-live']);
    const reads = tapped.calls.filter((call) => call.method === 'query');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.source).toBe('publisher.asyncPromote.selectorLookup');
    expect(reads[0]!.options?.controlQueue).toBe('share');
    expect(reads[0]!.text).toContain(JSON.stringify(uniquenessLookupKeys({ contextGraphId: 'cg-rows', assertionName: 'mine', agentAddress: ROW_AGENT })[0]));
    expect(reads[0]!.text).not.toMatch(/contextGraphId|OFFSET/);
    expect(reads[0]!.text).not.toContain('FILTER');
  });

  it('puts the selector values through literal(), returns a job reached through two key spellings once, and finds nothing for an unknown selector', async () => {
    const tapped = tapStore(openStore());
    await seedShareRows(tapped.store, [{ id: 'only', state: 'queued', name: 'asset' }]);
    const { queue } = queueOver(tapped.store);
    const hostile = { contextGraphId: 'cg"} } DROP', assertionName: 'a"> } #', agentAddress: ROW_AGENT };
    expect(await queue.listForSelector(hostile)).toEqual([]);
    expect(tapped.calls.at(-1)!.text).toContain(JSON.stringify(`${hostile.contextGraphId}\u001f\u001f${hostile.assertionName}\u001f${ROW_AGENT}`));
    // Store that gives two key spellings one term repeats the row; it is returned once.
    const doubling = tapStore(openStore(), { after: (call, result) => (call.source === 'publisher.asyncPromote.selectorLookup' && result.type === 'bindings' ? { ...result, bindings: [...result.bindings, ...result.bindings] } : result) });
    await seedShareRows(doubling.store, [{ id: 'twice', state: 'queued', name: 'asset' }]);
    expect(ids(await queueOver(doubling.store).queue.listForSelector({ contextGraphId: 'cg-rows', assertionName: 'asset', agentAddress: ROW_AGENT }))).toEqual(['twice']);
  });

  it('observes the jobs it returns, as every read of the queue does', async () => {
    const { queue } = await seeded([{ id: 'owner', state: 'queued', name: 'asset' }]);
    const selector = { contextGraphId: 'cg-rows', assertionName: 'asset', agentAddress: ROW_AGENT };
    await queue.listForSelector(selector);
    const rejection = await queue.enqueue({ ...selector, entities: 'all' }).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ existingJobId: 'owner', observedAdmission: true });
  });
});
