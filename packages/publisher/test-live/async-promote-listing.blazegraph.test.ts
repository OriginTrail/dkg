import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlazegraphNamespaceManager,
  BlazegraphStore,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import type { PromoteJob, PromoteListFilter } from '../src/async-promote-queue-types.js';
import { comparePromoteJobs, uniquenessLookupKeys } from '../src/async-promote-queue-utils.js';
import {
  LANES, SPELLINGS, STATES, expectedSweep, failedPopulation, population, respell, selectorPopulation, walkPages,
} from '../test/_helpers/share-listing-models.js';
import {
  ROW_NOW as NOW, deleteShareRow, keysetOrder, mulberry32, putShareRow, randomJobId, readEveryShareJob, seedShareRows, type ShareRowSpec,
} from '../test/_helpers/share-job-rows.js';

// OT-RFC-73 P8a / AC6 on a REAL Blazegraph (the in-memory twin is test/async-promote-listing-paging.test.ts: same helpers, same oracles). It needs a live
// endpoint and fails loudly without one:
//   docker run -d --name <name> -p 127.0.0.1:<port>:8080 "$(node -p "require('./blazegraph-image.json').image")"
//   BLAZEGRAPH_TEST_URL=http://127.0.0.1:<port>/bigdata/namespace/kb/sparql pnpm --filter @origintrail-official/dkg-publisher exec vitest run --config vitest.blazegraph.config.ts test-live/async-promote-listing.blazegraph.test.ts
// What only a real engine can show: that `ORDER BY ?job` and the string comparison of the cursor filter are the code point order the cursor is defined by
// (ties on the timestamp included), that a walk under interleaved writes is exact, and what a page costs as the retained history grows. The last prints
// `INFO page cost` lines; DKG_PROMOTE_LISTING_LIVE_HISTORY=0,10000,50000 reproduces the P8a discovery sizes (about 30 s to seed 50,000 jobs).

const HISTORIES = (process.env.DKG_PROMOTE_LISTING_LIVE_HISTORY ?? '0,2000').split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0);
const WALK_SEEDS = Number(process.env.DKG_PROMOTE_LISTING_LIVE_SEEDS ?? '6');
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
  const queueFor = (graphUri: string, listPageSize?: number) => new TripleStoreAsyncPromoteQueue(store, {
    graphUri, now: () => clock, backoff: () => 1_000, claimTokenGenerator: () => 't', idGenerator: () => `gen-${randomUUID()}`, ...(listPageSize ? { listPageSize } : {}),
  });

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
    const specs = population(450, mulberry32(5), { contexts: ['cg-a', 'cg-b'], tieGroup: 6 });
    for (let i = 0; i < specs.length; i += 150) await seedShareRows(store, specs.slice(i, i + 150), graph);
    const queue = queueFor(graph, 100);
    const all = await readEveryShareJob(store, graph);
    for (const filter of [{}, { state: ['queued'] }, { contextGraphId: 'cg-b', state: ['failed', 'succeeded'] }, { limit: 5 }] as PromoteListFilter[]) {
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

  it('page cost against the retained history (INFO page cost lines): the bound the discovery measured, through the product code', async () => {
    const median = async (run: () => Promise<unknown>, runs = 7) => {
      const times: number[] = [];
      for (let i = 0; i < runs + 1; i++) { const started = performance.now(); await run(); if (i > 0) times.push(performance.now() - started); }
      times.sort((a, b) => a - b);
      return { p50: Math.round(times[Math.floor(times.length / 2)]!), max: Math.round(times[times.length - 1]!) };
    };
    for (const history of HISTORIES) {
      const graph = graphOf(`cost${history}`);
      for (let at = 0; at < history; at += 500) {
        await seedShareRows(store, Array.from({ length: Math.min(500, history - at) }, (_, i) => ({ id: `hist-${at + i}`, state: 'succeeded' as const, enqueuedAt: NOW - 3_600_000 - (at + i) * 1_000, name: `hist-asset-${at + i}` })), graph);
      }
      const live: ShareRowSpec[] = [
        ...Array.from({ length: 20 }, (_, i): ShareRowSpec => ({ id: `act-q-${i}`, state: 'queued', enqueuedAt: NOW + i })),
        ...Array.from({ length: 6 }, (_, i): ShareRowSpec => ({ id: `act-f-${i}`, state: 'failed', enqueuedAt: NOW + 30 + i, lastError: { message: 'x', retryable: false, classification: 'fatal', recordedAt: NOW, diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE' }, attemptCount: 3, maxRetries: 3 })),
      ];
      await seedShareRows(store, live, graph);
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
});
