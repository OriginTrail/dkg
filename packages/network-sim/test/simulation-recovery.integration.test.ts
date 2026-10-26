// @vitest-environment happy-dom
import React, { act } from 'react';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPanel } from '../src/components/ControlPanel';
import * as api from '../src/api';
import { makeStore, mountUi, type MountedUi } from './ui-test-support';
vi.mock('../src/api');
vi.mock('../src/store', () => ({ useStore: () => store }));
vi.mock('node:fs/promises', () => {
  const readFile = vi.fn().mockRejectedValue(new Error('no devnet token'));
  return { readFile, default: { readFile } };
});

let store = makeStore();
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
  store = makeStore(); LocalEventSource.instances = []; clientRequests = [];
  accepted = deferred(); arrivalGate = responseGate = undefined;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('EventSource', LocalEventSource);
  vi.mocked(api.fetchContextGraphs).mockResolvedValue({ contextGraphs: [] });
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
  ui = await mountUi(React.createElement(ControlPanel)); await ui.click('Simulate');
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
    const recorded = vi.mocked(store.addOperation).mock.calls.length;
    await act(async () => stream.reconnect());
    expect(ui.container.textContent).toContain('Simulation complete: 2 succeeded, 0 failed');
    expect(ui.button('Play Simulation').disabled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(store.addOperation).toHaveBeenCalledTimes(recorded);
    expect((await status('other-client')).running).toBe(true);
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
