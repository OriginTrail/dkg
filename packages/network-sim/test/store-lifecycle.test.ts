// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider, useStore, type SimulationRun } from '../src/store';
import { fetchDevnetConfig, fetchNodeStatus } from '../src/api';
import type { DevnetConfig, NodeStatus } from '../src/types';

vi.mock('../src/api', () => ({ fetchDevnetConfig: vi.fn(), fetchNodeStatus: vi.fn() }));
const status: NodeStatus = { name: 'core', peerId: 'peer-1', nodeRole: 'core', uptimeMs: 100,
  connectedPeers: 2, connections: 2, relayConnected: false, multiaddrs: [] };
const config: DevnetConfig = { nodes: [1, 2, 3].map(id => ({ id, name: `Node ${id}`, apiPort: 9200 + id,
  listenPort: 10000 + id, nodeRole: id === 1 ? 'core' : 'edge' })), contracts: {}, hubAddress: '', chainRpc: '' };
const runConfig: SimulationRun['config'] = { opCount: 10, opsPerSec: 2, concurrency: 2,
  kasPerPublish: 1, contextGraphId: 'team', enabledOps: ['publish', 'query'] };
let store: ReturnType<typeof useStore>;
let root: Root | undefined;
let container: HTMLDivElement;
let frame: FrameRequestCallback;
const cancelFrame = vi.fn();

function Probe() { store = useStore(); return null; }
async function mount() {
  root = createRoot(container);
  await act(async () => { root!.render(React.createElement(StoreProvider, null, React.createElement(Probe))); });
}
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function stop() { if (root) { act(() => root!.unmount()); root = undefined; } }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frame = callback; return 41; }));
  vi.stubGlobal('cancelAnimationFrame', cancelFrame.mockReset());
  vi.mocked(fetchDevnetConfig).mockReset().mockResolvedValue(structuredClone(config));
  vi.mocked(fetchNodeStatus).mockReset().mockResolvedValue(status);
  container = document.createElement('div'); document.body.appendChild(container);
});
afterEach(() => {
  stop(); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('store initialization and polling', () => {
  it.each(['devnet', 'testnet'] as const)('supplies the documented %s nodes when configuration has none', async network => {
    vi.mocked(fetchDevnetConfig).mockResolvedValue({ ...config, nodes: [], network });
    await mount();
    expect(store.state.networkMode).toBe(network);
    expect(store.state.nodes.map(n => [n.id, n.apiPort, n.nodeRole])).toEqual(network === 'testnet'
      ? [[1, 9200, 'edge']]
      : [[1, 9201, 'core'], [2, 9202, 'edge'], [3, 9203, 'edge'], [4, 9204, 'edge'], [5, 9205, 'edge'], [6, 9206, 'edge']]);
    expect(store.state.nodes.every(n => n.online && n.status?.peerId === 'peer-1')).toBe(true);
  });

  it('recovers from unavailable configuration and clears configuration errors on replacement', async () => {
    vi.mocked(fetchDevnetConfig).mockRejectedValue(new Error('config unavailable'));
    await mount();
    expect(store.state.nodes).toHaveLength(6);
    expect(store.state.config?.chainRpc).toBe('http://127.0.0.1:8545');
    act(() => store.dispatch({ type: 'CONFIG_ERROR', error: 'invalid config' }));
    expect(store.state.configError).toBe('invalid config');
    act(() => store.dispatch({ type: 'SELECT_NODE', id: 6 }));
    expect(store.state.selectedNode).toBe(6);
    await act(async () => store.dispatch({ type: 'SET_CONFIG', config: { ...config, network: 'testnet', nodes: [{ ...config.nodes[0], name: '' }] } }));
    expect(store.state.configError).toBeNull();
    expect(store.state.nodes[0].name).toBe('testnet-node-1');
    act(() => store.dispatch({ type: 'SELECT_NODE', id: 1 }));
    expect(store.state.selectedNode).toBe(1);
  });

  it('backs off all-offline polling, caps it, and returns to normal cadence after recovery', async () => {
    vi.mocked(fetchNodeStatus).mockRejectedValue(new Error('offline'));
    await mount();
    expect(store.state.nodes.every(n => !n.online && n.status === null)).toBe(true);
    let calls = 3;
    for (const delay of [5000, 7000, 9000, 11000, 13000, 15000, 15000]) {
      await advance(delay - 1); expect(fetchNodeStatus).toHaveBeenCalledTimes(calls);
      await advance(1); calls += 3; expect(fetchNodeStatus).toHaveBeenCalledTimes(calls);
    }
    vi.mocked(fetchNodeStatus).mockResolvedValue(status);
    await advance(15000); calls += 3;
    expect(store.state.nodes.every(n => n.online)).toBe(true);
    await advance(2999); expect(fetchNodeStatus).toHaveBeenCalledTimes(calls);
    await advance(1); expect(fetchNodeStatus).toHaveBeenCalledTimes(calls + 3);
  });

  it('uses the slower cadence while a simulation runs, then restores idle polling', async () => {
    await mount();
    act(() => store.dispatch({ type: 'START_SIMULATION', id: 'run', name: 'Load', config: runConfig }));
    await advance(3000); expect(fetchNodeStatus).toHaveBeenCalledTimes(6);
    await advance(9999); expect(fetchNodeStatus).toHaveBeenCalledTimes(6);
    await advance(1); expect(fetchNodeStatus).toHaveBeenCalledTimes(9);
    act(() => store.dispatch({ type: 'COMPLETE_SIMULATION', id: 'run' }));
    await advance(10000); expect(fetchNodeStatus).toHaveBeenCalledTimes(12);
    await advance(3000); expect(fetchNodeStatus).toHaveBeenCalledTimes(15);
  });

  it('does not overlap polls or schedule another poll after unmount during an in-flight request', async () => {
    let resolve!: (value: NodeStatus) => void;
    const pending = new Promise<NodeStatus>(done => { resolve = done; });
    vi.mocked(fetchNodeStatus).mockReturnValue(pending);
    await mount();
    await advance(60000); expect(fetchNodeStatus).toHaveBeenCalledTimes(3);
    stop();
    await act(async () => { resolve(status); await pending; });
    expect(vi.getTimerCount()).toBe(0);
    await advance(60000); expect(fetchNodeStatus).toHaveBeenCalledTimes(3);
    expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(41);
  });
});

describe('public store operations', () => {
  it('bounds activity history, completes the correct operation, and preserves details when omitted', async () => {
    await mount();
    const ids: string[] = [];
    act(() => { for (let i = 0; i < 205; i++) ids.push(store.addOperation('query', 1, `Query ${i}`)); });
    expect(new Set(ids).size).toBe(205);
    expect(store.state.activities.map(a => a.id)).toEqual(ids.slice(5).reverse());
    act(() => { store.completeOperation(ids[204], 'error', 'timeout'); store.completeOperation(ids[203], 'success'); });
    act(() => store.completeOperation(ids[204], 'success'));
    expect(store.state.activities[0]).toMatchObject({ id: ids[204], status: 'success', detail: 'timeout' });
    expect(store.state.activities[1]).toMatchObject({ id: ids[203], status: 'success', detail: undefined });
    expect(store.state.activities[2].status).toBe('pending');
  });

  it('broadcasts only to current online peers, including when using a saved callback', async () => {
    await mount();
    const broadcast = store.addBroadcast;
    act(() => store.dispatch({ type: 'UPDATE_NODE', id: 2, online: false, status: null }));
    let id = '';
    act(() => { id = broadcast('publish', 1, 'Publish'); });
    expect(store.state.animations).toHaveLength(1);
    expect(store.state.animations[0]).toMatchObject({ id: `${id}-b0`, from: 0, to: 2, type: 'publish', speed: 0.5 });
    expect(store.state.animations[0].progress).toBeCloseTo(0);
    act(() => store.dispatch({ type: 'UPDATE_NODE', id: 3, online: false, status: null }));
    act(() => { id = broadcast('publish', 1, 'Local'); });
    expect(store.state.animations.at(-1)).toEqual({ id, from: 0, to: 0, type: 'publish', progress: 0, speed: 0.4 });
    act(() => store.dispatch({ type: 'REMOVE_ANIMATION', id }));
    expect(store.state.animations).toHaveLength(1);
  });

  it('advances directed and local animations by elapsed frame time and removes completed ones', async () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    await mount();
    act(() => { store.addOperation('chat', 1, 'To peer', 3); store.addOperation('query', 1, 'Local', 1); });
    expect(store.state.animations.map(a => [a.from, a.to])).toEqual([[0, 2], [0, 0]]);
    now += 1000; act(() => frame(now));
    expect(store.state.animations.map(a => a.progress)).toEqual([0.6, 0.4]);
    now += 1000; act(() => frame(now));
    expect(store.state.animations.map(a => [a.type, a.progress])).toEqual([['query', 0.8]]);
    now += 1000; act(() => frame(now));
    expect(store.state.animations).toEqual([]);
  });

  it('combines observed timestamps chronologically and ignores results for a retired run', async () => {
    await mount();
    const began = Date.now();
    act(() => store.dispatch({ type: 'START_SIMULATION', id: 'current', name: 'Current', config: runConfig }));
    const op = { type: 'RECORD_OP' as const, opType: 'query', success: true, durationMs: 10 };
    act(() => store.dispatch({ ...op, simulationId: 'current' }));
    vi.setSystemTime(began + 100);
    act(() => store.dispatch(op));
    vi.setSystemTime(began + 200);
    act(() => store.dispatch({ ...op, simulationId: 'current' }));
    expect(store.state.liveMetrics.recentTimestamps).toEqual([began, began + 100, began + 200]);
    const before = structuredClone(store.state.liveMetrics);
    act(() => store.dispatch({ ...op, simulationId: 'retired' }));
    expect(store.state.liveMetrics).toEqual(before);
    act(() => store.dispatch({ type: 'RESET_LIVE_METRICS' }));
    expect(store.state.liveMetrics).toMatchObject({ total: 2, recentTimestamps: [began, began + 200] });
    expect(store.state.simulationRuns[0].metrics).toEqual(store.state.liveMetrics);
  });

  it('reconciles server totals without double counting or overwriting manual work', async () => {
    await mount();
    act(() => store.dispatch({ type: 'START_SIMULATION', id: 'older', name: 'Older', config: runConfig }));
    act(() => store.dispatch({ type: 'COMPLETE_SIMULATION', id: 'older' }));
    const older = structuredClone(store.state.simulationRuns[0]);
    act(() => store.dispatch({ type: 'START_SIMULATION', id: 'recovering', name: 'Recovering', config: runConfig }));
    act(() => store.dispatch({ type: 'RECORD_OP', simulationId: 'recovering', opType: 'publish', success: true, durationMs: 100, phases: { prepare: 10, chain: 70 } }));
    act(() => store.dispatch({ type: 'RECORD_OP', opType: 'publish', success: true, durationMs: 30, phases: { prepare: 5, manualOnly: 3 } }));
    act(() => store.dispatch({ type: 'RECORD_OP', opType: 'query', success: true, durationMs: 20 }));
    expect(store.state.simulationRuns[1].metrics.total).toBe(1);
    const previous = store.state.simulationRuns[1];
    const saved = structuredClone(previous);
    const snapshot = { type: 'status' as const, total: 4, completed: 3, errors: 1, elapsedMs: 1_000, opsPerSec: 3,
      byOp: { publish: { ok: 2, fail: 1, timeouts: 0, totalMs: 200, allMs: 250,
        phaseTotals: { prepare: 30, chain: 140, commit: 40 }, phaseCounts: { prepare: 3, chain: 2, commit: 1 } } } };
    act(() => store.dispatch({ type: 'RECONCILE_SIMULATION', id: 'recovering', snapshot }));
    expect(previous).toEqual(saved);
    expect(store.state.simulationRuns[0]).toEqual(older);
    expect(store.state.simulationRuns[1].metrics).toMatchObject({ total: 3, success: 2, errors: 1,
      byType: { publish: { totalDurationMs: 250, successDurationMs: 200,
        phaseTotals: { prepare: 30, chain: 140, commit: 40 }, phaseCounts: { prepare: 3, chain: 2, commit: 1 } } } });
    expect(store.state.liveMetrics).toMatchObject({ total: 5, success: 4, errors: 1,
      byType: { publish: { total: 4, totalDurationMs: 280, successDurationMs: 230,
        phaseTotals: { prepare: 35, chain: 140, commit: 40, manualOnly: 3 }, phaseCounts: { prepare: 4, chain: 2, commit: 1, manualOnly: 1 } },
      query: { total: 1, success: 1, totalDurationMs: 20 } } });
    const recovered = structuredClone(store.state.liveMetrics);
    act(() => store.dispatch({ type: 'RECONCILE_SIMULATION', id: 'recovering', snapshot }));
    act(() => store.dispatch({ type: 'RECONCILE_SIMULATION', id: 'older', snapshot }));
    expect(store.state.liveMetrics).toEqual(recovered);
    // Resetting the live view clears manual work, while retaining the active run
    // contribution required for the next authoritative replacement.
    act(() => store.dispatch({ type: 'RESET_LIVE_METRICS' }));
    act(() => store.dispatch({ type: 'RECONCILE_SIMULATION', id: 'recovering', snapshot }));
    expect(store.state.liveMetrics).toEqual(store.state.simulationRuns[1].metrics);
    act(() => store.dispatch({ type: 'COMPLETE_SIMULATION', id: 'recovering', snapshot: { ...snapshot, type: 'done' } }));
    expect(store.state.activeSimulationId).toBeNull();
    expect(store.state.simulationRuns[1].finishedAt).toBe(previous.startedAt + snapshot.elapsedMs);
    const finishedAt = store.state.simulationRuns[1].finishedAt;
    vi.setSystemTime(Date.now() + 5_000);
    act(() => store.dispatch({ type: 'COMPLETE_SIMULATION', id: 'recovering' }));
    expect(store.state.simulationRuns[1].finishedAt).toBe(finishedAt);
  });

  it('keeps success/error durations and phase counts distinct without mutating earlier snapshots', async () => {
    await mount();
    act(() => store.dispatch({ type: 'START_SIMULATION', id: 'one', name: 'First', config: runConfig }));
    act(() => store.dispatch({ type: 'RECORD_OP', simulationId: 'one', opType: 'publish', success: true, durationMs: 100, phases: { prepare: 10, chain: 70 } }));
    const snapshot = structuredClone(store.state.liveMetrics);
    const previous = store.state.liveMetrics;
    vi.setSystemTime(Date.now() + 10000);
    act(() => store.dispatch({ type: 'RECORD_OP', simulationId: 'one', opType: 'publish', success: false, durationMs: 40, phases: { prepare: 15 } }));
    expect(previous).toEqual(snapshot);
    expect(store.state.liveMetrics).toMatchObject({ total: 2, success: 1, errors: 1,
      byType: { publish: { total: 2, success: 1, errors: 1, totalDurationMs: 140, successDurationMs: 100,
        phaseTotals: { prepare: 25, chain: 70 }, phaseCounts: { prepare: 2, chain: 1 } } }, recentTimestamps: [Date.now()] });
    expect(store.state.simulationRuns[0].metrics).toEqual(store.state.liveMetrics);
    act(() => store.dispatch({ type: 'COMPLETE_SIMULATION', id: 'one' }));
    const finished = structuredClone(store.state.simulationRuns[0]);
    expect(finished.finishedAt).toBe(Date.now());
    act(() => store.dispatch({ type: 'RECORD_OP', opType: 'query', success: true, durationMs: 12 }));
    expect(store.state.simulationRuns[0]).toEqual(finished);
    act(() => store.dispatch({ type: 'RESET_LIVE_METRICS' }));
    expect(store.state.liveMetrics).toEqual({ total: 0, success: 0, errors: 0, byType: {}, recentTimestamps: [] });
    act(() => store.dispatch({ type: 'RECORD_OP', opType: 'publish', success: false, durationMs: 20 }));
    act(() => store.dispatch({ type: 'START_SIMULATION', id: 'two', name: 'Second', config: runConfig }));
    act(() => store.dispatch({ type: 'RECORD_OP', simulationId: 'two', opType: 'query', success: true, durationMs: 7 }));
    expect(store.state.simulationRuns[0]).toEqual(finished);
    expect(store.state.simulationRuns[1].metrics).toEqual(store.state.liveMetrics);
    expect(store.state.liveMetrics.total).toBe(1);
  });
});

it('keeps diagnostics outside canonical operation metrics and reconciles their separate count', async () => {
  await mount();
  act(() => store.dispatch({ type: 'START_SIMULATION', id: 'current-errors', name: 'Current', config: runConfig }));
  act(() => store.dispatch({ type: 'SIMULATION_ERROR', id: 'old-run', message: 'late error' }));
  expect(store.state.liveMetrics.errors).toBe(0);
  act(() => store.dispatch({ type: 'SIMULATION_ERROR', id: 'current-errors', message: 'setup failed' }));
  expect(store.state.liveMetrics).toMatchObject({ total: 0, success: 0, errors: 0, byType: {} });
  expect(store.state.simulationRuns[0].diagnosticCount).toBe(1);
  expect(store.state.simulationRuns[0].error).toBe('setup failed');
  act(() => store.dispatch({ type: 'RECONCILE_SIMULATION', id: 'current-errors', snapshot: {
    type: 'status', total: 10, completed: 0, errors: 0, elapsedMs: 10, opsPerSec: 0, byOp: {},
  } }));
  expect(store.state.liveMetrics.errors).toBe(0);
  expect(store.state.simulationRuns[0].error).toBeUndefined();
  expect(store.state.simulationRuns[0].diagnosticCount).toBe(0);
  act(() => store.dispatch({ type: 'COMPLETE_SIMULATION', id: 'current-errors' }));
  const finished = store.state.simulationRuns[0];
  act(() => store.dispatch({ type: 'SIMULATION_ERROR', id: 'current-errors', message: 'late failure' }));
  expect(store.state.simulationRuns[0]).toEqual(finished);
});


it('ignores completion from an older run and reuses metric projections across animation ticks', async () => {
  await mount();
  act(() => store.dispatch({ type: 'START_SIMULATION', id: 'old', name: 'Old', config: runConfig }));
  act(() => store.dispatch({ type: 'START_SIMULATION', id: 'new', name: 'New', config: runConfig }));
  act(() => store.dispatch({ type: 'COMPLETE_SIMULATION', id: 'old' }));
  expect(store.state.activeSimulationId).toBe('new');
  const metrics = store.state.liveMetrics;
  act(() => store.dispatch({ type: 'TICK_ANIMATIONS', dt: 0.016 }));
  expect(store.state.liveMetrics).toBe(metrics);
  act(() => store.dispatch({ type: 'COMPLETE_SIMULATION', id: 'new' }));
  expect(store.state.activeSimulationId).toBeNull();
  expect(store.state.simulationRuns[1].finishedAt).toBe(Date.now());
  act(() => store.dispatch({ type: 'TICK_ANIMATIONS', dt: 0.016 }));
  expect(store.state.liveMetrics).toBe(metrics);
});
