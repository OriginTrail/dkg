/**
 * OT-RFC-73 AC1 check (1), publisher queue: the graph-based queue-boundary oracle.
 *
 * Every store call the publisher queue makes is recorded at the store boundary and classified by the queue graphs
 * it touches (SPARQL text, quad graph, method graph argument; a port of the harness `liftwire.mjs`). The audit
 * asserts every Publisher row of the plan's tagging table (section 5.1): the control rows by the `controlQueue`
 * they carry and the lane they resolve to, every other row by its resolved lane. It also fails on a queue call to a
 * store method P3's routing test does not cover. The scripted workload runs on both a store with the atomic
 * subject-replace capabilities and one without them, so `replaceSubjectAtomicallyOrFallback` and the job-record
 * writer take both paths, and again under a non-default ambient lane.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildStoreControlPath,
  controlStoreOptions,
  externalStorePriorityScheduler,
  selectStoreScheduler,
  setStoreControlPathForTesting,
  type StoreWorkPriority,
} from '@origintrail-official/dkg-storage';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_JOURNAL_GRAPH_URI,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
} from '../src/async-lift-control-plane.js';
import {
  LIFT_GRAPHS,
  PUBLISHER_ROW_SOURCES,
  PUBLISHER_TAGGING_ROWS,
  auditPublisherCalls,
  classifyLiftCall,
  resolveLane,
  type RecordedStoreCall,
} from './_helpers/queue-boundary-oracle.js';
import {
  WORKER_PROBE_SOURCES,
  runPublisherFundingScenario,
  runPublisherPagingScenario,
  runPublisherWakeScenario,
  runPublisherWorkload,
  type PublisherStack,
} from './_helpers/publisher-queue-scenarios.js';

const STACKS: readonly PublisherStack[] = ['atomic', 'fallback'];
const ALL_SOURCES = [...PUBLISHER_ROW_SOURCES.keys()];
const CONTROL_SOURCES = PUBLISHER_TAGGING_ROWS.filter((row) => row.lane === 'control').flatMap((row) => row.sources);

/** The one source only the fallback path of the job-record writer makes. */
const FALLBACK_ONLY_SOURCE = 'publisher.asyncLift.writeJobRequest';
/** The sources of the bounded page and COUNT reads (P9a). The scripted workload is the AC2 base and has none; their scenario is below. */
const PAGE_SOURCES = ['publisher.asyncLift.listPage', 'publisher.asyncLift.stats'];
/**
 * The scripted workload is the AC2 base, which has no retention (P11): the sweep's five sources are driven by its own scenario
 * (`async-lift-retention-control-oracle.test.ts`).
 */
const RETENTION_ONLY_SOURCES = ['scan', 'siblings', 'verify', 'walletLocks'].map((name) => `publisher.asyncLift.retention.${name}`);
const PAGE_ONLY_SOURCES = ['publisher.asyncLift.hasRunnableWork', 'publisher.asyncLift.listPage', ...RETENTION_ONLY_SOURCES];

const synthetic = (over: Partial<RecordedStoreCall>): RecordedStoreCall => ({
  index: 0,
  method: 'query',
  graphs: ['job'],
  source: 'publisher.asyncLift.getStatus',
  options: controlStoreOptions('publisher', 'publisher.asyncLift.getStatus'),
  ambient: undefined,
  first: 'SELECT 1',
  ...over,
});

afterEach(() => setStoreControlPathForTesting());

describe('publisher queue boundary oracle: the oracle itself', () => {
  it('keys its classification on the product graph IRIs', () => {
    expect(LIFT_GRAPHS).toEqual({
      job: 'urn:dkg:publisher:control-plane',
      wallet: 'urn:dkg:publisher:wallet-locks',
      journal: 'urn:dkg:publisher:journal',
    });
    expect(LIFT_GRAPHS).toEqual({
      job: DEFAULT_CONTROL_GRAPH_URI, wallet: DEFAULT_WALLET_LOCK_GRAPH_URI, journal: DEFAULT_JOURNAL_GRAPH_URI,
    });
  });

  it('classifies a call from its SPARQL text, its quad graph and its graph argument', () => {
    const quad = (graph: string) => ({ subject: 's', predicate: 'p', object: '"o"', graph });
    expect(classifyLiftCall('query', [`SELECT * WHERE { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { ?s ?p ?o } }`])).toEqual(['job']);
    expect(classifyLiftCall('query', [
      `SELECT * WHERE { GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> { ?l ?p ?o } OPTIONAL { GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> { ?j ?q ?r } } }`,
    ])).toEqual(['job', 'wallet']);
    expect(classifyLiftCall('query', ['SELECT * WHERE { GRAPH <did:dkg:context-graph:x> { ?s ?p ?o } }'])).toEqual([]);
    expect(classifyLiftCall('insert', [[quad(DEFAULT_JOURNAL_GRAPH_URI)]])).toEqual(['journal']);
    expect(classifyLiftCall('insert', [[quad('did:dkg:context-graph:x')]])).toEqual([]);
    expect(classifyLiftCall('deleteByPatternWithoutCount', [{ subject: 's', graph: DEFAULT_WALLET_LOCK_GRAPH_URI }])).toEqual(['wallet']);
    expect(classifyLiftCall('replaceSubject', [DEFAULT_CONTROL_GRAPH_URI, 's', []])).toEqual(['job']);
    expect(classifyLiftCall('replaceSubjectAndInsert', [DEFAULT_CONTROL_GRAPH_URI, 's', [], []])).toEqual(['job']);
    expect(classifyLiftCall('createGraph', [DEFAULT_JOURNAL_GRAPH_URI])).toEqual(['journal']);
    expect(classifyLiftCall('update', ['INSERT DATA {}', { touchedGraphs: [DEFAULT_WALLET_LOCK_GRAPH_URI] }])).toEqual(['wallet']);
  });

  it('names every call site of the publisher queue in exactly one tagging row', () => {
    expect(ALL_SOURCES.length).toBe(new Set(ALL_SOURCES).size);
    expect(CONTROL_SOURCES).toContain('publisher.asyncLift.retryList');
    expect(PUBLISHER_ROW_SOURCES.get('publisher.asyncLift.list')?.lane).toBe('normal');
    expect(PUBLISHER_ROW_SOURCES.get('publisher.asyncLift.reconciliationInventory')?.lane).toBe('normal');
    expect(PUBLISHER_ROW_SOURCES.get('publisher.asyncLift.ensureVmPublishIntentIndex')?.lane).toBe('normal');
    expect(PUBLISHER_ROW_SOURCES.get('publisher.asyncLift.listPage')?.lane).toBe('normal');
    expect(PUBLISHER_ROW_SOURCES.get('publisher.asyncLift.stats')?.lane).toBe('normal');
    expect(PUBLISHER_ROW_SOURCES.get('publisher.queueUsage.lift')?.lane).toBe('background');
    expect(PUBLISHER_ROW_SOURCES.get('publisher.queueUsage.liftJournal')?.lane).toBe('background');
  });

  it.each([
    ['an untagged control call', synthetic({ options: { source: 'publisher.asyncLift.getStatus' } }), 'needs controlQueue=publisher'],
    ['a control call to the wrong queue', synthetic({ options: controlStoreOptions('share', 'publisher.asyncLift.getStatus') }), 'saw share'],
    ['a control call that also sets a priority', synthetic({ options: { ...controlStoreOptions('publisher', 'publisher.asyncLift.getStatus'), priority: 'health' } }), 'sets priority=health'],
    ['a queue call with an unknown label', synthetic({ source: 'publisher.asyncLift.somethingNew', options: { source: 'publisher.asyncLift.somethingNew' } }), 'outside the tagging table'],
    ['a queue call with no label', synthetic({ source: undefined, options: undefined }), 'outside the tagging table'],
    ['a queue call to a method the routing test does not cover', synthetic({ method: 'hasGraph' }), 'does not cover'],
    ['a tagged page read', synthetic({ source: 'publisher.asyncLift.listPage', options: controlStoreOptions('publisher', 'publisher.asyncLift.listPage') }), 'is not control but carries controlQueue'],
    ['a page read moved to the background lane', synthetic({ source: 'publisher.asyncLift.listPage', options: { source: 'publisher.asyncLift.listPage', priority: 'background' } }), 'sets priority=background'],
    ['a stats COUNT moved to a priority', synthetic({ source: 'publisher.asyncLift.stats', options: { source: 'publisher.asyncLift.stats', priority: 'health' } }), 'sets priority=health'],
    ['a tagged full-history read', synthetic({ source: 'publisher.asyncLift.list', options: controlStoreOptions('publisher', 'publisher.asyncLift.list') }), 'is not control but carries controlQueue'],
    ['a full-history read moved to a priority', synthetic({ source: 'publisher.asyncLift.list', options: { source: 'publisher.asyncLift.list', priority: 'background' } }), 'sets priority=background'],
    ['a queue_usage COUNT off the background lane', synthetic({ source: 'publisher.queueUsage.lift', options: { source: 'publisher.queueUsage.lift' } }), 'resolved normal, want background'],
    ['a tagged data-plane call', synthetic({ graphs: [], source: 'test.worker.execute', options: controlStoreOptions('publisher', 'test.worker.execute') }), 'a data-plane call carries controlQueue=publisher'],
    ['a createGraph with options', synthetic({ method: 'createGraph', source: undefined, options: controlStoreOptions('publisher', 'x') }), 'createGraph takes no options'],
  ])('fails on %s', (_name, call, expected) => {
    const { violations } = auditPublisherCalls([call], { pathOn: true });
    expect(violations.join('\n')).toContain(expected);
  });

  it('accepts a correctly tagged control call, an option-less createGraph and an untouched data-plane call', () => {
    const { violations } = auditPublisherCalls([
      synthetic({}),
      synthetic({ method: 'createGraph', source: undefined, options: undefined }),
      synthetic({ graphs: [], source: 'test.worker.execute', options: { source: 'test.worker.execute' } }),
    ], { pathOn: true });
    expect(violations).toEqual([]);
  });

  it('resolves like the routing test: control only with the path on, else explicit ?? ambient ?? normal', () => {
    const tagged = controlStoreOptions('publisher', 's');
    for (const ambient of [undefined, 'normal', 'background'] as const) {
      expect(resolveLane({ options: tagged, ambient }, true)).toBe('control:publisher');
      expect(resolveLane({ options: tagged, ambient }, false)).toBe(ambient ?? 'normal');
      expect(resolveLane({ options: { source: 's', priority: 'ack' }, ambient }, true)).toBe('ack');
    }
  });
});

describe.each(STACKS)('publisher queue boundary oracle: %s stack', (stack) => {
  it('puts every queue call of the scripted workload in its tagging-table row, control path on', async () => {
    const run = await runPublisherWorkload(stack);
    const audit = auditPublisherCalls(run.calls, { pathOn: true });
    expect(audit.violations).toEqual([]);
    expect(audit.queueCalls).toBeGreaterThan(100);
    const driven = ALL_SOURCES.filter((source) => !PAGE_ONLY_SOURCES.includes(source));
    const expected = stack === 'atomic' ? driven.filter((source) => source !== FALLBACK_ONLY_SOURCE) : driven;
    expect([...audit.sourcesSeen].sort()).toEqual([...expected].sort());
  });

  it('takes the path of the stack in the job-record writer', async () => {
    const run = await runPublisherWorkload(stack);
    const writeJob = run.calls.filter((call) => call.source === 'publisher.asyncLift.writeJob');
    const methods = new Set(writeJob.map((call) => call.method));
    expect(writeJob.length).toBeGreaterThan(10);
    if (stack === 'atomic') {
      expect([...methods]).toEqual(['replaceSubjectAndInsert']);
      expect(run.calls.some((call) => call.source === FALLBACK_ONLY_SOURCE)).toBe(false);
      expect(run.calls.filter((call) => call.source === 'publisher.asyncLift.walletLock.write').map((call) => call.method))
        .toContain('replaceSubject');
    } else {
      expect([...methods].sort()).toEqual(['deleteByPatternWithoutCount', 'insert']);
      expect(run.calls.some((call) => call.source === FALLBACK_ONLY_SOURCE)).toBe(true);
      // The fallback's delete and insert carry the same control options as the atomic call would.
      const walletMethods = new Set(run.calls.filter((call) => call.source === 'publisher.asyncLift.walletLock.write').map((call) => call.method));
      expect([...walletMethods].sort()).toEqual(['deleteByPatternWithoutCount', 'insert']);
    }
  });

  it('keeps every control call on the publisher path whatever ambient lane the caller is in, and every other row on its lane', async () => {
    const ambient: StoreWorkPriority = 'background';
    const run = await runPublisherWorkload(stack, { ambient });
    expect(auditPublisherCalls(run.calls, { pathOn: true }).violations).toEqual([]);
    const queueCalls = run.calls.filter((call) => call.graphs.length > 0 && call.method !== 'createGraph');
    for (const call of queueCalls) {
      const row = PUBLISHER_ROW_SOURCES.get(call.source!)!;
      expect(call.ambient, `${call.method} ${call.source}`).toBe(ambient);
      expect(resolveLane(call, true), `${call.method} ${call.source}`)
        .toBe(row.lane === 'control' ? 'control:publisher' : 'background');
    }
  });

  it('resolves every call to the lane it has without the tags when the path is off', async () => {
    for (const ambient of [undefined, 'background'] as const) {
      const run = await runPublisherWorkload(stack, { ambient });
      expect(auditPublisherCalls(run.calls, { pathOn: false }).violations).toEqual([]);
      for (const call of run.calls) {
        const untagged = { ...call.options, controlQueue: undefined };
        expect(resolveLane(call, false)).toBe(untagged.priority ?? call.ambient ?? 'normal');
      }
    }
  });

  it('is routed by the production selector: tagged calls to the publisher instance, everything else to the shared scheduler', async () => {
    const run = await runPublisherWorkload(stack);
    const on = buildStoreControlPath({ share: 1, publisher: 2 });
    setStoreControlPathForTesting(on);
    for (const call of run.calls) {
      const tagged = call.options?.controlQueue === 'publisher';
      expect(selectStoreScheduler(externalStorePriorityScheduler, call.options), `${call.method} ${call.source}`)
        .toBe(tagged ? on.publisher : externalStorePriorityScheduler);
    }
    // The publisher path off (a queue with no slots has no instance): every call stays on the shared scheduler.
    setStoreControlPathForTesting(buildStoreControlPath({ share: 1, publisher: 0 }));
    for (const call of run.calls) {
      expect(selectStoreScheduler(externalStorePriorityScheduler, call.options)).toBe(externalStorePriorityScheduler);
    }
  });
});

describe.each(STACKS)('publisher queue boundary oracle: bounded page reads (P9a), %s stack', (stack) => {
  const AMBIENTS: ReadonlyArray<StoreWorkPriority | undefined> = [undefined, 'background'];

  it.each(AMBIENTS)('keeps the page and stats reads on the caller\'s lane with the path on and off (ambient %s)', async (ambient) => {
    const run = await runPublisherPagingScenario(stack, { ambient });
    for (const pathOn of [true, false]) {
      const audit = auditPublisherCalls(run.calls, { pathOn });
      expect(audit.violations, `path ${pathOn ? 'on' : 'off'}`).toEqual([]);
      for (const source of PAGE_SOURCES) expect(audit.sourcesSeen.has(source), source).toBe(true);
    }
    const reads = run.calls.filter((call) => PAGE_SOURCES.includes(call.source!));
    expect(reads.filter((call) => call.source === 'publisher.asyncLift.listPage')).toHaveLength(3);
    expect(reads.filter((call) => call.source === 'publisher.asyncLift.stats')).toHaveLength(1);
    for (const call of reads) {
      expect(call.method).toBe('query');
      expect(call.graphs).toEqual(['job']);
      expect(call.options).toEqual({ source: call.source });
      expect(call.ambient).toBe(ambient);
      // Not control, with the path on or off: the lane the caller already had.
      expect(resolveLane(call, true)).toBe(ambient ?? 'normal');
      expect(resolveLane(call, false)).toBe(ambient ?? 'normal');
    }
  });

  it('never routes a page or stats read to the publisher\'s control instance, the path being on', async () => {
    const run = await runPublisherPagingScenario(stack);
    const on = buildStoreControlPath({ share: 1, publisher: 2 });
    setStoreControlPathForTesting(on);
    const reads = run.calls.filter((call) => PAGE_SOURCES.includes(call.source!));
    expect(reads.length).toBe(4);
    for (const call of reads) {
      expect(selectStoreScheduler(externalStorePriorityScheduler, call.options), `${call.method} ${call.source}`)
        .toBe(externalStorePriorityScheduler);
    }
    // Next to them, the admissions of the same scenario are control calls and do take the instance.
    const admission = run.calls.filter((call) => call.source === 'publisher.asyncLift.findActiveVmPublish');
    expect(admission.length).toBe(3);
    for (const call of admission) expect(selectStoreScheduler(externalStorePriorityScheduler, call.options)).toBe(on.publisher);
  });
});

describe('publisher queue boundary oracle: claim -> processClaim', () => {
  it.each(STACKS)('%s: the claimed job\'s data-plane calls carry no control tag and inherit no lane from the claim', async (stack) => {
    for (const ambient of [undefined, 'background'] as const) {
      const run = await runPublisherWorkload(stack, { ambient });
      // The handler ran inside processClaim, so it sees exactly the lane its caller had: the claim added none.
      expect(run.handlerObservations.length).toBeGreaterThanOrEqual(6);
      for (const seen of run.handlerObservations) expect(seen.ambient, seen.phase).toBe(ambient);
      const probes = run.calls.filter((call) => WORKER_PROBE_SOURCES.includes(call.source as never));
      expect(probes.length).toBe(run.handlerObservations.length);
      for (const probe of probes) {
        expect(probe.graphs).toEqual([]);
        expect(probe.options).toEqual({ source: probe.source });
        expect(probe.ambient).toBe(ambient);
      }
      // The same run's claim bookkeeping IS tagged, so the absence of a tag on the probes is not vacuous.
      expect(run.calls.filter((call) => call.source === 'publisher.asyncLift.walletLock.write').length).toBeGreaterThan(0);
      expect(run.calls.filter((call) => call.graphs.length === 0).every((call) => call.options?.controlQueue === undefined)).toBe(true);
    }
  });

  it.each(STACKS)('%s: a job admitted from a non-default lane is claimed by the woken wallet loop without inheriting it', async (stack) => {
    const bare = await runPublisherWakeScenario(stack, undefined);
    const background = await runPublisherWakeScenario(stack, 'background');
    for (const run of [bare, background]) {
      expect(auditPublisherCalls(run.calls, { pathOn: true }).violations).toEqual([]);
      expect(run.handlerObservations.map((seen) => seen.phase)).toEqual([
        'test.worker.preflight', 'test.worker.preflight', 'test.worker.execute',
      ]);
      // The wake only resolves the idle wait of a loop started outside any lane: the tick runs in its own context.
      for (const seen of run.handlerObservations) expect(seen.ambient, seen.phase).toBeUndefined();
      for (const call of run.calls.filter((c) => WORKER_PROBE_SOURCES.includes(c.source as never))) {
        expect(call.options).toEqual({ source: call.source });
        expect(call.ambient).toBeUndefined();
      }
    }
    // The enqueue itself ran in the background lane, and its control calls still went to the publisher path.
    const admission = background.calls.filter((call) => call.source === 'publisher.asyncLift.findActiveVmPublish');
    expect(admission.length).toBeGreaterThan(0);
    for (const call of admission) {
      expect(call.ambient).toBe('background');
      expect(resolveLane(call, true)).toBe('control:publisher');
    }
  });
});


describe.each(STACKS)('publisher queue boundary oracle: advisory availability, %s stack', (stack) => {
  it.each([undefined, 'background'] as const)('keeps existence reads on the caller lane (ambient %s)', async (ambient) => {
    const run = await runPublisherFundingScenario(stack, { ambient });
    expect(auditPublisherCalls(run.calls, { pathOn: true }).violations).toEqual([]);
    expect(auditPublisherCalls(run.calls, { pathOn: false }).violations).toEqual([]);
    const reads = run.calls.filter((call) => call.source === 'publisher.asyncLift.hasRunnableWork');
    expect(reads).toHaveLength(2);
    const on = buildStoreControlPath({ share: 1, publisher: 2 });
    setStoreControlPathForTesting(on);
    for (const call of reads) {
      expect(call.method).toBe('query');
      expect(call.graphs).toEqual(['job']);
      expect(call.options).toEqual({ source: call.source });
      expect(resolveLane(call, true)).toBe(ambient ?? 'normal');
      expect(resolveLane(call, false)).toBe(ambient ?? 'normal');
      expect(selectStoreScheduler(externalStorePriorityScheduler, call.options)).toBe(externalStorePriorityScheduler);
    }
  });
});
