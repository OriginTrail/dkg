/**
 * OT-RFC-73 AC1 boundary recorder for the share queue: a store wrapper that records, for every call, the SPARQL text, quad
 * graphs and method graph argument (so a call is identified by what it touches, not only by its source label), its explicit
 * options and the ambient default lane in effect (`activeDefaultStoreWorkPriority()`), plus the lane the call resolves to.
 * Shared by the publisher oracle, static, lane-trace and claim-order tests and by the cli worker's wake-path scenario.
 */
import { expect } from 'vitest';
import {
  activeDefaultStoreWorkPriority,
  buildStoreControlPath,
  externalStorePriorityScheduler,
  selectStoreScheduler,
  setStoreControlPathForTesting,
  type Quad,
  type QueryOptions,
  type StoreWorkPriority,
  type TripleStore,
  type UpdateOptions,
} from '@origintrail-official/dkg-storage';

/**
 * The store methods the adapter routing test (packages/storage/test/store-control-routing.test.ts, `CALLS`) drives under
 * every ambient lane with the path on and off. A queue call to any other store method has no routing proof behind it.
 */
export const ROUTING_TEST_METHODS: readonly string[] = Object.freeze([
  'query', 'insert', 'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix',
  'replaceSubject', 'replaceSubjectAndInsert', 'update', 'createGraph', 'flush',
]);

/** Plumbing that never reaches the scheduler and is not a queue call. */
const NOT_A_STORE_CALL: ReadonlySet<string> = new Set(['getPressureSnapshot', 'then', 'constructor']);

export interface RecordedStoreCall {
  readonly index: number;
  readonly method: string;
  /** Every IRI the call names: `<...>` in a SPARQL text, `touchedGraphs`, quad graphs, the pattern graph or the graph argument. */
  readonly graphs: readonly string[];
  /** The options object the call carried (after `stripControlQueue`, when the recorder was asked to). */
  readonly options: QueryOptions | undefined;
  readonly source: string | undefined;
  /** `activeDefaultStoreWorkPriority()` at the moment of the call. */
  readonly ambient: StoreWorkPriority | undefined;
  /** The scripted operation in flight (`ShareStoreRecorder.mark`), or `''`. */
  readonly operation: string;
}

const OPTIONS_INDEX: Readonly<Record<string, number>> = Object.freeze({
  query: 1, update: 1, insert: 1, delete: 1, deleteByPattern: 1, deleteByPatternWithoutCount: 1,
  deleteBySubjectPrefix: 2, replaceSubject: 3, replaceSubjectAndInsert: 4, replaceGraph: 2,
  dropGraph: 1, hasGraph: 1, countQuads: 1, flush: 0, listGraphs: 0,
});

const IRI_IN_SPARQL = /<([^<>\s"{}|^`\\]+)>/g;

function graphsOf(method: string, args: readonly unknown[]): string[] {
  switch (method) {
    case 'query':
    case 'update':
      return [...String(args[0] ?? '').matchAll(IRI_IN_SPARQL)].map((match) => match[1]!)
        .concat([...((args[1] as UpdateOptions | undefined)?.touchedGraphs ?? [])]);
    case 'insert':
    case 'delete':
      return (Array.isArray(args[0]) ? args[0] as Quad[] : []).map((quad) => quad.graph);
    case 'deleteByPattern':
    case 'deleteByPatternWithoutCount': {
      const graph = (args[0] as Partial<Quad> | undefined)?.graph;
      return graph ? [graph] : [];
    }
    default:
      return typeof args[0] === 'string' ? [args[0]] : [];
  }
}

export interface ShareStoreRecorder {
  readonly store: TripleStore;
  readonly calls: RecordedStoreCall[];
  /** Name the scripted operation the following calls belong to; returns what `run` returns. */
  mark<T>(operation: string, run: () => Promise<T>): Promise<T>;
}

export interface ShareStoreRecorderOptions {
  /** Store capabilities to hide, e.g. `replaceSubject`, so the atomic helpers take their fallback branch. */
  hidden?: readonly string[];
  /** Drop `controlQueue` from every options object before recording and forwarding: the untagged behavior of the base. */
  stripControlQueue?: boolean;
}

export function recordShareStore(inner: TripleStore, recorderOptions: ShareStoreRecorderOptions = {}): ShareStoreRecorder {
  const calls: RecordedStoreCall[] = [];
  const state = { operation: '' };
  const store = new Proxy(inner, {
    get(target, prop) {
      if (typeof prop === 'string' && recorderOptions.hidden?.includes(prop)) return undefined;
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || NOT_A_STORE_CALL.has(prop)) return value.bind(target);
      return (...args: unknown[]) => {
        const optionsIndex = OPTIONS_INDEX[prop];
        let forwarded = args;
        if (recorderOptions.stripControlQueue && optionsIndex !== undefined
          && args[optionsIndex] && typeof args[optionsIndex] === 'object') {
          const { controlQueue: _dropped, ...rest } = args[optionsIndex] as QueryOptions;
          forwarded = [...args];
          forwarded[optionsIndex] = rest;
        }
        const options = optionsIndex === undefined ? undefined : forwarded[optionsIndex] as QueryOptions | undefined;
        calls.push({
          index: calls.length,
          method: prop,
          graphs: graphsOf(prop, forwarded),
          options,
          source: options?.source,
          ambient: activeDefaultStoreWorkPriority(),
          operation: state.operation,
        });
        return (value as (...a: unknown[]) => unknown).apply(target, forwarded);
      };
    },
  }) as TripleStore;
  return {
    store,
    calls,
    async mark(operation, run) {
      state.operation = operation;
      try { return await run(); } finally { state.operation = ''; }
    },
  };
}

/** Run `run` with the control path on (the share instance and the publisher instance injected) or off. */
export async function withControlPath<T>(on: boolean, run: () => Promise<T>): Promise<T> {
  setStoreControlPathForTesting(on ? buildStoreControlPath({ share: 1, publisher: 2 }) : {});
  try { return await run(); } finally { setStoreControlPathForTesting(undefined); }
}

/**
 * The lane a recorded call resolves to under the path currently injected: `control:<queue>` when the adapter's own
 * routing (`selectStoreScheduler`) sends it to that queue's instance, else explicit priority ?? ambient ?? `normal`.
 */
export function resolveLane(call: Pick<RecordedStoreCall, 'options' | 'ambient'>): string {
  if (selectStoreScheduler(externalStorePriorityScheduler, call.options) !== externalStorePriorityScheduler) {
    return `control:${call.options!.controlQueue}`;
  }
  return call.options?.priority ?? call.ambient ?? 'normal';
}

/** Operation family of P1b: the first two dot-separated segments of the source label. */
export function operationFamily(call: Pick<RecordedStoreCall, 'method' | 'source'>): string {
  return call.source ? call.source.split('.').slice(0, 2).join('.') : `(unlabelled ${call.method})`;
}

export const SHARE_OWNERSHIP_READER_SOURCE = 'publisher.asyncPromote.ownershipReader';
export const SHARE_QUEUE_USAGE_SOURCE = 'publisher.queueUsage.share';

export type ShareRow = 'control' | 'ownership-reader' | 'queue-usage' | 'data-plane' | 'no-scheduler-run';

/** The Share row of the §5.1 tagging table a recorded call belongs to, from what it touches and its source. */
export function shareRowOf(call: RecordedStoreCall, shareGraphs: readonly string[]): ShareRow {
  if (call.method === 'createGraph' || call.method === 'flush') return 'no-scheduler-run';
  if (!call.graphs.some((graph) => shareGraphs.includes(graph))) return 'data-plane';
  if (call.source === SHARE_OWNERSHIP_READER_SOURCE) return 'ownership-reader';
  if (call.source === SHARE_QUEUE_USAGE_SOURCE) return 'queue-usage';
  return 'control';
}

/**
 * Assert every recorded call against its Share row of the tagging table, by `controlQueue` for control rows (and the lane
 * they resolve to under the injected path) and by resolved lane for every other row. Also fails on a call to a store method
 * the adapter routing test does not cover.
 */
export function expectShareTaggingTable(
  calls: readonly RecordedStoreCall[],
  shareGraphs: readonly string[],
  { pathOn }: { pathOn: boolean },
): void {
  for (const call of calls) {
    const where = `#${call.index} ${call.method} [${call.source ?? 'no source'}] in '${call.operation}' (ambient ${call.ambient ?? 'none'})`;
    expect(ROUTING_TEST_METHODS, `${where}: a store method the routing test does not cover`).toContain(call.method);
    const row = shareRowOf(call, shareGraphs);
    const lane = resolveLane(call);
    const callerLane = call.options?.priority ?? call.ambient ?? 'normal';
    switch (row) {
      case 'control':
        expect(call.options?.controlQueue, `${where}: control row carries controlQueue 'share'`).toBe('share');
        expect(call.options?.priority, `${where}: the tag sets no priority`).toBeUndefined();
        expect(call.source, `${where}: control row has a share source label`).toMatch(/^publisher\.asyncPromote\./);
        expect(lane, where).toBe(pathOn ? 'control:share' : callerLane);
        break;
      case 'ownership-reader':
        expect(call.options?.controlQueue, `${where}: the lock-free reader is not control work`).toBeUndefined();
        expect(call.options?.priority, where).toBeUndefined();
        expect(lane, `${where}: stays on the caller's lane`).toBe(call.ambient ?? 'normal');
        break;
      case 'queue-usage':
        expect(call.options?.controlQueue, where).toBeUndefined();
        expect(lane, `${where}: monitoring reads stay background`).toBe('background');
        break;
      case 'data-plane':
        expect(call.options?.controlQueue, `${where}: data-plane work carries no control tag`).toBeUndefined();
        expect(lane, where).toBe(callerLane);
        break;
      case 'no-scheduler-run':
        // createGraph takes no options and the queue's flush passes none: neither reaches a scheduler (routing test).
        expect(call.options?.priority, where).toBeUndefined();
        if (call.options?.controlQueue !== undefined) expect(call.options.controlQueue, where).toBe('share');
        break;
    }
  }
}

/** Multiset of `lane|family` over the calls, as a sorted object (AC2's lane trace). */
export function laneTrace(calls: readonly RecordedStoreCall[]): Record<string, number> {
  const trace: Record<string, number> = {};
  for (const call of calls) {
    const key = `${resolveLane(call)}|${operationFamily(call)}`;
    trace[key] = (trace[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(trace).sort(([a], [b]) => a.localeCompare(b)));
}
