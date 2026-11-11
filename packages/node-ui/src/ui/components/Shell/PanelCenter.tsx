import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createRecoverableLazyView } from './RecoverableLazyView.js';
import { useTabsStore } from '../../stores/tabs.js';
import { DashboardView } from '../../views/DashboardView.js';
import { ContextGraphPrimerView } from '../../views/ContextGraphPrimerView.js';
import { authHeaders, fileUrl } from '../../api.js';
import { decodeTabId, type LayerKey } from '../../lib/tab-target.js';
import { CONTEXT_GRAPH_PRIMER_TAB_ID } from '../../lib/contextGraphPrimer.js';
import { MarkdownMessage } from '../chat/MarkdownMessage.js';
import { TabBar } from './TabBar.js';
import { FileText } from 'lucide-react';
import { Breadcrumbs } from '../ds/Breadcrumbs.js';
import { useContextGraphCrumb } from '../../hooks/useContextGraphCrumb.js';
import { Loading } from '../ds/Loading.js';
import { MARKETPLACE_TABS } from '../../marketplace/tabs.js';


const OperationsView = createRecoverableLazyView(() =>
  import('../../pages/Operations.js').then((m) => m.OperationsPage)
, 'operations');


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
export function DocumentViewer({ docRef, contentType: expectedContentType, contextGraphId }: { docRef: string; contentType: string; contextGraphId?: string }) {
  const { tabs, activeTabId } = useTabsStore();
  const [content, setContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'formatted' | 'raw'>('formatted');

  const hasFileRef = docRef.startsWith('urn:dkg:file:');
  const currentTab = tabs.find(t => t.id === activeTabId);
  const docLabel = currentTab?.label ?? 'Document';

  const graph = useContextGraphCrumb(contextGraphId ?? '');

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
    <div className="v10-doc-view">
      <div className="v10-doc-bar">
        <Breadcrumbs items={[contextGraphId ? graph : { label: 'Context graph' }, { label: docLabel }]} />
        {showToggle && (
          <div
            role="group"
            aria-label="Document view mode"
            className="v10-doc-modes ds-seg"
          >
            {(['formatted', 'raw'] as const).map(mode => {
              const active = viewMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setViewMode(mode)}
                  className="ds-seg-item"
                >
                  {mode === 'formatted' ? 'Formatted' : 'Raw'}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="v10-doc-body">
        {!hasFileRef ? (
          <div className="v10-doc-empty">
            <FileText size={28} className="v10-doc-empty-icon" />
            <span className="v10-doc-empty-title">
              Source file not available for this document
            </span>
            <span className="v10-doc-empty-text">
              This document was indexed into the graph without a stored source
              file, so there is nothing to preview here. You can still explore
              its extracted entities and relationships in the graph.
            </span>
          </div>
        ) : (
          <>
            {loading && <Loading label="Loading document…" />}
            {error && <div className="v10-doc-error">Failed to load: {error}</div>}
            {!loading && isImage && blobUrl && (
              <img src={blobUrl} alt={docLabel} className="v10-doc-img" />
            )}
            {!loading && isPdf && blobUrl && (
              <iframe src={blobUrl} title={docLabel} className="v10-doc-frame" />
            )}
            {content !== null && !isImage && !isPdf && isMarkdown && viewMode === 'formatted' && (
              <div className="v10-doc-markdown">
                <MarkdownMessage content={content} />
              </div>
            )}
            {content !== null && !isImage && !isPdf && !(isMarkdown && viewMode === 'formatted') && (
              <pre className="v10-doc-source">
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
    case 'document': return <DocumentViewer docRef={target.docRef} contentType={target.contentType} contextGraphId={target.contextGraphId} />;
    case 'layer': return <LayerPage layer={target.layer} contextGraphId={target.contextGraphId} />;
    default: break;
  }

  return (
    <div className="v10-view-placeholder">
      <p className="v10-center-note">
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
    <main className="v10-panel-center">
      <TabBar />
      <div id="main-content" tabIndex={-1} ref={contentRef} className="v10-center-content v10-center-content-enter">
        <ViewContainer />
      </div>
    </main>
  );
}

const LAYER_NAMES: Record<LayerKey, string> = { wm: 'Working Memory', swm: 'Shared Working Memory', vm: 'Verifiable Memory' };

function LayerPage({ layer, contextGraphId }: { layer: LayerKey; contextGraphId: string }) {
  const graph = useContextGraphCrumb(contextGraphId);
  return (
    <>
      <div className="ds-crumbs-bar"><Breadcrumbs items={[graph, { label: LAYER_NAMES[layer] }]} /></div>
      <MemoryLayerView layer={layer} contextGraphId={contextGraphId} />
    </>
  );
}
