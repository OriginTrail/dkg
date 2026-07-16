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
    fetchContextGraphs: () => Promise.reject(new Error('no daemon (test)')),
  },
}));
// The hook now subscribes to node events for live CG/membership
// refresh; stub it so the test doesn't need an EventSource.
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({ useNodeEvents: () => {} }));

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
    fetchCurrentAgentMock.mockResolvedValue({ agentDid: 'did:dkg:agent:0xabc', peerId: 'p1' });
  });
  afterEach(() => {
    localStorage.clear();
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
