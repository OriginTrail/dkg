// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { useVisibilityPolling } from '../src/ui/hooks/useVisibilityPolling.js';

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

interface HostProps {
  cb: () => void;
  intervalMs: number;
  runImmediately?: boolean;
}

function PollHost({ cb, intervalMs, runImmediately }: HostProps) {
  useVisibilityPolling(cb, intervalMs, { runImmediately });
  return null;
}

function mount(props: HostProps): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(PollHost, props));
  });
  mountedRoots.push(root);
  mountedContainers.push(container);
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useVisibilityPolling (BUG-007)', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    // Default to a visible tab; individual tests override.
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
    vi.useRealTimers();
  });

  it('runs immediately on mount + on each interval while visible', () => {
    const cb = vi.fn();
    mount({ cb, intervalMs: 1000 });

    expect(cb).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(cb).toHaveBeenCalledTimes(2);

    act(() => { vi.advanceTimersByTime(3000); });
    expect(cb).toHaveBeenCalledTimes(5);
  });

  it('honours runImmediately: false (no initial fire on mount)', () => {
    const cb = vi.fn();
    mount({ cb, intervalMs: 1000, runImmediately: false });
    expect(cb).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('pauses the timer when the tab becomes hidden', () => {
    const cb = vi.fn();
    mount({ cb, intervalMs: 1000 });
    expect(cb).toHaveBeenCalledTimes(1);

    // Hide the tab — visibilitychange handler should stop the interval
    act(() => { setHidden(true); });

    // 10s of fake time elapses while hidden — must not fire
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('refreshes immediately on resume + resumes interval cadence', () => {
    const cb = vi.fn();
    mount({ cb, intervalMs: 1000 });
    cb.mockClear();

    act(() => { setHidden(true); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(cb).not.toHaveBeenCalled();

    // Tab becomes visible — immediate refresh + interval restart
    act(() => { setHidden(false); });
    expect(cb).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(1000); });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('intervalMs <= 0 disables polling entirely (still safe to mount/unmount)', () => {
    const cb = vi.fn();
    mount({ cb, intervalMs: 0 });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(cb).not.toHaveBeenCalled();
  });

  it('cleans up the visibilitychange listener and timer on unmount (no leaked fires)', () => {
    const cb = vi.fn();
    mount({ cb, intervalMs: 1000 });
    cb.mockClear();

    // Unmount
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }

    // Both visibility and timer paths must be inert post-unmount.
    act(() => { vi.advanceTimersByTime(5000); });
    act(() => { setHidden(true); setHidden(false); });
    expect(cb).not.toHaveBeenCalled();
  });

  it('does not start the timer if mounted while the tab is already hidden (mount-on-hidden regression)', () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const cb = vi.fn();
    mount({ cb, intervalMs: 1000, runImmediately: false });

    // No initial fire (runImmediately: false), and timer must NOT
    // have started because document.hidden was true at mount.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(cb).not.toHaveBeenCalled();
  });

  it('suppresses the eager mount fire when the tab is already hidden (codex #752 — was firing once)', () => {
    // Pre-fix: with the default `runImmediately: true`, the hook
    // fired the callback once on mount regardless of `document.hidden`.
    // In the "browser session restore / background tab" case every
    // consumer still hit the daemon once on mount, leaving a chunk of
    // the BUG-007 fan-out in place. Now the eager call must also
    // pause until the tab becomes visible.
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    const cb = vi.fn();
    mount({ cb, intervalMs: 1000 });
    expect(cb).not.toHaveBeenCalled();

    // While hidden, the interval is also paused (existing behaviour).
    act(() => { vi.advanceTimersByTime(5000); });
    expect(cb).not.toHaveBeenCalled();

    // On becoming visible the visibilitychange handler runs an
    // immediate refresh AND resumes the cadence — both expected.
    act(() => { setHidden(false); });
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
