// @vitest-environment happy-dom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPanel } from '../src/components/ControlPanel';
import * as api from '../src/api';
import { makeStore, mountUi, type MountedUi } from './ui-test-support';
vi.mock('../src/api');
const observed = vi.hoisted(() => ({ dispatch: vi.fn(), addBroadcast: vi.fn(), addOperation: vi.fn(), completeOperation: vi.fn() }));
vi.mock('../src/store', async original => {
  const actual = await original<typeof import('../src/store')>();
  return { ...actual, useStore: () => {
    const current = actual.useStore();
    // Observe public actions while all progress updates use the real reducer.
    observed.dispatch.mockImplementation(current.dispatch);
    observed.addBroadcast.mockImplementation(current.addBroadcast);
    observed.addOperation.mockImplementation(current.addOperation);
    observed.completeOperation.mockImplementation(current.completeOperation);
    store = { ...current, ...observed };
    return store;
  } };
});
import { StoreProvider } from '../src/store';
let store = makeStore();
let ui: MountedUi;
let fetchMock: ReturnType<typeof vi.fn>;
const queryCounts = (ok: number, fail: number) => ({ query: {
  ok, fail, timeouts: 0, totalMs: 0, allMs: 0, phaseTotals: {}, phaseCounts: {},
} });
class TestEventSource {
  static instances: TestEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) { TestEventSource.instances.push(this); }
  get runId() { return new URL(this.url, 'http://localhost').searchParams.get('runId')!; }
  emit(event: Record<string, unknown>) { act(() => this.onmessage?.({ data: JSON.stringify({ runId: this.runId, total: 500, elapsedMs: 1000, opsPerSec: 0, byOp: {}, ...event }) })); }
}
beforeEach(async () => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
  store = makeStore(); TestEventSource.instances = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('EventSource', TestEventSource);
  fetchMock = vi.fn(async (url: string) => Response.json(url.startsWith('/sim/start') ? { started: true } : { stopped: true, runId: new URL(url, 'http://localhost').searchParams.get('runId') })); vi.stubGlobal('fetch', fetchMock);
  vi.mocked(api.fetchContextGraphs).mockResolvedValue({ contextGraphs: [] });
  vi.mocked(api.fetchDevnetConfig).mockResolvedValue({ nodes: makeStore().state.nodes, contracts: {}, hubAddress: '', chainRpc: '' });
  vi.mocked(api.fetchNodeStatus).mockResolvedValue(makeStore().state.nodes[0].status!);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  ui = await mountUi(React.createElement(StoreProvider, null, React.createElement(ControlPanel))); await ui.click('Simulate');
});
afterEach(() => { ui.unmount(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const source = () => TestEventSource.instances.at(-1)!;
const runId = () => {
  const action = [...vi.mocked(store.dispatch).mock.calls].reverse().find(([action]) => action.type === 'START_SIMULATION')?.[0];
  if (action?.type !== 'START_SIMULATION') throw new Error('No simulation was started');
  return action.id;
};

describe('simulation form and streamed results', () => {
  it('keeps Stop available on disconnect and resumes results when the stream reconnects', async () => {
    await ui.click('Play Simulation');
    act(() => source().onerror?.());
    expect(source().close).not.toHaveBeenCalled(); // Leave native EventSource reconnection enabled.
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'COMPLETE_SIMULATION', id: runId() }));
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    expect(ui.field('Total Ops').disabled).toBe(true);
    expect(ui.container.querySelector('[role="status"]')?.textContent).toContain('Connection lost');
    expect(ui.container.querySelector('.sim-summary')).toBeNull();
    act(() => source().onopen?.());
    expect(ui.container.querySelector('[role="status"]')).toBeNull();
    source().emit({ type: 'status', completed: 12, errors: 1, byOp: queryCounts(11, 1) });
    expect(ui.container.querySelector('.sim-stat-value')?.textContent).toBe('11/500');
    source().emit({ type: 'done', completed: 500, errors: 1, byOp: queryCounts(499, 1) });
    expect(ui.container.textContent).toContain('Simulation complete: 499 succeeded, 1 failed');
    expect(store.state.simulationRuns.at(-1)?.outcome?.kind).toBe('completed');
    expect(ui.field('Simulation Name').value).toBe('Simulation #2');
    expect(source().close).toHaveBeenCalledOnce();
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
  it('waits for server cancellation before hiding Stop after a disconnect', async () => {
    await ui.click('Play Simulation');
    act(() => source().onerror?.());
    let confirm!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { confirm = resolve; }));
    await ui.click('Stop Simulation');
    expect(fetchMock).toHaveBeenLastCalledWith(`/sim/stop?runId=${runId()}`, expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'COMPLETE_SIMULATION', id: runId() }));
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    await act(async () => confirm(Response.json({ stopped: true, runId: runId() })));
    expect(source().close).toHaveBeenCalledOnce();
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: 'COMPLETE_SIMULATION', id: runId(), outcome: { kind: 'cancelled' } });
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
  it.each(['network', 'http'])('retains Stop after a %s cancellation failure and permits retry', async failure => {
    await ui.click('Play Simulation');
    act(() => source().onerror?.());
    if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('stop unavailable'));
    else fetchMock.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    await ui.click('Stop Simulation');
    expect(source().close).not.toHaveBeenCalled();
    expect(store.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'COMPLETE_SIMULATION', id: runId() }));
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    expect(ui.container.querySelector('.sim-summary')).toBeNull();
    fetchMock.mockResolvedValueOnce(Response.json({ stopped: true, runId: runId() }));
    await ui.click('Stop Simulation');
    expect(source().close).toHaveBeenCalledOnce();
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: 'COMPLETE_SIMULATION', id: runId(), outcome: { kind: 'cancelled' } });
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
  it.each([true, false])('ignores a late stop response and stream callbacks from a previous run (stopped: %s)', async stopped => {
    await ui.click('Play Simulation');
    const oldSource = source();
    let confirm!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { confirm = resolve; }));
    await ui.click('Stop Simulation');
    oldSource.emit({ type: 'done', completed: 500, errors: 0, byOp: queryCounts(500, 0) });
    await ui.click('Play Simulation');
    act(() => source().onerror?.());
    await act(async () => confirm(Response.json({ stopped, runId: oldSource.runId, retryAfterMs: 1000 })));
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    expect(ui.container.querySelector('[role="status"]')?.textContent).toContain('Connection lost');
    expect(source().close).not.toHaveBeenCalled();
    expect(store.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'START_SIMULATION' }));
    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
    const requests = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    act(() => oldSource.onopen?.());
    expect(ui.container.querySelector('[role="status"]')?.textContent).toContain('Connection lost');
    act(() => source().onopen?.());
    expect(ui.container.querySelector('[role="status"]')).toBeNull();
    act(() => oldSource.onerror?.());
    expect(ui.container.querySelector('[role="status"]')).toBeNull();
  });
  it.each(['start-first', 'stop-first'])('honors startup cancellation when responses arrive %s', async ordering => {
    let started!: (response: Response) => void;
    let stopped!: (response: Response) => void;
    const startResponse = new Promise<Response>(resolve => { started = resolve; });
    const stopResponse = new Promise<Response>(resolve => { stopped = resolve; });
    fetchMock.mockReturnValueOnce(startResponse).mockReturnValueOnce(stopResponse);
    await ui.click('Play Simulation');
    expect(TestEventSource.instances).toHaveLength(0);
    await ui.click('Stop Simulation');
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2); // Run-scoped cancellation does not wait for the start response.
    if (ordering === 'start-first') {
      await act(async () => started(Response.json({ started: true })));
      await act(async () => stopped(Response.json({ stopped: true, runId: runId() })));
    } else {
      await act(async () => stopped(Response.json({ stopped: true, runId: runId() })));
      await act(async () => started(Response.json({ started: true })));
    }
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: 'COMPLETE_SIMULATION', id: runId(), outcome: { kind: 'cancelled' } });
    expect(ui.button('Play Simulation').disabled).toBe(false);
    expect(TestEventSource.instances.filter(stream => stream.close.mock.calls.length === 0)).toHaveLength(0);
    const calls = vi.mocked(store.dispatch).mock.calls.length;
    source()?.emit({ type: 'op', opType: 'query', nodeId: 2, success: true });
    expect(store.dispatch).toHaveBeenCalledTimes(calls);
  });
  it.each(['http', 'network'])('targets only its own run when a pending start fails via %s', async failure => {
    let resolve!: (response: Response) => void, reject!: (error: Error) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((yes, no) => { resolve = yes; reject = no; }));
    await ui.click('Play Simulation'); await ui.click('Stop Simulation');
    await act(async () => {
      if (failure === 'http') resolve(Response.json({ error: 'another run is active' }, { status: 409 }));
      else reject(new Error('start unavailable'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`/sim/stop?runId=${runId()}`);
    expect(TestEventSource.instances).toHaveLength(0);
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
  it.each(['op', 'status'])('counts failures once in progress and excludes them from succeeded totals via %s events', async eventType => {
    await ui.fill('Total Ops', '2');
    await ui.click('Play Simulation');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    if (eventType === 'op') source().emit({ type: 'op', opType: 'query', nodeId: 2, success: false, durationMs: 10, detail: 'rejected' });
    else source().emit({ type: 'status', completed: 1, errors: 1, byOp: queryCounts(0, 1) });
    expect((ui.container.querySelector('.sim-progress-fill') as HTMLElement).style.width).toBe('50%');
    expect(ui.container.querySelector('.sim-stat-value')?.textContent).toBe('0/2');
    expect(ui.container.querySelectorAll('.sim-stat-value')[2].textContent).toBe('1.0');
    if (eventType === 'op') source().emit({ type: 'op', opType: 'query', nodeId: 2, success: true, durationMs: 10, detail: 'done' });
    else source().emit({ type: 'status', completed: 2, errors: 1, byOp: queryCounts(1, 1) });
    expect((ui.container.querySelector('.sim-progress-fill') as HTMLElement).style.width).toBe('100%');
    expect(ui.container.querySelector('.sim-stat-value')?.textContent).toBe('1/2');
    source().emit({ type: 'done', completed: 2, errors: 1, byOp: queryCounts(1, 1) });
    expect(ui.container.textContent).toContain('Simulation complete: 1 succeeded, 1 failed');
  });
  it('submits edited parameters, keeps at least one operation, and blocks edits during the run', async () => {
    await ui.fill('Simulation Name', 'load-test'); await ui.fill('Context Graph', 'team');
    await ui.fill('Total Ops', '8'); await ui.fill('Ops/sec', '2.5'); await ui.fill('Concurrency', '3'); await ui.fill('KAs per Publish', '4');
    const ops = ui.container.querySelector('.graph-target-pills')!;
    await ui.click('Publish', ops); await ui.click('Shared Memory', ops); await ui.click('Query', ops); await ui.click('Chat', ops);
    expect(ops.querySelectorAll('.active')).toHaveLength(1);
    await ui.click('Query', ops);
    await ui.click('Play Simulation');
    const expected = { name: 'load-test', opCount: 8, opsPerSec: 2.5, concurrency: 3, kasPerPublish: 4, contextGraph: 'team', enabledOps: ['chat', 'query'] };
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/sim/start?runId=${runId()}`, expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: expect.any(AbortSignal) }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expected);
    expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'START_SIMULATION', name: 'load-test', config: { opCount: 8, opsPerSec: 2.5, concurrency: 3, kasPerPublish: 4, contextGraphId: 'team', enabledOps: ['chat', 'query'] } }));
    expect(ui.field('Total Ops').disabled).toBe(true);
    expect(source().url).toBe(`/sim/events?runId=${runId()}`);
    source().emit({ type: 'op', opType: 'query', nodeId: 2, success: true, durationMs: 50, detail: 'query complete', phases: { query: 40 } });
    expect(store.addOperation).toHaveBeenCalledWith('query', 2, 'sim query');
    expect(store.completeOperation).toHaveBeenCalledWith(vi.mocked(store.addOperation).mock.results[0].value, 'success', 'query complete');
    source().emit({ type: 'op', opType: 'publish', nodeId: 1, success: true, durationMs: 20, detail: 'asset' });
    expect(store.addBroadcast).toHaveBeenCalledWith('publish', 1, 'sim publish');
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(ui.container.textContent).toContain('1.0s');
    source().emit({ type: 'done', completed: 8, errors: 0, byOp: queryCounts(8, 0) });
    expect(source().close).toHaveBeenCalledTimes(1);
    expect(ui.container.textContent).toContain('Simulation complete: 8 succeeded, 0 failed');
    const calls = vi.mocked(store.dispatch).mock.calls.length;
    act(() => source().onerror?.()); // A disconnect after done must not dispatch a second completion.
    source().emit({ type: 'op', opType: 'query', nodeId: 1, success: true });
    source().emit({ type: 'status', completed: 999, errors: 999, byOp: queryCounts(0, 999) });
    expect(store.dispatch).toHaveBeenCalledTimes(calls);
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
  it('clamps empty numeric fields and uses a fallback run name', async () => {
    for (const name of ['Total Ops', 'Ops/sec', 'Concurrency', 'KAs per Publish']) await ui.fill(name, '');
    await ui.fill('Simulation Name', ''); await ui.click('Play Simulation');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ opCount: 1, opsPerSec: 1, concurrency: 1, kasPerPublish: 1 });
    expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'START_SIMULATION', name: expect.stringMatching(/^Simulation #/) }));
    act(() => source().onmessage?.({ data: 'malformed JSON' }));
    source().emit({ type: 'heartbeat' });
    expect(ui.container.querySelector('.sim-stat-value')?.textContent).toBe('0/1');
    source().emit({ type: 'error', message: 'setup progress', counted: false });
    expect(store.state.simulationRuns.at(-1)?.diagnosticCount ?? 0).toBe(0);
    source().emit({ type: 'error', message: 'setup error' });
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toBe('setup error');
    expect(store.state.liveMetrics.errors).toBe(0);
    expect(store.state.simulationRuns.at(-1)?.diagnosticCount).toBe(1);
    expect(ui.container.querySelectorAll('.sim-stat-value')[1].textContent).toBe('1');
    source().emit({ type: 'status', completed: 1, errors: 0, byOp: queryCounts(1, 0) });
    expect(store.state.liveMetrics.errors).toBe(0);
    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
    expect(ui.container.querySelector('.sim-stat-value')?.textContent).toBe('1/1');
    await ui.click('Stop Simulation');
    expect(source().close).toHaveBeenCalledTimes(1);
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: 'COMPLETE_SIMULATION', id: runId(), outcome: { kind: 'cancelled' } });
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
  it.each(['rejected', 'proxy', 'network'])('cleans up a %s start failure', async mode => {
    if (mode === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
    else fetchMock.mockResolvedValueOnce(mode === 'rejected' ? Response.json({ error: 'busy' }, { status: 409 }) : new Response('bad JSON', { status: 500 }));
    await ui.click('Play Simulation');
    if (mode !== 'rejected') await act(async () => source().emit({ type: 'unavailable', message: 'Results for this simulation are no longer available.' }));
    else expect(TestEventSource.instances).toEqual([]);
    expect(store.dispatch).toHaveBeenLastCalledWith({ type: 'COMPLETE_SIMULATION', id: runId(), outcome: { kind: mode === 'rejected' ? 'start-rejected' : 'cancelled' } });
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });
});


describe('run-scoped client recovery', () => {
  it('restores missed terminal totals and rejects another run before and after reconnection', async () => {
    await ui.click('Play Simulation'); const old = source();
    old.emit({ type: 'op', opType: 'query', nodeId: 2, success: true, durationMs: 10 });
    const recorded = vi.mocked(store.dispatch).mock.calls.length;
    act(() => old.onerror?.()); act(() => old.onopen?.());
    old.emit({ type: 'op', runId: 'foreign', opType: 'query', nodeId: 2, success: true });
    old.emit({ type: 'done', runId: 'foreign', completed: 99, errors: 0, byOp: queryCounts(99, 0) });
    expect(store.dispatch).toHaveBeenCalledTimes(recorded);
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    old.emit({ type: 'done', completed: 500, errors: 2, byOp: queryCounts(498, 2), elapsedMs: 2500 });
    expect(ui.container.textContent).toContain('Simulation complete: 498 succeeded, 2 failed in 2.5s');
    expect(old.close).toHaveBeenCalledOnce();
    const done = vi.mocked(store.dispatch).mock.calls.length;
    old.emit({ type: 'status', completed: 999, errors: 999, byOp: queryCounts(0, 999) });
    old.emit({ type: 'done', completed: 999, errors: 999, byOp: queryCounts(0, 999) });
    expect(store.dispatch).toHaveBeenCalledTimes(done);
  });

  it('reports unavailable results without fabricating successful completion', async () => {
    await ui.click('Play Simulation');
    await act(async () => source().emit({ type: 'unavailable', message: 'Results for this simulation are no longer available.' }));
    expect(fetchMock).toHaveBeenLastCalledWith(`/sim/stop?runId=${runId()}`, expect.objectContaining({ method: 'POST' }));
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain('Cancellation confirmed');
    expect(ui.container.querySelector('.sim-summary')).toBeNull();
    expect(ui.button('Play Simulation').disabled).toBe(false);
    await ui.click('Play Simulation');
    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('cancels an accepted run while its start response remains pending', async () => {
    let completeStart!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { completeStart = resolve; }));
    await ui.click('Play Simulation');
    const id = runId();
    expect(TestEventSource.instances).toHaveLength(0);
    await ui.click('Stop Simulation');
    expect(fetchMock.mock.calls[1][0]).toBe(`/sim/stop?runId=${id}`);
    expect(ui.button('Play Simulation').disabled).toBe(false);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => completeStart(Response.json({ started: true })));
    expect(TestEventSource.instances).toHaveLength(0);
  });

  it('keeps cancellation retryable when its response stalls beyond the deadline', async () => {
    await ui.click('Play Simulation');
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));
    await ui.click('Stop Simulation');
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(signal.aborted).toBe(true);
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain('retry');
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    await ui.click('Stop Simulation');
    expect(source().close).toHaveBeenCalledOnce();
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });

  it.each(['wrong-run', 'wrong-snapshot', 'not-stopped', 'bad-json'])('does not finalize on a %s cancellation response', async mode => {
    await ui.click('Play Simulation');
    fetchMock.mockResolvedValueOnce(mode === 'bad-json' ? new Response('invalid JSON') : Response.json({ stopped: mode !== 'not-stopped', runId: mode === 'wrong-run' ? 'foreign' : runId(), ...(mode === 'wrong-snapshot' ? { snapshot: { type: 'done', runId: 'foreign', completed: 999, errors: 0, byOp: queryCounts(999, 0), elapsedMs: 1000 } } : {}) }));
    await ui.click('Stop Simulation');
    expect(source().close).not.toHaveBeenCalled();
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain('retry');
  });

  it('does not let a late failed stop request show an error on a newer run', async () => {
    await ui.click('Play Simulation');
    let reject!: (error: Error) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((_resolve, no) => { reject = no; }));
    await ui.click('Stop Simulation');
    source().emit({ type: 'done', completed: 500, errors: 0, byOp: queryCounts(500, 0) });
    await ui.click('Play Simulation');
    await act(async () => reject(new Error('old request timed out')));
    expect(ui.container.querySelector('[role="alert"]')).toBeNull();
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    expect(source().close).not.toHaveBeenCalled();
  });

  it('uses final totals returned by cancellation when the stream missed progress', async () => {
    await ui.click('Play Simulation');
    fetchMock.mockResolvedValueOnce(Response.json({ stopped: true, runId: runId(), snapshot: { type: 'done', runId: runId(), total: 500, completed: 17, errors: 2, byOp: queryCounts(15, 2), elapsedMs: 2000 } }));
    await ui.click('Stop Simulation');
    expect(ui.container.textContent).toContain('Simulation complete: 15 succeeded, 2 failed in 2.0s');
  });

  it('reconciles an ambiguous start transport failure against its own server stream', async () => {
    fetchMock.mockRejectedValueOnce(new Error('response lost after acceptance'));
    await ui.click('Play Simulation');
    expect(source().url).toBe(`/sim/events?runId=${runId()}`);
    expect(ui.button('Stop Simulation').disabled).toBe(false);
    source().emit({ type: 'done', completed: 500, errors: 0, byOp: queryCounts(500, 0) });
    expect(ui.container.textContent).toContain('Simulation complete: 500 succeeded, 0 failed');
  });

  it.each(['pending-start', 'streaming'])('releases %s resources on unmount and ignores late work', async phase => {
    let complete!: (response: Response) => void;
    if (phase === 'pending-start') fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { complete = resolve; }));
    await ui.click('Play Simulation');
    const controller = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const stream = source(); const calls = vi.mocked(store.dispatch).mock.calls.length;
    ui.unmount();
    expect(controller.aborted).toBe(true);
    if (phase === 'pending-start') {
      await act(async () => complete(Response.json({ started: true })));
      expect(TestEventSource.instances).toHaveLength(0);
    } else {
      expect(stream.close).toHaveBeenCalledOnce();
      stream.emit({ type: 'done', completed: 500, errors: 0, byOp: queryCounts(500, 0) });
    }
    expect(store.dispatch).toHaveBeenCalledTimes(calls);
  });
});


it.each(['cancelled', 'start-rejected'] as const)('stores %s without showing a completed summary or resetting the name', async kind => {
  await ui.fill('Simulation Name', 'Recovery trial');
  if (kind === 'start-rejected') fetchMock.mockResolvedValueOnce(Response.json({ error: 'rejected' }, { status: 409 }));
  await ui.click('Play Simulation');
  if (kind === 'cancelled') await ui.click('Stop Simulation');
  expect(store.state.simulationRuns.at(-1)?.outcome).toEqual({ kind });
  expect(store.state.activeSimulationId).toBeNull();
  const alert = kind === 'cancelled' ? 'Cancellation confirmed' : 'could not be started';
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain(alert);
  expect(ui.container.querySelector('.sim-summary')).toBeNull();
  expect(ui.field('Simulation Name').value).toBe('Recovery trial');
  await ui.click('Query'); await ui.click('Simulate');
  expect(ui.container.querySelector('[role="alert"]')?.textContent).toContain(alert);
  expect(ui.container.querySelector('.sim-summary')).toBeNull();
  expect(ui.field('Simulation Name').value).toBe('Recovery trial');
});
