import React, { Suspense, useState, useEffect } from 'react';
import { useTabsStore } from '../../stores/tabs.js';
import { DashboardView } from '../../views/DashboardView.js';
import { ProjectView } from '../../views/ProjectView.js';
import { MemoryLayerView } from '../../views/MemoryLayerView.js';
import { authHeaders } from '../../api.js';

const CLOSE_ICON = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const OperationsView = React.lazy(() =>
  import('../../pages/Operations.js').then((m) => ({ default: m.OperationsPage }))
);

const AgentHubView = React.lazy(() =>
  import('../../pages/AgentHub.js').then((m) => ({ default: m.AgentHubPage }))
);

const GameView = React.lazy(() =>
  import('../../pages/Apps.js').then((m) => ({ default: m.AppsPage }))
);

const SettingsView = React.lazy(() =>
  import('../../pages/Settings.js').then((m) => ({ default: m.SettingsPage }))
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

const TEXT_CONTENT_TYPES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/x-yaml'];
function isTextContentType(ct: string) { return TEXT_CONTENT_TYPES.some(t => ct.startsWith(t)); }

function DocumentViewer({ docRef }: { docRef: string }) {
  const { tabs, activeTabId, closeTab } = useTabsStore();
  const setActiveTab = useTabsStore(s => s.setActiveTab);
  const [content, setContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentTab = tabs.find(t => t.id === activeTabId);
  const docLabel = currentTab?.label ?? 'Document';

  const handleBack = () => {
    const projectTab = tabs.find(t => t.id.startsWith('project:'));
    if (projectTab) {
      setActiveTab(projectTab.id);
    }
    closeTab(activeTabId);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    setBlobUrl(null);
    setContentType('');

    const fileHash = docRef.replace('urn:dkg:file:', '');
    const controller = new AbortController();

    fetch(`/api/file/${encodeURIComponent(fileHash)}`, { headers: authHeaders(), signal: controller.signal })
      .then(async res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get('content-type') ?? 'application/octet-stream';
        if (cancelled) return;
        setContentType(ct);

        if (isTextContentType(ct)) {
          const text = await res.text();
          if (!cancelled) { setContent(text); setLoading(false); }
        } else if (ct.startsWith('image/')) {
          const blob = await res.blob();
          if (!cancelled) { setBlobUrl(URL.createObjectURL(blob)); setLoading(false); }
        } else if (ct === 'application/pdf') {
          const blob = await res.blob();
          if (!cancelled) { setBlobUrl(URL.createObjectURL(blob)); setLoading(false); }
        } else {
          const text = await res.text();
          if (!cancelled) { setContent(text); setLoading(false); }
        }
      })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false); } });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [docRef]);

  useEffect(() => {
    const url = blobUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [blobUrl]);

  const isImage = contentType.startsWith('image/');
  const isPdf = contentType === 'application/pdf';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-panel)',
      }}>
        <button
          onClick={handleBack}
          style={{
            border: '1px solid var(--border-default)', borderRadius: 5, background: 'none',
            color: 'var(--text-secondary)', fontSize: 11, fontWeight: 600, padding: '4px 10px',
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}
        >
          ← Back to Project
        </button>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>📄 {docLabel}</span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        {loading && <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading document...</div>}
        {error && <div style={{ color: 'var(--accent-red)', fontSize: 12 }}>Failed to load: {error}</div>}
        {!loading && isImage && blobUrl && (
          <img src={blobUrl} alt={docLabel} style={{ maxWidth: '100%', borderRadius: 8 }} />
        )}
        {!loading && isPdf && blobUrl && (
          <iframe src={blobUrl} title={docLabel} style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8 }} />
        )}
        {content && !isImage && !isPdf && (
          <pre style={{
            fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7,
            color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'var(--bg-surface)', borderRadius: 8, padding: 16,
            border: '1px solid var(--border-default)', margin: 0,
          }}>
            {content}
          </pre>
        )}
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

  if (activeTabId === 'agent-hub') {
    return (
      <Suspense fallback={<div className="lazy-spinner">Loading agent hub...</div>}>
        <AgentHubView />
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

  if (activeTabId === 'settings') {
    return (
      <Suspense fallback={<div className="lazy-spinner">Loading settings...</div>}>
        <SettingsView />
      </Suspense>
    );
  }

  if (activeTabId === 'memory-stack') return <MemoryStackView />;

  if (activeTabId.startsWith('project:')) {
    const cgId = activeTabId.slice('project:'.length);
    return <ProjectView contextGraphId={cgId} />;
  }

  if (activeTabId.startsWith('doc:')) {
    const raw = activeTabId.slice(4);
    const lastColon = raw.lastIndexOf(':');
    const docRef = lastColon > 0 ? raw.slice(lastColon + 1) : raw;
    return <DocumentViewer docRef={docRef} />;
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
