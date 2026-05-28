/**
 * Compact horizontal strip of sub-graph chips. Sits above the layer
 * detail view and scopes the whole project view to the selected
 * sub-graph (or "All").
 *
 * Visual styling is fully driven by the project profile: each SubGraphBinding
 * contributes its icon/color/label. Per-sub-graph entity/triple counts come
 * from the daemon's GET /api/sub-graph/list endpoint. If the profile or list
 * endpoint fail, this component renders nothing — it's purely additive.
 */
import React from 'react';
import { fetchSubGraphs, type SubGraphInfo } from '../api.js';
import type { ProjectProfile } from '../hooks/useProjectProfile.js';
import type { MemoryEntity, TrustLevel } from '../hooks/useMemoryEntities.js';
import { useMemoryGraphEvents } from '../hooks/useNodeEvents.js';
import { isUserFacingSubGraph, ROOT_SLUG_SENTINEL } from '../lib/subGraphs.js';

export interface SubGraphBadge {
  /** Short label shown inline on the chip, e.g. "2 proposed" */
  label: string;
  /** Tone color for the dot next to the badge */
  tone: 'warn' | 'danger' | 'info' | 'muted';
}

export interface SubGraphBarProps {
  contextGraphId: string;
  profile: ProjectProfile;
  selected: string | null;   // null === "All"
  /** Second arg `originatingLayer` carries the active layer
   *  context when the bar is mounted on a WM/SWM/VM page so the
   *  detail view can seed its `enabledLayers` to match what the
   *  user was scoped to (§4.4.1 fold-in #4 — "scope must never
   *  silently change semantics across a navigation transition").
   *  Optional and only meaningful when transitioning INTO a chip
   *  detail; clearing back to All passes undefined. */
  onSelect: (slug: string | null, originatingLayer?: 'wm' | 'swm' | 'vm') => void;
  /** Optional entity list for computing live badges (proposed / p0 / open PRs). */
  entities?: MemoryEntity[];
  /**
   * Single-layer scope (back-compat). When set, the chip counts
   * reflect entities whose canonical layer (`trustLevel`) matches
   * this layer — so on the WM/SWM/VM pages the row reports a
   * per-layer slice instead of the daemon's project-wide total.
   * Without this prop the row falls back to daemon totals (used
   * on the Overview / Subgraphs pages). Also used as the
   * `originatingLayer` argument forwarded to `onSelect` when a
   * chip is clicked (#9 polish).
   *
   * Superseded by `enabledScope` when both are set. New callers
   * (PR #793 sweep 6 Bug O onward) should use `enabledScope`.
   */
  layer?: 'wm' | 'swm' | 'vm';
  /**
   * Multi-layer scope (PR #793 sweep 6 Bug O). Carries the
   * user's current detail-view `enabledLayers` Set so the
   * sibling bar's chip counts agree with the detail pane's
   * filtered slice. Pre-Bug-O the bar mounted alongside a
   * scoped detail was layer-agnostic, showing all-three chip
   * counts above a filtered detail body — same-screen
   * disagreement. The Set is interpreted as:
   *   • size 0 or undefined → layer-agnostic (Overview / Subgraphs)
   *   • size 1 → single-layer slice (matches the legacy `layer`)
   *   • size 2 → narrowed across 2 layers
   *   • size 3 → semantically all-three, treated as layer-agnostic
   *     for the `inLayerMode` discriminant (the #7 hint / Bug K
   *     rephrase / tooltip-branch logic stays at "no narrowing")
   *
   * Always trumps `layer` when both are non-empty. Forwarded as
   * a fresh Set on chip click via `originatingScope` — see below.
   */
  enabledScope?: ReadonlySet<TrustLevel>;
}

const LAYER_TRUST_LEVEL = {
  wm: 'working',
  swm: 'shared',
  vm: 'verified',
} as const;

/**
 * Compute a small ambient badge per sub-graph:
 *   decisions → N proposed  (yellow)
 *   tasks     → N p0        (red)
 *   github    → N open PRs  (blue)
 *
 * All others get no badge. Keeps the bar quiet unless there's actually
 * something to look at.
 */
function computeBadges(entities: MemoryEntity[] | undefined): Map<string, SubGraphBadge> {
  const out = new Map<string, SubGraphBadge>();
  if (!entities) return out;

  const PRED_DEC_STATUS = 'http://dkg.io/ontology/decisions/status';
  const PRED_TASK_STATUS = 'http://dkg.io/ontology/tasks/status';
  const PRED_TASK_PRIORITY = 'http://dkg.io/ontology/tasks/priority';
  const PRED_GH_STATE = 'http://dkg.io/ontology/github/state';
  const TYPE_DECISION = 'http://dkg.io/ontology/decisions/Decision';
  const TYPE_TASK = 'http://dkg.io/ontology/tasks/Task';
  const TYPE_PR = 'http://dkg.io/ontology/github/PullRequest';

  let proposed = 0;
  let p0 = 0;
  let openPr = 0;

  for (const e of entities) {
    if (e.types.includes(TYPE_DECISION)) {
      const s = e.properties.get(PRED_DEC_STATUS)?.[0];
      if (s === 'proposed') proposed++;
    } else if (e.types.includes(TYPE_TASK)) {
      const prio = e.properties.get(PRED_TASK_PRIORITY)?.[0];
      const status = e.properties.get(PRED_TASK_STATUS)?.[0];
      // Only count active p0s so finished critical work doesn't keep
      // the red dot lit forever.
      if (prio === 'p0' && status !== 'done' && status !== 'cancelled') p0++;
    } else if (e.types.includes(TYPE_PR)) {
      const s = e.properties.get(PRED_GH_STATE)?.[0];
      if (s === 'open') openPr++;
    }
  }
  if (proposed > 0) out.set('decisions', { label: `${proposed} proposed`, tone: 'warn' });
  if (p0 > 0) out.set('tasks', { label: `${p0} p0`, tone: 'danger' });
  if (openPr > 0) out.set('github', { label: `${openPr} open`, tone: 'info' });
  return out;
}

export const SubGraphBar: React.FC<SubGraphBarProps> = ({ contextGraphId, profile, selected, onSelect, entities, layer, enabledScope }) => {
  const [subGraphs, setSubGraphs] = React.useState<SubGraphInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const badges = React.useMemo(() => computeBadges(entities), [entities]);
  const requestIdRef = React.useRef(0);

  // PR #793 sweep 6 Bug O — resolve a single "allowed trust
  // levels" Set from the (preferred) `enabledScope` Set carrier or
  // the legacy `layer` single-layer prop. A Set of size 3 collapses
  // to null (no narrowing — same semantic as undefined). The legacy
  // `layer` path maps through `LAYER_TRUST_LEVEL` into a size-1
  // Set. Once a Set or null is in hand, every derivation below
  // reads it the same way and the multi-layer case round-trips
  // cleanly. When the carrier collapses to null we're in layer-
  // agnostic mode.
  const allowedTrustLevels = React.useMemo<ReadonlySet<TrustLevel> | null>(() => {
    if (enabledScope && enabledScope.size > 0 && enabledScope.size < 3) {
      return new Set(enabledScope);
    }
    if (enabledScope && enabledScope.size >= 3) return null;
    if (layer) return new Set<TrustLevel>([LAYER_TRUST_LEVEL[layer]]);
    return null;
  }, [enabledScope, layer]);
  // `isNarrowed` is true when the bar reports a sliced view (any
  // non-null `allowedTrustLevels`). Pre-Bug-O this was just
  // `layer !== undefined`; the Set carrier generalises it for the
  // multi-layer cases. Drives the #7 / Bug K layer-mode tooltip
  // branching and the All chip Root-inclusion rule.
  const isNarrowed = allowedTrustLevels !== null;

  // When `entities` is provided we derive per-sub-graph counts locally
  // so the chip count matches what the entity list below it shows.
  // Without narrowing, count every entity that belongs to the
  // sub-graph (any layer) — used on the sub-graph page where the
  // per-pyramid header sums across layers (Issue B: the daemon's
  // `/api/sub-graph/list` `entityCount` counts entities once per
  // sub-graph membership, double-counting cross-sub-graph entities,
  // so the chip said "27" while the list said "11"). With
  // narrowing, scope to entities whose canonical `trustLevel` is
  // in the allowed set.
  const entityScopedCounts = React.useMemo(() => {
    if (!entities) return null;
    const counts = new Map<string, number>();
    for (const e of entities) {
      if (allowedTrustLevels && !allowedTrustLevels.has(e.trustLevel)) continue;
      for (const sg of e.subGraphs) {
        counts.set(sg, (counts.get(sg) ?? 0) + 1);
      }
    }
    return counts;
  }, [allowedTrustLevels, entities]);

  // Distinct count of in-scope entities for the "All" chip. Summing
  // per-sub-graph counts would double-count entities living in two or
  // more sub-graphs (the entity list under us is layer-filtered
  // without sub-graph multiplicity, so the sum disagrees with it).
  //
  // Layer-scoped semantic differs from layer-agnostic semantic:
  //   • Layer mode (WM/SWM/VM page): "All" should match the layer tab
  //     badge — every distinct entity at that layer, including
  //     root-bucket SWM entities whose graph URI is
  //     `<cg>/_shared_memory` (subGraphOf filters underscore-prefixed
  //     segments, leaving an empty `subGraphs` set). Without them
  //     "All" undercut the badge (e.g. 25 vs 27) and confused users.
  //   • Layer-agnostic mode (sub-graph page): "All" is the umbrella
  //     over named-sub-graph chips, so entities with no chip
  //     membership stay excluded — including them would inflate the
  //     total past anything the user can drill into by clicking a chip.
  const entityScopedAllTotal = React.useMemo(() => {
    if (!entities) return null;
    let n = 0;
    for (const e of entities) {
      if (allowedTrustLevels && !allowedTrustLevels.has(e.trustLevel)) continue;
      // Layer-agnostic mode (no narrowing) excludes root entities
      // by design — `All` is the umbrella over named-sub-graph
      // chips. In layer / narrowed mode root entities are
      // included so the total matches the layer-tab badge.
      if (!isNarrowed && e.subGraphs.size === 0) continue;
      n++;
    }
    return n;
  }, [allowedTrustLevels, isNarrowed, entities]);

  // S3 fold-in: the synthesized "Root" bucket is "all entities minus
  // those in any named sub-graph". Computed from the same entity list
  // the named chips use so the counts agree row-by-row.
  const rootEntityCount = React.useMemo(() => {
    if (!entities) return null;
    let n = 0;
    for (const e of entities) {
      if (allowedTrustLevels && !allowedTrustLevels.has(e.trustLevel)) continue;
      if (e.subGraphs.size > 0) continue;
      n++;
    }
    return n;
  }, [allowedTrustLevels, entities]);

  const loadSubGraphs = React.useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    fetchSubGraphs(contextGraphId)
      .then(r => { if (requestId === requestIdRef.current) setSubGraphs(r.subGraphs ?? []); })
      .catch(() => { /* silent — leave empty */ })
      .finally(() => { if (requestId === requestIdRef.current) setLoading(false); });
  }, [contextGraphId]);

  React.useEffect(() => {
    loadSubGraphs();
    return () => { requestIdRef.current++; };
  }, [loadSubGraphs]);
  useMemoryGraphEvents(contextGraphId, loadSubGraphs);

  const merged = React.useMemo(() => {
    // Filter out the `meta` sub-graph since it holds the profile itself, not
    // user-facing entities. Merge daemon counts with profile display data.
    // When `layerScopedCounts` is populated, the chip count is replaced
    // with the per-layer slice (entities whose canonical layer matches);
    // the daemon's `sg.entityCount` (project-wide total) is still used
    // as the fallback for Overview / Subgraphs callers that omit `layer`.
    return subGraphs
      .filter(isUserFacingSubGraph)
      .map(sg => {
        const binding = profile.forSubGraph(sg.name);
        // Prefer the locally-derived distinct count (matches the entity
        // list below); preserve a 0 result instead of falling back to
        // the daemon total when in entity-scoped mode (the sub-graph
        // genuinely has no in-scope entities).
        const entityScoped = entityScopedCounts !== null
          ? (entityScopedCounts.get(sg.name) ?? 0)
          : sg.entityCount;
        return {
          slug: sg.name,
          icon: binding.icon ?? '•',
          color: binding.color ?? '#64748b',
          displayName: binding.displayName ?? sg.name,
          description: binding.description ?? sg.description,
          rank: binding.rank ?? 99,
          entityCount: entityScoped,
          tripleCount: sg.tripleCount,
          layerScoped: entityScopedCounts !== null,
        };
      })
      .sort((a, b) => a.rank - b.rank);
  }, [subGraphs, profile, entityScopedCounts]);

  // Show the Root chip when the consumer derives root from entities
  // and at least one entity is in the root bucket. Without entities
  // (Overview / Subgraphs page) we'd be guessing — keep it hidden.
  // Also keep it visible whenever Root is the currently selected
  // chip — otherwise a live refresh (or the "View root" empty-state
  // action) that drops the count to 0 hides the chip while the
  // detail body remains in Root scope, leaving no active chip.
  // The count still renders honestly (0 if no root entities).
  const hasRootEntities = rootEntityCount !== null && rootEntityCount > 0;
  const showRootChip = hasRootEntities || selected === ROOT_SLUG_SENTINEL;

  if (loading && merged.length === 0 && !showRootChip) return null;
  if (merged.length === 0 && !showRootChip) return null;

  // Prefer the distinct-entity total (R2-5 / Issue B); fall back to
  // the daemon-sum only when no entities prop was passed.
  const totalEntities = entityScopedAllTotal ?? merged.reduce((a, b) => a + b.entityCount, 0);
  const totalTriples = merged.reduce((a, b) => a + b.tripleCount, 0);
  // Tooltip suffix tells the user the count is narrowed on a
  // WM/SWM/VM (or multi-layer) page; on the Overview / Subgraphs
  // page it stays implicit (project-wide totals match the daemon
  // view). For a single-layer scope the suffix reads as the
  // layer's full canonical title; for a multi-layer narrowing
  // it concatenates the present layer labels.
  const TRUST_LAYER_TITLE: Record<TrustLevel, string> = {
    working: 'Working Memory',
    shared: 'Shared Working Memory',
    verified: 'Verifiable Memory',
  };
  const layerLabel = allowedTrustLevels
    ? [...allowedTrustLevels].map(t => TRUST_LAYER_TITLE[t]).join(' + ')
    : null;
  const scopeSuffix = layerLabel ? ` in ${layerLabel}` : '';

  // S3 polish #7 — the `All` semantic differs between narrowed
  // and layer-agnostic mode (see `entityScopedAllTotal` for the
  // locked rule):
  //   • Narrowed (WM/SWM/VM or a multi-layer slice): All includes
  //     root-bucket entities so it matches the layer-tab badge.
  //   • Layer-agnostic mode (Subgraph Explorer overview): All
  //     EXCLUDES root by design — it's the umbrella over named
  //     sub-graph chips; including root would inflate the total
  //     past anything the user can drill into.
  // Surface different tooltip / aria-label / inline hint copy on
  // each mode so the math reads consistently with the chip count.
  // (PR #793 Codex sweep 1 — gating fix.)
  const inLayerMode = isNarrowed;
  const allTooltipCopy = inLayerMode
    ? `Total entities — includes those in named subgraphs (some may belong to more than one), plus Root entities not in any subgraph · ${totalEntities} entities${scopeSuffix}${layerLabel ? '' : ` · ${totalTriples} triples`}`
    : `Total entities in named subgraphs (some may belong to more than one). Root entities are counted separately on the Root chip · ${totalEntities} entities · ${totalTriples} triples`;
  const allAriaCopy = inLayerMode
    ? `All — total entities. Includes those in named subgraphs (some may belong to more than one), plus Root entities not in any subgraph. ${totalEntities} entities${scopeSuffix}.`
    : `All — total entities in named subgraphs (some may belong to more than one). Root entities are counted separately on the Root chip. ${totalEntities} entities.`;

  return (
    <div className="v10-subgraph-bar">
      <div className="v10-subgraph-bar-label">Subgraphs</div>
      <button
        type="button"
        className={`v10-subgraph-chip${selected === null ? ' active' : ''}`}
        /* All chip clears the selection — no originatingLayer
           seed because the All view shows daemon-wide totals. */
        onClick={() => onSelect(null)}
        title={allTooltipCopy}
        aria-label={allAriaCopy}
      >
        <span className="v10-subgraph-chip-icon">⊚</span>
        <span className="v10-subgraph-chip-label">All</span>
        <span className="v10-subgraph-chip-count">{totalEntities}</span>
      </button>
      {merged.map(sg => {
        const badge = badges.get(sg.slug);
        return (
          <button
            key={sg.slug}
            type="button"
            className={`v10-subgraph-chip${selected === sg.slug ? ' active' : ''}${badge ? ' has-badge' : ''}`}
            /* #9 polish — forward the bar's `layer` prop as the
               originating layer so the detail view's
               `enabledLayers` is seeded to match the scope the
               user was already in. Clicking from Overview or
               the Subgraphs page leaves `layer` undefined → no
               narrowing, default to all three. */
            onClick={() => onSelect(sg.slug, layer)}
            title={`${sg.displayName}${sg.description ? ' · ' + sg.description : ''} · ${sg.entityCount} entities${scopeSuffix}${layerLabel ? '' : ` · ${sg.tripleCount} triples`}${badge ? ' · ' + badge.label : ''}`}
            style={{
              '--sg-color': sg.color,
            } as React.CSSProperties}
          >
            <span className="v10-subgraph-chip-icon" style={{ color: sg.color }}>{sg.icon}</span>
            <span className="v10-subgraph-chip-label">{sg.displayName}</span>
            <span className="v10-subgraph-chip-count">{sg.entityCount}</span>
            {badge && (
              <span className={`v10-subgraph-chip-badge tone-${badge.tone}`}>
                <span className="v10-subgraph-chip-badge-dot" />
                {badge.label}
              </span>
            )}
          </button>
        );
      })}
      {showRootChip && (() => {
        const displayCount = rootEntityCount ?? 0;
        const isActive = selected === ROOT_SLUG_SENTINEL;
        return (
          <button
            type="button"
            className={`v10-subgraph-chip v10-subgraph-chip-root${isActive ? ' active' : ''}`}
            data-active={isActive}
            data-count={displayCount}
            /* #9 polish — Root chip carries the originating layer
               just like the named chips so a click from a layer
               page keeps the layer scope when entering Root. */
            onClick={() => onSelect(ROOT_SLUG_SENTINEL, layer)}
            title={`Entities not in any subgraph (Context Graph root) · ${displayCount} entities${scopeSuffix}`}
            aria-label="Entities not in any subgraph (Context Graph root)"
          >
            <span className="v10-subgraph-chip-icon">⊘</span>
            <span className="v10-subgraph-chip-label">Root</span>
            <span className="v10-subgraph-chip-count">{displayCount}</span>
          </button>
        );
      })()}
      {showRootChip && inLayerMode && (
        /* #7 polish — inline legend-style hint after the Root
           chip. Reads as "this row includes Root and the
           subgraph chips", NOT as arithmetic — `MemoryEntity.subGraphs`
           is a Set, so cross-membership entities count once in
           the All total while potentially appearing under
           multiple chip totals. Leading `+` mirrors set
           membership ("plus these things"); the comma list
           avoids a second `+` that would read as a sum.
           Cross-membership disclosure lives in the long-form
           All-chip tooltip — two-tier: hint = visual cue,
           tooltip = explanation. ux-locked at PR #793 Codex
           sweep 3 Bug K. Gated on `inLayerMode` (sweep 1 — the
           layer-agnostic All total excludes Root by design). */
        <span className="v10-subgraph-bar-hint" aria-hidden="true">
          + Root, subgraphs
        </span>
      )}
    </div>
  );
};
