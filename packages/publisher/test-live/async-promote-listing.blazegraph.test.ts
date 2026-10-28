import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlazegraphNamespaceManager,
  BlazegraphStore,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import type { PromoteJob, PromoteListFilter } from '../src/async-promote-queue-types.js';
import { PROMOTE_STATE, comparePromoteJobs, jobSubject, uniquenessLookupKeys } from '../src/async-promote-queue-utils.js';
import {
  LANES, SPELLINGS, STATES, expectedSweep, failedPopulation, population, respell, selectorPopulation, tiedContenders, walkPages,
} from '../test/_helpers/share-listing-models.js';
import { tapStore } from '../test/_helpers/store-tap.js';
import {
  ROW_NOW as NOW, deleteShareRow, keysetOrder, mulberry32, putShareRow, randomJobId, readEveryShareJob, seedShareRows, type ShareRowSpec,
} from '../test/_helpers/share-job-rows.js';

// OT-RFC-73 P8a / AC6 on a REAL Blazegraph (the in-memory twin is test/async-promote-listing-paging.test.ts: same helpers, same oracles). It needs a live
// endpoint and fails loudly without one:
//   docker run -d --name <name> -p 127.0.0.1:<port>:8080 "$(node -p "require('./blazegraph-image.json').image")"
//   BLAZEGRAPH_TEST_URL=http://127.0.0.1:<port>/bigdata/namespace/kb/sparql pnpm --filter @origintrail-official/dkg-publisher exec vitest run --config vitest.blazegraph.config.ts test-live/async-promote-listing.blazegraph.test.ts
// What only a real engine can show: that `ORDER BY ?job` and the string comparison of the cursor filter are the code point order the cursor is defined by
// (ties on the timestamp included), that a walk under interleaved writes is exact, and what a page and a complete listing cost as the retained history
// grows. The last two print `INFO page cost` and `INFO complete listing` lines; DKG_PROMOTE_LISTING_LIVE_HISTORY=<size> reproduces the P8a discovery
// sizes (about 30 s to seed 50,000 jobs; run one size per namespace, as the scans filter a graph out of the shared indexes, so a larger history
// beside it inflates a smaller one) and DKG_PROMOTE_LISTING_LIVE_KEY_PAGE=<keys> changes the key page of the complete listing's cost lines.

const HISTORIES = (process.env.DKG_PROMOTE_LISTING_LIVE_HISTORY ?? '0,2000').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0);
const WALK_SEEDS = Number(process.env.DKG_PROMOTE_LISTING_LIVE_SEEDS ?? '6');
/** Keys per read of a complete listing, to compare sizes in the cost test (default: the queue's own). */
const LIST_KEY_PAGE = Number(process.env.DKG_PROMOTE_LISTING_LIVE_KEY_PAGE ?? '0');
const ids = (jobs: readonly Pick<PromoteJob, 'jobId'>[]) => jobs.map((job) => job.jobId);
const ACTIVE = ['queued', 'running', 'failed_retrying'] as const;

describe('share queue paging (live Blazegraph)', () => {
  const id = randomUUID();
  const namespace = `promote-listing-${id}`;
  const graphOf = (name: string) => `urn:test:promote-listing:${id}:${name}`;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  let store: BlazegraphStore;
  let clock = NOW;
  const queueFor = (graphUri: string, listPageSize?: number, listKeyPageSize?: number) => new TripleStoreAsyncPromoteQueue(store, {
    graphUri, now: () => clock, backoff: () => 1_000, claimTokenGenerator: () => 't', idGenerator: () => `gen-${randomUUID()}`,
    ...(listPageSize ? { listPageSize } : {}), ...(listKeyPageSize ? { listKeyPageSize } : {}),
  });

  /** `history` retained `succeeded` jobs, one second apart, plus the 26 live ones the cost tests read: 20 `queued` and 6 post-commit `failed`. */
  async function seedHistory(graph: string, history: number): Promise<void> {
    for (let at = 0; at < history; at += 500) {
      await seedShareRows(store, Array.from({ length: Math.min(500, history - at) }, (_, i) => ({ id: `hist-${at + i}`, state: 'succeeded' as const, enqueuedAt: NOW - 3_600_000 - (at + i) * 1_000, name: `hist-asset-${at + i}` })), graph);
    }
    const live: ShareRowSpec[] = [
      ...Array.from({ length: 20 }, (_, i): ShareRowSpec => ({ id: `act-q-${i}`, state: 'queued', enqueuedAt: NOW + i })),
      ...Array.from({ length: 6 }, (_, i): ShareRowSpec => ({ id: `act-f-${i}`, state: 'failed', enqueuedAt: NOW + 30 + i, lastError: { message: 'x', retryable: false, classification: 'fatal', recordedAt: NOW, diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE' }, attemptCount: 3, maxRetries: 3 })),
    ];
    await seedShareRows(store, live, graph);
  }

  beforeAll(async () => {
    const endpoint = process.env.BLAZEGRAPH_TEST_URL;
    if (!endpoint) throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    manager = new BlazegraphNamespaceManager({ namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint), requestTimeoutMs: 30_000 });
    expect(new URL(manager.sparqlUrl(namespace)).pathname).not.toBe(new URL(endpoint).pathname);
    handles = await manager.acquireMany([namespace]);
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 30_000 });
  }, 60_000);

  afterAll(async () => {
    try { await store?.close(); } finally { if (handles.length > 0) await manager.disposeAll(handles); }
  }, 60_000);

  it('walks 600 jobs of random mixed-case ids at tied and distinct timestamps in code point order, for every page size', async () => {
    const graph = graphOf('order');
    const specs = population(600, mulberry32(77), { tieGroup: 40, contexts: ['cg-a', 'cg-b'] });
    for (let i = 0; i < specs.length; i += 150) await seedShareRows(store, specs.slice(i, i + 150), graph);
    const queue = queueFor(graph);
    const expected = ids((await readEveryShareJob(store, graph)).sort(keysetOrder));
    expect(expected).toHaveLength(600);
    for (const pageSize of [1, 7, 100, 599, 600, 1_000]) {
      if (pageSize === 1 && process.env.DKG_PROMOTE_LISTING_LIVE_FULL !== '1') continue; // 600 round trips; the full set is opt-in
      const pages = await walkPages(queue, {}, pageSize);
      expect(pages.flatMap((page) => ids(page.jobs)), `page size ${pageSize}`).toEqual(expected);
    }
    const filtered = await walkPages(queue, { state: ['queued', 'running'], contextGraphId: 'cg-a' }, 13);
    expect(filtered.flatMap((page) => ids(page.jobs))).toEqual(ids((await readEveryShareJob(store, graph)).sort(keysetOrder)
      .filter((job) => ['queued', 'running'].includes(job.state) && job.request.contextGraphId === 'cg-a')));
  }, 300_000);

  it.each(Array.from({ length: WALK_SEEDS }, (_, seed) => seed))('a walk under interleaved writes is exactly what the model says, seed %i', async (seed) => {
    const rand = mulberry32(60_000 + seed);
    const graph = graphOf(`walk${seed}`);
    const queue = queueFor(graph);
    const model = new Map<string, ShareRowSpec>();
    const insert = async (spec: ShareRowSpec) => { model.set(spec.id, spec); await putShareRow(store, spec, graph); };
    for (const spec of population(40, rand, { tieGroup: 2 + (seed % 5), contexts: ['cg-a', 'cg-b'] })) await insert(spec);
    const filter: Omit<PromoteListFilter, 'limit'> = seed % 2 ? { state: ['queued', 'running', 'failed_retrying'] } : {};
    const matches = (spec: ShareRowSpec) => !filter.state?.length || filter.state.includes(spec.state);
    const stable = new Set([...model.values()].filter(matches).map((spec) => spec.id));
    const seen: string[] = [];
    let cursor: string | undefined, cursorKey: { enqueuedAt: number; jobId: string } | undefined;
    const pageSize = 3 + (seed % 4);
    for (let guard = 0; guard < 200; guard++) {
      const ahead = [...model.values()].filter(matches).map((spec) => ({ jobId: spec.id, enqueuedAt: spec.enqueuedAt! })).filter((key) => !cursorKey || keysetOrder(key, cursorKey) > 0).sort(keysetOrder);
      const page = await queue.listPage(filter, { pageSize, ...(cursor ? { cursor } : {}) });
      expect(ids(page.jobs), `seed ${seed} page ${guard}`).toEqual(ahead.slice(0, pageSize).map((key) => key.jobId));
      expect(page.complete).toBe(ahead.length <= pageSize);
      seen.push(...ids(page.jobs));
      if (page.complete) break;
      cursor = page.nextCursor;
      cursorKey = { jobId: page.jobs.at(-1)!.jobId, enqueuedAt: page.jobs.at(-1)!.enqueuedAt };
      for (let k = Math.floor(rand() * 4); k > 0; k--) {
        const roll = rand(), existing = [...model.keys()];
        if (roll < 0.4 || existing.length === 0) {
          let newId = randomJobId(rand);
          while (model.has(newId)) newId = randomJobId(rand);
          // At the cursor's own timestamp, so the tie-break on the job id is what decides which side of the cursor it lands on.
          await insert({ id: newId, state: STATES[Math.floor(rand() * STATES.length)]!, enqueuedAt: cursorKey.enqueuedAt + (rand() < 0.5 ? 0 : 1), contextGraphId: 'cg-a' });
        } else if (roll < 0.85) {
          const old = model.get(existing[Math.floor(rand() * existing.length)]!)!;
          await insert({ ...old, state: STATES[Math.floor(rand() * STATES.length)]! });
        } else {
          const victim = existing[Math.floor(rand() * existing.length)]!;
          model.delete(victim);
          await deleteShareRow(store, victim, graph);
        }
      }
      for (const stableId of stable) { const spec = model.get(stableId); if (!spec || !matches(spec)) stable.delete(stableId); }
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const stableId of stable) expect(seen.filter((seenId) => seenId === stableId), stableId).toHaveLength(1);
  }, 300_000);

  it('serves list, getStats, the post-commit sweep and the selector lookup as the previous complete reads did', async () => {
    // list and getStats
    const graph = graphOf('reads');
    // Retry times both after and before the enqueue time, so the ready-time order differs from the enqueue order the keys come in.
    const specs = population(450, mulberry32(5), { contexts: ['cg-a', 'cg-b'], tieGroup: 6 })
      .map((spec, i): ShareRowSpec => (spec.state === 'failed_retrying' ? { ...spec, nextRetryAt: spec.enqueuedAt! + (i % 7) * 5 - 12 } : spec));
    for (let i = 0; i < specs.length; i += 150) await seedShareRows(store, specs.slice(i, i + 150), graph);
    const queue = queueFor(graph, 100, 200); // 450 rows: three key reads of 200 and payload batches of 100
    const all = await readEveryShareJob(store, graph);
    for (const filter of [{}, { state: ['queued'] }, { contextGraphId: 'cg-b', state: ['failed', 'succeeded'] }, { limit: 5 }, { limit: 40 },
      { state: ['failed_retrying', 'queued'], limit: 12 }] as PromoteListFilter[]) {
      const expected = all.filter((job) => (!filter.state?.length || filter.state.includes(job.state)) && (!filter.contextGraphId || job.request.contextGraphId === filter.contextGraphId)).sort(comparePromoteJobs);
      expect(await queue.list(filter), JSON.stringify(filter)).toEqual(filter.limit ? expected.slice(0, filter.limit) : expected);
    }
    expect(await queue.getStats()).toEqual(Object.fromEntries(STATES.map((state) => [state, specs.filter((spec) => spec.state === state).length])));

    // the post-commit sweep
    const sweepGraph = graphOf('sweep');
    const sweepSpecs = failedPopulation(mulberry32(8), 130); // three sweep pages
    await seedShareRows(store, sweepSpecs, sweepGraph);
    const sweeper = queueFor(sweepGraph);
    clock = NOW + 123_456;
    const expectedRun = expectedSweep(sweepSpecs, clock);
    expect(expectedRun.events.length).toBeGreaterThan(10);
    expect(await sweeper.recoverPostCommitFailures()).toEqual(expectedRun.events);
    const stored = new Map((await readEveryShareJob(store, sweepGraph)).map((job) => [job.jobId, job]));
    for (const [jobId, job] of expectedRun.finals) expect(stored.get(jobId), jobId).toEqual(JSON.parse(JSON.stringify(job)));
    // 120 contenders at one enqueue time, three to an assertion: the pages (50) cut through tied jobs, and the previous sweep's order (localeCompare) picks each winner.
    const tiedGraph = graphOf('sweep-ties');
    const tiedSpecs = tiedContenders(mulberry32(9), 120);
    await seedShareRows(store, tiedSpecs, tiedGraph);
    const expectedTied = expectedSweep(tiedSpecs, clock);
    expect(expectedTied.events).toHaveLength(40);
    expect(await queueFor(tiedGraph).recoverPostCommitFailures()).toEqual(expectedTied.events);
    const storedTied = new Map((await readEveryShareJob(store, tiedGraph)).map((job) => [job.jobId, job]));
    for (const [jobId, job] of expectedTied.finals) expect(storedTied.get(jobId), jobId).toEqual(JSON.parse(JSON.stringify(job)));
    clock = NOW;

    // the selector lookup, over every spelling an older version wrote the key in
    const selectorGraph = graphOf('selector');
    const rand = mulberry32(21);
    const selectorSpecs = selectorPopulation(rand);
    await seedShareRows(store, selectorSpecs, selectorGraph);
    const storedKey = new Map<string, string>();
    for (const spec of selectorSpecs) storedKey.set(spec.id, await respell(store, spec, SPELLINGS[Math.floor(rand() * SPELLINGS.length)]!, selectorGraph));
    const looker = queueFor(selectorGraph);
    const everything = await looker.list();
    for (const lane of LANES) for (const name of ['alpha', 'beta']) {
      const selector = { contextGraphId: 'cg-rows', assertionName: name, agentAddress: lane };
      const got = await looker.listForSelector(selector);
      const gotIds = new Set(ids(got));
      for (const job of everything.filter((j) => j.request.contextGraphId === 'cg-rows' && j.request.assertionName === name && j.request.agentAddress === lane && j.request.subGraphName === undefined)) {
        expect(gotIds.has(job.jobId), `${job.jobId} missing for ${name} ${lane}`).toBe(true);
      }
      const keys = new Set(uniquenessLookupKeys(selector));
      for (const job of got) expect(keys.has(storedKey.get(job.jobId)!)).toBe(true);
      expect(ids(got)).toEqual(ids([...got].sort(comparePromoteJobs)));
    }
  }, 300_000);

  it('lists a record with a second state triple once: SELECT DISTINCT with ORDER BY and LIMIT on a real engine', async () => {
    const graph = graphOf('duplicate-state');
    await seedShareRows(store, Array.from({ length: 7 }, (_, i): ShareRowSpec => ({ id: `d-${i}`, state: 'queued', enqueuedAt: NOW + i })), graph);
    await store.insert([{ subject: jobSubject('d-3'), predicate: PROMOTE_STATE, object: JSON.stringify('running'), graph }]);
    const queue = queueFor(graph, 2, 3);
    for (const pageSize of [1, 2, 3, 100]) {
      expect((await walkPages(queue, {}, pageSize)).flatMap((page) => ids(page.jobs)), `page size ${pageSize}`).toEqual(['d-0', 'd-1', 'd-2', 'd-3', 'd-4', 'd-5', 'd-6']);
    }
    expect(ids(await queue.list())).toEqual(['d-0', 'd-1', 'd-2', 'd-3', 'd-4', 'd-5', 'd-6']);
    expect(ids(await queue.list({ state: ['queued', 'running'], limit: 5 }))).toEqual(['d-0', 'd-1', 'd-2', 'd-3', 'd-4']);
  }, 120_000);

  it('page cost against the retained history (INFO page cost lines): the bound the discovery measured, through the product code', async () => {
    const median = async (run: () => Promise<unknown>, runs = 7) => {
      const times: number[] = [];
      for (let i = 0; i < runs + 1; i++) { const started = performance.now(); await run(); if (i > 0) times.push(performance.now() - started); }
      times.sort((a, b) => a - b);
      return { p50: Math.round(times[Math.floor(times.length / 2)]!), max: Math.round(times[times.length - 1]!) };
    };
    for (const history of HISTORIES) {
      const graph = graphOf(`cost${history}`);
      await seedHistory(graph, history);
      const queue = queueFor(graph);
      const rows: string[] = [];
      for (const [label, filter, pageSize] of [
        ['broad filter, 100 per page', {}, 100], ['broad filter, 1000 per page', {}, 1_000], ['state succeeded, 100 per page', { state: ['succeeded'] }, 100],
        ['live states, 100 per page', { state: [...ACTIVE] }, 100],
      ] as const) {
        const first = await queue.listPage(filter, { pageSize });
        const t = await median(() => queue.listPage(filter, { pageSize }));
        const deep = first.nextCursor ? await median(() => queue.listPage(filter, { pageSize, cursor: first.nextCursor })) : undefined;
        rows.push(`${label}: first ${t.p50} ms (max ${t.max})${deep ? `, second ${deep.p50} ms` : ''}`);
      }
      const stats = await median(() => queue.getStats());
      const sweep = await median(() => queueFor(graph).recoverPostCommitFailures(), 3);
      const complete = history <= 10_000 ? await median(() => queueFor(graph).list({ state: [...ACTIVE] }), 3) : undefined;
      console.log(`INFO  page cost at ${history} retained jobs + 26 live (median of 7; Blazegraph via the product's store adapter, parse and mutex included): ${rows.join(' ;; ')} ;; getStats ${stats.p50} ms ;; sweep (26 failed, 6 candidates) ${sweep.p50} ms${complete ? ` ;; list(live states) ${complete.p50} ms` : ''}`);
      expect((await queue.getStats()).succeeded).toBe(history);
    }
  }, 1_800_000);
  it('complete listing cost against the retained history (INFO complete listing lines): total time and the longest wait of a queue operation that arrives meanwhile', async () => {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    for (const history of HISTORIES) {
      const graph = graphOf(`complete${history}`);
      await seedHistory(graph, history);
      const queue = queueFor(graph);
      // A job-status read takes the same mutex as an admission, a claim and a heartbeat, so its latency while a listing runs is how long that listing keeps them waiting.
      const idle: number[] = [];
      for (let i = 0; i < 9; i++) { const started = performance.now(); await queue.getStatus('probe'); idle.push(performance.now() - started); }
      const lines: string[] = [];
      for (const [label, filter] of [['complete listing', {}], ['limit 10', { limit: 10 }], ['live states', { state: [...ACTIVE] }]] as Array<[string, PromoteListFilter]>) {
        const totals: number[] = [];
        let longestWait = 0, queries = 0, slowestQuery = 0, rows = 0;
        for (let run = 0; run < 4; run++) { // the first run is a warm-up
          const starts = new Map<number, number>();
          const tapped = tapStore(store, {
            before: (call) => { starts.set(call.index, performance.now()); },
            after: (call, result) => { if (run > 0) slowestQuery = Math.max(slowestQuery, performance.now() - starts.get(call.index)!); return result; },
          });
          const listing = new TripleStoreAsyncPromoteQueue(tapped.store, { graphUri: graph, now: () => clock, backoff: () => 1_000, claimTokenGenerator: () => 't', idGenerator: () => `gen-${randomUUID()}`, ...(LIST_KEY_PAGE ? { listKeyPageSize: LIST_KEY_PAGE } : {}) });
          let running = true;
          const waits: number[] = [];
          const probe = (async () => { while (running) { const started = performance.now(); await listing.getStatus('probe'); waits.push(performance.now() - started); await sleep(1); } })();
          const started = performance.now();
          rows = (await listing.list(filter)).length;
          const total = performance.now() - started;
          running = false;
          await probe;
          if (run > 0) {
            totals.push(total);
            longestWait = Math.max(longestWait, ...waits);
            queries += tapped.calls.filter((call) => call.method === 'query' && call.source?.startsWith('publisher.asyncPromote.list')).length;
          }
        }
        lines.push(`${label}: ${rows} rows, total median ${Math.round(median(totals))} ms, longest wait of a concurrent status read ${Math.round(longestWait)} ms, ${Math.round(queries / 3)} listing queries per call, slowest single query ${Math.round(slowestQuery)} ms`);
      }
      console.log(`INFO  complete listing at ${history} retained jobs + 26 live (median of 3 runs; idle status read ${Math.round(median(idle))} ms): ${lines.join(' ;; ')}`);
      expect((await queue.list({ state: ['succeeded'] })).length).toBe(history);
    }
  }, 1_800_000);
});
