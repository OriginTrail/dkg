/**
 * OT-RFC-73 P11, publisher retention: what the scan and the sibling read make of records they cannot take at face value (split out of async-lift-retention.test.ts,
 * online review 4396942228).
 *
 * A finish time a JS number cannot hold exactly or an engine answers twice, a subject that is no publisher job, and a key whose read holds two records of one job id: each
 * case runs the sweep over a real `TripleStoreAsyncLiftPublisher` and an in-memory store, and checks that the pass is not stalled and that nothing it cannot judge is touched.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import type { PublisherRetentionBatchResult } from '../src/index.js';
import {
  CONTROL_FINALIZED_AT, CONTROL_LIFECYCLE_KEY, CONTROL_PAYLOAD, CONTROL_STATUS, DEFAULT_CONTROL_GRAPH_URI, jobSubject, requestSubject, serializeJob,
} from '../src/async-lift-control-plane.js';
import { decodeLiftJobPayload } from '../src/lift-job-payload-codec.js';
import type { LiftJob } from '../src/lift-job.js';
import { LIFT_JOB_SUBJECT_PREFIX, buildLiftRetentionScanQuery, buildLiftRetentionTieQuery } from '../src/async-lift-retention-scan.js';
import { LiftJobPayloadUnreadableError } from '../src/lift-job-payload-unreadable.js';
import { LiftJobStoreSelectors, lifecycleKeyOfJob, parseInventoryPayload } from '../src/lift-job-store-selectors.js';
import { bindingJobIds } from '../src/async-lift-lifecycle-siblings.js';
import {
  DAY, NOW, WINDOW, at, createRetentionTemplates, fin, graphFingerprint, keyedQuads, present, seedKeyed, seedWalletLock, spyStore, stampKeyed, type KeyedSpec, type RetentionTemplates,
} from './_helpers/lift-retention-fixtures.js';
import {
  RETENTION, deletedIds, drain, kept, newRetention, publisherOver, removedJobIds, verifiedSubjects, wouldDeleteIds,
} from './_helpers/lift-retention-sweep.js';

let templates: RetentionTemplates;
beforeAll(async () => { templates = await createRetentionTemplates(); });

const stores: OxigraphStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

describe('finish times a JS number cannot hold exactly, and repeated rows (online review round 1: 4394031868, 4394031890)', () => {
  // The cursor holds a JS number and the engine compares terms exactly. Before the scan read `xsd:integer` finish times only, a decimal that a double rounds
  // (`100.0000000000000001`) came back after a cursor at 100 forever, and a job indexed at 100 and 100.0 came back twice in the tie walk at 100: either was an anomaly on every
  // call, and the job at 200 behind it was never reached. The retained record J is a finalized job of its own key whose finish-time index the case writes; E, at 200, can go.
  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  const int = (n: number) => `"${n}"^^<${XSD}integer>`;
  const dec = (lexical: string) => `"${lexical}"^^<${XSD}decimal>`;
  const J: KeyedSpec = { id: 'J', key: 'kj', state: 'finalized', acceptedAt: 50, finalizedAt: 100 };
  const E: KeyedSpec = { id: 'E', key: 'ke', state: 'finalized', acceptedAt: 150, finalizedAt: 200 };
  const withFinishTerms = (spec: KeyedSpec, terms: readonly string[]): Quad[] =>
    keyedQuads(templates, spec).flatMap((quad) => (quad.predicate === CONTROL_FINALIZED_AT ? terms.map((object) => ({ ...quad, object })) : [quad]));
  /** At most `max` calls, stopping when the pass is over or a call failed. */
  const calls = async (retention: ReturnType<typeof newRetention>, max = 6): Promise<PublisherRetentionBatchResult[]> => {
    const results: PublisherRetentionBatchResult[] = [];
    for (let i = 0; i < max; i++) { const res = await retention.runBatch(); results.push(res); if (!res.hasMore || res.error) break; }
    return results;
  };
  const CASES: ReadonlyArray<{ label: string; terms: string[]; judgedJ: number }> = [
    { label: 'J indexed at the integer 100 and the decimal 100.0 (equal in every engine)', terms: [int(100), dec('100.0')], judgedJ: 1 },
    { label: 'J indexed at the decimals 100.0000000000000001 and 100.0000000000000002 (both 100 as doubles)', terms: [dec('100.0000000000000001'), dec('100.0000000000000002')], judgedJ: 0 },
    { label: 'J indexed at two integers, 100 and 300', terms: [int(100), int(300)], judgedJ: 2 },
    { label: 'J indexed at the decimal 100.0000000000000001 alone (the review\'s repro)', terms: [dec('100.0000000000000001')], judgedJ: 0 },
  ];

  it.each(CASES.flatMap((c) => (['delete', 'report'] as const).map((mode) => [c.label, mode, c] as const)))('%s, %s mode: J stays untouched, E behind it is reached, the pass completes in at most 3 calls at batch size 1 and 2, no anomaly', async (_label, mode, c) => {
    for (const batchSize of [1, 2]) {
      const store = new OxigraphStore();
      stores.push(store);
      await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
      await store.insert([...withFinishTerms(J, c.terms), ...keyedQuads(templates, E)]);
      const before = await present(store, 'J');
      const retention = newRetention(publisherOver(store), { mode, batchSize });
      const results = await calls(retention);
      const where = `batch size ${batchSize}: ${results.length} calls, anomalies ${results.map((r) => r.anomalies).join(',')}`;
      expect(results.at(-1)!.hasMore, where).toBe(false);
      expect(results.length, where).toBeLessThanOrEqual(3);
      expect(results.every((r) => r.anomalies === 0 && r.error === undefined), where).toBe(true);
      expect(results.filter((r) => r.passCompleted), where).toHaveLength(1);
      expect(mode === 'delete' ? deletedIds(results) : wouldDeleteIds(results), where).toEqual(['E']);
      expect(mode === 'delete' ? wouldDeleteIds(results) : deletedIds(results), where).toEqual([]);
      expect(await present(store, 'J'), where).toBe(before);
      // a J the scan can read (it has an integer finish time) is judged at each one an answer holds, and kept: its index does not match its one payload; one it cannot read is not a candidate at all
      expect(kept(results), where).toEqual(c.judgedJ > 0 ? { index_mismatch: c.judgedJ } : {});
      expect(results.reduce((n, r) => n + r.scanned, 0), where).toBe(1 + c.judgedJ);
      expect(retention.counters().lastCompletePass, where).toMatchObject(mode === 'delete' ? { deleted: { finalized: 1 }, wouldDelete: { finalized: 0 } } : { deleted: { finalized: 0 }, wouldDelete: { finalized: 1 } });
    }
  });

  it.each(['delete', 'report'] as const)('%s mode: an engine that answers one subject twice (two integer forms of one value, "100" and "0100", which Oxigraph merges, so the repeat is made on its answer) judges it once and reaches the job behind it', async (mode) => {
    // J is retained by a wallet lock, so neither mode removes it. Batch size 1: the window of the range scan is J twice, so the walk enters the tie at 100, whose answer is J twice too.
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [J, E]);
    await seedWalletLock(store, 'J', 'wallet-1', 'released');
    const before = await present(store, 'J');
    const served: string[][] = [];
    const spy = spyStore(store, {
      rewrite: async (entry, run) => {
        if (entry.source !== `${RETENTION}scan`) return run();
        const all = await store.query(entry.text.replace(/ LIMIT \d+$/, ''));
        if (all.type !== 'bindings') return all;
        const bindings = all.bindings.flatMap((b) => (b['job'] === jobSubject('J') ? [b, b] : [b])).slice(0, Number(/LIMIT (\d+)$/.exec(entry.text)![1]));
        served.push(bindings.map((b) => String(b['job']).slice(jobSubject('').length)));
        return { ...all, bindings };
      },
    });
    const retention = newRetention(publisherOver(spy.store), { mode, batchSize: 1 });
    const results = await calls(retention);
    const where = `${results.length} calls, anomalies ${results.map((r) => r.anomalies).join(',')}, served ${JSON.stringify(served)}`;
    expect(served.some((ids) => ids.length === 2 && ids[0] === 'J' && ids[1] === 'J'), `the engine repeated J (${where})`).toBe(true);
    expect(results.at(-1)!.hasMore, where).toBe(false);
    expect(results.length, where).toBeLessThanOrEqual(4);
    expect(results.every((r) => r.anomalies === 0 && r.error === undefined), where).toBe(true);
    expect(results.filter((r) => r.passCompleted), where).toHaveLength(1);
    expect(verifiedSubjects(spy.log), where).toEqual([jobSubject('J'), jobSubject('E')]);            // each judged once, in order
    expect(kept(results), where).toEqual({ bound_obligation: 1 });
    expect(mode === 'delete' ? deletedIds(results) : wouldDeleteIds(results), where).toEqual(['E']);
    expect(await present(store, 'J'), where).toBe(before);
  });
});

describe('subjects that are not publisher jobs cannot stall a pass (verification of online review round 1: the share scan\'s subject filter, P10a cdfd3448a)', () => {
  // A foreign writer's subject that carries the finalized status and an integer finish time. A blank node has no STR, so ORDER BY STR(?job) leaves its rows in engine order and the
  // key check of the tie walk rejects them; an IRI outside the job prefix that mixes astral and high BMP characters is ordered by code point in Oxigraph and by UTF-16 in the key check.
  // Before the scan read IRIs under the job prefix only, either was an anomaly on every call, and the job behind it was never reached.
  const XSD_INT = '^^<http://www.w3.org/2001/XMLSchema#integer>';
  const T = Math.round(10 * DAY);
  const E = fin('E', 'ke', 20);
  const foreign = (subject: string, finalizedAt = T): Quad[] => [
    { subject, predicate: CONTROL_STATUS, object: '"finalized"', graph: DEFAULT_CONTROL_GRAPH_URI },
    { subject, predicate: CONTROL_FINALIZED_AT, object: `"${finalizedAt}"${XSD_INT}`, graph: DEFAULT_CONTROL_GRAPH_URI },
  ];
  const tieGroup = (subjects: readonly string[]): Quad[] => subjects.flatMap((subject) => foreign(subject));
  async function storeWith(quads: readonly Quad[]): Promise<OxigraphStore> {
    const store = new OxigraphStore();
    stores.push(store);
    await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
    await store.insert([...quads]);
    return store;
  }
  /** Every triple of the control graph except those of the real jobs named in `jobs` (job and request subjects), as sorted lines: what a sweep must leave as it found it. */
  const notJobs = async (store: OxigraphStore, ...jobs: string[]): Promise<string> => {
    const skip = new Set(jobs.flatMap((id) => [jobSubject(id), requestSubject(id)]));
    const r = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { ?s ?p ?o } }`);
    return r.type === 'bindings' ? r.bindings.filter((b) => !skip.has(b['s']!)).map((b) => `${b['s']} ${b['p']} ${b['o']}`).sort().join('\n') : '';
  };
  const calls = async (retention: ReturnType<typeof newRetention>, max = 12): Promise<PublisherRetentionBatchResult[]> => {
    const results: PublisherRetentionBatchResult[] = [];
    for (let i = 0; i < max; i++) { const res = await retention.runBatch(); results.push(res); if (!res.hasMore || res.error) break; }
    return results;
  };
  const passOf = (mode: 'delete' | 'report', n: number) => (mode === 'delete' ? { deleted: { finalized: n }, wouldDelete: { finalized: 0 } } : { deleted: { finalized: 0 }, wouldDelete: { finalized: n } });

  it.each(['delete', 'report'] as const)('%s mode: five blank nodes sharing one finish time (a tie group larger than the batch) in front of an eligible job: the job is reached, the pass completes, no anomaly, the blank nodes are untouched', async (mode) => {
    for (const batchSize of [1, 2, 3, 4]) {
      const store = await storeWith([...tieGroup(['_:b1', '_:b2', '_:b3', '_:b4', '_:b5']), ...keyedQuads(templates, E)]);
      const foreignBefore = await notJobs(store, 'E');
      expect(foreignBefore.split('\n')).toHaveLength(10);
      const retention = newRetention(publisherOver(store), { mode, batchSize });
      const results = await calls(retention);
      const at = `batch size ${batchSize}: ${results.length} calls, anomalies ${results.map((r) => r.anomalies).join(',')}, scanned ${results.map((r) => r.scanned).join(',')}`;
      expect(results.at(-1)!.hasMore, at).toBe(false);
      expect(results.every((r) => r.anomalies === 0 && r.error === undefined), at).toBe(true);
      expect(retention.counters().anomalies, at).toBe(0);
      expect(results.filter((r) => r.passCompleted), at).toHaveLength(1);
      expect(results.reduce((n, r) => n + r.scanned, 0), `${at}: the blank nodes are not candidates, the job is`).toBe(1);
      expect(mode === 'delete' ? deletedIds(results) : wouldDeleteIds(results), at).toEqual(['E']);
      expect((await present(store, 'E')) !== '', at).toBe(mode !== 'delete');
      expect(retention.counters().lastCompletePass, at).toMatchObject({ ...passOf(mode, 1), kept: { unreadable: 0 } });
      expect(await notJobs(store, 'E'), `${at}: the blank nodes are untouched`).toBe(foreignBefore);
    }
  });

  it('blank nodes among distinct finish times (the range scan, no tie group) are no candidates either: never judged, never counted, never deleted', async () => {
    const store = await storeWith([...foreign('_:early', Math.round(5 * DAY)), ...foreign('_:mid', Math.round(15 * DAY)), ...keyedQuads(templates, fin('E1', 'k1', 10)), ...keyedQuads(templates, fin('E2', 'k2', 20))]);
    const foreignBefore = await notJobs(store, 'E1', 'E2');
    const retention = newRetention(publisherOver(store), { batchSize: 2 });
    const results = await calls(retention);
    expect(results.at(-1)!.hasMore).toBe(false);
    expect(results.every((r) => r.anomalies === 0 && r.error === undefined)).toBe(true);
    expect(results.reduce((n, r) => n + r.scanned, 0)).toBe(2);
    expect(retention.counters().lastCompletePass).toMatchObject({ scanned: 2, deleted: { finalized: 2 }, kept: { unreadable: 0 } });
    expect(await notJobs(store, 'E1', 'E2')).toBe(foreignBefore);
  });

  // The engine labels a blank node afresh in every store, so where its rows land among the real jobs of a group varies from store to store: eight stores.
  it('a tie group that mixes blank nodes and real jobs: every real job of the group is judged once, the blank nodes are skipped (eight stores, the engine labels blank nodes afresh)', async () => {
    const jobs = ['m1', 'm2', 'm3', 'm4'];
    for (let attempt = 0; attempt < 8; attempt++) {
      const store = await storeWith([...tieGroup(['_:x1', '_:x2', '_:x3']), ...jobs.flatMap((id) => keyedQuads(templates, { ...fin(id, `key-${id}`, 5), finalizedAt: T }))]);
      const foreignBefore = await notJobs(store, ...jobs);
      const spy = spyStore(store);
      const results = await calls(newRetention(publisherOver(spy.store), { batchSize: 2 }), 20);
      expect(results.at(-1)!.hasMore, `store ${attempt}`).toBe(false);
      expect(results.every((r) => r.anomalies === 0 && r.error === undefined), `store ${attempt}`).toBe(true);
      expect(verifiedSubjects(spy.log).sort(), `store ${attempt}`).toEqual(jobs.map((id) => jobSubject(id)));
      for (const id of jobs) expect(await present(store, id), `store ${attempt}: ${id}`).toBe('');
      expect(await notJobs(store, ...jobs), `store ${attempt}: the three blank nodes are as they were`).toBe(foreignBefore);
    }
  });

  // An IRI outside the job prefix is no publisher job either. An ASCII one was already kept safely (as unreadable, once each), but one that mixes astral and high BMP characters
  // stalled the pass: an engine orders it by code point and the key check by UTF-16.
  it.each(['delete', 'report'] as const)('%s mode: IRI subjects with another prefix sharing one finish time (ASCII, and mixing astral and high BMP characters), in front of an eligible job: not read, the job is reached, no anomaly, untouched', async (mode) => {
    const others = [
      ['ASCII', ['urn:other:job:o1', 'urn:dkg:publisher:lift-request:o2', 'urn:dkg:publisher:lift-jobs:o3', 'http://example.org/job/o4', 'urn:dkg:publisher:lift-job']],
      ['astral and high BMP', ['urn:other:～', 'urn:other:\u{1F600}', 'urn:other:a', 'urn:other:\u{10000}', 'urn:other:｟']],
    ] as const;
    for (const [label, subjects] of others) for (const batchSize of [1, 2, 3]) {
      const store = await storeWith([...tieGroup(subjects), ...keyedQuads(templates, E)]);
      const foreignBefore = await notJobs(store, 'E');
      const spy = spyStore(store);
      const retention = newRetention(publisherOver(spy.store), { mode, batchSize });
      const results = await calls(retention);
      const at = `${label}, batch size ${batchSize}: ${results.length} calls, anomalies ${results.map((r) => r.anomalies).join(',')}`;
      expect(results.at(-1)!.hasMore, at).toBe(false);
      expect(results.every((r) => r.anomalies === 0 && r.error === undefined), at).toBe(true);
      expect(results.reduce((n, r) => n + r.scanned, 0), `${at}: the foreign subjects are not candidates`).toBe(1);
      expect(verifiedSubjects(spy.log), `${at}: only the publisher job IRI is ever verified`).toEqual([jobSubject('E')]);
      expect(removedJobIds(spy.log), at).toEqual(mode === 'delete' ? ['E'] : []);
      expect(retention.counters().lastCompletePass, at).toMatchObject({ ...passOf(mode, 1), kept: { unreadable: 0 } });
      expect(await notJobs(store, 'E'), at).toBe(foreignBefore);
    }
  });

  // The limit that stays: under the job prefix a non-ASCII id needs a foreign writer (the queue's ids are ASCII, `isSafeJobId`), and an engine that orders such ids by code point
  // disagrees with the key check, which reads UTF-16. The scan fails closed: an anomaly on every call that meets the pair, no cursor moves, nothing foreign is touched.
  it('in-prefix IRI subjects with astral and high BMP characters (needs a foreign writer) fail closed: anomalies, no pass completes, nothing foreign is touched', async () => {
    const store = await storeWith([...tieGroup(['～', '\u{1F600}', 'a'].map((id) => jobSubject(id))), ...keyedQuads(templates, E)]);
    const foreignBefore = await notJobs(store, 'E');
    const retention = newRetention(publisherOver(store), { mode: 'report', batchSize: 1 });
    const results = await calls(retention, 6);
    expect(results.at(-1)!.hasMore).toBe(true);
    expect(results.some((r) => r.anomalies > 0)).toBe(true);
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(retention.counters().lastCompletePass).toBeUndefined();
    expect(await notJobs(store, 'E')).toBe(foreignBefore);
  });

  it('the scan and tie queries select IRI subjects under the job prefix only', () => {
    const prefix = `FILTER (STRSTARTS(STR(?job), ${JSON.stringify(LIFT_JOB_SUBJECT_PREFIX)}))`;
    for (const query of [
      buildLiftRetentionScanQuery(DEFAULT_CONTROL_GRAPH_URI, NOW - WINDOW, 5), buildLiftRetentionScanQuery(DEFAULT_CONTROL_GRAPH_URI, NOW - WINDOW, 5, { after: 7 }),
      buildLiftRetentionTieQuery(DEFAULT_CONTROL_GRAPH_URI, 42, 10), buildLiftRetentionTieQuery(DEFAULT_CONTROL_GRAPH_URI, 42, 10, jobSubject('a')),
    ]) {
      expect(query).toContain('FILTER (isIRI(?job))');
      expect(query).toContain(prefix);
    }
  });
});

describe('two records of one job id: the key is kept whole, whatever order the engine returns its rows in (online review round 3: 4396325296)', () => {
  // Admission's read keeps one record per job id, the last row's. With two records of one id, the engine's row order decides which one admission sees, and the
  // sweep, which reads the key the same way, would judge the binding from that one alone: delete the record it saw, and the hidden one can bind the key.
  /** The quads of `spec` (by default as `keyedQuads` writes them) stored under the subjects of job `subjectId`: its payload still names `spec.id`. */
  const storedUnder = (spec: KeyedSpec, subjectId: string, quads = keyedQuads(templates, spec)): Quad[] => quads.map((quad) => ({
    ...quad,
    subject: quad.subject === jobSubject(spec.id) ? jobSubject(subjectId) : quad.subject === requestSubject(spec.id) ? requestSubject(subjectId) : quad.subject,
    object: quad.object === `<${requestSubject(spec.id)}>` ? `<${requestSubject(subjectId)}>` : quad.object,
  }));
  /** The quads without their lifecycle-key triples: the record of a job stored before the key was indexed, which the read reaches through its legacy branch (on in a fresh store). */
  const unkeyed = (quads: Quad[]): Quad[] => quads.filter((quad) => quad.predicate !== CONTROL_LIFECYCLE_KEY);
  /** The quads of `spec`'s failed job written the pre-upgrade way (a legacy-v0 payload with no claim or validation), which the decoder reads as `compatibility`. */
  const legacyV0Failed = (spec: KeyedSpec): Quad[] => {
    const { claim: _claim, validation: _validation, ...job } = stampKeyed(templates, spec) as unknown as Record<string, unknown>;
    const failure = { ...(job['failure'] as Record<string, unknown>), failedFromState: 'claimed' };
    const quads = serializeJob({ ...job, failure } as unknown as LiftJob, DEFAULT_CONTROL_GRAPH_URI, { payloadSchema: 'legacy-v0' });
    const decoded = decodeLiftJobPayload(quads.find((quad) => quad.predicate === CONTROL_PAYLOAD)?.object);
    if (decoded.kind !== 'compatibility') throw new Error(`fixture: ${spec.id}'s legacy-v0 failed payload decodes as ${decoded.kind}, not compatibility`);
    return quads;
  };
  /** Job f's two payloads with every other job's rows between them: the rows of f's other payload first, then the other jobs', then those of f's payload in the named status. */
  const SPLIT_ORDERS = ['split, f finalized last', 'split, f failed last'] as const;
  type RowOrder = 'engine' | 'ascending' | 'descending' | (typeof SPLIT_ORDERS)[number];
  const splitAroundF = (rows: Array<Record<string, string>>, order: (typeof SPLIT_ORDERS)[number]): Array<Record<string, string>> => {
    const last = order === 'split, f finalized last' ? 'finalized' : 'failed';
    const part = (row: Record<string, string>): number => { const job = parseInventoryPayload(row['payload']); return job?.jobId !== 'f' ? 1 : job.status === last ? 2 : 0; };
    return [0, 1, 2].flatMap((n) => rows.filter((row) => part(row) === n));
  };
  /**
   * `store` with the rows of every sibling read (the one query that binds `?indexed`) in the engine's order, sorted by payload text or split: each of two payloads of one job
   * id is the last row in one of the sorted orders, which keep the rows of one id together, and a split order puts another job's rows between f's two payloads. `seen` gets
   * the records of each answer the stub rewrites, in its order (`id:status`, one per run of rows with one payload).
   */
  const siblingRowsIn = (store: OxigraphStore, order: RowOrder, seen?: string[][]): OxigraphStore => (order === 'engine' ? store : spyStore(store, {
    rewrite: async (entry, run) => {
      const answer = await run();
      if (answer.type !== 'bindings' || !entry.text.includes('?indexed')) return answer;
      const sorted = [...answer.bindings].sort((a, b) => (a['payload']! < b['payload']! ? -1 : a['payload']! > b['payload']! ? 1 : 0));
      const bindings = order === 'ascending' ? sorted : order === 'descending' ? sorted.reverse() : splitAroundF(sorted, order);
      seen?.push(bindings.filter((row, i) => row['payload'] !== bindings[i - 1]?.['payload']).map((row) => {
        const job = parseInventoryPayload(row['payload']);
        return job === null ? 'undecodable' : `${job.jobId}:${job.status}`;
      }));
      return { ...answer, bindings };
    },
  }).store);
  /** Admission's own read of the key named `name` (`vmPublishAdmissionCandidates`) and the binding it answers with, in the given row orders (by default the two sorted ones). */
  const admissionViews = async (store: OxigraphStore, name: string, orders: readonly RowOrder[] = ['ascending', 'descending']): Promise<string[]> => {
    const key = lifecycleKeyOfJob(stampKeyed(templates, fin('probe', name, 1)))!;
    const views: string[] = [];
    for (const order of orders) {
      const records = await new LiftJobStoreSelectors(siblingRowsIn(store, order), DEFAULT_CONTROL_GRAPH_URI, (job) => job).vmPublishAdmissionCandidates(key);
      views.push(`records ${records.map((job) => `${job.jobId}:${job.status}`).sort().join(' ')}, binds ${bindingJobIds(records, key).join(' ') || 'nothing'}`);
    }
    return views;
  };
  const CASES: Array<readonly [string, () => Quad[][], Record<string, number>]> = [
    ['subject z holds an older retryable failed payload of job f, subject f the old finalized job f (the review\'s case)',
      () => [keyedQuads(templates, fin('f', 'key', 10)), storedUnder(at('f', 'key', 'retryable', 5), 'z')], { siblings_unreadable: 1 }],
    ['one id with no subject mismatch: subject f holds two payloads of job f, a newer finalized one and an older retryable failed one, next to the old finalized g',
      () => [keyedQuads(templates, fin('g', 'key', 20)), keyedQuads(templates, fin('f', 'key', 30)), keyedQuads(templates, at('f', 'key', 'retryable', 10))], { unreadable: 1, siblings_unreadable: 1 }],
    // Each row below pins one part of the check (verification of round 3): every row the read returns is checked, from either branch and whatever its payload's schema,
    // and the refusal keeps every candidate of the key, not only the first.
    ['the review\'s case with both records stored without their lifecycle-key triples, read through the legacy branch (its rows bind no ?indexed)',
      () => [unkeyed(keyedQuads(templates, fin('f', 'key', 10))), unkeyed(storedUnder(at('f', 'key', 'retryable', 5), 'z'))], { siblings_unreadable: 1 }],
    ['the review\'s case with z\'s failed payload of job f written the pre-upgrade way, which decodes as compatibility',
      () => [keyedQuads(templates, fin('f', 'key', 10)), storedUnder(at('f', 'key', 'retryable', 5), 'z', legacyV0Failed(at('f', 'key', 'retryable', 5)))], { siblings_unreadable: 1 }],
    ['the review\'s case with a second old finalized candidate in the key, g, finished before f: both candidates are kept',
      () => [keyedQuads(templates, fin('g', 'key', 8)), keyedQuads(templates, fin('f', 'key', 10)), storedUnder(at('f', 'key', 'retryable', 5), 'z')], { siblings_unreadable: 2 }],
    ['one id, two payloads in one status: subject f holds two retryable failed payloads of job f (accepted day 30 and day 10), next to the old finalized g (day 20)',
      () => [keyedQuads(templates, fin('g', 'key', 20)), keyedQuads(templates, at('f', 'key', 'retryable', 30)), keyedQuads(templates, at('f', 'key', 'retryable', 10))], { siblings_unreadable: 1 }],
  ];

  it.each(CASES.flatMap(([label, records, reasons]) => (['delete', 'report'] as const).map((mode) => [label, mode, records, reasons] as const)))('%s, %s mode: every record stays and admission answers as before, in every row order', async (_label, mode, records, reasons) => {
    for (const insertion of ['as listed', 'reversed'] as const) {
      for (const order of ['engine', 'ascending', 'descending'] as const) {
        const where = `inserted ${insertion}, sibling rows in ${order} order`;
        const store = new OxigraphStore();
        stores.push(store);
        await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
        for (const quads of insertion === 'as listed' ? records() : records().reverse()) await store.insert(quads);
        const graph = await graphFingerprint(store, DEFAULT_CONTROL_GRAPH_URI);
        const views = await admissionViews(store, 'key');
        expect(views[0], `${where}: each sorted order shows admission the other record of the id`).not.toBe(views[1]);
        const results = await drain(newRetention(publisherOver(siblingRowsIn(store, order)), { mode }));
        // soft: a failure names every insertion and row order that fails, not only the first
        expect.soft(results.every((r) => r.error === undefined), where).toBe(true);
        expect.soft([...deletedIds(results), ...wouldDeleteIds(results)], where).toEqual([]);
        expect.soft(kept(results), where).toEqual(reasons);
        expect.soft(await graphFingerprint(store, DEFAULT_CONTROL_GRAPH_URI) === graph, `${where}: both records of the id stay, byte for byte`).toBe(true);
        expect.soft(await admissionViews(store, 'key'), `${where}: admission binds what it bound, in either row order`).toEqual(views);
      }
    }
  });

  // Verification of round 3, second pass: every row above reaches the check with the two payloads of one id as adjacent rows, and two mutants of its two-payloads test
  // passed them all (comparing each row only with the row before it, and forgetting the ids it has seen once it holds two). Here g's rows sit between f's two payloads.
  it.each((['delete', 'report'] as const).flatMap((mode) => SPLIT_ORDERS.map((order) => [mode, order] as const)))('subject f holds two payloads of job f and the engine returns g\'s row between them, %s mode, sibling rows in %s order: every record stays and admission answers as before', async (mode, order) => {
    const records = (): Quad[][] => [keyedQuads(templates, fin('g', 'key', 20)), keyedQuads(templates, fin('f', 'key', 30)), keyedQuads(templates, at('f', 'key', 'retryable', 10))];
    const between = order === 'split, f finalized last' ? ['f:failed', 'g:finalized', 'f:finalized'] : ['f:finalized', 'g:finalized', 'f:failed'];
    for (const insertion of ['as listed', 'reversed'] as const) {
      const where = `inserted ${insertion}`;
      const store = new OxigraphStore();
      stores.push(store);
      await store.createGraph(DEFAULT_CONTROL_GRAPH_URI);
      for (const quads of insertion === 'as listed' ? records() : records().reverse()) await store.insert(quads);
      const graph = await graphFingerprint(store, DEFAULT_CONTROL_GRAPH_URI);
      const views = await admissionViews(store, 'key', SPLIT_ORDERS);
      expect(views[0], `${where}: each split order shows admission the other record of f`).not.toBe(views[1]);
      const seen: string[][] = [];
      const results = await drain(newRetention(publisherOver(siblingRowsIn(store, order, seen)), { mode }));
      expect(seen.length, `${where}: the sweep read the key`).toBeGreaterThan(0);
      for (const read of seen) expect(read, `${where}: the sweep's read has g's record between f's two`).toEqual(between);
      expect.soft(results.every((r) => r.error === undefined), where).toBe(true);
      expect.soft([...deletedIds(results), ...wouldDeleteIds(results)], where).toEqual([]);
      expect.soft(kept(results), where).toEqual({ unreadable: 1, siblings_unreadable: 1 });
      expect.soft(await graphFingerprint(store, DEFAULT_CONTROL_GRAPH_URI) === graph, `${where}: every record stays, byte for byte`).toBe(true);
      expect.soft(await admissionViews(store, 'key', SPLIT_ORDERS), `${where}: admission binds what it bound, in either split order`).toEqual(views);
    }
  });

  it('the sweep\'s read refuses the key with the error type of an unreadable record; admission\'s read is unchanged and still answers', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await seedKeyed(store, templates, [fin('f', 'key', 10)]);
    await store.insert(storedUnder(at('f', 'key', 'retryable', 5), 'z'));
    const key = lifecycleKeyOfJob(stampKeyed(templates, fin('f', 'key', 10)))!;
    const refusal = await publisherOver(store).retentionAccess().runClaimTransaction((tx) => tx.siblings(key)).then(() => undefined, (cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(LiftJobPayloadUnreadableError);
    expect((refusal as Error).message).toBe(`Malformed persisted LiftJob payload: subject ${jobSubject('z')} holds a payload of job f`);
    expect((await admissionViews(store, 'key')).sort()).toEqual(['records f:failed, binds f', 'records f:finalized, binds nothing']);
  });
});
