// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ fetch: vi.fn(), poll: null as null | (() => void),
  event: null as null | ((event: { type: string }) => void) }));
vi.mock('../src/ui/api-wrapper.js', () => ({ api: { fetchNotificationsFeed: controls.fetch } }));
vi.mock('../src/ui/hooks/useVisibilityPolling.js', async () => {
  const { useEffect } = await import('react');
  return { useVisibilityPolling: (callback: () => void) => useEffect(() => {
    controls.poll = callback; callback(); return () => { controls.poll = null; };
  }, [callback]) };
});
vi.mock('../src/ui/hooks/useNodeEvents.js', async () => {
  const { useEffect } = await import('react');
  return { useNodeEvents: (callback: (event: { type: string }) => void) => useEffect(() => {
    controls.event = callback; return () => { controls.event = null; };
  }, [callback]) };
});
import { useNotificationsFeed } from '../src/ui/hooks/useNotificationsFeed.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null, container: HTMLDivElement;
let active: number, peak: number;
let pending: Array<{ resolve: (value: any) => void; reject: (error: Error) => void }>;
const response = { notifications: [], badgeCount: 7 };
function Probe() {
  const feed = useNotificationsFeed();
  return React.createElement('div', null, `${feed.status}:${feed.unread}:${feed.refreshError}`);
}
beforeEach(() => {
  vi.useFakeTimers(); active = 0; peak = 0; pending = [];
  controls.fetch.mockReset().mockImplementation(() => {
    active++; peak = Math.max(peak, active);
    return new Promise((resolve, reject) => pending.push({ resolve, reject })).finally(() => active--);
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root!.render(React.createElement(Probe)));
});
afterEach(() => {
  if (root) act(() => root!.unmount()); root = null;
  container.remove(); vi.useRealTimers();
});
async function settle(value = response, error?: Error) {
  await act(async () => { const next = pending.shift()!; if (error) next.reject(error); else next.resolve(value); });
}

it('coalesces polls and notification bursts into one follow-up without overlapping requests', async () => {
  expect(controls.fetch).toHaveBeenCalledTimes(1);
  act(() => {
    for (let i = 0; i < 100; i++) { controls.poll!(); controls.event!({ type: 'notification' }); }
    vi.advanceTimersByTime(400);
  });
  expect(controls.fetch).toHaveBeenCalledTimes(1); expect(peak).toBe(1);
  await settle(); expect(controls.fetch).toHaveBeenCalledTimes(2); expect(peak).toBe(1);
  await settle(); expect(controls.fetch).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe('ready:7:false'); expect(active).toBe(0);
});

it('preserves cached data after a failed refresh and permits a later retry', async () => {
  await settle(); act(() => controls.poll!()); await settle(response, new Error('unavailable'));
  expect(container.textContent).toBe('ready:7:true');
  act(() => controls.poll!()); await settle();
  expect(container.textContent).toBe('ready:7:false'); expect(peak).toBe(1);
});

it('does not start a queued refresh after unmount', async () => {
  act(() => controls.poll!()); act(() => root!.unmount()); root = null;
  await settle(); expect(controls.fetch).toHaveBeenCalledTimes(1); expect(active).toBe(0);
});
