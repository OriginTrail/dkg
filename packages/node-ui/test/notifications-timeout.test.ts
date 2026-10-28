// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/ui/api-wrapper.js', async () => {
  const { fetchNotificationsFeed } = await import('../src/ui/api.js'); return { api: { fetchNotificationsFeed } };
});
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useNodeEvents: () => {} }));
import { useNotificationsFeed } from '../src/ui/hooks/useNotificationsFeed.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('recovers the serialized notification feed after a request never responds', async () => {
  vi.useFakeTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
  const fetch = vi.fn().mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })).mockResolvedValue(new Response('{"notifications":[],"badgeCount":3}'));
  vi.stubGlobal('fetch', fetch);
  let feed: ReturnType<typeof useNotificationsFeed>;
  function Probe() { feed = useNotificationsFeed(); return null; }
  const container = document.createElement('div'); const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    if (feed!.status !== 'ready') await act(async () => feed!.retry());
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(feed!.status).toBe('ready'); expect(feed!.unread).toBe(3);
  } finally { act(() => root.unmount()); }
});
