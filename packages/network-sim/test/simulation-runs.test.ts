import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
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
