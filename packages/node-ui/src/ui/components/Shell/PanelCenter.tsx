import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createRecoverableLazyView } from './RecoverableLazyView.js';
import { useTabsStore } from '../../stores/tabs.js';
import { DashboardView } from '../../views/DashboardView.js';
import { ContextGraphPrimerView } from '../../views/ContextGraphPrimerView.js';
import { authHeaders, fileUrl } from '../../api.js';
import { decodeTabId } from '../../lib/tab-target.js';
import { CONTEXT_GRAPH_PRIMER_TAB_ID } from '../../lib/contextGraphPrimer.js';
import { MarkdownMessage } from '../chat/MarkdownMessage.js';
import { TabBar } from './TabBar.js';
import { MARKETPLACE_TABS } from '../../marketplace/tabs.js';


const OperationsView = createRecoverableLazyView(() =>
  import('../../pages/Operations.js').then((m) => m.OperationsPage)
, 'operations');

const AgentHubView = createRecoverableLazyView(() =>
  import('../../pages/AgentHub.js').then((m) => m.AgentHubPage)
, 'agent hub');

const SettingsView = createRecoverableLazyView(() =>
  import('../../pages/Settings.js').then((m) => m.SettingsPage)
, 'settings');

const AgentProfilePage = createRecoverableLazyView(() =>
  import('../AgentProfilePage.js').then((m) => m.AgentProfilePage)
, 'account');

const PublishingConvictionView = createRecoverableLazyView(() =>
  import('../../pages/PublishingConviction.js').then((m) => m.PublishingConvictionPage)
, 'Publisher Conviction');

const ConvictionDetailView = createRecoverableLazyView(() =>
  import('../../pages/conviction/ConvictionDetailView.js').then((m) => m.ConvictionDetailView)
, 'account');

const ProjectView = createRecoverableLazyView(() =>
  import('../../views/ProjectView.js').then((m) => m.ProjectView)
, 'project');

const MemoryLayerView = createRecoverableLazyView(() =>
  import('../../views/MemoryLayerView.js').then((m) => m.MemoryLayerView)
, ({ layer }) => ({ wm: 'working memory', swm: 'shared memory', vm: 'verifiable memory' })[layer]);

const MarketplaceView = createRecoverableLazyView(() =>
  import('../../marketplace/views/MarketplaceView.js').then((m) => m.MarketplaceView)
, 'marketplace');

const MarketplacePlansView = createRecoverableLazyView(() =>
  import('../../marketplace/views/PlansView.js').then((m) => m.PlansView)
, 'marketplace plans');

const MarketplaceAccessView = createRecoverableLazyView(() =>
  import('../../marketplace/views/AccessView.js').then((m) => m.AccessView)
, 'marketplace access');

const MarketplaceOperateView = createRecoverableLazyView(() =>
  import('../../marketplace/views/OperateView.js').then((m) => m.OperateView)
, 'marketplace operate');

const MemoryStackView = createRecoverableLazyView(() =>
  import('../../views/MemoryStackView.js').then((m) => m.MemoryStackView)
, 'memory stack');


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
    const projectTab = tabs.find(t => decodeTabId(t.id).kind === 'graph');
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
            border: '1px solid var(--border-default)', borderRadius: 'var(--radius-control)', background: 'none',
            color: 'var(--text-secondary)', fontSize: 'var(--fs-label)', fontWeight: 600, padding: '4px 10px',
            cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}
        >
          ← Back to Project
        </button>
        <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'var(--text-primary)' }}>📄 {docLabel}</span>
        {showToggle && (
          <div
            role="group"
            aria-label="Document view mode"
            style={{
              marginLeft: 'auto', display: 'flex', gap: 2, padding: 2,
              border: '1px solid var(--border-default)', borderRadius: 'var(--radius-control)',
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
                    border: 'none', borderRadius: 'var(--radius-xs)', cursor: 'pointer',
                    padding: '3px 12px', fontSize: 'var(--fs-label)', fontWeight: 600,
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
            <span style={{ fontSize: 'var(--fs-display)', opacity: 0.6 }}>📄</span>
            <span style={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'var(--text-secondary)' }}>
              Source file not available for this document
            </span>
            <span style={{ fontSize: 'var(--fs-control)', maxWidth: 360, lineHeight: 1.6 }}>
              This document was indexed into the graph without a stored source
              file, so there is nothing to preview here. You can still explore
              its extracted entities and relationships in the graph.
            </span>
          </div>
        ) : (
          <>
            {loading && <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-control)' }}>Loading document...</div>}
            {error && <div style={{ color: 'var(--accent-red)', fontSize: 'var(--fs-control)' }}>Failed to load: {error}</div>}
            {!loading && isImage && blobUrl && (
              <img src={blobUrl} alt={docLabel} style={{ maxWidth: '100%', borderRadius: 'var(--radius-nested)' }} />
            )}
            {!loading && isPdf && blobUrl && (
              <iframe src={blobUrl} title={docLabel} style={{ width: '100%', height: '100%', border: 'none', borderRadius: 'var(--radius-nested)' }} />
            )}
            {content !== null && !isImage && !isPdf && isMarkdown && viewMode === 'formatted' && (
              <div style={{
                background: 'var(--bg-surface)', borderRadius: 'var(--radius-nested)', padding: '16px 20px',
                border: '1px solid var(--border-default)', color: 'var(--text-primary)',
              }}>
                <MarkdownMessage content={content} />
              </div>
            )}
            {content !== null && !isImage && !isPdf && !(isMarkdown && viewMode === 'formatted') && (
              <pre style={{
                fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-control)', lineHeight: 1.7,
                color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: 'var(--bg-surface)', borderRadius: 'var(--radius-nested)', padding: 16,
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

  if (activeTabId === MARKETPLACE_TABS.browse.id) return <MarketplaceView />;

  if (activeTabId === MARKETPLACE_TABS.plans.id) return <MarketplacePlansView />;

  if (activeTabId === MARKETPLACE_TABS.access.id) return <MarketplaceAccessView />;

  if (activeTabId === MARKETPLACE_TABS.operate.id) return <MarketplaceOperateView />;

  if (activeTabId === 'operations') {
    return <OperationsView />;
  }

  if (activeTabId === 'agent-hub') {
    return <AgentHubView />;
  }

  if (activeTabId === 'settings') {
    return <SettingsView />;
  }

  if (activeTabId === 'conviction') {
    return <PublishingConvictionView />;
  }

  if (activeTabId === 'memory-stack') return <MemoryStackView />;

  if (activeTabId === CONTEXT_GRAPH_PRIMER_TAB_ID) return <ContextGraphPrimerView />;

  const target = decodeTabId(activeTabId);
  switch (target.kind) {
    case 'graph': return <ProjectView contextGraphId={target.contextGraphId} />;
    case 'conviction': return <ConvictionDetailView accountId={target.accountId} />;
    // The graph part of an agent tab scopes the profile to one context graph's
    // data; a future "global agent profile" view could drop it.
    case 'agent': return <AgentProfilePage contextGraphId={target.contextGraphId} agentUri={target.agentUri} />;
    case 'document': return <DocumentViewer docRef={target.docRef} contentType={target.contentType} />;
    case 'layer': return <MemoryLayerView layer={target.layer} contextGraphId={target.contextGraphId} />;
    default: break;
  }

  return (
    <div className="v10-view-placeholder">
      <p style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-control)' }}>
        View "{activeTabId}" coming soon.
      </p>
    </div>
  );
}

/** Below this content width a view stacks. Media queries can't see the open side panels. */
const CENTER_NARROW_PX = 560;

export function PanelCenter() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    // Replaying the CSS animation on the existing DOM node keeps view state
    // intact. Keying this wrapper would remount data-heavy pages and reset
    // their local controls just to obtain a visual transition.
    content.classList.remove('v10-center-content-enter');
    void content.offsetWidth;
    content.classList.add('v10-center-content-enter');
  }, [activeTabId]);

  // Not a CSS container: that would trap the fixed drawers and dialogs inside this panel.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      el.toggleAttribute('data-narrow', entry.contentRect.width < CENTER_NARROW_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="v10-panel-center">
      <TabBar />
      <div ref={contentRef} className="v10-center-content v10-center-content-enter">
        <ViewContainer />
      </div>
    </div>
  );
}
