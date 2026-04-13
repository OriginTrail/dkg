import React, { Suspense } from 'react';
import { useTabsStore } from '../../stores/tabs.js';
import { DashboardView } from '../../views/DashboardView.js';
import { ProjectView } from '../../views/ProjectView.js';
import { MemoryLayerView } from '../../views/MemoryLayerView.js';

const CLOSE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const OperationsView = React.lazy(() =>
  import('../../pages/Operations.js').then((m) => ({ default: m.OperationsPage }))
);

const GameView = React.lazy(() =>
  import('../../pages/Apps.js').then((m) => ({ default: m.AppsPage }))
);

function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useTabsStore();

  return (
    <div className="v10-center-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={`v10-center-tab ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          <span className="v10-center-tab-label">{tab.label}</span>
          {tab.closable && (
            <span
              className="v10-center-tab-close"
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
            >
              {CLOSE_ICON}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function MemoryStackView() {
  return (
    <div style={{ maxWidth: 800, padding: '0' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>Memory Stack</h1>
      <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 24 }}>
        Aggregate view of all memory layers across your projects.
      </p>
      <div style={{ display: 'flex', gap: 12 }}>
        {(['Working Memory', 'Shared Working Memory', 'Verified Memory'] as const).map((label, i) => {
          const icons = ['◇', '◈', '◉'];
          const colors = ['var(--layer-working)', 'var(--layer-shared)', 'var(--layer-verified)'];
          return (
            <div key={label} style={{
              flex: 1, padding: '18px 16px', borderRadius: 10,
              border: '1px solid var(--border-default)', background: 'var(--bg-surface)',
            }}>
              <div style={{ fontSize: 18, color: colors[i], marginBottom: 8 }}>{icons[i]}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {i === 0 ? 'Private agent drafts' : i === 1 ? 'Shared proposals' : 'Published knowledge'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ViewContainer() {
  const activeTabId = useTabsStore((s) => s.activeTabId);

  if (activeTabId === 'dashboard') return <DashboardView />;

  if (activeTabId === 'operations') {
    return (
      <Suspense fallback={<div className="lazy-spinner">Loading operations...</div>}>
        <OperationsView />
      </Suspense>
    );
  }

  if (activeTabId === 'game') {
    return (
      <Suspense fallback={<div className="lazy-spinner">Loading game...</div>}>
        <GameView />
      </Suspense>
    );
  }

  if (activeTabId === 'memory-stack') return <MemoryStackView />;

  if (activeTabId.startsWith('project:')) {
    const cgId = activeTabId.slice('project:'.length);
    return <ProjectView contextGraphId={cgId} />;
  }

  if (activeTabId.startsWith('wm:')) {
    return <MemoryLayerView layer="wm" contextGraphId={activeTabId.slice(3)} />;
  }
  if (activeTabId.startsWith('swm:')) {
    return <MemoryLayerView layer="swm" contextGraphId={activeTabId.slice(4)} />;
  }
  if (activeTabId.startsWith('vm:')) {
    return <MemoryLayerView layer="vm" contextGraphId={activeTabId.slice(3)} />;
  }

  return (
    <div className="v10-view-placeholder">
      <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
        View "{activeTabId}" coming soon.
      </p>
    </div>
  );
}

export function PanelCenter() {
  return (
    <div className="v10-panel-center">
      <TabBar />
      <div className="v10-center-content">
        <ViewContainer />
      </div>
    </div>
  );
}
