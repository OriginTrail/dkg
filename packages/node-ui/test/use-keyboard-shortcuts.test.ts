// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

// Mock the layout store BEFORE importing the hook so the hook resolves
// our spy implementation. We use real Zustand-style return shape so
// `useLayoutStore()` (no selector) destructures cleanly.
const toggleLeft = vi.fn();
const toggleRight = vi.fn();
const toggleBottom = vi.fn();

vi.mock('../src/ui/stores/layout.js', () => ({
  useLayoutStore: () => ({ toggleLeft, toggleRight, toggleBottom }),
  // Some App.tsx imports also pull `maxBottomHeight` from this module —
  // export a stub so any consumer (we only mount the hook here, but the
  // module surface is stable for downstream consumers) doesn't crash.
  maxBottomHeight: () => 600,
}));

// eslint-disable-next-line import/first -- mock has to be declared before the import
import { useKeyboardShortcuts } from '../src/ui/hooks/useKeyboardShortcuts.js';

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function HookHost() {
  useKeyboardShortcuts();
  return null;
}

function mount(): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(HookHost));
  });
  mountedRoots.push(root);
  mountedContainers.push(container);
}

function fireKeydown(init: KeyboardEventInit & { target?: EventTarget }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  // happy-dom honours `bubbles: true` on dispatchEvent against window for
  // KeyboardEvent. The hook attaches `keydown` directly on `window`.
  if (init.target) {
    init.target.dispatchEvent(event);
  } else {
    window.dispatchEvent(event);
  }
  return event;
}

describe('useKeyboardShortcuts (BUG-005)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it('Cmd+B (lowercase, no modifier) toggles the left sidebar exactly once', () => {
    mount();
    const ev = fireKeydown({ key: 'b', metaKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(toggleLeft).toHaveBeenCalledTimes(1);
    expect(toggleRight).not.toHaveBeenCalled();
    expect(toggleBottom).not.toHaveBeenCalled();
  });

  it('Ctrl+B (Windows/Linux) toggles the same way as Cmd+B', () => {
    mount();
    fireKeydown({ key: 'b', ctrlKey: true });
    expect(toggleLeft).toHaveBeenCalledTimes(1);
  });

  it('Cmd+Shift+B reports `e.key` as uppercase `B` in Chrome — must still toggle the right panel (BUG-005 reproducer)', () => {
    mount();
    fireKeydown({ key: 'B', metaKey: true, shiftKey: true });
    expect(toggleRight).toHaveBeenCalledTimes(1);
    // CRITICAL: must NOT also fire the non-shift left-toggle path.
    // Original buggy implementation tested `key === "b"` for both
    // branches, so the shift branch never matched (case mismatch) and
    // the user was left wondering why the right panel never toggled.
    expect(toggleLeft).not.toHaveBeenCalled();
  });

  it('Cmd+B with Caps Lock active (key reported as `B`) still toggles the LEFT sidebar (case-insensitive dispatch)', () => {
    mount();
    fireKeydown({ key: 'B', metaKey: true });
    expect(toggleLeft).toHaveBeenCalledTimes(1);
    expect(toggleRight).not.toHaveBeenCalled();
  });

  it('Cmd+J toggles the bottom panel; Cmd+Shift+J does NOT', () => {
    mount();
    fireKeydown({ key: 'j', metaKey: true });
    expect(toggleBottom).toHaveBeenCalledTimes(1);

    fireKeydown({ key: 'j', metaKey: true, shiftKey: true });
    // After the shift-modified dispatch the early-return on
    // `e.shiftKey` should have prevented the J branch from firing
    // again. So the count stays at 1.
    expect(toggleBottom).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire any toggle when typing into a text input (form-field guard)', () => {
    mount();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    fireKeydown({ key: 'b', metaKey: true, target: input });
    fireKeydown({ key: 'j', metaKey: true, target: input });
    fireKeydown({ key: 'B', metaKey: true, shiftKey: true, target: input });
    expect(toggleLeft).not.toHaveBeenCalled();
    expect(toggleRight).not.toHaveBeenCalled();
    expect(toggleBottom).not.toHaveBeenCalled();
    input.remove();
  });

  it('does NOT fire any toggle when typing into a textarea (form-field guard #2)', () => {
    mount();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    fireKeydown({ key: 'b', metaKey: true, target: ta });
    expect(toggleLeft).not.toHaveBeenCalled();
    ta.remove();
  });

  it('does NOT fire on a bare `B` keypress without Cmd/Ctrl (modifier required)', () => {
    mount();
    fireKeydown({ key: 'b' });
    fireKeydown({ key: 'B' });
    expect(toggleLeft).not.toHaveBeenCalled();
  });

  it('ignores unrelated modifier keys (Alt alone is not a shortcut)', () => {
    mount();
    fireKeydown({ key: 'b', altKey: true });
    expect(toggleLeft).not.toHaveBeenCalled();
  });

  it('removes the keydown listener on unmount (no leaked toggles after teardown)', () => {
    mount();
    fireKeydown({ key: 'b', metaKey: true });
    expect(toggleLeft).toHaveBeenCalledTimes(1);
    // Teardown the host
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
    fireKeydown({ key: 'b', metaKey: true });
    expect(toggleLeft).toHaveBeenCalledTimes(1);
  });
});
