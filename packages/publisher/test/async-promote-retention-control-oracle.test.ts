/**
 * OT-RFC-73 AC1, share queue, retention rows of the §5.1 tagging table: the sweep's verify and delete run inside the share mutex on the control path
 * (`controlQueue: 'share'`, no priority), its candidate scan runs outside the lock on the background lane (explicit `priority: 'background'`, no control tag),
 * whatever the ambient lane, with the control path on and off. Same recorder and same row assertions as the share queue's own oracle
 * (async-promote-share-control-oracle.test.ts); a retention pass is not part of that workload because its lane-trace baseline predates retention.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore, withDefaultStoreWorkPriority, type StoreWorkPriority } from '@origintrail-official/dkg-storage';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI } from '../src/async-promote-queue-utils.js';
import {
  ROUTING_TEST_METHODS,
  SHARE_RETENTION_SCAN_SOURCE,
  expectShareTaggingTable,
  recordShareStore,
  resolveLane,
  shareRowOf,
  withControlPath,
  type RecordedStoreCall,
} from './_helpers/share-control-recorder.js';
import { driveRetentionWorkload } from './_helpers/share-retention-workload.js';

const GRAPHS = [DEFAULT_PROMOTE_CONTROL_GRAPH_URI];
const R = 'publisher.asyncPromote.retention.';
type Ambient = StoreWorkPriority | undefined;
const AMBIENTS: readonly Ambient[] = [undefined, 'normal', 'background'];
const inAmbient = <T>(ambient: Ambient, run: () => Promise<T>): Promise<T> => (ambient === undefined ? run() : withDefaultStoreWorkPriority(ambient, run));

async function run(mode: 'report' | 'delete', pathOn: boolean, ambient: Ambient) {
  const inner = new OxigraphStore();
  const recorder = recordShareStore(inner);
  let lanes: string[] = [];
  const outcome = await withControlPath(pathOn, async () => {
    const result = await inAmbient(ambient, () => driveRetentionWorkload(recorder, inner, { mode }));
    lanes = recorder.calls.map(resolveLane);
    return result;
  });
  return { calls: recorder.calls, lanes, outcome };
}

describe.each(['report', 'delete'] as const)('retention boundary oracle (%s mode)', (mode) => {
  describe.each([true, false])('control path on: %s', (pathOn) => {
    it.each(AMBIENTS.map((ambient) => [ambient ?? 'none', ambient] as const))('ambient lane %s: every call matches its row of the tagging table', async (_label, ambient) => {
      const { calls, outcome } = await run(mode, pathOn, ambient);
      await withControlPath(pathOn, async () => expectShareTaggingTable(calls, GRAPHS, { pathOn }));
      // not vacuous: the pass reached every row it has, and really judged (and, in delete mode, deleted) jobs
      const rows = new Set(calls.map((call) => shareRowOf(call, GRAPHS)));
      expect([...rows].sort()).toEqual(mode === 'delete' ? ['control', 'no-scheduler-run', 'retention-scan'] : ['control', 'retention-scan']);
      expect(mode === 'delete' ? outcome.deleted : outcome.wouldDelete).toBe(5);
    });
  });

  it('puts verify and delete on the share control instance and the scan on the background lane, under every ambient lane', async () => {
    for (const ambient of AMBIENTS) {
      const { calls, lanes } = await run(mode, true, ambient);
      const laneOf = (source: string) => [...new Set(calls.flatMap((call, i) => (call.source === source ? [lanes[i]] : [])))].sort();
      expect(laneOf(`${R}verify`), `verify, ambient ${ambient}`).toEqual(['control:share']);
      expect(laneOf(SHARE_RETENTION_SCAN_SOURCE), `scan, ambient ${ambient}`).toEqual(['background']);
      if (mode === 'delete') expect(laneOf(`${R}delete`), `delete, ambient ${ambient}`).toEqual(['control:share']);
    }
  });

  it('with the path off every call resolves exactly as the same call without the tag would: the caller\'s lane, the scan background', async () => {
    for (const ambient of AMBIENTS) {
      const { calls, lanes } = await run(mode, false, ambient);
      for (const [i, call] of calls.entries()) {
        if (call.source === SHARE_RETENTION_SCAN_SOURCE) expect(lanes[i]).toBe('background');
        else if (call.source) expect(lanes[i], `${call.source}, ambient ${ambient}`).toBe(ambient ?? 'normal');
      }
    }
  });

  it('makes no share-graph call outside the scripted pass, and none to a store method the adapter routing test does not cover', async () => {
    const { calls } = await run(mode, true, undefined);
    expect(calls.filter((call) => call.operation === '' && shareRowOf(call, GRAPHS) !== 'data-plane')).toEqual([]);
    expect([...new Set(calls.map((call) => call.method))].filter((method) => !ROUTING_TEST_METHODS.includes(method))).toEqual([]);
  });

  it('opens no ambient lane scope of its own: the lock and the sweep leave the caller\'s default lane as it was', async () => {
    for (const ambient of AMBIENTS) {
      const { calls } = await run(mode, true, ambient);
      expect(new Set(calls.map((call) => call.ambient))).toEqual(new Set([ambient]));
    }
  });
});

describe('the retention rows of the oracle can fail', () => {
  const call = (over: Partial<RecordedStoreCall>): RecordedStoreCall => ({
    index: 0, method: 'query', graphs: GRAPHS, options: { source: SHARE_RETENTION_SCAN_SOURCE, priority: 'background' }, source: SHARE_RETENTION_SCAN_SOURCE,
    ambient: undefined, operation: 'retention', ...over,
  });
  const withOptions = (options: RecordedStoreCall['options']) => call({ options, source: options?.source });
  const check = (calls: RecordedStoreCall[], pathOn = true) => () => expectShareTaggingTable(calls, GRAPHS, { pathOn });

  it('accepts a background scan, and verify and delete calls that carry the control tag', async () => {
    await withControlPath(true, async () => expect(check([
      call({}),
      withOptions({ source: `${R}verify`, controlQueue: 'share' }),
      { ...withOptions({ source: `${R}delete`, controlQueue: 'share' }), method: 'deleteByPatternWithoutCount' },
    ])).not.toThrow());
  });

  it('fails a scan that was given the control tag, no lane, or a lane other than background', () => {
    expect(check([withOptions({ source: SHARE_RETENTION_SCAN_SOURCE, priority: 'background', controlQueue: 'share' })])).toThrow(/not control work/);
    expect(check([withOptions({ source: SHARE_RETENTION_SCAN_SOURCE })])).toThrow(/background lane/);
    expect(check([withOptions({ source: SHARE_RETENTION_SCAN_SOURCE, priority: 'normal' })])).toThrow(/background lane/);
  });

  it('fails a verify or a delete that lost the control tag, or that asks for a lane of its own', () => {
    expect(check([withOptions({ source: `${R}verify` })])).toThrow(/controlQueue 'share'/);
    expect(check([{ ...withOptions({ source: `${R}delete` }), method: 'deleteByPatternWithoutCount' }])).toThrow(/controlQueue 'share'/);
    expect(check([withOptions({ source: `${R}verify`, controlQueue: 'share', priority: 'background' })])).toThrow(/sets no priority/);
  });

  it('fails a retention call tagged for the other queue', () => {
    expect(check([withOptions({ source: `${R}verify`, controlQueue: 'publisher' })])).toThrow(/controlQueue 'share'/);
  });
});
