import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { buildPromoteOwnershipCandidateQuery, createPromoteOwnershipReader, promoteOwnershipLookup, readPromoteOwnershipCandidates,
  type PromoteConflictLookup } from '../src/async-promote-ownership.js';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { PromoteAdmissionCoordinator } from '../src/promote-admission.js';
import { PromoteJobConflictError, type PromoteJob } from '../src/async-promote-queue-types.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI as GRAPH, PROMOTE_PAYLOAD, PROMOTE_STATE, PROMOTE_UNIQUENESS_KEY, expectBindings, jobSubject, legacyUniquenessKey,
  literal, parseJobPayload, serializeJobRecord, uniquenessKey, uniquenessLookupKeys } from '../src/async-promote-queue-utils.js';
import { AG, AG_MIXED, OTHER, US, collapsingStore, decisive, ids, job, lease, probeUnitSeparatorCollapse, put, putSpelled, referenceCandidates, req } from './_helpers/promote-lookup-differential.js';

// The conflict lookup (enqueue admission, lifecycle ownership reads, recovery sweeps) used to read `?job <uniquenessKey> ?key . FILTER (?key IN (...))`:
// the key was unbound, so the engine enumerated every job ever stored before filtering, and every row of the key (succeeded ones included) was decoded in
// JS. The candidate query now binds each key as a constant and drops rows that can never decide the lookup. These tests pin that the DECISION is unchanged AND that
// every job is still a candidate exactly ONCE: a UNION branch is one solution per match, and an engine that identifies two different key spellings with
// one stored term (Blazegraph does for the legacy key and the default-lane key, which differ only by a trailing U+001F) used to return the job once per branch.
// The randomised differential over the same oracle is async-promote-bounded-lookup.property.test.ts; the real-engine one is test-live/.

const stores: OxigraphStore[] = [];
const memory = () => { const store = new OxigraphStore(); stores.push(store); return store; };
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
const SOURCE = { source: 'publisher.asyncPromote.findActiveConflict' };

describe('bounded promote conflict lookup', () => {
  it('binds every uniqueness key as a constant of a UNION branch, never as an IN-filter over an unbound key, and pushes the state restriction into the query', () => {
    const peerLane = 'did:dkg:agent:Peer-1';                         // a non-EVM lane keeps its case: four distinct stored-key spellings
    const q = buildPromoteOwnershipCandidateQuery(GRAPH, promoteOwnershipLookup(req({ agentAddress: peerLane })));
    const keys = [uniquenessKey(req({ agentAddress: peerLane })), legacyUniquenessKey(req()), `${legacyUniquenessKey(req())}\u001f`, `${legacyUniquenessKey(req())}\u001f${peerLane.toLowerCase()}`];
    expect(q).not.toMatch(/\bIN\s*\(/);
    expect(q).not.toMatch(/\?key\b/);
    for (const key of keys) expect(q).toContain(`<${PROMOTE_UNIQUENESS_KEY}> ${literal(key)}`);
    expect(q.match(/UNION/g)?.length).toBe(3);
    expect(q).toContain(`OPTIONAL { ?job <${PROMOTE_STATE}> ?state . }`);
    expect(q).toContain('sameTerm(?state, "succeeded")');
    const wild = buildPromoteOwnershipCandidateQuery(GRAPH, promoteOwnershipLookup(req(), true));
    expect(wild).toContain('<urn:dkg:promote-queue:assertionName> "a"');
    expect(wild).not.toContain('UNION');
  });

  it('returns exactly the rows that can decide the lookup, however many succeeded jobs share the key', async () => {
    const store = memory();
    const done = Array.from({ length: 40 }, (_, i) => job(`done-${i}`, 'succeeded'));
    await put(store, GRAPH, ...done, job('q1', 'queued'), job('fail-plain', 'failed', { reason: 'cancelled' }), job('fail-bound', 'failed', { bound: true }), job('other-key', 'queued', { name: 'zzz' }));
    const lookup = promoteOwnershipLookup(req());
    const reference = await referenceCandidates(store, GRAPH, lookup);
    const bounded = await readPromoteOwnershipCandidates(store, GRAPH, lookup);
    expect(reference.length).toBe(40 + 3);
    expect(ids(bounded)).toEqual(['fail-bound', 'q1']);                      // succeeded rows and the unbound failed row are never decoded
    expect(ids(bounded.filter(decisive))).toEqual(ids(reference.filter(decisive)));
  });

  it('the lookup keys are distinct strings; the legacy key and the default-lane key differ only by a trailing U+001F, so a Set of the key list cannot merge them', () => {
    const base = legacyUniquenessKey(req());
    expect(uniquenessLookupKeys(req())).toEqual([`${base}${US}${AG}`, `${base}${US}`, base]);          // lane: canonical == pre-canonical spelling (one string), default lane, legacy
    expect(uniquenessLookupKeys(req({ agentAddress: AG_MIXED }))).toEqual([`${base}${US}${AG}`, `${base}${US}`, base]);
    expect(uniquenessLookupKeys({ contextGraphId: 'cg', assertionName: 'a' })).toEqual([`${base}${US}`, base]);   // no lane: canonical, pre-canonical and default-lane spellings are ONE string
    expect(uniquenessLookupKeys(req({ agentAddress: 'did:dkg:agent:Peer-1' }))).toHaveLength(4);        // a non-EVM lane keeps its case
    for (const r of [req(), req({ agentAddress: AG_MIXED }), req({ agentAddress: 'did:dkg:agent:Peer-1' }), { contextGraphId: 'cg', assertionName: 'a' }]) {
      const keys = uniquenessLookupKeys(r);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(`${base}${US}`.slice(0, -1)).toBe(base);
  });

  it('emits one branch per DISTINCT key even when a lookup carries a key list that repeats a spelling', () => {
    const clean = promoteOwnershipLookup(req());
    const [k1, k3, k4] = (clean.lookupQuery as { keys: string[] }).keys as [string, string, string];
    const repeating: PromoteConflictLookup = { ...clean, lookupQuery: { kind: 'uniquenessKeys', keys: [k1, k1, k3, k4, k3, k1, k4] } };
    expect(buildPromoteOwnershipCandidateQuery(GRAPH, repeating)).toBe(buildPromoteOwnershipCandidateQuery(GRAPH, clean));
    const q = buildPromoteOwnershipCandidateQuery(GRAPH, { ...clean, lookupQuery: { kind: 'uniquenessKeys', keys: [k3, k3, k3] } });
    expect(q).not.toContain('UNION');
    expect(q.split(`${literal(k3)}`).length).toBe(2);                                                  // the key appears exactly once
  });

  describe('U+001F positive control (the legacy key and the default-lane key as ONE stored term)', () => {
    const jobs = [job('A', 'queued'), job('B', 'running', { lease }), job('C', 'queued'),
      job('D', 'failed', { bound: true }), job('E', 'succeeded'), job('F', 'failed', { reason: 'cancelled' }), job('G', 'queued', { lane: OTHER })];
    const spelling: Record<string, string> = { A: `${legacyUniquenessKey(req())}${US}`, B: legacyUniquenessKey(req()), C: uniquenessKey(req()), D: legacyUniquenessKey(req()),
      E: `${legacyUniquenessKey(req())}${US}`, F: legacyUniquenessKey(req()), G: uniquenessKey(req({ agentAddress: OTHER })) };
    const lookup = promoteOwnershipLookup(req());
    const seeded = async (engine: 'exact' | 'collapse') => {
      const store = engine === 'collapse' ? collapsingStore(memory()) : memory();
      for (const j of jobs) await putSpelled(store, GRAPH, j, spelling[j.jobId]!);
      return store;
    };

    it('a direct probe sees the pair match ONE stored term on the collapsing engine and two terms on the exact engine', async () => {
      expect(await probeUnitSeparatorCollapse(memory(), 'urn:test:probe:exact')).toEqual({ legacyMatches: 1, defaultLaneMatches: 0, collapses: false });
      expect(await probeUnitSeparatorCollapse(collapsingStore(memory()), 'urn:test:probe:collapse')).toEqual({ legacyMatches: 1, defaultLaneMatches: 1, collapses: true });
    });

    it('repeat count > 0: the unchanged query text returns A, B and D (stored under a spelling two branches reach) twice, and the product still returns every job ONCE', async () => {
      for (const engine of ['exact', 'collapse'] as const) {
        const store = await seeded(engine);
        const raw = expectBindings(await store.query(buildPromoteOwnershipCandidateQuery(GRAPH, lookup), SOURCE));
        const rawIds = raw.map(x => parseJobPayload(x.payload)!.jobId).sort();
        const repeated = raw.length - new Set(raw.map(x => x.payload)).size;
        expect(ids(await referenceCandidates(store, GRAPH, lookup))).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
        expect(ids(await readPromoteOwnershipCandidates(store, GRAPH, lookup))).toEqual(['A', 'B', 'C', 'D']);
        expect(rawIds).toEqual(engine === 'exact' ? ['A', 'B', 'C', 'D'] : ['A', 'A', 'B', 'B', 'C', 'D', 'D']);
        expect(repeated).toBe(engine === 'exact' ? 0 : 3);                      // the control: the model really makes the query repeat rows, so the dedupe assertions above discriminate
        expect((await createPromoteOwnershipReader(store, GRAPH)(req()))?.jobId).toBe('D');
      }
    });
  });

  it('merges only IDENTICAL payload rows, in first-seen order (stub store); a different payload of the same job is still a separate candidate', async () => {
    const payloadOf = (j: PromoteJob) => serializeJobRecord(j, GRAPH).jobQuads.find(q => q.predicate === PROMOTE_PAYLOAD)!.object;
    const [p1, p2, p3] = [job('j1', 'queued'), job('j2', 'queued'), job('j3', 'queued')].map(payloadOf) as [string, string, string];
    const twin = payloadOf(job('j1', 'running', { lease }));
    const stub = (rows: string[]) => ({ query: async () => ({ type: 'bindings', bindings: rows.map(payload => ({ payload })) }) }) as unknown as TripleStore;
    const read = async (rows: string[]) => (await readPromoteOwnershipCandidates(stub(rows), GRAPH, promoteOwnershipLookup(req()))).map(j => j.jobId);
    expect(await read([p1, p1, p2, p1, p3, p2])).toEqual(['j1', 'j2', 'j3']);
    expect(await read([p3, p1, p2])).toEqual(['j3', 'j1', 'j2']);
    expect(await read([])).toEqual([]);
    expect(await read([p1, twin])).toEqual(['j1', 'j1']);
    await expect(read([p1, p1, '"not a job"'])).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
  });

  it('queue admission still refuses every active owner, a failed bound obligation and a legacy wildcard-lane owner, and admits behind terminal history', async () => {
    const store = memory();
    const history = Array.from({ length: 200 }, (_, i) => job(`done-${i}`, 'succeeded', { name: i % 2 ? 'a' : `x${i}` }));
    await put(store, GRAPH, ...history, job('failed-bound', 'failed', { bound: true }));
    const queue = new TripleStoreAsyncPromoteQueue(store, { idGenerator: () => `new-${Math.random().toString(36).slice(2)}` });
    // the failed bound row has no certified retirement: it keeps owning the assertion
    await expect(queue.enqueue({ contextGraphId: 'cg', assertionName: 'a', agentAddress: AG, entities: 'all' })).rejects.toBeInstanceOf(PromoteJobConflictError);
    await queue.enqueue({ contextGraphId: 'cg', assertionName: 'fresh', agentAddress: AG, entities: 'all' });
    await expect(queue.enqueue({ contextGraphId: 'cg', assertionName: 'fresh', agentAddress: AG, entities: 'all' })).rejects.toBeInstanceOf(PromoteJobConflictError);
    await put(store, GRAPH, job('legacy-running', 'running', { formatVersion: 1, lane: null, name: 'legacy', lease }));
    await expect(queue.enqueue({ contextGraphId: 'cg', assertionName: 'legacy', agentAddress: OTHER, entities: 'all' })).rejects.toBeInstanceOf(PromoteJobConflictError);
  });

  it('keeps failing closed on an unreadable row in every class the query still returns', async () => {
    for (const state of ['queued', 'running', 'failed_retrying'] as const) {
      const store = memory();
      await put(store, GRAPH, job('bad', state));
      await store.deleteByPattern({ subject: jobSubject('bad'), predicate: PROMOTE_PAYLOAD, graph: GRAPH });
      await store.insert([{ subject: jobSubject('bad'), predicate: PROMOTE_PAYLOAD, object: literal('{}'), graph: GRAPH }]);
      await expect(readPromoteOwnershipCandidates(store, GRAPH, promoteOwnershipLookup(req()))).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
      await expect(createPromoteOwnershipReader(store, GRAPH)(req())).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    }
    // a row without a state triple and a row with an unrecognised state are returned too
    const store = memory();
    await put(store, GRAPH, job('no-state', 'queued'));
    await store.deleteByPattern({ subject: jobSubject('no-state'), predicate: PROMOTE_STATE, graph: GRAPH });
    expect(ids(await readPromoteOwnershipCandidates(store, GRAPH, promoteOwnershipLookup(req())))).toEqual(['no-state']);
  });

  describe('D-5 narrowings (corrupted rows only)', () => {
    it('D1/D2: a row whose state triple says succeeded (or failed without a recovery binding) is no longer decoded, so a corrupt payload there no longer fails the lookup', async () => {
      for (const state of ['succeeded', 'failed'] as const) {
        const store = memory();
        await put(store, GRAPH, job('bad', state));
        await store.deleteByPattern({ subject: jobSubject('bad'), predicate: PROMOTE_PAYLOAD, graph: GRAPH });
        await store.insert([{ subject: jobSubject('bad'), predicate: PROMOTE_PAYLOAD, object: literal('{}'), graph: GRAPH }]);
        await expect(referenceCandidates(store, GRAPH, promoteOwnershipLookup(req()))).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
        expect(await readPromoteOwnershipCandidates(store, GRAPH, promoteOwnershipLookup(req()))).toEqual([]);
      }
    });

    it('D1/D2 boundary: a failed row that still shows a recovery binding keeps failing closed (a bound failed row owns the assertion)', async () => {
      const store = memory();
      await put(store, GRAPH, job('bound-bad', 'failed', { bound: true }));
      await store.deleteByPattern({ subject: jobSubject('bound-bad'), predicate: PROMOTE_PAYLOAD, graph: GRAPH });
      await store.insert([{ subject: jobSubject('bound-bad'), predicate: PROMOTE_PAYLOAD, object: literal('{"recoveryBinding":'), graph: GRAPH }]);
      await expect(readPromoteOwnershipCandidates(store, GRAPH, promoteOwnershipLookup(req()))).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    });

    it('D4: a lookup no longer clears another process\'s stale owner observation of a job that became terminal there; any read of that job still does', async () => {
      let n = 0;
      const stale = async () => {
        const store = memory();
        const coordinator = PromoteAdmissionCoordinator.for(store, GRAPH);
        const queue = new TripleStoreAsyncPromoteQueue(store, { idGenerator: () => `d4-${++n}` });
        const id = await queue.enqueue({ contextGraphId: 'cg', assertionName: 'a', agentAddress: AG, entities: 'all' });
        const observed = () => (coordinator as unknown as { owners: Map<string, unknown> }).owners.has(id);
        expect(observed()).toBe(true);                                       // the acknowledged write left an owner observation in this process
        // another process finishes the job; this process's coordinator hears nothing
        const row = expectBindings(await store.query(`SELECT ?payload WHERE { GRAPH <${GRAPH}> { <${jobSubject(id)}> <${PROMOTE_PAYLOAD}> ?payload } }`, SOURCE))[0]!;
        await store.deleteByPattern({ subject: jobSubject(id), graph: GRAPH });
        await put(store, GRAPH, { ...parseJobPayload(row.payload)!, state: 'succeeded', updatedAt: 9_000 });
        return { store, coordinator, queue, id, observed };
      };
      // before: findActiveConflict observed every returned row, terminal ones included, which dropped the stale entry
      const before = await stale();
      for (const candidate of await referenceCandidates(before.store, GRAPH, promoteOwnershipLookup(req()))) before.coordinator.observe(candidate);
      expect(before.observed()).toBe(false);
      // now: the bound path (it has no owner fast path) runs the real conflict lookup, which does not return the succeeded row
      const after = await stale();
      await after.queue.enqueueAndClaim({ ...req(), entities: 'all', recoveryBinding: job('x', 'queued', { bound: true }).request.recoveryBinding! } as never, 'worker');
      expect(after.observed()).toBe(true);
      expect((await after.queue.getStatus(after.id))?.state).toBe('succeeded');
      expect(after.observed()).toBe(false);
    });
  });

  describe('hot key: the work of a lookup is bounded by the jobs under its key, not by the history', () => {
    // Rows read and decoded are the part of the cost this process controls; the engine-side index work is measured on Blazegraph (test-live/).
    const countingStore = (inner: TripleStore) => {
      const counter = { rows: 0 };
      const store = new Proxy(inner, { get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (prop !== 'query' || typeof v !== 'function') return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        return async (text: string, options?: { source?: string }) => {
          const result = await (v as (...a: unknown[]) => Promise<Parameters<typeof expectBindings>[0]>).call(target, text, options);
          if (options?.source === 'publisher.asyncPromote.findActiveConflict') counter.rows += expectBindings(result).length;
          return result;
        };
      } }) as TripleStore;
      return { store, counter };
    };

    it('one live job among N finished ones under the SAME key: the bounded lookup reads one row at every N, the previous one read N + 1', async () => {
      const rowsRead: Array<{ finished: number; previous: number; bounded: number }> = [];
      for (const finished of [25, 100, 400]) {
        const inner = memory();
        await put(inner, GRAPH, ...Array.from({ length: finished }, (_, i) => job(`hot-${i}`, 'succeeded')), job('hot-live', 'queued'));
        const { store, counter } = countingStore(inner);
        const lookup = promoteOwnershipLookup(req());
        const previous = await referenceCandidates(store, GRAPH, lookup);
        const previousRows = counter.rows; counter.rows = 0;
        const bounded = await readPromoteOwnershipCandidates(store, GRAPH, lookup);
        rowsRead.push({ finished, previous: previousRows, bounded: counter.rows });
        expect(ids(bounded.filter(decisive))).toEqual(['hot-live']);
        expect(ids(previous.filter(decisive))).toEqual(['hot-live']);
      }
      expect(rowsRead).toEqual([{ finished: 25, previous: 26, bounded: 1 }, { finished: 100, previous: 101, bounded: 1 }, { finished: 400, previous: 401, bounded: 1 }]);
    });

    it('history under OTHER keys is never read: a fresh key beside 3,000 retained jobs reads no row, and the queue admits it', async () => {
      const inner = memory();
      await put(inner, GRAPH, ...Array.from({ length: 3_000 }, (_, i) => job(`h-${i}`, i % 9 === 0 ? 'failed' : 'succeeded', { name: `n-${i}` })));
      const { store, counter } = countingStore(inner);
      expect(await readPromoteOwnershipCandidates(store, GRAPH, promoteOwnershipLookup(req({ assertionName: 'fresh' })))).toEqual([]);
      expect(counter.rows).toBe(0);
      const queue = new TripleStoreAsyncPromoteQueue(store, { idGenerator: () => 'fresh-1' });
      await queue.enqueue({ contextGraphId: 'cg', assertionName: 'fresh', agentAddress: AG, entities: 'all' });
      expect(counter.rows).toBe(0);
    });

    it('the growth that remains is per key: ACTIVE rows under the key are all returned, because each one can decide (the lookup returns what the previous one did, minus the finished ones)', async () => {
      const inner = memory();
      await put(inner, GRAPH, ...Array.from({ length: 60 }, (_, i) => job(`done-${i}`, 'succeeded')), ...Array.from({ length: 7 }, (_, i) => job(`q-${i}`, 'queued')));
      const { store, counter } = countingStore(inner);
      const bounded = await readPromoteOwnershipCandidates(store, GRAPH, promoteOwnershipLookup(req()));
      expect(counter.rows).toBe(7);
      expect(bounded).toHaveLength(7);
    });
  });
});
