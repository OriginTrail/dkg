import { afterEach, expect, it, vi } from 'vitest';
import { SimulationRuns } from '../src/server/simulation-runs';
import { combineMetrics, emptyMetrics, recordMetric, snapshotMetrics } from '../src/simulation-metrics';
import type { OpEvent, SimOp } from '../src/simulation-protocol';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['query', '__proto__', 'constructor', 'toString'])('keeps incremental and recovered metrics equivalent and immutable for %s', rawType => {
  // Deliberately bypass request validation to exercise defensive dictionary handling.
  const opType = rawType as SimOp;
  vi.useFakeTimers(); vi.setSystemTime(1000);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
  const registry = new SimulationRuns();
  const admission = registry.admit('metrics', 3);
  if (!admission.accepted) throw new Error('fixture run rejected');
  let incremental = emptyMetrics();
  const history: Array<{ value: typeof incremental; copy: typeof incremental }> = [];
  const events: OpEvent[] = [
    { type: 'op', opType, nodeId: 1, success: true, durationMs: 100, detail: 'ok', phases: { query: 40, ['__proto__']: 3 } },
    { type: 'op', opType, nodeId: 2, success: false, durationMs: 50, detail: 'timeout after 50ms', phases: { query: 20, constructor: 4 } },
    { type: 'op', opType, nodeId: 3, success: false, durationMs: 0, detail: 'executor failure', phases: {} },
  ];
  for (const event of events) {
    history.push({ value: incremental, copy: structuredClone(incremental) });
    incremental = recordMetric(incremental, event);
    expect(registry.record(admission.run, event)).toBe(true);
    expect(snapshotMetrics({ type: 'status', ...registry.status(admission.run) }, incremental)).toEqual(incremental);
    vi.advanceTimersByTime(100);
  }
  const expected = { total: 3, success: 1, errors: 2, totalDurationMs: 150, successDurationMs: 100,
    phaseTotals: { query: 60, ['__proto__']: 3, constructor: 4 },
    phaseCounts: { query: 2, ['__proto__']: 1, constructor: 1 } };
  expect(incremental.byType[opType]).toEqual(expected);
  expect(incremental.recentTimestamps).toEqual([1000, 1100, 1200]);
  expect(registry.finish(admission.run).byOp[opType]).toEqual({ ok: 1, fail: 2, timeouts: 1, totalMs: 100, allMs: 150,
    phaseTotals: expected.phaseTotals, phaseCounts: expected.phaseCounts });
  expect(snapshotMetrics(registry.finish(admission.run), incremental)).toEqual(incremental);
  const manual = recordMetric(emptyMetrics(), { opType: 'manual', success: true, durationMs: 9 });
  expect(combineMetrics(manual, incremental).byType).toEqual({ manual: manual.byType.manual, [opType]: expected });
  for (const { value, copy } of history) expect(value).toEqual(copy);
  expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
});

it('isolates outgoing snapshot dictionaries from canonical accounting and future results', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const registry = new SimulationRuns();
  const admission = registry.admit('snapshot-isolation', 2);
  if (!admission.accepted) throw new Error('fixture run rejected');
  const event: OpEvent = { type: 'op', opType: 'query', nodeId: 1, success: true,
    durationMs: 100, detail: 'ok', phases: { query: 40 } };
  registry.record(admission.run, event);
  const first = registry.status(admission.run);
  const retained = structuredClone(first);
  registry.record(admission.run, { ...event, success: false, durationMs: 50, detail: 'timeout', phases: { query: 20 } });
  expect(first).toEqual(retained);
  first.byOp.query.ok = 900;
  first.byOp.query.phaseTotals.query = 900;
  first.byOp.query.phaseCounts.query = 900;
  const second = registry.status(admission.run);
  expect(second.byOp.query).toEqual({ ok: 1, fail: 1, timeouts: 1, totalMs: 100, allMs: 150,
    phaseTotals: { query: 60 }, phaseCounts: { query: 2 } });
  second.byOp.query.phaseTotals.query = 999;
  expect(registry.finish(admission.run).byOp.query.phaseTotals.query).toBe(60);
});


it('keeps run diagnostics out of operation totals while preserving legacy wire counts', () => {
  const registry = new SimulationRuns();
  const admission = registry.admit('diagnostics', 2);
  if (!admission.accepted) throw new Error('fixture run rejected');
  registry.fail(admission.run, new Error('setup diagnostic'));
  expect(snapshotMetrics({ type: 'status', ...registry.status(admission.run) }, emptyMetrics()))
    .toEqual(emptyMetrics());
  registry.record(admission.run, { type: 'op', opType: 'query', nodeId: 1, success: true, durationMs: 5, detail: 'ok', phases: {} });
  registry.fail(admission.run, new Error('transport diagnostic'));
  const terminal = registry.finish(admission.run);
  expect(terminal).toMatchObject({ completed: 1, errors: 2 });
  expect(snapshotMetrics(terminal, emptyMetrics())).toMatchObject({ total: 1, success: 1, errors: 0 });
  expect(admission.run.stats).toMatchObject({ completed: 1, errors: 0 });
});
