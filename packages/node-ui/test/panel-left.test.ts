// @vitest-environment happy-dom
//
// NOTE on mocking: PanelLeft pulls from `../src/ui/api.js` (current-agent +
// local-agent integrations) and `../src/ui/api-wrapper.js` (context graphs
// list). Both are mocked here so the test runs without a live daemon. All
// stores (layout, projects, journey, tabs) are real — they're the unit
// under test for the sidebar sections work.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const fetchCurrentAgentMock = vi.fn();
const fetchLocalAgentIntegrationsMock = vi.fn();
const apiFetchContextGraphsMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    fetchCurrentAgent: fetchCurrentAgentMock,
    fetchLocalAgentIntegrations: fetchLocalAgentIntegrationsMock,
  };
});

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    fetchContextGraphs: apiFetchContextGraphsMock,
  },
}));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Cross-test cleanup registry. PanelLeft spins up a 60s polling interval
// (`loadCGs`) and subscribes to `useNodeEvents` on mount — without an
// explicit unmount, those listeners + timers leak into the next test and
// can produce flaky extra mock calls (qa-lead / Codex).
const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

describe('PanelLeft — sidebar cleanup + collapsible sections', () => {
  afterEach(() => {
    // Unmount in reverse-mount order so any teardown effects fire in the
    // expected sequence. Wrap each unmount in `act` so React's flush
    // (effects, microtasks) completes before the next test runs.
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    // useNodeEvents (used by PanelLeft) opens an EventSource on mount.
    // happy-dom doesn't ship EventSource; stub it so the hook can no-op
    // without throwing in the test container.
    (globalThis as any).EventSource = class StubEventSource {
      url: string;
      readyState = 0;
      onopen: ((e: any) => void) | null = null;
      onmessage: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      constructor(url: string) { this.url = url; }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    };

    fetchCurrentAgentMock.mockResolvedValue({
      agentAddress: 'agent-self',
      agentDid: 'did:dkg:agent:peer-self',
      name: 'Self',
      peerId: 'peer-self',
      nodeIdentityId: 'node-self',
    });
    fetchLocalAgentIntegrationsMock.mockResolvedValue({ integrations: [] });
    apiFetchContextGraphsMock.mockResolvedValue({
      contextGraphs: [
        // assetCount intentionally set to a non-zero value — the test
        // verifies the badge is gone regardless of underlying data.
        // callerInvolved short-circuits `belongsInMyProjectsSidebar`
        // so the CG appears in the "My Context Graphs" section without
        // needing an agent-identity resolve.
        { id: 'cg-1', name: 'My First CG', assetCount: 42, callerInvolved: true },
      ],
    });
  });

  async function renderPanel() {
    const { PanelLeft } = await import('../src/ui/components/Shell/PanelLeft.js');
    const { useJourneyStore } = await import('../src/ui/stores/journey.js');
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');
    const { useLayoutStore } = await import('../src/ui/stores/layout.js');
    // Reset stores between tests so prior toggles don't leak.
    act(() => {
      useJourneyStore.setState({ stage: 2 });
      useProjectsStore.setState({
        // `callerInvolved: true` short-circuits the My-CG membership
        // predicate (`belongsInMyProjectsSidebar`) without needing an
        // agent-identity resolve — keeps the test pure-DOM, no async.
        contextGraphs: [
          { id: 'cg-1', name: 'My First CG', assetCount: 42, callerInvolved: true } as any,
        ],
        loading: false,
        activeProjectId: null,
      });
      useLayoutStore.setState({
        leftSectionMyProjectsOpen: true,
        leftSectionIntegrationsOpen: false,
      });
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);
    await act(async () => {
      root.render(React.createElement(PanelLeft));
    });
    await flush();
    await flush();
    return { container, root };
  }

  it('does not render the in-panel ◂ collapse button (global header toggle is the sole control)', async () => {
    const { container } = await renderPanel();
    expect(container.querySelector('.v10-collapse-btn')).toBeNull();
    // And the unicode glyph isn't rendered anywhere else (it would
    // appear if a stray dev forgot to clean up the constant).
    expect(container.textContent || '').not.toContain('◂');
  });

  it('does not render entity-count badges next to context-graph rows', async () => {
    const { container } = await renderPanel();
    expect(container.querySelector('.v10-tree-section-badge')).toBeNull();
    // The row itself renders (it's the CG we seeded), so the absence
    // is not just "nothing rendered at all".
    expect(container.textContent).toContain('My First CG');
  });

  it('renders both section chevron headers with the v10-peer-group pattern', async () => {
    const { container } = await renderPanel();
    const headers = container.querySelectorAll('.v10-peer-group-header');
    expect(headers.length).toBe(2);
    const labels = Array.from(container.querySelectorAll('.v10-peer-group-label')).map((el) => el.textContent);
    expect(labels).toEqual(['My Context Graphs', 'Integrations']);
  });

  it('expands "My Context Graphs" by default and keeps "Integrations" collapsed', async () => {
    const { container } = await renderPanel();
    const headers = container.querySelectorAll('.v10-peer-group-header');
    const myCgHeader = headers[0] as HTMLButtonElement;
    const integrationsHeader = headers[1] as HTMLButtonElement;
    expect(myCgHeader.getAttribute('aria-expanded')).toBe('true');
    expect(integrationsHeader.getAttribute('aria-expanded')).toBe('false');
    // My CG body should be in the DOM (chevron expanded class + a row).
    expect(container.querySelector('.v10-peer-group-chevron.expanded')).toBeTruthy();
    expect(container.textContent).toContain('My First CG');
    // Integrations body should NOT be in the DOM (lazy mount).
    expect(container.textContent).not.toContain('Agents');
  });

  it('toggling a section updates the layout store and persists to localStorage', async () => {
    const { useLayoutStore } = await import('../src/ui/stores/layout.js');
    const { container } = await renderPanel();
    // Sanity: initial store state matches DOM.
    expect(useLayoutStore.getState().leftSectionMyProjectsOpen).toBe(true);
    expect(useLayoutStore.getState().leftSectionIntegrationsOpen).toBe(false);

    const headers = container.querySelectorAll('.v10-peer-group-header');
    await act(async () => {
      (headers[1] as HTMLButtonElement).click();
    });
    expect(useLayoutStore.getState().leftSectionIntegrationsOpen).toBe(true);
    // The persist() helper debounces with a 150ms setTimeout; wait it out
    // so the assertion sees the resolved write.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const persistedRaw = localStorage.getItem('dkg-layout');
    expect(persistedRaw).toBeTruthy();
    const persisted = JSON.parse(persistedRaw as string);
    expect(persisted.leftSectionIntegrationsOpen).toBe(true);
    expect(persisted.leftSectionMyProjectsOpen).toBe(true);
  });

  it('still renders the "My Context Graphs" header when the membership filter yields zero (with empty-body hint)', async () => {
    // qa-lead Pass 1 #2: at stage>=2 with CGs that all live in the
    // Context Oracle view (no callerInvolved match), the sidebar must
    // still surface the My CG header so the user has a visible anchor —
    // otherwise it shrinks to a lone collapsed "Integrations" toggle.
    const { PanelLeft } = await import('../src/ui/components/Shell/PanelLeft.js');
    const { useJourneyStore } = await import('../src/ui/stores/journey.js');
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');
    const { useLayoutStore } = await import('../src/ui/stores/layout.js');
    apiFetchContextGraphsMock.mockResolvedValue({
      contextGraphs: [{ id: 'cg-x', name: 'Catalog Only CG', callerInvolved: false } as any],
    });
    act(() => {
      useJourneyStore.setState({ stage: 2 });
      useProjectsStore.setState({
        contextGraphs: [{ id: 'cg-x', name: 'Catalog Only CG', callerInvolved: false } as any],
        loading: false,
        activeProjectId: null,
      });
      useLayoutStore.setState({
        leftSectionMyProjectsOpen: true,
        leftSectionIntegrationsOpen: false,
      });
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);
    await act(async () => {
      root.render(React.createElement(PanelLeft));
    });
    await flush();
    await flush();

    const labels = Array.from(container.querySelectorAll('.v10-peer-group-label')).map((el) => el.textContent);
    expect(labels).toContain('My Context Graphs');
    expect(container.textContent).toContain('No context graphs in this view yet.');
    // The catalog-only CG should NOT render as a row in this section.
    expect(container.textContent).not.toContain('Catalog Only CG');
  });

  it('section headers point at their body containers via aria-controls', async () => {
    const { container } = await renderPanel();
    const headers = container.querySelectorAll('.v10-peer-group-header');
    const myCgHeader = headers[0] as HTMLButtonElement;
    const integrationsHeader = headers[1] as HTMLButtonElement;
    const myCgControls = myCgHeader.getAttribute('aria-controls');
    const integrationsControls = integrationsHeader.getAttribute('aria-controls');
    expect(myCgControls).toBeTruthy();
    expect(integrationsControls).toBeTruthy();
    // The id pointed at by aria-controls of the (open) My CG header
    // must exist in the DOM. `useId()` returns ids shaped like ":r0:"
    // which aren't valid CSS selectors — use getElementById, not
    // querySelector (Codex).
    expect(document.getElementById(myCgControls!)).toBeTruthy();
    // Integrations is collapsed by default → its body is unmounted, so
    // the id is currently absent (aria-controls is still allowed to
    // reference a not-yet-rendered region per WAI-ARIA).
    expect(document.getElementById(integrationsControls!)).toBeNull();
  });

  it('opening Integrations triggers the local-integrations fetch; closing it halts further polls', async () => {
    // qa-lead Pass 2 #10 + Codex follow-up: validate the design claim
    // that `IntegrationsSectionBody` only polls while mounted by
    // actually advancing past the 30s setInterval after collapse.
    // `shouldAdvanceTime: true` lets microtask/render flushes still
    // resolve on real time, while explicit advanceTimersByTime jumps
    // the polling clock — so a leaked setInterval would visibly bump
    // the mock call count.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = await renderPanel();
      const headers = container.querySelectorAll('.v10-peer-group-header');
      const integrationsHeader = headers[1] as HTMLButtonElement;

      // Open Integrations — the body mounts and fires its first fetch.
      await act(async () => {
        integrationsHeader.click();
      });
      await flush();
      expect(fetchLocalAgentIntegrationsMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      const callsAfterOpen = fetchLocalAgentIntegrationsMock.mock.calls.length;

      // Close it — the body unmounts and React's effect cleanup should
      // clear the 30s setInterval.
      await act(async () => {
        integrationsHeader.click();
      });
      await flush();
      expect(container.textContent).not.toContain('Agents');

      // Advance past the polling interval. If cleanup leaked, the
      // setInterval callback would queue another loadLocal() and the
      // call count would bump. Mock-call counting is sync so no need
      // to flush microtasks for the assertion. NB: 31_000 sits BELOW
      // PanelLeft's separate `setInterval(loadCGs, 60_000)` (which calls
      // `fetchContextGraphs`, not `fetchLocalAgentIntegrations`, so the
      // mock we assert on would be unaffected even if it fired). Keep
      // this gap if either constant moves — the polling-halt cleanup
      // proof depends on advancing *just enough* to fire Integrations
      // polling but not the unrelated CG-list refresh.
      await act(async () => {
        vi.advanceTimersByTime(31_000);
      });
      expect(fetchLocalAgentIntegrationsMock.mock.calls.length).toBe(callsAfterOpen);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrates section open-state defaults when a pre-existing dkg-layout blob lacks the new fields', async () => {
    // Simulates an upgrade from before PR7: the user already has a
    // `dkg-layout` blob with the original fields but no
    // leftSectionMyProjectsOpen / leftSectionIntegrationsOpen. The
    // layout store's loadPersisted should backfill both with their
    // defaults (My CG open, Integrations closed) so the user doesn't
    // boot into a broken state.
    vi.resetModules();
    localStorage.setItem('dkg-layout', JSON.stringify({
      leftCollapsed: false,
      rightCollapsed: false,
      bottomCollapsed: true,
      leftWidth: 240,
      rightWidth: 360,
      bottomHeight: 200,
      // Intentionally NO leftSectionMyProjectsOpen / leftSectionIntegrationsOpen.
    }));
    const { useLayoutStore } = await import('../src/ui/stores/layout.js');
    expect(useLayoutStore.getState().leftSectionMyProjectsOpen).toBe(true);
    expect(useLayoutStore.getState().leftSectionIntegrationsOpen).toBe(false);
  });
});
