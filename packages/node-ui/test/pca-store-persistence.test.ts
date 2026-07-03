// @vitest-environment happy-dom
//
// C2 — the double-mint create-pending marker must be DURABLE. `setCreatePending`
// writes localStorage SYNCHRONOUSLY (persistNow), not via the 150ms debounce, so a
// crash/hard-refresh in the window after the create POST is dispatched (the daemon
// mints regardless) but before a debounced timer would fire cannot lose the marker
// → no second fund-locking mint on reopen. Low-risk writes (trackAccount/
// untrackAccount) stay debounced. Mirrors layout-persistence.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PCA_SCOPE = '84532:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PCA_KEY = `dkg-pca:${PCA_SCOPE}`;
const DEBOUNCE_WAIT_MS = 150 + 30;

async function loadFreshStore(): Promise<typeof import('../src/ui/stores/pca.js')> {
  vi.resetModules();
  return await import('../src/ui/stores/pca.js');
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('usePcaStore (dkg-pca persistence — double-mint marker durability)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  function setScope(usePcaStore: Awaited<ReturnType<typeof loadFreshStore>>['usePcaStore']) {
    usePcaStore.getState().setScope(PCA_SCOPE);
  }

  it('setCreatePending writes localStorage SYNCHRONOUSLY (no timer advance)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const spy = vi.spyOn(localStorage, 'setItem');

    usePcaStore.getState().setCreatePending({ ownerEoa: '0xabc', submittedAt: 1 });

    // The marker is the double-mint guard — it must hit storage immediately, with
    // NO `await wait(...)`.
    expect(spy).toHaveBeenCalledTimes(1);
    const [key, raw] = spy.mock.calls[0]!;
    expect(key).toBe(PCA_KEY);
    expect(JSON.parse(raw as string).createPending.ownerEoa).toBe('0xabc');
    spy.mockRestore();
  });

  it('trackAccount stays DEBOUNCED (not synchronous)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const spy = vi.spyOn(localStorage, 'setItem');

    usePcaStore.getState().trackAccount('5');
    expect(spy).not.toHaveBeenCalled(); // debounced, unlike the marker

    await wait(DEBOUNCE_WAIT_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]![1] as string).trackedIds).toContain('5');
    spy.mockRestore();
  });

  it('the create-pending marker survives a reload happening INSIDE the debounce window', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    usePcaStore.getState().setCreatePending({ ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' });
    // Do NOT advance timers — simulate a crash/refresh immediately after submit.
    const reloaded = await loadFreshStore();
    setScope(reloaded.usePcaStore);
    const marker = reloaded.usePcaStore.getState().createPending;
    expect(marker?.ownerEoa).toBe('0xabc');
    expect(marker?.txHash).toBe('0xdead');
  });

  it('persistNow subsumes a queued debounced write (no stale-marker double-write)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const spy = vi.spyOn(localStorage, 'setItem');

    usePcaStore.getState().trackAccount('5'); // queues a debounced write
    usePcaStore.getState().setCreatePending({ ownerEoa: '0xabc', submittedAt: 1 }); // synchronous, cancels the timer

    // One synchronous write so far; the cancelled debounce must NOT fire a second.
    expect(spy).toHaveBeenCalledTimes(1);
    await wait(DEBOUNCE_WAIT_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(spy.mock.calls[0]![1] as string);
    expect(persisted.createPending.ownerEoa).toBe('0xabc');
    expect(persisted.trackedIds).toContain('5'); // snapshot captured both
    spy.mockRestore();
  });

  // P1 — confirmed-create finalize must be ATOMIC + SYNCHRONOUS: clearing the
  // marker and tracking the new id in one write, so a reload in the 150ms window
  // can't resurrect the stale marker (→ reconcile → double-mint) OR lose the id.
  it('finishCreate clears the marker AND tracks the id synchronously (P1)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    usePcaStore.getState().setCreatePending({ ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' });

    usePcaStore.getState().finishCreate('7'); // no timer advance

    // localStorage flipped synchronously: marker null AND id tracked.
    const persisted = JSON.parse(localStorage.getItem(PCA_KEY)!);
    expect(persisted.createPending).toBeNull();
    expect(persisted.trackedIds).toContain('7');
    // In-memory matches.
    expect(usePcaStore.getState().createPending).toBeNull();
    expect(usePcaStore.getState().trackedIds).toContain('7');

    // A subsequent reload resumes the FORM (no stale marker), with the id tracked.
    const reloaded = await loadFreshStore();
    setScope(reloaded.usePcaStore);
    expect(reloaded.usePcaStore.getState().createPending).toBeNull();
    expect(reloaded.usePcaStore.getState().trackedIds).toContain('7');
  });

  // T3 — when localStorage is unavailable, the marker still lives in memory (the
  // within-session guard) but createPendingPersisted is FALSE so the reconcile
  // screen can warn it won't survive a refresh (vs falsely claiming it's saved).
  it('setCreatePending: storage failure → marker in memory but createPendingPersisted=false (T3)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    usePcaStore.getState().setCreatePending({ ownerEoa: '0xabc', submittedAt: 1 });
    expect(usePcaStore.getState().createPending?.ownerEoa).toBe('0xabc'); // in-memory guard intact
    expect(usePcaStore.getState().createPendingPersisted).toBe(false); // storage blocked
    spy.mockRestore();
  });

  it('setCreatePending: storage OK → createPendingPersisted=true (T3)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    usePcaStore.getState().setCreatePending({ ownerEoa: '0xabc', submittedAt: 1 });
    expect(usePcaStore.getState().createPendingPersisted).toBe(true);
    expect(JSON.parse(localStorage.getItem(PCA_KEY)!).createPending.ownerEoa).toBe('0xabc');
  });
});
