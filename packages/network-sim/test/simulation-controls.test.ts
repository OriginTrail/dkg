// @vitest-environment happy-dom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPanel } from '../src/components/ControlPanel';
import * as api from '../src/api';
import { makeStore, mountUi, type MountedUi } from './ui-test-support';
vi.mock('../src/api');
vi.mock('../src/store', () => ({ useStore: () => store }));
let store = makeStore();
let ui: MountedUi;
let fetchMock: ReturnType<typeof vi.fn>;
class TestEventSource {
  static instances: TestEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { TestEventSource.instances.push(this); }
  emit(event: unknown) { act(() => this.onmessage?.({ data: JSON.stringify(event) })); }
}
beforeEach(async () => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
  store = makeStore(); TestEventSource.instances = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', TestEventSource);
  fetchMock = vi.fn(async () => Response.json({ started: true })); vi.stubGlobal('fetch', fetchMock);
  vi.mocked(api.fetchContextGraphs).mockResolvedValue({ contextGraphs: [] });
  ui = await mountUi(React.createElement(ControlPanel)); await ui.click('Simulate');
});
afterEach(() => { ui.unmount(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const source = () => TestEventSource.instances.at(-1)!;

describe('simulation form and streamed results', () => {
  it('submits edited parameters, keeps at least one operation, and blocks edits during the run', async () => {
    await ui.fill('Simulation Name', 'load-test'); await ui.fill('Context Graph', 'team');
    await ui.fill('Total Ops', '8'); await ui.fill('Ops/sec', '2.5'); await ui.fill('Concurrency', '3'); await ui.fill('KAs per Publish', '4');
    const ops = ui.container.querySelector('.graph-target-pills')!;
    await ui.click('Publish', ops); await ui.click('Shared Memory', ops); await ui.click('Query', ops); await ui.click('Chat', ops);
    expect(ops.querySelectorAll('.active')).toHaveLength(1);
    await ui.click('Query', ops);
    await ui.click('Play Simulation');
    const expected = { name: 'load-test', opCount: 8, opsPerSec: 2.5, concurrency: 3, kasPerPublish: 4, contextGraph: 'team', enabledOps: ['chat', 'query'] };
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/sim/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(expected) });
    expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'START_SIMULATION', name: 'load-test', config: { opCount: 8, opsPerSec: 2.5, concurrency: 3, kasPerPublish: 4, contextGraphId: 'team', enabledOps: ['chat', 'query'] } }));
    expect(ui.field('Total Ops').disabled).toBe(true);
    expect(source().url).toBe('/sim/events');
    source().emit({ type: 'op', opType: 'query', nodeId: 2, success: true, durationMs: 50, detail: 'query complete', phases: { query: 40 } });
    expect(store.addOperation).toHaveBeenCalledWith('query', 2, 'sim query');
    expect(store.completeOperation).toHaveBeenCalledWith('operation', 'success', 'query complete');
    source().emit({ type: 'op', opType: 'publish', nodeId: 1, success: true, durationMs: 20, detail: 'asset' });
    expect(store.addBroadcast).toHaveBeenCalledWith('publish', 1, 'sim publish');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(ui.container.textContent).toContain('1.0s');
    source().emit({ type: 'done', completed: 8, errors: 0 });
    expect(source().close).toHaveBeenCalledTimes(1);
    expect(ui.container.textContent).toContain('Simulation complete: 8 succeeded, 0 failed');
    const calls = vi.mocked(store.dispatch).mock.calls.length;
    act(() => source().onerror?.()); // A disconnect after done must not dispatch a second completion.
    source().emit({ type: 'op', opType: 'query', nodeId: 1, success: true });
    source().emit({ type: 'status', completed: 999, errors: 999 });
    expect(store.dispatch).toHaveBeenCalledTimes(calls);
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
  it('clamps empty numeric fields and uses a fallback run name', async () => {
    for (const name of ['Total Ops', 'Ops/sec', 'Concurrency', 'KAs per Publish']) await ui.fill(name, '');
    await ui.fill('Simulation Name', ''); await ui.click('Play Simulation');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ opCount: 1, opsPerSec: 1, concurrency: 1, kasPerPublish: 1 });
    expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'START_SIMULATION', name: expect.stringMatching(/^Simulation #/) }));
    act(() => source().onmessage?.({ data: 'malformed JSON' }));
    source().emit({ type: 'error', message: 'setup error' });
    source().emit({ type: 'status', completed: 1, errors: 0 });
    expect(ui.container.querySelector('.sim-stat-value')?.textContent).toBe('1/1');
    fetchMock.mockRejectedValueOnce(new Error('stop unavailable'));
    await ui.click('Stop Simulation');
    expect(source().close).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: 'STOP_SIMULATION' });
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
  it.each(['rejected', 'invalid-json', 'network'])('cleans up a %s start failure', async mode => {
    if (mode === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
    else fetchMock.mockResolvedValueOnce(mode === 'rejected' ? Response.json({ error: 'busy' }, { status: 409 }) : new Response('bad JSON', { status: 500 }));
    await ui.click('Play Simulation');
    expect(TestEventSource.instances).toEqual([]);
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: 'STOP_SIMULATION' });
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
});
