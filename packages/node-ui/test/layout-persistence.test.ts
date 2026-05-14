// @vitest-environment happy-dom
//
// Covers PR1 layout persistence: `useLayoutStore` reads from `localStorage`
// key `dkg-layout` on first import, and writes are debounced to one
// `setItem` per ~150ms window across rapid `setLeftWidth` calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LAYOUT_KEY = 'dkg-layout';
const DEBOUNCE_MS = 150;
const DEBOUNCE_WAIT_MS = DEBOUNCE_MS + 30;

async function loadFreshStore(): Promise<typeof import('../src/ui/stores/layout.js')> {
  vi.resetModules();
  return await import('../src/ui/stores/layout.js');
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('useLayoutStore (dkg-layout localStorage persistence)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('falls back to defaults when no persisted state is present', async () => {
    const { useLayoutStore } = await loadFreshStore();
    const state = useLayoutStore.getState();
    expect(state.leftWidth).toBe(240);
    expect(state.rightWidth).toBe(360);
    expect(state.leftCollapsed).toBe(false);
    expect(state.rightCollapsed).toBe(false);
    expect(state.bottomCollapsed).toBe(true);
  });

  it('reads persisted widths from the dkg-layout key on initial load', async () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ leftWidth: 320, rightWidth: 420, leftCollapsed: true }),
    );

    const { useLayoutStore } = await loadFreshStore();
    const state = useLayoutStore.getState();
    expect(state.leftWidth).toBe(320);
    expect(state.rightWidth).toBe(420);
    expect(state.leftCollapsed).toBe(true);
    // bottomCollapsed not in the persisted blob -> default
    expect(state.bottomCollapsed).toBe(true);
  });

  it('clamps persisted widths to the drag-handler bounds on load', async () => {
    // Stale or hand-edited `dkg-layout` entries that fall outside the bounds
    // enforced by App.tsx's drag handlers would otherwise reload into an
    // unusable shell. Clamp on load so the store is always within range.
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ leftWidth: 2000, rightWidth: 1 }),
    );

    const { useLayoutStore } = await loadFreshStore();
    const state = useLayoutStore.getState();
    expect(state.leftWidth).toBe(400);   // clamp left to max 400
    expect(state.rightWidth).toBe(200);  // clamp right to min 200
  });

  it('ignores corrupted JSON and falls back to defaults', async () => {
    localStorage.setItem(LAYOUT_KEY, '{not json');

    const { useLayoutStore } = await loadFreshStore();
    const state = useLayoutStore.getState();
    expect(state.leftWidth).toBe(240);
    expect(state.rightWidth).toBe(360);
  });

  it('ignores non-finite numeric widths and falls back to defaults', async () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ leftWidth: 'oops', rightWidth: Number.POSITIVE_INFINITY }),
    );

    const { useLayoutStore } = await loadFreshStore();
    const state = useLayoutStore.getState();
    expect(state.leftWidth).toBe(240);
    expect(state.rightWidth).toBe(360);
  });

  it('debounces rapid setLeftWidth calls into a single write after 150ms', async () => {
    const { useLayoutStore } = await loadFreshStore();
    // happy-dom installs `setItem` as an own property on the localStorage
    // instance, not on Storage.prototype — spy on the instance directly.
    const spy = vi.spyOn(localStorage, 'setItem');

    useLayoutStore.getState().setLeftWidth(300);
    useLayoutStore.getState().setLeftWidth(310);
    useLayoutStore.getState().setLeftWidth(320);

    // Before the debounce window elapses, no write has hit localStorage.
    expect(spy).not.toHaveBeenCalled();

    await wait(DEBOUNCE_WAIT_MS);

    expect(spy).toHaveBeenCalledTimes(1);
    const [key, raw] = spy.mock.calls[0]!;
    expect(key).toBe(LAYOUT_KEY);
    const parsed = JSON.parse(raw as string);
    expect(parsed.leftWidth).toBe(320);

    spy.mockRestore();
  });

  it('persists rightWidth changes through the debounced path', async () => {
    const { useLayoutStore } = await loadFreshStore();
    const spy = vi.spyOn(localStorage, 'setItem');

    useLayoutStore.getState().setRightWidth(540);
    expect(spy).not.toHaveBeenCalled();

    await wait(DEBOUNCE_WAIT_MS);

    expect(spy).toHaveBeenCalledTimes(1);
    const [, raw] = spy.mock.calls[0]!;
    expect(JSON.parse(raw as string).rightWidth).toBe(540);

    spy.mockRestore();
  });

  it('round-trips a setRightWidth into the next module load', async () => {
    const { useLayoutStore } = await loadFreshStore();
    useLayoutStore.getState().setRightWidth(412);
    await wait(DEBOUNCE_WAIT_MS);

    const reloaded = await loadFreshStore();
    expect(reloaded.useLayoutStore.getState().rightWidth).toBe(412);
  });

  it('silently swallows localStorage.setItem failures (private mode, quota)', async () => {
    const { useLayoutStore } = await loadFreshStore();
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    useLayoutStore.getState().setLeftWidth(280);
    await wait(DEBOUNCE_WAIT_MS);

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
