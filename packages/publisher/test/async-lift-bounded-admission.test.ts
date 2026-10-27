import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { LiftJobStoreSelectors, lifecycleKeyOfJob } from '../src/lift-job-store-selectors.js';
import { LiftLegacyScanMemo } from '../src/lift-legacy-scan-memo.js';
import type { LiftJob, PersistedLiftJob, RawLiftRequest } from '../src/lift-job.js';
import {
  CONTROL_LIFECYCLE_KEY,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  knowledgeAssetVmPublishLifecycleKey,
  literal,
  serializeJob,
} from '../src/async-lift-control-plane.js';
import { createRawLiftJobRequest } from '../src/async-lift-publisher-utils.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';

// OT-RFC-73 P7 (S2) - the publisher's admission lookup is bounded by the lifecycle key once no LEGACY un-indexed VM-publish row can exist.
// `findActiveVmPublish` used to UNION the key-bound index branch with a branch that joins status and payload of EVERY retained job
// (FILTER NOT EXISTS lifecycleKey): time proportional to the retained history, paid by every admission under the global claim lock.
// What admission learned is kept per store and graph for the whole process (LiftLegacyScanMemo), so every publisher instance shares it.
const FIND_ACTIVE = 'publisher.asyncLift.findActiveVmPublish';
const BACKFILL = 'publisher.asyncLift.ensureVmPublishIntentIndex';
const SEPARATOR = String.fromCharCode(0x1f);

const rawLiftRequest = (): RawLiftRequest => ({
  swmId: 'swm-1', namespace: 'default', contextGraphId: 'music-social', shareOperationId: 'share-op-1', roots: [],
  contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION, kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7',
  assertionVersion: '1', publicTripleCount: 2, privateTripleCount: 0, scope: 'full', transitionType: 'CREATE',
  authority: { type: 'owner', proofRef: 'proof:owner:1' },
});

interface RecordedQuery { readonly source?: string; readonly sparql: string; readonly payloads: number }

describe('bounded VM-publish admission lookup', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;
  let queries: RecordedQuery[];

  /** Record every query of `target` with the number of payload rows it transferred. */
  function record(target: OxigraphStore): RecordedQuery[] {
    const recorded: RecordedQuery[] = [];
    const query = target.query.bind(target);
    target.query = (async (sparql: string, options?: { source?: string }) => {
      const result = await query(sparql, options as never);
      recorded.push({
        source: options?.source,
        sparql,
        payloads: result.type === 'bindings' ? result.bindings.filter((row) => row['payload'] !== undefined).length : 0,
      });
      return result;
    }) as typeof target.query;
    return recorded;
  }

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
    queries = record(store);
  });

  const publisher = (target: TripleStore = store, graphUri?: string): TripleStoreAsyncLiftPublisher =>
    new TripleStoreAsyncLiftPublisher(target, { now: () => ++now, idGenerator: () => `job-${++ids}`, ...(graphUri ? { graphUri } : {}) });
  const request = (name: string, intent = 'a') => kaVmPublishRequest({ name, intentKey: `sha256:${intent.repeat(64).slice(0, 64)}` });
  const findActive = () => queries.filter((q) => q.source === FIND_ACTIVE);
  const unions = () => findActive().map((q) => /UNION/.test(q.sparql));
  const dropIndex = async (jobId: string): Promise<void> => { await store.deleteByPattern({ subject: jobSubject(jobId), predicate: CONTROL_LIFECYCLE_KEY, graph: DEFAULT_CONTROL_GRAPH_URI }); };
  const lifecycleKeyTriples = async (): Promise<number> => {
    const result = await store.query(`SELECT ?job WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { ?job <${CONTROL_LIFECYCLE_KEY}> ?key } }`);
    return result.type === 'bindings' ? result.bindings.length : -1;
  };

  // The selector has no scan-mode override: tests steer it through the process-wide memo, as a process restart does.
  const restartProcess = (): void => new LiftLegacyScanMemo(store, DEFAULT_CONTROL_GRAPH_URI).forgetForTesting();
  const selectorsOver = (): LiftJobStoreSelectors => new LiftJobStoreSelectors(store, DEFAULT_CONTROL_GRAPH_URI, (job) => job);

  /**
   * A VM-publish job that was admitted before the #1828 index existed, already on the store when the process starts: its row
   * is built on a scratch store (so no admission on `store` has learned anything yet) and copied without the lifecycle-key triple.
   */
  async function legacyJob(
    req: ReturnType<typeof request>, jobId: string, mutate: (job: PersistedLiftJob) => PersistedLiftJob = (job) => job,
  ): Promise<string> {
    const scratch = new OxigraphStore();
    const seed = new TripleStoreAsyncLiftPublisher(scratch, { now: () => 500, idGenerator: () => jobId });
    await seed.enqueueKnowledgeAssetVmPublish(req);
    const job = mutate((await seed.getStatus(jobId))!);
    await store.insert(serializeJob(job as LiftJob, DEFAULT_CONTROL_GRAPH_URI).filter((quad) => quad.predicate !== CONTROL_LIFECYCLE_KEY));
    return jobId;
  }

  /** `count` finalized, indexed jobs; the first `hot` of them share the lifecycle key of `hotName`. */
  async function seedHistory(count: number, hot = 0, hotName = 'hot'): Promise<void> {
    const seedPublisher = new TripleStoreAsyncLiftPublisher(new OxigraphStore(), { now: () => 500, idGenerator: () => 'template' });
    await seedPublisher.enqueueKnowledgeAssetVmPublish(request('template'));
    const template = (await seedPublisher.getStatus('template'))!;
    if (template.request.jobType !== 'knowledge-asset-vm-publish') throw new Error('template missing');
    const templatePublish = template.request.knowledgeAssetVmPublish;
    const history = Array.from({ length: count }, (_, index): LiftJob => ({
      jobId: `history-${index}`, jobSlug: `history-${index}`,
      request: { jobType: 'knowledge-asset-vm-publish', knowledgeAssetVmPublish: {
        ...templatePublish, name: index < hot ? hotName : `historical-${index}`,
      } },
      status: 'finalized',
      timestamps: { acceptedAt: index, updatedAt: index },
      retries: { retryCount: 0, maxRetries: 10 },
      claim: { walletId: 'historical-wallet' }, validation: KA_VM_VALIDATION,
      finalization: { mode: 'local' },
      controlPlane: { jobRef: jobSubject(`history-${index}`) },
    }));
    await store.insert(history.flatMap((job) => serializeJob(job, DEFAULT_CONTROL_GRAPH_URI)));
  }

  describe('patch behavior', () => {
    it('scans for legacy rows ONCE; once none exists the admission query is bound by the lifecycle key (no UNION, no FILTER NOT EXISTS)', async () => {
      const p = publisher();
      const first = await p.enqueueKnowledgeAssetVmPublish(request('albums'));
      const second = await p.enqueueKnowledgeAssetVmPublish(request('albums'));
      const third = await p.enqueueKnowledgeAssetVmPublish(request('songs'));
      expect(second).toBe(first);                                           // same intent: deduplicated through the key-bound index branch
      expect(third).not.toBe(first);
      expect(unions()).toEqual([true, false, false]);
      expect(findActive().slice(1).some((q) => /NOT EXISTS/.test(q.sparql))).toBe(false);
    });

    it('pins both query forms: the scan is the pre-P7 query text, the bounded form is its first branch alone', async () => {
      const key = knowledgeAssetVmPublishLifecycleKey({ contextGraphId: 'music-social', name: 'albums' });
      const selectors = selectorsOver();
      await selectors.vmPublishAdmissionCandidates(key);                    // the first call of a process scans and finds no legacy row ...
      await selectors.vmPublishAdmissionCandidates(key);                    // ... so the next one is the bounded form
      const flat = (sparql: string): string => sparql.replace(/\s+/g, ' ').trim();
      const indexed = `{ ?job <${CONTROL_LIFECYCLE_KEY}> ${literal(key)} ; <${CONTROL_PAYLOAD}> ?payload . OPTIONAL { ?job <${CONTROL_STATUS}> ?status } BIND(true AS ?indexed) }`;
      const legacy = `{ ?job <${CONTROL_STATUS}> ?status ; <${CONTROL_PAYLOAD}> ?payload . FILTER NOT EXISTS { ?job <${CONTROL_LIFECYCLE_KEY}> ?lifecycleKey } }`;
      const head = `SELECT ?payload ?status ?indexed WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> {`;
      expect(findActive().map((q) => flat(q.sparql))).toEqual([
        `${head} ${indexed} UNION ${legacy} } }`,
        `${head} ${indexed} } }`,
      ]);
    });

    it('a legacy un-indexed VM-publish job keeps the scan on and is still deduplicated; after the boot backfill one more scan finds nothing and ends it', async () => {
      const legacyId = await legacyJob(request('albums'), 'legacy-1');
      const p = publisher();
      expect(await p.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(legacyId);
      expect(await p.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(legacyId);
      expect(unions()).toEqual([true, true]);                              // legacy row present: the scan keeps running, behaviour unchanged
      expect(await p.ensureVmPublishIntentIndex()).toBe(1);
      queries.length = 0;
      expect(await p.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(legacyId);
      expect(await p.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(legacyId);
      expect(unions()).toEqual([true, false]);                             // one more scan finds no legacy row any more (the backfill indexed it), then the key-bound branch alone
    });

    it('CHARACTERISATION of the accepted trade: a legacy un-indexed row that appears AFTER this process learned "none" is not seen until the next backfill or process start', async () => {
      const p = publisher();
      const first = await p.enqueueKnowledgeAssetVmPublish(request('albums'));
      await dropIndex(first);                                               // e.g. an older-version writer on the same store re-creating a pre-#1828 row
      const second = await p.enqueueKnowledgeAssetVmPublish(request('albums'));
      expect(second).not.toBe(first);                                       // the unbounded lookup would return `first` (see the start-up case above)
      expect(unions()).toEqual([true, false]);
      expect(await p.ensureVmPublishIntentIndex()).toBe(1);                 // the backfill repairs the late row ...
      expect(await lifecycleKeyTriples()).toBe(2);                          // ... so the bounded lookup sees both jobs again
    });

    it('ignores malformed un-indexed neighbours exactly like the unbounded lookup, and they do not keep the scan on', async () => {
      const p = publisher();
      await store.insert([
        { subject: jobSubject('broken'), predicate: CONTROL_PAYLOAD, object: literal('{not-json'), graph: DEFAULT_CONTROL_GRAPH_URI },
        { subject: jobSubject('broken'), predicate: CONTROL_STATUS, object: literal('accepted'), graph: DEFAULT_CONTROL_GRAPH_URI },
      ]);
      const id = await p.enqueueKnowledgeAssetVmPublish(request('albums'));
      expect(await p.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(id);
      expect(unions()).toEqual([true, false]);
    });

    it('a legacy row whose lifecycle key cannot be built (U+001F in the name) never matches an admission, so it does not keep the scan on', async () => {
      await legacyJob(request('albums'), 'legacy-bad', (job) => {
        if (job.request.jobType !== 'knowledge-asset-vm-publish') return job;
        return { ...job, request: { ...job.request, knowledgeAssetVmPublish: { ...job.request.knowledgeAssetVmPublish, name: `bad${SEPARATOR}name` } } } as PersistedLiftJob;
      });
      const p = publisher();
      const id = await p.enqueueKnowledgeAssetVmPublish(request('songs'));
      expect(await p.enqueueKnowledgeAssetVmPublish(request('songs'))).toBe(id);
      expect(unions()).toEqual([true, false]);
      expect(await p.ensureVmPublishIntentIndex()).toBe(1);                 // still un-indexable, still counted: the backfill's count is unchanged
    });

    it('a legacy RAW-LIFT row (restorePersistedLegacyRawLiftJob can leave one in a mainnet queue) is returned by the scan but is no VM-publish job, so it does not keep the scan on', async () => {
      const rawId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), { idGenerator: () => 'raw-1', now: () => 500 });
      const p = publisher();
      const id = await p.enqueueKnowledgeAssetVmPublish(request('albums'));
      expect(findActive()[0]!.payloads).toBe(1);                            // the scan really transferred the raw-lift row ...
      expect(await p.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(id);
      expect(await p.enqueueKnowledgeAssetVmPublish(request('songs'))).not.toBe(id);
      expect(unions()).toEqual([true, false, false]);                       // ... and one scan was still enough: admission does not scan forever
      expect(await p.getStatus(rawId)).toMatchObject({ jobId: rawId, status: 'accepted' });
      expect(await p.ensureVmPublishIntentIndex()).toBe(0);                 // the backfill leaves raw-lift rows alone, as before
    });

    it('a failed scan learns nothing: the next admission scans again', async () => {
      const p = publisher();
      const query = store.query.bind(store);
      store.query = (async () => { throw new Error('candidate backend unavailable'); }) as typeof store.query;
      await expect(p.enqueueKnowledgeAssetVmPublish(request('albums'))).rejects.toThrow('candidate backend unavailable');
      store.query = query;
      await p.enqueueKnowledgeAssetVmPublish(request('albums'));
      expect(unions()).toEqual([true]);
      expect(new LiftLegacyScanMemo(store, DEFAULT_CONTROL_GRAPH_URI).scanRequired()).toBe(false);
    });

    it('the selector returns the same candidates with and without the legacy branch when no legacy row exists', async () => {
      const p = publisher();
      await p.enqueueKnowledgeAssetVmPublish(request('albums'));
      await p.enqueueKnowledgeAssetVmPublish(request('songs'));
      const selectors = selectorsOver();
      const key = knowledgeAssetVmPublishLifecycleKey({ contextGraphId: 'music-social', name: 'albums' });
      queries.length = 0;
      restartProcess();                                                      // the admissions above learned "none": a restart forgets it
      const full = await selectors.vmPublishAdmissionCandidates(key);
      const bounded = await selectors.vmPublishAdmissionCandidates(key);
      expect(unions()).toEqual([true, false]);                              // the two reads really are the scan and the bounded form
      expect(bounded.map((j) => j.jobId)).toEqual(full.map((j) => j.jobId));
      expect(bounded).toHaveLength(1);
    });

    it('has ONE policy: the process-wide memo alone picks the query form, and no argument forces either one', async () => {
      const selectors = selectorsOver();
      const key = knowledgeAssetVmPublishLifecycleKey({ contextGraphId: 'music-social', name: 'albums' });
      // An argument a former test-only mode took: ignored, so it neither switches the form nor changes what the memo learns.
      const withExtraArgument = selectors.vmPublishAdmissionCandidates as (...args: unknown[]) => Promise<unknown>;
      const admit = (extra?: unknown): Promise<unknown> => (extra === undefined
        ? withExtraArgument.call(selectors, key)
        : withExtraArgument.call(selectors, key, extra));
      await admit();                                                         // learns "none"
      await admit({ legacyUnindexedScan: true });                            // would have forced the scan
      await admit({ legacyUnindexedScan: false });
      expect(unions()).toEqual([true, false, false]);
      restartProcess();
      await admit({ legacyUnindexedScan: false });                           // would have forced the bounded form, and kept the memo untouched
      await admit();
      expect(unions()).toEqual([true, false, false, true, false]);           // the forgotten memo scans, and clearing it again ends the scan
    });

    it('owns its lifecycle-key classification: a caller cannot pass one, so none can declare the shared scan complete', async () => {
      await legacyJob(request('albums'), 'legacy-1');                        // a KEYED legacy row: by the canonical rule the scan must go on
      const selectors = selectorsOver();
      const key = knowledgeAssetVmPublishLifecycleKey({ contextGraphId: 'music-social', name: 'albums' });
      expect(selectors.vmPublishAdmissionCandidates).toHaveLength(1);        // the key alone: there is no classifier parameter
      // @ts-expect-error a second argument is a type error
      const typed = selectors.vmPublishAdmissionCandidates.bind(selectors, key, () => null);
      expect(typed).toBeTypeOf('function');
      // What a JavaScript caller or a stale TypeScript build could still pass: a classifier that calls every row keyless.
      const untyped = selectors.vmPublishAdmissionCandidates as (...args: unknown[]) => Promise<PersistedLiftJob[]>;
      const first = await untyped.call(selectors, key, () => null);
      const second = await untyped.call(selectors, key, () => null);
      expect(first.map((job) => job.jobId)).toEqual(['legacy-1']);
      expect(second.map((job) => job.jobId)).toEqual(['legacy-1']);          // still found: the scan was not ended by the argument
      expect(unions()).toEqual([true, true]);
      expect(new LiftLegacyScanMemo(store, DEFAULT_CONTROL_GRAPH_URI).scanRequired()).toBe(true);
      // The memo is shared by every selector over the store: another one is not told the scan is complete either.
      expect((await selectorsOver().vmPublishAdmissionCandidates(key)).map((job) => job.jobId)).toEqual(['legacy-1']);
      expect(unions()).toEqual([true, true, true]);
    });

    it('clears the memo only by the canonical rule: keyed legacy rows keep scanning; keyless, non-VM and malformed rows do not', async () => {
      const key = knowledgeAssetVmPublishLifecycleKey({ contextGraphId: 'music-social', name: 'albums' });
      const keyless = (job: PersistedLiftJob): PersistedLiftJob => (job.request.jobType !== 'knowledge-asset-vm-publish' ? job : {
        ...job, request: { ...job.request, knowledgeAssetVmPublish: { ...job.request.knowledgeAssetVmPublish, name: `bad${SEPARATOR}name` } },
      } as PersistedLiftJob);
      await legacyJob(request('songs'), 'legacy-keyed');
      await legacyJob(request('albums'), 'legacy-bad', keyless);
      await seedLegacyRawLiftTestJob(store, rawLiftRequest(), { idGenerator: () => 'raw-1', now: () => 500 });
      const selectors = selectorsOver();
      await selectors.vmPublishAdmissionCandidates(key);
      await selectors.vmPublishAdmissionCandidates(key);
      expect(unions()).toEqual([true, true]);                                // the keyed row alone holds the scan open ...
      await store.deleteByPattern({ subject: jobSubject('legacy-keyed'), graph: DEFAULT_CONTROL_GRAPH_URI });
      await selectors.vmPublishAdmissionCandidates(key);
      await selectors.vmPublishAdmissionCandidates(key);
      expect(unions()).toEqual([true, true, true, false]);                   // ... and with it gone the keyless and raw-lift rows let one more scan end it
    });

    it('classifies a persisted job by one fixed rule: its lifecycle key, or none for a non-VM or unbuildable request', async () => {
      const seed = new TripleStoreAsyncLiftPublisher(new OxigraphStore(), { now: () => 500, idGenerator: () => 'seed' });
      await seed.enqueueKnowledgeAssetVmPublish(request('albums'));
      const job = (await seed.getStatus('seed'))!;
      expect(lifecycleKeyOfJob(job)).toBe(knowledgeAssetVmPublishLifecycleKey({ contextGraphId: 'music-social', name: 'albums' }));
      expect(lifecycleKeyOfJob({ ...job, request: createRawLiftJobRequest(rawLiftRequest()) } as unknown as PersistedLiftJob)).toBeNull();
      expect(lifecycleKeyOfJob({
        ...job, request: { ...job.request, knowledgeAssetVmPublish: { ...(job.request as { knowledgeAssetVmPublish: object }).knowledgeAssetVmPublish, name: `bad${SEPARATOR}name` } },
      } as unknown as PersistedLiftJob)).toBeNull();
    });
  });

  describe('process-wide memo', () => {
    // A decorated view of a store (a mutation observer, a cache invalidator) is a different object over the same backend.
    const decorated = (inner: TripleStore): TripleStore => new Proxy(inner, {
      has: (target, property) => property === 'innerStore' || property in target,
      get: (target, property) => {
        if (property === 'innerStore') return inner;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    it('two publisher instances over one store share it: only the first instance pays the scan', async () => {
      const admission = publisher();
      const runtime = publisher();
      const albums = await admission.enqueueKnowledgeAssetVmPublish(request('albums'));
      await runtime.enqueueKnowledgeAssetVmPublish(request('songs'));
      expect(await admission.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(albums);
      expect(unions()).toEqual([true, false, false]);
    });

    it('a decorated view of the store shares the memo of its backend', async () => {
      const first = publisher(decorated(store));
      const second = publisher(store);
      const third = publisher(decorated(decorated(store)));
      await first.enqueueKnowledgeAssetVmPublish(request('albums'));
      await second.enqueueKnowledgeAssetVmPublish(request('songs'));
      await third.enqueueKnowledgeAssetVmPublish(request('movies'));
      expect(unions()).toEqual([true, false, false]);
    });

    it('is per store and per control graph', async () => {
      await publisher().enqueueKnowledgeAssetVmPublish(request('albums'));
      expect(unions()).toEqual([true]);
      await publisher(store, 'urn:dkg:publisher:other-control-plane').enqueueKnowledgeAssetVmPublish(request('albums'));
      expect(unions()).toEqual([true, true]);                               // another graph on the same store has its own legacy rows
      const other = new OxigraphStore();
      const otherQueries = record(other);
      await publisher(other).enqueueKnowledgeAssetVmPublish(request('albums'));
      expect(otherQueries.filter((q) => q.source === FIND_ACTIVE).map((q) => /UNION/.test(q.sparql))).toEqual([true]);
    });

    it('reads allocate nothing: a publisher that never admits learns and records nothing', async () => {
      publisher();
      publisher(decorated(store));
      expect(new LiftLegacyScanMemo(store, DEFAULT_CONTROL_GRAPH_URI).scanRequired()).toBe(true);
      expect(new LiftLegacyScanMemo(decorated(store), DEFAULT_CONTROL_GRAPH_URI).scanRequired()).toBe(true);
    });

    it('a legacy row on the store keeps every instance scanning, and the backfill of one instance ends it for all', async () => {
      const legacyId = await legacyJob(request('albums'), 'legacy-1');
      const admission = publisher();
      const runtime = publisher(decorated(store));
      expect(await admission.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(legacyId);
      expect(await runtime.enqueueKnowledgeAssetVmPublish(request('albums'))).toBe(legacyId);
      expect(unions()).toEqual([true, true]);
      expect(await runtime.ensureVmPublishIntentIndex()).toBe(1);
      queries.length = 0;
      await admission.enqueueKnowledgeAssetVmPublish(request('albums'));    // the one scan that finds the backfilled queue clean ...
      await runtime.enqueueKnowledgeAssetVmPublish(request('albums'));      // ... is shared by the other instance
      expect(unions()).toEqual([true, false]);
    });
  });

  describe('hot keys', () => {
    // A lifecycle key with a long history of its own (the same asset re-published over time) is the one case the lifecycle-key
    // bound cannot remove: the lookup stays proportional to the rows under THAT key, and to nothing else.
    async function admitOnHotKey(unrelated: number, hotRows: number): Promise<{ transferred: number[]; ids: string[] }> {
      store = new OxigraphStore();
      queries = record(store);
      await seedHistory(unrelated + hotRows, hotRows);
      await publisher().enqueueKnowledgeAssetVmPublish(request('warm-up'));  // learn "none", so the next admissions are bounded
      queries.length = 0;
      const p = publisher();
      const ids = [await p.enqueueKnowledgeAssetVmPublish(request('hot')), await p.enqueueKnowledgeAssetVmPublish(request('hot'))];
      expect(unions()).toEqual([false, false]);
      return { transferred: findActive().map((q) => q.payloads), ids };
    }

    it('transfers the rows under the key and nothing of the rest of the history', async () => {
      const lean = await admitOnHotKey(0, 25);
      const heavy = await admitOnHotKey(1_500, 25);
      expect(lean.transferred).toEqual([25, 26]);                           // 25 finalized siblings, then the same plus the job the first admission created
      expect(heavy.transferred).toEqual(lean.transferred);                  // 1,500 more jobs under other keys change nothing
      expect(heavy.ids[1]).toBe(heavy.ids[0]);                              // and the decision is the usual one: finalized siblings do not occupy the subject, the new job does
    });

    it('grows with the key own history, one row per job under it', async () => {
      const small = await admitOnHotKey(200, 5);
      const large = await admitOnHotKey(200, 40);
      expect(small.transferred).toEqual([5, 6]);
      expect(large.transferred).toEqual([40, 41]);
    });
  });

  describe('boot backfill', () => {
    it('selects only the un-indexed rows: indexed history never transfers, the full list is not read', async () => {
      await seedHistory(60);
      await legacyJob(request('albums'), 'legacy-1');
      await legacyJob(request('songs'), 'legacy-2');
      await legacyJob(request('movies'), 'legacy-3');
      await store.insert([
        { subject: jobSubject('broken'), predicate: CONTROL_PAYLOAD, object: literal('{not-json'), graph: DEFAULT_CONTROL_GRAPH_URI },
        { subject: jobSubject('broken'), predicate: CONTROL_STATUS, object: literal('accepted'), graph: DEFAULT_CONTROL_GRAPH_URI },
      ]);
      expect(await lifecycleKeyTriples()).toBe(60);
      queries.length = 0;

      expect(await publisher().ensureVmPublishIntentIndex()).toBe(3);

      expect(queries.map((q) => q.source)).toEqual([BACKFILL]);             // one read; no `publisher.asyncLift.list`
      expect(queries[0]!.sparql).toContain('NOT EXISTS');
      expect(queries[0]!.payloads).toBe(4);                                 // the three legacy jobs and the malformed row, none of the 60 indexed ones
      expect(await lifecycleKeyTriples()).toBe(63);

      queries.length = 0;
      expect(await publisher().ensureVmPublishIntentIndex()).toBe(0);       // idempotent: nothing left but the malformed row
      expect(queries.map((q) => [q.source, q.payloads])).toEqual([[BACKFILL, 1]]);
      expect(await lifecycleKeyTriples()).toBe(63);
    });

    it('reads nothing but the un-indexed rows of an empty queue too', async () => {
      queries.length = 0;
      expect(await publisher().ensureVmPublishIntentIndex()).toBe(0);
      expect(queries.map((q) => [q.source, q.payloads])).toEqual([[BACKFILL, 0]]);
    });
  });
});
