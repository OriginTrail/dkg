import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlazegraphNamespaceManager,
  BlazegraphStore,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
} from '@origintrail-official/dkg-storage';
import { buildPromoteOwnershipCandidateQuery, promoteOwnershipLookup, readPromoteOwnershipCandidates } from '../src/async-promote-ownership.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PromoteJobConflictError } from '../src/async-promote-queue-types.js';
import { expectBindings } from '../src/async-promote-queue-utils.js';
import { AG, CONFLICT_READ_OPTIONS, decisive, differentialCase, ids, job, probeUnitSeparatorCollapse, put, referenceCandidates, req, rng, type DifferentialCase } from '../test/_helpers/promote-lookup-differential.js';

// OT-RFC-73 P6 / AC4: the decision-identity differential of the bounded share conflict lookup on a REAL Blazegraph (the in-memory twin is
// test/async-promote-bounded-lookup.property.test.ts, same generator and same oracle). It needs a live endpoint and fails loudly without one:
//   docker run -d --name <name> -p 127.0.0.1:<port>:8080 "$(node -p "require('./blazegraph-image.json').image")"
//   BLAZEGRAPH_TEST_URL=http://127.0.0.1:<port>/bigdata/namespace/kb/sparql pnpm --filter @origintrail-official/dkg-publisher exec vitest run --config vitest.blazegraph.config.ts test-live/async-promote-bounded-lookup.blazegraph.test.ts
// Positive control: the duplicate-row hazard the lookup's payload de-duplication exists for appears only on an engine that gives the legacy key and the default-lane key
// (they differ by a trailing U+001F) ONE stored term. Whether an image does is a property of that image, so the run reports it, and
// BLAZEGRAPH_REQUIRE_U001F_COLLAPSE=1 turns "the engine reproduces the duplication" into a requirement (use it on the image that is meant to prove the de-duplication;
// the in-memory collapsing engine of the unit and property tests proves the code path on every run).
// CI (tornado-blazegraph) runs this file twice: on the lyrasis/blazegraph service container, where it only REPORTS the `INFO  U+001F ...` line (that engine's behaviour was not
// measured when the lane was added, so its first run tells), and on the blazegraph-image.json image through `docker run` with BLAZEGRAPH_REQUIRE_U001F_COLLAPSE=1.
// That image is the engine the node setup provisions and the one that reproduces the duplication (46 of 150 stores repeated rows in the recorded run); a bump of it to an engine
// that stops identifying the pair fails the second run instead of letting the real-engine G1 pass without exercising the payload de-duplication.

const CASES = Number(process.env.DKG_PROMOTE_LOOKUP_LIVE_CASES ?? '150');
const SEED_BASE = 20_261_950;
// retained-history sizes of the distinct-key timing (ascending, multiples of 500); raise them to see the previous query's growth, e.g. 1000,10000,20000
const HISTORIES = (process.env.DKG_PROMOTE_LOOKUP_LIVE_HISTORY ?? '1000,3000').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0 && n % 500 === 0);
const requireCollapse = process.env.BLAZEGRAPH_REQUIRE_U001F_COLLAPSE === '1';
const SOURCE = { source: 'publisher.asyncPromote.findActiveConflict' };

describe('bounded promote conflict lookup (live Blazegraph)', () => {
  const id = randomUUID();
  const namespace = `promote-lookup-${id}`;
  const graphOf = (name: string) => `urn:test:promote-lookup:${id}:${name}`;
  let manager: BlazegraphNamespaceManager;
  let handles: Awaited<ReturnType<BlazegraphNamespaceManager['acquireMany']>> = [];
  let store: BlazegraphStore;
  const g1 = { cases: 0, conflicts: 0, wildcard: 0, multi: 0, repeatedRows: 0, storesWithRepeats: 0 };
  let probe: Awaited<ReturnType<typeof probeUnitSeparatorCollapse>> | undefined;

  beforeAll(async () => {
    const endpoint = process.env.BLAZEGRAPH_TEST_URL;
    if (!endpoint) throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    manager = new BlazegraphNamespaceManager({
      namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint),
      requestTimeoutMs: 30_000,
    });
    // An own namespace: the queue's control graph IRI is fixed in production, so setup and teardown must not share a namespace with anything else.
    expect(new URL(manager.sparqlUrl(namespace)).pathname).not.toBe(new URL(endpoint).pathname);
    handles = await manager.acquireMany([namespace]);
    store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 30_000 });
  }, 60_000);

  afterAll(async () => {
    try { await store?.close(); } finally { if (handles.length > 0) await manager.disposeAll(handles); }
  }, 60_000);

  it(`G1: the conflict decision and the candidate id multisets are identical to the previous lookup on ${CASES} randomised stores`, async () => {
    for (let c = 0; c < CASES; c++) {
      const seen: DifferentialCase = await differentialCase(store, graphOf(`eq${c}`), rng(SEED_BASE * 31 + c));
      g1.cases++; g1.conflicts += seen.conflicts; g1.wildcard += seen.wildcard; g1.multi += seen.multi; g1.repeatedRows += seen.repeatedRows;
      if (seen.repeatedRows > 0) g1.storesWithRepeats++;
    }
    console.log(`INFO  G1 live Blazegraph: ${g1.cases} stores, ${g1.conflicts} with a conflict, ${g1.wildcard} legacy wildcard lookups, ${g1.multi} multi-match; the engine repeated rows of the bounded query in ${g1.storesWithRepeats} stores (${g1.repeatedRows} surplus rows before the product's de-duplication)`);
    expect(g1.cases).toBe(CASES);
    if (CASES >= 100) expect(g1.conflicts).toBeGreaterThanOrEqual(Math.floor(CASES * 0.1));
    if (CASES >= 100) expect(g1.wildcard).toBeGreaterThanOrEqual(Math.floor(CASES * 0.2));              // the legacy wildcard-lane query is reached on the real engine too
  }, 600_000);

  it('U+001F positive control: a direct probe of the legacy / default-lane key pair, consistent with the repeats G1 observed', async () => {
    probe = await probeUnitSeparatorCollapse(store, graphOf('probe'));
    console.log(`INFO  U+001F ${probe.collapses ? 'COLLAPSES' : 'does not collapse'} on this engine: the legacy key matches ${probe.legacyMatches} job(s), the default-lane key (legacy + U+001F) matches ${probe.defaultLaneMatches}; `
      + `G1 repeated rows in ${g1.storesWithRepeats} of ${g1.cases} stores -> the duplication ${g1.storesWithRepeats > 0 ? 'REPRODUCED' : 'did NOT reproduce'}`);
    expect(probe.legacyMatches).toBe(1);
    if (g1.cases > 0) expect(probe.collapses).toBe(g1.storesWithRepeats > 0);              // the engine either identifies the pair (and repeats rows) or it does not (and cannot)
    if (requireCollapse) {
      const missing = 'BLAZEGRAPH_REQUIRE_U001F_COLLAPSE=1, but this engine does not reproduce the duplicate rows: the real-engine G1 would pass without ever exercising the payload de-duplication';
      expect(probe.collapses, missing).toBe(true);
      expect(g1.storesWithRepeats, missing).toBeGreaterThan(0);
    }
  }, 60_000);

  it('G2b hot key: N finished jobs under ONE key + one live job: the bounded query returns the live row only, the previous one every row, and the decision is the same', async () => {
    const timings: string[] = [];
    for (const finished of [500, 2_000]) {
      const graph = graphOf(`hot${finished}`);
      for (let at = 0; at < finished; at += 500) {
        await put(store, graph, ...Array.from({ length: Math.min(500, finished - at) }, (_, i) => job(`hot-${at + i}`, 'succeeded')));
      }
      await put(store, graph, job('hot-live', 'queued'));
      const lookup = promoteOwnershipLookup(req());
      const reference = await referenceCandidates(store, graph, lookup);
      const bounded = await readPromoteOwnershipCandidates(store, graph, lookup, CONFLICT_READ_OPTIONS);
      const raw = expectBindings(await store.query(buildPromoteOwnershipCandidateQuery(graph, lookup), SOURCE));
      expect(reference).toHaveLength(finished + 1);
      expect(raw).toHaveLength(1);
      expect(ids(bounded)).toEqual(['hot-live']);
      expect(ids(bounded.filter(decisive))).toEqual(ids(reference.filter(decisive)));
      const median = async (run: () => Promise<unknown>) => { const t: number[] = []; for (let i = 0; i < 3; i++) { const s = performance.now(); await run(); t.push(performance.now() - s); } return Math.round(t.sort((a, b) => a - b)[1]!); };
      timings.push(`${finished} rows under the key: previous ${await median(() => referenceCandidates(store, graph, lookup))} ms | bounded ${await median(() => readPromoteOwnershipCandidates(store, graph, lookup, CONFLICT_READ_OPTIONS))} ms`);
    }
    console.log(`INFO  G2b hot key, median of 3 (query + JS decode): ${timings.join(' ;; ')}`);
  }, 300_000);

  it('a fresh key beside retained history reads no row; the queue admits it, refuses the live selector and admits it again once the job succeeded', async () => {
    const graph = graphOf('queue');
    const fresh = promoteOwnershipLookup(req({ assertionName: 'fresh' }));
    const median = async (run: () => Promise<unknown>) => { const t: number[] = []; for (let i = 0; i < 3; i++) { const s = performance.now(); await run(); t.push(performance.now() - s); } return Math.round(t.sort((a, b) => a - b)[1]!); };
    const timings: string[] = [];
    let stored = 0;
    for (const history of HISTORIES) {
      for (; stored < history; stored += 500) {
        await put(store, graph, ...Array.from({ length: 500 }, (_, i) => job(`h-${stored + i}`, 'succeeded', { name: `n-${stored + i}` })));
      }
      expect(await readPromoteOwnershipCandidates(store, graph, fresh, CONFLICT_READ_OPTIONS)).toEqual([]);
      expect(expectBindings(await store.query(buildPromoteOwnershipCandidateQuery(graph, fresh), SOURCE))).toEqual([]);
      timings.push(`${history} retained jobs: previous ${await median(() => referenceCandidates(store, graph, fresh))} ms | bounded ${await median(() => readPromoteOwnershipCandidates(store, graph, fresh, CONFLICT_READ_OPTIONS))} ms`);
    }
    console.log(`INFO  distinct fresh key beside retained history, median of 3: ${timings.join(' ;; ')}`);
    let n = 0;
    const queue = new TripleStoreAsyncPromoteQueue(store, { graphUri: graph, idGenerator: () => `q-${++n}` });
    const request = { contextGraphId: 'cg', assertionName: 'fresh', agentAddress: AG, entities: 'all' as const };
    const first = await queue.enqueue(request);
    await expect(queue.enqueue(request)).rejects.toBeInstanceOf(PromoteJobConflictError);
    const claimed = (await queue.claimNext('worker'))!;
    expect(claimed.jobId).toBe(first);
    const token = claimed.lease!.claimToken;
    for (const marker of ['swmInserted', 'wmCleaned', 'lifecycleStamped', 'gossiped'] as const) await queue.recordCommitMarker(first, token, marker);
    await queue.succeed(first, token, { promotedCount: 1, succeededAt: Date.now(), gossipMessageSize: 1 });
    expect(await queue.enqueue(request)).toBe('q-2');
  }, 900_000);
});
