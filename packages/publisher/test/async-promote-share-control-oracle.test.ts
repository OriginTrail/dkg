/**
 * OT-RFC-73 AC1 check (1), share queue: the graph-based queue-boundary oracle. A recording store (SPARQL text, quad graphs,
 * method graph argument, explicit options, ambient lane) sits under the real queue while a script drives every public
 * operation. Every call is asserted against its Share row of the §5.1 tagging table: control rows by `controlQueue` (and the
 * control lane they resolve to when the path is on), every other row by the lane it resolves to. It runs the atomic and the
 * fallback branch of `replaceSubjectAtomicallyOrFallback`, the path on and off, under each ambient lane. The worker wake-path
 * scenario is in the cli package's async-promote-worker.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OxigraphStore, withDefaultStoreWorkPriority, type StoreWorkPriority } from '@origintrail-official/dkg-storage';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI } from '../src/async-promote-queue-utils.js';
import {
  ROUTING_TEST_METHODS,
  SHARE_OWNERSHIP_READER_SOURCE,
  SHARE_QUEUE_USAGE_SOURCE,
  expectShareTaggingTable,
  recordShareStore,
  resolveLane,
  shareRowOf,
  withControlPath,
  type RecordedStoreCall,
} from './_helpers/share-control-recorder.js';
import { driveShareWorkload, WORKLOAD_DATA_GRAPH } from './_helpers/share-control-workload.js';

const GRAPHS = [DEFAULT_PROMOTE_CONTROL_GRAPH_URI];
const CUSTOM_GRAPH = 'urn:test:custom-promote-control';
const P = 'publisher.asyncPromote.';

type Ambient = StoreWorkPriority | undefined;
const AMBIENTS: readonly Ambient[] = [undefined, 'normal', 'background'];
const STORES = [
  { name: 'atomic', atomic: true, hidden: [] as string[] },
  { name: 'fallback', atomic: false, hidden: ['replaceSubject', 'replaceSubjectAndInsert'] },
] as const;

const inAmbient = <T>(ambient: Ambient, run: () => Promise<T>): Promise<T> =>
  ambient === undefined ? run() : withDefaultStoreWorkPriority(ambient, run);

/** The store calls on the share control graph that belong to the control rows, per scripted operation. */
const CONTROL_LABELS_BY_OPERATION: Readonly<Record<string, readonly string[]>> = {
  'enqueue': [`${P}findActiveConflict`, `${P}writeJob`],
  'enqueue (same selector)': [],
  'getStatus': [`${P}readJob`],
  'list': [`${P}list`, `${P}list.payloads`],
  'listPage': [`${P}list`, `${P}list.payloads`],
  'listForSelector': [`${P}selectorLookup`],
  'getStats': [`${P}stats`],
  'claimNext': [`${P}claimNext.candidates`, `${P}recoverExpired`, `${P}writeJob`],
  'heartbeat': [`${P}readJob`, `${P}writeJob`],
  'recordCommitMarker': [`${P}readJob`, `${P}writeJob`],
  'succeed': [`${P}readJob`, `${P}writeJob`],
  'fail (retryable)': [`${P}readJob`, `${P}writeJob`],
  'fail (post-commit)': [`${P}readJob`, `${P}writeJob`],
  'recoverPostCommitFailures': [`${P}findActiveConflict`, `${P}recoverPostCommit`, `${P}writeJob`],
  'cancel': [`${P}readJob`, `${P}writeJob`],
  'recover': [`${P}findActiveConflict`, `${P}readJob`, `${P}writeJob`],
  'recoverOnStartup': [`${P}findActiveConflict`, `${P}recoverExpired`, `${P}writeJob`],
  'clearTerminalJob': [`${P}clearTerminalJob`, `${P}deleteJob`],
  'clearTerminalJob (absent)': [`${P}clearTerminalJob`],
  'reconcileShare': [`${P}reconcile`],
  'pause and resume': [],
  'enqueueAndClaim': [`${P}findActiveConflict`, `${P}writeJob`],
  'bindRecovery': [`${P}readJob`, `${P}writeJob`],
  'ownership reader': [],
  'queue depth': [],
  'data plane': [],
};

const distinct = (values: readonly (string | undefined)[]) => [...new Set(values)].sort();

async function runWorkload(variant: (typeof STORES)[number], pathOn: boolean, ambient: Ambient, graphUri?: string) {
  const recorder = recordShareStore(new OxigraphStore(), { hidden: variant.hidden });
  let lanes: string[] = [];
  const { operations } = await withControlPath(pathOn, async () => {
    const result = await inAmbient(ambient, () => driveShareWorkload(recorder, { atomic: variant.atomic, ...(graphUri ? { graphUri } : {}) }));
    lanes = recorder.calls.map(resolveLane); // resolved while the path is injected
    return result;
  });
  return { calls: recorder.calls, lanes, operations };
}

describe.each(STORES)('share queue boundary oracle ($name branch)', (variant) => {
  describe.each([true, false])('control path on: %s', (pathOn) => {
    it.each(AMBIENTS.map((ambient) => [ambient ?? 'none', ambient] as const))('ambient lane %s: every call matches its row of the tagging table', async (_label, ambient) => {
      const recorder = recordShareStore(new OxigraphStore(), { hidden: variant.hidden });
      await withControlPath(pathOn, async () => {
        await inAmbient(ambient, () => driveShareWorkload(recorder, { atomic: variant.atomic }));
        expectShareTaggingTable(recorder.calls, GRAPHS, { pathOn });
      });
      // Not vacuous: the script reached every row.
      const rows = new Set(recorder.calls.map((call) => shareRowOf(call, GRAPHS)));
      expect([...rows].sort()).toEqual(['control', 'data-plane', 'no-scheduler-run', 'ownership-reader', 'queue-usage']);
    });
  });

  it('keeps the control tag on a custom control graph', async () => {
    const { calls } = await runWorkload(variant, true, undefined, CUSTOM_GRAPH);
    expect(calls.filter((call) => call.graphs.includes(DEFAULT_PROMOTE_CONTROL_GRAPH_URI))).toEqual([]);
    await withControlPath(true, async () => expectShareTaggingTable(calls, [CUSTOM_GRAPH], { pathOn: true }));
  });

  it('drives each operation to exactly the control labels the table lists for it', async () => {
    const { calls, operations } = await runWorkload(variant, true, undefined);
    for (const operation of new Set(operations)) {
      const control = calls.filter((call) => call.operation === operation && shareRowOf(call, GRAPHS) === 'control');
      expect(distinct(control.map((call) => call.source)), operation).toEqual([...CONTROL_LABELS_BY_OPERATION[operation]!].sort());
    }
    expect(Object.keys(CONTROL_LABELS_BY_OPERATION).sort()).toEqual(
      variant.atomic ? [...new Set(operations)].sort() : [...new Set(operations), 'enqueueAndClaim', 'bindRecovery'].sort(),
    );
  });

  it('writes the job record through the branch under test, with the control tag on every call of it', async () => {
    const { calls } = await runWorkload(variant, true, undefined);
    const writes = calls.filter((call) => call.source === `${P}writeJob`);
    expect(distinct(writes.map((call) => call.method))).toEqual(
      variant.atomic ? ['replaceSubject'] : ['deleteByPatternWithoutCount', 'insert'],
    );
    expect(writes.every((call) => call.options?.controlQueue === 'share')).toBe(true);
    // The fallback is two store calls per write; the atomic path one.
    expect(writes).toHaveLength(variant.atomic ? 22 : 34);
  });

  it('never makes a share-graph call outside the scripted operations or to a method the routing test does not cover', async () => {
    const { calls } = await runWorkload(variant, true, undefined);
    expect(calls.filter((call) => call.operation === '' && shareRowOf(call, GRAPHS) !== 'data-plane')).toEqual([]);
    expect([...new Set(calls.map((call) => call.method))].filter((method) => !ROUTING_TEST_METHODS.includes(method))).toEqual([]);
  });

  it('puts the rows outside the control path on the caller\'s lane with the path on', async () => {
    for (const ambient of AMBIENTS) {
      const { calls, lanes } = await runWorkload(variant, true, ambient);
      const laneOf = (source: string) => distinct(calls.flatMap((call, i) => (call.source === source ? [lanes[i]] : [])));
      expect(laneOf(SHARE_OWNERSHIP_READER_SOURCE), `reader, ambient ${ambient}`).toEqual([ambient ?? 'normal']);
      expect(laneOf(SHARE_QUEUE_USAGE_SOURCE), 'queue usage').toEqual(['background']);
      expect(laneOf('test.share.dataPlane'), `data plane, ambient ${ambient}`).toEqual([ambient ?? 'normal']);
      const control = distinct(calls.flatMap((call, i) => (shareRowOf(call, GRAPHS) === 'control' ? [lanes[i]] : [])));
      expect(control, `control rows, ambient ${ambient}`).toEqual(['control:share']);
    }
  });
});

describe('the oracle can fail', () => {
  const call = (over: Partial<RecordedStoreCall>): RecordedStoreCall => ({
    index: 0, method: 'query', graphs: GRAPHS, options: { source: `${P}readJob`, controlQueue: 'share' }, source: `${P}readJob`,
    ambient: undefined, operation: 'getStatus', ...over,
  });
  const check = (calls: RecordedStoreCall[], pathOn = true) => () => expectShareTaggingTable(calls, GRAPHS, { pathOn });
  const fixture = (over: Partial<RecordedStoreCall>, options: RecordedStoreCall['options']) =>
    call({ ...over, options, source: options?.source });

  it('accepts a correctly tagged control call, a reader on the caller\'s lane and a data-plane call', async () => {
    await withControlPath(true, async () => expect(check([
      call({}),
      fixture({ index: 1 }, { source: SHARE_OWNERSHIP_READER_SOURCE }),
      fixture({ index: 2, graphs: [WORKLOAD_DATA_GRAPH] }, { source: 'test.dataPlane' }),
    ])).not.toThrow());
  });

  it('fails a control-graph call that lost its control tag', () => {
    expect(check([fixture({}, { source: `${P}readJob` })])).toThrow(/controlQueue 'share'/);
  });

  it('fails a control call that carries a priority, or the other queue\'s tag', () => {
    expect(check([fixture({}, { source: `${P}readJob`, controlQueue: 'share', priority: 'health' })])).toThrow(/sets no priority/);
    expect(check([fixture({}, { source: `${P}readJob`, controlQueue: 'publisher' })])).toThrow(/controlQueue 'share'/);
  });

  it('fails a control call whose source is not a share queue label', () => {
    expect(check([fixture({}, { source: 'publisher.asyncLift.readJob', controlQueue: 'share' })])).toThrow(/share source label/);
  });

  it('fails the lock-free ownership reader if it is tagged or given a lane of its own', () => {
    expect(check([fixture({}, { source: SHARE_OWNERSHIP_READER_SOURCE, controlQueue: 'share' })])).toThrow(/not control work/);
    expect(check([fixture({}, { source: SHARE_OWNERSHIP_READER_SOURCE, priority: 'health' })])).toThrow();
  });

  it('fails a monitoring COUNT that is not background', () => {
    expect(check([fixture({}, { source: SHARE_QUEUE_USAGE_SOURCE, priority: 'normal' })])).toThrow(/stay background/);
  });

  it('fails data-plane work that carries a control tag', () => {
    expect(check([fixture({ graphs: [WORKLOAD_DATA_GRAPH] }, { source: 'test.dataPlane', controlQueue: 'share' })])).toThrow(/no control tag/);
  });

  it('fails a queue call to a store method the routing test does not cover', () => {
    expect(check([call({ method: 'replaceGraph' })])).toThrow(/routing test does not cover/);
    expect(check([call({ method: 'hasGraph' })])).toThrow(/routing test does not cover/);
  });

  it('fails a control row that does not resolve to the control lane although the path is on', async () => {
    // With no path injected a tagged call resolves to the caller's lane, as with the path off.
    expect(check([call({ ambient: 'background' })], true)).toThrow();
    await withControlPath(true, async () => expect(check([call({ ambient: 'background' })], true)).not.toThrow());
    await withControlPath(false, async () => expect(check([call({ ambient: 'background' })], false)).not.toThrow());
    // With the path on, a control call that lost its tag stays on the caller's lane, which is a failure even then.
    await withControlPath(true, async () => expect(check([fixture({}, { source: `${P}readJob` })], true)).toThrow());
  });
});

describe('the covered-method list follows the adapter routing test', () => {
  it('names only methods packages/storage/test/store-control-routing.test.ts drives', () => {
    const routing = readFileSync(fileURLToPath(new URL('../../storage/test/store-control-routing.test.ts', import.meta.url)), 'utf8');
    for (const method of ROUTING_TEST_METHODS) expect(routing, method).toMatch(new RegExp(`\\b${method}\\b`));
  });
});
