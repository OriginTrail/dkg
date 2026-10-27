/**
 * OT-RFC-73 AC1, publisher side: the graph-based queue-boundary oracle.
 *
 * A port of the harness `liftwire.mjs` (OT-RFC-73 evidence archive, `exp-v06/lib`): the publisher queue's control
 * plane is identified by WHAT A STORE CALL TOUCHES (the three queue graphs), never by its source label alone. A
 * label-only check misses exactly the calls that carry none, which is how two call sites sat on the wrong lane
 * before P1b. A call is classified from three places, as in the harness:
 *
 *   - the SPARQL text of `query` / `update` (a `GRAPH <iri>` block naming a queue graph),
 *   - the quad graph of `insert` / `delete`, and the pattern graph of `deleteByPattern*`,
 *   - the graph ARGUMENT of the subject-replace, graph and prefix methods.
 *
 * The recorder keeps, for each call, its explicit options and the ambient `withDefaultStoreWorkPriority` lane in
 * effect (`activeDefaultStoreWorkPriority()`), because the lane a call resolves to depends on both. The audit then
 * asserts every row of the Publisher part of the plan's tagging table (section 5.1): the control rows by the
 * `controlQueue` they carry, every other row by the lane it resolves to.
 */
import {
  activeDefaultStoreWorkPriority,
  storeOperationFamily,
  type QueryOptions,
  type StoreWorkPriority,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_JOURNAL_GRAPH_URI,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
} from '../../src/async-lift-control-plane.js';

export type LiftGraphTag = 'job' | 'wallet' | 'journal';

export const LIFT_GRAPHS: Readonly<Record<LiftGraphTag, string>> = Object.freeze({
  job: DEFAULT_CONTROL_GRAPH_URI,
  wallet: DEFAULT_WALLET_LOCK_GRAPH_URI,
  journal: DEFAULT_JOURNAL_GRAPH_URI,
});

const TAG_ORDER: readonly LiftGraphTag[] = ['job', 'wallet', 'journal'];
const TAG_OF_GRAPH = new Map<string, LiftGraphTag>(TAG_ORDER.map((tag) => [LIFT_GRAPHS[tag], tag]));
const GRAPH_IN_SPARQL = new RegExp(
  `<(${TAG_ORDER.map((tag) => LIFT_GRAPHS[tag].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})>`,
  'g',
);

/** Queue-graph tags named by a SPARQL text, in job < wallet < journal order. */
export function queueGraphsInSparql(sparql: unknown): LiftGraphTag[] {
  const found = new Set<LiftGraphTag>();
  for (const match of String(sparql ?? '').matchAll(GRAPH_IN_SPARQL)) found.add(TAG_OF_GRAPH.get(match[1]!)!);
  return TAG_ORDER.filter((tag) => found.has(tag));
}

const tagsOfGraphs = (graphs: readonly unknown[]): LiftGraphTag[] =>
  TAG_ORDER.filter((tag) => graphs.some((graph) => typeof graph === 'string' && TAG_OF_GRAPH.get(graph) === tag));

/** Position of the `QueryOptions` argument of each store method that can carry one. */
export const OPTIONS_INDEX: Readonly<Record<string, number>> = Object.freeze({
  query: 1,
  update: 1,
  insert: 1,
  delete: 1,
  deleteByPattern: 1,
  deleteByPatternWithoutCount: 1,
  replaceSubject: 3,
  replaceSubjectAndInsert: 4,
  replaceGraph: 2,
  dropGraph: 1,
  hasGraph: 1,
  countQuads: 1,
  deleteBySubjectPrefix: 2,
  listGraphs: 0,
  flush: 0,
});

/**
 * The store methods P3's routing test (`storage/test/store-control-routing.test.ts`) drives with and without the
 * control options, under each ambient lane, with the path on and off. A queue call to any other method has no
 * routing proof, so the audit fails on it. `store-control-path-coverage.test.ts` keeps this list in step with that
 * test's source.
 */
export const ROUTING_COVERED_METHODS: ReadonlySet<string> = new Set([
  'query',
  'insert',
  'delete',
  'deleteByPattern',
  'deleteByPatternWithoutCount',
  'deleteBySubjectPrefix',
  'replaceSubject',
  'replaceSubjectAndInsert',
  'update',
  'createGraph',
  'flush',
]);

/** Which queue graphs does this store call touch? Empty for a call that is not a queue call. */
export function classifyLiftCall(method: string, args: readonly unknown[]): LiftGraphTag[] {
  switch (method) {
    case 'query':
      return queueGraphsInSparql(args[0]);
    case 'update': {
      const touched = (args[1] as { touchedGraphs?: readonly string[] } | undefined)?.touchedGraphs ?? [];
      const inText = queueGraphsInSparql(args[0]);
      return TAG_ORDER.filter((tag) => inText.includes(tag) || tagsOfGraphs(touched).includes(tag));
    }
    case 'insert':
    case 'delete':
      return tagsOfGraphs((Array.isArray(args[0]) ? args[0] : []).map((quad: { graph?: unknown } | undefined) => quad?.graph));
    case 'deleteByPattern':
    case 'deleteByPatternWithoutCount':
      return tagsOfGraphs([(args[0] as { graph?: unknown } | undefined)?.graph]);
    case 'replaceSubject':
    case 'replaceSubjectAndInsert':
    case 'replaceGraph':
    case 'replaceGraphAndSubject':
    case 'dropGraph':
    case 'hasGraph':
    case 'countQuads':
    case 'deleteBySubjectPrefix':
    case 'createGraph':
      return tagsOfGraphs([args[0]]);
    default:
      return [];
  }
}

export interface RecordedStoreCall {
  /** Order of the call at the store boundary. */
  readonly index: number;
  readonly method: string;
  /** Queue graphs the call touches, such as `['job']` or `['job', 'wallet']`; empty for a data-plane call. */
  readonly graphs: readonly LiftGraphTag[];
  /** `options.source`, or undefined when the call carried none. */
  readonly source: string | undefined;
  /** The explicit options object the caller passed, exactly as passed. */
  readonly options: QueryOptions | undefined;
  /** The ambient `withDefaultStoreWorkPriority` lane in effect at the call. */
  readonly ambient: StoreWorkPriority | undefined;
  /** First argument (a pattern, a quad list, a SPARQL text or a graph IRI). */
  readonly first: unknown;
}

export interface LiftStoreRecorder {
  readonly store: TripleStore;
  readonly calls: RecordedStoreCall[];
}

/**
 * Wrap `inner` in a recording proxy. `hidden` removes methods from the store (the way a store without the atomic
 * capabilities looks), which sends `replaceSubjectAtomicallyOrFallback` down its fallback path. The proxy does not
 * change what a call does: it records and forwards, and the store's own internal calls stay unrecorded.
 */
export function recordLiftStore(inner: TripleStore, hidden: readonly string[] = []): LiftStoreRecorder {
  const calls: RecordedStoreCall[] = [];
  const store = new Proxy(inner, {
    get(target, prop) {
      if (typeof prop === 'string' && hidden.includes(prop)) return undefined;
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string' || prop === 'constructor' || prop === 'then') return value;
      return (...args: unknown[]) => {
        const graphs = classifyLiftCall(prop, args);
        const optionsIndex = OPTIONS_INDEX[prop];
        const options = optionsIndex === undefined ? undefined : args[optionsIndex] as QueryOptions | undefined;
        calls.push({
          index: calls.length,
          method: prop,
          graphs,
          source: typeof options === 'object' && options !== null ? options.source : undefined,
          options,
          ambient: activeDefaultStoreWorkPriority(),
          first: args[0],
        });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as TripleStore;
  return { store, calls };
}

/** The lane a call resolves to: its queue's control path, or the shared scheduler's explicit ?? ambient ?? normal. */
export type ResolvedLane = StoreWorkPriority | 'control:publisher' | 'control:share';

/**
 * AC1's resolution rule. A call carrying `controlQueue` resolves to that queue's control path when the path is on
 * for that queue; any other call, and any call with the path off, resolves to explicit ?? ambient ?? `normal`.
 */
export function resolveLane(call: Pick<RecordedStoreCall, 'options' | 'ambient'>, pathOn: boolean): ResolvedLane {
  const queue = call.options?.controlQueue;
  if (pathOn && queue !== undefined) return `control:${queue}`;
  return call.options?.priority ?? call.ambient ?? 'normal';
}

export type LaneExpectation = 'control' | 'normal' | 'background';

export interface TaggingRow {
  readonly id: string;
  /** The Publisher row of plan section 5.1, in short. */
  readonly row: string;
  readonly lane: LaneExpectation;
  /** The source label of each call site the row covers. */
  readonly sources: readonly string[];
}

const LIFT = 'publisher.asyncLift.';

/** The Publisher part of the tagging table (plan section 5.1) as call sites. */
export const PUBLISHER_TAGGING_ROWS: readonly TaggingRow[] = [
  {
    id: 'control-path',
    row: 'Every call on control-plane / wallet-locks / journal, incl. journal append/allocate, point reads and bulk retry()\'s list',
    lane: 'control',
    sources: [
      'getStatus', 'lookupVmPublishIntent', 'readJournalEntries', 'retryList',
      'findActiveVmPublish', 'claimCandidates', 'nextAccepted',
      'writeJob', 'writeJobRequest', 'deleteJob', 'deleteJobRequest',
      'walletLock.write', 'walletLock.delete', 'walletLock.read', 'walletLock.ownership', 'walletLock.sweep',
      'appendJournalEntry', 'allocateJournalSeq',
      // P11: bulk clear's sibling read, under the claim lock and the job lock.
      'clear.siblings',
    ].map((name) => `${LIFT}${name}`),
  },
  {
    id: 'unlocked-full-history',
    row: 'Unlocked full-history reads that stay complete: list(), reconciliationInventory, boot backfill',
    lane: 'normal',
    sources: ['list', 'reconciliationInventory', 'ensureVmPublishIntentIndex', 'writeVmPublishIntentIndex']
      .map((name) => `${LIFT}${name}`),
  },
  {
    // P9a bounded the two reads a client can drive (the job listing page and the stats). They hold no lock, so the
    // control path (two slots that a claim or an admission waits for) is not theirs, and a background lane would
    // starve them exactly when an operator needs them. They keep the caller's lane, like the reads they replace.
    id: 'bounded-page-reads',
    row: 'Bounded page and COUNT reads (P9a): listPage(), getStats(). Decided: normal, the caller\'s lane',
    lane: 'normal',
    sources: ['listPage', 'stats'].map((name) => `${LIFT}${name}`),
  },
  {
    id: 'queue-usage',
    row: 'P1b queue_usage COUNTs (jobs by state on control-plane, journal entry count)',
    lane: 'background',
    sources: ['publisher.queueUsage.lift', 'publisher.queueUsage.liftJournal'],
  },
];

export const PUBLISHER_ROW_SOURCES: ReadonlyMap<string, TaggingRow> = new Map(
  PUBLISHER_TAGGING_ROWS.flatMap((row) => row.sources.map((source) => [source, row] as const)),
);

export interface AuditOptions {
  /** Whether the publisher's control path is on. */
  readonly pathOn: boolean;
}

export interface AuditResult {
  readonly violations: string[];
  /** Source labels of the queue-graph calls that matched a tagging row. */
  readonly sourcesSeen: ReadonlySet<string>;
  readonly queueCalls: number;
  readonly dataPlaneCalls: number;
}

const describeCall = (call: RecordedStoreCall): string =>
  `#${call.index} ${call.method}(${call.graphs.join('+') || 'data-plane'}) source=${call.source ?? '(none)'}`;

/**
 * Assert every recorded call against the Publisher tagging rows. Returns the violations rather than throwing so a
 * test can show all of them at once.
 */
export function auditPublisherCalls(calls: readonly RecordedStoreCall[], audit: AuditOptions): AuditResult {
  const violations: string[] = [];
  const sourcesSeen = new Set<string>();
  let queueCalls = 0;
  let dataPlaneCalls = 0;
  for (const call of calls) {
    const queue = call.options?.controlQueue;
    if (call.graphs.length === 0) {
      // 'Both' row: pre-queue reads, data-plane work and worker verification are unchanged. They never carry a
      // control tag and resolve to explicit ?? ambient ?? normal.
      dataPlaneCalls += 1;
      if (queue !== undefined) violations.push(`${describeCall(call)}: a data-plane call carries controlQueue=${queue}`);
      if (resolveLane(call, audit.pathOn) !== (call.options?.priority ?? call.ambient ?? 'normal')) {
        violations.push(`${describeCall(call)}: a data-plane call left its explicit ?? ambient ?? normal lane`);
      }
      continue;
    }
    queueCalls += 1;
    if (!ROUTING_COVERED_METHODS.has(call.method)) {
      violations.push(`${describeCall(call)}: queue call to a store method P3's routing test does not cover`);
    }
    if (call.method === 'createGraph') {
      // 'createGraph' takes no options and the HTTP adapters make no scheduler run for it (P3's routing test pins
      // that), so it has no lane to tag. It must stay option-less: an options argument here would be a tag nobody reads.
      if (call.options !== undefined) violations.push(`${describeCall(call)}: createGraph takes no options`);
      continue;
    }
    const row = call.source === undefined ? undefined : PUBLISHER_ROW_SOURCES.get(call.source);
    if (row === undefined) {
      violations.push(`${describeCall(call)}: queue call outside the tagging table (no row for its source)`);
      continue;
    }
    sourcesSeen.add(call.source!);
    const lane = resolveLane(call, audit.pathOn);
    if (row.lane === 'control') {
      if (queue !== 'publisher') {
        violations.push(`${describeCall(call)}: row '${row.id}' needs controlQueue=publisher, saw ${String(queue)}`);
      }
      if (call.options?.priority !== undefined) {
        violations.push(`${describeCall(call)}: a control call sets priority=${call.options.priority} (tagging sets none)`);
      }
      const want: ResolvedLane = audit.pathOn ? 'control:publisher' : (call.ambient ?? 'normal');
      if (lane !== want) violations.push(`${describeCall(call)}: resolved ${lane}, want ${want}`);
    } else {
      if (queue !== undefined) violations.push(`${describeCall(call)}: row '${row.id}' is not control but carries controlQueue=${queue}`);
      // 'normal' rows stay on the caller's lane (no priority is set for them); 'background' rows name it.
      const want: ResolvedLane = row.lane === 'background' ? 'background' : (call.ambient ?? 'normal');
      if (row.lane === 'normal' && call.options?.priority !== undefined) {
        violations.push(`${describeCall(call)}: row '${row.id}' stays on the caller's lane but sets priority=${call.options.priority}`);
      }
      if (lane !== want) violations.push(`${describeCall(call)}: resolved ${lane}, want ${want}`);
    }
  }
  return { violations, sourcesSeen, queueCalls, dataPlaneCalls };
}

/** Labels this PR adds map to the base label of the same operation before families are compared (AC2). */
export const LABEL_TO_BASE: Readonly<Record<string, string>> = Object.freeze({
  'publisher.asyncLift.retryList': 'publisher.asyncLift.list',
  // getStats() was a list() until P9a made it a COUNT: one call before, one call after.
  'publisher.asyncLift.stats': 'publisher.asyncLift.list',
});

/**
 * Labels of calls the base SHA never made at all: P11's bulk clear reads the lifecycle siblings of each job it removes. They are additions to the workload, not
 * relabelled base calls, so the AC2 traces leave them out (the boundary oracle still audits their lane and tag).
 */
export const ADDED_LABELS: ReadonlySet<string> = new Set(['publisher.asyncLift.clear.siblings']);

/** A call's source label with the labels this PR adds mapped back to the base label of the same operation. */
const baseSourceOf = (call: Pick<RecordedStoreCall, 'source'>): string | undefined =>
  call.source === undefined ? undefined : (LABEL_TO_BASE[call.source] ?? call.source);

const tally = (keys: Iterable<string>): Record<string, number> => {
  const trace: Record<string, number> = {};
  for (const key of keys) trace[key] = (trace[key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(trace).sort(([a], [b]) => (a < b ? -1 : 1)));
};

/**
 * The lane trace of a workload (AC2): how many calls resolved to each (lane, operation family) with the control path
 * OFF. The resolved lane is explicit ?? ambient ?? `normal`; the family is the first two dot-separated segments of
 * the call's source label, after the label mapping. A call with no label is counted under `(unlabelled)`.
 */
export function laneTrace(calls: readonly RecordedStoreCall[]): Record<string, number> {
  return tally(calls.filter((call) => !ADDED_LABELS.has(call.source ?? '')).map((call) => {
    const source = baseSourceOf(call);
    return `${resolveLane(call, false)} ${source === undefined ? '(unlabelled)' : storeOperationFamily(source)}`;
  }));
}

/**
 * The per-site lane trace (AC2): how many calls resolved to each (lane, source label) with the control path OFF.
 * The family trace above cannot see a change that keeps every family's count, such as two sites of one family
 * exchanging lanes or labels; every queue site has a label of its own (the static coverage test fails on a shared
 * one), so counting by label compares the workload site by site. A call with no label is counted under
 * `(unlabelled:<method>)`, so the option-less `createGraph` and `flush` calls stay apart from unlabelled queries.
 */
export function sourceTrace(calls: readonly RecordedStoreCall[]): Record<string, number> {
  return tally(calls.filter((call) => !ADDED_LABELS.has(call.source ?? '')).map((call) => {
    const source = baseSourceOf(call);
    return `${resolveLane(call, false)} ${source ?? `(unlabelled:${call.method})`}`;
  }));
}

/** The family trace a per-site trace folds to, for checking the two goldens against each other. */
export function familyOfSourceTrace(trace: Readonly<Record<string, number>>): Record<string, number> {
  const family: Record<string, number> = {};
  for (const [key, count] of Object.entries(trace)) {
    const space = key.indexOf(' ');
    const lane = key.slice(0, space);
    const source = key.slice(space + 1);
    const folded = `${lane} ${source.startsWith('(unlabelled') ? '(unlabelled)' : storeOperationFamily(source)}`;
    family[folded] = (family[folded] ?? 0) + count;
  }
  return Object.fromEntries(Object.entries(family).sort(([a], [b]) => (a < b ? -1 : 1)));
}
