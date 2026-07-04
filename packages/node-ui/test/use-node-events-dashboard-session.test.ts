// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  fail() {
    this.onerror?.(new Event('error'));
  }

  close() {
    this.closed = true;
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useNodeEvents dashboard sessions', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = undefined;
    }
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('refreshes an expired dashboard session before reopening the SSE stream', async () => {
    const initialNow = Date.now();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/dashboard/session/status') {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/dashboard/session/loopback') {
        return new Response(JSON.stringify({
          authenticated: true,
          source: 'loopback',
          csrfToken: 'csrf-refreshed',
          expiresAt: Date.now() + 60_000,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [{ setDashboardSessionForTesting }, { getDashboardSession }, { useNodeEvents }] = await Promise.all([
      import('../src/ui/dashboardSessionTestSupport.js'),
      import('../src/ui/dashboardSessionClient.js'),
      import('../src/ui/hooks/useNodeEvents.js'),
    ]);

    setDashboardSessionForTesting({
      state: 'authenticated',
      authenticated: true,
      source: 'loopback',
      csrfToken: 'csrf-old',
      expiresAt: initialNow + 60_000,
    });

    function Probe() {
      useNodeEvents(() => {});
      return React.createElement('div');
    }

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(Probe));
    });
    await flush();

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/api/events');
    expect(fetchMock).not.toHaveBeenCalled();

    vi.setSystemTime(initialNow + 60_001);
    await act(async () => {
      MockEventSource.instances[0].fail();
      vi.advanceTimersByTime(0);
    });
    await flush();

    expect(fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${input}`)).toEqual([
      'GET /api/dashboard/session/status',
      'POST /api/dashboard/session/loopback',
    ]);
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe('/api/events');
    expect(getDashboardSession()).toMatchObject({
      state: 'authenticated',
      csrfToken: 'csrf-refreshed',
    });
  });

  it('does not enter a zero-delay reconnect loop when status returns a near-expired session', async () => {
    const initialNow = Date.now();
    const expiresAt = initialNow + 10_000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/dashboard/session/status') {
        return new Response(JSON.stringify({
          authenticated: true,
          source: 'loopback',
          csrfToken: 'csrf-still-current',
          expiresAt,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const [{ setDashboardSessionForTesting }, { useNodeEvents }] = await Promise.all([
      import('../src/ui/dashboardSessionTestSupport.js'),
      import('../src/ui/hooks/useNodeEvents.js'),
    ]);

    setDashboardSessionForTesting({
      state: 'authenticated',
      authenticated: true,
      source: 'loopback',
      csrfToken: 'csrf-old',
      expiresAt,
    });

    function Probe() {
      useNodeEvents(() => {});
      return React.createElement('div');
    }

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(Probe));
    });
    await flush();
    expect(MockEventSource.instances).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(MockEventSource.instances[1].closed).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(4_998);
    });
    await flush();
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].closed).toBe(false);
  });
});
