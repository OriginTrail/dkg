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
import { canonicalEntityUri, uriTail, type MemoryEntity, type TrustLevel } from './useMemoryEntities.js';

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
  /**
   * Stable per-event identifier — `${event}|${opUri ?? entity.uri}|${atIso}`.
   * Same entity URI can produce several rows in one feed (`added` +
   * `promoted` for an entity that was both imported and promoted, or
   * two `promoted` rows for two distinct promoters / re-promotions),
   * so keying React's list by `entity.uri` would collide and
   * reconcile the wrong row on updates. Renderers MUST key off `id`.
   */
  id: string;
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
  /**
   * Whether the row should navigate when clicked. `false` for stub
   * promotion rows whose underlying root isn't in `rawMemory.entities`
   * — `ProjectView.openEntityDetail` would clear the selection
   * immediately because `selectedEntity` resolves to `null`, so we
   * render those rows as static text (the event still appears in the
   * timeline; only the navigation is suppressed). Defaults to `true`.
   */
  clickable: boolean;
}

function parseDateLike(s: string): Date | null {
  const stripped = s.replace(/^"|"$/g, '').replace(/^"(.+)"(?:@\w+|\^\^.+)?$/, '$1');
  const d = new Date(stripped);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Stable per-event id (Code1 fix). The same entity URI can appear in
 * several rows (`added` from an import + `promoted` from a WM→SWM
 * transition + a second `promoted` from a re-promotion by a different
 * agent), so keying React's list by `entity.uri` would collide and
 * reconcile the wrong row on updates. The id is event-discriminated
 * + tied to either the operation URI (for transition events) or the
 * entity URI (for entity-derived events), plus the row's timestamp.
 *
 * Codex Code4 (PR #656) — promotion rows additionally include the
 * `rootUri` so a single `WorkspaceOperation` that promotes several
 * roots produces a distinct id per root (one op URI + multiple roots
 * at the same timestamp would otherwise collide on `${event}|${opUri}|${ts}`).
 */
export function buildActivityId(
  event: ActivityEvent,
  subjectUri: string,
  at: Date | null,
  rootUri?: string,
): string {
  const ts = at ? at.toISOString() : 'no-ts';
  if (rootUri && rootUri !== subjectUri) {
    return `${event}|${subjectUri}|${rootUri}|${ts}`;
  }
  return `${event}|${subjectUri}|${ts}`;
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
      // Per-event id (Code1) — typed/added rows have at most one of
      // each event-kind per entity, so `${event}|${uri}|${atIso}` is
      // stable across re-renders even if the same URI later gains a
      // `'promoted'` row from the joiner.
      const id = buildActivityId(event, e.uri, at);
      out.push({
        id,
        entity: e,
        at,
        authorUri: author,
        kindUri,
        subGraph: sg,
        layer: e.trustLevel,
        event,
        // Entity-derived rows always have a resolvable entity in
        // `rawMemory` (we iterated `entityList` to get here), so they
        // can always navigate.
        clickable: true,
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
// `useSwmAttributions` queries `_shared_memory_meta` for every
// `dkg:WorkspaceOperation` row and exposes them in two shapes:
//
//   1. `attributions: Map<rootUri, AgentAttribution[]>` — deduplicated
//      by `(root, agent)`. The SWM-graph legend wants this (one
//      colour-slot per promoter regardless of how often they re-promoted).
//
//   2. `events: WorkspaceOperationEvent[]` — raw per-operation rows,
//      no dedup. Re-promotions of the same `(root, agent)` produce
//      two rows. This is the substrate the activity feed needs: every
//      promotion is its own event in the timeline.
//
// Codex Code2 (PR #656) caught us wiring the deduped map into the
// activity feed — that silently dropped re-promotions and could show
// outdated timestamps. The joiner below now consumes the raw event
// list. No new SPARQL — same `useSwmAttributions` query, two
// projections.
//
// Kept as a small pure helper that takes data + an entity lookup so
// the joiner is testable without a network query — the React hook
// below just wires the live `useSwmAttributions` result in.

/**
 * Raw per-operation event shape, mirrored from
 * `useSwmAttributions.WorkspaceOperationEvent`. Re-declared here as a
 * structural subset so this file doesn't have to import the SWM hook
 * type and can be exercised by tests with plain object literals.
 *
 * @deprecated Use `WorkspaceOperationEvent` directly when consuming
 *   the live hook — this alias is retained for symmetry with the
 *   pre-Code2 `PromotionAttribution` callers but is now a strict
 *   superset (`rootUri` is required).
 */
export interface PromotionAttribution {
  agent: string;
  opUri: string;
  publishedAt: string;
  subGraph?: string;
  /** The root entity URI this promotion event applies to. Was
   *  implicit in the previous Map key; now explicit so the row can
   *  also surface multiple roots from one op id. */
  rootUri: string;
}

export interface BuildPromotionEventsOptions {
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
 * Pure helper — turns a raw `_shared_memory_meta` event list into a
 * flat list of `'promoted'` activity items, ready to merge with the
 * entity-derived feed. Skips rows whose timestamp can't be parsed
 * (the meta graph encodes them as ISO strings — failures are not
 * expected in practice but we'd rather drop than render an "Invalid
 * Date" row).
 *
 * Stub rows (root not in `entitiesByUri`) are emitted as
 * `clickable: false` so the row stays in the timeline but doesn't
 * navigate to a detail view that would immediately clear itself
 * (Codex Code3, PR #656).
 */
export function buildPromotionEvents(
  events: ReadonlyArray<PromotionAttribution>,
  opts: BuildPromotionEventsOptions,
): ActivityItem[] {
  const { entitiesByUri, agentUri, subGraph, limit = 200 } = opts;
  const out: ActivityItem[] = [];
  for (const evt of events) {
    if (agentUri && evt.agent !== agentUri) continue;
    if (subGraph && evt.subGraph !== subGraph) continue;
    const at = parseDateLike(evt.publishedAt);
    if (!at) continue;
    // Local-1 (PR #656) — `evt.rootUri` is the raw SPARQL binding
    // value and can be wrapped (`<urn:...>`), while `entitiesByUri`
    // is keyed by canonical URIs (the same canonicalisation
    // `buildEntities` applies). Without this step every promotion of
    // a wrapped-URI root would fall through to the stub branch and
    // render as a non-clickable static row, even though the entity
    // is loaded. Same C8 / R2-1 pattern as the earlier #639 fixes.
    const canonicalRoot = canonicalEntityUri(evt.rootUri);
    const entity = entitiesByUri.get(canonicalRoot);
    const resolved = entity != null;
    out.push({
      // Per-op id (Code1 + Code4) — keys off the operation URI plus
      // the (canonical) root URI so (a) two re-promotions of the
      // same (root, agent) with different `opUri`s reconcile as
      // distinct rows, and (b) a single `WorkspaceOperation` that
      // promotes multiple roots produces a distinct id per root
      // (the opUri alone would collide). Use the canonical form so
      // a wrapped + unwrapped event for the same root don't render
      // as two rows.
      id: buildActivityId('promoted', evt.opUri, at, canonicalRoot),
      // When the entity isn't in `entitiesByUri` (data race, or a
      // promotion of a root that was already published past SWM
      // before this hook ran), synthesise a stub so the row still
      // renders cleanly. A URI-tail label is good enough for the row.
      entity: entity ?? syntheticEntityStub(canonicalRoot),
      at,
      // Author on a `'promoted'` row is the *promoter* (the agent
      // who moved this entity into SWM), not the original `prov:
      // wasAttributedTo` author. Different events, different agents.
      authorUri: evt.agent,
      // Promotion is intentionally not a "typed activity" — clears
      // the `typeIri` filter contract: typed-only callers won't see
      // promotion rows. Renderer leans on `event === 'promoted'`.
      kindUri: null,
      subGraph: evt.subGraph ?? null,
      // Trust layer is `shared` by construction — the entity has
      // just landed in SWM. Even if the entity object isn't loaded
      // yet, the row is about the SWM transition.
      layer: 'shared',
      event: 'promoted',
      // Code3 — stub rows can't navigate to a detail view that
      // ProjectView would immediately clear. Render them as static
      // text instead of an interactive button.
      clickable: resolved,
    });
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
  // R2-Local-2 (PR #656) — reuse `uriTail` from `useMemoryEntities`
  // so stub labels match the rest of the surface; the previous
  // `[#/]` split collapsed canonical `urn:dkg:thing:...` URIs to
  // the entire URN.
  return {
    uri,
    label: uriTail(uri),
    types: [],
    trustLevel: 'shared',
    layers: new Set(['shared']),
    subGraphs: new Set(),
    properties: new Map(),
    connections: [],
  };
}

export interface UseProjectActivityEventsOptions extends UseProjectActivityOptions {
  /**
   * Raw per-operation event log from `useSwmAttributions.events`.
   * When omitted (or empty) the joiner reduces to plain
   * `useProjectActivity(entities, opts)`. Code2 (PR #656) — we now
   * consume the raw event list, not the deduped attribution map, so
   * re-promotions surface as distinct rows.
   */
  swmEvents?: ReadonlyArray<PromotionAttribution>;
}

/**
 * Joiner hook — `useProjectActivity` plus the SWM promotion stream.
 * Existing callers (AgentProfileView) keep using `useProjectActivity`
 * directly when they don't want promotion rows polluting a per-agent
 * typed-activity slice. The Overview "Recent activity" feed swaps to
 * this one and feeds in the live `useSwmAttributions().events` result.
 */
export function useProjectActivityEvents(
  entityList: MemoryEntity[],
  opts: UseProjectActivityEventsOptions = {},
): ActivityItem[] {
  const { swmEvents, ...baseOpts } = opts;
  const base = useProjectActivity(entityList, baseOpts);
  return useMemo(() => {
    // typeIri pins the feed to a typed-activity kind (Decision/Task/
    // PR/etc.) — promotion rows have no `kindUri` so they're dropped
    // wholesale, matching how the same filter drops `'added'` rows.
    if (opts.typeIri) return base;
    if (!swmEvents || swmEvents.length === 0) return base;
    const entitiesByUri = new Map<string, MemoryEntity>();
    for (const e of entityList) entitiesByUri.set(e.uri, e);
    const promotions = buildPromotionEvents(swmEvents, {
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
  }, [base, swmEvents, entityList, baseOpts.agentUri, baseOpts.subGraph, baseOpts.limit, opts.typeIri]);
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
