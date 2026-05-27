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
import type { AssertionLifecycleEvent } from '../hooks/useAssertionLifecycleEvents.js';
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
  /**
   * N6 polish (task #23) — bundle-keyed lifecycle events from
   * `useAssertionLifecycleEvents`. When supplied, this is the
   * authoritative source for `'added'` (from `dkg:AssertionCreated`)
   * and `'promoted'` (from `dkg:AssertionPromoted`) rows. The
   * entity-list `dcterms:created` rows and `swmEvents` promotions
   * are suppressed so we don't render the same transition twice.
   * AgentProfileView omits this; it stays on `swmEvents` for now.
   */
  lifecycleEvents?: ReadonlyArray<AssertionLifecycleEvent>;
  /**
   * PR #694 Comment 8 — when set, the lifecycle SPARQL failed for
   * the current context graph. Surface a quiet inline error indicator
   * in place of (or above) the empty hint so the consumer can
   * distinguish "no local activity yet" from "the activity stream
   * couldn't load". The hook clears `events` on failure but our
   * Comment 3 fix advances `resultContextGraphId` to the current
   * cgId in the catch path so consumers can no longer detect failure
   * by `events.length === 0` alone — this prop is the explicit
   * signal. Only the Overview supplies it; other callers omit.
   */
  lifecycleError?: string | null;
  title?: React.ReactNode;
  onSelectEntity: (uri: string) => void;
  /** Optional click handler for author chips (navigate to agent profile). */
  onOpenAgent?: (uri: string) => void;
  /** Optional empty-state copy. */
  emptyHint?: React.ReactNode;
  className?: string;
}

// Mirror of `useProjectActivityEvents`'s default cap so the title-
// badge "saturation indicator" stays in sync with the joiner's cap
// without needing the joiner to return a `total` count alongside the
// items. PR #694 Comment 9 — the badge previously rendered the
// post-slice count, implying a project had exactly `limit` items
// when it actually had more.
const DEFAULT_ITEM_LIMIT = 200;

export const ActivityFeed: React.FC<ActivityFeedProps> = ({
  entities,
  agentUri,
  typeIri,
  subGraph,
  limit,
  includeUndated = true,
  swmEvents,
  lifecycleEvents,
  lifecycleError,
  title,
  onSelectEntity,
  onOpenAgent,
  emptyHint,
  className = '',
}) => {
  // useProjectActivityEvents reduces to plain useProjectActivity when
  // both swmEvents and lifecycleEvents are undefined, so existing
  // callers (AgentProfileView) get identical behaviour without
  // passing the new props. Returns `{ items, hasMore }` — `hasMore`
  // is the pre-slice honest signal for the title saturation badge
  // (PR #694 Comment 13).
  const { items, hasMore } = useProjectActivityEvents(entities, {
    agentUri, typeIri, subGraph, limit, includeUndated, swmEvents, lifecycleEvents,
  });
  const buckets = React.useMemo(() => bucketActivity(items), [items]);
  const agents = useAgentsContext();
  const profile = useProjectProfileContext();

  // PR #694 Comment 13 — render `${effectiveLimit}+` only when the
  // joiner reports rows were dropped. Boundary case: a project with
  // exactly `effectiveLimit` rows shows the exact count, not the
  // saturation indicator (the prior `>=` heuristic overstated here).
  const effectiveLimit = limit ?? DEFAULT_ITEM_LIMIT;
  const titleCount = hasMore ? `${effectiveLimit}+` : String(items.length);

  // N6 polish (item 3) — title row gets a total-feed count badge
  // mirroring the per-bucket chip; we render the same row in both
  // the empty and populated branches so the heading stays anchored
  // (showing "0" rather than vanishing into the empty state).
  const titleRow = title ? (
    <div className="v10-activity-feed-title">
      <span className="v10-activity-feed-title-label">{title}</span>
      <span className="v10-activity-feed-title-count">{titleCount}</span>
    </div>
  ) : null;

  // PR #694 Comment 8 + 11 — when the lifecycle SPARQL errored,
  // render a quiet inline error indicator. Comment 11 narrowed the
  // Comment 8 fix: the indicator renders INLINE (above buckets,
  // below the title), so typed Decision/Task/PR rows from the BASE
  // entity-list path still render when present — a lifecycle
  // failure shouldn't blank the whole feed. Only when `items.length
  // === 0` does the indicator replace the empty hint. Copy is
  // "Couldn't load recent activity." (qa-lead tweak — dropped
  // "Retrying…" because the hook only re-fetches on cgId change,
  // not on a timer).
  const errorBanner = lifecycleError ? (
    <div
      className="v10-activity-feed-error"
      role="status"
      aria-live="polite"
      title={lifecycleError}
    >
      Couldn't load recent activity.
    </div>
  ) : null;

  if (items.length === 0) {
    // N6 polish (item 2) — the centered bold `EmptyState` primitive
    // read as a load-bearing message; quieter inline tertiary text
    // recedes so the rest of the Overview stays the focal area.
    // The error banner takes precedence over the empty hint here so
    // the user doesn't see two contradictory states (Comment 8).
    return (
      <div className={`v10-activity-feed v10-activity-feed-empty ${className}`}>
        {titleRow}
        {errorBanner ?? (
          <div className="v10-activity-feed-empty-hint">
            {emptyHint ?? 'No activity with a timestamp yet.'}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`v10-activity-feed ${className}`}>
      {titleRow}
      {errorBanner}
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
    if (item.event === 'promoted') {
      // Promote rows from `dkg:AssertionPromoted` carry the per-bundle
      // root-entity count; surface it inline so a single row reads as
      // "one promote action of N entities" instead of needing N
      // separate rows. Hidden when missing (legacy WorkspaceOperation
      // fallback rows) or zero.
      return item.entityCount != null && item.entityCount > 0
        ? `Promoted to SWM · ${item.entityCount} ${item.entityCount === 1 ? 'entity' : 'entities'}`
        : 'Promoted to SWM';
    }
    if (item.event === 'published') return 'Published to VM';
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
