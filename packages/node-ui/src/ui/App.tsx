import React, { useEffect, useLayoutEffect, useRef, useCallback, useState, useSyncExternalStore } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Header } from './components/Shell/Header.js';
import { PanelLeft } from './components/Shell/PanelLeft.js';
import { PanelCenter } from './components/Shell/PanelCenter.js';
import { PanelBottom } from './components/Shell/PanelBottom.js';
import { PanelRight } from './components/Shell/PanelRight.js';
import { ContextGraphDialogs } from './components/Shell/ContextGraphDialogs.js';
import { useLayoutStore, useShellPanels, maxBottomHeight } from './stores/layout.js';
import { useTabsStore } from './stores/tabs.js';
import { chooseTab as openTab } from './lib/shellNavigation.js';
import { detectMockMode, isUsingMocks, subscribeMockMode } from './api-wrapper.js';
import { CONTEXT_GRAPH_PRIMER_TAB } from './lib/contextGraphPrimer.js';
import { applyTheme } from './lib/applyTheme.js';
import { useNodeStatusPolling } from './hooks/useNodeState.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useShellRouting } from './hooks/useShellRouting.js';
import { NodeUnavailableView } from './components/NodeUnavailableView.js';
import { ApiTokenPrompt } from './components/ApiTokenPrompt.js';
import { observabilityHref } from './lib/observabilityTab.js';
import { tabIdToPath } from './lib/tab-routes.js';

/**
 * Drag a resize handle along one axis. Every handle can mount after the
 * shell does (a collapsed bottom panel, side panels hidden on a narrow
 * screen), so the node is tracked in state through a callback ref and the
 * listener attaches whenever a handle appears.
 */
function useDragResize(onDrag: (delta: number) => void, axis: 'x' | 'y') {
  const cbRef = useRef(onDrag);
  cbRef.current = onDrag;
  const [handle, setHandle] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!handle) return;
    const pos = (e: MouseEvent) => (axis === 'x' ? e.clientX : e.clientY);
    let start = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = pos(e) - start;
      start = pos(e);
      cbRef.current(delta);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.classList.remove('active');
    };

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      start = pos(e);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      handle.classList.add('active');
    };

    handle.addEventListener('mousedown', onMouseDown);
    return () => {
      handle.removeEventListener('mousedown', onMouseDown);
      // A handle that unmounts mid-drag must not leave document listeners
      // or the body cursor behind.
      onMouseUp();
    };
  }, [handle, axis]);

  return useCallback((node: HTMLDivElement | null) => setHandle(node), []);
}

function AppShell() {
  useNodeStatusPolling();
  useKeyboardShortcuts();
  useShellRouting();
  const { bottomCollapsed, theme, leftWidth, rightWidth, setLeftWidth, setRightWidth, setBottomHeight } = useLayoutStore();
  const { narrow, leftOpen, rightOpen } = useShellPanels();
  const closeNarrowPanel = useLayoutStore((s) => s.closeNarrowPanel);
  // Resizing past the breakpoint shows the page, not a floating panel. Navigation does the
  // same in useShellRouting. The create and join dialogs belong to the shell
  // (ContextGraphDialogs), so closing the panel keeps them.
  const lastNarrow = useRef(narrow);
  useEffect(() => {
    if (lastNarrow.current === narrow) return; // only a crossing, not the first render
    lastNarrow.current = narrow;
    // Shows the page: closes a floating panel, and an expanded one does not carry over.
    useLayoutStore.getState().revealCentre();
  }, [narrow, closeNarrowPanel]);
  const [, setVpTick] = useState(0);

  useEffect(() => {
    // BUG-004: see applyTheme for why both <html> AND <body> need the
    // class. The helper lives in src/ui/lib/applyTheme so a unit test
    // can pin the contract without mounting AppShell.
    applyTheme(theme);
  }, [theme]);

  // Re-render on viewport resize so the render-time clamp in PanelBottom
  // and the drag base both recompute against the new maxBottomHeight().
  // We deliberately do NOT write a clamped value back into the store
  // here: persisting the shrunk height would destroy the user's
  // preferred panel size whenever the window is only temporarily
  // smaller, and it could never be restored on re-enlarge (Codex). The
  // unclamped preference stays in the store; only a user drag changes
  // it. Shrink-drag still isn't sticky because onDragBottom bases off
  // the clamped effective height, not the raw stored value.
  useEffect(() => {
    const onResize = () => setVpTick((t) => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => {
    const id = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    return () => window.cancelAnimationFrame(id);
  }, [leftOpen, rightOpen]);

  const onDragLeft = useCallback((delta: number) => {
    const w = useLayoutStore.getState().leftWidth;
    setLeftWidth(Math.max(140, Math.min(400, w + delta)));
  }, [setLeftWidth]);

  const onDragRight = useCallback((delta: number) => {
    const w = useLayoutStore.getState().rightWidth;
    setRightWidth(Math.max(200, Math.min(500, w - delta)));
  }, [setRightWidth]);

  // Handle sits above the bottom panel; dragging UP (negative delta)
  // makes the panel taller, so subtract the delta. Clamp to the
  // viewport-aware max so the center pane keeps its minimum height.
  // Base the drag off the *clamped effective* height (what the user
  // actually sees), not the raw stored preference — otherwise, when the
  // stored value exceeds the viewport max, the first shrink-drag has to
  // chew through the phantom off-screen height before the panel moves
  // (Codex). This write is a user-initiated change, so persisting it is
  // intended.
  const onDragBottom = useCallback((delta: number) => {
    const eff = Math.min(useLayoutStore.getState().bottomHeight, maxBottomHeight());
    setBottomHeight(Math.min(eff - delta, maxBottomHeight()));
  }, [setBottomHeight]);

  const rightExpanded = useLayoutStore((s) => s.rightExpanded);
  const expanded = rightExpanded && rightOpen && !narrow;

  const leftHandle = useDragResize(onDragLeft, 'x');
  const rightHandle = useDragResize(onDragRight, 'x');
  const bottomHandle = useDragResize(onDragBottom, 'y');

  return (
    <div className="v10-app">
      <ApiTokenPrompt />
      <nav aria-label="Skip link"><button type="button" className="ds-skip-link" onClick={() => document.getElementById(expanded ? 'agents-panel' : 'main-content')?.focus()}>Skip to content</button></nav>
      <Header />
      <ContextGraphDialogs />
      <div className="v10-app-body">
        {narrow && (leftOpen || rightOpen) && (
          <button type="button" className="v10-panel-scrim" aria-label="Close panel" onClick={closeNarrowPanel} />
        )}
        {/* A closed side panel unmounts, so its polling and listeners stop. What
            must outlive it lives in the shell: the context graph dialogs
            (ContextGraphDialogs) and agent conversations (stores/agentConversations). */}
        {leftOpen && (
          <>
            <div className="v10-panel-left" role="complementary" aria-label="Context graphs and node" style={{ width: leftWidth }}>
              <PanelLeft />
            </div>
            <div className="v10-resize-handle-h" ref={leftHandle} />
          </>
        )}

        <div className="v10-center-region" style={{ flex: 1, minWidth: 0, display: expanded ? 'none' : 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <PanelCenter />
          </div>
          {!bottomCollapsed && <div className="v10-resize-handle-v" ref={bottomHandle} />}
          <PanelBottom />
        </div>

        {rightOpen && (
          <>
            {!expanded && <div className="v10-resize-handle-h" ref={rightHandle} />}
            <div id="agents-panel" tabIndex={-1} className="v10-panel-right" role="complementary" aria-label="Agents" style={expanded ? { flex: 1, minWidth: 0 } : { width: rightWidth }}>
              <PanelRight />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Old address: Network is a tab in Observability now. The address opens the tab. */
function NetworkRoute() {
  return <Navigate to={observabilityHref('network')} replace />;
}

/** Old address: Agent hub is the right panel. AppShell opens it once it has mounted. */
function AgentHubRoute() {
  return <Navigate to={tabIdToPath(useTabsStore.getState().activeTabId)} replace state={{ openAgents: true }} />;
}

const MarketplaceGalleryRoute = React.lazy(() =>
  import('./marketplace/GalleryView.js').then((m) => ({ default: m.MarketplaceGalleryView }))
);

function ContextGraphPrimerRoute() {

  useLayoutEffect(() => {
    openTab(CONTEXT_GRAPH_PRIMER_TAB);
  }, [openTab]);

  // Legacy address: the primer tab now lives at /primer.
  return <Navigate to="/primer" replace />;
}

export function App() {
  const usingMocks = useSyncExternalStore(subscribeMockMode, isUsingMocks, isUsingMocks);
  useEffect(() => { void detectMockMode(); }, []);
  if (usingMocks) return <NodeUnavailableView />;

  return (
    <Routes>
      <Route path="/network" element={<NetworkRoute />} />
      <Route path="/agent-hub" element={<AgentHubRoute />} />
      <Route path="/context-graph-primer" element={<ContextGraphPrimerRoute />} />
      <Route path="/agent" element={<Navigate to="/" replace />} />
      <Route path="/explorer" element={<Navigate to="/" replace />} />
      <Route path="/messages" element={<Navigate to="/" replace />} />
      {/* V9 installable apps framework was retired in V10 (see daemon 410 handler).
          Redirect stale bookmarks for /ui/apps/... back to the dashboard so upgraded
          nodes don't silently render AppShell under a dead URL. */}
      <Route path="/apps/*" element={<Navigate to="/" replace />} />
      {/* Fixture-fed marketplace component gallery (never live data). */}
      <Route path="/dev/gallery" element={
        <React.Suspense fallback={<div className="lazy-spinner">Loading...</div>}>
          <MarketplaceGalleryRoute />
        </React.Suspense>
      } />
      <Route path="*" element={<AppShell />} />
    </Routes>
  );
}
