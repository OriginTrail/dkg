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
}

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

export const SubGraphBar: React.FC<SubGraphBarProps> = ({ contextGraphId, profile, selected, onSelect, entities }) => {
  const [subGraphs, setSubGraphs] = React.useState<SubGraphInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const badges = React.useMemo(() => computeBadges(entities), [entities]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSubGraphs(contextGraphId)
      .then(r => { if (!cancelled) setSubGraphs(r.subGraphs ?? []); })
      .catch(() => { /* silent — leave empty */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contextGraphId]);

  const merged = React.useMemo(() => {
    // Filter out the `meta` sub-graph since it holds the profile itself, not
    // user-facing entities. Merge daemon counts with profile display data.
    return subGraphs
      .filter(sg => sg.name !== 'meta')
      .map(sg => {
        const binding = profile.forSubGraph(sg.name);
        return {
          slug: sg.name,
          icon: binding.icon ?? '•',
          color: binding.color ?? '#64748b',
          displayName: binding.displayName ?? sg.name,
          description: binding.description ?? sg.description,
          rank: binding.rank ?? 99,
          entityCount: sg.entityCount,
          tripleCount: sg.tripleCount,
        };
      })
      .sort((a, b) => a.rank - b.rank);
  }, [subGraphs, profile]);

  if (loading && merged.length === 0) return null;
  if (merged.length === 0) return null;

  const totalEntities = merged.reduce((a, b) => a + b.entityCount, 0);
  const totalTriples = merged.reduce((a, b) => a + b.tripleCount, 0);

  return (
    <div className="v10-subgraph-bar">
      <div className="v10-subgraph-bar-label">Sub-graphs</div>
      <button
        type="button"
        className={`v10-subgraph-chip${selected === null ? ' active' : ''}`}
        onClick={() => onSelect(null)}
        title={`All sub-graphs · ${totalEntities} entities · ${totalTriples} triples`}
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
            title={`${sg.displayName}${sg.description ? ' · ' + sg.description : ''} · ${sg.entityCount} entities · ${sg.tripleCount} triples${badge ? ' · ' + badge.label : ''}`}
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
