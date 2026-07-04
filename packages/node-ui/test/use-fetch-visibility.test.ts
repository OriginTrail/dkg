// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { useFetch } from '../src/ui/hooks.js';

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

interface HostProps {
  fetcher: () => Promise<number>;
  intervalMs: number;
}

function FetchHost({ fetcher, intervalMs }: HostProps) {
  const result = useFetch(fetcher, [], intervalMs);
  return React.createElement('span', {
    'data-error': result.error ?? '',
    'data-loading': String(result.loading),
  });
}

function mount(props: HostProps): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(React.createElement(FetchHost, props)); });
  mountedRoots.push(root);
  mountedContainers.push(container);
  return container;
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('useFetch visibility-pause (BUG-007 path B)', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    sessionStorage.clear();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fetches once on mount + on each interval while visible', async () => {
    const fetcher = vi.fn().mockResolvedValue(42);
    mount({ fetcher, intervalMs: 1000 });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => { vi.advanceTimersByTime(2000); });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('pauses the polling interval when the tab becomes hidden', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher, intervalMs: 1000 });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => { setHidden(true); });

    // 10s of fake time elapses while hidden — must not fire any
    // additional fetches.
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('resumes with one immediate refresh + interval cadence on visibility=true', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher, intervalMs: 1000 });
    await flush();
    fetcher.mockClear();

    act(() => { setHidden(true); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(fetcher).not.toHaveBeenCalled();

    // Resume: hook fires `load()` once + restarts the interval.
    act(() => { setHidden(false); });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('cleans up the visibilitychange listener on unmount (no leaked fetches after teardown)', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher, intervalMs: 1000 });
    await flush();
    fetcher.mockClear();

    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }

    // Both visibility transitions and timer ticks must be inert.
    act(() => { setHidden(true); setHidden(false); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('intervalMs=0: initial load fires + resume-on-visible refreshes once (no interval started)', async () => {
    const fetcher = vi.fn().mockResolvedValue(1);
    mount({ fetcher, intervalMs: 0 });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1); // initial load

    act(() => { setHidden(true); });
    act(() => { setHidden(false); });
    await flush();
    // The hook calls load() once on resume even without a polling
    // interval — that's defensible (long-hidden tabs benefit from a
    // fresh snapshot on return). Pin the contract: exactly one
    // additional fetch fires.
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Crucially, no INTERVAL was started — advance the clock and
    // confirm no extra ticks fire.
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reloads once and marks the session when the initial request returns 401', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const fetcher = vi.fn().mockRejectedValue({ status: 401 });

    const container = mount({ fetcher, intervalMs: 0 });
    await flush();

    expect(sessionStorage.getItem('__dkg_401_reloaded')).toBe('1');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(container.querySelector('span')?.getAttribute('data-error')).toBe('');
  });

  it('does not reload repeatedly after a 401 reload has already been attempted', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    sessionStorage.setItem('__dkg_401_reloaded', '1');
    const fetcher = vi.fn().mockRejectedValue({ status: 401 });

    const container = mount({ fetcher, intervalMs: 0 });
    await flush();

    expect(reload).not.toHaveBeenCalled();
    expect(container.querySelector('span')?.getAttribute('data-error'))
      .toBe('Authentication expired — please refresh the page.');
  });
});
