import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationRuns } from '../src/server/simulation-runs';
import type { ScopedSimEvent } from '../src/simulation-protocol';

describe('run registry failure finalization', () => {
  it.each([new Error('setup failed'), 'transport failed'])('publishes a terminal run failure and ignores late results: %s', error => {
    const registry = new SimulationRuns();
    const admitted = registry.admit('failed-run', 2);
    if (!admitted.accepted) throw new Error('fixture run was rejected');
    const events: ScopedSimEvent[] = [];
    const client = { write: vi.fn((chunk: string) => { events.push(JSON.parse(chunk.slice(6))); return true; }), end: vi.fn() };
    registry.subscribe(client as unknown as ServerResponse, admitted.run.id);
    registry.fail(admitted.run, error);
    expect(admitted.run.stats).toMatchObject({ completed: 0, errors: 0 });
    expect(admitted.run.diagnosticCount).toBe(1);
    const terminal = registry.finish(admitted.run);
    expect(events.map(event => event.type)).toEqual(['status', 'error', 'done']);
    expect(events[1]).toEqual({ type: 'error', runId: 'failed-run', message: error instanceof Error ? error.message : error });
    expect(terminal).toMatchObject({ completed: 0, errors: 1, byOp: {} });
    expect(client.end).toHaveBeenCalledOnce();
    const frozen = structuredClone(terminal);
    const successor = registry.admit('successor', 1);
    expect(successor.accepted).toBe(true);
    registry.fail(admitted.run, new Error('late failure'));
    expect(registry.record(admitted.run, { type: 'op', opType: 'query', nodeId: 1, success: true,
      durationMs: 200, detail: 'late result', phases: { query: 200 } })).toBe(false);
    expect(registry.finish(admitted.run)).toEqual(frozen);
    expect(events).toHaveLength(3);
    expect(registry.active?.id).toBe('successor');
    expect(registry.active?.stats).toMatchObject({ completed: 0, errors: 0 });
  });
});

describe('expiring start admission', () => {
  afterEach(() => vi.useRealTimers());
  it('never reopens an expired start window after the server clock rolls back', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
    const registry = new SimulationRuns();
    const now = Date.now();
    const id = `sim-v1-${now + 30_000}-expired`;
    vi.setSystemTime(now + 30_000);
    expect(registry.cancel(id)).toEqual({ stopped: true, runId: id });
    vi.setSystemTime(now);
    expect(registry.admit(id, 1).accepted).toBe(false);
  });
  it('still cancels an accepted run after its admission window closes', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
    const id = `sim-v1-${Date.now() + 30_000}-accepted`;
    const registry = new SimulationRuns();
    const admitted = registry.admit(id, 1);
    expect(admitted.accepted).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(registry.cancel(id)).toMatchObject({ stopped: true, runId: id, snapshot: { type: 'done', completed: 0 } });
    expect(registry.active).toBeNull();
    if (admitted.accepted) expect(admitted.run.abort.signal.aborted).toBe(true);
  });
});
