/**
 * Compact horizontal strip of sub-graph chips. Sits above MemoryStrip and
 * scopes the whole project view to the selected sub-graph (or "All").
 *
 * Visual styling is fully driven by the project profile: each SubGraphBinding
 * contributes its icon/color/label. Per-sub-graph entity/triple counts come
 * from the daemon's GET /api/sub-graph/list endpoint. If the profile or list
 * endpoint fail, this component renders nothing — it's purely additive.
 */
import React from 'react';
import { fetchSubGraphs, type SubGraphInfo } from '../api.js';
import type { ProjectProfile } from '../hooks/useProjectProfile.js';
import type { MemoryEntity } from '../hooks/useMemoryEntities.js';
import { useMemoryGraphEvents } from '../hooks/useNodeEvents.js';

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
  onSelect: (slug: string | null) => void;
  /** Optional entity list for computing live badges (proposed / p0 / open PRs). */
  entities?: MemoryEntity[];
  /**
   * When set, the chip counts reflect entities whose canonical layer
   * (`trustLevel`) matches this layer — so on the WM/SWM/VM pages the
   * row reports a per-layer slice instead of the daemon's project-wide
   * total. Without this prop the row falls back to daemon totals
   * (used on the Overview / Subgraphs pages).
   */
  layer?: 'wm' | 'swm' | 'vm';
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

export const SubGraphBar: React.FC<SubGraphBarProps> = ({ contextGraphId, profile, selected, onSelect, entities, layer }) => {
  const [subGraphs, setSubGraphs] = React.useState<SubGraphInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const badges = React.useMemo(() => computeBadges(entities), [entities]);
  const requestIdRef = React.useRef(0);

  // When `entities` is provided we derive per-sub-graph counts locally
  // so the chip count matches what the entity list below it shows.
  // Without `layer`, count every entity that belongs to the sub-graph
  // (any layer) — used on the sub-graph page where the per-pyramid
  // header sums across layers (Issue B: the daemon's
  // `/api/sub-graph/list` `entityCount` counts entities once per
  // sub-graph membership, double-counting cross-sub-graph entities,
  // so the chip said "27" while the list said "11"). With `layer`
  // set, scope to entities whose canonical `trustLevel` matches —
  // used on the WM/SWM/VM page (post-P4).
  const entityScopedCounts = React.useMemo(() => {
    if (!entities) return null;
    const trust = layer ? LAYER_TRUST_LEVEL[layer] : null;
    const counts = new Map<string, number>();
    for (const e of entities) {
      if (trust !== null && e.trustLevel !== trust) continue;
      for (const sg of e.subGraphs) {
        counts.set(sg, (counts.get(sg) ?? 0) + 1);
      }
    }
    return counts;
  }, [layer, entities]);

  // Distinct count of in-scope entities for the "All" chip. Summing
  // per-sub-graph counts would double-count entities living in two or
  // more sub-graphs (the entity list under us is layer-filtered
  // without sub-graph multiplicity, so the sum disagrees with it).
  const entityScopedAllTotal = React.useMemo(() => {
    if (!entities) return null;
    const trust = layer ? LAYER_TRUST_LEVEL[layer] : null;
    let n = 0;
    for (const e of entities) {
      if (trust !== null && e.trustLevel !== trust) continue;
      if (e.subGraphs.size === 0) continue; // entity has no sub-graph — not in any chip
      n++;
    }
    return n;
  }, [layer, entities]);

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
      .filter(sg => sg.name !== 'meta')
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

  if (loading && merged.length === 0) return null;
  if (merged.length === 0) return null;

  // Prefer the distinct-entity total (R2-5 / Issue B); fall back to
  // the daemon-sum only when no entities prop was passed.
  const totalEntities = entityScopedAllTotal ?? merged.reduce((a, b) => a + b.entityCount, 0);
  const totalTriples = merged.reduce((a, b) => a + b.tripleCount, 0);
  // Tooltip suffix tells the user the count is layer-scoped on a
  // WM/SWM/VM page; on the Overview / Subgraphs page it stays implicit
  // (project-wide totals match the daemon view).
  const layerLabel = layer === 'wm' ? 'Working Memory'
    : layer === 'swm' ? 'Shared Working Memory'
    : layer === 'vm' ? 'Verifiable Memory'
    : null;
  const scopeSuffix = layerLabel ? ` in ${layerLabel}` : '';

  return (
    <div className="v10-subgraph-bar">
      <div className="v10-subgraph-bar-label">Sub-graphs</div>
      <button
        type="button"
        className={`v10-subgraph-chip${selected === null ? ' active' : ''}`}
        onClick={() => onSelect(null)}
        title={`All sub-graphs · ${totalEntities} entities${scopeSuffix}${layerLabel ? '' : ` · ${totalTriples} triples`}`}
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
            onClick={() => onSelect(sg.slug)}
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
    </div>
  );
};
