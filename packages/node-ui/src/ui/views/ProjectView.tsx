import React, { useMemo, useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { listJoinRequests, approveJoinRequest, rejectJoinRequest, listParticipants, listAssertions, promoteAssertion, publishSharedMemory, type PendingJoinRequest } from '../api.js';
import { ImportFilesModal } from '../components/Modals/ImportFilesModal.js';
import { ShareProjectModal } from '../components/Modals/ShareProjectModal.js';
import { useMemoryEntities, type TrustLevel, type MemoryEntity, type Triple } from '../hooks/useMemoryEntities.js';
import { useTabsStore } from '../stores/tabs.js';

const RdfGraph = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.RdfGraph }))
);

interface ProjectViewProps {
  contextGraphId: string;
}

type LayerView = 'overview' | 'wm' | 'swm' | 'vm';
type LayerContentTab = 'items' | 'assertions' | 'graph' | 'docs';

const TRUST_COLORS: Record<TrustLevel, string> = {
  verified: '#22c55e',
  shared: '#f59e0b',
  working: '#64748b',
};

const TYPE_LABELS: Record<string, { icon: string; group: string }> = {
  Person: { icon: '👤', group: 'People' },
  SoftwareApplication: { icon: '💻', group: 'Software' },
  SoftwareSourceCode: { icon: '📦', group: 'Code' },
  Organization: { icon: '🏢', group: 'Organizations' },
  Event: { icon: '📅', group: 'Events' },
  ChooseAction: { icon: '⚡', group: 'Decisions' },
  DefinedTerm: { icon: '📘', group: 'Concepts' },
  CreativeWork: { icon: '📄', group: 'Documents' },
  Product: { icon: '🪙', group: 'Products' },
  ConversationTurn: { icon: '💬', group: 'Conversations' },
  Thing: { icon: '◆', group: 'Other' },
};

function shortType(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

function shortPred(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  const raw = cut >= 0 ? uri.slice(cut + 1) : uri;
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

function entityMeta(e: MemoryEntity) {
  const primaryType = e.types[0] ? shortType(e.types[0]) : 'Entity';
  const info = TYPE_LABELS[primaryType] ?? TYPE_LABELS.Thing;
  return { ...info, type: primaryType };
}

function getDescription(e: MemoryEntity): string | null {
  const descPreds = ['http://schema.org/description', 'http://schema.org/text'];
  for (const p of descPreds) {
    const v = e.properties.get(p);
    if (v?.[0]) return v[0];
  }
  return null;
}

function neighborhoodTriples(entityUri: string, allTriples: Triple[], hops: number = 2): Triple[] {
  const visited = new Set<string>([entityUri]);
  let frontier = new Set<string>([entityUri]);

  for (let i = 0; i < hops; i++) {
    const nextFrontier = new Set<string>();
    for (const t of allTriples) {
      if (frontier.has(t.subject) && !visited.has(t.object)) {
        nextFrontier.add(t.object);
      }
      if (frontier.has(t.object) && !visited.has(t.subject)) {
        nextFrontier.add(t.subject);
      }
    }
    for (const u of nextFrontier) visited.add(u);
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  return allTriples.filter(t => visited.has(t.subject) || visited.has(t.object));
}

function matchesSearch(e: MemoryEntity, q: string): boolean {
  const lower = q.toLowerCase();
  if (e.label.toLowerCase().includes(lower)) return true;
  if (e.uri.toLowerCase().includes(lower)) return true;
  for (const t of e.types) if (shortType(t).toLowerCase().includes(lower)) return true;
  for (const [, vals] of e.properties) {
    for (const v of vals) if (v.toLowerCase().includes(lower)) return true;
  }
  for (const c of e.connections) if (c.targetLabel.toLowerCase().includes(lower)) return true;
  return false;
}

function humanizeLabel(entity: MemoryEntity | undefined, uri: string): string {
  if (entity) return entity.label;
  const slash = uri.lastIndexOf('/');
  const hash = uri.lastIndexOf('#');
  const cut = Math.max(slash, hash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

// ─── Layer Switcher Bar ──────────────────────────────────────

function LayerSwitcher({ active, counts, onSwitch, onShare, onImport, onRefresh }: {
  active: LayerView;
  counts: { wm: number; swm: number; vm: number; total: number };
  onSwitch: (v: LayerView) => void;
  onShare: () => void;
  onImport: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="v10-layer-switcher">
      <button
        className={`v10-layer-switch-btn ${active === 'overview' ? 'active' : ''}`}
        data-layer="overview"
        onClick={() => onSwitch('overview')}
      >
        <span className="v10-layer-switch-icon">◎</span> Overview
      </button>
      <button
        className={`v10-layer-switch-btn ${active === 'wm' ? 'active' : ''}`}
        data-layer="wm"
        onClick={() => onSwitch('wm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#64748b' }}>◇</span> Working Memory
        {counts.wm > 0 && <span className="v10-layer-switch-count">{counts.wm}</span>}
      </button>
      <button
        className={`v10-layer-switch-btn ${active === 'swm' ? 'active' : ''}`}
        data-layer="swm"
        onClick={() => onSwitch('swm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#f59e0b' }}>◈</span> Shared Memory
        {counts.swm > 0 && <span className="v10-layer-switch-count">{counts.swm}</span>}
      </button>
      <button
        className={`v10-layer-switch-btn ${active === 'vm' ? 'active' : ''}`}
        data-layer="vm"
        onClick={() => onSwitch('vm')}
      >
        <span className="v10-layer-switch-icon" style={{ color: '#22c55e' }}>◉</span> Verified Memory
        {counts.vm > 0 && <span className="v10-layer-switch-count">{counts.vm}</span>}
      </button>
      <div className="v10-layer-switcher-spacer" />
      <div className="v10-layer-switcher-actions">
        <button className="v10-layer-action-btn" onClick={onShare}>⤴ Share</button>
        <button className="v10-layer-action-btn" onClick={onImport}>↑ Import</button>
        <button className="v10-layer-action-btn" onClick={onRefresh}>↻</button>
      </div>
    </div>
  );
}

// ─── Project Overview Card ───────────────────────────────────

function ProjectOverviewCard({ cg, memory, participants }: {
  cg: any;
  memory: ReturnType<typeof useMemoryEntities>;
  participants: string[];
}) {
  const { wm: working, swm: shared, vm: verified } = memory.counts;
  const layerSum = working + shared + verified;
  const pctVm = layerSum > 0 ? Math.round((verified / layerSum) * 100) : 0;
  const pctSwm = layerSum > 0 ? Math.round((shared / layerSum) * 100) : 0;
  const pctWm = layerSum > 0 ? Math.max(0, 100 - pctVm - pctSwm) : 0;

  return (
    <div className="v10-po">
      <div className="v10-po-top">
        <span className="v10-po-dot" />
        <div>
          <div className="v10-po-title">{cg.name || cg.id}</div>
          {cg.description && <div className="v10-po-desc">{cg.description}</div>}
        </div>
      </div>
      <div className="v10-po-stats">
        <div className="v10-po-stat"><span className="v10-po-stat-val">{layerSum}</span><span className="v10-po-stat-label">Entities total</span></div>
        <div className="v10-po-stat"><span className="v10-po-stat-val">{working}</span><span className="v10-po-stat-label">in Working</span></div>
        <div className="v10-po-stat"><span className="v10-po-stat-val">{shared}</span><span className="v10-po-stat-label">in Shared</span></div>
        <div className="v10-po-stat"><span className="v10-po-stat-val">{verified}</span><span className="v10-po-stat-label">in Verified</span></div>
        <div className="v10-po-stat"><span className="v10-po-stat-val">{participants.length}</span><span className="v10-po-stat-label">participants</span></div>
      </div>
      {participants.length > 0 && (
        <div className="v10-po-participants">
          <div className="v10-po-participants-label">Participants</div>
          <div className="v10-po-participants-list">
            {participants.map(addr => (
              <span key={addr} className="v10-po-participant" title={addr}>
                <span className="v10-po-participant-dot" style={{ background: '#3b82f6' }} />
                {addr.slice(0, 6)}…{addr.slice(-4)}
              </span>
            ))}
          </div>
        </div>
      )}
      {layerSum > 0 && (
        <div className="v10-po-progress">
          <div className="v10-po-progress-label">
            <span>Knowledge Progress</span>
            <span style={{ color: '#22c55e', fontWeight: 600 }}>{pctVm}% verified</span>
          </div>
          <div className="v10-po-progress-bar">
            {pctVm > 0 && <div className="v10-po-progress-seg vm" style={{ width: `${pctVm}%` }} />}
            {pctSwm > 0 && <div className="v10-po-progress-seg swm" style={{ width: `${pctSwm}%` }} />}
            {pctWm > 0 && <div className="v10-po-progress-seg wm" style={{ width: `${pctWm}%` }} />}
          </div>
          <div className="v10-po-progress-legend">
            <span className="v10-po-legend-item"><span className="v10-po-legend-dot" style={{ background: '#22c55e' }} />Verified ({verified})</span>
            <span className="v10-po-legend-item"><span className="v10-po-legend-dot" style={{ background: '#f59e0b' }} />Shared ({shared})</span>
            <span className="v10-po-legend-item"><span className="v10-po-legend-dot" style={{ background: '#64748b' }} />Working ({working})</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Pending Join Requests ───────────────────────────────────

function PendingJoinRequestsBar({ contextGraphId, onParticipantsChanged }: { contextGraphId: string; onParticipantsChanged?: () => void }) {
  const [requests, setRequests] = useState<PendingJoinRequest[]>([]);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    listJoinRequests(contextGraphId)
      .then(data => setRequests(data.requests.filter(r => r.status === 'pending')))
      .catch(() => setRequests([]));
  }, [contextGraphId]);

  if (requests.length === 0) return null;

  const handleApprove = async (addr: string) => {
    setProcessing(addr);
    try {
      await approveJoinRequest(contextGraphId, addr);
      setRequests(prev => prev.filter(r => r.agentAddress !== addr));
      onParticipantsChanged?.();
    } catch { /* noop */ } finally { setProcessing(null); }
  };

  const handleReject = async (addr: string) => {
    setProcessing(addr);
    try {
      await rejectJoinRequest(contextGraphId, addr);
      setRequests(prev => prev.filter(r => r.agentAddress !== addr));
      onParticipantsChanged?.();
    } catch { /* noop */ } finally { setProcessing(null); }
  };

  return (
    <div className="v10-ph-join-requests" style={{ margin: '0 16px 8px', padding: '8px 12px', borderRadius: 8, background: 'var(--bg-surface)', border: '1px solid #f59e0b44' }}>
      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.8px', color: 'var(--text-ghost)', marginBottom: 6, display: 'block' }}>
        Pending Join Requests <span className="v10-ph-join-badge">{requests.length}</span>
      </span>
      <div className="v10-ph-join-list">
        {requests.map(req => (
          <div key={req.agentAddress} className="v10-ph-join-item">
            <div className="v10-ph-join-info">
              <span className="v10-ph-join-name">{req.name || `${req.agentAddress.slice(0, 6)}…${req.agentAddress.slice(-4)}`}</span>
              <span className="v10-ph-join-addr" title={req.agentAddress}>{req.agentAddress.slice(0, 10)}…</span>
            </div>
            <div className="v10-ph-join-actions">
              <button className="v10-ph-join-btn approve" onClick={() => handleApprove(req.agentAddress)} disabled={processing === req.agentAddress}>
                {processing === req.agentAddress ? '…' : '✓ Approve'}
              </button>
              <button className="v10-ph-join-btn reject" onClick={() => handleReject(req.agentAddress)} disabled={processing === req.agentAddress}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Memory Strip Graph (inline graph for expanded layer) ────

function MemoryStripGraph({ layerKey, memory }: {
  layerKey: 'wm' | 'swm' | 'vm';
  memory: ReturnType<typeof useMemoryEntities>;
}) {
  const targetLayer: TrustLevel = layerKey === 'vm' ? 'verified' : layerKey === 'swm' ? 'shared' : 'working';
  const color = layerKey === 'vm' ? '#22c55e' : layerKey === 'swm' ? '#f59e0b' : '#64748b';

  const triples = useMemo(() => {
    const seen = new Set<string>();
    return memory.allTriples
      .filter(t => t.layer === targetLayer)
      .filter(t => {
        const key = `${t.subject}|${t.predicate}|${t.object}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ subject, predicate, object }) => ({ subject, predicate, object }));
  }, [memory.allTriples, targetLayer]);

  const graphOptions = useMemo(() => ({
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: {
      predicates: ['http://schema.org/name', 'http://www.w3.org/2000/01/rdf-schema#label', 'http://purl.org/dc/terms/title'],
      minZoomForLabels: 0.3,
    },
    style: {
      defaultNodeColor: color,
      defaultEdgeColor: '#334155',
      edgeWidth: 0.7,
      fontSize: 16,
    },
    hexagon: { baseSize: 7, minSize: 5, maxSize: 10, scaleWithDegree: true },
    focus: { maxNodes: 2000, hops: 999 },
  }), [color]);

  if (triples.length === 0) {
    return (
      <div className="v10-graph-view" style={{ height: 300 }}>
        <span className="v10-graph-placeholder">No triples in this layer</span>
      </div>
    );
  }

  return (
    <div className="v10-graph-view" style={{ height: 300, position: 'relative' }}>
      <Suspense fallback={<span className="v10-graph-placeholder">Loading graph...</span>}>
        <RdfGraph
          data={triples}
          format="triples"
          options={graphOptions}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          initialFit
        />
      </Suspense>
    </div>
  );
}

// ─── Memory Strip (expandable layer rows) ────────────────────

function MemoryStrip({ memory, onSwitchLayer, onSelectEntity, contextGraphId }: {
  memory: ReturnType<typeof useMemoryEntities>;
  onSwitchLayer: (layer: LayerView) => void;
  onSelectEntity: (uri: string) => void;
  contextGraphId: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandTab, setExpandTab] = useState<Record<string, string>>({ wm: 'items', swm: 'items', vm: 'items' });

  const layerEntities = useMemo(() => {
    const wm: MemoryEntity[] = [];
    const swm: MemoryEntity[] = [];
    const vm: MemoryEntity[] = [];
    for (const e of memory.entityList) {
      if (e.trustLevel === 'verified') vm.push(e);
      else if (e.trustLevel === 'shared') swm.push(e);
      else wm.push(e);
    }
    return { wm, swm, vm };
  }, [memory.entityList]);

  const layerTripleCounts = useMemo(() => {
    let wm = 0, swm = 0, vm = 0;
    for (const t of memory.allTriples) {
      if (t.layer === 'verified') vm++;
      else if (t.layer === 'shared') swm++;
      else wm++;
    }
    return { wm, swm, vm };
  }, [memory.allTriples]);

  const toggleExpand = (layer: string) => {
    setExpanded(prev => prev === layer ? null : layer);
  };

  const layers: Array<{
    key: string;
    label: string;
    color: string;
    icon: string;
    entities: MemoryEntity[];
    promoteLabel: string | null;
    viewLayer: LayerView;
  }> = [
    { key: 'wm', label: 'Working Memory', color: '#64748b', icon: '◇', entities: layerEntities.wm, promoteLabel: 'Promote All → Shared', viewLayer: 'wm' },
    { key: 'swm', label: 'Shared Working Memory', color: '#f59e0b', icon: '◈', entities: layerEntities.swm, promoteLabel: 'Publish All → VM', viewLayer: 'swm' },
    { key: 'vm', label: 'Verified Memory', color: '#22c55e', icon: '◉', entities: layerEntities.vm, promoteLabel: null, viewLayer: 'vm' },
  ];

  return (
    <div className="v10-memory-strip">
      {layers.map(layer => {
        const isExpanded = expanded === layer.key;
        const activeTab = expandTab[layer.key] ?? 'items';
        return (
          <React.Fragment key={layer.key}>
            <div
              className={`v10-memory-layer ${layer.key} ${isExpanded ? 'expanded' : ''}`}
              onClick={() => toggleExpand(layer.key)}
            >
              <div className="v10-layer-label" style={{ color: layer.color }}>
                <span className="v10-layer-abbr">{layer.label}</span>
                <span className="v10-layer-count">{layer.entities.length}</span>
              </div>
              <div className="v10-layer-items">
                <span className="v10-layer-chevron">▸</span>
                {layer.entities.length === 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-ghost)', fontStyle: 'italic' }}>No assets yet</span>
                )}
                {layer.entities.slice(0, 6).map(e => {
                  const { icon } = entityMeta(e);
                  return (
                    <div key={e.uri} className="v10-layer-chip" style={{ borderColor: `${layer.color}40` }}>
                      <span className="v10-chip-dot" style={{ background: layer.color }} />
                      <span className="v10-chip-text">{e.label}</span>
                      <span className="v10-chip-meta">{icon}</span>
                    </div>
                  );
                })}
                {layer.entities.length > 6 && (
                  <span className="v10-chip-meta">+{layer.entities.length - 6} more</span>
                )}
              </div>
            </div>
            <div className={`v10-layer-expand-content ${isExpanded ? 'open' : ''}`}>
              <div className="v10-split-pane" style={{ minHeight: 0 }}>
                {/* Left: Canvas widgets */}
                <CanvasPanel
                  layer={layer.key as 'wm' | 'swm' | 'vm'}
                  entities={layer.entities}
                  tripleCount={layerTripleCounts[layer.key as 'wm' | 'swm' | 'vm']}
                  contextGraphId={contextGraphId}
                  onComplete={memory.refresh}
                />

                {/* Right: Content tabs */}
                <div className="v10-split-content">
                  <div className="v10-layer-expand-tabs">
                    <button
                      className={`v10-layer-expand-tab ${activeTab === 'items' ? 'active' : ''}`}
                      onClick={e => { e.stopPropagation(); setExpandTab(prev => ({ ...prev, [layer.key]: 'items' })); }}
                    >{layer.key === 'vm' ? 'Knowledge Assets' : 'Entities'}</button>
                    {layer.key !== 'vm' && (
                      <button
                        className={`v10-layer-expand-tab ${activeTab === 'assertions' ? 'active' : ''}`}
                        onClick={e => { e.stopPropagation(); setExpandTab(prev => ({ ...prev, [layer.key]: 'assertions' })); }}
                      >Assertions</button>
                    )}
                    <button
                      className={`v10-layer-expand-tab ${activeTab === 'graph' ? 'active' : ''}`}
                      onClick={e => { e.stopPropagation(); setExpandTab(prev => ({ ...prev, [layer.key]: 'graph' })); }}
                    >Graph</button>
                    <button
                      className={`v10-layer-expand-tab ${activeTab === 'docs' ? 'active' : ''}`}
                      onClick={e => { e.stopPropagation(); setExpandTab(prev => ({ ...prev, [layer.key]: 'docs' })); }}
                    >Documents</button>
                  </div>
                  {activeTab === 'assertions' && layer.key !== 'vm' && (
                    <AssertionsList contextGraphId={contextGraphId} layer={layer.key as 'wm' | 'swm'} onComplete={memory.refresh} />
                  )}
                  {activeTab === 'items' && (
                    <>
                      <div className="v10-layer-expand-items">
                        {layer.entities.slice(0, 10).map(e => {
                          const { icon, type } = entityMeta(e);
                          return (
                            <div key={e.uri} className="v10-item-row" style={{ cursor: 'pointer' }} onClick={(ev) => { ev.stopPropagation(); onSelectEntity(e.uri); }}>
                              <span className="v10-item-icon">{icon}</span>
                              <div className="v10-item-info">
                                <div className="v10-item-name">{e.label}</div>
                                <div className="v10-item-meta-row">
                                  <span className="v10-item-type">{type}</span>
                                  <span className="v10-item-count">· {e.connections.length + e.properties.size} triples</span>
                                </div>
                              </div>
                              <span className={`v10-trust-badge ${layer.key}`}>
                                {layer.icon} {layer.key === 'vm' ? 'Verified' : layer.key === 'swm' ? 'Shared' : 'Working'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      <div className="v10-layer-expand-footer">
                        <button className="v10-layer-expand-footer-btn" onClick={e => { e.stopPropagation(); onSwitchLayer(layer.viewLayer); }}>
                          View full layer →
                        </button>
                      </div>
                    </>
                  )}
                  {activeTab === 'graph' && (
                    <MemoryStripGraph layerKey={layer.key as 'wm' | 'swm' | 'vm'} memory={memory} />
                  )}
                  {activeTab === 'docs' && (
                    <div style={{ maxHeight: 300, overflow: 'auto' }}>
                      <DocumentsList entities={layer.entities} contextGraphId={contextGraphId} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ─── Generative Widget Components ─────────────────────────────

function GenWidget({ title, agent, footnote, dismissed, onDismiss, children }: {
  title: string;
  agent?: string;
  footnote?: string;
  dismissed?: boolean;
  onDismiss?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`v10-gen-widget ${dismissed ? 'dissolved' : ''}`}>
      <div className="v10-gen-widget-header">
        <span className="v10-gen-widget-title">{title}</span>
        <div className="v10-gen-widget-right">
          {agent && (
            <span className="v10-gen-widget-agent">
              <span className="v10-gen-widget-agent-dot" />
              {agent}
            </span>
          )}
          {onDismiss && (
            <button className="v10-gen-widget-dismiss" onClick={onDismiss}>✕</button>
          )}
        </div>
      </div>
      <div className="v10-gen-widget-body">{children}</div>
      {footnote && <div className="v10-gen-widget-footnote">{footnote}</div>}
    </div>
  );
}

function TypeBreakdownWidget({ entities }: { entities: MemoryEntity[] }) {
  const breakdown = useMemo(() => {
    const counts = new Map<string, { icon: string; count: number }>();
    for (const e of entities) {
      const { icon, type } = entityMeta(e);
      const existing = counts.get(type);
      if (existing) existing.count++;
      else counts.set(type, { icon, count: 1 });
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [entities]);

  if (breakdown.length === 0) return null;

  return (
    <GenWidget title="Entity Types">
      <div className="v10-layer-summary">
        {breakdown.map(([type, { icon, count }]) => (
          <div key={type} className="v10-layer-summary-stat">
            <span className="v10-layer-summary-label">{icon} {type}</span>
            <span className="v10-layer-summary-value">{count}</span>
          </div>
        ))}
      </div>
    </GenWidget>
  );
}

function LayerStatsWidget({ entities, triples, layer }: {
  entities: MemoryEntity[];
  triples: number;
  layer: 'wm' | 'swm' | 'vm';
}) {
  const docCount = useMemo(
    () => entities.filter(e => e.properties.has('http://dkg.io/ontology/sourceContentType')).length,
    [entities]
  );
  const totalConns = useMemo(
    () => entities.reduce((sum, e) => sum + e.connections.length, 0),
    [entities]
  );
  const avgConns = entities.length > 0 ? (totalConns / entities.length).toFixed(1) : '0';
  const layerConfig = {
    wm: { icon: '◇', color: '#64748b' },
    swm: { icon: '◈', color: '#f59e0b' },
    vm: { icon: '◉', color: '#22c55e' },
  }[layer];

  return (
    <GenWidget title="Layer Stats">
      <div className="v10-layer-summary">
        <div className="v10-layer-summary-stat">
          <span className="v10-layer-summary-label">Knowledge Assets</span>
          <span className="v10-layer-summary-value">{entities.length}</span>
        </div>
        <div className="v10-layer-summary-stat">
          <span className="v10-layer-summary-label">Triples</span>
          <span className="v10-layer-summary-value">{triples}</span>
        </div>
        <div className="v10-layer-summary-stat">
          <span className="v10-layer-summary-label">Connections</span>
          <span className="v10-layer-summary-value">{totalConns}</span>
        </div>
        <div className="v10-layer-summary-stat">
          <span className="v10-layer-summary-label">Avg. connections / entity</span>
          <span className="v10-layer-summary-value">{avgConns}</span>
        </div>
        {docCount > 0 && (
          <div className="v10-layer-summary-stat">
            <span className="v10-layer-summary-label">📄 Documents</span>
            <span className="v10-layer-summary-value">{docCount}</span>
          </div>
        )}
        <div className="v10-layer-summary-bar">
          <div className="v10-layer-summary-bar-fill" style={{ width: '100%', background: layerConfig.color }} />
        </div>
      </div>
    </GenWidget>
  );
}

function LayerActionsWidget({ layer, count, contextGraphId, onComplete }: {
  layer: 'wm' | 'swm';
  count: number;
  contextGraphId: string;
  onComplete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isWm = layer === 'wm';

  const handleAction = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (isWm) {
        const assertions = await listAssertions(contextGraphId);
        let promoted = 0;
        for (const a of assertions) {
          const res = await promoteAssertion(contextGraphId, a.name);
          promoted += res.promotedCount;
        }
        setResult(`Promoted ${promoted} triple${promoted !== 1 ? 's' : ''} to Shared Memory`);
      } else {
        await publishSharedMemory(contextGraphId);
        setResult('Published to Verified Memory');
      }
      onComplete?.();
    } catch (err: any) {
      setError(err.message ?? 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [isWm, contextGraphId, onComplete]);

  if (count === 0) return null;
  const color = isWm ? '#f59e0b' : '#22c55e';
  const target = isWm ? 'Shared Memory' : 'Verified Memory';

  return (
    <GenWidget title={isWm ? 'Promote' : 'Publish'} footnote={`Moves assets from this layer to ${target}.`}>
      <div className="v10-decision-context" style={{ marginBottom: 10 }}>
        {count} asset{count !== 1 ? 's' : ''} in this layer can be {isWm ? 'promoted to Shared Memory for collaborative review' : 'published to Verified Memory on-chain'}.
      </div>
      {result && <div style={{ fontSize: 11, color: 'var(--accent-green)', marginBottom: 8 }}>✓ {result}</div>}
      {error && <div style={{ fontSize: 11, color: 'var(--accent-red)', marginBottom: 8 }}>✕ {error}</div>}
      <div className="v10-decision-actions">
        <button
          className="v10-decision-btn approve"
          style={{ borderColor: `${color}50`, color, background: `${color}15`, opacity: busy ? 0.5 : 1 }}
          disabled={busy}
          onClick={handleAction}
        >
          {busy ? '...' : `✓ ${isWm ? 'Promote All → Shared' : 'Publish All → VM'}`}
        </button>
      </div>
    </GenWidget>
  );
}

function CanvasPanel({ layer, entities, tripleCount, contextGraphId, onComplete }: {
  layer: 'wm' | 'swm' | 'vm';
  entities: MemoryEntity[];
  tripleCount: number;
  contextGraphId?: string;
  onComplete?: () => void;
}) {
  return (
    <div className="v10-split-canvas">
      <LayerStatsWidget entities={entities} triples={tripleCount} layer={layer} />
      <TypeBreakdownWidget entities={entities} />
      {(layer === 'wm' || layer === 'swm') && (
        <LayerActionsWidget layer={layer} count={entities.length} contextGraphId={contextGraphId} onComplete={onComplete} />
      )}
      {entities.length === 0 && (
        <div className="v10-canvas-empty">
          <div className="v10-canvas-empty-icon">⬡</div>
          <div className="v10-canvas-empty-text">
            Import data or chat with agents to populate this layer.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Assertions List (WM/SWM named graphs) ──────────────────

function AssertionsList({ contextGraphId, layer, onComplete }: {
  contextGraphId: string;
  layer: 'wm' | 'swm';
  onComplete: () => void;
}) {
  const { data: assertions, loading, refresh } = useFetch(
    () => listAssertions(contextGraphId),
    [contextGraphId],
    0
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePromote = useCallback(async (name: string) => {
    setBusy(name);
    setResult(null);
    setError(null);
    try {
      if (layer === 'wm') {
        const res = await promoteAssertion(contextGraphId, name);
        setResult(`Promoted ${res.promotedCount} triples to Shared Memory`);
      } else {
        await publishSharedMemory(contextGraphId);
        setResult('Published to Verified Memory');
      }
      refresh();
      onComplete();
    } catch (err: any) {
      setError(err.message ?? 'Action failed');
    } finally {
      setBusy(null);
    }
  }, [contextGraphId, layer, refresh, onComplete]);

  const handlePromoteAll = useCallback(async () => {
    if (!assertions?.length) return;
    setBusy('__all__');
    setResult(null);
    setError(null);
    try {
      if (layer === 'wm') {
        let total = 0;
        for (const a of assertions) {
          const res = await promoteAssertion(contextGraphId, a.name);
          total += res.promotedCount;
        }
        setResult(`Promoted ${total} triples across ${assertions.length} assertion${assertions.length !== 1 ? 's' : ''}`);
      } else {
        await publishSharedMemory(contextGraphId);
        setResult('Published all to Verified Memory');
      }
      refresh();
      onComplete();
    } catch (err: any) {
      setError(err.message ?? 'Action failed');
    } finally {
      setBusy(null);
    }
  }, [assertions, contextGraphId, layer, refresh, onComplete]);

  if (loading) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-ghost)', fontSize: 12 }}>Loading assertions...</div>;
  }

  if (!assertions?.length) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-ghost)', fontSize: 12 }}>No assertions in this layer</div>;
  }

  const actionLabel = layer === 'wm' ? 'Promote → Shared' : 'Publish → VM';
  const actionAllLabel = layer === 'wm' ? 'Promote All → Shared' : 'Publish All → VM';

  return (
    <div style={{ flex: 1, overflow: 'auto' }}>
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{assertions.length} assertion{assertions.length !== 1 ? 's' : ''}</span>
        <button
          className={`v10-layer-expand-footer-btn ${layer === 'wm' ? 'promote' : 'publish'}`}
          disabled={busy !== null}
          onClick={handlePromoteAll}
          style={{ opacity: busy === '__all__' ? 0.5 : 1 }}
        >
          {busy === '__all__' ? '...' : actionAllLabel}
        </button>
      </div>
      {result && <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--accent-green)' }}>✓ {result}</div>}
      {error && <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--accent-red)' }}>✕ {error}</div>}
      {assertions.map(a => (
        <div key={a.name} className="v10-item-row">
          <span className="v10-item-icon">▤</span>
          <div className="v10-item-info">
            <div className="v10-item-name" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{a.name}</div>
            <div className="v10-item-meta-row">
              {a.tripleCount != null && <span className="v10-item-count">{a.tripleCount} triples</span>}
            </div>
          </div>
          <button
            className={`v10-layer-expand-footer-btn ${layer === 'wm' ? 'promote' : 'publish'}`}
            disabled={busy !== null}
            onClick={ev => { ev.stopPropagation(); handlePromote(a.name); }}
            style={{ opacity: busy === a.name ? 0.5 : 1, flexShrink: 0 }}
          >
            {busy === a.name ? '...' : actionLabel}
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Full Layer Detail View (WM / SWM / VM) ─────────────────

function LayerDetailView({ layer, memory, nodeColors, onNodeClick, onSelectEntity, contextGraphId }: {
  layer: 'wm' | 'swm' | 'vm';
  memory: ReturnType<typeof useMemoryEntities>;
  nodeColors: Record<string, string>;
  onNodeClick: (node: any) => void;
  onSelectEntity: (uri: string) => void;
  contextGraphId: string;
}) {
  const [contentTab, setContentTab] = useState<LayerContentTab>('items');

  const config = {
    wm: { icon: '◇', title: 'Working Memory', desc: 'Private agent scratchpad — ephemeral, fast local storage', color: '#64748b', actionLabel: 'Promote All → Shared', actionClass: 'promote' },
    swm: { icon: '◈', title: 'Shared Working Memory', desc: 'Team workspace — shared proposals, TTL-bounded', color: '#f59e0b', actionLabel: 'Publish All → VM', actionClass: 'primary' },
    vm: { icon: '◉', title: 'Verified Memory', desc: 'Endorsed, published, on-chain knowledge', color: '#22c55e', actionLabel: null, actionClass: '' },
  }[layer];

  const entities = useMemo(() => {
    return memory.entityList.filter(e => {
      if (layer === 'vm') return e.trustLevel === 'verified';
      if (layer === 'swm') return e.trustLevel === 'shared';
      return e.trustLevel === 'working';
    });
  }, [memory.entityList, layer]);

  const layerTriples = useMemo(() => {
    const targetLayer: TrustLevel = layer === 'vm' ? 'verified' : layer === 'swm' ? 'shared' : 'working';
    const seen = new Set<string>();
    return memory.allTriples
      .filter(t => t.layer === targetLayer)
      .filter(t => {
        const key = `${t.subject}|${t.predicate}|${t.object}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ subject, predicate, object }) => ({ subject, predicate, object }));
  }, [memory.allTriples, layer]);

  const graphOptions = useMemo(() => ({
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: {
      predicates: ['http://schema.org/name', 'http://www.w3.org/2000/01/rdf-schema#label', 'http://purl.org/dc/terms/title'],
      minZoomForLabels: 0.3,
    },
    style: {
      nodeColors,
      defaultNodeColor: config.color,
      defaultEdgeColor: '#334155',
      edgeWidth: 0.7,
      fontSize: 16,
    },
    hexagon: { baseSize: 7, minSize: 5, maxSize: 10, scaleWithDegree: true },
    focus: { maxNodes: 3000, hops: 999 },
  }), [nodeColors, config.color]);

  return (
    <div className="v10-layer-detail">
      <div className="v10-split-pane">
        {/* Left: Generative Canvas */}
        <CanvasPanel layer={layer} entities={entities} tripleCount={layerTriples.length} contextGraphId={contextGraphId} onComplete={memory.refresh} />

        {/* Right: Content Tabs */}
        <div className="v10-split-content">
          <div className="v10-content-tabs">
            <button className={`v10-content-tab ${contentTab === 'items' ? 'active' : ''}`} onClick={() => setContentTab('items')}>
              <span className="v10-content-tab-icon">◈</span> {layer === 'vm' ? 'Knowledge Assets' : 'Entities'}
            </button>
            {layer !== 'vm' && (
              <button className={`v10-content-tab ${contentTab === 'assertions' ? 'active' : ''}`} onClick={() => setContentTab('assertions')}>
                <span className="v10-content-tab-icon">▤</span> Assertions
              </button>
            )}
            <button className={`v10-content-tab ${contentTab === 'graph' ? 'active' : ''}`} onClick={() => setContentTab('graph')}>
              <span className="v10-content-tab-icon">⬡</span> Graph
            </button>
            <button className={`v10-content-tab ${contentTab === 'docs' ? 'active' : ''}`} onClick={() => setContentTab('docs')}>
              <span className="v10-content-tab-icon">📄</span> Documents
            </button>
          </div>

          {contentTab === 'items' && (
            <>
              <div className="v10-layer-detail-header">
                <span className="v10-layer-detail-icon" style={{ color: config.color }}>{config.icon}</span>
                <div>
                  <div className="v10-layer-detail-title">{config.title}</div>
                  <div className="v10-layer-detail-desc">{config.desc}</div>
                </div>
                <div className="v10-layer-detail-actions" />
              </div>
              <div className="v10-layer-detail-content">
                <div className="v10-items-list">
                  {entities.map(e => {
                    const { icon, type } = entityMeta(e);
                    return (
                      <div key={e.uri} className="v10-item-row" style={{ cursor: 'pointer' }} onClick={() => onSelectEntity(e.uri)}>
                        <span className="v10-item-icon">{icon}</span>
                        <div className="v10-item-info">
                          <div className="v10-item-name">{e.label}</div>
                          <div className="v10-item-ual">{e.uri}</div>
                          <div className="v10-item-meta-row">
                            <span className="v10-item-type">{type}</span>
                            <span className="v10-item-count">· {e.connections.length + e.properties.size} triples</span>
                          </div>
                        </div>
                        <span className={`v10-trust-badge ${layer}`}>
                          {config.icon} {layer === 'vm' ? 'Verified' : layer === 'swm' ? 'Shared' : 'Working'}
                        </span>
                      </div>
                    );
                  })}
                  {entities.length === 0 && (
                    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-ghost)', fontSize: 12 }}>
                      No entities in {config.title}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {contentTab === 'assertions' && layer !== 'vm' && (
            <AssertionsList contextGraphId={contextGraphId} layer={layer} onComplete={memory.refresh} />
          )}

          {contentTab === 'graph' && (
            <div className="v10-graph-view" style={{ flex: 1, position: 'relative' }}>
              {layerTriples.length > 0 ? (
                <Suspense fallback={<span className="v10-graph-placeholder">Loading graph...</span>}>
                  <RdfGraph
                    data={layerTriples}
                    format="triples"
                    options={graphOptions}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                    onNodeClick={onNodeClick}
                    initialFit
                  />
                </Suspense>
              ) : (
                <span className="v10-graph-placeholder">No data to graph in {config.title}</span>
              )}
            </div>
          )}

          {contentTab === 'docs' && (
            <DocumentsList entities={entities} contextGraphId={contextGraphId} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Documents List ──────────────────────────────────────────

const SOURCE_CONTENT_TYPE = 'http://dkg.io/ontology/sourceContentType';
const MARKDOWN_FORM = 'http://dkg.io/ontology/markdownForm';
const SOURCE_FILE = 'http://dkg.io/ontology/sourceFile';
const DKG_SIZE = 'http://dkg.io/ontology/size';

function DocumentsList({ entities, contextGraphId }: { entities: MemoryEntity[]; contextGraphId?: string }) {
  const openTab = useTabsStore(s => s.openTab);

  const docs = useMemo(() => {
    return entities.filter(e => e.properties.has(SOURCE_CONTENT_TYPE));
  }, [entities]);

  const handleOpenDoc = (e: MemoryEntity) => {
    const fileRef = e.connections.find(c => c.predicate === MARKDOWN_FORM || c.predicate === SOURCE_FILE)?.targetUri;
    const fileHash = fileRef?.replace('urn:dkg:file:', '') ?? '';
    const scope = contextGraphId ? `${contextGraphId}:` : '';
    openTab({
      id: `doc:${scope}${fileHash || e.uri}`,
      label: e.label,
      closable: true,
      icon: '📄',
    });
  };

  if (docs.length === 0) {
    return (
      <div className="v10-docs-placeholder" style={{ flex: 1 }}>
        No documents in this layer. Import a file to get started.
      </div>
    );
  }

  return (
    <div className="v10-layer-detail-content">
      <div className="v10-items-list">
        {docs.map(e => {
          const contentType = e.properties.get(SOURCE_CONTENT_TYPE)?.[0] ?? '';
          const fileRef = e.connections.find(c => c.predicate === MARKDOWN_FORM || c.predicate === SOURCE_FILE)?.targetUri;
          const fileEntity = fileRef ? entities.find(f => f.uri === fileRef) : undefined;
          const size = fileEntity?.properties.get(DKG_SIZE)?.[0] ?? e.properties.get(DKG_SIZE)?.[0];
          return (
            <div key={e.uri} className="v10-item-row" onClick={() => handleOpenDoc(e)}>
              <span className="v10-item-icon">📄</span>
              <div className="v10-item-info">
                <div className="v10-item-name">{e.label}</div>
                <div className="v10-item-meta-row">
                  {contentType && <span className="v10-item-type">{contentType}</span>}
                  {size && <span className="v10-item-count">· {Math.round(parseInt(size) / 1024)}KB</span>}
                </div>
              </div>
              <button className="v10-item-promote-btn" onClick={ev => { ev.stopPropagation(); handleOpenDoc(e); }}>Open →</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Provenance Bar ──────────────────────────────────────────

function ProvenanceBar({ memory }: { memory: ReturnType<typeof useMemoryEntities> }) {
  const latestEvent = useMemo(() => {
    if (memory.counts.vm > 0) return `${memory.counts.vm} knowledge assets verified on-chain`;
    if (memory.counts.swm > 0) return `${memory.counts.swm} assets in shared memory`;
    if (memory.counts.wm > 0) return `${memory.counts.wm} drafts in working memory`;
    return 'No activity yet';
  }, [memory.counts]);

  return (
    <div className="v10-provenance-bar">
      <span className="v10-provenance-bar-dot" />
      <span>{latestEvent}</span>
    </div>
  );
}

// ─── KA Detail View (split-pane: content+triples+graph | provenance) ─────

type KAPane = 'content' | 'triples' | 'graph';

function KADetailView({ entity, allEntities, allTriples, onNavigate, onClose }: {
  entity: MemoryEntity;
  allEntities: Map<string, MemoryEntity>;
  allTriples: Triple[];
  onNavigate: (uri: string) => void;
  onClose: () => void;
}) {
  const [pane, setPane] = useState<KAPane>('content');
  const { icon, type } = entityMeta(entity);
  const desc = getDescription(entity);
  const layerBadge = entity.trustLevel === 'verified' ? 'vm' : entity.trustLevel === 'shared' ? 'swm' : 'wm';
  const layerLabel = entity.trustLevel === 'verified' ? 'Verified Memory' : entity.trustLevel === 'shared' ? 'Shared Working Memory' : 'Working Memory';

  const incoming = useMemo(() => {
    const result: Array<{ pred: string; entity: MemoryEntity }> = [];
    for (const [, other] of allEntities) {
      for (const conn of other.connections) {
        if (conn.targetUri === entity.uri) {
          result.push({ pred: shortPred(conn.predicate), entity: other });
        }
      }
    }
    return result;
  }, [entity.uri, allEntities]);

  const entityTriples = useMemo(
    () => allTriples.filter(t => t.subject === entity.uri || t.object === entity.uri),
    [entity.uri, allTriples]
  );

  const hoodTriples = useMemo(
    () => neighborhoodTriples(entity.uri, allTriples, 2),
    [entity.uri, allTriples]
  );

  const graphOptions = useMemo(() => ({
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: {
      predicates: ['http://schema.org/name', 'http://www.w3.org/2000/01/rdf-schema#label'],
      minZoomForLabels: 0.2,
    },
    style: {
      defaultNodeColor: TRUST_COLORS[entity.trustLevel],
      defaultEdgeColor: '#475569',
      edgeWidth: 1.0,
      fontSize: 16,
    },
    hexagon: { baseSize: 7, minSize: 4, maxSize: 10, scaleWithDegree: true },
    focus: { maxNodes: 500, hops: 999 },
  }), [entity.trustLevel]);

  const tripleCount = entity.connections.length + entity.properties.size;

  return (
    <div className="v10-ka-detail">
      <div className="v10-ka-header">
        <button className="v10-ka-back" onClick={onClose}>← Back to Project</button>
        <div className="v10-ka-header-left">
          <div className="v10-ka-label">Knowledge Asset</div>
          <div className="v10-ka-name">
            {icon} {entity.label}
            <span className={`v10-trust-badge ${layerBadge}`}>{layerLabel}</span>
          </div>
          <div className="v10-ka-ual">{entity.uri} · {type} · {tripleCount} triples</div>
        </div>
      </div>

      <div className="v10-ka-split">
        {/* Left pane: Content / Triples / Graph */}
        <div className="v10-ka-left">
          <div className="v10-content-tabs" style={{ margin: '0 -20px', padding: '0 20px', background: 'transparent' }}>
            <button className={`v10-content-tab ${pane === 'content' ? 'active' : ''}`} onClick={() => setPane('content')}>Content</button>
            <button className={`v10-content-tab ${pane === 'triples' ? 'active' : ''}`} onClick={() => setPane('triples')}>Triples</button>
            <button className={`v10-content-tab ${pane === 'graph' ? 'active' : ''}`} onClick={() => setPane('graph')}>Graph</button>
          </div>

          {pane === 'content' && (
            <>
              {desc && (
                <div className="v10-ka-section">
                  <div className="v10-ka-desc"><p>{desc}</p></div>
                </div>
              )}

              {entity.properties.size > 0 && (
                <div className="v10-ka-section">
                  <div className="v10-ka-section-title">Properties</div>
                  {[...entity.properties].map(([pred, vals]) => (
                    <div key={pred} className="v10-ka-prop">
                      <span className="v10-ka-prop-key">{shortPred(pred)}</span>
                      <span className="v10-ka-prop-val">{vals.join(', ')}</span>
                    </div>
                  ))}
                </div>
              )}

              {entity.connections.length > 0 && (
                <div className="v10-ka-section">
                  <div className="v10-ka-section-title">Links to ({entity.connections.length})</div>
                  {entity.connections.map((conn, i) => (
                    <button key={i} className="v10-ka-conn" onClick={() => onNavigate(conn.targetUri)}>
                      <span className="v10-ka-conn-pred">{shortPred(conn.predicate)}</span>
                      <span className="v10-ka-conn-arrow">→</span>
                      <span className="v10-ka-conn-target">{conn.targetLabel}</span>
                    </button>
                  ))}
                </div>
              )}

              {incoming.length > 0 && (
                <div className="v10-ka-section">
                  <div className="v10-ka-section-title">Referenced by ({incoming.length})</div>
                  {incoming.map((inc, i) => (
                    <button key={i} className="v10-ka-conn" onClick={() => onNavigate(inc.entity.uri)}>
                      <span className="v10-ka-conn-target">{inc.entity.label}</span>
                      <span className="v10-ka-conn-arrow">→</span>
                      <span className="v10-ka-conn-pred">{inc.pred}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="v10-ka-meta">
                <span className="v10-ka-meta-item">{icon} {type}</span>
                <span className="v10-ka-meta-item">{tripleCount} triples</span>
                <span className="v10-ka-meta-item">{entity.connections.length} links</span>
              </div>
            </>
          )}

          {pane === 'triples' && (
            <div style={{ marginTop: 8, overflowX: 'auto', border: '1px solid var(--border-default)', borderRadius: 6 }}>
              <table className="v10-ka-triples-table">
                <thead>
                  <tr><th>Subject</th><th>Predicate</th><th>Object</th></tr>
                </thead>
                <tbody>
                  {entityTriples.slice(0, 50).map((t, i) => (
                    <tr key={i}>
                      <td title={t.subject}>{shortPred(t.subject)}</td>
                      <td title={t.predicate}>{shortPred(t.predicate)}</td>
                      <td title={t.object}>{t.object.startsWith('"') ? t.object.replace(/^"|"$/g, '').slice(0, 60) : shortPred(t.object)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 10, color: 'var(--text-ghost)', fontFamily: 'var(--font-mono)', padding: '6px 8px' }}>
                {Math.min(entityTriples.length, 50)} of {entityTriples.length} triples shown
              </div>
            </div>
          )}

          {pane === 'graph' && (
            <div style={{ height: 300, position: 'relative', marginTop: 8, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-default)' }}>
              {hoodTriples.length > 0 ? (
                <Suspense fallback={<span className="v10-graph-placeholder">Loading graph...</span>}>
                  <RdfGraph
                    data={hoodTriples}
                    format="triples"
                    options={graphOptions}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                    onNodeClick={(n: any) => n?.id && n.id !== entity.uri && onNavigate(n.id)}
                    initialFit
                  />
                </Suspense>
              ) : (
                <div className="v10-graph-placeholder">No neighborhood data</div>
              )}
            </div>
          )}
        </div>

        {/* Right pane: Provenance Trail */}
        <div className="v10-ka-right">
          <div className="v10-ka-section-title">Provenance Trail</div>
          <div className="v10-ka-timeline">
            {entity.trustLevel === 'verified' && (
              <div className="v10-ka-event">
                <div className="v10-ka-event-dot verified" />
                <div className="v10-ka-event-header">
                  <span className="v10-ka-event-title">Published to Verified Memory</span>
                </div>
                <div className="v10-ka-event-desc">Knowledge asset endorsed and published on-chain</div>
              </div>
            )}
            {(entity.trustLevel === 'shared' || entity.trustLevel === 'verified') && (
              <div className="v10-ka-event">
                <div className="v10-ka-event-dot shared" />
                <div className="v10-ka-event-header">
                  <span className="v10-ka-event-title">Promoted to Shared Working Memory</span>
                </div>
                <div className="v10-ka-event-desc">Shared with project participants for review</div>
              </div>
            )}
            <div className="v10-ka-event">
              <div className="v10-ka-event-dot created" />
              <div className="v10-ka-event-header">
                <span className="v10-ka-event-title">Created in Working Memory</span>
              </div>
              <div className="v10-ka-event-desc">Extracted from imported data or agent conversation</div>
            </div>
          </div>

          {/* Trust Summary */}
          <div style={{ marginTop: 16, padding: '10px 12px', borderRadius: 6, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
            <div className="v10-ka-section-title" style={{ marginBottom: 6 }}>Entity Summary</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Type</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{type}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Triples</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{tripleCount}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Links</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{entity.connections.length}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Layer</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{layerLabel.split(' ')[0]}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main ProjectView ────────────────────────────────────────

export function ProjectView({ contextGraphId }: ProjectViewProps) {
  const { data: cgData } = useFetch(api.fetchContextGraphs, [], 30_000);
  const [showImport, setShowImport] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [activeLayer, setActiveLayer] = useState<LayerView>('overview');
  const [selectedUri, setSelectedUri] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);

  const cg = useMemo(
    () => cgData?.contextGraphs?.find((c: any) => c.id === contextGraphId),
    [cgData, contextGraphId]
  );

  const memory = useMemoryEntities(contextGraphId);

  const refreshParticipants = useCallback(() => {
    if (cg?.id) {
      listParticipants(cg.id)
        .then(data => setParticipants(data.allowedAgents))
        .catch(() => setParticipants([]));
    }
  }, [cg?.id]);

  useEffect(() => { refreshParticipants(); }, [refreshParticipants]);

  const selectedEntity = useMemo(
    () => selectedUri ? memory.entities.get(selectedUri) ?? null : null,
    [selectedUri, memory.entities]
  );

  const nodeColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const [uri, entity] of memory.entities) {
      colors[uri] = TRUST_COLORS[entity.trustLevel];
    }
    return colors;
  }, [memory.entities]);

  const handleNavigate = useCallback((uri: string) => { setSelectedUri(uri); }, []);
  const handleNodeClick = useCallback((node: any) => { if (node?.id) setSelectedUri(node.id); }, []);

  if (!cg) {
    return (
      <div className="v10-view-placeholder">
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading context graph...</p>
      </div>
    );
  }

  return (
    <div className="v10-memory-explorer">
      {/* Layer Switcher */}
      <LayerSwitcher
        active={activeLayer}
        counts={memory.counts}
        onSwitch={v => { setActiveLayer(v); setSelectedUri(null); }}
        onShare={() => setShowShare(true)}
        onImport={() => setShowImport(true)}
        onRefresh={memory.refresh}
      />

      {/* Drilldown overlay */}
      {selectedEntity && (
        <KADetailView
          entity={selectedEntity}
          allEntities={memory.entities}
          allTriples={memory.graphTriples}
          onNavigate={handleNavigate}
          onClose={() => setSelectedUri(null)}
        />
      )}

      {/* Overview View */}
      {activeLayer === 'overview' && !selectedEntity && (
        <>
          <ProjectOverviewCard cg={cg} memory={memory} participants={participants} />
          <PendingJoinRequestsBar contextGraphId={contextGraphId} onParticipantsChanged={refreshParticipants} />
          {memory.loading && (
            <div className="v10-me-loading"><div className="v10-me-loading-text">Loading memory...</div></div>
          )}
          {memory.error && (
            <div className="v10-me-error">Error: {memory.error}</div>
          )}
          <MemoryStrip memory={memory} onSwitchLayer={setActiveLayer} onSelectEntity={handleNavigate} contextGraphId={contextGraphId} />
        </>
      )}

      {/* Layer Detail Views */}
      {(activeLayer === 'wm' || activeLayer === 'swm' || activeLayer === 'vm') && !selectedEntity && (
        <LayerDetailView
          layer={activeLayer}
          memory={memory}
          nodeColors={nodeColors}
          onNodeClick={handleNodeClick}
          onSelectEntity={handleNavigate}
          contextGraphId={contextGraphId}
        />
      )}

      {/* Provenance Bar */}
      <ProvenanceBar memory={memory} />

      <ImportFilesModal
        open={showImport}
        onClose={() => setShowImport(false)}
        contextGraphId={cg.id}
        contextGraphName={cg.name}
      />
      <ShareProjectModal
        open={showShare}
        onClose={() => setShowShare(false)}
        contextGraphId={cg.id}
        contextGraphName={cg.name}
      />
    </div>
  );
}
