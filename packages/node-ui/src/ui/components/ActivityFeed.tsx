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
  useProjectActivity,
  bucketActivity,
  relativeTime,
  type ActivityItem,
} from '../hooks/useProjectActivity.js';
import { useAgentsContext } from '../hooks/useAgents.js';
import { useProjectProfileContext } from '../hooks/useProjectProfile.js';
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
  title,
  onSelectEntity,
  onOpenAgent,
  emptyHint,
  className = '',
}) => {
  const items = useProjectActivity(entities, {
    agentUri, typeIri, subGraph, limit, includeUndated,
  });
  const buckets = React.useMemo(() => bucketActivity(items), [items]);
  const agents = useAgentsContext();
  const profile = useProjectProfileContext();

  if (items.length === 0) {
    return (
      <div className={`v10-activity-feed v10-activity-feed-empty ${className}`}>
        {title && <div className="v10-activity-feed-title">{title}</div>}
        <div className="v10-activity-feed-empty-body">
          {emptyHint ?? 'No activity with a timestamp yet.'}
        </div>
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
                key={item.entity.uri}
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
  const typeBinding = profile?.forType(item.kindUri);
  const typeLabel = typeBinding?.label
    ?? item.kindUri.split(/[#/]/).pop()
    ?? 'Entity';
  const typeIcon = typeBinding?.icon ?? '◆';
  const typeColor = typeBinding?.color ?? '#a855f7';
  const layerColor = LAYER_COLOR[item.layer];

  // Surface status when the entity has one — decisions.status / tasks.status /
  // github.state — because "rejected" / "blocked" / "merged" is often the
  // most useful scan-while-browsing signal.
  const status = findStatus(item.entity);

  return (
    <button
      type="button"
      className="v10-activity-feed-row"
      onClick={() => onSelectEntity(item.entity.uri)}
      title={item.at ? `${item.entity.label}\n${item.at.toISOString()}` : item.entity.label}
    >
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
