// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadStore(narrow: boolean) {
  vi.resetModules();
  vi.stubGlobal('matchMedia', () => ({ matches: narrow, addEventListener: () => {}, removeEventListener: () => {} }));
  return (await import('../src/ui/stores/layout.js')).useLayoutStore;
}

describe('side panels on a narrow screen', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('opens one panel at a time and leaves the saved desktop state alone', async () => {
    const store = await loadStore(true);
    expect(store.getState().narrowPanel).toBeNull();
    store.getState().toggleLeft();
    expect(store.getState().narrowPanel).toBe('left');
    store.getState().toggleRight();
    expect(store.getState().narrowPanel).toBe('right');
    store.getState().closeNarrowPanel();
    expect(store.getState().narrowPanel).toBeNull();
    expect(store.getState().leftCollapsed).toBe(false);
    expect(store.getState().rightCollapsed).toBe(false);
  });

  it('marks the panel held while one of its dialogs is open', async () => {
    const store = await loadStore(true);
    expect(store.getState().narrowPanelHeld).toBe(false);
    store.getState().holdNarrowPanel(true);
    expect(store.getState().narrowPanelHeld).toBe(true);
    store.getState().holdNarrowPanel(false);
    expect(store.getState().narrowPanelHeld).toBe(false);
  });

  it('keeps the normal toggle on a wide screen', async () => {
    const store = await loadStore(false);
    store.getState().toggleLeft();
    expect(store.getState().leftCollapsed).toBe(true);
    expect(store.getState().narrowPanel).toBeNull();
  });
});
