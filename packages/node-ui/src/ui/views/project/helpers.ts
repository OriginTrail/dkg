import { useMemo } from 'react';
import {
  useMemoryEntities,
  canonicalEntityUri,
  type TrustLevel,
  type MemoryEntity,
  type Triple,
} from '../../hooks/useMemoryEntities.js';
import {
  VIZ_ANCHOR_TYPE, VIZ_AGENT_TYPE,
  VIZ_PRED_ANCHORED_IN, VIZ_PRED_SIGNED_BY, VIZ_PRED_CONSENSUS,
} from '../../hooks/useVerifiedMemoryAnchors.js';
import { memoryGraphLabels } from '../../lib/memoryLabels.js';

export type LayerView = 'overview' | 'graph-overview' | 'query' | 'wm' | 'swm' | 'vm';
export type LayerContentTab = 'items' | 'assertions' | 'graph' | 'docs';

/**
 * Whether the SWM attribution SPARQL is worth firing for the current
 * `ProjectView` route state. True only when the SWM-layer graph (the
 * sole remaining consumer) is the active view.
 *
 * PR #694 review fix — the Overview was previously included here too
 * because the activity feed read `useSwmAttributions(...).events`
 * (the WorkspaceOperation source). After the lifecycle-source
 * switch in task #23 (`useAssertionLifecycleEvents`) the Overview
 * no longer consumes this stream; firing the 5k-row SWM SPARQL on
 * every Overview render was pure waste. Trade-off: the SWM tab now
 * incurs the cold-start fetch on click instead of being pre-warmed
 * by Overview navigation. Bounded by the 10s query timeout and the
 * tab has its own loading state, so the cold-start window is
 * acceptable.
 *
 * Notably *not* gated on `selectedUri`: opening an entity detail
 * overlays the same view, and toggling the hook to `undefined` on
 * detail-open would clear its cached events and force a re-fetch on
 * detail-close, making the SWM graph's agent tints flicker out
 * during every detail round-trip (R2-Local-1, PR #656).
 */
export function shouldFetchSwmAttribution(args: {
  activeLayer: LayerView;
  activeSubGraph: string | null;
}): boolean {
  if (args.activeSubGraph) return false;
  return args.activeLayer === 'swm';
}
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
    title: 'Verifiable Memory',
    desc: 'Endorsed, published, on-chain knowledge',
    trustLabel: 'Verifiable',
    trustLevel: 'verified',
  },
};

export function layerNoun(
  layer: 'wm' | 'swm' | 'vm' | TrustLevel,
  count: number = 2,
): string {
  const normalized =
    layer === 'working' ? 'wm' :
    layer === 'shared' ? 'swm' :
    layer === 'verified' ? 'vm' :
    layer;
  const plural = count !== 1;
  if (normalized === 'vm') return plural ? 'Knowledge Assets' : 'Knowledge Asset';
  return plural ? 'Entities' : 'Entity';
}

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

// Built-in graph-viz auto-tints (schema.org → purple, prov → blue, etc) that
// would otherwise override our layer default for any node with a matching
// rdf:type. We neutralise them by mapping each to `defaultNodeColor` so the
// layer color wins for non-attribution nodes. SWM agent attribution still
// works because per-URI `nodeColors` sits ABOVE namespaceColors in the
// style-engine priority stack. Future coloring rework can drop a richer
// taxonomy in here without touching the rest of the wiring.
export function neutraliseBuiltinNamespaces(defaultColor: string): Record<string, string> {
  return {
    'https://schema.org/': defaultColor,
    'http://www.w3.org/ns/prov#': defaultColor,
    'http://xmlns.com/foaf/0.1/': defaultColor,
    'http://purl.org/dc/terms/': defaultColor,
  };
}

export function buildLayerGraphOptions(
  layer: 'wm' | 'swm' | 'vm',
  nodeColors?: Record<string, string>,
) {
  const { color } = LAYER_CONFIG[layer];
  // VM ("Verifiable Memory") is the DKG hero view — we deliberately juice it:
  // thicker & brighter edges, bigger hub/leaf spread, higher gradient so every
  // node reads as a "trust gem". WM/SWM stay quieter so VM clearly wins the
  // eye. This is the visual equivalent of "this knowledge is anchored on-chain".
  const isVM = layer === 'vm';
  return {
    labelMode: 'humanized' as const,
    renderer: '2d' as const,
    labels: memoryGraphLabels({ minZoomForLabels: isVM ? 0.2 : 0.3 }),
    style: {
      classColors: CODE_CLASS_COLORS,
      predicateColors: CODE_PREDICATE_COLORS,
      namespaceColors: neutraliseBuiltinNamespaces(color),
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

/**
 * Returns the strict N-hop neighbourhood around `entityUri`: every triple
 * whose subject AND object both sit inside the visited set after `hops`
 * BFS expansions from the focal entity. Edges that would dangle from a
 * frontier node to a node (N+1) hops out are deliberately excluded —
 * otherwise rendering pulls in nodes that have no visible path back to
 * the focal entity, producing visually disconnected components in the
 * detail graph. If you need the loose "edge cut" semantics (frontier
 * node ↔ outside node), don't reuse this — define a separate helper
 * with clear name + JSDoc so the two semantics stay distinguishable.
 */
export function neighborhoodTriples(entityUri: string, allTriples: Triple[], hops: number = 2): Triple[] {
  // Canonicalise both sides of the comparison: `entityUri` is the
  // canonical form (`MemoryEntity.uri`) but `allTriples` keeps raw
  // daemon strings, which can ship wrapped as `<urn:...>`. A bare
  // entity URI would miss wrapped-IRI rows that the entity-detail
  // Triples tab + KADetailView header (now canonicalised) include —
  // the graph pane right below would silently drop them.
  const canonicalSubject = (t: Triple) => canonicalEntityUri(t.subject);
  const canonicalObject = (t: Triple) => canonicalEntityUri(t.object);
  const visited = new Set<string>([entityUri]);
  let frontier = new Set<string>([entityUri]);

  for (let i = 0; i < hops; i++) {
    const nextFrontier = new Set<string>();
    for (const t of allTriples) {
      const s = canonicalSubject(t);
      const o = canonicalObject(t);
      if (frontier.has(s) && !visited.has(o)) {
        nextFrontier.add(o);
      }
      if (frontier.has(o) && !visited.has(s)) {
        nextFrontier.add(s);
      }
    }
    for (const u of nextFrontier) visited.add(u);
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  return allTriples.filter(t => visited.has(canonicalSubject(t)) && visited.has(canonicalObject(t)));
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
  const colon = uri.lastIndexOf(':');
  const cut = Math.max(slash, hash, colon);
  const tail = cut >= 0 ? uri.slice(cut + 1) : uri;
  const decoded = (() => {
    try { return decodeURIComponent(tail); }
    catch { return tail; }
  })();
  if (/^urn:dkg:extraction:[^\s]+$/i.test(uri)) {
    const short = decoded.replace(/-/g, '').replace(/_+/g, ' ').slice(0, 12).trim();
    return short ? `Extraction ${short}` : 'Extraction';
  }
  return decoded || uri;
}

// ─── Layer Switcher Bar ──────────────────────────────────────

// Tight pure mirror of `components.tsx::isResourceNode` — kept here so
// the residue filter below stays in one file and doesn't create a
// circular import. Literal-valued triples (`"..."`, blank/whitespace,
// non-IRI tokens) return false; resource-shaped values return true.
function isResourceObject(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('"')) return false;
  if (trimmed.startsWith('_:')) return true;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

/**
 * Admission predicate for sub-graph-scoped triple selectors. PR #772
 * sweep 1 Bug A locked the three-rule shape on `scopedTriples`; Task #19
 * surfaced the same lesson at `singleLayerPanelTriples` (the two
 * selectors had parallel inline copies, the second never picked up the
 * Bug A fix, the leakage re-appeared on a different surface). Extracted
 * here so the next routing change stays consistent across both
 * consumers — and any future third consumer.
 *
 * Rules (in order):
 *   1. Tagged triple → routes to the exact slug (named branch only;
 *      Root carries no tagged triples by definition).
 *   2. Tagged triple with a non-matching slug → REJECTED, even if an
 *      endpoint is shared with this scope. An entity in multiple
 *      sub-graphs is shared territory, not a broadcast channel.
 *   3. Untagged triple → admitted via endpoint-in-scope check. This is
 *      the post-promotion recovery branch — promoting an assertion
 *      erases the `subGraph` origin tag from the resulting SWM/VM
 *      triples; without rule 3 promoted entities lose their rdf:type,
 *      labels, literal properties, and cross-layer edges in named
 *      views.
 *
 * `requireResourceObject` toggles the object-side admission shape:
 *   - false (default — `scopedTriples` shape) — any object whose
 *     canonical URI is in scope admits, including literal-shaped
 *     orphans that happen to match a URI string. Matches the historical
 *     scopedTriples behavior.
 *   - true (`singleLayerPanelTriples` shape) — only resource-shaped
 *     objects admit; literals reach the panel via the subject-local
 *     property branch upstream of this predicate.
 */
export function admitTripleForScope(
  t: { subject: string; object: string; subGraph?: string | undefined },
  opts: {
    slug: string;
    isRoot: boolean;
    scopedUris: ReadonlySet<string>;
    requireResourceObject?: boolean;
  },
): boolean {
  if (!opts.isRoot && t.subGraph === opts.slug) return true;
  // Rule 2: explicit non-matching tag — reject regardless of endpoint
  // membership. This is the load-bearing exact-tag-routing rule from
  // PR #772 sweep 1 Bug A + Task #19.
  if (t.subGraph) return false;
  if (opts.scopedUris.has(t.subject)) return true;
  return opts.requireResourceObject
    ? (isResourceObject(t.object) && opts.scopedUris.has(t.object))
    : opts.scopedUris.has(t.object);
}

export function useLayerTriples(memory: ReturnType<typeof useMemoryEntities>, layer: 'wm' | 'swm' | 'vm'): Triple[] {
  const targetLayer = LAYER_CONFIG[layer].trustLevel;
  return useMemo(() => {
    const seen = new Set<string>();
    const out: Triple[] = [];
    for (const t of memory.allTriples) {
      if (t.layer !== targetLayer) continue;
      // Skip residual triples for a subject that has been promoted past
      // this layer: post-promote the daemon currently leaves the WM
      // `/assertion/<addr>/<name>` graphs on disk, so a promoted entity's
      // WM triples keep coming back from `wmSparql` even though the
      // entity has logically moved to SWM. The entity's canonical layer
      // is `trustLevel` (its highest layer); a triple whose subject has
      // moved past `targetLayer` would otherwise be counted on the
      // prior layer's tally. Triples whose subject has no entity record
      // (literal orphans / class IRIs that only ever appear as objects)
      // pass through unfiltered.
      //
      // R2-1 fix: `entities.get` is keyed by the canonical (trimmed,
      // unwrapped) URI per `buildEntities`. The daemon sometimes ships
      // subjects wrapped (`<urn:...>`) — looking them up raw misses the
      // entity record, silently bypasses this filter, and the phantom
      // triple returns. Canonicalise first.
      const subjectEntity = memory.entities.get(canonicalEntityUri(t.subject));
      if (subjectEntity && subjectEntity.trustLevel !== targetLayer) continue;
      // Issue-A fix (object-side, asymmetric C17 form): a WM triple
      // `wm-entity-A relatesTo swm-entity-B` (B promoted to SWM) has
      // a WM subject but its object has moved past WM. The triple is
      // residue — counting it on WM would inflate the count and
      // would leak the promoted-entity URI as an object in any
      // downstream rendering. Drop resource→resource edges whose
      // object has been promoted past the requested layer.
      // Literal-valued triples (labels, names, etc.) have a
      // non-resource object so this check no-ops; they always pass.
      //
      // This stays in `useLayerTriples` because it's a per-LAYER
      // correctness rule (a triple shouldn't be tallied on a layer
      // where neither endpoint canonically lives). Entity-filtering
      // for the graph view happens downstream in `LayerGraphPanel`
      // via `filterTriplesToEntities` — `useLayerTriples` is the
      // honest layer source for triple counts and VM hero stats.
      if (isResourceObject(t.object)) {
        const canonicalObject = canonicalEntityUri(t.object);
        const objectEntity = memory.entities.get(canonicalObject);
        if (objectEntity && objectEntity.trustLevel !== targetLayer) continue;
      }
      // Canonicalise the dedup key so wrapped/bare duplicates of the
      // same `(s,p,o)` collapse — mirrors `dedupeTriplesBySpo` in
      // `ProjectView.tsx` and `buildEntities`' per-entity SPO key.
      // Without this the layer header / graph counts a wrapped-IRI
      // duplicate row twice while the KADetailView Triples tab
      // (canonicalised) shows it once.
      const key = `${canonicalEntityUri(t.subject)}|${t.predicate}|${canonicalEntityUri(t.object)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [memory.allTriples, memory.entities, targetLayer]);
}

const RDF_TYPE_URI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
function isRdfType(predicate: string): boolean {
  // Match the wrapped/unwrapped + whitespace tolerance used elsewhere
  // (see `splitGraphTriplesForShelf::graphNodeKey`); raw equality
  // would let a `<rdf:type>` predicate slip past this guard.
  const trimmed = predicate.trim();
  const unwrapped = trimmed.startsWith('<') && trimmed.endsWith('>')
    ? trimmed.slice(1, -1)
    : trimmed;
  return unwrapped === RDF_TYPE_URI;
}

/**
 * Task #25 — graph-render-side entity filter. Used by `LayerGraphPanel`
 * just before `RdfGraph`. Drops resource→resource edges whose object
 * isn't in the layer's `entityList` membership (same rule the Entities
 * tab uses: `e.types.length > 0 || e.properties.size > 0 || e.connections.length > 0`).
 * Pure-object URIs — vocabulary constants (`cbv:BizStep-packing`),
 * IPFS file refs (`ipfs://...`), DID identity refs (`did:...`),
 * blank-node compound-property anchors — drop uniformly. If the
 * object IS a first-class entity in the layer (e.g. a DID with its
 * own rdf:type), the edge is kept.
 *
 * Lives in `helpers.ts` (not `components.tsx`) so it stays pure and
 * unit-testable without rendering. `rdf:type` is exempt: class IRIs
 * aren't entities but the triple is needed for `classColors`, and
 * the downstream `splitGraphTriplesForShelf` rdf:type guard already
 * prevents the class IRI from becoming a canvas node.
 *
 * `entityUris` is the set of canonical URIs of entities in the
 * **layer's** entityList — i.e. callers should pass
 * `memory.entityList.filter(e => e.trustLevel === layer.trustLevel)`
 * mapped to canonical URIs. (`LayerGraphPanel` already has the layer
 * to do that filtering with.)
 */
export function filterTriplesToEntities(
  triples: Triple[],
  entityUris: ReadonlySet<string>,
  options?: { focalSubjects?: ReadonlySet<string> },
): Triple[] {
  const out: Triple[] = [];
  const focal = options?.focalSubjects;
  for (const t of triples) {
    // Subject-side check (Codex EwIbn): keep only triples whose subject
    // is a real entity per the entityList membership rule. In practice
    // every subject of a triple is in entityList (it has at least one
    // type/property/connection), but a scoped entityUris (per-sub-graph,
    // KADetailView with allEntities filtered down, etc.) can have
    // subjects that aren't in the scope. Drop those. Callers can pass
    // `focalSubjects` to exempt subjects that must always render (e.g.
    // KADetailView's focal entity).
    const subjectCanonical = canonicalEntityUri(t.subject);
    if (!entityUris.has(subjectCanonical) && !focal?.has(subjectCanonical)) continue;
    // Object-side check (the original gate): drop resource→resource
    // edges where the object isn't a known entity. `rdf:type` is exempt
    // because class IRIs aren't entities but the triple is needed for
    // `classColors`; the downstream `splitGraphTriplesForShelf`
    // `rdf:type` guard prevents the class IRI from becoming a canvas
    // node anyway.
    if (isResourceObject(t.object)) {
      if (!isRdfType(t.predicate) && !entityUris.has(canonicalEntityUri(t.object))) continue;
    }
    out.push(t);
  }
  return out;
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
