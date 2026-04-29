import { useMemo } from 'react';
import {
  useMemoryEntities,
  type TrustLevel,
  type MemoryEntity,
  type Triple,
} from '../../hooks/useMemoryEntities.js';
import {
  VIZ_ANCHOR_TYPE, VIZ_AGENT_TYPE,
  VIZ_PRED_ANCHORED_IN, VIZ_PRED_SIGNED_BY, VIZ_PRED_CONSENSUS,
} from '../../hooks/useVerifiedMemoryAnchors.js';

export type LayerView = 'overview' | 'graph-overview' | 'wm' | 'swm' | 'vm';
export type LayerContentTab = 'items' | 'assertions' | 'graph' | 'docs';
export const TRUST_COLORS: Record<TrustLevel, string> = {
  verified: '#22c55e',
  shared: '#f59e0b',
  working: '#64748b',
};

export const TYPE_LABELS: Record<string, { icon: string; group: string }> = {
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

export const PROV_WAS_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';
export const AGENT_NS = 'http://dkg.io/ontology/agent/';
export const AGENT_CREATED_BY   = AGENT_NS + 'createdBy';
export const AGENT_PROMOTED_BY  = AGENT_NS + 'promotedBy';
export const AGENT_PUBLISHED_BY = AGENT_NS + 'publishedBy';
export const AGENT_CREATED_AT   = AGENT_NS + 'createdAt';
export const AGENT_PROMOTED_AT  = AGENT_NS + 'promotedAt';
export const AGENT_PUBLISHED_AT = AGENT_NS + 'publishedAt';
export function entityAuthorUri(e: MemoryEntity): string | null {
  for (const c of e.connections) {
    if (c.predicate === PROV_WAS_ATTRIBUTED_TO) return c.targetUri;
  }
  return null;
}

/**
 * Resolve who performed a specific layer transition on an entity.
 * Prefers the per-transition predicate (`:createdBy` / `:promotedBy` /
 * `:publishedBy`) and falls back to the authoritative
 * `prov:wasAttributedTo` when the transition agent isn't set — which is
 * the case for entities promoted in bulk by a seed script.
 */
export function transitionAgentUri(
  e: MemoryEntity,
  step: 'created' | 'promoted' | 'published',
): string | null {
  const stepPred = step === 'created'
    ? AGENT_CREATED_BY
    : step === 'promoted'
      ? AGENT_PROMOTED_BY
      : AGENT_PUBLISHED_BY;
  for (const c of e.connections) {
    if (c.predicate === stepPred) return c.targetUri;
  }
  // Fallback: whoever authored the entity is the best guess for this
  // transition's actor until the live promote/publish flow starts
  // writing its own attribution triples.
  return entityAuthorUri(e);
}

/** Parse the matching timestamp if set; otherwise return null. */
export function transitionAtISO(
  e: MemoryEntity,
  step: 'created' | 'promoted' | 'published',
): string | null {
  const stepPred = step === 'created'
    ? AGENT_CREATED_AT
    : step === 'promoted'
      ? AGENT_PROMOTED_AT
      : AGENT_PUBLISHED_AT;
  const vals = e.properties.get(stepPred);
  return vals?.[0] ?? null;
}

export function shortType(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

export function shortPred(uri: string): string {
  const hash = uri.lastIndexOf('#');
  const slash = uri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  const raw = cut >= 0 ? uri.slice(cut + 1) : uri;
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

export function entityMeta(e: MemoryEntity, profile?: { forType: (iri: string) => { icon?: string; label?: string; color?: string } } | null) {
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
export const LAYER_CONFIG: Record<'wm' | 'swm' | 'vm', {
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
export const CODE = 'http://dkg.io/ontology/code/';
export const CODE_CLASS_COLORS: Record<string, string> = {
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
export const CODE_PREDICATE_COLORS: Record<string, string> = {
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

export function buildLayerGraphOptions(
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

export function getDescription(e: MemoryEntity): string | null {
  const descPreds = ['http://schema.org/description', 'http://schema.org/text'];
  for (const p of descPreds) {
    const v = e.properties.get(p);
    if (v?.[0]) return v[0];
  }
  return null;
}

export function neighborhoodTriples(entityUri: string, allTriples: Triple[], hops: number = 2): Triple[] {
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

export function matchesSearch(e: MemoryEntity, q: string): boolean {
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

export function humanizeLabel(entity: MemoryEntity | undefined, uri: string): string {
  if (entity) return entity.label;
  const slash = uri.lastIndexOf('/');
  const hash = uri.lastIndexOf('#');
  const cut = Math.max(slash, hash);
  return cut >= 0 ? uri.slice(cut + 1) : uri;
}

// ─── Layer Switcher Bar ──────────────────────────────────────

export function useLayerTriples(memory: ReturnType<typeof useMemoryEntities>, layer: 'wm' | 'swm' | 'vm'): Triple[] {
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

export const SOURCE_CONTENT_TYPE = 'http://dkg.io/ontology/sourceContentType';
export const MARKDOWN_FORM = 'http://dkg.io/ontology/markdownForm';
export const SOURCE_FILE = 'http://dkg.io/ontology/sourceFile';
export const DKG_SIZE = 'http://dkg.io/ontology/size';

export type KAPane = 'content' | 'triples' | 'graph';

export function formatTrailTimestamp(raw: string): string {
  const s = raw.replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
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

export function formatTimelineBucket(ym: string): string {
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
// `profile:QueryCatalog` + `profile:SavedQuery` render grouped SPARQL
// pills that narrow the entity list.
export type SubGraphTab = 'items' | 'graph' | 'timeline' | 'docs';

export type SubGraphEntitySort = 'created-desc' | 'created-asc' | 'triples' | 'label';

export function entityTimestamp(e: MemoryEntity, predicate: string): number | null {
  const vals = e.properties.get(predicate);
  const raw = vals?.[0];
  if (!raw) return null;
  const cleaned = raw
    .replace(/^"|"$/g, '')
    .replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
  const t = Date.parse(cleaned);
  return Number.isNaN(t) ? null : t;
}

/** Compact relative-time formatter for entity cards. Follows the
 *  conventions most chat / activity feeds use: "now" / "2m" / "3h" /
 *  "5d" / falls back to ISO date for anything older than 30 days. */
export function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  // Older than a month — show the date so it's still useful at a glance.
  return new Date(ts).toISOString().slice(0, 10);
}
