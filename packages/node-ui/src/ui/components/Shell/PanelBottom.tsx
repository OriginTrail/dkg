import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLayoutStore, maxBottomHeight, readPxVar } from '../../stores/layout.js';
import { api } from '../../api-wrapper.js';

const BOTTOM_TABS = ['Node Log', 'Transactions'] as const;
type BottomTab = typeof BOTTOM_TABS[number];

const CHEVRON_DOWN = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

function NodeLogContent() {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api.fetchNodeLog({ lines: 100, q: filter || undefined })
      .then(({ lines: l }: any) => setLines(l ?? []))
      .catch(() => {});
  }, [filter]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 5_000);
    return () => clearInterval(iv);
  }, [load]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines]);

  return (
    <div className="v10-log-container">
      <div className="v10-log-toolbar">
        <input
          type="text"
          placeholder="Filter logs..."
          className="v10-log-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="v10-log-output" ref={scrollRef}>
        {lines.map((line, i) => (
          <div key={i} className="v10-log-line">{line}</div>
        ))}
        {lines.length === 0 && (
          <div className="v10-log-line" style={{ color: 'var(--text-tertiary)' }}>No log output</div>
        )}
      </div>
    </div>
  );
}

export function PanelBottom() {
  const { bottomCollapsed, toggleBottom, bottomHeight } = useLayoutStore();
  const [activeTab, setActiveTab] = useState<BottomTab>('Node Log');
  // The tab-strip height lives in CSS (`--tab-h`); read it at runtime
  // so a CSS tweak can't silently break the floor below (Codex).
  const tabStripH = readPxVar('--tab-h', 36);

  return (
    <div
      className={`v10-panel-bottom ${bottomCollapsed ? 'collapsed' : ''}`}
      // Clamp against the viewport at render so a height persisted on a
      // taller screen can't crush the center pane after reload on a
      // shorter one; floor at the tab-strip height so the controls stay
      // reachable on very short viewports (Codex / ui-lead).
      style={bottomCollapsed ? undefined : { height: Math.max(tabStripH, Math.min(bottomHeight, maxBottomHeight())) }}
    >
      <div className="v10-bottom-tabs">
        {BOTTOM_TABS.map((tab) => (
          <button
            key={tab}
            className={`v10-bottom-tab ${tab === activeTab ? 'active' : ''}`}
            onClick={() => { setActiveTab(tab); if (bottomCollapsed) toggleBottom(); }}
          >
            {tab}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="v10-bottom-toggle" onClick={toggleBottom}>
          <span style={{ transform: bottomCollapsed ? 'rotate(180deg)' : 'none', display: 'flex', transition: 'transform 0.15s' }}>
            {CHEVRON_DOWN}
          </span>
        </button>
      </div>
      {!bottomCollapsed && (
        <div className="v10-bottom-content">
          {activeTab === 'Node Log' && <NodeLogContent />}
          {activeTab !== 'Node Log' && (
            <div style={{ padding: '12px 16px', color: 'var(--text-tertiary)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
              {activeTab} tab coming soon...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
