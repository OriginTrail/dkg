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
// A DIFFERENT deployment on the SAME chain (distinct nft+token) — a marker stored
// under one scope must not bleed into the other's storage key.
const PCA_SCOPE_B = '84532:0xcccccccccccccccccccccccccccccccccccccccc:0xdddddddddddddddddddddddddddddddddddddddd';
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

// #1376 — the TOP-UP-pending marker inherits the create-pending durability
// contract (C2 above). `setTopUpPending` writes localStorage SYNCHRONOUSLY
// (persistNow), not via the 150ms debounce, so a crash/hard-refresh in the window
// after the top-up POST is dispatched (the daemon broadcasts regardless) but
// before a debounced timer would fire cannot lose the marker → the reconcile
// screen still knows a top-up is in flight rather than letting a second
// buffer-funding top-up through. A lost marker fails toward DANGER, like create.
// Removal (`clearTopUpPending`, the low-stakes direction) stays debounced. Markers
// are keyed per account id, so concurrent top-ups on different PCAs are
// independent; malformed persisted entries are dropped on load so a corrupt blob
// can't seed a phantom in-flight top-up.
describe('usePcaStore (dkg-pca persistence — top-up marker durability, #1376)', () => {
  beforeEach(() => localStorage.clear());
  // Structural (not by-convention) isolation: the storage-failure case installs a
  // THROWING setItem mock, so a mid-test assertion failure would otherwise poison
  // later tests. Drain any queued debounce, restore all mocks, then clear.
  afterEach(async () => {
    await wait(DEBOUNCE_WAIT_MS);
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function setScope(usePcaStore: Awaited<ReturnType<typeof loadFreshStore>>['usePcaStore']) {
    usePcaStore.getState().setScope(PCA_SCOPE);
  }

  it('setTopUpPending writes localStorage SYNCHRONOUSLY (no timer advance)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const spy = vi.spyOn(localStorage, 'setItem');

    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '3', ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' });

    // Same double-spend guard tier as create-pending: it must hit storage
    // immediately, with NO `await wait(...)`.
    expect(spy).toHaveBeenCalledTimes(1);
    const [key, raw] = spy.mock.calls[0]!;
    expect(key).toBe(PCA_KEY);
    expect(JSON.parse(raw as string).topUpPending['3'].txHash).toBe('0xdead');
    spy.mockRestore();
  });

  it('a top-up marker (with optional tokens/previousTopUpBufferTrac) survives a reload', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    usePcaStore.getState().setTopUpPending({
      accountId: '3',
      ownerEoa: '0xabc',
      submittedAt: 42,
      txHash: '0xdead',
      tokens: '100',
      previousTopUpBufferTrac: '50',
    });

    // Do NOT advance timers — persistNow already wrote synchronously; simulate a
    // crash/refresh immediately after submit.
    const reloaded = await loadFreshStore();
    setScope(reloaded.usePcaStore);
    const marker = reloaded.usePcaStore.getState().topUpPending['3'];
    expect(marker).toEqual({
      accountId: '3',
      ownerEoa: '0xabc',
      submittedAt: 42,
      txHash: '0xdead',
      tokens: '100',
      previousTopUpBufferTrac: '50',
    });
  });

  it('clearTopUpPending removes in-memory immediately but persists via the DEBOUNCE', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const spy = vi.spyOn(localStorage, 'setItem');
    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '3', ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' });
    expect(spy).toHaveBeenCalledTimes(1); // the synchronous set
    spy.mockClear();

    usePcaStore.getState().clearTopUpPending('3');
    // In-memory removal is immediate...
    expect(usePcaStore.getState().topUpPending).toEqual({});
    // ...but the write is debounced (low-stakes direction), so nothing synchronous.
    expect(spy).not.toHaveBeenCalled();

    await wait(DEBOUNCE_WAIT_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(PCA_KEY)!).topUpPending).toEqual({});

    // A subsequent reload carries no marker.
    const reloaded = await loadFreshStore();
    setScope(reloaded.usePcaStore);
    expect(reloaded.usePcaStore.getState().topUpPending).toEqual({});
    spy.mockRestore();
  });

  it('load drops malformed top-up entries, keeping only fully-valid ones', async () => {
    // One valid entry ('3') plus one malformed entry per STRUCTURED reject branch of
    // sanitizeTopUpPending (5): missing txHash, key/accountId mismatch, non-digit key,
    // empty ownerEoa, non-finite submittedAt. (The non-object-raw branch is covered in
    // its own test below.)
    localStorage.setItem(
      PCA_KEY,
      JSON.stringify({
        topUpPending: {
          '3': { accountId: '3', ownerEoa: '0xowner', submittedAt: 1, txHash: '0xhash' },
          '4': { accountId: '4', ownerEoa: '0xo', submittedAt: 1 }, // missing txHash
          '5': { accountId: '6', ownerEoa: '0xo', submittedAt: 1, txHash: '0xh' }, // key/accountId mismatch
          abc: { accountId: 'abc', ownerEoa: '0xo', submittedAt: 1, txHash: '0xh' }, // non-digit key
          '7': { accountId: '7', ownerEoa: '', submittedAt: 1, txHash: '0xh' }, // empty ownerEoa
          '8': { accountId: '8', ownerEoa: '0xo', submittedAt: 'soon', txHash: '0xh' }, // non-finite submittedAt
        },
      }),
    );

    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const pending = usePcaStore.getState().topUpPending;
    expect(Object.keys(pending)).toEqual(['3']);
    expect(pending['3']).toEqual({
      accountId: '3',
      ownerEoa: '0xowner',
      submittedAt: 1,
      txHash: '0xhash',
    });
  });

  // The `raw == null || typeof raw !== 'object'` branch of sanitizeTopUpPending,
  // isolated so a regression here fails distinctly from the structured-field checks.
  it('load drops non-object top-up entries (null / primitive raw)', async () => {
    localStorage.setItem(
      PCA_KEY,
      JSON.stringify({
        topUpPending: {
          '3': { accountId: '3', ownerEoa: '0xowner', submittedAt: 1, txHash: '0xhash' },
          '9': null, // raw == null
          '10': 'nope', // raw is a primitive, not an object
        },
      }),
    );

    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const pending = usePcaStore.getState().topUpPending;
    expect(Object.keys(pending)).toEqual(['3']);
    expect(pending['3'].txHash).toBe('0xhash');
  });

  it('setTopUpPending ignores an invalid accountId (no-op, no throw)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);

    expect(() =>
      usePcaStore
        .getState()
        .setTopUpPending({ accountId: '', ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' }),
    ).not.toThrow();
    expect(() =>
      usePcaStore
        .getState()
        .setTopUpPending({ accountId: 'abc', ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' }),
    ).not.toThrow();

    // The guard returns before any state mutation or write.
    expect(usePcaStore.getState().topUpPending).toEqual({});
    expect(localStorage.getItem(PCA_KEY)).toBeNull();
  });

  it('top-up markers are keyed independently per account id', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '3', ownerEoa: '0xa', submittedAt: 1, txHash: '0x3' });
    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '7', ownerEoa: '0xb', submittedAt: 2, txHash: '0x7' });
    expect(Object.keys(usePcaStore.getState().topUpPending).sort()).toEqual(['3', '7']);

    usePcaStore.getState().clearTopUpPending('3');
    // Clearing one leaves the other intact.
    expect(usePcaStore.getState().topUpPending['3']).toBeUndefined();
    expect(usePcaStore.getState().topUpPending['7']?.txHash).toBe('0x7');

    await wait(DEBOUNCE_WAIT_MS); // flush the debounced clear so no timer leaks into the next test
  });

  it('setTopUpPending (persistNow) subsumes a queued debounced write', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const spy = vi.spyOn(localStorage, 'setItem');

    usePcaStore.getState().trackAccount('5'); // queues a debounced write
    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '3', ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' }); // synchronous, cancels the timer

    // One synchronous write; the cancelled debounce must NOT fire a second.
    expect(spy).toHaveBeenCalledTimes(1);
    await wait(DEBOUNCE_WAIT_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(spy.mock.calls[0]![1] as string);
    expect(persisted.topUpPending['3'].txHash).toBe('0xdead'); // marker captured
    expect(persisted.trackedIds).toContain('5'); // AND the queued id, in the same snapshot
    spy.mockRestore();
  });

  // Storage-failure crash-safety (mirrors the create-pending T3). persistNow
  // swallows the storage error, but the in-memory set happened first, so the
  // within-session double-spend guard survives a blocked/full store.
  it('setTopUpPending: storage failure keeps the marker in memory', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(() =>
      usePcaStore
        .getState()
        .setTopUpPending({ accountId: '3', ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' }),
    ).not.toThrow();

    // The write failed, but the session still knows a top-up is in flight.
    expect(usePcaStore.getState().topUpPending['3']?.txHash).toBe('0xdead');
    spy.mockRestore();
  });

  // Markers are isolated per deployment scope (the storage key embeds nft+token).
  it('top-up markers are isolated per deployment scope', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore); // scope A
    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '3', ownerEoa: '0xabc', submittedAt: 1, txHash: '0xdead' });

    // A different deployment on the same chain shows no marker...
    usePcaStore.getState().setScope(PCA_SCOPE_B);
    expect(usePcaStore.getState().topUpPending).toEqual({});

    // ...and switching back restores scope A's marker (persisted synchronously before the switch).
    usePcaStore.getState().setScope(PCA_SCOPE);
    expect(usePcaStore.getState().topUpPending['3']?.txHash).toBe('0xdead');
  });

  // Re-submitting the same accountId overwrites last-write-wins, in memory AND on disk.
  it('setTopUpPending overwrites the same accountId (last-write-wins)', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '3', ownerEoa: '0xabc', submittedAt: 1, txHash: '0xAAA' });
    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '3', ownerEoa: '0xabc', submittedAt: 2, txHash: '0xBBB' });

    expect(usePcaStore.getState().topUpPending['3'].txHash).toBe('0xBBB');
    expect(JSON.parse(localStorage.getItem(PCA_KEY)!).topUpPending['3'].txHash).toBe('0xBBB');
  });

  // A top-up write must not clobber an in-flight create marker: persistNow
  // snapshots the WHOLE store, so both guards coexist and both survive a reload.
  it('setTopUpPending preserves an existing create-pending marker in the merged snapshot', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    usePcaStore
      .getState()
      .setCreatePending({ ownerEoa: '0xowner', submittedAt: 1, txHash: '0xcreate' });
    usePcaStore
      .getState()
      .setTopUpPending({ accountId: '3', ownerEoa: '0xabc', submittedAt: 2, txHash: '0xtopup' });

    const reloaded = await loadFreshStore();
    setScope(reloaded.usePcaStore);
    expect(reloaded.usePcaStore.getState().createPending?.ownerEoa).toBe('0xowner');
    expect(reloaded.usePcaStore.getState().topUpPending['3'].txHash).toBe('0xtopup');
  });

  // Clearing an id that isn't tracked must be a safe no-op (idempotent retry/recovery).
  it('clearTopUpPending on an unknown id is a safe no-op', async () => {
    const { usePcaStore } = await loadFreshStore();
    setScope(usePcaStore);
    expect(() => usePcaStore.getState().clearTopUpPending('99')).not.toThrow();
    expect(usePcaStore.getState().topUpPending).toEqual({});
  });
});
