import React, { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Header } from './components/Shell/Header.js';
import { PanelLeft } from './components/Shell/PanelLeft.js';
import { PanelCenter } from './components/Shell/PanelCenter.js';
import { PanelBottom } from './components/Shell/PanelBottom.js';
import { PanelRight } from './components/Shell/PanelRight.js';
import { useLayoutStore, maxBottomHeight } from './stores/layout.js';
import { useAgentsStore } from './stores/agents.js';
import { useTabsStore } from './stores/tabs.js';
import { api } from './api-wrapper.js';
import {
  ensureDashboardSession,
  exchangeDashboardSession,
  getDashboardSession,
  isDashboardSessionReady,
  subscribeDashboardSession,
  type DashboardSessionStatus,
} from './dashboardSessionClient.js';
import { CONTEXT_GRAPH_PRIMER_TAB } from './lib/contextGraphPrimer.js';
import { applyTheme } from './lib/applyTheme.js';
import { useVisibilityPolling } from './hooks/useVisibilityPolling.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useShellRouting } from './hooks/useShellRouting.js';
import { MockModeBanner } from './components/MockModeBanner.js';

function useLiveStatus() {
  const setNodeStatus = useAgentsStore((s) => s.setNodeStatus);
  // Status was previously polled every 10s with a raw `setInterval`,
  // even when the tab was hidden — burning ~6 requests/minute against
  // the daemon for nothing. Route through the visibility-aware
  // helper so a backgrounded tab stops polling entirely (BUG-007).
  useVisibilityPolling(() => {
    api.fetchStatus().then(setNodeStatus).catch(() => {});
  }, 10_000);
}

function useDragResize(onDrag: (delta: number) => void) {
  const handleRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef(onDrag);
  cbRef.current = onDrag;

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;

    let startX = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      startX = e.clientX;
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
      startX = e.clientX;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      handle.classList.add('active');
    };

    handle.addEventListener('mousedown', onMouseDown);
    return () => handle.removeEventListener('mousedown', onMouseDown);
  }, []);

  return handleRef;
}

// Vertical twin of useDragResize for the bottom panel — tracks clientY
// and uses a row-resize cursor. Kept as a separate hook (rather than
// generalising useDragResize) to keep the horizontal path untouched.
function useDragResizeV(onDrag: (delta: number) => void) {
  const cbRef = useRef(onDrag);
  cbRef.current = onDrag;
  // The bottom handle only renders while the panel is expanded, and the
  // panel defaults to collapsed — so a one-shot useEffect([]) keyed on a
  // ref would bind to `null` on its only run and never re-bind when the
  // handle later appears, leaving it inert. Track the node in state and
  // key the effect on it so the listener (re)attaches whenever the
  // handle mounts/unmounts (Codex).
  const [handle, setHandle] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!handle) return;

    let startY = 0;

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - startY;
      startY = e.clientY;
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
      startY = e.clientY;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      handle.classList.add('active');
    };

    handle.addEventListener('mousedown', onMouseDown);
    return () => {
      handle.removeEventListener('mousedown', onMouseDown);
      // If the handle unmounts (panel collapsed) or the shell unmounts
      // mid-drag, fully tear down: onMouseUp removes the document
      // mousemove/mouseup listeners and resets the body cursor/
      // user-select so the app can't get stuck in row-resize still
      // firing setBottomHeight (Codex).
      onMouseUp();
    };
  }, [handle]);

  // Stable callback ref: React invokes it with the node on mount and
  // null on unmount, driving the effect above.
  return useCallback((node: HTMLDivElement | null) => setHandle(node), []);
}

function AppShell() {
  useLiveStatus();
  useKeyboardShortcuts();
  useShellRouting();
  const { leftCollapsed, rightCollapsed, bottomCollapsed, theme, leftWidth, rightWidth, setLeftWidth, setRightWidth, setBottomHeight } = useLayoutStore();
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
  }, [leftCollapsed, rightCollapsed]);

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

  const leftHandle = useDragResize(onDragLeft);
  const rightHandle = useDragResize(onDragRight);
  const bottomHandle = useDragResizeV(onDragBottom);

  return (
    <div className="v10-app">
      <MockModeBanner />
      <Header />
      <div className="v10-app-body">
        {!leftCollapsed && (
          <>
            <div className="v10-panel-left" style={{ width: leftWidth }}>
              <PanelLeft />
            </div>
            <div className="v10-resize-handle-h" ref={leftHandle} />
          </>
        )}

        <div className="v10-center-region" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <PanelCenter />
          </div>
          {!bottomCollapsed && <div className="v10-resize-handle-v" ref={bottomHandle} />}
          <PanelBottom />
        </div>

        {!rightCollapsed && (
          <>
            <div className="v10-resize-handle-h" ref={rightHandle} />
            <div className="v10-panel-right" style={{ width: rightWidth }}>
              <PanelRight />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const NetworkDebugPage = React.lazy(() =>
  import('./pages/Network.js').then((m) => ({ default: m.NetworkPage }))
);

function ContextGraphPrimerRoute() {
  const openTab = useTabsStore((s) => s.openTab);

  useLayoutEffect(() => {
    openTab(CONTEXT_GRAPH_PRIMER_TAB);
  }, [openTab]);

  return <Navigate to="/" replace />;
}

function DashboardUnlockForm() {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      await exchangeDashboardSession(trimmed);
      setToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dashboard unlock failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="v10-session-gate" data-testid="dashboard-session-unlock">
      <form className="v10-session-unlock" onSubmit={submit}>
        <div className="v10-session-unlock-copy">
          <h1>Unlock dashboard</h1>
          <p>Enter a node API token to open a dashboard session.</p>
        </div>
        <label className="v10-session-token-field">
          <span>API token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {error && <div className="v10-session-error" role="alert">{error}</div>}
        <button className="dkg-btn dkg-btn-solid" type="submit" disabled={submitting || token.trim().length === 0}>
          {submitting ? 'Unlocking...' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}

export function DashboardSessionGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<DashboardSessionStatus>(() => getDashboardSession());
  const [checking, setChecking] = useState(() => !isDashboardSessionReady(getDashboardSession()));

  useEffect(() => {
    let mounted = true;
    const unsubscribe = subscribeDashboardSession(() => {
      if (mounted) setSession(getDashboardSession());
    });
    void ensureDashboardSession().then((nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
    }).finally(() => {
      if (mounted) setChecking(false);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (checking && !isDashboardSessionReady(session)) {
    return (
      <div className="v10-session-gate">
        <div className="v10-session-unlock">
          <div className="v10-stat-loading">Checking session...</div>
        </div>
      </div>
    );
  }

  if (!isDashboardSessionReady(session)) return <DashboardUnlockForm />;

  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/network" element={
        <DashboardSessionGate>
          <React.Suspense fallback={<div className="lazy-spinner">Loading...</div>}>
            <NetworkDebugPage />
          </React.Suspense>
        </DashboardSessionGate>
      } />
      <Route path="/context-graph-primer" element={<ContextGraphPrimerRoute />} />
      <Route path="/agent" element={<Navigate to="/" replace />} />
      <Route path="/explorer" element={<Navigate to="/" replace />} />
      <Route path="/messages" element={<Navigate to="/" replace />} />
      {/* V9 installable apps framework was retired in V10 (see daemon 410 handler).
          Redirect stale bookmarks for /ui/apps/... back to the dashboard so upgraded
          nodes don't silently render AppShell under a dead URL. */}
      <Route path="/apps/*" element={<Navigate to="/" replace />} />
      <Route path="*" element={<DashboardSessionGate><AppShell /></DashboardSessionGate>} />
    </Routes>
  );
}
