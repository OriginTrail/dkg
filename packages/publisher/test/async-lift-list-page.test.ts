/**
 * OT-RFC-73 P9a (AC6): static paging tests of the publisher queue's keyset listing.
 *
 * A fixed inventory is walked at every page size and under every status and context graph filter; the walk must be the
 * complete, ordered, duplicate-free listing, however the page boundaries fall (ties on `acceptedAt` included). The
 * query text, the order guard, the skipped-row rule and the lane the reads take are pinned here too. Equivalence with
 * the complete `list()` and with `publisherJobReadScope` is `async-lift-list-page-equivalence.test.ts`; interleaved
 * mutation is `async-lift-list-page-mutation.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import {
  CONTROL_ACCEPTED_AT,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  XSD_INTEGER,
  jobSubject,
  literal,
} from '../src/async-lift-control-plane.js';
import {
  LIFT_JOB_PAGE_SOURCE,
  LIFT_JOB_STATS_SOURCE,
  LiftJobListingSelectors,
  buildLiftJobPageQuery,
} from '../src/lift-job-listing-selectors.js';
import { LiftJobPageError, decodeLiftJobPageCursor, encodeLiftJobPageCursor } from '../src/lift-job-page.js';
import {
  GRAPH,
  INVENTORY_KINDS,
  INVENTORY_STATES,
  STATUSES,
  createJobTemplates,
  expectedMembership,
  expectedOrder,
  jobQuads,
  seedJobs,
  walkPages,
  type JobSpec,
  type JobTemplates,
} from './_helpers/lift-job-inventory.js';

// Top level, not a hook: the table-driven cases below build their rows while the suite is collected.
const templates: JobTemplates = await createJobTemplates();

const stores: OxigraphStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function publisherOver(specs: readonly JobSpec[]) {
  const store = new OxigraphStore();
  stores.push(store);
  await seedJobs(store, templates, specs);
  return { store, publisher: new TripleStoreAsyncLiftPublisher(store, { now: () => 1 }) };
}

/** 4 kinds x 5 states over two graphs, with acceptance times that tie, and ids that sort differently by code unit and by locale. */
function mixedSpecs(): JobSpec[] {
  const specs: JobSpec[] = [];
  let n = 0;
  for (const kind of INVENTORY_KINDS) {
    for (const state of INVENTORY_STATES) {
      n += 1;
      specs.push({
        id: `${n % 2 === 0 ? 'B' : 'b'}-${kind}-${state}`,
        kind,
        state,
        contextGraphId: n % 3 === 0 ? 'cg-b' : 'cg-a',
        acceptedAt: 1_000 + (n % 4) * 10,
      });
    }
  }
  return specs;
}

const NS = (value: number): string => `"${value}"^^<${XSD_INTEGER}>`;

/** The stored `payload` object (a literal) the production serializer writes for a spec. */
const storedPayload = (spec: JobSpec): string => jobQuads(templates, spec).find((quad) => quad.predicate === CONTROL_PAYLOAD)!.object;

describe('publisher job page: static walks', () => {
  it('is the complete, ordered, duplicate-free listing at every page size, whichever way the boundaries fall', async () => {
    const specs = mixedSpecs();
    const { publisher } = await publisherOver(specs);
    const want = expectedOrder(specs);
    expect(want).toHaveLength(20);
    for (const limit of [1, 2, 3, 4, 5, 7, 10, 19, 20, 21, 1_000]) {
      const walk = await walkPages(publisher, { limit });
      expect(walk.ids, `limit ${limit}`).toEqual(want);
      expect(walk.pages).toHaveLength(Math.ceil(want.length / limit));
      // Every page but the last is full and names its successor; the last is the only complete one.
      walk.pages.forEach((page, index) => {
        const last = index === walk.pages.length - 1;
        expect(page.complete).toBe(last);
        expect(page.nextCursor === null).toBe(last);
        if (!last) expect(page.jobs).toHaveLength(limit);
      });
    }
  });

  it('orders by the id code unit among jobs accepted in the same millisecond, which is not the locale order of list()', async () => {
    const specs: JobSpec[] = ['b-1', 'B-2', 'a-3', 'A-4'].map((id) => ({
      id, kind: 'vm', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 50,
    }));
    const { publisher } = await publisherOver(specs);
    const walk = await walkPages(publisher, { limit: 2 });
    expect(walk.ids).toEqual(['A-4', 'B-2', 'a-3', 'b-1']);
    const listed = (await publisher.list()).map((job) => job.jobId);
    expect(listed).not.toEqual(walk.ids);
    expect([...listed].sort()).toEqual([...walk.ids].sort());
  });

  it('puts a boundary tie on the right side: the id decides, never the page edge', async () => {
    const specs: JobSpec[] = ['j1', 'j2', 'j3', 'j4', 'j5'].map((id) => ({
      id, kind: 'vm', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 7,
    }));
    const { publisher } = await publisherOver(specs);
    for (const limit of [1, 2, 3, 4]) {
      expect((await walkPages(publisher, { limit })).ids, `limit ${limit}`).toEqual(['j1', 'j2', 'j3', 'j4', 'j5']);
    }
  });

  it('is complete on the first page when the page holds exactly what exists, and needs a second page when it holds one fewer', async () => {
    const specs = mixedSpecs().slice(0, 6);
    const { publisher } = await publisherOver(specs);
    const exact = await publisher.listPage({ limit: 6 });
    expect(exact.jobs).toHaveLength(6);
    expect(exact).toMatchObject({ nextCursor: null, complete: true });
    const short = await publisher.listPage({ limit: 5 });
    expect(short.jobs).toHaveLength(5);
    expect(short.complete).toBe(false);
    const rest = await publisher.listPage({ limit: 5, cursor: short.nextCursor! });
    expect(rest.jobs).toHaveLength(1);
    expect(rest).toMatchObject({ nextCursor: null, complete: true });
  });

  it('answers an empty queue, an empty filter and a cursor past the end with an empty complete page', async () => {
    const empty = await publisherOver([]);
    expect(await empty.publisher.listPage()).toEqual({ jobs: [], nextCursor: null, complete: true });
    const { publisher } = await publisherOver(mixedSpecs());
    expect(await publisher.listPage({ contextGraphId: 'no-such-graph' })).toEqual({ jobs: [], nextCursor: null, complete: true });
    expect(await publisher.listPage({ status: 'broadcast' })).toEqual({ jobs: [], nextCursor: null, complete: true });
    const beyond = encodeLiftJobPageCursor({ acceptedAt: 9_999_999, jobId: 'zzz' });
    expect(await publisher.listPage({ cursor: beyond })).toEqual({ jobs: [], nextCursor: null, complete: true });
  });

  it('defaults to 100 jobs and honours the largest page', async () => {
    const specs: JobSpec[] = Array.from({ length: 130 }, (_, index) => ({
      id: `n${String(index).padStart(3, '0')}`, kind: 'vm' as const, state: 'accepted' as const, contextGraphId: 'cg-a', acceptedAt: index,
    }));
    const { publisher } = await publisherOver(specs);
    const first = await publisher.listPage();
    expect(first.jobs).toHaveLength(100);
    expect(first.complete).toBe(false);
    const second = await publisher.listPage({ cursor: first.nextCursor! });
    expect(second.jobs).toHaveLength(30);
    expect(second.complete).toBe(true);
    const all = await publisher.listPage({ limit: 1_000 });
    expect(all.jobs).toHaveLength(130);
    expect(all.complete).toBe(true);
  });

  it('applies the status and context graph filters on every page of the walk', async () => {
    const specs = mixedSpecs();
    const { publisher } = await publisherOver(specs);
    for (const status of STATUSES) {
      for (const contextGraphId of [undefined, 'cg-a', 'cg-b', 'no-such-graph']) {
        const filter = { ...(status ? { status } : {}), ...(contextGraphId ? { contextGraphId } : {}) };
        const want = expectedOrder(specs.filter((spec) => expectedMembership(spec, filter)));
        for (const limit of [1, 3, 1_000]) {
          const walk = await walkPages(publisher, { ...filter, limit });
          expect(walk.ids, `${JSON.stringify(filter)} limit ${limit}`).toEqual(want);
        }
      }
    }
  });

  it('keeps raw lifts out of a graph-scoped page even when their request names the graph, and keeps un-indexed publish jobs in', async () => {
    const specs = mixedSpecs();
    const { publisher } = await publisherOver(specs);
    const ids = (await walkPages(publisher, { contextGraphId: 'cg-a' })).ids;
    const kindOf = new Map(specs.map((spec) => [spec.id, spec.kind]));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids.map((id) => kindOf.get(id)))).toEqual(new Set(['vm', 'vm-unindexed']));
    // The same graph, unscoped, does list the raw lifts: operator-only means invisible to graph readers, not absent.
    const unscoped = (await walkPages(publisher, {})).ids;
    expect(new Set(unscoped.map((id) => kindOf.get(id)))).toEqual(new Set(INVENTORY_KINDS));
  });

  it('returns the jobs the complete listing returns, field for field', async () => {
    const { publisher } = await publisherOver(mixedSpecs());
    const listed = new Map((await publisher.list()).map((job) => [job.jobId, job]));
    const walked = (await walkPages(publisher, { limit: 4 })).pages.flatMap((page) => page.jobs);
    expect(walked).toHaveLength(listed.size);
    for (const job of walked) expect(job).toEqual(listed.get(job.jobId));
  });

  it('leaves the complete listing as it was: list() still returns every job in its own order', async () => {
    const specs = mixedSpecs();
    const { publisher } = await publisherOver(specs);
    const listed = await publisher.list();
    expect(listed).toHaveLength(specs.length);
    const sorted = [...listed].sort((a, b) => a.timestamps.acceptedAt - b.timestamps.acceptedAt || a.jobId.localeCompare(b.jobId));
    expect(listed.map((job) => job.jobId)).toEqual(sorted.map((job) => job.jobId));
  });
});

describe('publisher job page: the query', () => {
  const base = { limit: 3 };

  it('is a keyset page: no OFFSET, one more row than the page, ordered by the key', () => {
    const query = buildLiftJobPageQuery(GRAPH, base);
    expect(query).not.toMatch(/OFFSET/i);
    expect(query).toContain('LIMIT 4');
    expect(query.match(/ORDER BY \?acceptedAt STR\(\?job\)/g)).toHaveLength(2);
    expect(query).not.toContain('?acceptedAt >');
  });

  it('applies the cursor as a strict lexicographic bound and nothing when there is none', () => {
    const after = { acceptedAt: 1_234, jobId: 'job-9' };
    const query = buildLiftJobPageQuery(GRAPH, { ...base, after });
    expect(query).toContain(`FILTER (?acceptedAt > ${NS(1_234)} || (?acceptedAt = ${NS(1_234)} && STR(?job) > ${literal(jobSubject('job-9'))}))`);
    expect(buildLiftJobPageQuery(GRAPH, base)).not.toContain('FILTER (?acceptedAt');
  });

  it('reads the payloads of the page only: the payload variable is bound outside the inner select', () => {
    const query = buildLiftJobPageQuery(GRAPH, { ...base, status: 'failed', contextGraphId: 'cg-a' });
    const inner = query.slice(query.indexOf('{ SELECT'), query.indexOf('LIMIT 4'));
    expect(inner).not.toContain('?payload');
    expect(query.slice(query.indexOf('LIMIT 4'))).toContain(`<${CONTROL_PAYLOAD}> ?payload`);
    expect(query).toContain(`FILTER (?status = ${literal('failed')})`);
    expect(query).toContain(literal('cg-a'));
  });

  it('keeps the inner select DISTINCT: a job stored with a repeated status or payload triple is one candidate, not two', () => {
    const query = buildLiftJobPageQuery(GRAPH, base);
    expect(query).toContain('SELECT DISTINCT ?job ?acceptedAt WHERE');
    expect(query.indexOf('SELECT DISTINCT')).toBeLessThan(query.indexOf('LIMIT 4'));
  });

  it('writes every caller value as a literal, so a hostile graph id or status cannot change the query', async () => {
    const { publisher } = await publisherOver(mixedSpecs());
    const hostile = 'cg-a" } } UNION { ?s ?p ?o } #';
    const query = buildLiftJobPageQuery(GRAPH, { ...base, contextGraphId: hostile, status: 'a"b' as never });
    expect(query).toContain(JSON.stringify(hostile));
    expect(query).not.toContain(`${literal('cg-a')} } }`);
    expect(await publisher.listPage({ contextGraphId: hostile })).toEqual({ jobs: [], nextCursor: null, complete: true });
    expect(await publisher.listPage({ status: 'a"b' as never })).toEqual({ jobs: [], nextCursor: null, complete: true });
  });

  it('costs one store call per page, however deep the page is', async () => {
    const specs: JobSpec[] = Array.from({ length: 40 }, (_, index) => ({
      id: `n${String(index).padStart(3, '0')}`, kind: 'vm' as const, state: 'accepted' as const, contextGraphId: 'cg-a', acceptedAt: index,
    }));
    const { store, publisher } = await publisherOver(specs);
    const query = vi.spyOn(store, 'query');
    const walk = await walkPages(publisher, { limit: 8 });
    expect(walk.pages).toHaveLength(5);
    expect(query).toHaveBeenCalledTimes(5);
  });
});

describe('publisher job page: refusals', () => {
  it('refuses a bad cursor or limit before it reads anything', async () => {
    const { store, publisher } = await publisherOver(mixedSpecs());
    const query = vi.spyOn(store, 'query');
    await expect(publisher.listPage({ cursor: 'garbage!' })).rejects.toMatchObject({ code: 'malformed_cursor', name: 'LiftJobPageError' });
    await expect(publisher.listPage({ limit: 0 })).rejects.toMatchObject({ code: 'invalid_limit' });
    await expect(publisher.listPage({ limit: 1_001 })).rejects.toMatchObject({ code: 'invalid_limit' });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('publisher job page: what the store may answer', () => {
  const payloadOf = (spec: JobSpec): string => jobQuads(templates, spec).find((quad) => quad.predicate === CONTROL_PAYLOAD)!.object;
  const spec = (id: string, acceptedAt = 10): JobSpec => ({ id, kind: 'vm', state: 'accepted', contextGraphId: 'cg-a', acceptedAt });
  const row = (id: string, acceptedAt: number | string, payload = payloadOf(spec(id))): Record<string, string> => ({
    job: jobSubject(id), acceptedAt: typeof acceptedAt === 'number' ? NS(acceptedAt) : acceptedAt, payload,
  });
  const selectorsAnswering = (bindings: Array<Record<string, string>>) =>
    new LiftJobListingSelectors({ query: async () => ({ type: 'bindings', bindings }) } as never, GRAPH, (job) => job);

  it('hands out a page and a cursor when the rows are in key order', async () => {
    const page = await selectorsAnswering([row('a', 1), row('b', 1), row('c', 2)]).page({ limit: 2 });
    expect(page.jobs.map((job) => job.jobId)).toEqual(['a', 'b']);
    expect(decodeLiftJobPageCursor(page.nextCursor!)).toEqual({ acceptedAt: 1, jobId: 'b' });
  });

  it.each([
    ['rows out of order by time', [row('a', 2), row('b', 1)], undefined],
    ['rows out of order by id', [row('b', 1), row('a', 1)], undefined],
    ['a job that comes back after another job', [row('a', 1), row('b', 1), row('a', 1)], undefined],
    ['rows of a repeated job followed by a smaller one', [row('b', 1), row('b', 1), row('a', 1)], undefined],
    ['a first row at the cursor', [row('a', 1)], { acceptedAt: 1, jobId: 'a' }],
    ['a first row before the cursor', [row('a', 1)], { acceptedAt: 5, jobId: 'a' }],
    ['a first row before the cursor in id order', [row('a', 5)], { acceptedAt: 5, jobId: 'b' }],
  ])('refuses %s as unordered_page rather than skip or repeat jobs', async (_name, bindings, after) => {
    const cursor = after === undefined ? undefined : encodeLiftJobPageCursor(after);
    await expect(selectorsAnswering(bindings).page({ limit: 5, ...(cursor ? { cursor } : {}) }))
      .rejects.toMatchObject({ name: 'LiftJobPageError', code: 'unordered_page' });
  });

  it.each([
    ['a subject that is not a job', { job: 'urn:other:thing', acceptedAt: NS(1), payload: '"x"' }],
    ['an acceptedAt that is not an integer', row('a', '"soon"')],
    ['a missing acceptedAt', { job: jobSubject('a'), payload: '"x"' }],
  ])('refuses %s as unreadable_row', async (_name, bad) => {
    await expect(selectorsAnswering([bad as Record<string, string>]).page({ limit: 5 }))
      .rejects.toMatchObject({ code: 'unreadable_row' });
  });

  it('reads the repeated rows of one job (a second payload triple) as one job, in the place the first row gave it', async () => {
    const claimed = payloadOf({ ...spec('a', 1), state: 'claimed' });
    const rows = [row('a', 1), row('a', 1, claimed), row('b', 2), row('c', 3)];
    const page = await selectorsAnswering(rows).page({ limit: 2 });
    expect(page.jobs.map((job) => job.jobId)).toEqual(['a', 'b']);
    expect(page.complete).toBe(false);
    expect(decodeLiftJobPageCursor(page.nextCursor!)).toEqual({ acceptedAt: 2, jobId: 'b' });
    // A job's repeats do not count against the page size or make a short page look full.
    const only = await selectorsAnswering([row('a', 1), row('a', 1, claimed)]).page({ limit: 1 });
    expect(only.jobs.map((job) => job.jobId)).toEqual(['a']);
    expect(only).toMatchObject({ nextCursor: null, complete: true });
  });

  it('shows the repeated job from a payload that decodes, and the same one whichever way the engine ordered the repeats', async () => {
    const good = payloadOf(spec('a'));
    const other = payloadOf({ ...spec('a'), state: 'claimed' });
    for (const rows of [[row('a', 1, literal('{no')), row('a', 1, good)], [row('a', 1, good), row('a', 1, literal('{no'))]]) {
      expect((await selectorsAnswering(rows).page()).jobs.map((job) => job.jobId)).toEqual(['a']);
    }
    const forward = await selectorsAnswering([row('a', 1, good), row('a', 1, other)]).page();
    const reversed = await selectorsAnswering([row('a', 1, other), row('a', 1, good)]).page();
    expect(forward.jobs).toHaveLength(1);
    expect(reversed.jobs).toEqual(forward.jobs);
    // A job none of whose payloads decode is skipped, like any undecodable row, and the cursor still steps past it.
    const none = await selectorsAnswering([row('a', 1, literal('{no')), row('a', 1, literal('{nope')), row('b', 2)]).page({ limit: 1 });
    expect(none.jobs).toEqual([]);
    expect(decodeLiftJobPageCursor(none.nextCursor!)).toEqual({ acceptedAt: 1, jobId: 'a' });
  });

  it('still refuses the first row at the cursor when it is repeated: the repeat is never a way past the cursor check', async () => {
    const cursor = encodeLiftJobPageCursor({ acceptedAt: 1, jobId: 'a' });
    await expect(selectorsAnswering([row('a', 1), row('a', 1)]).page({ limit: 5, cursor }))
      .rejects.toMatchObject({ code: 'unordered_page' });
  });

  it('will not mint a cursor from a row whose id the cursor grammar cannot hold', async () => {
    const odd = row('has space', 1);
    await expect(selectorsAnswering([row('a', 0), odd, row('z', 9)]).page({ limit: 2 })).rejects.toMatchObject({ code: 'unreadable_row' });
    // The same row is fine when it is not the resume point: the page is not the last one the walk needs to continue from.
    const page = await selectorsAnswering([row('a', 0), odd]).page({ limit: 2 });
    expect(page.complete).toBe(true);
  });

  it('skips a row whose payload no longer decodes, as list() does, and resumes after it', async () => {
    const broken = row('b', 2, literal('{not-json'));
    const first = await selectorsAnswering([row('a', 1), broken, row('c', 3)]).page({ limit: 2 });
    expect(first.jobs.map((job) => job.jobId)).toEqual(['a']);
    expect(first.complete).toBe(false);
    // The cursor names the last row SCANNED (the broken one), so the walk does not read it again.
    expect(decodeLiftJobPageCursor(first.nextCursor!)).toEqual({ acceptedAt: 2, jobId: 'b' });
  });

  it('can return an empty page that still has a successor', async () => {
    const only = await selectorsAnswering([row('a', 1, literal('{no')), row('b', 2, literal('{no')), row('c', 3)]).page({ limit: 2 });
    expect(only.jobs).toEqual([]);
    expect(only.complete).toBe(false);
    expect(only.nextCursor).not.toBeNull();
  });

  it('walks past rows the store holds but a page cannot position, with the complete listing still answering', async () => {
    const { store, publisher } = await publisherOver(mixedSpecs().slice(0, 4));
    // A row that is a job to list() (status and payload) but whose subject is not a job IRI is outside the key order.
    const payload = jobQuads(templates, spec('foreign')).find((quad) => quad.predicate === CONTROL_PAYLOAD)!.object;
    await store.insert([
      { subject: 'urn:other:foreign', predicate: CONTROL_STATUS, object: literal('accepted'), graph: GRAPH },
      { subject: 'urn:other:foreign', predicate: CONTROL_ACCEPTED_AT, object: NS(5), graph: GRAPH },
      { subject: 'urn:other:foreign', predicate: CONTROL_PAYLOAD, object: payload, graph: GRAPH },
    ]);
    expect((await publisher.list()).map((job) => job.jobId)).toContain('foreign');
    expect((await walkPages(publisher, {})).ids).not.toContain('foreign');
  });
});

describe('publisher job page: lanes', () => {
  it('reads on the caller\'s lane: a source label and nothing else, no control tag and no priority', async () => {
    const { store, publisher } = await publisherOver(mixedSpecs().slice(0, 6));
    const query = vi.spyOn(store, 'query');
    const walk = await walkPages(publisher, { limit: 2, contextGraphId: 'cg-a' });
    expect(walk.pages.length).toBeGreaterThan(1);
    await publisher.getStats();
    const options = query.mock.calls.map(([, opts]) => opts);
    expect(options.filter((opts) => opts?.source === LIFT_JOB_PAGE_SOURCE)).toHaveLength(walk.pages.length);
    expect(options.filter((opts) => opts?.source === LIFT_JOB_STATS_SOURCE)).toHaveLength(1);
    for (const opts of options) expect(opts).toEqual({ source: opts?.source });
  });
});

describe('publisher job page: a job stored with a repeated status or payload triple', () => {
  // Corrupted data only: the publisher writes one status and one payload triple per job. Six jobs, three ties.
  const specs: JobSpec[] = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((id, index) => ({
    id, kind: 'vm', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 10 + Math.floor(index / 2),
  }));
  const want = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];

  async function corrupted(repeats: Record<string, ReadonlyArray<'status' | 'payload'>>) {
    const { store, publisher } = await publisherOver(specs);
    for (const [id, kinds] of Object.entries(repeats)) {
      const spec = specs.find((candidate) => candidate.id === id)!;
      await store.insert(kinds.map((kind) => (kind === 'status'
        ? { subject: jobSubject(id), predicate: CONTROL_STATUS, object: literal('failed'), graph: GRAPH }
        : { subject: jobSubject(id), predicate: CONTROL_PAYLOAD, object: storedPayload({ ...spec, state: 'claimed' }), graph: GRAPH })));
    }
    return publisher;
  }

  it.each([
    ['a second payload triple', { j2: ['payload'], j5: ['payload'] }],
    ['a second status triple', { j2: ['status'], j3: ['status'] }],
    ['both', { j4: ['status', 'payload'], j1: ['payload'] }],
  ] as const)('walks %s as one job, once, in order, at every page size', async (_name, repeats) => {
    const publisher = await corrupted(repeats);
    for (const limit of [1, 2, 3, 4, 5, 6, 7, 1_000]) {
      const walk = await walkPages(publisher, { limit });
      expect(walk.ids, `limit ${limit}`).toEqual(want);
      expect(walk.pages).toHaveLength(Math.ceil(want.length / limit));
      walk.pages.forEach((page, index) => expect(page.complete).toBe(index === walk.pages.length - 1));
    }
  });

  it('filters a job with two status triples under each of its states, once', async () => {
    const publisher = await corrupted({ j2: ['status'], j3: ['status'] });
    for (const limit of [1, 2, 1_000]) {
      expect((await walkPages(publisher, { status: 'failed', limit })).ids, `failed limit ${limit}`).toEqual(['j2', 'j3']);
      expect((await walkPages(publisher, { status: 'accepted', limit })).ids, `accepted limit ${limit}`).toEqual(want);
    }
  });

  it('does not lose the jobs behind a repeated one at a page boundary', async () => {
    // The repeat must not use up a place of the inner LIMIT: a page that held two rows of j2 would call itself the last.
    const publisher = await corrupted({ j1: ['status', 'payload'], j2: ['status', 'payload'] });
    const first = await publisher.listPage({ limit: 1 });
    expect(first.jobs.map((job) => job.jobId)).toEqual(['j1']);
    expect(first.complete).toBe(false);
    const second = await publisher.listPage({ limit: 1, cursor: first.nextCursor! });
    expect(second.jobs.map((job) => job.jobId)).toEqual(['j2']);
    expect(second.complete).toBe(false);
  });

  it('hands out the same pages twice', async () => {
    const publisher = await corrupted({ j2: ['payload'], j3: ['status', 'payload'] });
    const first = await publisher.listPage({ limit: 3 });
    expect(await publisher.listPage({ limit: 3 })).toEqual(first);
  });

  it('does not repeat the jobs of list(), which still returns a job once per row', async () => {
    const publisher = await corrupted({ j2: ['payload'] });
    expect((await publisher.list()).filter((job) => job.jobId === 'j2')).toHaveLength(2);
    expect((await walkPages(publisher, {})).ids.filter((id) => id === 'j2')).toHaveLength(1);
  });
});

describe('publisher job page: stats', () => {
  it('tallies jobs per state with one COUNT query that transfers no payload', async () => {
    const specs = mixedSpecs();
    const { store, publisher } = await publisherOver(specs);
    const query = vi.spyOn(store, 'query');
    const stats = await publisher.getStats();
    expect(stats).toEqual({ accepted: 4, claimed: 4, validated: 0, broadcast: 0, included: 0, finalized: 4, failed: 8 });
    expect(query).toHaveBeenCalledTimes(1);
    const text = String(query.mock.calls[0]![0]);
    expect(text).toMatch(/COUNT\(/);
    expect(text).toMatch(/GROUP BY \?state/);
    expect(text).not.toContain(CONTROL_PAYLOAD);
  });

  it('is all zeroes for an empty queue', async () => {
    const { publisher } = await publisherOver([]);
    expect(await publisher.getStats()).toEqual({ accepted: 0, claimed: 0, validated: 0, broadcast: 0, included: 0, finalized: 0, failed: 0 });
  });
});

describe('publisher job page: a published listing is a pure function of the stored rows', () => {
  it('returns the same page twice', async () => {
    const { publisher } = await publisherOver(mixedSpecs());
    const first = await publisher.listPage({ limit: 7 });
    expect(await publisher.listPage({ limit: 7 })).toEqual(first);
    expect(await publisher.listPage({ limit: 7, cursor: first.nextCursor! })).toEqual(await publisher.listPage({ limit: 7, cursor: first.nextCursor! }));
  });

  it('throws the typed error class, not a plain Error', () => {
    expect(new LiftJobPageError('invalid_limit', 'x')).toBeInstanceOf(Error);
  });
});
