// @vitest-environment happy-dom
//
// A2 — the persisted PCA store (`stores/pca.ts`). Mirrors
// `layout-persistence.test.ts`: a fresh module import per case so the
// localStorage-seeded `initial` is re-read, and the debounced writer is
// awaited before asserting the persisted blob.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PCA_KEY = 'dkg-pca';
const DEBOUNCE_WAIT_MS = 150 + 30;

async function loadFreshStore(): Promise<typeof import('../src/ui/stores/pca.js')> {
  vi.resetModules();
  return await import('../src/ui/stores/pca.js');
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('usePcaStore (dkg-pca localStorage persistence)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to an empty tracked set and no pending create', async () => {
    const { usePcaStore } = await loadFreshStore();
    const s = usePcaStore.getState();
    expect(s.trackedIds).toEqual([]);
    expect(s.createPending).toBeNull();
  });

  it('reads persisted trackedIds + createPending on initial load', async () => {
    localStorage.setItem(
      PCA_KEY,
      JSON.stringify({
        trackedIds: ['1', '5'],
        createPending: { ownerEoa: '0xowner', submittedAt: 1000, txHash: '0xdead' },
      }),
    );
    const { usePcaStore } = await loadFreshStore();
    const s = usePcaStore.getState();
    expect(s.trackedIds).toEqual(['1', '5']);
    expect(s.createPending).toEqual({ ownerEoa: '0xowner', submittedAt: 1000, txHash: '0xdead' });
  });

  it('sanitizes a corrupt blob: drops non-numeric ids, dedupes, nulls a malformed pending marker', async () => {
    localStorage.setItem(
      PCA_KEY,
      JSON.stringify({
        trackedIds: ['1', '1', 'abc', 7, '', '9'],
        createPending: { ownerEoa: '', submittedAt: 'nope' },
      }),
    );
    const { usePcaStore } = await loadFreshStore();
    const s = usePcaStore.getState();
    expect(s.trackedIds).toEqual(['1', '9']);
    expect(s.createPending).toBeNull();
  });

  it('ignores corrupted JSON and falls back to defaults', async () => {
    localStorage.setItem(PCA_KEY, '{not json');
    const { usePcaStore } = await loadFreshStore();
    expect(usePcaStore.getState().trackedIds).toEqual([]);
  });

  it('trackAccount adds, dedupes, and persists (debounced)', async () => {
    const { usePcaStore } = await loadFreshStore();
    const spy = vi.spyOn(localStorage, 'setItem');

    usePcaStore.getState().trackAccount('3');
    usePcaStore.getState().trackAccount('3'); // dupe — no-op
    usePcaStore.getState().trackAccount('4');
    expect(usePcaStore.getState().trackedIds).toEqual(['3', '4']);
    expect(usePcaStore.getState().isTracked('3')).toBe(true);
    expect(usePcaStore.getState().isTracked('99')).toBe(false);

    await wait(DEBOUNCE_WAIT_MS);
    expect(spy).toHaveBeenCalled();
    const lastRaw = spy.mock.calls.at(-1)![1] as string;
    expect(JSON.parse(lastRaw).trackedIds).toEqual(['3', '4']);
    spy.mockRestore();
  });

  it('trackAccount rejects an invalid (non-numeric) id', async () => {
    const { usePcaStore } = await loadFreshStore();
    usePcaStore.getState().trackAccount('0xabc');
    usePcaStore.getState().trackAccount('');
    expect(usePcaStore.getState().trackedIds).toEqual([]);
  });

  it('untrackAccount removes the id and persists', async () => {
    localStorage.setItem(PCA_KEY, JSON.stringify({ trackedIds: ['1', '2', '3'] }));
    const { usePcaStore } = await loadFreshStore();
    usePcaStore.getState().untrackAccount('2');
    expect(usePcaStore.getState().trackedIds).toEqual(['1', '3']);
  });

  it('drives the create-pending lifecycle and persists each transition', async () => {
    const { usePcaStore } = await loadFreshStore();
    const marker = { ownerEoa: '0xowner', submittedAt: 12345, txHash: '0xbeef' };
    usePcaStore.getState().setCreatePending(marker);
    expect(usePcaStore.getState().createPending).toEqual(marker);

    // C2 — the create-pending marker is written SYNCHRONOUSLY (persistNow), so it
    // is in localStorage immediately, with no debounce wait. (See
    // pca-store-persistence.test.ts for the durability guarantee in detail.)
    expect(JSON.parse(localStorage.getItem(PCA_KEY)!).createPending).toEqual(marker);

    usePcaStore.getState().clearCreatePending();
    expect(usePcaStore.getState().createPending).toBeNull();
    await wait(DEBOUNCE_WAIT_MS);
    expect(JSON.parse(localStorage.getItem(PCA_KEY)!).createPending).toBeNull();
  });

  it('round-trips a tracked id into the next module load', async () => {
    const first = await loadFreshStore();
    first.usePcaStore.getState().trackAccount('11');
    await wait(DEBOUNCE_WAIT_MS);

    const reloaded = await loadFreshStore();
    expect(reloaded.usePcaStore.getState().trackedIds).toEqual(['11']);
  });

  it('silently swallows localStorage.setItem failures (private mode, quota)', async () => {
    const { usePcaStore } = await loadFreshStore();
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    usePcaStore.getState().trackAccount('1');
    await wait(DEBOUNCE_WAIT_MS);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
