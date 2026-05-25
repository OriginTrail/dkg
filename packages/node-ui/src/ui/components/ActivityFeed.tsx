/**
 * A unified feed of recent project activity — decisions, tasks, PRs,
 * commits — grouped by Today / Yesterday / Earlier this week / month.
 * Each row shows the AgentChip prominently so the curator can see
 * who wrote what at a glance. Click a row to open the entity detail.
 *
 * Filterable via props:
 *   - `agentUri`   → only items attributed to this agent (agent profile)
 *   - `typeIri`    → only items of this rdf:type
 *   - `subGraph`   → only items from this sub-graph
 *   - `limit`      → max rows (default 200)
 *
 * Type-specific glyph + pill come from the project profile binding if
 * set, so a book-research project's "Character edits" feed reads the
 * same UI with the right labels.
 */
import React from 'react';
import type { MemoryEntity, TrustLevel } from '../hooks/useMemoryEntities.js';
import {
  useProjectActivityEvents,
  bucketActivity,
  relativeTime,
  type ActivityItem,
  type PromotionAttribution as ActivityFeedEvent,
} from '../hooks/useProjectActivity.js';
import { useAgentsContext } from '../hooks/useAgents.js';
import { useProjectProfileContext } from '../hooks/useProjectProfile.js';
import { EmptyState } from './ContextGraphPrimitives.js';
import { AgentChip } from './AgentChip.js';

const LAYER_COLOR: Record<TrustLevel, string> = {
  working:  '#64748b',
  shared:   '#f59e0b',
  verified: '#22c55e',
};

const LAYER_GLYPH: Record<TrustLevel, string> = {
  working:  '◇',
  shared:   '◈',
  verified: '◉',
};

export interface ActivityFeedProps {
  entities: MemoryEntity[];
  agentUri?: string;
  typeIri?: string;
  subGraph?: string;
  limit?: number;
  /**
   * When true (default) includes entities without a parseable timestamp
   * in an "Undated" bucket. The project overview's "recent activity"
   * feed sets this to false.
   */
  includeUndated?: boolean;
  /**
   * N6 part 2 — when supplied, SWM promotion events are interleaved
   * into the feed as `'promoted'` rows. The Overview wires this to
   * `useSwmAttributions(...).events` (raw per-operation event log)
   * so re-promotions surface as distinct rows. AgentProfileView omits
   * this (the per-agent typed-activity slice doesn't want promotion
   * noise). Codex Code2 (PR #656) — switched from the deduped
   * `attributions` map to the raw event list.
   */
  swmEvents?: ReadonlyArray<ActivityFeedEvent>;
  title?: React.ReactNode;
  onSelectEntity: (uri: string) => void;
  /** Optional click handler for author chips (navigate to agent profile). */
  onOpenAgent?: (uri: string) => void;
  /** Optional empty-state copy. */
  emptyHint?: React.ReactNode;
  className?: string;
}

export const ActivityFeed: React.FC<ActivityFeedProps> = ({
  entities,
  agentUri,
  typeIri,
  subGraph,
  limit,
  includeUndated = true,
  swmEvents,
  title,
  onSelectEntity,
  onOpenAgent,
  emptyHint,
  className = '',
}) => {
  // useProjectActivityEvents reduces to plain useProjectActivity when
  // swmEvents is undefined, so existing callers (AgentProfileView)
  // get identical behaviour without passing the new prop.
  const items = useProjectActivityEvents(entities, {
    agentUri, typeIri, subGraph, limit, includeUndated, swmEvents,
  });
  const buckets = React.useMemo(() => bucketActivity(items), [items]);
  const agents = useAgentsContext();
  const profile = useProjectProfileContext();

  if (items.length === 0) {
    return (
      <div className={`v10-activity-feed v10-activity-feed-empty ${className}`}>
        {title && <div className="v10-activity-feed-title">{title}</div>}
        <EmptyState
          compact
          title={emptyHint ?? 'No activity with a timestamp yet.'}
          className="v10-activity-feed-empty-state"
        />
      </div>
    );
  }

  return (
    <div className={`v10-activity-feed ${className}`}>
      {title && <div className="v10-activity-feed-title">{title}</div>}
      {buckets.map(bucket => (
        <div key={bucket.key} className="v10-activity-feed-bucket">
          <div className="v10-activity-feed-bucket-head">
            <span className="v10-activity-feed-bucket-label">{bucket.label}</span>
            <span className="v10-activity-feed-bucket-count">{bucket.items.length}</span>
          </div>
          <div className="v10-activity-feed-items">
            {bucket.items.map(item => (
              <ActivityRow
                key={item.id}
                item={item}
                agents={agents}
                profile={profile}
                onSelectEntity={onSelectEntity}
                onOpenAgent={onOpenAgent}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

function ActivityRow({
  item,
  agents,
  profile,
  onSelectEntity,
  onOpenAgent,
}: {
  item: ActivityItem;
  agents: ReturnType<typeof useAgentsContext>;
  profile: ReturnType<typeof useProjectProfileContext>;
  onSelectEntity: (uri: string) => void;
  onOpenAgent?: (uri: string) => void;
}) {
  const author = item.authorUri ? agents?.get(item.authorUri) : null;
  // Event-specific presentation (N6). `'typed'` keeps the historical
  // type-binding-driven look (Decision green check, Task cyan, etc.).
  // `'added'` is a neutral import treatment. `'promoted'` (and the
  // forthcoming `'published'`) are stage transitions, coloured to the
  // *target* layer they advanced into so the row reads as "moved to
  // Shared Working Memory".
  const isTyped = item.event === 'typed';
  const typeBinding = isTyped && item.kindUri ? profile?.forType(item.kindUri) : null;
  const typeLabel = ((): string => {
    if (item.event === 'added') return 'Added';
    if (item.event === 'promoted') return 'Promoted to Shared Working Memory';
    if (item.event === 'published') return 'Published to Verifiable Memory';
    return typeBinding?.label ?? (item.kindUri ? item.kindUri.split(/[#/]/).pop() : null) ?? 'Entity';
  })();
  const typeIcon = ((): string => {
    if (item.event === 'added') return '+';
    if (item.event === 'promoted') return '⇡';
    if (item.event === 'published') return '◉';
    return typeBinding?.icon ?? '◆';
  })();
  const typeColor = ((): string => {
    if (item.event === 'promoted') return LAYER_COLOR.shared;
    if (item.event === 'published') return LAYER_COLOR.verified;
    if (item.event === 'added') return '#64748b';
    return typeBinding?.color ?? '#a855f7';
  })();
  const layerColor = LAYER_COLOR[item.layer];

  // Surface status when the entity has one — decisions.status / tasks.status /
  // github.state — because "rejected" / "blocked" / "merged" is often the
  // most useful scan-while-browsing signal. Only meaningful on `'typed'`
  // rows; `'promoted'` / `'added'` / `'published'` describe the transition
  // itself and the status would read confusingly next to "Promoted to …".
  const status = isTyped ? findStatus(item.entity) : null;
  // Event-aware tooltip — promote/publish rows read better as
  // "Promoted to Shared Working Memory · Foo" than just "Foo".
  const tooltip = (() => {
    const parts: string[] = [];
    if (item.event !== 'typed') parts.push(typeLabel);
    parts.push(item.entity.label);
    if (item.at) parts.push(item.at.toISOString());
    return parts.join('\n');
  })();

  // Codex Code3 (PR #656) — stub promotion rows for roots that aren't
  // in `rawMemory.entities` are non-clickable. The detail navigation
  // would otherwise resolve `selectedEntity` to null and clear the
  // selection on the next render. Render as static text instead of
  // an interactive button; the event still appears in the timeline.
  const rowBody = (
    <>
      <span
        className="v10-activity-feed-layer"
        style={{ color: layerColor }}
        title={`${item.layer} memory`}
      >
        {LAYER_GLYPH[item.layer]}
      </span>
      <span
        className="v10-activity-feed-type"
        style={{ '--type-color': typeColor } as React.CSSProperties}
      >
        <span className="v10-activity-feed-type-icon">{typeIcon}</span>
        <span className="v10-activity-feed-type-label">{typeLabel}</span>
      </span>
      <span className="v10-activity-feed-title-text">{item.entity.label}</span>
      {status && (
        <span className={`v10-activity-feed-status status-${statusTone(status)}`}>
          {status}
        </span>
      )}
      {(author || item.authorUri) && (
        <span className="v10-activity-feed-author">
          <AgentChip
            agent={author ?? undefined}
            fallbackUri={item.authorUri ?? undefined}
            size="sm"
            onOpenAgent={onOpenAgent}
          />
        </span>
      )}
      <span className="v10-activity-feed-time" title={item.at ? item.at.toLocaleString() : 'no timestamp'}>
        {relativeTime(item.at)}
      </span>
    </>
  );

  if (!item.clickable) {
    return (
      <div
        className="v10-activity-feed-row v10-activity-feed-row-static"
        title={tooltip}
        aria-disabled="true"
      >
        {rowBody}
      </div>
    );
  }

  return (
    <button
      type="button"
      className="v10-activity-feed-row"
      onClick={() => onSelectEntity(item.entity.uri)}
      title={tooltip}
    >
      {rowBody}
    </button>
  );
}

function findStatus(e: MemoryEntity): string | null {
  const preds = [
    'http://dkg.io/ontology/decisions/status',
    'http://dkg.io/ontology/tasks/status',
    'http://dkg.io/ontology/github/state',
  ];
  for (const p of preds) {
    const v = e.properties.get(p)?.[0];
    if (v) return v;
  }
  return null;
}

function statusTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
  switch (status) {
    case 'accepted':
    case 'done':
    case 'merged':
      return 'good';
    case 'proposed':
    case 'in_progress':
    case 'open':
      return 'warn';
    case 'rejected':
    case 'superseded':
    case 'blocked':
    case 'cancelled':
      return 'bad';
    default:
      return 'neutral';
  }
}
