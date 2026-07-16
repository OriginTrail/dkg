import { useMemo, useState, useEffect, lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { useMemoryEntities, canonicalEntityUri, type MemoryEntity, type Triple } from '../../../hooks/useMemoryEntities.js';
import { decodeRdfStringLiteral } from '../../../../rdf-literal.js';
import { MEMORY_LABEL_PREDICATES } from '../../../lib/memoryLabels.js';
import { useLayoutStore } from '../../../stores/layout.js';
import { useVerifiableMemoryAnchors, type PublishAnchor } from '../../../hooks/useVerifiableMemoryAnchors.js';
import { useSwmAttributions, type AgentPaletteEntry, type SwmAttributionsResult } from '../../../hooks/useSwmAttributions.js';
import { TRUST_COLORS, LAYER_CONFIG, buildLayerGraphOptions, humanizeLabel, useLayerTriples, filterTriplesToEntities } from '../helpers.js';
import { EmptyState, toneForLayer } from '../../../components/ContextGraphPrimitives.js';

export const RdfGraph = lazy(() =>
  import('@origintrail-official/dkg-graph-viz/react').then(m => ({ default: m.RdfGraph }))
);

const RDF_TYPE_URI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL_PREDICATE_PRIORITY = new Map<string, number>(
  MEMORY_LABEL_PREDICATES.map((p, i) => [p, i]),
);

interface SingletonShelfItem {
  uri: string;
  label: string;
}

function isResourceNode(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('"')) return false;
  if (trimmed.startsWith('_:')) return true;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return true;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

function graphNodeKey(value: string): string {
  // Match the trim+unwrap shape used by graph-model.cleanUri and
  // useMemoryEntities.canonicalEntityUri so the shelf groups nodes the
  // same way the renderer does (avoids `' <urn:x> '` and `'<urn:x>'`
  // being treated as different keys).
  const trimmed = value.trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1) : trimmed;
}

function splitGraphTriplesForShelf(triples: Triple[]): { canvasTriples: Triple[]; singletonItems: SingletonShelfItem[] } {
  const subjects = new Set<string>();
  const degree = new Map<string, number>();
  const labels = new Map<string, string>();
  // Track which label predicate (by MEMORY_LABEL_PREDICATES index) supplied
  // each label so a later, higher-priority predicate can win regardless of
  // query order — matches the precedence used elsewhere in the UI.
  const labelPriority = new Map<string, number>();

  for (const triple of triples) {
    const subjectKey = graphNodeKey(triple.subject);
    subjects.add(subjectKey);
    const priority = LABEL_PREDICATE_PRIORITY.get(triple.predicate);
    if (priority !== undefined) {
      const label = decodeRdfStringLiteral(triple.object).trim();
      if (label) {
        const existing = labelPriority.get(subjectKey);
        if (existing === undefined || priority < existing) {
          labels.set(subjectKey, label);
          labelPriority.set(subjectKey, priority);
        }
      }
    }
    // Normalise the predicate the same way subjects/objects are normalised
    // — otherwise a wrapped (`<rdf:type>`) or whitespace-padded predicate
    // slips past this guard, gets counted as a regular resource edge, and
    // pulls its class IRI into the connected graph as a phantom node
    // while inflating the subject's degree.
    if (graphNodeKey(triple.predicate) === RDF_TYPE_URI || !isResourceNode(triple.object)) continue;
    const objectKey = graphNodeKey(triple.object);
    degree.set(subjectKey, (degree.get(subjectKey) ?? 0) + 1);
    degree.set(objectKey, (degree.get(objectKey) ?? 0) + 1);
  }

  const singletonItems = [...subjects]
    .filter(key => (degree.get(key) ?? 0) === 0)
    .map(key => ({
      uri: key,
      label: labels.get(key) ?? humanizeLabel(undefined, key),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (singletonItems.length === 0) return { canvasTriples: triples, singletonItems };

  const singletonSet = new Set(singletonItems.map(item => item.uri));
  return {
    // Drop triples whose *subject* OR *object* is on the shelf. Filtering
    // only by subject leaves a triple like `<urn:onCanvas> mentions <urn:shelved>`
    // in the canvas, rendering `urn:shelved` as a connected node while a
    // chip with the same URI also sits in the shelf — the user sees the
    // same entity in two places, possibly with two different labels.
    canvasTriples: triples.filter(triple =>
      !singletonSet.has(graphNodeKey(triple.subject))
      && !singletonSet.has(graphNodeKey(triple.object))
    ),
    singletonItems,
  };
}

function defaultGraphScopeLabel(layer: 'wm' | 'swm' | 'vm'): string {
  if (layer === 'wm') return 'Working Memory graph: local entities connected by entity-to-entity triples from loaded layer data.';
  if (layer === 'swm') return 'Shared Working Memory graph: promoted shared entities connected by entity-to-entity triples from loaded layer data.';
  return 'Verifiable Memory graph: published knowledge assets, provenance anchors, and connected entity-to-entity triples from loaded layer data.';
}

function GraphSingletonShelf({
  items,
  onSelect,
}: {
  items: SingletonShelfItem[];
  onSelect?: (uri: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="v10-graph-singleton-shelf" aria-label="Standalone entities without visible links">
      <div
        className="v10-graph-singleton-head"
        title="Entities with no visible links are grouped here to keep the graph readable."
      >
        <span>Standalone entities</span>
        <span>{items.length}</span>
      </div>
      <div className="v10-graph-singleton-list">
        {items.map(({ uri, label }) => {
          return (
            <button
              key={uri}
              type="button"
              className="v10-graph-singleton-item"
              title={uri}
              onClick={() => onSelect?.(uri)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// PR #818 Codex sweep 4 (finding 3) — extracted shared cap helper.
// Both `SubGraphOverviewGrid`'s named-card path and the Root mini-
// card consume this so the cap shape stays in lockstep across the
// dual paths (the post-PR-#793 polish cycle accumulated two
// parallel inline copies; sweep 2-3 fixes had to be applied twice
// and qa caught the parity drift). Extracting it here closes the
// duplication and gives one site to evolve the sampling rule.
//
// Sampling strategy: cluster topology matters more than uniform
// random first-N. We keep every triple for the N heaviest-degree
// subjects so the rendered slice reads as a representative slice
// of the bucket's connected structure.
//
// Pre-check `kept + subjectDegree > MAX_PER_CARD` BEFORE adding so
// a single dominant subject can't smuggle the whole heavy cluster
// through (`break` shape would leave 100s of rows unaccounted for
// because `keep.has(subject)` is true for every row of the
// dominant subject). `continue` (not `break`) so the loop scans
// further for smaller satellites that still fit — denser pack at
// the cap, friendlier user-facing outcome than under-fill.
//
// Residual fallback: when EVERY subject's degree alone exceeds
// MAX_PER_CARD, the pre-check rejects every subject and exits
// with an empty `keep`. The card would render the empty-body
// branch on a clearly-populated bucket — strictly worse UX. Fall
// back to admitting the heaviest subject so SOMETHING renders;
// the post-`slice(0, MAX_PER_CARD)` then trims its long tail.
// The rendered slice loses some cluster topology in that residual
// case, but the user sees the dominant hub vs an empty card.
const MAX_PER_CARD = 2500;
export function applyHeaviestSubjectsCap(triples: Triple[], maxPerCard: number = MAX_PER_CARD): Triple[] {
  if (triples.length <= maxPerCard) return triples;
  const degree = new Map<string, number>();
  for (const t of triples) degree.set(t.subject, (degree.get(t.subject) ?? 0) + 1);
  const order = [...degree.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uri]) => uri);
  const keep = new Set<string>();
  let kept = 0;
  for (const uri of order) {
    const subjectDegree = degree.get(uri) ?? 0;
    if (kept + subjectDegree > maxPerCard) continue;
    keep.add(uri);
    kept += subjectDegree;
  }
  if (keep.size === 0 && order.length > 0) keep.add(order[0]);
  return triples.filter(t => keep.has(t.subject)).slice(0, maxPerCard);
}

export function GraphSurface({
  title,
  scopeLabel,
  tone,
  className,
  rail,
  overlay,
  showScopeLabel = true,
  singletonItems = [],
  onSingletonClick,
  renderGraph,
}: {
  title: string;
  scopeLabel: string;
  tone: 'wm' | 'swm' | 'vm';
  className?: string;
  rail?: ReactNode;
  overlay?: ReactNode;
  showScopeLabel?: boolean;
  singletonItems?: SingletonShelfItem[];
  onSingletonClick?: (uri: string) => void;
  renderGraph: (expanded: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded]);

  const expandButton = (
    <button
      type="button"
      className={`v10-graph-expand-btn${showScopeLabel ? '' : ' in-canvas'}`}
      onClick={() => setExpanded(true)}
      title={`Expand ${title}`}
      aria-label={`Expand ${title}`}
    >
      &#10530;
    </button>
  );

  const body = (expandedView: boolean) => (
    <>
      {/* Don't render the scope-bar + expand-button inside the expanded
          modal — the modal has its own × close affordance and a dedicated
          subtitle. The previous CSS-only hide (display:none) left the
          duplicate expand button in the a11y tree. */}
      {showScopeLabel && !expandedView && (
      <div className="v10-graph-shell-bar">
        <div className="v10-graph-scope" title={scopeLabel}>{scopeLabel}</div>
        {expandButton}
      </div>
      )}
      <div className="v10-graph-body">
        <div className="v10-graph-canvas">
          {!showScopeLabel && !expandedView && expandButton}
          <div className="v10-graph-view">
            {renderGraph(expandedView)}
          </div>
          {overlay && <div className="v10-graph-overlay">{overlay}</div>}
          <GraphSingletonShelf items={singletonItems} onSelect={onSingletonClick} />
        </div>
        {rail && <aside className="v10-graph-rail">{rail}</aside>}
      </div>
    </>
  );

  return (
    <>
      <div className={`v10-graph-shell v10-graph-shell-${tone}${className ? ` ${className}` : ''}`}>
        {!expanded && body(false)}
      </div>
      {expanded && (
        <div
          className="v10-graph-expanded-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`${title} expanded`}
          onClick={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
        >
          <div className={`v10-graph-expanded-panel v10-graph-shell-${tone}`}>
            <div className="v10-graph-expanded-head">
              <div>
                <div className="v10-graph-expanded-title">{title}</div>
                <div className="v10-graph-expanded-subtitle">{scopeLabel}</div>
              </div>
              <button
                type="button"
                className="v10-graph-expanded-close"
                onClick={() => setExpanded(false)}
                aria-label={`Close expanded ${title}`}
              >
                ×
              </button>
            </div>
            <div className="v10-graph-expanded-body">
              {body(true)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Layer graph panel (used by LayerContent in both inline and full views) ──

export function LayerGraphPanel({
  layer,
  triples,
  onNodeClick,
  contextGraphId,
  scopeLabel,
  trustLegendActiveLayer,
  title: titleOverride,
  scopeEntities,
  swmAttribution,
  layerEntities,
  nodeColorsOverride,
}: {
  layer: 'wm' | 'swm' | 'vm';
  triples: Triple[];
  onNodeClick?: (node: any) => void;
  contextGraphId?: string;
  scopeLabel?: string;
  trustLegendActiveLayer?: 'wm' | 'swm' | 'vm' | null;
  title?: string;
  /**
   * Per-URI colour override passed straight into the graph style's
   * `nodeColors` slot. Sits ABOVE `classColors` / `namespaceColors`
   * in the style-engine priority stack, so the caller wins for
   * specified URIs while unspecified nodes still inherit the
   * existing class/namespace palette and layer defaults. Used by
   * `SubGraphDetailView` (multi-layer view) to paint per-entity
   * trust colour (TRUST_COLORS keyed by `entity.trustLevel`) on
   * top of the WM-default-layer fallback (fold-in #6, PR #677
   * follow-up). Omit on the WM/SWM/VM layer tabs — SWM's own
   * attribution palette via `swmAttribution` still runs.
   */
  nodeColorsOverride?: Record<string, string>;
  // When provided, the panel guarantees every URI in this set appears
  // either on the canvas or on the singleton shelf. Used by callers
  // (e.g. SubGraphDetailView) whose entity scope can include entities
  // that have no triples in the rendered triple set (e.g. promoted SWM
  // entities whose triples live in `_shared_memory` and don't pass the
  // sub-graph filter). Without this, those entities silently disappear
  // from the Graph tab even though the Entities tab shows them.
  scopeEntities?: ReadonlyArray<{ uri: string; label: string }>;
  /**
   * Codex Code6 (PR #656) — when the parent already calls
   * `useSwmAttributions` (e.g. `ProjectView` shares one result between
   * the Overview activity feed and the SWM graph), it can pass that
   * result in here to suppress the internal hook call. Without this,
   * the SPARQL fires twice on every SWM-tab render. When omitted, the
   * panel falls back to the local hook (the long-standing behaviour
   * preserved for all other callsites — `SubGraphDetailView`,
   * `EntityDetailView`, tests).
   */
  swmAttribution?: SwmAttributionsResult;
  /**
   * Task #25 (PR #677) — the layer's `entityList` (entities whose
   * canonical layer matches this panel's `layer`). When supplied,
   * the panel filters object-side resources against entity membership
   * via `filterTriplesToEntities` so pure-object URIs (vocabulary
   * constants, `ipfs://` file refs, `did:` identity refs, blank-node
   * compound-property anchors) don't render as canvas nodes. Omit
   * (or pass an empty array) to preserve the legacy behaviour where
   * the panel renders every resource referenced in `triples`.
   */
  layerEntities?: ReadonlyArray<MemoryEntity>;
}) {
  const { title: layerTitle } = LAYER_CONFIG[layer];
  const title = titleOverride ?? layerTitle;
  const theme = useLayoutStore(s => s.theme);

  // All URIs that already appear as subject or object in the base VM triples.
  // We pass this into the anchor hook so synthetic anchor→entity edges only
  // get emitted for entities that actually render, avoiding dangling anchors.
  const visibleEntityUris = useMemo(() => {
    if (layer !== 'vm') return undefined;
    const s = new Set<string>();
    for (const t of triples) {
      s.add(t.subject);
      // Literals (`"..."`) are never anchor roots; skip them.
      if (isResourceNode(t.object)) s.add(t.object);
    }
    return s;
  }, [triples, layer]);

  // VM-only provenance decorations — synthetic anchor + agent identity
  // triples injected around every published KA root. Keeps the data on-disk
  // untouched; the "halo" of trust lives purely in the viz.
  const { anchors, decorationTriples } = useVerifiableMemoryAnchors(
    layer === 'vm' && contextGraphId ? contextGraphId : undefined,
    visibleEntityUris,
  );

  // SWM-only agent attribution — colours each root KA by the agent that
  // promoted it, so the graph reads as "who proposed what". Also surfaces
  // conflict nodes (multi-agent disagreement) and an agent palette for the
  // legend. No-op on WM / VM.
  //
  // Codex Code6 (PR #656) — when the parent passes `swmAttribution`
  // it has already paid for the SPARQL (e.g. `ProjectView` shares the
  // result with the Overview activity feed). Skip the internal hook's
  // network call by passing `undefined`, then read from the prop. The
  // hook still runs (rules of hooks) but short-circuits to empty state.
  const localSwmAttr = useSwmAttributions(
    layer === 'swm' && contextGraphId && !swmAttribution ? contextGraphId : undefined,
  );
  const swmAttr = swmAttribution ?? localSwmAttr;

  // Task #25 (PR #677) — entity-only graph filter, render-path side.
  // `useLayerTriples` stays the honest source of all layer triples
  // (triple counts, VM hero stats depend on that). The graph view is
  // the only surface that wants "@id-entities only" semantics, so the
  // filter lives here. Callers that don't pass `layerEntities` (older
  // callsites, tests) keep the legacy behaviour of rendering every
  // resource referenced in `triples`.
  //
  // Codex Ev_St/EwIbh: the filter must run on the BASE layer triples
  // BEFORE `decorationTriples` are merged in. VM provenance overlay
  // triples (`urn:dkg:viz:anchor:*`, `urn:dkg:viz:agent:*`) are
  // synthetic, never present in `layerEntities`, and must always
  // render. Filtering after the merge would strip the entire trust
  // halo from published Knowledge Assets.
  const filteredBaseTriples = useMemo(() => {
    if (!layerEntities || layerEntities.length === 0) return triples;
    const entityUris = new Set<string>();
    for (const e of layerEntities) entityUris.add(canonicalEntityUri(e.uri));
    return filterTriplesToEntities(triples, entityUris);
  }, [triples, layerEntities]);

  const uniqueTriples = useMemo(() => {
    const seen = new Set<string>();
    const out: Triple[] = [];
    const push = (t: Triple) => {
      const key = `${t.subject}|${t.predicate}|${t.object}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ subject: t.subject, predicate: t.predicate, object: t.object } as Triple);
    };
    for (const t of filteredBaseTriples) push(t);
    // Decoration triples are only produced for VM; for other layers the
    // hook returns an empty array so this loop is a no-op. They
    // intentionally bypass `filterTriplesToEntities` — synthetic viz
    // nodes aren't in `entityList` by design and must always show as
    // the trust halo around published KAs.
    for (const t of decorationTriples) push(t);
    return out;
  }, [filteredBaseTriples, decorationTriples]);

  const renderTriples = uniqueTriples;

  // Per-URI node tints by layer:
  //   • SWM uses `swmAttr.nodeColors` (agent attribution).
  //   • Multi-layer sub-graph callers pass `nodeColorsOverride`
  //     keyed by `entity.trustLevel` so the canvas matches the
  //     entity's canonical layer (fold-in #6).
  //   • WM / VM layer tabs use neither — classColors rules.
  // When both are supplied (SWM sub-graph view), merge with the
  // caller's override taking precedence — it's the more specific
  // intent. The style engine still falls back to classColors /
  // namespaceColors / `defaultNodeColor` for unspecified URIs.
  const mergedNodeColors = useMemo(() => {
    const swm = layer === 'swm' ? swmAttr.nodeColors : undefined;
    if (!swm && !nodeColorsOverride) return undefined;
    if (!swm) return nodeColorsOverride;
    if (!nodeColorsOverride) return swm;
    return { ...swm, ...nodeColorsOverride };
  }, [layer, swmAttr.nodeColors, nodeColorsOverride]);
  const graphOptions = useMemo(
    () => buildLayerGraphOptions(layer, mergedNodeColors),
    [layer, mergedNodeColors],
  );
  const { canvasTriples, singletonItems } = useMemo(
    () => splitGraphTriplesForShelf(renderTriples),
    [renderTriples],
  );

  // Union `singletonItems` (URIs that are *subjects* of triples but have
  // no resource→resource edges) with any caller-supplied scope entity
  // that doesn't already appear on canvas or shelf. Without this, an
  // entity that exists in the scope (e.g. `SubGraphDetailView`'s
  // `scopedEntities`) but has no triples in the rendered triple set
  // — say a promoted SWM entity whose triples live in `_shared_memory`
  // and don't pass the sub-graph scope filter — silently disappears.
  const shelfItems = useMemo(() => {
    if (!scopeEntities || scopeEntities.length === 0) return singletonItems;
    const known = new Set(singletonItems.map(item => graphNodeKey(item.uri)));
    for (const t of canvasTriples) {
      known.add(graphNodeKey(t.subject));
      if (isResourceNode(t.object)) known.add(graphNodeKey(t.object));
    }
    const extra: SingletonShelfItem[] = [];
    for (const entity of scopeEntities) {
      const key = graphNodeKey(entity.uri);
      if (known.has(key)) continue;
      known.add(key);
      extra.push({ uri: key, label: entity.label || humanizeLabel(undefined, key) });
    }
    if (extra.length === 0) return singletonItems;
    return [...singletonItems, ...extra].sort((a, b) => a.label.localeCompare(b.label));
  }, [singletonItems, canvasTriples, scopeEntities]);
  const graphKey = `${contextGraphId ?? 'context'}:${layer}`;
  const swmAttributionPending = layer === 'swm' && Boolean(contextGraphId) && swmAttr.loading;
  const graphTitle = `${title} graph`;
  const resolvedScopeLabel = scopeLabel ?? defaultGraphScopeLabel(layer);
  const showGraphScopeLabel = trustLegendActiveLayer === null && Boolean(scopeLabel);
  const nodeLayerContext = trustLegendActiveLayer === null ? undefined : trustLegendActiveLayer ?? layer;
  const hasOverlay = (layer === 'vm' && anchors.length > 0) || (layer === 'swm' && swmAttr.palette.length > 0);
  const overlay = hasOverlay ? (
    <>
      {layer === 'vm' && anchors.length > 0 && (
        <VerifiedGraphLegend anchors={anchors} />
      )}
      {layer === 'swm' && swmAttr.palette.length > 0 && (
        <SwmAttributionLegend palette={swmAttr.palette} conflicts={swmAttr.conflicts.length} />
      )}
    </>
  ) : null;
  const graphViewConfig = useMemo(() => ({
    name: `${graphKey}:${theme}`,
    palette: theme,
  }), [graphKey, theme]);

  if (uniqueTriples.length === 0 && shelfItems.length === 0) {
    return (
      <GraphSurface
        title={graphTitle}
        scopeLabel={resolvedScopeLabel}
        tone={layer}
        className="v10-graph-view-fill"
        showScopeLabel={showGraphScopeLabel}
        renderGraph={() => (
          <div className="v10-layer-empty-shell">
            <EmptyState
              compact
              tone={toneForLayer(layer)}
              icon={LAYER_CONFIG[layer].icon}
              title={`No triples in ${title}`}
              description="The graph will appear when this layer has connected triples."
            />
          </div>
        )}
      />
    );
  }

  if (swmAttributionPending) {
    return (
      <GraphSurface
        title={graphTitle}
        scopeLabel={resolvedScopeLabel}
        tone="swm"
        className="v10-graph-view-fill"
        showScopeLabel={showGraphScopeLabel}
        renderGraph={() => (
          <div className="v10-layer-empty-shell">
            <EmptyState
              compact
              tone="swm"
              icon={LAYER_CONFIG.swm.icon}
              title="Loading Shared Working Memory attribution..."
              description="Agent colors are being prepared before the graph renders."
            />
          </div>
        )}
      />
    );
  }

  return (
    <GraphSurface
      title={graphTitle}
      scopeLabel={resolvedScopeLabel}
      tone={layer}
      className="v10-graph-view-fill"
      overlay={overlay}
      showScopeLabel={showGraphScopeLabel}
      singletonItems={shelfItems}
      onSingletonClick={(uri) => onNodeClick?.(nodeLayerContext ? { id: uri, trustLayer: nodeLayerContext } : { id: uri })}
      renderGraph={(expanded) => (
        canvasTriples.length > 0 ? (
          <Suspense fallback={<span className="v10-graph-placeholder">Loading graph...</span>}>
            <RdfGraph
              key={`${graphKey}:${expanded ? 'expanded' : 'inline'}:${canvasTriples.length}`}
              data={canvasTriples}
              format="triples"
              options={graphOptions}
              viewConfig={graphViewConfig}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
              onNodeClick={nodeLayerContext
                ? (node: any) => onNodeClick?.({ ...node, trustLayer: nodeLayerContext })
                : onNodeClick}
              initialFit
            />
          </Suspense>
        ) : (
          <div className="v10-graph-placeholder v10-graph-placeholder-centered">
            Connected graph appears when this layer has linked entities.
          </div>
        )
      )}
    />
  );
}

// ─── SWM attribution legend (docked rail) ────────────
// Maps each palette slot to the agent who promoted the corresponding KA roots.
// N3's broader multi-agent attribution remains gated, so this stays scoped to
// the root attribution data already available today.
export function SwmAttributionLegend({ palette, conflicts }: { palette: AgentPaletteEntry[]; conflicts: number }) {
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

// ─── Verifiable Memory graph legend (docked rail) ─────────
// Explains the synthetic VM anchor and agent decoration triples produced by
// `useVerifiableMemoryAnchors` without pulling in the later VM metadata work.
export function VerifiedGraphLegend({ anchors }: { anchors: PublishAnchor[] }) {
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
    <div className="v10-vm-legend" aria-label="Verifiable Memory legend">
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

// S2 finalize: the expandable WM/SWM/VM `MemoryStrip` /
// `MemoryStripExpanded` duplicated the layer tabs and was removed
// from the Overview branch in PR #615. The exports lingered with
// no production caller. Removed here per "no backwards-compat
// shims" (initial release).

