import React, { useMemo, useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { useFetch } from '../hooks.js';
import { api } from '../api-wrapper.js';
import { listJoinRequests, approveJoinRequest, rejectJoinRequest, listParticipants, listAssertions, promoteAssertion, publishSharedMemory, executeQuery, type PendingJoinRequest, type PublishResult } from '../api.js';
import { ImportFilesModal } from '../components/Modals/ImportFilesModal.js';
import { ShareProjectModal } from '../components/Modals/ShareProjectModal.js';
import { useMemoryEntities, type TrustLevel, type MemoryEntity, type Triple } from '../hooks/useMemoryEntities.js';
import { useProjectProfile, ProjectProfileContext, useProjectProfileContext } from '../hooks/useProjectProfile.js';
import { SubGraphBar } from '../components/SubGraphBar.js';
import { fetchSubGraphs, type SubGraphInfo } from '../api.js';
import { GenUIEntityPanel } from '../genui/index.js';
import { useTabsStore } from '../stores/tabs.js';
import {
  useVerifiedMemoryAnchors,
  VIZ_ANCHOR_TYPE,
  VIZ_AGENT_TYPE,
  VIZ_PRED_ANCHORED_IN,
  VIZ_PRED_SIGNED_BY,
  VIZ_PRED_CONSENSUS,
  type PublishAnchor,
} from '../hooks/useVerifiedMemoryAnchors.js';
import { useSwmAttributions, type AgentPaletteEntry } from '../hooks/useSwmAttributions.js';

const RdfGraph = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.RdfGraph }))
);

interface ProjectViewProps {
  contextGraphId: string;
}

type LayerView = 'overview' | 'graph-overview' | 'wm' | 'swm' | 'vm';
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
  Package: { icon: '📦', group: 'Packages' },
  File: { icon: '📄', group: 'Files' },
  Class: { icon: '🔷', group: 'Classes' },
  Interface: { icon: '🔶', group: 'Interfaces' },
  Function: { icon: 'ƒ', group: 'Functions' },
  TypeAlias: { icon: '🏷️', group: 'Types' },
  Enum: { icon: '🔢', group: 'Enums' },
  ExternalModule: { icon: '🌐', group: 'External Modules' },
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

function entityMeta(e: MemoryEntity, profile?: { forType: (iri: string) => { icon?: string; label?: string; color?: string } } | null) {
  // Prefer a profile binding if one is declared for any of the entity's
  // rdf:type IRIs — this is what makes the same UI render differently for
  // code / github / decisions / tasks (or a book project) purely from data.
  if (profile) {
    for (const t of e.types) {
      const b = profile.forType(t);
      const fallbackLabel = shortType(t);
      const primaryType = b.label ?? fallbackLabel;
      if (b.icon || b.color || b.label) {
        return {
          icon: b.icon ?? (TYPE_LABELS[fallbackLabel]?.icon ?? TYPE_LABELS.Thing.icon),
          group: b.label ?? (TYPE_LABELS[fallbackLabel]?.group ?? TYPE_LABELS.Thing.group),
          color: b.color,
          type: primaryType,
        };
      }
    }
  }
  const primaryType = e.types[0] ? shortType(e.types[0]) : 'Entity';
  const info = TYPE_LABELS[primaryType] ?? TYPE_LABELS.Thing;
  return { ...info, type: primaryType };
}

// ─── Shared layer configuration ─────────────────────────────
// Single source of truth for the visual identity of WM / SWM / VM.
const LAYER_CONFIG: Record<'wm' | 'swm' | 'vm', {
  icon: string;
  color: string;
  title: string;
  desc: string;
  trustLabel: string;
  trustLevel: TrustLevel;
}> = {
  wm: {
    icon: '◇',
    color: '#64748b',
    title: 'Working Memory',
    desc: 'Private agent scratchpad — ephemeral, fast local storage',
    trustLabel: 'Working',
    trustLevel: 'working',
  },
  swm: {
    icon: '◈',
    color: '#f59e0b',
    title: 'Shared Working Memory',
    desc: 'Team workspace — shared proposals, TTL-bounded',
    trustLabel: 'Shared',
    trustLevel: 'shared',
  },
  vm: {
    icon: '◉',
    color: '#22c55e',
    title: 'Verified Memory',
    desc: 'Endorsed, published, on-chain knowledge',
    trustLabel: 'Verified',
    trustLevel: 'verified',
  },
};

// ─── Shared graph styling ────────────────────────────────────
// Rich palette for known ontologies — applied in any RdfGraph rendered
// from this view. Nodes without matching types fall back to the layer's
// default color (WM gray / SWM amber / VM green).
const CODE = 'http://dkg.io/ontology/code/';
const CODE_CLASS_COLORS: Record<string, string> = {
  [CODE + 'Package']: '#a855f7',        // purple
  [CODE + 'File']: '#3b82f6',           // blue
  [CODE + 'Class']: '#22c55e',          // green
  [CODE + 'Interface']: '#06b6d4',      // cyan
  [CODE + 'Function']: '#f59e0b',       // amber
  [CODE + 'TypeAlias']: '#ec4899',      // pink
  [CODE + 'Enum']: '#ef4444',           // red
  [CODE + 'ExternalModule']: '#64748b', // slate
  // Synthetic viz nodes — only appear in VM graph. Gold anchor + purple
  // agent identity map 1:1 to the VM hero banner chips so the legend is
  // consistent across the UI.
  [VIZ_ANCHOR_TYPE]: '#f5a524',         // gold — on-chain anchor
  [VIZ_AGENT_TYPE]: '#c084fc',          // lavender — agent DID
};
// Predicate edge colors match the vertex palette so the graph reads as a
// single coherent visual — structural edges use the color of their target
// node type (e.g. `contains` lives between Package→File, so it goes purple-
// blue; `definedIn` points at Files, so it's blue; etc.).
const CODE_PREDICATE_COLORS: Record<string, string> = {
  [CODE + 'imports']: '#60a5fa',     // bright sky-blue (File → File/External)
  [CODE + 'contains']: '#a855f7',    // purple (Package → File)
  [CODE + 'definedIn']: '#3b82f6',   // blue (Declaration → File)
  [CODE + 'exports']: '#f59e0b',     // amber (File → Declaration)
  [CODE + 'extends']: '#22c55e',     // green (Class → Class)
  [CODE + 'implements']: '#06b6d4',  // cyan (Class → Interface)
  // VM provenance edges — pointed, bright and monochromatic so they stand
  // out against the dense committed sub-graph behind them.
  [VIZ_PRED_ANCHORED_IN]: '#f5a524',   // gold (entity → anchor)
  [VIZ_PRED_SIGNED_BY]: '#c084fc',     // lavender (anchor → agent)
  [VIZ_PRED_CONSENSUS]: '#22c55e',     // green (consensus literal edge)
};

function buildLayerGraphOptions(
  layer: 'wm' | 'swm' | 'vm',
  nodeColors?: Record<string, string>,
) {
  const { color } = LAYER_CONFIG[layer];
  // VM ("Verified Memory") is the DKG hero view — we deliberately juice it:
  // thicker & brighter edges, bigger hub/leaf spread, higher gradient so every
  // node reads as a "trust gem". WM/SWM stay quieter so VM clearly wins the
  // eye. This is the visual equivalent of "this knowledge is anchored on-chain".
  const isVM = layer === 'vm';
  return {
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: {
      predicates: [
        'http://schema.org/name',
        'http://www.w3.org/2000/01/rdf-schema#label',
        'http://purl.org/dc/terms/title',
      ],
      minZoomForLabels: isVM ? 0.2 : 0.3,
    },
    style: {
      classColors: CODE_CLASS_COLORS,
      predicateColors: CODE_PREDICATE_COLORS,
      // Per-URI node tints (SWM attribution uses this to paint root KAs by
      // their proposing agent). Omitted for layers that don't use it, so
      // the style engine keeps falling back to classColors.
      ...(nodeColors && Object.keys(nodeColors).length > 0 ? { nodeColors } : {}),
      defaultNodeColor: color,
      defaultEdgeColor: isVM ? '#4ade80' : '#64748b', // VM: vivid green edges
      edgeWidth: isVM ? 1.8 : 1.2,
      // Keep VM very slightly bolder than WM/SWM for hierarchy, but well
      // below the previous 16/17 — those drowned dense layouts in text.
      fontSize: isVM ? 12 : 11,
      gradient: true,
      gradientIntensity: isVM ? 0.65 : 0.4,
    },
    hexagon: {
      baseSize: isVM ? 13 : 11,
      minSize: isVM ? 8 : 7,
      // VM max is deliberately larger than WM/SWM so anchor nodes, which
      // accumulate one edge per KA in the batch, read as clear hubs. A
      // typical anchor ties to 8–20 entities and pops out visually.
      maxSize: isVM ? 42 : 28,
      scaleWithDegree: true,
    },
    focus: { maxNodes: 3000, hops: 999 },
  };
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
        className={`v10-layer-switch-btn ${active === 'graph-overview' ? 'active' : ''}`}
        data-layer="graph-overview"
        onClick={() => onSwitch('graph-overview')}
      >
        <span className="v10-layer-switch-icon">⌬</span> Graph Overview
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

// ─── Layer graph panel (used by LayerContent in both inline and full views) ──

function LayerGraphPanel({
  layer,
  triples,
  onNodeClick,
  contextGraphId,
}: {
  layer: 'wm' | 'swm' | 'vm';
  triples: Triple[];
  onNodeClick?: (node: any) => void;
  contextGraphId?: string;
}) {
  const { title } = LAYER_CONFIG[layer];

  // All URIs that already appear as subject or object in the base VM triples.
  // We pass this into the anchor hook so synthetic anchor→entity edges only
  // get emitted for entities that actually render, avoiding dangling anchors.
  const visibleEntityUris = useMemo(() => {
    if (layer !== 'vm') return undefined;
    const s = new Set<string>();
    for (const t of triples) {
      s.add(t.subject);
      // Literals (`"..."`) are never anchor roots; skip them.
      if (!t.object.startsWith('"')) s.add(t.object);
    }
    return s;
  }, [triples, layer]);

  // VM-only provenance decorations — synthetic anchor + agent identity
  // triples injected around every published KA root. Keeps the data on-disk
  // untouched; the "halo" of trust lives purely in the viz.
  const { anchors, decorationTriples } = useVerifiedMemoryAnchors(
    layer === 'vm' && contextGraphId ? contextGraphId : undefined,
    visibleEntityUris,
  );

  // SWM-only agent attribution — colours each root KA by the agent that
  // promoted it, so the graph reads as "who proposed what". Also surfaces
  // conflict nodes (multi-agent disagreement) and an agent palette for the
  // legend. No-op on WM / VM.
  const swmAttr = useSwmAttributions(layer === 'swm' && contextGraphId ? contextGraphId : undefined);

  const uniqueTriples = useMemo(() => {
    const seen = new Set<string>();
    const out: Triple[] = [];
    const push = (t: Triple) => {
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ subject: t.subject, predicate: t.predicate, object: t.object } as Triple);
    };
    for (const t of triples) push(t);
    // Decoration triples are only produced for VM; for other layers the
    // hook returns an empty array so this loop is a no-op.
    for (const t of decorationTriples) push(t);
    return out;
  }, [triples, decorationTriples]);

  // Only SWM layer uses per-URI node tints — for the rest, classColors rules
  // so code graphs stay legible (Package purple / File blue / etc).
  const graphOptions = useMemo(
    () => buildLayerGraphOptions(layer, layer === 'swm' ? swmAttr.nodeColors : undefined),
    [layer, swmAttr.nodeColors],
  );

  if (uniqueTriples.length === 0) {
    return (
      <div className="v10-graph-view v10-graph-view-fill">
        <span className="v10-graph-placeholder">No triples in {title}</span>
      </div>
    );
  }

  return (
    <div className="v10-graph-view v10-graph-view-fill" style={{ position: 'relative' }}>
      <Suspense fallback={<span className="v10-graph-placeholder">Loading graph...</span>}>
        <RdfGraph
          data={uniqueTriples}
          format="triples"
          options={graphOptions}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          onNodeClick={onNodeClick}
          initialFit
        />
      </Suspense>
      {layer === 'vm' && anchors.length > 0 && (
        <VerifiedGraphLegend anchors={anchors} />
      )}
      {layer === 'swm' && swmAttr.palette.length > 0 && (
        <SwmAttributionLegend palette={swmAttr.palette} conflicts={swmAttr.conflicts.length} />
      )}
    </div>
  );
}

// ─── SWM attribution legend (floating overlay) ────────────
// Pinned to the top-right of the Shared Working Memory graph, this swatch
// maps each palette slot to the agent who promoted the corresponding KA
// roots. Reads as "who said what" at a glance. When two or more agents
// touch the same entity, a separate amber "review" badge appears listing
// the conflict count — the mechanism works in the single-agent devnet
// (shows 0) and lights up organically once a second agent joins.
function SwmAttributionLegend({ palette, conflicts }: { palette: AgentPaletteEntry[]; conflicts: number }) {
  return (
    <div className="v10-swm-legend" aria-label="SWM attribution legend">
      <div className="v10-swm-legend-row v10-swm-legend-head">
        <span>SWM attribution</span>
        <span className="v10-swm-legend-count">{palette.length} agent{palette.length === 1 ? '' : 's'}</span>
      </div>
      {palette.slice(0, 8).map(p => (
        <div key={p.agent} className="v10-swm-legend-row" title={p.agent}>
          <span className="v10-swm-legend-swatch" style={{ background: p.color }} />
          <span className="v10-swm-legend-label">{p.label}</span>
          <span className="v10-swm-legend-metric">{p.entityCount}</span>
        </div>
      ))}
      {conflicts > 0 && (
        <div className="v10-swm-legend-row v10-swm-legend-conflict">
          <span className="v10-swm-legend-swatch" style={{ background: '#f59e0b' }}>!</span>
          <span className="v10-swm-legend-label">In review</span>
          <span className="v10-swm-legend-metric">{conflicts}</span>
        </div>
      )}
    </div>
  );
}

// ─── Verified Memory graph legend (floating overlay) ─────────
// Lives in the top-right of the VM graph view. Explains the two new glyphs
// (gold anchor, lavender agent) introduced by `useVerifiedMemoryAnchors`
// so viewers can decode the graph at a glance. Also doubles as an anchor
// ledger: total anchors + distinct signers + latest publish time. This is
// where the "DKG secret sauce" gets called out explicitly.
function VerifiedGraphLegend({ anchors }: { anchors: PublishAnchor[] }) {
  const signerCount = useMemo(() => {
    const s = new Set<string>();
    for (const a of anchors) for (const g of a.agents) s.add(g);
    return s.size;
  }, [anchors]);
  const latest = anchors[0]?.publishedAt;
  const latestLabel = (() => {
    if (!latest) return null;
    try {
      return new Date(latest).toLocaleString(undefined, {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
    } catch { return null; }
  })();

  return (
    <div className="v10-vm-legend" aria-label="Verified Memory legend">
      <div className="v10-vm-legend-row v10-vm-legend-head">
        <span>VM provenance layer</span>
        <span className="v10-vm-legend-count">{anchors.length} anchor{anchors.length === 1 ? '' : 's'}</span>
      </div>
      <div className="v10-vm-legend-row">
        <span className="v10-vm-legend-swatch" style={{ background: '#f5a524' }}>◉</span>
        <span className="v10-vm-legend-label">On-chain anchor</span>
      </div>
      <div className="v10-vm-legend-row">
        <span className="v10-vm-legend-swatch" style={{ background: '#c084fc' }}>◈</span>
        <span className="v10-vm-legend-label">Agent identity ({signerCount})</span>
      </div>
      <div className="v10-vm-legend-row">
        <span className="v10-vm-legend-swatch" style={{ background: '#4ade80' }}>—</span>
        <span className="v10-vm-legend-label">Signed / anchored edge</span>
      </div>
      {latestLabel && (
        <div className="v10-vm-legend-foot">Latest: {latestLabel}</div>
      )}
    </div>
  );
}

// ─── Memory Strip (expandable layer rows) ────────────────────

function MemoryStrip({ memory, onSwitchLayer, onSelectEntity, contextGraphId, onNodeClick }: {
  memory: ReturnType<typeof useMemoryEntities>;
  onSwitchLayer: (layer: LayerView) => void;
  onSelectEntity: (uri: string) => void;
  contextGraphId: string;
  onNodeClick?: (node: any) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [expandTab, setExpandTab] = useState<Record<string, string>>({ wm: 'items', swm: 'items', vm: 'items' });
  const profile = useProjectProfileContext();

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
    { key: 'swm', label: 'Shared Working Memory', color: '#f59e0b', icon: '◈', entities: layerEntities.swm, promoteLabel: 'Publish to Verified Memory', viewLayer: 'swm' },
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
                  const { icon } = entityMeta(e, profile);
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
              {isExpanded && (
                <MemoryStripExpanded
                  layerKey={layer.key as 'wm' | 'swm' | 'vm'}
                  entities={layer.entities}
                  tripleCount={layerTripleCounts[layer.key as 'wm' | 'swm' | 'vm']}
                  contextGraphId={contextGraphId}
                  memory={memory}
                  activeTab={activeTab as LayerContentTab}
                  onTabChange={tab =>
                    setExpandTab(prev => ({ ...prev, [layer.key]: tab }))
                  }
                  onSelectEntity={onSelectEntity}
                  onNodeClick={onNodeClick}
                  onSwitchLayer={() => onSwitchLayer(layer.viewLayer)}
                />
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// Thin wrapper that computes the layer's triples once and renders LayerContent with a footer.
function MemoryStripExpanded({
  layerKey,
  entities,
  tripleCount,
  contextGraphId,
  memory,
  activeTab,
  onTabChange,
  onSelectEntity,
  onNodeClick,
  onSwitchLayer,
}: {
  layerKey: 'wm' | 'swm' | 'vm';
  entities: MemoryEntity[];
  tripleCount: number;
  contextGraphId: string;
  memory: ReturnType<typeof useMemoryEntities>;
  activeTab: LayerContentTab;
  onTabChange: (tab: LayerContentTab) => void;
  onSelectEntity: (uri: string) => void;
  onNodeClick?: (node: any) => void;
  onSwitchLayer: () => void;
}) {
  const layerTriples = useLayerTriples(memory, layerKey);
  return (
    <LayerContent
      layer={layerKey}
      entities={entities}
      tripleCount={tripleCount}
      layerTriples={layerTriples}
      contextGraphId={contextGraphId}
      memory={memory}
      activeTab={activeTab}
      onTabChange={onTabChange}
      onSelectEntity={onSelectEntity}
      onNodeClick={onNodeClick}
      footer={
        <div className="v10-layer-expand-footer">
          <button
            className="v10-layer-expand-footer-btn"
            onClick={e => {
              e.stopPropagation();
              onSwitchLayer();
            }}
          >
            View full layer →
          </button>
        </div>
      }
    />
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
  const profile = useProjectProfileContext();
  const breakdown = useMemo(() => {
    const counts = new Map<string, { icon: string; count: number }>();
    for (const e of entities) {
      const { icon, type } = entityMeta(e, profile);
      const existing = counts.get(type);
      if (existing) existing.count++;
      else counts.set(type, { icon, count: 1 });
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [entities, profile]);

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
  const color = isWm ? '#f59e0b' : '#22c55e';
  const target = isWm ? 'Shared Memory' : 'Verified Memory';

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
      onComplete();
    } catch (err: any) {
      setError(err.message ?? 'Action failed');
    } finally {
      setBusy(false);
    }
  }, [isWm, contextGraphId, onComplete]);

  if (count === 0) return null;

  return (
    <GenWidget title={isWm ? 'Promote' : 'Publish'} footnote={`Moves assets from this layer to ${target}.`}>
      <div className="v10-decision-context" style={{ marginBottom: 10 }}>
        {count} asset{count !== 1 ? 's' : ''} in this layer can be {isWm ? 'promoted to Shared Memory for collaborative review' : 'published to Verified Memory on-chain'}.
      </div>
      {result && <div style={{ fontSize: 11, color: 'var(--accent-green)', marginBottom: 8 }}>✓ {result}</div>}
      {error && <div style={{ fontSize: 11, color: 'var(--accent-red)', marginBottom: 8 }}>✕ {error}</div>}
      <div className="v10-decision-actions">
        <button
          className={isWm ? 'v10-decision-btn approve' : 'v10-decision-btn primary-cta publish-vm'}
          style={isWm
            ? { borderColor: `${color}50`, color, background: `${color}15`, opacity: busy ? 0.5 : 1 }
            : { opacity: busy ? 0.5 : 1 }}
          disabled={busy}
          onClick={handleAction}
        >
          {busy ? '...' : (isWm ? '✓ Promote All → Shared' : '◉ Publish to Verified Memory')}
        </button>
      </div>
    </GenWidget>
  );
}

// ─── Horizontal widget strip (stats + types + CTA) for the Entities tab ──

function LayerWidgetStrip({ layer, entities, tripleCount, contextGraphId, onComplete }: {
  layer: 'wm' | 'swm' | 'vm';
  entities: MemoryEntity[];
  tripleCount: number;
  contextGraphId: string;
  onComplete: () => void;
}) {
  if (entities.length === 0) {
    return (
      <div className="v10-layer-widgets-strip empty">
        <div className="v10-canvas-empty">
          <div className="v10-canvas-empty-icon">⬡</div>
          <div className="v10-canvas-empty-text">
            Import data or chat with agents to populate this layer.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="v10-layer-widgets-strip">
      <div className="v10-layer-widgets-strip-stats">
        <LayerStatsWidget entities={entities} triples={tripleCount} layer={layer} />
        <TypeBreakdownWidget entities={entities} />
      </div>
      {(layer === 'wm' || layer === 'swm') && (
        <div className="v10-layer-widgets-strip-action">
          <LayerActionsWidget layer={layer} count={entities.length} contextGraphId={contextGraphId} onComplete={onComplete} />
        </div>
      )}
    </div>
  );
}

// ─── Enhanced Entity list (sorted by triple count, with type pill) ──────

function EntityList({ entities, layerKey, layerIcon, onSelectEntity }: {
  entities: MemoryEntity[];
  layerKey: 'wm' | 'swm' | 'vm';
  layerIcon: string;
  onSelectEntity: (uri: string) => void;
}) {
  const profile = useProjectProfileContext();
  const sorted = useMemo(() => {
    const copy = [...entities];
    copy.sort((a, b) => {
      const aCount = a.connections.length + a.properties.size;
      const bCount = b.connections.length + b.properties.size;
      return bCount - aCount;
    });
    return copy;
  }, [entities]);

  const trustLabel = layerKey === 'vm' ? 'Verified' : layerKey === 'swm' ? 'Shared' : 'Working';

  if (entities.length === 0) {
    return (
      <div className="v10-entity-list empty">
        <div className="v10-entity-list-empty">No entities in this layer yet.</div>
      </div>
    );
  }

  return (
    <div className="v10-entity-list">
      <div className="v10-entity-list-header">
        <span className="v10-entity-list-count">{sorted.length} entit{sorted.length === 1 ? 'y' : 'ies'}</span>
        <span className="v10-entity-list-hint">sorted by triples · click to open</span>
      </div>
      {sorted.map(e => {
        const { icon, type } = entityMeta(e, profile);
        const tripleCount = e.connections.length + e.properties.size;
        return (
          <div
            key={e.uri}
            className="v10-entity-card"
            onClick={(ev) => { ev.stopPropagation(); onSelectEntity(e.uri); }}
          >
            <span className="v10-entity-card-icon">{icon}</span>
            <div className="v10-entity-card-main">
              <div className="v10-entity-card-title">{e.label}</div>
              <div className="v10-entity-card-meta">
                {type && type !== 'Entity' && (
                  <span className="v10-entity-type-pill">{icon} {type}</span>
                )}
                <span className="v10-entity-card-triples">{tripleCount} triples</span>
              </div>
            </div>
            <span className={`v10-trust-badge ${layerKey}`}>
              {layerIcon} {trustLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Shared LayerContent (tabs + bodies, used by both inline strip and full page) ──

type LayerContentTab = 'items' | 'assertions' | 'graph' | 'docs';

function LayerContent({
  layer,
  entities,
  tripleCount,
  layerTriples,
  contextGraphId,
  memory,
  activeTab,
  onTabChange,
  onSelectEntity,
  onNodeClick,
  footer,
}: {
  layer: 'wm' | 'swm' | 'vm';
  entities: MemoryEntity[];
  tripleCount: number;
  layerTriples: Triple[];
  contextGraphId: string;
  memory: ReturnType<typeof useMemoryEntities>;
  activeTab: LayerContentTab;
  onTabChange: (tab: LayerContentTab) => void;
  onSelectEntity: (uri: string) => void;
  onNodeClick?: (node: any) => void;
  footer?: React.ReactNode;
}) {
  const config = LAYER_CONFIG[layer];
  const itemsLabel = layer === 'vm' ? 'Knowledge Assets' : 'Entities';

  const handleTab = (tab: LayerContentTab) => (e: React.MouseEvent) => {
    e.stopPropagation();
    onTabChange(tab);
  };

  return (
    <>
      <div className="v10-layer-expand-tabs">
        <button
          className={`v10-layer-expand-tab ${activeTab === 'items' ? 'active' : ''}`}
          onClick={handleTab('items')}
        >{itemsLabel}</button>
        {layer !== 'vm' && (
          <button
            className={`v10-layer-expand-tab ${activeTab === 'assertions' ? 'active' : ''}`}
            onClick={handleTab('assertions')}
          >Assertions</button>
        )}
        <button
          className={`v10-layer-expand-tab ${activeTab === 'graph' ? 'active' : ''}`}
          onClick={handleTab('graph')}
        >Graph</button>
        <button
          className={`v10-layer-expand-tab ${activeTab === 'docs' ? 'active' : ''}`}
          onClick={handleTab('docs')}
        >Documents</button>
      </div>

      {activeTab === 'items' && (
        <div className="v10-layer-expand-body entities-tab">
          {layer === 'vm' && (
            <VerifiedMemoryHeroBanner
              entities={entities}
              tripleCount={tripleCount}
              contextGraphId={contextGraphId}
            />
          )}
          <LayerWidgetStrip
            layer={layer}
            entities={entities}
            tripleCount={tripleCount}
            contextGraphId={contextGraphId}
            onComplete={memory.refresh}
          />
          <EntityList
            entities={entities}
            layerKey={layer}
            layerIcon={config.icon}
            onSelectEntity={onSelectEntity}
          />
          {footer}
        </div>
      )}

      {activeTab === 'assertions' && layer !== 'vm' && (
        <div className="v10-layer-expand-body full-width">
          <AssertionsList contextGraphId={contextGraphId} layer={layer} onComplete={memory.refresh} />
        </div>
      )}

      {activeTab === 'graph' && (
        <div className="v10-layer-expand-body full-width">
          <LayerGraphPanel
            layer={layer}
            triples={layerTriples}
            onNodeClick={onNodeClick}
            contextGraphId={contextGraphId}
          />
        </div>
      )}

      {activeTab === 'docs' && (
        <div className="v10-layer-expand-body full-width">
          <DocumentsList entities={entities} contextGraphId={contextGraphId} />
        </div>
      )}
    </>
  );
}

// ─── Verified Memory Hero Banner ──────────────────────────────
// Sits at the top of the VM tab's "Knowledge Assets" view. Pulls together
// the DKG "secret sauce" into a compact visual: anchoring, consensus,
// agent identity — the verifiability elements that justify the VM's cost.
function VerifiedMemoryHeroBanner({ entities, tripleCount, contextGraphId }: {
  entities: MemoryEntity[];
  tripleCount: number;
  contextGraphId: string;
}) {
  const totalAssets = entities.length;
  const typeSet = new Set<string>();
  for (const e of entities) for (const t of e.types) typeSet.add(t);
  const typeCount = typeSet.size;

  return (
    <div className="v10-vm-hero">
      <div className="v10-vm-hero-title">
        <span className="v10-vm-hero-badge">◉ Verified</span>
        <span className="v10-vm-hero-headline">On-chain anchored · cryptographically signed</span>
      </div>
      <div className="v10-vm-hero-stats">
        <div className="v10-vm-hero-stat">
          <div className="v10-vm-hero-stat-val">{totalAssets}</div>
          <div className="v10-vm-hero-stat-lbl">Knowledge Assets</div>
        </div>
        <div className="v10-vm-hero-stat">
          <div className="v10-vm-hero-stat-val">{tripleCount.toLocaleString()}</div>
          <div className="v10-vm-hero-stat-lbl">Verified Triples</div>
        </div>
        <div className="v10-vm-hero-stat">
          <div className="v10-vm-hero-stat-val">{typeCount}</div>
          <div className="v10-vm-hero-stat-lbl">Entity Types</div>
        </div>
        <div className="v10-vm-hero-stat">
          <div className="v10-vm-hero-stat-val" title={contextGraphId}>{contextGraphId.slice(0, 10)}…</div>
          <div className="v10-vm-hero-stat-lbl">Context Graph</div>
        </div>
      </div>
      <div className="v10-vm-hero-strip">
        <div className="v10-vm-hero-chip" title="Multi-agent endorsement">
          <span className="v10-vm-hero-chip-dot" style={{ background: '#22c55e' }} />
          Consensus
        </div>
        <div className="v10-vm-hero-chip" title="Published to the DKG blockchain anchor">
          <span className="v10-vm-hero-chip-dot" style={{ background: '#3b82f6' }} />
          On-chain
        </div>
        <div className="v10-vm-hero-chip" title="Each contribution bound to a DID">
          <span className="v10-vm-hero-chip-dot" style={{ background: '#a855f7' }} />
          Agent Identity
        </div>
        <div className="v10-vm-hero-chip" title="Tamper-evident via content hashing">
          <span className="v10-vm-hero-chip-dot" style={{ background: '#f59e0b' }} />
          Content Hash
        </div>
      </div>
    </div>
  );
}

// Small helper: compute unique triples for a given layer slice of memory.
function useLayerTriples(memory: ReturnType<typeof useMemoryEntities>, layer: 'wm' | 'swm' | 'vm'): Triple[] {
  const targetLayer = LAYER_CONFIG[layer].trustLevel;
  return useMemo(() => {
    const seen = new Set<string>();
    const out: Triple[] = [];
    for (const t of memory.allTriples) {
      if (t.layer !== targetLayer) continue;
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [memory.allTriples, targetLayer]);
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

  const actionLabel = layer === 'wm' ? 'Promote → Shared' : 'Publish to VM';
  const actionAllLabel = layer === 'wm' ? 'Promote All → Shared' : 'Publish all to Verified Memory';

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

function LayerDetailView({ layer, memory, onNodeClick, onSelectEntity, contextGraphId }: {
  layer: 'wm' | 'swm' | 'vm';
  memory: ReturnType<typeof useMemoryEntities>;
  onNodeClick: (node: any) => void;
  onSelectEntity: (uri: string) => void;
  contextGraphId: string;
}) {
  const [contentTab, setContentTab] = useState<LayerContentTab>('items');
  const config = LAYER_CONFIG[layer];

  const entities = useMemo(
    () => memory.entityList.filter(e => e.trustLevel === config.trustLevel),
    [memory.entityList, config.trustLevel],
  );
  const layerTriples = useLayerTriples(memory, layer);

  return (
    <div className="v10-layer-detail">
      <div className="v10-layer-detail-header">
        <span className="v10-layer-detail-icon" style={{ color: config.color }}>{config.icon}</span>
        <div>
          <div className="v10-layer-detail-title">{config.title}</div>
          <div className="v10-layer-detail-desc">{config.desc}</div>
        </div>
        <div className="v10-layer-detail-actions" />
      </div>
      <div className="v10-layer-detail-body">
        <LayerContent
          layer={layer}
          entities={entities}
          tripleCount={layerTriples.length}
          layerTriples={layerTriples}
          contextGraphId={contextGraphId}
          memory={memory}
          activeTab={contentTab}
          onTabChange={setContentTab}
          onSelectEntity={onSelectEntity}
          onNodeClick={onNodeClick}
        />
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

// Small sub-graph badge rendered next to cross-references so the user
// sees "oh, this link takes me to the github sub-graph" before clicking.
function SubGraphBadge({
  entity,
  profile,
}: {
  entity: MemoryEntity;
  profile: ReturnType<typeof useProjectProfileContext>;
}) {
  // Pick the first non-meta sub-graph the entity has triples in. Most
  // entities only live in one sub-graph; when they span more, the
  // primary (lowest rank) binding wins.
  const slug = useMemo(() => {
    for (const s of entity.subGraphs) {
      if (s !== 'meta') return s;
    }
    return null;
  }, [entity.subGraphs]);
  if (!slug || !profile) return null;
  const binding = profile.forSubGraph(slug);
  const color = binding?.color ?? '#64748b';
  const icon = binding?.icon ?? '•';
  const label = binding?.displayName ?? slug;
  return (
    <span
      className="v10-subgraph-badge"
      style={{ '--sg-color': color } as React.CSSProperties}
      title={`In sub-graph: ${label}`}
    >
      <span className="v10-subgraph-badge-icon" style={{ color }}>{icon}</span>
      <span className="v10-subgraph-badge-label">{label}</span>
    </span>
  );
}

// ─── Verify on DKG CTA ───────────────────────────────────────
// Publishes a single entity through the SWM publish endpoint. For WM-only
// entities the daemon will surface a useful error ("not in SWM") which we
// display verbatim — a follow-up can add a one-shot promote+publish
// endpoint, but for the PoC this is honest and fast.
function VerifyOnDkgButton({
  entity,
  contextGraphId,
  onVerified,
}: {
  entity: MemoryEntity;
  contextGraphId: string;
  onVerified: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const layer = entity.trustLevel;
  if (layer === 'verified') return null;

  const handle = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await publishSharedMemory(contextGraphId, [entity.uri]);
      setResult(r);
      onVerified();
    } catch (err: any) {
      setError(err?.message ?? 'Publish failed');
    } finally {
      setBusy(false);
    }
  };

  const needsPromote = layer === 'working';
  const cta = needsPromote ? 'Verify on DKG (requires SWM promote)' : 'Verify on DKG →';

  return (
    <div className="v10-ka-verify">
      {!result && (
        <>
          <button
            className={`v10-ka-verify-btn ${needsPromote ? 'gated' : ''}`}
            onClick={handle}
            disabled={busy}
          >
            {busy ? 'Publishing…' : cta}
          </button>
          <div className="v10-ka-verify-hint">
            {needsPromote
              ? 'Entity is still in Working Memory. Promote it to Shared Memory via the Assertions tab first, then come back here.'
              : 'Anchors this entity on-chain with a TRAC-locked Knowledge Asset. Consensus signers and TX hash appear below on success.'}
          </div>
        </>
      )}
      {error && (
        <div className="v10-ka-verify-err">✕ {error}</div>
      )}
      {result && (
        <div className="v10-ka-verify-ok">
          <div className="v10-ka-verify-ok-row">
            <span className="v10-ka-verify-ok-lbl">Status</span>
            <span className="v10-ka-verify-ok-val">✓ {result.status}</span>
          </div>
          {result.txHash && (
            <div className="v10-ka-verify-ok-row">
              <span className="v10-ka-verify-ok-lbl">TX hash</span>
              <span className="v10-ka-verify-ok-val mono" title={result.txHash}>
                {result.txHash.slice(0, 10)}…{result.txHash.slice(-6)}
              </span>
            </div>
          )}
          {result.blockNumber != null && (
            <div className="v10-ka-verify-ok-row">
              <span className="v10-ka-verify-ok-lbl">Block</span>
              <span className="v10-ka-verify-ok-val mono">#{result.blockNumber}</span>
            </div>
          )}
          {result.kas?.[0]?.tokenId && (
            <div className="v10-ka-verify-ok-row">
              <span className="v10-ka-verify-ok-lbl">Token</span>
              <span className="v10-ka-verify-ok-val mono">#{result.kas[0].tokenId}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KADetailView({ entity, allEntities, allTriples, onNavigate, onClose, contextGraphId, onRefresh }: {
  entity: MemoryEntity;
  allEntities: Map<string, MemoryEntity>;
  allTriples: Triple[];
  onNavigate: (uri: string) => void;
  onClose: () => void;
  contextGraphId: string;
  onRefresh: () => void;
}) {
  const [pane, setPane] = useState<KAPane>('content');
  const profile = useProjectProfileContext();
  const { icon, type } = entityMeta(entity, profile);
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
      fontSize: 11,
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
              {/* Profile-driven Generative UI — streamed from the DKG daemon's
                  LLM-backed /api/genui/render for any rdf:type that declares a
                  detailHint. Falls back to the generic detail below if the
                  profile has no binding for this type. */}
              {(() => {
                const binding = entity.types.map(t => profile?.forType(t)).find(b => b?.detailHint);
                if (!binding || !profile?.contextGraphId) return null;
                return (
                  <div className="v10-ka-section">
                    <GenUIEntityPanel
                      contextGraphId={profile.contextGraphId}
                      entityUri={entity.uri}
                    />
                  </div>
                );
              })()}
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
                  <div className="v10-ka-section-title">References ({entity.connections.length})</div>
                  {entity.connections.map((conn, i) => {
                    const target = allEntities.get(conn.targetUri);
                    return (
                      <button key={i} className="v10-ka-conn" onClick={() => onNavigate(conn.targetUri)}>
                        <span className="v10-ka-conn-pred">{shortPred(conn.predicate)}</span>
                        <span className="v10-ka-conn-arrow">→</span>
                        <span className="v10-ka-conn-target">{conn.targetLabel}</span>
                        {target && <SubGraphBadge entity={target} profile={profile} />}
                      </button>
                    );
                  })}
                </div>
              )}

              {incoming.length > 0 && (
                <div className="v10-ka-section">
                  <div className="v10-ka-section-title">Referenced by ({incoming.length})</div>
                  {incoming.map((inc, i) => (
                    <button key={i} className="v10-ka-conn" onClick={() => onNavigate(inc.entity.uri)}>
                      <span className="v10-ka-conn-target">{inc.entity.label}</span>
                      <SubGraphBadge entity={inc.entity} profile={profile} />
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

          {/* Verify on DKG — prominent CTA for WM/SWM entities */}
          <VerifyOnDkgButton
            entity={entity}
            contextGraphId={contextGraphId}
            onVerified={onRefresh}
          />

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

// ─── Sub-graph Overview Grid ─────────────────────────────────
// A bird's-eye "wall of graphs" — one miniature RdfGraph per registered
// sub-graph, displayed side-by-side. Each card inherits its color/icon/label
// from the project profile (SubGraphBinding), so the same component adapts
// to a code project, a research project, a book project, etc. without
// knowing anything about their ontologies.
//
// Data: the WM triples already carry a `subGraph` tag (see
// `useMemoryEntities`). We simply bucket them by slug and hand each bucket
// to a lightweight mini-graph. No extra network calls are made — the
// daemon's /api/sub-graph/list only supplies counts for the card header.

function SubGraphOverviewGrid({
  contextGraphId,
  memory,
  onNodeClick,
  onSelectSubGraph,
}: {
  contextGraphId: string;
  memory: ReturnType<typeof useMemoryEntities>;
  onNodeClick?: (node: any) => void;
  onSelectSubGraph: (slug: string) => void;
}) {
  const profile = useProjectProfileContext();
  const [subGraphs, setSubGraphs] = useState<SubGraphInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSubGraphs(contextGraphId)
      .then(r => { if (!cancelled) setSubGraphs(r.subGraphs ?? []); })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contextGraphId]);

  // Bucket every triple by its origin sub-graph so each mini-graph renders
  // just its slice. We dedupe on (s,p,o) and cap per-bucket to keep the
  // mini-graph canvases snappy. Without the cap, sub-graphs like `code`
  // (~25k triples) can lock up the tab while force-graph runs its layout.
  //
  // Sampling strategy: when a sub-graph exceeds MAX_PER_CARD, we keep
  // every triple for the N heaviest root entities (highest degree) so
  // the user sees a representative, connected slice rather than a
  // random first-N truncation that breaks clusters apart.
  const MAX_PER_CARD = 2500;
  const triplesBySubGraph = useMemo(() => {
    const bySg = new Map<string, Triple[]>();
    const seen = new Map<string, Set<string>>();
    for (const t of memory.allTriples) {
      if (!t.subGraph) continue;
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      let s = seen.get(t.subGraph);
      if (!s) { s = new Set(); seen.set(t.subGraph, s); }
      if (s.has(key)) continue;
      s.add(key);
      let arr = bySg.get(t.subGraph);
      if (!arr) { arr = []; bySg.set(t.subGraph, arr); }
      arr.push({ subject: t.subject, predicate: t.predicate, object: t.object });
    }
    // If a bucket is over the cap, fall back to sampling the heaviest
    // subjects and dropping the long tail. This preserves cluster
    // topology far better than truncation.
    for (const [sg, triples] of bySg) {
      if (triples.length <= MAX_PER_CARD) continue;
      const degree = new Map<string, number>();
      for (const t of triples) degree.set(t.subject, (degree.get(t.subject) ?? 0) + 1);
      const order = [...degree.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([uri]) => uri);
      const keep = new Set<string>();
      let kept = 0;
      for (const uri of order) {
        if (kept >= MAX_PER_CARD) break;
        keep.add(uri);
        kept += degree.get(uri)!;
      }
      bySg.set(sg, triples.filter(t => keep.has(t.subject)));
    }
    return bySg;
  }, [memory.allTriples]);

  // Per-sub-graph layer counts — drives the mini pyramid on each card so
  // you can see at a glance which sub-graphs are mostly verified vs still
  // in flight. Computed from rawMemory.entityList intersected with the
  // entity's subGraphs bag.
  const layerCountsBySubGraph = useMemo(() => {
    const out = new Map<string, { wm: number; swm: number; vm: number }>();
    for (const e of memory.entityList) {
      for (const sg of e.subGraphs) {
        let counts = out.get(sg);
        if (!counts) { counts = { wm: 0, swm: 0, vm: 0 }; out.set(sg, counts); }
        if (e.layers.has('working'))  counts.wm++;
        if (e.layers.has('shared'))   counts.swm++;
        if (e.layers.has('verified')) counts.vm++;
      }
    }
    return out;
  }, [memory.entityList]);

  // Merge registered sub-graphs (minus `meta`) with profile bindings so
  // icon/color/label/rank all flow from the single source of truth.
  const cards = useMemo(() => {
    return subGraphs
      .filter(sg => sg.name !== 'meta')
      .map(sg => {
        const binding = profile?.forSubGraph(sg.name) ?? {};
        return {
          slug: sg.name,
          icon: binding.icon ?? '•',
          color: binding.color ?? '#64748b',
          displayName: binding.displayName ?? sg.name,
          description: binding.description,
          rank: binding.rank ?? 99,
          entityCount: sg.entityCount,
          tripleCount: sg.tripleCount,
          triples: triplesBySubGraph.get(sg.name) ?? [],
          layerCounts: layerCountsBySubGraph.get(sg.name) ?? { wm: 0, swm: 0, vm: 0 },
        };
      })
      .sort((a, b) => a.rank - b.rank);
  }, [subGraphs, profile, triplesBySubGraph, layerCountsBySubGraph]);

  if (loading && cards.length === 0) {
    return (
      <div className="v10-sgov-loading">Loading sub-graphs…</div>
    );
  }
  if (cards.length === 0) {
    return (
      <div className="v10-sgov-empty">
        No sub-graphs registered on this project yet.
      </div>
    );
  }

  return (
    <div className="v10-sgov">
      <div className="v10-sgov-header">
        <div className="v10-sgov-title">Sub-graph Overview</div>
        <div className="v10-sgov-sub">
          {cards.length} sub-graphs · {cards.reduce((a, b) => a + b.entityCount, 0)} entities · {cards.reduce((a, b) => a + b.tripleCount, 0)} triples
        </div>
      </div>
      <div className="v10-sgov-grid">
        {cards.map(card => (
          <SubGraphMiniCard
            key={card.slug}
            card={card}
            onNodeClick={onNodeClick}
            onOpen={() => onSelectSubGraph(card.slug)}
          />
        ))}
      </div>
    </div>
  );
}

function SubGraphMiniCard({
  card,
  onNodeClick,
  onOpen,
}: {
  card: {
    slug: string; icon: string; color: string; displayName: string;
    description?: string; entityCount: number; tripleCount: number;
    triples: Triple[];
    layerCounts: { wm: number; swm: number; vm: number };
  };
  onNodeClick?: (node: any) => void;
  onOpen: () => void;
}) {
  // A compact-mode graph options block — pared-down labels, smaller nodes,
  // brighter default color (driven by the sub-graph's profile color) so each
  // card reads as a distinct "island" at a glance.
  const graphOptions = useMemo(() => ({
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: {
      predicates: [
        'http://schema.org/name',
        'http://www.w3.org/2000/01/rdf-schema#label',
        'http://purl.org/dc/terms/title',
      ],
      minZoomForLabels: 0.8, // Keep labels out of the way in the mini view.
    },
    style: {
      classColors: CODE_CLASS_COLORS,
      predicateColors: CODE_PREDICATE_COLORS,
      defaultNodeColor: card.color,
      defaultEdgeColor: '#475569',
      edgeWidth: 1.0,
      fontSize: 12,
      gradient: true,
      gradientIntensity: 0.35,
    },
    hexagon: { baseSize: 6, minSize: 3, maxSize: 16, scaleWithDegree: true },
    focus: { maxNodes: 5000, hops: 999 },
  }), [card.color]);

  return (
    <div
      className="v10-sgov-card"
      style={{
        '--sg-color': card.color,
        borderColor: card.color + '55',
      } as React.CSSProperties}
    >
      <div className="v10-sgov-card-head">
        <span className="v10-sgov-card-icon" style={{ color: card.color }}>{card.icon}</span>
        <div className="v10-sgov-card-title-wrap">
          <div className="v10-sgov-card-title">{card.displayName}</div>
          {card.description && (
            <div className="v10-sgov-card-desc" title={card.description}>{card.description}</div>
          )}
        </div>
        <button type="button" className="v10-sgov-card-open" onClick={onOpen} title={`Focus on ${card.displayName}`}>
          ↗
        </button>
      </div>
      <div className="v10-sgov-card-stats">
        <span className="v10-sgov-card-stat"><b>{card.entityCount}</b> entities</span>
        <span className="v10-sgov-card-stat"><b>{card.tripleCount}</b> triples</span>
      </div>
      <div className="v10-sgov-card-pyramid">
        <MiniLayerPyramid counts={card.layerCounts} />
      </div>
      <div className="v10-sgov-card-graph">
        {card.triples.length === 0 ? (
          <div className="v10-sgov-card-empty">
            {card.entityCount > 0 ? 'No WM triples · promoted data only' : 'No data yet'}
          </div>
        ) : (
          <Suspense fallback={<div className="v10-sgov-card-empty">Loading…</div>}>
            <RdfGraph
              data={card.triples}
              format="triples"
              options={graphOptions}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              onNodeClick={onNodeClick}
              initialFit
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// ─── MiniLayerPyramid ────────────────────────────────────────
// Three-segment WM/SWM/VM bar. Used as a header widget in the sub-graph
// page (clickable — toggles which layers contribute entities) and as a
// compact badge on SubGraphOverviewGrid cards (read-only).
function MiniLayerPyramid({
  counts,
  activeLayers,
  onClickLayer,
  compact = false,
}: {
  counts: { wm: number; swm: number; vm: number };
  activeLayers?: Set<TrustLevel>;
  onClickLayer?: (layer: TrustLevel) => void;
  compact?: boolean;
}) {
  const total = counts.wm + counts.swm + counts.vm;
  if (total === 0) {
    return compact ? null : <div className="v10-minipyr v10-minipyr-empty">No data</div>;
  }
  const rows: Array<{ key: TrustLevel; short: string; count: number; color: string; label: string }> = [
    { key: 'verified', short: 'VM',  count: counts.vm,  color: '#22c55e', label: 'Verified' },
    { key: 'shared',   short: 'SWM', count: counts.swm, color: '#f59e0b', label: 'Shared' },
    { key: 'working',  short: 'WM',  count: counts.wm,  color: '#64748b', label: 'Working' },
  ];
  const interactive = !!onClickLayer;
  return (
    <div className={`v10-minipyr${compact ? ' compact' : ''}`}>
      {!compact && (
        <div className="v10-minipyr-bar">
          {rows.filter(r => r.count > 0).map(r => {
            const pct = (r.count / total) * 100;
            const active = activeLayers ? activeLayers.has(r.key) : true;
            return (
              <div
                key={r.key}
                className={`v10-minipyr-seg${active ? '' : ' dim'}`}
                style={{ width: `${pct}%`, background: r.color }}
                title={`${r.label}: ${r.count}`}
              />
            );
          })}
        </div>
      )}
      <div className="v10-minipyr-legend">
        {rows.map(r => {
          const active = activeLayers ? activeLayers.has(r.key) : true;
          return (
            <button
              key={r.key}
              type="button"
              className={`v10-minipyr-chip${active ? '' : ' dim'}${interactive ? ' interactive' : ''}`}
              onClick={interactive ? () => onClickLayer!(r.key) : undefined}
              disabled={!interactive}
              title={`${r.label} Memory — ${r.count} entities${interactive ? ' (click to toggle)' : ''}`}
            >
              <span className="v10-minipyr-dot" style={{ background: r.color }} />
              <span className="v10-minipyr-short">{r.short}</span>
              <span className="v10-minipyr-count">{r.count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── SubGraphTimeline ────────────────────────────────────────
// Horizontal ribbon of entities sorted by the sub-graph's declared
// `profile:timelinePredicate`. Grouped into year-month buckets so the
// ribbon has natural section headers.
function SubGraphTimeline({
  items,
  color,
  onSelectEntity,
}: {
  items: Array<{ entity: MemoryEntity; date: Date }>;
  color: string;
  onSelectEntity: (uri: string) => void;
}) {
  const profile = useProjectProfileContext();
  const grouped = useMemo(() => {
    const out = new Map<string, Array<{ entity: MemoryEntity; date: Date }>>();
    for (const it of items) {
      const key = `${it.date.getFullYear()}-${String(it.date.getMonth() + 1).padStart(2, '0')}`;
      const arr = out.get(key) ?? [];
      arr.push(it);
      out.set(key, arr);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="v10-subgraph-timeline-empty">
        No entities in this sub-graph have a timeline value (check the profile's <code>timelinePredicate</code> and the underlying data).
      </div>
    );
  }

  return (
    <div className="v10-subgraph-timeline">
      {grouped.map(([bucket, rows]) => (
        <div key={bucket} className="v10-subgraph-timeline-bucket">
          <div className="v10-subgraph-timeline-bucket-head">
            <span className="v10-subgraph-timeline-bucket-dot" style={{ background: color }} />
            <span className="v10-subgraph-timeline-bucket-label">{formatTimelineBucket(bucket)}</span>
            <span className="v10-subgraph-timeline-bucket-count">{rows.length}</span>
          </div>
          <div className="v10-subgraph-timeline-items">
            {rows.map(({ entity, date }) => {
              const { icon } = entityMeta(entity, profile);
              return (
                <button
                  key={entity.uri}
                  className="v10-subgraph-timeline-item"
                  onClick={() => onSelectEntity(entity.uri)}
                  title={`${entity.label} · ${date.toISOString().slice(0, 10)}`}
                >
                  <span className="v10-subgraph-timeline-item-icon">{icon}</span>
                  <span className="v10-subgraph-timeline-item-label">{entity.label}</span>
                  <span className="v10-subgraph-timeline-item-date">{date.toISOString().slice(0, 10)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatTimelineBucket(ym: string): string {
  const [y, m] = ym.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mi = Math.max(0, Math.min(11, parseInt(m, 10) - 1));
  return `${months[mi]} ${y}`;
}

// ─── SubGraphDetailView ──────────────────────────────────────
// Renders a sub-graph as a first-class page with the same Entities /
// Graph / (optional) Timeline / Documents tabs as the layer views. The
// layer axis becomes a secondary filter in the header via the mini
// pyramid chips; `profile:FilterChip` rows filter by predicate value;
// `profile:SavedQuery` pills run SPARQL and narrow the entity list.
type SubGraphTab = 'items' | 'graph' | 'timeline' | 'docs';

function SubGraphDetailView({
  slug,
  rawMemory,
  contextGraphId,
  onNodeClick,
  onSelectEntity,
}: {
  slug: string;
  rawMemory: ReturnType<typeof useMemoryEntities>;
  contextGraphId: string;
  onNodeClick: (node: any) => void;
  onSelectEntity: (uri: string) => void;
}) {
  const profile = useProjectProfileContext();
  const binding = profile?.forSubGraph(slug);
  const chips = profile?.chipsFor(slug) ?? [];
  const savedQueries = profile?.savedQueriesFor(slug) ?? [];
  const timelinePredicate = binding?.timelinePredicate;

  const [activeTab, setActiveTab] = useState<SubGraphTab>('items');
  const [enabledLayers, setEnabledLayers] = useState<Set<TrustLevel>>(
    () => new Set<TrustLevel>(['working', 'shared', 'verified']),
  );
  const [chipState, setChipState] = useState<Map<string, Set<string>>>(new Map());
  const [activeQuerySlug, setActiveQuerySlug] = useState<string | null>(null);
  const [queryResults, setQueryResults] = useState<Set<string> | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);

  // Base slice: every entity that has at least one WM triple in this sub-graph.
  // SWM/VM triples don't carry sub-graph origin, so we additionally pull in
  // any SWM/VM entity whose URI matches a scoped one (preserving the promoted
  // slices of the same entity across layers).
  const scopedEntities = useMemo(() => {
    const scoped: MemoryEntity[] = [];
    for (const e of rawMemory.entityList) {
      if (e.subGraphs.has(slug)) scoped.push(e);
    }
    return scoped;
  }, [rawMemory.entityList, slug]);

  const scopedUris = useMemo(
    () => new Set(scopedEntities.map(e => e.uri)),
    [scopedEntities],
  );

  // Triples visible in the Graph tab: anything tagged with this sub-graph's
  // origin, plus any triple whose endpoints are both scoped entities (this
  // carries promoted SWM/VM edges whose origin was erased on promotion).
  const scopedTriples = useMemo(
    () => rawMemory.graphTriples.filter(t =>
      t.subGraph === slug || (scopedUris.has(t.subject) && scopedUris.has(t.object)),
    ),
    [rawMemory.graphTriples, scopedUris, slug],
  );

  // Layer counts for the pyramid header.
  const layerCounts = useMemo(() => {
    let wm = 0, swm = 0, vm = 0;
    for (const e of scopedEntities) {
      if (e.layers.has('working'))  wm++;
      if (e.layers.has('shared'))   swm++;
      if (e.layers.has('verified')) vm++;
    }
    return { wm, swm, vm, total: scopedEntities.length };
  }, [scopedEntities]);

  // Apply the three filter axes on top of the base scope.
  const filteredEntities = useMemo(() => {
    let out = scopedEntities;
    if (enabledLayers.size < 3) {
      out = out.filter(e => enabledLayers.has(e.trustLevel));
    }
    if (chipState.size > 0) {
      for (const chip of chips) {
        const selected = chipState.get(chip.slug);
        if (!selected || selected.size === 0) continue;
        out = out.filter(e => {
          const vals = e.properties.get(chip.predicate);
          if (!vals || vals.length === 0) return false;
          return vals.some(v => selected.has(v));
        });
      }
    }
    if (queryResults) {
      out = out.filter(e => queryResults.has(e.uri));
    }
    return out;
  }, [scopedEntities, enabledLayers, chipState, chips, queryResults]);

  const filteredUris = useMemo(
    () => new Set(filteredEntities.map(e => e.uri)),
    [filteredEntities],
  );

  const filteredTriples = useMemo(() => {
    if (filteredEntities.length === scopedEntities.length) return scopedTriples;
    return scopedTriples.filter(
      t => filteredUris.has(t.subject) || filteredUris.has(t.object),
    );
  }, [scopedTriples, scopedEntities, filteredEntities, filteredUris]);

  const timelineItems = useMemo(() => {
    if (!timelinePredicate) return [];
    const out: Array<{ entity: MemoryEntity; date: Date }> = [];
    for (const e of filteredEntities) {
      const vals = e.properties.get(timelinePredicate);
      if (!vals?.[0]) continue;
      const dstr = vals[0].replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
      const d = new Date(dstr);
      if (isNaN(d.getTime())) continue;
      out.push({ entity: e, date: d });
    }
    out.sort((a, b) => a.date.getTime() - b.date.getTime());
    return out;
  }, [filteredEntities, timelinePredicate]);

  const toggleLayer = useCallback((layer: TrustLevel) => {
    setEnabledLayers(prev => {
      const next = new Set(prev);
      if (next.has(layer)) {
        // Refuse to turn off the last enabled layer — otherwise the list
        // empties with no obvious recovery affordance.
        if (next.size > 1) next.delete(layer);
      } else {
        next.add(layer);
      }
      return next;
    });
  }, []);

  const toggleChip = useCallback((chipSlug: string, value: string) => {
    setChipState(prev => {
      const next = new Map(prev);
      const curr = new Set(next.get(chipSlug) ?? []);
      if (curr.has(value)) curr.delete(value);
      else curr.add(value);
      if (curr.size === 0) next.delete(chipSlug);
      else next.set(chipSlug, curr);
      return next;
    });
  }, []);

  const clearQuery = useCallback(() => {
    setActiveQuerySlug(null);
    setQueryResults(null);
    setQueryError(null);
  }, []);

  const runQuery = useCallback(async (q: { slug: string; sparql: string; resultColumn: string; name: string }) => {
    setQueryLoading(true);
    setQueryError(null);
    setActiveQuerySlug(q.slug);
    try {
      const r = await executeQuery(q.sparql, contextGraphId);
      const bindings = (r as any)?.result?.bindings ?? [];
      const col = q.resultColumn || 'uri';
      const ids = new Set<string>();
      for (const row of bindings) {
        const raw = (row as any)[col];
        if (!raw) continue;
        const s = typeof raw === 'string' ? raw : String(raw);
        const iri = s.startsWith('<') && s.endsWith('>') ? s.slice(1, -1) : s;
        ids.add(iri);
      }
      setQueryResults(ids);
    } catch (err: any) {
      setQueryError(err?.message ?? String(err));
      setQueryResults(null);
      setActiveQuerySlug(null);
    } finally {
      setQueryLoading(false);
    }
  }, [contextGraphId]);

  const color = binding?.color ?? '#64748b';
  const icon = binding?.icon ?? '•';
  const title = binding?.displayName ?? slug;
  const desc = binding?.description;

  // Reset filters when the sub-graph changes — otherwise chips from
  // `tasks` would linger when the user jumps to `decisions` and silently
  // zero out the list.
  useEffect(() => {
    setActiveTab('items');
    setEnabledLayers(new Set<TrustLevel>(['working', 'shared', 'verified']));
    setChipState(new Map());
    clearQuery();
  }, [slug, clearQuery]);

  const hasAnyFilter = enabledLayers.size < 3 || chipState.size > 0 || !!queryResults;
  const resetFilters = () => {
    setEnabledLayers(new Set<TrustLevel>(['working', 'shared', 'verified']));
    setChipState(new Map());
    clearQuery();
  };

  return (
    <div
      className="v10-layer-detail v10-subgraph-detail"
      style={{ '--sg-color': color } as React.CSSProperties}
    >
      <div className="v10-subgraph-detail-header">
        <span className="v10-subgraph-detail-icon" style={{ color }}>{icon}</span>
        <div className="v10-subgraph-detail-title-wrap">
          <div className="v10-subgraph-detail-title">{title}</div>
          {desc && <div className="v10-subgraph-detail-desc">{desc}</div>}
        </div>
        <MiniLayerPyramid
          counts={{ wm: layerCounts.wm, swm: layerCounts.swm, vm: layerCounts.vm }}
          activeLayers={enabledLayers}
          onClickLayer={toggleLayer}
        />
      </div>

      {savedQueries.length > 0 && (
        <div className="v10-subgraph-savedqueries">
          <span className="v10-subgraph-savedqueries-label">Saved queries</span>
          {savedQueries.map(q => {
            const isActive = activeQuerySlug === q.slug;
            return (
              <button
                key={q.slug}
                type="button"
                className={`v10-subgraph-savedquery${isActive ? ' active' : ''}`}
                onClick={() => isActive ? clearQuery() : runQuery(q)}
                title={q.description || q.name}
                disabled={queryLoading && !isActive}
              >
                <span className="v10-subgraph-savedquery-glyph">
                  {queryLoading && isActive ? '…' : isActive ? '✓' : '◎'}
                </span>
                {q.name}
              </button>
            );
          })}
          {queryError && (
            <span className="v10-subgraph-savedquery-error" title={queryError}>✕ query failed</span>
          )}
          {queryResults && activeQuerySlug && (
            <span className="v10-subgraph-savedquery-count">
              {queryResults.size} match{queryResults.size === 1 ? '' : 'es'}
            </span>
          )}
        </div>
      )}

      {chips.length > 0 && (
        <div className="v10-subgraph-filters">
          {chips.map(chip => {
            const selected = chipState.get(chip.slug) ?? new Set<string>();
            return (
              <div key={chip.slug} className="v10-subgraph-filter-row">
                <span className="v10-subgraph-filter-label">{chip.label}</span>
                <div className="v10-subgraph-filter-chips">
                  {chip.values.map(v => {
                    const on = selected.has(v);
                    return (
                      <button
                        key={v}
                        type="button"
                        className={`v10-subgraph-filter-chip${on ? ' active' : ''}`}
                        onClick={() => toggleChip(chip.slug, v)}
                      >
                        {v}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {hasAnyFilter && (
            <button type="button" className="v10-subgraph-filter-reset" onClick={resetFilters}>
              Reset filters
            </button>
          )}
        </div>
      )}

      <div className="v10-layer-detail-body">
        <div className="v10-layer-expand-tabs">
          <button
            className={`v10-layer-expand-tab ${activeTab === 'items' ? 'active' : ''}`}
            onClick={() => setActiveTab('items')}
          >
            Entities ({filteredEntities.length}{filteredEntities.length !== scopedEntities.length ? ` / ${scopedEntities.length}` : ''})
          </button>
          <button
            className={`v10-layer-expand-tab ${activeTab === 'graph' ? 'active' : ''}`}
            onClick={() => setActiveTab('graph')}
          >
            Graph
          </button>
          {timelinePredicate && (
            <button
              className={`v10-layer-expand-tab ${activeTab === 'timeline' ? 'active' : ''}`}
              onClick={() => setActiveTab('timeline')}
            >
              Timeline
            </button>
          )}
          <button
            className={`v10-layer-expand-tab ${activeTab === 'docs' ? 'active' : ''}`}
            onClick={() => setActiveTab('docs')}
          >
            Documents
          </button>
        </div>

        {activeTab === 'items' && (
          <div className="v10-layer-expand-body entities-tab">
            <EntityList
              entities={filteredEntities}
              layerKey="wm"
              layerIcon={icon}
              onSelectEntity={onSelectEntity}
            />
          </div>
        )}

        {activeTab === 'graph' && (
          <div className="v10-layer-expand-body full-width">
            <LayerGraphPanel
              layer="wm"
              triples={filteredTriples}
              onNodeClick={onNodeClick}
              contextGraphId={contextGraphId}
            />
          </div>
        )}

        {activeTab === 'timeline' && timelinePredicate && (
          <div className="v10-layer-expand-body full-width">
            <SubGraphTimeline
              items={timelineItems}
              color={color}
              onSelectEntity={onSelectEntity}
            />
          </div>
        )}

        {activeTab === 'docs' && (
          <div className="v10-layer-expand-body full-width">
            <DocumentsList
              entities={filteredEntities}
              contextGraphId={contextGraphId}
            />
          </div>
        )}
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
  // Active sub-graph *page* — when set, the middle pane renders the sub-graph
  // detail view instead of the overview / layer views. This is structurally
  // a sibling of `activeLayer`, not a filter over it: sub-graphs are a peer
  // axis to layers, and each axis gets its own first-class page.
  const [activeSubGraph, setActiveSubGraph] = useState<string | null>(null);
  const profile = useProjectProfile(contextGraphId);

  const cg = useMemo(
    () => cgData?.contextGraphs?.find((c: any) => c.id === contextGraphId),
    [cgData, contextGraphId]
  );

  const rawMemory = useMemoryEntities(contextGraphId);

  const refreshParticipants = useCallback(() => {
    if (cg?.id) {
      listParticipants(cg.id)
        .then(data => setParticipants(data.allowedAgents))
        .catch(() => setParticipants([]));
    }
  }, [cg?.id]);

  useEffect(() => { refreshParticipants(); }, [refreshParticipants]);

  const selectedEntity = useMemo(
    () => selectedUri ? rawMemory.entities.get(selectedUri) ?? null : null,
    [selectedUri, rawMemory.entities]
  );

  // Route a sub-graph chip click to the sub-graph page. Selecting "All"
  // (null) exits the page back to the current layer view, or overview if
  // we were already on one.
  const handleSelectSubGraph = useCallback((slug: string | null) => {
    setActiveSubGraph(slug);
    setSelectedUri(null);
  }, []);

  // Cross-sub-graph jump: when the user clicks an entity link that lives
  // in a different sub-graph, switch pages and open the entity detail.
  // Falls back to just opening the detail if the entity has no sub-graph
  // origin (SWM/VM entities without WM presence).
  const handleNavigate = useCallback((uri: string) => {
    const target = rawMemory.entities.get(uri);
    if (target && target.subGraphs.size > 0) {
      // Prefer the active sub-graph if the entity lives in it (stay put);
      // otherwise hop to the first sub-graph it belongs to.
      if (!activeSubGraph || !target.subGraphs.has(activeSubGraph)) {
        const next = target.subGraphs.values().next().value;
        if (next && next !== 'meta') setActiveSubGraph(next);
      }
    }
    setSelectedUri(uri);
  }, [rawMemory.entities, activeSubGraph]);

  const handleNodeClick = useCallback((node: any) => {
    if (node?.id) handleNavigate(node.id);
  }, [handleNavigate]);

  if (!cg) {
    return (
      <div className="v10-view-placeholder">
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>Loading context graph...</p>
      </div>
    );
  }

  return (
    <ProjectProfileContext.Provider value={profile}>
    <div className="v10-memory-explorer">
      {/* Layer Switcher — hidden while a sub-graph page is active because the
          sub-graph page has its own layer filter (the mini pyramid). */}
      {!activeSubGraph && (
        <LayerSwitcher
          active={activeLayer}
          counts={rawMemory.counts}
          onSwitch={v => { setActiveLayer(v); setSelectedUri(null); }}
          onShare={() => setShowShare(true)}
          onImport={() => setShowImport(true)}
          onRefresh={rawMemory.refresh}
        />
      )}

      {/* Drilldown overlay */}
      {selectedEntity && (
        <KADetailView
          entity={selectedEntity}
          allEntities={rawMemory.entities}
          allTriples={rawMemory.graphTriples}
          onNavigate={handleNavigate}
          onClose={() => setSelectedUri(null)}
          contextGraphId={contextGraphId}
          onRefresh={rawMemory.refresh}
        />
      )}

      {/* Sub-graph page mode — first-class peer of the layer views */}
      {activeSubGraph && !selectedEntity && (
        <>
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={activeSubGraph}
            entities={rawMemory.entityList}
            onSelect={handleSelectSubGraph}
          />
          <SubGraphDetailView
            slug={activeSubGraph}
            rawMemory={rawMemory}
            contextGraphId={contextGraphId}
            onNodeClick={handleNodeClick}
            onSelectEntity={handleNavigate}
          />
        </>
      )}

      {/* Overview View */}
      {!activeSubGraph && activeLayer === 'overview' && !selectedEntity && (
        <>
          <ProjectOverviewCard cg={cg} memory={rawMemory} participants={participants} />
          <PendingJoinRequestsBar contextGraphId={contextGraphId} onParticipantsChanged={refreshParticipants} />
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={activeSubGraph}
            entities={rawMemory.entityList}
            onSelect={handleSelectSubGraph}
          />
          {rawMemory.loading && (
            <div className="v10-me-loading"><div className="v10-me-loading-text">Loading memory...</div></div>
          )}
          {rawMemory.error && (
            <div className="v10-me-error">Error: {rawMemory.error}</div>
          )}
          <MemoryStrip
            memory={rawMemory}
            onSwitchLayer={setActiveLayer}
            onSelectEntity={handleNavigate}
            contextGraphId={contextGraphId}
            onNodeClick={handleNodeClick}
          />
        </>
      )}

      {/* Graph Overview — one mini graph per sub-graph, side-by-side */}
      {!activeSubGraph && activeLayer === 'graph-overview' && !selectedEntity && (
        <SubGraphOverviewGrid
          contextGraphId={contextGraphId}
          memory={rawMemory}
          onNodeClick={handleNodeClick}
          onSelectSubGraph={handleSelectSubGraph}
        />
      )}

      {/* Layer Detail Views */}
      {!activeSubGraph && (activeLayer === 'wm' || activeLayer === 'swm' || activeLayer === 'vm') && !selectedEntity && (
        <>
          <SubGraphBar
            contextGraphId={contextGraphId}
            profile={profile}
            selected={activeSubGraph}
            entities={rawMemory.entityList}
            onSelect={handleSelectSubGraph}
          />
          <LayerDetailView
            layer={activeLayer}
            memory={rawMemory}
            onNodeClick={handleNodeClick}
            onSelectEntity={handleNavigate}
            contextGraphId={contextGraphId}
          />
        </>
      )}

      {/* Provenance Bar */}
      <ProvenanceBar memory={rawMemory} />

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
    </ProjectProfileContext.Provider>
  );
}
