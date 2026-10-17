// @vitest-environment happy-dom
//
// PR6 coverage gap: the shared hidden-CG hook + the "My Context Graphs"
// membership hook are user-facing (sidebar/dashboard parity is an explicit
// invariant) but shipped without unit tests. These pin:
//   - useHiddenContextGraphIds: localStorage load, hide(), unhideAll(),
//     cross-instance sync via the custom event, legacy key back-compat.
//   - useMyContextGraphs: the membership filter == belongsInMyProjectsSidebar
//     applied to the store list minus hidden ids (the parity invariant),
//     and identity-independent callerInvolved resolution.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

const HIDDEN_KEY = 'v10:hiddenProjectIds';

// fetchCurrentAgent is hit by useMyContextGraphs on mount; stub it so the
// hook's identity path is deterministic and offline. The hook now calls
// it through api-wrapper (mock-aware), so mock at that layer — the
// wrapper's withFallback would otherwise route to the mock provider in
// the test env and bypass a plain api.js stub.
const fetchCurrentAgentMock = vi.fn();
const fetchContextGraphsMock = vi.fn();
let nodeEventHandler: ((event: any) => void) | undefined;
vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return { ...actual, fetchCurrentAgent: fetchCurrentAgentMock };
});
vi.mock('../src/ui/api-wrapper.js', () => ({
  // fetchContextGraphs rejects so the hook's store-hydration loadCGs
  // catch is a no-op and the store keeps the fixtures each test seeds
  // directly (simulates "no daemon" — membership logic is what's under
  // test here, not the loader).
  api: {
    fetchCurrentAgent: () => fetchCurrentAgentMock(),
    fetchContextGraphs: () => fetchContextGraphsMock(),
  },
}));
// The hook now subscribes to node events for live CG/membership
// refresh; stub it so the test doesn't need an EventSource.
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useNodeEvents: (handler: (event: any) => void) => { nodeEventHandler = handler; } }));

async function importHooks() {
  const hidden = await import('../src/ui/hooks/useHiddenContextGraphIds.js');
  const mine = await import('../src/ui/hooks/useMyContextGraphs.js');
  const store = await import('../src/ui/stores/projects.js');
  return { ...hidden, ...mine, useProjectsStore: store.useProjectsStore };
}

interface HiddenApi {
  hidden: Set<string>;
  hide: (id: string) => void;
  unhideAll: () => void;
}

/** Mount a hook into a real React root and capture its latest return. */
async function renderHook<T>(useHook: () => T): Promise<{
  current: () => T;
  unmount: () => Promise<void>;
}> {
  let latest: T;
  function Probe() {
    latest = useHook();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    current: () => latest,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

function cg(id: string, over: Record<string, unknown> = {}) {
  return { id, name: id.toUpperCase(), ...over } as any;
}

describe('useHiddenContextGraphIds', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    document.body.innerHTML = '';
    vi.resetModules();
    nodeEventHandler = undefined;
    fetchContextGraphsMock.mockReset().mockRejectedValue(new Error('no daemon (test)'));
    fetchCurrentAgentMock.mockResolvedValue({ agentDid: 'did:dkg:agent:0xabc', peerId: 'p1' });
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('loads an empty set when nothing is persisted', async () => {
    const { useHiddenContextGraphIds } = await importHooks();
    const h = await renderHook<HiddenApi>(() => useHiddenContextGraphIds());
    expect([...h.current().hidden]).toEqual([]);
    await h.unmount();
  });

  it('reads the legacy v10:hiddenProjectIds key (back-compat with existing users)', async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['a', 'b']));
    const { useHiddenContextGraphIds } = await importHooks();
    const h = await renderHook<HiddenApi>(() => useHiddenContextGraphIds());
    expect([...h.current().hidden].sort()).toEqual(['a', 'b']);
    await h.unmount();
  });

  it('tolerates corrupt JSON and non-array payloads', async () => {
    localStorage.setItem(HIDDEN_KEY, '{not json');
    const { useHiddenContextGraphIds } = await importHooks();
    const h1 = await renderHook<HiddenApi>(() => useHiddenContextGraphIds());
    expect([...h1.current().hidden]).toEqual([]);
    await h1.unmount();

    localStorage.setItem(HIDDEN_KEY, JSON.stringify({ not: 'an array' }));
    const h2 = await renderHook<HiddenApi>(() => useHiddenContextGraphIds());
    expect([...h2.current().hidden]).toEqual([]);
    await h2.unmount();
  });

  it('hide(id) persists to localStorage and updates the live set', async () => {
    const { useHiddenContextGraphIds } = await importHooks();
    const h = await renderHook<HiddenApi>(() => useHiddenContextGraphIds());
    await act(async () => { h.current().hide('cg-1'); });
    expect([...h.current().hidden]).toEqual(['cg-1']);
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual(['cg-1']);
    await h.unmount();
  });

  it('unhideAll() clears the persisted set', async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['x', 'y']));
    const { useHiddenContextGraphIds } = await importHooks();
    const h = await renderHook<HiddenApi>(() => useHiddenContextGraphIds());
    await act(async () => { h.current().unhideAll(); });
    expect([...h.current().hidden]).toEqual([]);
    expect(JSON.parse(localStorage.getItem(HIDDEN_KEY)!)).toEqual([]);
    await h.unmount();
  });

  it('two hook instances stay in sync via the custom change event (parity invariant)', async () => {
    const { useHiddenContextGraphIds } = await importHooks();
    const a = await renderHook<HiddenApi>(() => useHiddenContextGraphIds());
    const b = await renderHook<HiddenApi>(() => useHiddenContextGraphIds());

    await act(async () => { a.current().hide('shared-cg'); });
    // The second instance must observe the same hidden id — this is exactly
    // the PanelLeft↔Dashboard↔MemoryStack parity guarantee.
    expect([...b.current().hidden]).toEqual(['shared-cg']);

    await act(async () => { b.current().unhideAll(); });
    expect([...a.current().hidden]).toEqual([]);

    await a.unmount();
    await b.unmount();
  });
});

describe('useMyContextGraphs (sidebar/dashboard membership parity)', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    document.body.innerHTML = '';
    vi.resetModules();
    nodeEventHandler = undefined;
    fetchContextGraphsMock.mockReset().mockRejectedValue(new Error('no daemon (test)'));
    fetchCurrentAgentMock.mockResolvedValue({ agentDid: 'did:dkg:agent:0xabc', peerId: 'p1' });
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('supersedes a pre-event inventory response after membership changes', async () => {
    let oldReply!: (value: any) => void;
    fetchContextGraphsMock.mockReturnValueOnce(new Promise(resolve => { oldReply = resolve; }));
    const { useMyContextGraphs } = await importHooks();
    const h = await renderHook(() => useMyContextGraphs());
    try {
      fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [cg('approved', { callerInvolved: true })] });
      await act(async () => { nodeEventHandler?.({ type: 'join_approved', data: {} }); });
      await act(async () => { oldReply({ contextGraphs: [] }); });
      expect(fetchContextGraphsMock).toHaveBeenCalledTimes(2);
      expect(h.current().myCgs.map(cg => cg.id)).toEqual(['approved']);
      expect(h.current().cgsError).toBeNull();
    } finally { await h.unmount(); }
  });

  it.each(['resolve', 'reject'])('replaces an old-token request that later %ss without publishing its data or error', async outcome => {
    let resolve!: (value: any) => void, reject!: (error: Error) => void;
    window.__DKG_TOKEN__ = 'token-a';
    fetchContextGraphsMock.mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; }));
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    const seen: string[][] = [];
    const unsubscribe = useProjectsStore.subscribe(state => seen.push(state.contextGraphs.map(cg => cg.id)));
    const h = await renderHook(() => useMyContextGraphs());
    try {
      window.__DKG_TOKEN__ = 'token-b';
      fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [cg('new-session', { callerInvolved: true })] });
      await act(async () => {
        if (outcome === 'resolve') resolve({ contextGraphs: [cg('old-session', { callerInvolved: true })] });
        else reject(new Error('old-session error'));
      });
      expect(fetchContextGraphsMock).toHaveBeenCalledTimes(2);
      expect(seen.flat()).not.toContain('old-session');
      expect(h.current().myCgs.map(cg => cg.id)).toEqual(['new-session']);
      expect(h.current().cgsLoading).toBe(false);
      expect(h.current().cgsError).toBeNull();
    } finally { unsubscribe(); delete window.__DKG_TOKEN__; await h.unmount(); }
  });

  it('mutation recovery follows a newer event refresh instead of returning stale inventory', async () => {
    fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [cg('old', { callerInvolved: true })] });
    const { useMyContextGraphs } = await importHooks();
    const { refreshContextGraphInventoryAfterMutation } = await import('../src/ui/hooks/useContextGraphInventory.js');
    const h = await renderHook(() => useMyContextGraphs());
    let first!: (value: any) => void, second!: (value: any) => void;
    fetchContextGraphsMock.mockReturnValueOnce(new Promise(resolve => { first = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { second = resolve; }));
    let settled = false;
    const mutation = refreshContextGraphInventoryAfterMutation().then(rows => { settled = true; return rows; });
    try {
      await act(async () => { await Promise.resolve(); });
      await act(async () => { nodeEventHandler?.({ type: 'join_approved', data: {} }); });
      await act(async () => { first({ contextGraphs: [cg('superseded', { callerInvolved: true })] }); });
      expect(settled).toBe(false);
      await act(async () => { second({ contextGraphs: [cg('current', { callerInvolved: true })] }); });
      expect((await mutation).map(cg => cg.id)).toEqual(['current']);
    } finally {
      first({ contextGraphs: [] }); second({ contextGraphs: [] });
      await mutation; await h.unmount();
    }
  });

  it('keeps an explicit mutation refresh owned when the last inventory view unmounts', async () => {
    fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [] });
    const { useMyContextGraphs } = await importHooks();
    const { refreshContextGraphInventoryAfterMutation } = await import('../src/ui/hooks/useContextGraphInventory.js');
    const h = await renderHook(() => useMyContextGraphs());
    let reply!: (value: any) => void;
    fetchContextGraphsMock.mockReturnValueOnce(new Promise(resolve => { reply = resolve; }));
    const mutation = refreshContextGraphInventoryAfterMutation();
    await h.unmount();
    reply({ contextGraphs: [cg('created', { callerInvolved: true })] });
    expect((await mutation).map(cg => cg.id)).toEqual(['created']);
  });

  it('coalesced inventory callers also await the associated identity refresh', async () => {
    let identity!: (value: any) => void, list!: (value: any) => void;
    fetchCurrentAgentMock.mockReturnValueOnce(new Promise(resolve => { identity = resolve; }));
    fetchContextGraphsMock.mockReturnValueOnce(new Promise(resolve => { list = resolve; }));
    const { useMyContextGraphs } = await importHooks();
    const { refreshContextGraphInventory } = await import('../src/ui/hooks/useContextGraphInventory.js');
    const h = await renderHook(() => useMyContextGraphs());
    let settled = false;
    const joined = refreshContextGraphInventory().then(() => { settled = true; });
    try {
      await act(async () => { list({ contextGraphs: [] }); });
      expect(settled).toBe(false);
      await act(async () => { identity({ agentDid: 'did:dkg:agent:0xabc' }); await joined; });
      expect(settled).toBe(true);
    } finally { identity({ agentDid: 'did:dkg:agent:0xabc' }); await joined; await h.unmount(); }
  });

  it('refreshes identity with inventory when no dashboard membership consumer is mounted', async () => {
    fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [] });
    const { useContextGraphInventory, refreshContextGraphInventory } = await import('../src/ui/hooks/useContextGraphInventory.js');
    fetchCurrentAgentMock.mockClear();
    const h = await renderHook(() => useContextGraphInventory());
    try {
      expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(1);
      await act(async () => { await refreshContextGraphInventory(true); });
      expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(2);
    } finally { await h.unmount(); }
  });

  it('coordinates one identity refresh per retry even when a new graph array arrives later', async () => {
    fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [] });
    const { useMyContextGraphs } = await importHooks();
    const h = await renderHook(() => useMyContextGraphs());
    let reply!: (value: any) => void;
    fetchContextGraphsMock.mockReturnValueOnce(new Promise(resolve => { reply = resolve; }));
    fetchCurrentAgentMock.mockClear();
    try {
      let retry!: Promise<void>;
      await act(async () => { retry = h.current().retry(); });
      expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(1);
      await act(async () => { reply({ contextGraphs: [cg('after-retry', { callerInvolved: true })] }); await retry; });
      expect(fetchCurrentAgentMock).toHaveBeenCalledTimes(1);
    } finally { await h.unmount(); }
  });

  it('distinguishes a failed cold list from a confirmed empty list and clears the error on retry', async () => {
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    useProjectsStore.setState({ contextGraphs: [] });
    const h = await renderHook(() => useMyContextGraphs());
    try {
      expect(h.current().cgsLoading).toBe(false);
      expect(h.current().cgsError).toContain('no daemon');
      expect(h.current().myCgs).toEqual([]);
      fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [] });
      await act(async () => { await h.current().retry(); });
      expect(h.current().cgsError).toBeNull();
      expect(h.current().myCgs).toEqual([]);
    } finally { await h.unmount(); }
  });

  it('preserves the last good graphs and exposes the failing endpoint', async () => {
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    useProjectsStore.setState({ contextGraphs: [cg('kept', { callerInvolved: true })] });
    fetchCurrentAgentMock.mockRejectedValueOnce(new Error('identity unavailable'));
    const h = await renderHook(() => useMyContextGraphs());
    try {
      expect(h.current().myCgs.map(cg => cg.id)).toEqual(['kept']);
      expect(h.current().cgsError).toContain('no daemon');
      expect(h.current().identityError).toContain('identity unavailable');
      fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [cg('kept', { callerInvolved: true })] });
      fetchCurrentAgentMock.mockResolvedValue({ agentDid: 'did:dkg:agent:0xabc' });
      await act(async () => { await h.current().retry(); });
      expect(h.current().cgsError).toBeNull();
      expect(h.current().identityError).toBeNull();
    } finally { await h.unmount(); }
  });

  it('does not let a slow older list overwrite a successful retry', async () => {
    let oldReply!: (value: any) => void;
    fetchContextGraphsMock.mockReturnValueOnce(new Promise(resolve => { oldReply = resolve; }));
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    useProjectsStore.setState({ contextGraphs: [] });
    const h = await renderHook(() => useMyContextGraphs());
    try {
      fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [cg('new', { callerInvolved: true })] });
      await act(async () => { await h.current().retry(); });
      await act(async () => { oldReply({ contextGraphs: [cg('old', { callerInvolved: true })] }); });
      expect(h.current().myCgs.map(cg => cg.id)).toEqual(['new']);
    } finally { await h.unmount(); }
  });

  it('retries identity even when the graph-list cache returns the same array reference', async () => {
    const graphs = [cg('kept', { callerInvolved: true })];
    fetchContextGraphsMock.mockResolvedValue({ contextGraphs: graphs });
    fetchCurrentAgentMock.mockRejectedValue(new Error('identity unavailable'));
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    useProjectsStore.setState({ contextGraphs: graphs });
    const h = await renderHook(() => useMyContextGraphs());
    try {
      expect(h.current().identityError).toContain('identity unavailable');
      fetchCurrentAgentMock.mockResolvedValue({ agentDid: 'did:dkg:agent:0xabc' });
      await act(async () => { await h.current().retry(); });
      expect(h.current().identityError).toBeNull();
    } finally { await h.unmount(); }
  });

  it('does not mutate the shared graph store after unmount', async () => {
    let reply!: (value: any) => void;
    fetchContextGraphsMock.mockReturnValueOnce(new Promise(resolve => { reply = resolve; }));
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    useProjectsStore.setState({ contextGraphs: [] });
    const h = await renderHook(() => useMyContextGraphs());
    await h.unmount();
    await act(async () => { reply({ contextGraphs: [cg('old', { callerInvolved: true })] }); });
    expect(useProjectsStore.getState().contextGraphs).toEqual([]);
  });

  it('returns only callerInvolved members and excludes non-members (identity-independent)', async () => {
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    act(() => {
      useProjectsStore.setState({
        contextGraphs: [
          cg('member', { callerInvolved: true }),
          cg('outsider', { callerInvolved: false, accessPolicy: 'public' }),
          cg('member2', { callerInvolved: true }),
        ],
      });
    });
    const h = await renderHook(() => useMyContextGraphs());
    expect((h.current() as any).myCgs.map((c: any) => c.id)).toEqual(['member', 'member2']);
    await h.unmount();
  });

  it('subtracts hidden ids from the membership set (the exact sidebar filter)', async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['member2']));
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    act(() => {
      useProjectsStore.setState({
        contextGraphs: [
          cg('member', { callerInvolved: true }),
          cg('member2', { callerInvolved: true }),
        ],
      });
    });
    const h = await renderHook(() => useMyContextGraphs());
    expect((h.current() as any).myCgs.map((c: any) => c.id)).toEqual(['member']);
    await h.unmount();
  });

  it('curator-by-identity match is included even without callerInvolved', async () => {
    // canonicalAgentDid only lowercases full 40-hex EVM addresses, so use
    // realistic-length addresses with differing case to also assert the
    // case-insensitive curator match.
    const AGENT = 'did:dkg:agent:0xCAFEbabeCAFEbabeCAFEbabeCAFEbabeCAFEbabe';
    const CURATOR = 'did:dkg:agent:0xcafebabecafebabecafebabecafebabecafebabe';
    fetchCurrentAgentMock.mockReset();
    fetchCurrentAgentMock.mockResolvedValue({ agentDid: AGENT, peerId: 'p1' });
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    act(() => {
      useProjectsStore.setState({
        contextGraphs: [
          cg('curated', { curator: CURATOR }),
          cg('other', { curator: 'did:dkg:agent:0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' }),
        ],
      });
    });
    const h = await renderHook(() => useMyContextGraphs());
    // identity resolves async (fetchCurrentAgent → setIdentity → useMemo
    // recompute); poll a few macrotask ticks for the membership to settle.
    for (let i = 0; i < 5 && (h.current() as any).myCgs.length === 0; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    expect((h.current() as any).myCgs.map((c: any) => c.id)).toEqual(['curated']);
    await h.unmount();
  });

  it('exposes identityLoading and flips it false after the agent request settles', async () => {
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    act(() => { useProjectsStore.setState({ contextGraphs: [] }); });
    const h = await renderHook(() => useMyContextGraphs());
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect((h.current() as any).identityLoading).toBe(false);
    await h.unmount();
  });

  it('a hidden + non-member list yields an empty membership set', async () => {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(['m']));
    const { useMyContextGraphs, useProjectsStore } = await importHooks();
    act(() => {
      useProjectsStore.setState({
        contextGraphs: [
          cg('m', { callerInvolved: true }),
          cg('n', { callerInvolved: false }),
        ],
      });
    });
    const h = await renderHook(() => useMyContextGraphs());
    expect((h.current() as any).myCgs).toEqual([]);
    await h.unmount();
  });
});
