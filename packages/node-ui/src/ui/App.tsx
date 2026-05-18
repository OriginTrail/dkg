import React, { useEffect, useRef, useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Header } from './components/Shell/Header.js';
import { PanelLeft } from './components/Shell/PanelLeft.js';
import { PanelCenter } from './components/Shell/PanelCenter.js';
import { PanelBottom } from './components/Shell/PanelBottom.js';
import { PanelRight } from './components/Shell/PanelRight.js';
import { useLayoutStore, maxBottomHeight } from './stores/layout.js';
import { useAgentsStore } from './stores/agents.js';
import { api } from './api-wrapper.js';

function useLiveStatus() {
  const setNodeStatus = useAgentsStore((s) => s.setNodeStatus);
  useEffect(() => {
    let mounted = true;
    const poll = () => {
      api.fetchStatus().then((s) => { if (mounted) setNodeStatus(s); }).catch(() => {});
    };
    poll();
    const iv = setInterval(poll, 10_000);
    return () => { mounted = false; clearInterval(iv); };
  }, [setNodeStatus]);
}

function useKeyboardShortcuts() {
  const { toggleLeft, toggleRight, toggleBottom } = useLayoutStore();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'b') { e.preventDefault(); toggleLeft(); }
      if (mod && e.key === 'j') { e.preventDefault(); toggleBottom(); }
      if (mod && e.shiftKey && e.key === 'b') { e.preventDefault(); toggleRight(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleLeft, toggleRight, toggleBottom]);
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
  const handleRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef(onDrag);
  cbRef.current = onDrag;

  useEffect(() => {
    const handle = handleRef.current;
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
      // If the shell unmounts mid-drag, fully tear down: onMouseUp
      // removes the document mousemove/mouseup listeners and resets the
      // body cursor/user-select so the app can't get stuck in
      // row-resize still firing setBottomHeight (Codex).
      onMouseUp();
    };
  }, []);

  return handleRef;
}

function AppShell() {
  useLiveStatus();
  useKeyboardShortcuts();
  const { leftCollapsed, rightCollapsed, bottomCollapsed, theme, leftWidth, rightWidth, setLeftWidth, setRightWidth, setBottomHeight } = useLayoutStore();

  useEffect(() => {
    document.body.classList.toggle('light', theme === 'light');
  }, [theme]);

  // Keep the persisted bottom height within the current viewport: clamp
  // it into the store on mount and on window resize so the rendered
  // height AND the drag base (which reads the store) stay in sync — a
  // render-only clamp would leave the store holding a stale large value
  // and make the first shrink-drag feel stuck (Codex).
  useEffect(() => {
    const sync = () => setBottomHeight(Math.min(useLayoutStore.getState().bottomHeight, maxBottomHeight()));
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [setBottomHeight]);

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
  const onDragBottom = useCallback((delta: number) => {
    const h = useLayoutStore.getState().bottomHeight;
    setBottomHeight(Math.min(h - delta, maxBottomHeight()));
  }, [setBottomHeight]);

  const leftHandle = useDragResize(onDragLeft);
  const rightHandle = useDragResize(onDragRight);
  const bottomHandle = useDragResizeV(onDragBottom);

  return (
    <div className="v10-app">
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

export function App() {
  return (
    <Routes>
      <Route path="/network" element={
        <React.Suspense fallback={<div className="lazy-spinner">Loading...</div>}>
          <NetworkDebugPage />
        </React.Suspense>
      } />
      <Route path="/agent" element={<Navigate to="/" replace />} />
      <Route path="/explorer" element={<Navigate to="/" replace />} />
      <Route path="/settings" element={<Navigate to="/" replace />} />
      <Route path="/messages" element={<Navigate to="/" replace />} />
      {/* V9 installable apps framework was retired in V10 (see daemon 410 handler).
          Redirect stale bookmarks for /ui/apps/... back to the dashboard so upgraded
          nodes don't silently render AppShell under a dead URL. */}
      <Route path="/apps/*" element={<Navigate to="/" replace />} />
      <Route path="*" element={<AppShell />} />
    </Routes>
  );
}
