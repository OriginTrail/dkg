/**
 * Derive a unified activity feed from the project's memory.
 *
 * For each entity that has *some* date predicate, we treat it as an
 * "activity item" at that time. Priority for which predicate drives the
 * timestamp (first match wins):
 *
 *   1. dcterms:created              — generic, emitted by importers
 *   2. github:mergedAt / closedAt   — PR / issue lifecycle
 *   3. decisions:date               — decision authored-at
 *   4. tasks:dueDate                — task target date (proxy for "coming up")
 *
 * Items are sorted newest-first and carry their attribution agent (via
 * prov:wasAttributedTo) so the feed can render an AgentChip per row.
 *
 * This is intentionally client-side: every memory triple is already in
 * the hook's cache, and the feed is a pure derivation. No extra SPARQL.
 *
 * **N6 — event classification.** Originally the feed allowlisted a small
 * set of "interesting" types (Decision / Task / PR / Issue / Commit) and
 * silently dropped every other entity, so a Context Graph full of
 * imported knowledge displayed "No activity yet" even when many entities
 * had been imported with `dcterms:created` timestamps. The feed now
 * surfaces every entity with a parseable timestamp and tags each item
 * with an `event` discriminator so the renderer can adapt the icon,
 * copy and per-row chrome:
 *
 *   - `'typed'`   — entity matches one of the historical ACTIVITY_TYPES
 *                    (preserved verbatim so AgentProfileView and the
 *                    existing decision/task/PR feed shape unchanged).
 *   - `'added'`   — pure import: the entity has a timestamp but isn't
 *                    one of the typed-activity kinds.
 *   - `'promoted'` / `'published'` — reserved for later commits in this
 *                    series; surfaced from `_shared_memory_meta`
 *                    WorkspaceOperation records (not derived from the
 *                    entity-list pass below).
 */
import { useMemo } from 'react';
import type { MemoryEntity, TrustLevel } from './useMemoryEntities.js';

// Priority order — first predicate that has a parseable value wins.
const TIMESTAMP_PREDICATES = [
  'http://purl.org/dc/terms/created',
  'http://dkg.io/ontology/github/mergedAt',
  'http://dkg.io/ontology/github/closedAt',
  'http://dkg.io/ontology/decisions/date',
  'http://dkg.io/ontology/tasks/dueDate',
];

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV_WAS_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';

/**
 * Entity types that surface as "typed" activity rows (the original feed
 * shape — decision proposed, task done, PR merged, etc.). Imported
 * entities whose `rdf:type` is not in this set become `'added'` rows
 * instead (see `event` on `ActivityItem`).
 */
const ACTIVITY_TYPES = new Set([
  'http://dkg.io/ontology/decisions/Decision',
  'http://dkg.io/ontology/tasks/Task',
  'http://dkg.io/ontology/github/PullRequest',
  'http://dkg.io/ontology/github/Issue',
  'http://dkg.io/ontology/github/Commit',
]);

/**
 * Discriminator on every activity item. Drives the row icon / copy.
 * `'typed'` preserves the legacy decision/task/PR feed shape; `'added'`
 * is the N6 broadening — any entity with a timestamp that isn't one of
 * the historical typed activities. `'promoted'` / `'published'` are
 * threaded through in later commits in this series and originate from
 * `_shared_memory_meta` WorkspaceOperation records, not the
 * entity-list pass.
 */
export type ActivityEvent = 'added' | 'typed' | 'promoted' | 'published';

export interface ActivityItem {
  entity: MemoryEntity;
  /**
   * Primary activity timestamp — `null` means the entity is relevant
   * (matches filters, has a known type) but carries no parseable date
   * predicate. Bucketed into an "Undated" group at the end of the feed
   * so agent profile pages show every authored item even when the seed
   * didn't emit creation timestamps.
   */
  at: Date | null;
  authorUri: string | null;
  /**
   * Primary rdf:type of the entity (first match from ACTIVITY_TYPES),
   * or `null` for `'added'` rows whose entity doesn't have one of the
   * historical typed-activity kinds. Renderers should fall back to a
   * neutral "added" treatment when this is `null`.
   */
  kindUri: string | null;
  /** Which sub-graph this activity lives in. */
  subGraph: string | null;
  /** Trust layer — drives the coloured dot in the feed. */
  layer: TrustLevel;
  /** N6 event-kind discriminator — see `ActivityEvent`. */
  event: ActivityEvent;
}

function parseDateLike(s: string): Date | null {
  const stripped = s.replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
  const d = new Date(stripped);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Pick the primary activity-timestamp for an entity: walks TIMESTAMP_PREDICATES
 * and returns the first parseable value.
 */
function timestampOf(entity: MemoryEntity): Date | null {
  for (const pred of TIMESTAMP_PREDICATES) {
    const vals = entity.properties.get(pred);
    if (!vals?.length) continue;
    for (const v of vals) {
      const d = parseDateLike(v);
      if (d) return d;
    }
  }
  return null;
}

function authorOf(entity: MemoryEntity): string | null {
  for (const c of entity.connections) {
    if (c.predicate === PROV_WAS_ATTRIBUTED_TO) return c.targetUri;
  }
  return null;
}

function primaryActivityType(entity: MemoryEntity): string | null {
  for (const t of entity.types) {
    if (ACTIVITY_TYPES.has(t)) return t;
  }
  return null;
}

function primarySubGraph(entity: MemoryEntity): string | null {
  for (const sg of entity.subGraphs) {
    if (sg !== 'meta') return sg;
  }
  return null;
}

export interface UseProjectActivityOptions {
  /** Max rows returned. Defaults to 200 — plenty for "what happened recently". */
  limit?: number;
  /** Optional: filter by agent URI. Useful for agent profile views. */
  agentUri?: string;
  /** Optional: filter by entity-type IRI. */
  typeIri?: string;
  /** Optional: filter by sub-graph slug. */
  subGraph?: string;
  /**
   * When true (default) entities without a parseable timestamp are
   * still included, sorted after all dated items. Set false for the
   * project-home "recent" feed where we strictly want temporal data.
   */
  includeUndated?: boolean;
}

export function useProjectActivity(
  entityList: MemoryEntity[],
  opts: UseProjectActivityOptions = {},
): ActivityItem[] {
  const {
    limit = 200,
    agentUri,
    typeIri,
    subGraph,
    includeUndated = true,
  } = opts;
  return useMemo(() => {
    const out: ActivityItem[] = [];
    for (const e of entityList) {
      const kindUri = primaryActivityType(e);
      // typeIri filter pins the feed to a specific typed-activity kind
      // (used by AgentProfileView's per-type stat chips). When set, the
      // entity must have that exact `kindUri` — `'added'` rows are
      // dropped from the slice. Without `typeIri` we keep both `typed`
      // and `added` items.
      if (typeIri && kindUri !== typeIri) continue;
      const at = timestampOf(e);
      // No-timestamp + includeUndated: only surface entities with a
      // recognised type so the Undated bucket on AgentProfileView
      // stays focused on authored work, not every random untyped
      // entity in the project.
      if (!at) {
        if (!includeUndated) continue;
        if (!kindUri) continue;
      }
      const author = authorOf(e);
      if (agentUri && author !== agentUri) continue;
      const sg = primarySubGraph(e);
      if (subGraph && sg !== subGraph) continue;
      const event: ActivityEvent = kindUri ? 'typed' : 'added';
      out.push({
        entity: e,
        at,
        authorUri: author,
        kindUri,
        subGraph: sg,
        layer: e.trustLevel,
        event,
      });
    }
    // Dated items newest-first; undated items go last, ordered by label
    // for stable scan-ability.
    out.sort((a, b) => {
      if (a.at && b.at) return b.at.getTime() - a.at.getTime();
      if (a.at && !b.at) return -1;
      if (!a.at && b.at) return 1;
      return a.entity.label.localeCompare(b.entity.label);
    });
    return out.slice(0, limit);
  }, [entityList, limit, agentUri, typeIri, subGraph, includeUndated]);
}

/** Bucket items into "Today / Yesterday / Earlier this week / <month>" groups. */
export interface ActivityBucket {
  key: string;
  label: string;
  items: ActivityItem[];
}

export function bucketActivity(items: ActivityItem[], now: Date = new Date()): ActivityBucket[] {
  const startOfDay = (d: Date) => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
  };
  const today = startOfDay(now);
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const buckets: Record<string, ActivityBucket> = {};
  const order: string[] = [];
  const push = (key: string, label: string, item: ActivityItem) => {
    if (!buckets[key]) {
      buckets[key] = { key, label, items: [] };
      order.push(key);
    }
    buckets[key].items.push(item);
  };

  for (const item of items) {
    if (!item.at) {
      push('undated', 'Undated', item);
      continue;
    }
    const day = startOfDay(item.at);
    if (day.getTime() === today.getTime()) {
      push('today', 'Today', item);
    } else if (day.getTime() === yesterday.getTime()) {
      push('yesterday', 'Yesterday', item);
    } else if (item.at.getTime() >= weekAgo.getTime()) {
      push('this-week', 'Earlier this week', item);
    } else {
      const m = item.at.toLocaleString(undefined, { month: 'long', year: 'numeric' });
      push(`m-${m}`, m, item);
    }
  }
  // Always float Undated to the bottom, even if it was the first key added.
  const undatedIdx = order.indexOf('undated');
  if (undatedIdx !== -1 && undatedIdx < order.length - 1) {
    order.splice(undatedIdx, 1);
    order.push('undated');
  }
  return order.map(k => buckets[k]);
}

// ─── Promotion events (N6 part 2) ────────────────────────────────
//
// `useSwmAttributions` already queries the project's `_shared_memory_meta`
// partitions and produces a `Map<rootUri, AgentAttribution[]>` carrying
// `(agent, opUri, publishedAt, subGraph)` per (root, agent) pair. We
// re-use that data here — no new SPARQL — and project each attribution
// into a `'promoted'` activity row so the Overview feed shows who
// promoted what when. Each `AgentAttribution` becomes one row; an
// entity promoted by two distinct agents produces two rows (which
// reads as the conflict signal the SWM legend already badges).
//
// Kept as a small pure helper that takes data + an entity lookup so
// the joiner is testable without a network query — the React hook
// below just wires the live `useSwmAttributions` result in.

/**
 * Minimal shape of a SWM agent-attribution entry, mirrored from
 * `useSwmAttributions.AgentAttribution`. Re-declared here as a
 * structural subset so this file doesn't have to import the SWM hook
 * type and can be exercised by tests with plain object literals.
 */
export interface PromotionAttribution {
  agent: string;
  opUri: string;
  publishedAt: string;
  subGraph?: string;
}

export interface AppendPromotionEventsOptions {
  /** Per-URI entity lookup. Used to recover entity label + trustLevel
   *  for the promoted root. URIs that don't resolve still produce a row
   *  with a `null`-ish entity stub so the feed never silently drops a
   *  promotion just because the root URI hasn't loaded yet. */
  entitiesByUri: Map<string, MemoryEntity>;
  /** Optional: filter to a single agent (the promoter). */
  agentUri?: string;
  /** Optional: filter to a single sub-graph slug. */
  subGraph?: string;
  /** Cap on rows returned. Promotion rows are interleaved with
   *  entity-derived rows by the joiner hook below; the joiner enforces
   *  the *combined* cap, not a per-stream cap. */
  limit?: number;
}

/**
 * Pure helper — turns a SWM attribution map into a flat list of
 * `'promoted'` activity items, ready to merge with the entity-derived
 * feed. Skips rows whose timestamp can't be parsed (the meta graph
 * encodes them as ISO strings — failures are not expected in practice
 * but we'd rather drop than render an "Invalid Date" row).
 */
export function buildPromotionEvents(
  attributions: Map<string, PromotionAttribution[]>,
  opts: AppendPromotionEventsOptions,
): ActivityItem[] {
  const { entitiesByUri, agentUri, subGraph, limit = 200 } = opts;
  const out: ActivityItem[] = [];
  for (const [rootUri, attrs] of attributions) {
    const entity = entitiesByUri.get(rootUri);
    for (const attr of attrs) {
      if (agentUri && attr.agent !== agentUri) continue;
      if (subGraph && attr.subGraph !== subGraph) continue;
      const at = parseDateLike(attr.publishedAt);
      if (!at) continue;
      out.push({
        // When the entity isn't in `entitiesByUri` (data race, or a
        // promotion of a root that was already published past SWM
        // before this hook ran), synthesise a stub so the row still
        // renders cleanly. `humanizeLabel` would be ideal here but
        // pulling that dep would couple this file to project helpers;
        // a URI-tail label is good enough for the Overview row.
        entity: entity ?? syntheticEntityStub(rootUri),
        at,
        // Author on a `'promoted'` row is the *promoter* (the agent
        // who moved this entity into SWM), not the original `prov:
        // wasAttributedTo` author. Different events, different agents.
        authorUri: attr.agent,
        // Promotion is intentionally not a "typed activity" — clears
        // the `typeIri` filter contract: typed-only callers won't see
        // promotion rows. Renderer leans on `event === 'promoted'`.
        kindUri: null,
        subGraph: attr.subGraph ?? null,
        // Trust layer is `shared` by construction — the entity has
        // just landed in SWM. Even if the entity object isn't loaded
        // yet, the row is about the SWM transition.
        layer: 'shared',
        event: 'promoted',
      });
    }
  }
  out.sort((a, b) => {
    if (a.at && b.at) return b.at.getTime() - a.at.getTime();
    if (a.at && !b.at) return -1;
    if (!a.at && b.at) return 1;
    return a.entity.label.localeCompare(b.entity.label);
  });
  return out.slice(0, limit);
}

function syntheticEntityStub(uri: string): MemoryEntity {
  // URI-tail label so the row reads ("promoted <tail>") even when
  // the underlying entity hasn't loaded into `entitiesByUri` yet.
  const tail = uri.split(/[#/]/).filter(Boolean).pop() ?? uri;
  return {
    uri,
    label: tail,
    types: [],
    trustLevel: 'shared',
    layers: new Set(['shared']),
    subGraphs: new Set(),
    properties: new Map(),
    connections: [],
  };
}

export interface UseProjectActivityEventsOptions extends UseProjectActivityOptions {
  /** SWM attribution map from `useSwmAttributions`. When omitted the
   *  joiner reduces to plain `useProjectActivity(entities, opts)`. */
  swmAttributions?: Map<string, PromotionAttribution[]>;
}

/**
 * Joiner hook — `useProjectActivity` plus the SWM promotion stream.
 * Existing callers (AgentProfileView) keep using `useProjectActivity`
 * directly when they don't want promotion rows polluting a per-agent
 * typed-activity slice. The Overview "Recent activity" feed swaps to
 * this one and feeds in the live `useSwmAttributions` result.
 */
export function useProjectActivityEvents(
  entityList: MemoryEntity[],
  opts: UseProjectActivityEventsOptions = {},
): ActivityItem[] {
  const { swmAttributions, ...baseOpts } = opts;
  const base = useProjectActivity(entityList, baseOpts);
  return useMemo(() => {
    // typeIri pins the feed to a typed-activity kind (Decision/Task/
    // PR/etc.) — promotion rows have no `kindUri` so they're dropped
    // wholesale, matching how the same filter drops `'added'` rows.
    if (opts.typeIri) return base;
    if (!swmAttributions || swmAttributions.size === 0) return base;
    const entitiesByUri = new Map<string, MemoryEntity>();
    for (const e of entityList) entitiesByUri.set(e.uri, e);
    const promotions = buildPromotionEvents(swmAttributions, {
      entitiesByUri,
      agentUri: baseOpts.agentUri,
      subGraph: baseOpts.subGraph,
      // No per-stream limit — apply the combined cap below.
      limit: Number.POSITIVE_INFINITY,
    });
    const merged = [...base, ...promotions];
    merged.sort((a, b) => {
      if (a.at && b.at) return b.at.getTime() - a.at.getTime();
      if (a.at && !b.at) return -1;
      if (!a.at && b.at) return 1;
      return a.entity.label.localeCompare(b.entity.label);
    });
    const cap = baseOpts.limit ?? 200;
    return merged.slice(0, cap);
  }, [base, swmAttributions, entityList, baseOpts.agentUri, baseOpts.subGraph, baseOpts.limit, opts.typeIri]);
}

/** "2h ago" / "3d ago" / "Apr 18" — compact relative-time label. */
export function relativeTime(d: Date | null, now: Date = new Date()): string {
  if (!d) return '—';
  const diffMs = now.getTime() - d.getTime();
  const absMs = Math.abs(diffMs);
  const future = diffMs < 0;
  const m = 60_000, h = m * 60, day = h * 24;
  if (absMs < m) return future ? 'in a moment' : 'just now';
  if (absMs < h)  return future ? `in ${Math.floor(absMs / m)}m`  : `${Math.floor(absMs / m)}m ago`;
  if (absMs < day) return future ? `in ${Math.floor(absMs / h)}h`  : `${Math.floor(absMs / h)}h ago`;
  if (absMs < 7 * day) return future ? `in ${Math.floor(absMs / day)}d` : `${Math.floor(absMs / day)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
