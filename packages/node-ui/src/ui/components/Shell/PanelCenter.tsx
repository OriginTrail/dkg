import React, { Suspense, useState, useEffect } from 'react';
import { useTabsStore } from '../../stores/tabs.js';
import { DashboardView } from '../../views/DashboardView.js';
import { ProjectView } from '../../views/ProjectView.js';
import { ContextGraphPrimerView } from '../../views/ContextGraphPrimerView.js';
import { MemoryLayerView } from '../../views/MemoryLayerView.js';
import { MemoryStackView } from '../../views/MemoryStackView.js';
import { authHeaders, fileUrl } from '../../api.js';
import { DOC_TAB_PREFIX, decodeDocTabId } from '../../lib/doc-tab-id.js';
import { CONTEXT_GRAPH_PRIMER_TAB_ID } from '../../lib/contextGraphPrimer.js';
import { MarkdownMessage } from '../chat/MarkdownMessage.js';

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

const SettingsView = React.lazy(() =>
  import('../../pages/Settings.js').then((m) => ({ default: m.SettingsPage }))
);

const AgentProfilePage = React.lazy(() =>
  import('../AgentProfilePage.js').then((m) => ({ default: m.AgentProfilePage }))
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

const TEXT_CONTENT_TYPES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/x-yaml'];
function isTextContentType(ct: string) { return TEXT_CONTENT_TYPES.some(t => ct.startsWith(t)); }

// `expectedContentType` is the MIME the document list recorded for this file
// (from the tab-id encoding). It is a hint passed to the daemon so it serves
// the file inline with the right type; the authoritative type used for the
// render branches below is `contentType`, read from the fetch response
// headers. `docRef` is the full `urn:dkg:file:keccak256:<hex>` urn, or — when
// the document has no source file — the entity uri, which does not start with
// `urn:dkg:file:` and drives the "source not available" empty state.
function DocumentViewer({ docRef, contentType: expectedContentType }: { docRef: string; contentType: string }) {
  const { tabs, activeTabId, closeTab } = useTabsStore();
  const setActiveTab = useTabsStore(s => s.setActiveTab);
  const [content, setContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');

  const hasFileRef = docRef.startsWith('urn:dkg:file:');
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

    // No source file linked (docRef is the entity uri, not a file urn) —
    // skip the request entirely; the render shows the empty state.
    if (!hasFileRef) {
      setLoading(false);
      return;
    }

    // Strip only the `urn:dkg:file:` prefix so the algorithm-qualified
    // digest (`keccak256:<hex>`) survives. fileUrl() passes it through
    // unchanged and appends `?contentType=` so the daemon resolves the
    // keccak pointer and serves the file inline with the right MIME type.
    const fileHash = docRef.replace('urn:dkg:file:', '');
    const controller = new AbortController();

    fetch(fileUrl(fileHash, expectedContentType || undefined), { headers: authHeaders(), signal: controller.signal })
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
  }, [docRef, hasFileRef, expectedContentType]);

  // Each newly opened document starts in the documented default view
  // (Formatted). The toggle is per-document state, so it must reset when
  // the viewer switches to a different doc — otherwise opening doc B after
  // toggling doc A to Raw would surprise the user by showing B raw.
  useEffect(() => {
    setViewMode('formatted');
  }, [docRef]);

  useEffect(() => {
    const url = blobUrl;
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [blobUrl]);

  const isImage = contentType.startsWith('image/');
  const isPdf = contentType === 'application/pdf';
  // Treat the document as markdown when either the served response type or
  // the type recorded at import time says so — the daemon now returns the
  // correct `text/markdown` for these files, but fall back to the encoded
  // hint so the formatted view still engages if the header is generic.
  const isMarkdown =
    contentType.startsWith('text/markdown') ||
    expectedContentType.startsWith('text/markdown');
  const showToggle = !loading && !error && hasFileRef && isMarkdown && content !== null;

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
        {showToggle && (
          <div
            role="group"
            aria-label="Document view mode"
            style={{
              marginLeft: 'auto', display: 'flex', gap: 2, padding: 2,
              border: '1px solid var(--border-default)', borderRadius: 6,
              background: 'var(--bg-surface)',
            }}
          >
            {(['formatted', 'raw'] as const).map(mode => {
              const active = viewMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setViewMode(mode)}
                  style={{
                    border: 'none', borderRadius: 4, cursor: 'pointer',
                    padding: '3px 12px', fontSize: 11, fontWeight: 600,
                    fontFamily: 'var(--font-sans)',
                    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: active ? 'var(--bg-elevated)' : 'transparent',
                  }}
                >
                  {mode === 'formatted' ? 'Formatted' : 'Raw'}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        {!hasFileRef ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 10, height: '100%',
            color: 'var(--text-tertiary)', textAlign: 'center',
          }}>
            <span style={{ fontSize: 28, opacity: 0.6 }}>📄</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
              Source file not available for this document
            </span>
            <span style={{ fontSize: 12, maxWidth: 360, lineHeight: 1.6 }}>
              This document was indexed into the graph without a stored source
              file, so there is nothing to preview here. You can still explore
              its extracted entities and relationships in the graph.
            </span>
          </div>
        ) : (
          <>
            {loading && <div style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading document...</div>}
            {error && <div style={{ color: 'var(--accent-red)', fontSize: 12 }}>Failed to load: {error}</div>}
            {!loading && isImage && blobUrl && (
              <img src={blobUrl} alt={docLabel} style={{ maxWidth: '100%', borderRadius: 8 }} />
            )}
            {!loading && isPdf && blobUrl && (
              <iframe src={blobUrl} title={docLabel} style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8 }} />
            )}
            {content !== null && !isImage && !isPdf && isMarkdown && viewMode === 'formatted' && (
              <div style={{
                background: 'var(--bg-surface)', borderRadius: 8, padding: '16px 20px',
                border: '1px solid var(--border-default)', color: 'var(--text-primary)',
              }}>
                <MarkdownMessage content={content} />
              </div>
            )}
            {content !== null && !isImage && !isPdf && !(isMarkdown && viewMode === 'formatted') && (
              <pre style={{
                fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7,
                color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: 'var(--bg-surface)', borderRadius: 8, padding: 16,
                border: '1px solid var(--border-default)', margin: 0,
              }}>
                {content}
              </pre>
            )}
          </>
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

  if (activeTabId === 'settings') {
    return (
      <Suspense fallback={<div className="lazy-spinner">Loading settings...</div>}>
        <SettingsView />
      </Suspense>
    );
  }

  if (activeTabId === 'memory-stack') return <MemoryStackView />;

  if (activeTabId === CONTEXT_GRAPH_PRIMER_TAB_ID) return <ContextGraphPrimerView />;

  if (activeTabId.startsWith('project:')) {
    const cgId = activeTabId.slice('project:'.length);
    return <ProjectView contextGraphId={cgId} />;
  }

  if (activeTabId.startsWith('agent:')) {
    // Tab id shape: `agent:<projectId>|<agentSlug>`. The project part
    // scopes the profile to a single context graph's data; a future
    // "global agent profile" view could drop the prefix.
    const raw = activeTabId.slice('agent:'.length);
    const pipeIdx = raw.indexOf('|');
    if (pipeIdx > 0) {
      const cgId = raw.slice(0, pipeIdx);
      const agentSlug = raw.slice(pipeIdx + 1);
      const agentUri = agentSlug.includes(':') ? agentSlug : `urn:dkg:agent:${agentSlug}`;
      return (
        <Suspense fallback={<div className="lazy-spinner">Loading agent…</div>}>
          <AgentProfilePage contextGraphId={cgId} agentUri={agentUri} />
        </Suspense>
      );
    }
  }

  if (activeTabId.startsWith(DOC_TAB_PREFIX)) {
    // Tab id shape: `doc:<contextGraphId>|<docRef>|<contentType>`. The
    // encode/decode contract lives in doc-tab-id.ts (kept pure so it is
    // unit-testable without mounting React).
    const { docRef, contentType } = decodeDocTabId(activeTabId);
    return <DocumentViewer docRef={docRef} contentType={contentType} />;
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
