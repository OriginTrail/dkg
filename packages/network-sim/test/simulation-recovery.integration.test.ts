// @vitest-environment happy-dom
import React, { act } from 'react';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPanel } from '../src/components/ControlPanel';
import * as api from '../src/api';
import { mountUi, type MountedUi } from './ui-test-support';
vi.mock('../src/api');
import { StoreProvider, useStore } from '../src/store';
vi.mock('node:fs/promises', () => {
  const readFile = vi.fn().mockRejectedValue(new Error('no devnet token'));
  return { readFile, default: { readFile } };
});

let store: ReturnType<typeof useStore>;
function StoreProbe() { store = useStore(); return null; }
let ui: MountedUi;
let engine: typeof import('../src/server/sim-engine');
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
};
let accepted: ReturnType<typeof deferred>;
let arrivalGate: ReturnType<typeof deferred> | undefined;
let responseGate: ReturnType<typeof deferred> | undefined;
let clientRequests: Promise<Response>[];

async function http(url: string, init?: RequestInit) {
  const request = Object.assign(Readable.from(init?.body ? [Buffer.from(String(init.body))] : []), { url, method: init?.method ?? 'GET' }) as IncomingMessage;
  let code = 0, body = '';
  const response = { writeHead(status: number) { code = status; }, end(data: string) { body = data; } };
  await engine.handleSimRequest(request, response as unknown as ServerResponse);
  return new Response(body, { status: code });
}

/** Browser/HTTP transport only: events and snapshots come from the real request handler. */
class LocalEventSource {
  static instances: LocalEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private request: IncomingMessage | null = null;
  private closed = false;
  constructor(readonly url: string) {
    LocalEventSource.instances.push(this);
    queueMicrotask(() => { void this.reconnect(); });
  }
  async reconnect() {
    if (this.closed) return;
    const request = Object.assign(new EventEmitter(), { url: this.url, method: 'GET' }) as IncomingMessage;
    this.request = request;
    this.onopen?.();
    await engine.handleSimRequest(request, {
      writeHead() {}, end() {},
      write: (chunk: string) => { if (chunk.startsWith('data: ')) this.onmessage?.({ data: chunk.slice(6) }); return true; },
    } as unknown as ServerResponse);
  }
  disconnect() { this.request?.emit('close'); this.request = null; this.onerror?.(); }
  close() { this.closed = true; this.request?.emit('close'); this.request = null; }
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01'));
  LocalEventSource.instances = []; clientRequests = [];
  accepted = deferred(); arrivalGate = responseGate = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('EventSource', LocalEventSource);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(api.fetchContextGraphs).mockResolvedValue({ contextGraphs: [] });
  vi.mocked(api.fetchDevnetConfig).mockResolvedValue({ nodes: [{ id: 1, name: 'Node 1', apiPort: 9201, listenPort: 10001, nodeRole: 'core' }], contracts: {}, hubAddress: '', chainRpc: '' });
  vi.mocked(api.fetchNodeStatus).mockResolvedValue({ name: 'Node 1', peerId: 'peer-1', nodeRole: 'core', uptimeMs: 0, connectedPeers: 0, connections: 0, relayConnected: false, multiaddrs: [] });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  engine = await import('../src/server/sim-engine');
  transport = vi.fn<typeof fetch>((input, init) => {
    const url = String(input);
    if (!url.startsWith('/sim/')) {
      if (url.endsWith('/api/context-graph/exists')) return Promise.resolve(Response.json({ exists: true }));
      return Promise.resolve(Response.json({ result: { bindings: [] } }));
    }
    const pending = (async () => {
      if (url.startsWith('/sim/start')) await arrivalGate?.promise;
      const result = await http(url, init);
      if (url.startsWith('/sim/start')) { accepted.resolve(); await responseGate?.promise; }
      return result;
    })();
    clientRequests.push(pending);
    return pending;
  });
  vi.stubGlobal('fetch', transport);
  ui = await mountUi(React.createElement(StoreProvider, null, React.createElement(StoreProbe), React.createElement(ControlPanel))); await ui.click('Simulate');
  await ui.fill('Total Ops', '2'); await ui.fill('Ops/sec', '1');
  // Keep only Query enabled through the real form controls.
  const operations = ui.container.querySelector('.graph-target-pills')!;
  await ui.click('Publish', operations); await ui.click('Shared Memory', operations); await ui.click('Chat', operations);
});
afterEach(async () => {
  ui?.unmount(); arrivalGate?.resolve(); responseGate?.resolve();
  await Promise.allSettled(clientRequests);
  if (engine) await http('/sim/stop', { method: 'POST' });
  await vi.advanceTimersByTimeAsync(1000);
  LocalEventSource.instances.forEach(stream => stream.close());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

const runId = () => new URL(String(transport.mock.calls.find(([url]) => String(url).startsWith('/sim/start'))![0]), 'http://localhost').searchParams.get('runId')!;
const status = async (id: string) => (await http(`/sim/status?runId=${id}`)).json();

describe('simulation UI with real server recovery', () => {
  it('recovers A after offline completion while B is running without recording B in A', async () => {
    await ui.click('Play Simulation'); await accepted.promise;
    await act(async () => vi.advanceTimersByTimeAsync(501));
    const first = runId(), stream = LocalEventSource.instances[0];
    expect((await status(first)).completed).toBe(1);
    act(() => stream.disconnect());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect((await status(first)).running).toBe(false);
    const second = await http('/sim/start?runId=other-client', { method: 'POST', body: JSON.stringify({ opCount: 10, opsPerSec: 1, enabledOps: ['query'] }) });
    expect(second.status).toBe(200);
    await act(async () => vi.advanceTimersByTimeAsync(501));
    const recorded = store.state.activities.length;
    await act(async () => stream.reconnect());
    expect(ui.container.textContent).toContain('Simulation complete: 2 succeeded, 0 failed');
    expect(ui.button('Play Simulation').disabled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(store.state.activities).toHaveLength(recorded);
    expect(store.state.simulationRuns[0].metrics).toMatchObject({ total: 2, success: 2, errors: 0, byType: { query: { total: 2, success: 2 } } });
    expect(store.state.liveMetrics).toEqual(store.state.simulationRuns[0].metrics);
    expect(store.state.activeSimulationId).toBeNull();
    expect((await status('other-client')).running).toBe(true);
  });

  it('retains progress and cancellation when switching control tabs', async () => {
    await ui.click('Play Simulation'); await accepted.promise;
    await act(async () => vi.advanceTimersByTimeAsync(501));
    const id = runId();
    await ui.click('Query', ui.container.querySelector('.tab-bar')!);
    expect(store.state.activeSimulationId).toBe(id);
    expect(LocalEventSource.instances).toHaveLength(1);
    await ui.click('Simulate');
    expect(ui.field('Total Ops').value).toBe('2');
    expect(ui.container.textContent).toContain('1/2');
    await ui.click('Stop Simulation');
    expect((await status(id)).running).toBe(false);
    expect(store.state.activeSimulationId).toBeNull();
    expect(store.state.simulationRuns[0].metrics.total).toBe(1);
  });

  it('records completion while another control tab is visible', async () => {
    await ui.click('Play Simulation'); await accepted.promise;
    await ui.click('Query', ui.container.querySelector('.tab-bar')!);
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(store.state.activeSimulationId).toBeNull();
    expect(store.state.simulationRuns[0].finishedAt).toBeDefined();
    expect(store.state.simulationRuns[0].metrics).toMatchObject({ total: 2, success: 2, errors: 0 });
    await ui.click('Simulate');
    expect(ui.container.textContent).toContain('Simulation complete: 2 succeeded, 0 failed');
  });

  it('reconciles missed failures while running and avoids counting a replayed snapshot twice', async () => {
    await ui.fill('Total Ops', '4');
    await ui.click('Play Simulation'); await accepted.promise;
    await act(async () => vi.advanceTimersByTimeAsync(501));
    const stream = LocalEventSource.instances[0];
    act(() => stream.disconnect());
    const original = transport.getMockImplementation()!;
    transport.mockImplementation((input, init) => String(input).endsWith('/api/query')
      ? Promise.resolve(Response.json({ error: 'fixture query failure' }, { status: 500 })) : original(input, init));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => stream.reconnect());
    expect(store.state.simulationRuns[0].metrics).toMatchObject({ total: 2, success: 1, errors: 1 });
    // A second reconnect must replace the same totals, never append them.
    act(() => stream.disconnect());
    await act(async () => stream.reconnect());
    expect(store.state.liveMetrics.total).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(store.state.liveMetrics).toMatchObject({ total: 4, success: 1, errors: 3,
      byType: { query: { total: 4, success: 1, errors: 3 } } });
    expect(store.state.simulationRuns[0].metrics).toEqual(store.state.liveMetrics);
    expect(ui.container.textContent).toContain('Simulation complete: 1 succeeded, 3 failed');
  });

  it('cancels server work while the accepted start response is still withheld', async () => {
    responseGate = deferred();
    await ui.click('Play Simulation'); await accepted.promise;
    await act(async () => vi.advanceTimersByTimeAsync(501));
    const id = runId();
    expect((await status(id)).running).toBe(true);
    expect(LocalEventSource.instances).toHaveLength(0);
    await ui.click('Stop Simulation'); await act(async () => Promise.all(clientRequests.slice(1)));
    expect((await status(id)).running).toBe(false);
    expect(ui.container.textContent).toContain('Simulation complete: 1 succeeded, 0 failed');
    await act(async () => { responseGate!.resolve(); await clientRequests[0]; });
    expect(LocalEventSource.instances).toHaveLength(0);
    expect(ui.button('Play Simulation').disabled).toBe(false);
  });

  it('cancels a start that reaches the server after the stop request', async () => {
    arrivalGate = deferred();
    await ui.click('Play Simulation');
    const id = runId();
    await ui.click('Stop Simulation'); await act(async () => Promise.all(clientRequests.slice(1)));
    expect(ui.button('Play Simulation').disabled).toBe(false);
    await act(async () => { arrivalGate!.resolve(); await clientRequests[0]; });
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect((await http(`/sim/status?runId=${id}`)).status).toBe(404);
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/api/query'))).toHaveLength(0);
    expect(LocalEventSource.instances).toHaveLength(0);
  });
});
