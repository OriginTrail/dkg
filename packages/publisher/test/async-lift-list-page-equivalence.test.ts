/**
 * OT-RFC-73 P9a: the page is the complete listing, cut into pieces.
 *
 * Three questions, each answered against an independent oracle:
 *
 *  1. Scope. Does the SPARQL context-graph filter select exactly what `publisherJobReadScope` admits to a graph-scoped
 *     listing, for publish jobs (indexed or not) and for raw lifts (current or legacy v0 payload), including raw lifts
 *     whose request names the very graph being listed? Checked three ways: against the specs (what each job IS), against
 *     `publisherJobReadScope` applied to the decoded jobs of the complete `list()`, and on the SPARQL pre-filter ALONE
 *     (no code-side re-check), so the re-check is shown to be a backstop that never has to remove anything from a
 *     publisher-written inventory.
 *  2. Membership. Does a walk of pages hold exactly the jobs `list(filter)` returns, in the page order, once each?
 *  3. Stats. Does the COUNT tally what the list-based tally it replaces did?
 *
 * Each runs over a fixed mixed inventory and as a property over random ones (100 cases per run, 1,000 nightly).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import {
  CONTROL_CONTEXT_GRAPH_ID,
  CONTROL_HAS_REQUEST,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  CONTROL_SWM_ID,
  jobSubject,
  literal,
  requestSubject,
} from '../src/async-lift-control-plane.js';
import { LIFT_JOB_STATES, type LiftJobState } from '../src/lift-job-states.js';
import { publisherJobReadScope } from '../src/async-lift-publisher-utils.js';
import { buildLiftJobPageQuery } from '../src/lift-job-listing-selectors.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';
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
  type InventoryKind,
  type InventoryState,
  type JobFilter,
  type JobSpec,
} from './_helpers/lift-job-inventory.js';

const templates = await createJobTemplates();
const opened: OxigraphStore[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((store) => store.close()));
});

async function inventory(specs: readonly JobSpec[]) {
  const store = new OxigraphStore();
  opened.push(store);
  await seedJobs(store, templates, specs);
  return { store, publisher: new TripleStoreAsyncLiftPublisher(store, { now: () => 1 }) };
}

/** Subjects the SPARQL pre-filter alone selects: the page query with room for every job, rows read as they come. */
async function preFilterIds(store: OxigraphStore, filter: JobFilter, query = buildLiftJobPageQuery): Promise<string[]> {
  const result = await store.query(query(GRAPH, { ...filter, limit: 1_000 }));
  if (result.type !== 'bindings') throw new Error('expected bindings');
  return result.bindings.map((row) => row['job']!.slice(jobSubject('').length));
}

/** What the complete listing's own scope rule admits: decode, ask `publisherJobReadScope`, never a query. */
function admittedByScope(jobs: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['list']>>, filter: JobFilter): string[] {
  return jobs
    .filter((job) => filter.status === undefined || job.status === filter.status)
    .filter((job) => {
      if (filter.contextGraphId === undefined) return true;
      const scope = publisherJobReadScope(job);
      return scope.kind === 'context-graph' && scope.contextGraphId === filter.contextGraphId;
    })
    .map((job) => job.jobId);
}

/** The tally `getStats` used before it became a COUNT. */
async function listTally(publisher: TripleStoreAsyncLiftPublisher): Promise<Record<LiftJobState, number>> {
  const stats = Object.fromEntries(LIFT_JOB_STATES.map((state) => [state, 0])) as Record<LiftJobState, number>;
  for (const job of await publisher.list()) stats[job.status] += 1;
  return stats;
}

const sortById = (ids: readonly string[]): string[] => [...ids].sort();

const GRAPHS = ['cg-a', 'cg-b', 'cg-c'] as const;

function fixedSpecs(): JobSpec[] {
  const specs: JobSpec[] = [];
  let n = 0;
  for (const kind of INVENTORY_KINDS) {
    for (const state of INVENTORY_STATES) {
      for (const contextGraphId of GRAPHS) {
        n += 1;
        specs.push({ id: `${kind}-${state}-${contextGraphId}`, kind, state, contextGraphId, acceptedAt: 500 + (n % 5) });
      }
    }
  }
  return specs;
}

describe('publisher job page: the context graph filter is publisherJobReadScope', () => {
  it('selects the publish jobs of the graph, indexed or not, and never a raw lift, for every filter', async () => {
    const specs = fixedSpecs();
    expect(specs).toHaveLength(60);
    const { store, publisher } = await inventory(specs);
    const decoded = await publisher.list();
    expect(decoded).toHaveLength(60);
    for (const status of STATUSES) {
      for (const contextGraphId of [undefined, ...GRAPHS, 'cg-none']) {
        const filter: JobFilter = { ...(status ? { status } : {}), ...(contextGraphId ? { contextGraphId } : {}) };
        const byspec = specs.filter((spec) => expectedMembership(spec, filter)).map((spec) => spec.id);
        const byScope = admittedByScope(decoded, filter);
        // The two oracles agree with each other: the specs describe what publisherJobReadScope sees.
        expect(sortById(byScope), JSON.stringify(filter)).toEqual(sortById(byspec));
        // The complete listing, the SPARQL pre-filter alone and the walk of pages all hold exactly that.
        expect(sortById((await publisher.list(filter)).map((job) => job.jobId)), `list ${JSON.stringify(filter)}`).toEqual(sortById(byspec));
        expect(sortById(await preFilterIds(store, filter)), `pre-filter ${JSON.stringify(filter)}`).toEqual(sortById(byspec));
        for (const limit of [1, 4, 1_000]) {
          const walk = await walkPages(publisher, { ...filter, limit });
          expect(walk.ids, `walk ${JSON.stringify(filter)} limit ${limit}`).toEqual(expectedOrder(specs.filter((spec) => expectedMembership(spec, filter))));
        }
      }
    }
  });

  it('is discriminating: a filter on the request\'s graph id alone also admits the raw lifts, which the real one must not', async () => {
    const specs = fixedSpecs();
    const { store } = await inventory(specs);
    const naive = (graphUri: string, params: Parameters<typeof buildLiftJobPageQuery>[1]): string =>
      buildLiftJobPageQuery(graphUri, params).replace(/FILTER NOT EXISTS \{[^}]*\}/, '');
    const filter: JobFilter = { contextGraphId: 'cg-a' };
    const naiveIds = await preFilterIds(store, filter, naive);
    const rawIds = specs.filter((spec) => spec.kind === 'raw' || spec.kind === 'raw-v0').filter((spec) => spec.contextGraphId === 'cg-a').map((spec) => spec.id);
    expect(rawIds.length).toBeGreaterThan(0);
    for (const id of rawIds) expect(naiveIds).toContain(id);
    for (const id of rawIds) expect(await preFilterIds(store, filter)).not.toContain(id);
  });

  it('treats the legacy raw lift (v0 payload) like the current one: operator-only', async () => {
    const specs: JobSpec[] = [
      { id: 'raw-v0', kind: 'raw-v0', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 1 },
      { id: 'raw-current', kind: 'raw', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 2 },
      { id: 'publish', kind: 'vm', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 3 },
    ];
    const { publisher } = await inventory(specs);
    const decoded = await publisher.list();
    expect(decoded.map((job) => publisherJobReadScope(job).kind)).toEqual(['operator-only', 'operator-only', 'context-graph']);
    expect((await walkPages(publisher, { contextGraphId: 'cg-a' })).ids).toEqual(['publish']);
    expect((await walkPages(publisher, {})).ids).toEqual(['raw-v0', 'raw-current', 'publish']);
  });

  it('backstop: a raw lift whose request triples were altered to look like a publish request is still kept out by the code-side re-check', async () => {
    const specs: JobSpec[] = [
      { id: 'forged', kind: 'raw', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 1 },
      { id: 'publish', kind: 'vm', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 2 },
    ];
    const { store, publisher } = await inventory(specs);
    await store.deleteByPattern({ subject: requestSubject('forged'), predicate: CONTROL_SWM_ID, graph: GRAPH });
    // The SPARQL filter now lets it through; the page and the complete listing still agree it is out.
    expect(sortById(await preFilterIds(store, { contextGraphId: 'cg-a' }))).toEqual(['forged', 'publish']);
    expect((await publisher.list({ contextGraphId: 'cg-a' })).map((job) => job.jobId)).toEqual(['publish']);
    const walk = await walkPages(publisher, { contextGraphId: 'cg-a', limit: 1 });
    expect(walk.ids).toEqual(['publish']);
    // The cursor still stepped over the dropped row: it was scanned, not returned.
    expect(walk.pages.map((page) => page.jobs.length)).toEqual([0, 1]);
  });

  it('documents the one way the filter can miss: a publish job whose request subject does not name the graph is not found by a graph-scoped page', async () => {
    const specs: JobSpec[] = [{ id: 'publish', kind: 'vm', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 1 }];
    const { store, publisher } = await inventory(specs);
    expect((await walkPages(publisher, { contextGraphId: 'cg-a' })).ids).toEqual(['publish']);
    await store.deleteByPattern({ subject: requestSubject('publish'), predicate: CONTROL_CONTEXT_GRAPH_ID, graph: GRAPH });
    expect((await publisher.list({ contextGraphId: 'cg-a' })).map((job) => job.jobId)).toEqual(['publish']);
    expect((await walkPages(publisher, { contextGraphId: 'cg-a' })).ids).toEqual([]);
    // Unscoped, nothing depends on the request subject.
    expect((await walkPages(publisher, {})).ids).toEqual(['publish']);
    // The publisher never writes such a request: serializeRequest emits the graph id for both request shapes.
    const written = jobQuads(templates, specs[0]!).filter((quad) => quad.subject === requestSubject('publish') && quad.predicate === CONTROL_CONTEXT_GRAPH_ID);
    expect(written).toHaveLength(1);
    expect(jobQuads(templates, { ...specs[0]!, kind: 'raw' }).filter((quad) => quad.predicate === CONTROL_HAS_REQUEST)).toHaveLength(1);
  });
});

describe('publisher job page: a walk is list(filter)', () => {
  it('holds the same jobs as the complete listing, in page order, for every filter and page size', async () => {
    const { publisher } = await inventory(fixedSpecs());
    for (const status of STATUSES) {
      for (const contextGraphId of [undefined, 'cg-a', 'cg-c']) {
        const filter = { ...(status ? { status } : {}), ...(contextGraphId ? { contextGraphId } : {}) };
        const listed = await publisher.list(filter);
        for (const limit of [1, 3, 7, 100]) {
          const walk = await walkPages(publisher, { ...filter, limit });
          expect(sortById(walk.ids)).toEqual(sortById(listed.map((job) => job.jobId)));
          expect(new Set(walk.ids).size).toBe(walk.ids.length);
          const walked = walk.pages.flatMap((page) => page.jobs);
          const byId = new Map(listed.map((job) => [job.jobId, job]));
          for (const job of walked) expect(job).toEqual(byId.get(job.jobId));
        }
      }
    }
  });
});

describe('publisher job stats: COUNT is the list tally', () => {
  it('matches the tally of the complete listing on a mixed inventory', async () => {
    const { publisher } = await inventory(fixedSpecs());
    const stats = await publisher.getStats();
    expect(stats).toEqual(await listTally(publisher));
    expect(stats).toEqual({ accepted: 12, claimed: 12, validated: 0, broadcast: 0, included: 0, finalized: 12, failed: 24 });
  });

  it('matches after the queue changes underneath it', async () => {
    const { publisher } = await inventory(fixedSpecs());
    await publisher.cancel('vm-accepted-cg-a');
    await publisher.claimNext('wallet-9');
    await publisher.clear('finalized');
    expect(await publisher.getStats()).toEqual(await listTally(publisher));
    expect((await publisher.list()).length).toBeLessThan(60);
  });

  it('counts a row whose payload no longer decodes, which the list tally skipped (the one documented difference)', async () => {
    const { store, publisher } = await inventory([{ id: 'ok', kind: 'vm', state: 'accepted', contextGraphId: 'cg-a', acceptedAt: 1 }]);
    await store.insert([
      { subject: jobSubject('broken'), predicate: CONTROL_STATUS, object: literal('accepted'), graph: GRAPH },
      { subject: jobSubject('broken'), predicate: CONTROL_PAYLOAD, object: literal('{not-json'), graph: GRAPH },
    ]);
    expect((await listTally(publisher)).accepted).toBe(1);
    expect((await publisher.getStats()).accepted).toBe(2);
  });
});

describe('publisher job page: properties over random inventories', () => {
  const kinds = fc.constantFrom<InventoryKind>(...INVENTORY_KINDS);
  const states = fc.constantFrom<InventoryState>('accepted', 'accepted', 'claimed', 'finalized', 'retryable', 'held');
  // Ids exercise the order: upper and lower case, digits and every punctuation mark of the grammar, and shared prefixes.
  const ids = fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,5}$/), { minLength: 2, maxLength: 14 });
  const scenarios = fc.record({
    ids,
    jobs: fc.array(fc.record({
      kind: kinds, state: states, contextGraphId: fc.constantFrom(...GRAPHS), acceptedAt: fc.integer({ min: 0, max: 4 }),
    }), { minLength: 14, maxLength: 14 }),
    status: fc.constantFrom<LiftJobState | undefined>(undefined, undefined, 'accepted', 'claimed', 'finalized', 'failed', 'broadcast'),
    contextGraphId: fc.constantFrom<string | undefined>(undefined, undefined, ...GRAPHS, 'cg-none'),
    limit: fc.constantFrom(1, 2, 3, 5, 1_000),
  });
  const stats = { cases: 0, nonEmpty: 0, multiPage: 0, scoped: 0, rawInScope: 0, ties: 0 };

  it('every walk equals list(filter), the scope oracle and the pre-filter, and the COUNT equals the list tally', async () => {
    const options = propertyOptions();
    await fc.assert(fc.asyncProperty(scenarios, async (scenario) => {
      const specs: JobSpec[] = scenario.ids.map((id, index) => ({ id, ...scenario.jobs[index]! }));
      const { store, publisher } = await inventory(specs);
      try {
        const filter: JobFilter = {
          ...(scenario.status ? { status: scenario.status } : {}),
          ...(scenario.contextGraphId ? { contextGraphId: scenario.contextGraphId } : {}),
        };
        const members = specs.filter((spec) => expectedMembership(spec, filter));
        const walk = await walkPages(publisher, { ...filter, limit: scenario.limit });
        expect(walk.ids).toEqual(expectedOrder(members));
        expect(sortById(walk.ids)).toEqual(sortById((await publisher.list(filter)).map((job) => job.jobId)));
        expect(sortById(walk.ids)).toEqual(sortById(admittedByScope(await publisher.list(), filter)));
        expect(sortById(await preFilterIds(store, filter))).toEqual(sortById(members.map((spec) => spec.id)));
        expect(await publisher.getStats()).toEqual(await listTally(publisher));
        stats.cases += 1;
        if (members.length > 0) stats.nonEmpty += 1;
        if (walk.pages.length > 1) stats.multiPage += 1;
        if (filter.contextGraphId !== undefined) stats.scoped += 1;
        if (filter.contextGraphId !== undefined && specs.some((spec) => (spec.kind === 'raw' || spec.kind === 'raw-v0') && spec.contextGraphId === filter.contextGraphId)) stats.rawInScope += 1;
        if (new Set(members.map((spec) => spec.acceptedAt)).size < members.length) stats.ties += 1;
      } finally {
        await store.close();
        opened.pop();
      }
    }), options);
    // Positive controls: the property compared what it claims to compare.
    expect(stats.cases).toBe(options.numRuns);
    expect(stats.nonEmpty).toBeGreaterThan(options.numRuns / 3);
    expect(stats.multiPage).toBeGreaterThan(0);
    expect(stats.scoped).toBeGreaterThan(0);
    expect(stats.rawInScope).toBeGreaterThan(0);       // a raw lift named the graph being listed
    expect(stats.ties).toBeGreaterThan(0);             // equal acceptance times, ordered by id
  }, 300_000);
});
