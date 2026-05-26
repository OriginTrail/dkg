// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  useProjectActivity,
  buildActivityId,
  type ActivityItem,
  type ActivityEvent,
} from '../src/ui/hooks/useProjectActivity.js';
import {
  buildMemoryEntities,
  type LayeredTriple,
  type MemoryEntity,
} from '../src/ui/hooks/useMemoryEntities.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DC_CREATED = 'http://purl.org/dc/terms/created';
const PROV_AUTHOR = 'http://www.w3.org/ns/prov#wasAttributedTo';
const TYPE_DECISION = 'http://dkg.io/ontology/decisions/Decision';
const TYPE_TASK = 'http://dkg.io/ontology/tasks/Task';
const SCHEMA_NAME = 'http://schema.org/name';

interface CapturedItem {
  id: string;
  uri: string;
  event: ActivityEvent;
  kindUri: string | null;
  at: string | null;
  author: string | null;
  clickable: boolean;
}

function Probe({
  entities,
  opts,
}: {
  entities: MemoryEntity[];
  opts?: Parameters<typeof useProjectActivity>[1];
}) {
  const items = useProjectActivity(entities, opts);
  const dump: CapturedItem[] = items.map(toCaptured);
  return React.createElement('div', {
    id: 'probe',
    'data-items': JSON.stringify(dump),
  });
}

function toCaptured(item: ActivityItem): CapturedItem {
  return {
    id: item.id,
    uri: item.entity.uri,
    event: item.event,
    kindUri: item.kindUri,
    at: item.at?.toISOString() ?? null,
    author: item.authorUri,
    clickable: item.clickable,
  };
}

function entitiesFrom(triples: LayeredTriple[]): MemoryEntity[] {
  return [...buildMemoryEntities(triples).values()];
}

function readItems(container: HTMLElement): CapturedItem[] {
  const probe = container.querySelector('#probe');
  if (!probe) return [];
  try {
    return JSON.parse(probe.getAttribute('data-items') ?? '[]');
  } catch {
    return [];
  }
}

describe('useProjectActivity — N6 event classification', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // The whole point of N6: an imported entity (timestamp + non-typed
  // rdf:type) used to be silently dropped by the ACTIVITY_TYPES gate,
  // so a CG full of imported knowledge read "No activity yet" on the
  // Overview. It must now surface as an 'added' row.
  it('surfaces an imported entity as an `added` activity row even without a typed activity kind', () => {
    const triples: LayeredTriple[] = [
      // An imported document — has dcterms:created but is not a
      // Decision/Task/PR/Issue/Commit, so the original feed dropped it.
      { subject: 'urn:doc:1', predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:1', predicate: SCHEMA_NAME, object: '"Imported Doc"', layer: 'working' },
      { subject: 'urn:doc:1', predicate: DC_CREATED, object: '"2026-05-20T10:00:00Z"', layer: 'working' },
    ];
    act(() => {
      root.render(React.createElement(Probe, { entities: entitiesFrom(triples) }));
    });
    const items = readItems(container);
    expect(items).toHaveLength(1);
    expect(items[0].event).toBe('added');
    expect(items[0].kindUri).toBe(null);
    expect(items[0].uri).toBe('urn:doc:1');
    expect(items[0].at).toBe('2026-05-20T10:00:00.000Z');
  });

  // The historical decision/task/PR/issue/commit shape must keep
  // producing `typed` rows — AgentProfileView and the existing feed
  // empty-state would regress otherwise.
  it('preserves `typed` rows for entities matching ACTIVITY_TYPES', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:decision:1', predicate: RDF_TYPE, object: TYPE_DECISION, layer: 'working' },
      { subject: 'urn:decision:1', predicate: SCHEMA_NAME, object: '"Pick a name"', layer: 'working' },
      { subject: 'urn:decision:1', predicate: DC_CREATED, object: '"2026-05-21T10:00:00Z"', layer: 'working' },
    ];
    act(() => {
      root.render(React.createElement(Probe, { entities: entitiesFrom(triples) }));
    });
    const items = readItems(container);
    expect(items).toHaveLength(1);
    expect(items[0].event).toBe('typed');
    expect(items[0].kindUri).toBe(TYPE_DECISION);
  });

  // Mixed feed: typed rows AND added rows interleave, sorted by
  // timestamp newest-first.
  it('interleaves `typed` and `added` rows under one sort axis (newest-first)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:doc:older',  predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:older',  predicate: DC_CREATED, object: '"2026-05-20T08:00:00Z"', layer: 'working' },
      { subject: 'urn:task:newer', predicate: RDF_TYPE, object: TYPE_TASK, layer: 'working' },
      { subject: 'urn:task:newer', predicate: DC_CREATED, object: '"2026-05-22T08:00:00Z"', layer: 'working' },
    ];
    act(() => {
      root.render(React.createElement(Probe, { entities: entitiesFrom(triples) }));
    });
    const items = readItems(container);
    expect(items.map(i => i.uri)).toEqual(['urn:task:newer', 'urn:doc:older']);
    expect(items[0].event).toBe('typed');
    expect(items[1].event).toBe('added');
  });

  // includeUndated:false (the Overview "recent activity" path) must
  // still drop entities with no timestamp — N6's broadening is not a
  // license to swamp the recent feed with un-dated imports.
  it('with includeUndated:false drops entities with no timestamp (Overview path)', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:doc:no-date', predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:no-date', predicate: SCHEMA_NAME, object: '"Undated"', layer: 'working' },
      { subject: 'urn:doc:dated',   predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:dated',   predicate: DC_CREATED, object: '"2026-05-22T08:00:00Z"', layer: 'working' },
    ];
    act(() => {
      root.render(React.createElement(Probe, {
        entities: entitiesFrom(triples),
        opts: { includeUndated: false },
      }));
    });
    const items = readItems(container);
    expect(items.map(i => i.uri)).toEqual(['urn:doc:dated']);
  });

  // includeUndated:true (default) used to require an entity to match
  // ACTIVITY_TYPES to enter the Undated bucket — that gate is still
  // wanted there, since the bucket is for "authored work I can't sort
  // temporally", not "every random entity in the project".
  it('with includeUndated:true keeps only typed entities when timestamp is missing', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:doc:no-date',  predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:no-date',  predicate: SCHEMA_NAME, object: '"Untyped undated"', layer: 'working' },
      { subject: 'urn:task:no-date', predicate: RDF_TYPE, object: TYPE_TASK, layer: 'working' },
      { subject: 'urn:task:no-date', predicate: SCHEMA_NAME, object: '"Typed undated"', layer: 'working' },
    ];
    act(() => {
      root.render(React.createElement(Probe, {
        entities: entitiesFrom(triples),
        opts: { includeUndated: true },
      }));
    });
    const items = readItems(container);
    // Only the typed entity. The plain Article without a timestamp
    // doesn't surface — otherwise the feed would balloon to every
    // untyped entity ever imported.
    expect(items.map(i => i.uri)).toEqual(['urn:task:no-date']);
    expect(items[0].event).toBe('typed');
  });

  // typeIri filter must keep behaving as today — AgentProfileView's
  // per-type stat chips select by IRI and expect a single-kind slice.
  it('typeIri filter drops `added` rows and pins to the requested typed kind', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:doc:1',      predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:1',      predicate: DC_CREATED, object: '"2026-05-20T08:00:00Z"', layer: 'working' },
      { subject: 'urn:decision:1', predicate: RDF_TYPE, object: TYPE_DECISION, layer: 'working' },
      { subject: 'urn:decision:1', predicate: DC_CREATED, object: '"2026-05-21T08:00:00Z"', layer: 'working' },
      { subject: 'urn:task:1',     predicate: RDF_TYPE, object: TYPE_TASK, layer: 'working' },
      { subject: 'urn:task:1',     predicate: DC_CREATED, object: '"2026-05-22T08:00:00Z"', layer: 'working' },
    ];
    act(() => {
      root.render(React.createElement(Probe, {
        entities: entitiesFrom(triples),
        opts: { typeIri: TYPE_DECISION },
      }));
    });
    const items = readItems(container);
    expect(items.map(i => i.uri)).toEqual(['urn:decision:1']);
    expect(items[0].event).toBe('typed');
  });

  // agentUri filter respects author attribution on added rows too —
  // an import attributed to alice@example should pass `agentUri=alice`.
  it('agentUri filter applies to both `typed` and `added` rows', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:doc:1', predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:1', predicate: DC_CREATED, object: '"2026-05-20T08:00:00Z"', layer: 'working' },
      { subject: 'urn:doc:1', predicate: PROV_AUTHOR, object: 'did:dkg:agent:alice', layer: 'working' },
      { subject: 'urn:doc:2', predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:2', predicate: DC_CREATED, object: '"2026-05-21T08:00:00Z"', layer: 'working' },
      { subject: 'urn:doc:2', predicate: PROV_AUTHOR, object: 'did:dkg:agent:bob', layer: 'working' },
    ];
    act(() => {
      root.render(React.createElement(Probe, {
        entities: entitiesFrom(triples),
        opts: { agentUri: 'did:dkg:agent:alice' },
      }));
    });
    const items = readItems(container);
    expect(items.map(i => i.uri)).toEqual(['urn:doc:1']);
    expect(items[0].author).toBe('did:dkg:agent:alice');
  });
});

// ─── N6 part 2 — promotion events ───────────────────────────────

import {
  useProjectActivityEvents,
  buildPromotionEvents,
  type PromotionAttribution,
} from '../src/ui/hooks/useProjectActivity.js';

function ProbeEvents({
  entities,
  opts,
}: {
  entities: MemoryEntity[];
  opts?: Parameters<typeof useProjectActivityEvents>[1];
}) {
  const items = useProjectActivityEvents(entities, opts);
  const dump: CapturedItem[] = items.map(toCaptured);
  return React.createElement('div', {
    id: 'probe',
    'data-items': JSON.stringify(dump),
  });
}

describe('useProjectActivityEvents — promotion events (N6 part 2)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // The headline win: a CG with a promoted entity surfaces the promote
  // as a `'promoted'` activity row on the Overview, attributed to the
  // promoter (not the original author), and tagged to the SWM layer.
  it('surfaces a SWM promotion as a `promoted` row attributed to the promoter', () => {
    // The promoted entity exists in the entity list as an `'added'` row
    // (it has dcterms:created from import); the promote layers on top.
    const triples: LayeredTriple[] = [
      { subject: 'urn:doc:promoted', predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:promoted', predicate: DC_CREATED, object: '"2026-05-20T08:00:00Z"', layer: 'working' },
      { subject: 'urn:doc:promoted', predicate: PROV_AUTHOR, object: 'did:dkg:agent:alice', layer: 'working' },
    ];
    const events: PromotionAttribution[] = [{
      rootUri: 'urn:doc:promoted',
      agent: 'did:dkg:agent:bob',
      opUri: 'urn:dkg:share:op-1',
      publishedAt: '2026-05-22T10:00:00Z',
    }];
    act(() => {
      root.render(React.createElement(ProbeEvents, {
        entities: entitiesFrom(triples),
        opts: { swmEvents: events },
      }));
    });
    const items = readItems(container);
    // Promoted is newer than added (May 22 vs May 20) → first row.
    expect(items.map(i => i.event)).toEqual(['promoted', 'added']);
    expect(items[0].author).toBe('did:dkg:agent:bob');
    expect(items[0].uri).toBe('urn:doc:promoted');
    expect(items[0].kindUri).toBe(null);
    expect(items[0].clickable).toBe(true);
    // `'added'` row keeps its original-author attribution.
    expect(items[1].author).toBe('did:dkg:agent:alice');
    expect(items[1].clickable).toBe(true);
    // Code1 — every row has a stable per-event id; the promoted row
    // and the added row (same entity URI) have distinct ids.
    expect(items[0].id).not.toEqual(items[1].id);
  });

  // Two distinct agents promoting the same root → two `'promoted'`
  // rows (mirrors the SWM-graph conflict signal — different events,
  // different rows, the timeline shows both promotions).
  it('emits one row per (root, agent) when two agents promoted the same entity', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:e:contested', predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
    ];
    const events: PromotionAttribution[] = [
      { rootUri: 'urn:e:contested', agent: 'did:dkg:agent:alice', opUri: 'urn:dkg:share:op-a', publishedAt: '2026-05-22T10:00:00Z' },
      { rootUri: 'urn:e:contested', agent: 'did:dkg:agent:bob',   opUri: 'urn:dkg:share:op-b', publishedAt: '2026-05-23T10:00:00Z' },
    ];
    act(() => {
      root.render(React.createElement(ProbeEvents, {
        entities: entitiesFrom(triples),
        opts: { swmEvents: events },
      }));
    });
    const items = readItems(container).filter(i => i.event === 'promoted');
    expect(items).toHaveLength(2);
    expect(items.map(i => i.author).sort()).toEqual(['did:dkg:agent:alice', 'did:dkg:agent:bob']);
    // Code1 — two promotion rows for the same root have distinct ids.
    expect(items[0].id).not.toEqual(items[1].id);
  });

  // Codex Code2 regression — the same `(root, agent)` is promoted
  // twice (different op id / timestamp). The previous wiring fed the
  // deduped `attributions` map and silently lost the second event.
  // The joiner now consumes the raw per-op event list and renders both.
  it('emits two rows for re-promotion of the same (root, agent) — different op ids (Code2)', () => {
    const events: PromotionAttribution[] = [
      { rootUri: 'urn:e:repromoted', agent: 'did:dkg:agent:bob', opUri: 'urn:dkg:share:op-first',  publishedAt: '2026-05-22T10:00:00Z' },
      { rootUri: 'urn:e:repromoted', agent: 'did:dkg:agent:bob', opUri: 'urn:dkg:share:op-second', publishedAt: '2026-05-24T10:00:00Z' },
    ];
    act(() => {
      root.render(React.createElement(ProbeEvents, {
        entities: entitiesFrom([]),
        opts: { swmEvents: events },
      }));
    });
    const items = readItems(container).filter(i => i.event === 'promoted');
    expect(items).toHaveLength(2);
    // Distinct ids per event keep React's reconciliation honest.
    expect(items[0].id).not.toEqual(items[1].id);
    // Newest first.
    expect(items[0].at).toBe('2026-05-24T10:00:00.000Z');
    expect(items[1].at).toBe('2026-05-22T10:00:00.000Z');
  });

  // Codex Code3 — a promotion of a root that isn't in `entitiesByUri`
  // still emits a row (the timeline doesn't drop transitions silently),
  // but the row is marked `clickable: false` so the renderer can render
  // it as static text rather than navigating to a detail view that
  // ProjectView would immediately clear.
  it('emits a non-clickable stub row when the promoted root is missing from entitiesByUri (Code3)', () => {
    const events: PromotionAttribution[] = [{
      rootUri: 'urn:dkg:thing:orphan-root',
      agent: 'did:dkg:agent:bob',
      opUri: 'urn:dkg:share:op-1',
      publishedAt: '2026-05-22T10:00:00Z',
    }];
    act(() => {
      root.render(React.createElement(ProbeEvents, {
        entities: entitiesFrom([]),
        opts: { swmEvents: events },
      }));
    });
    const items = readItems(container);
    expect(items).toHaveLength(1);
    expect(items[0].event).toBe('promoted');
    expect(items[0].uri).toBe('urn:dkg:thing:orphan-root');
    expect(items[0].clickable).toBe(false);
  });

  // The agentUri filter narrows promotions to a single promoter; this
  // is how AgentProfileView would surface "what did Bob promote".
  it('agentUri filter applies to promotion rows (promoter, not original author)', () => {
    const events: PromotionAttribution[] = [
      { rootUri: 'urn:e:1', agent: 'did:dkg:agent:alice', opUri: 'urn:op:1', publishedAt: '2026-05-22T10:00:00Z' },
      { rootUri: 'urn:e:2', agent: 'did:dkg:agent:bob',   opUri: 'urn:op:2', publishedAt: '2026-05-23T10:00:00Z' },
    ];
    act(() => {
      root.render(React.createElement(ProbeEvents, {
        entities: entitiesFrom([]),
        opts: { swmEvents: events, agentUri: 'did:dkg:agent:bob' },
      }));
    });
    const items = readItems(container);
    expect(items.map(i => i.uri)).toEqual(['urn:e:2']);
    expect(items[0].author).toBe('did:dkg:agent:bob');
  });

  // typeIri pins the feed to a typed-activity kind — promotion rows
  // are not typed and so must be dropped wholesale, mirroring how the
  // same filter drops `'added'` rows.
  it('typeIri filter drops promotion rows entirely', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:decision:1', predicate: RDF_TYPE, object: TYPE_DECISION, layer: 'working' },
      { subject: 'urn:decision:1', predicate: DC_CREATED, object: '"2026-05-20T08:00:00Z"', layer: 'working' },
    ];
    const events: PromotionAttribution[] = [
      { rootUri: 'urn:e:promoted', agent: 'did:dkg:agent:bob', opUri: 'urn:op:1', publishedAt: '2026-05-22T10:00:00Z' },
    ];
    act(() => {
      root.render(React.createElement(ProbeEvents, {
        entities: entitiesFrom(triples),
        opts: { swmEvents: events, typeIri: TYPE_DECISION },
      }));
    });
    const items = readItems(container);
    expect(items.map(i => i.event)).toEqual(['typed']);
  });

  // Omitting swmEvents → joiner reduces to the entity-derived
  // feed only. Keeps the AgentProfileView path noise-free.
  it('without swmEvents returns the same items as useProjectActivity', () => {
    const triples: LayeredTriple[] = [
      { subject: 'urn:doc:1', predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
      { subject: 'urn:doc:1', predicate: DC_CREATED, object: '"2026-05-22T08:00:00Z"', layer: 'working' },
    ];
    act(() => {
      root.render(React.createElement(ProbeEvents, {
        entities: entitiesFrom(triples),
        opts: {},
      }));
    });
    const items = readItems(container);
    expect(items.map(i => i.event)).toEqual(['added']);
  });
});

// Pure-helper tests — `buildPromotionEvents` is a standalone joiner so
// callers can compose other event streams (later: VM publishes) without
// the React hook plumbing.
describe('buildPromotionEvents — pure joiner', () => {
  it('drops rows with unparseable timestamps rather than emitting Invalid Date', () => {
    const items = buildPromotionEvents(
      [{
        rootUri: 'urn:e:1',
        agent: 'did:dkg:agent:bob',
        opUri: 'urn:op:1',
        publishedAt: 'not-a-date',
      }],
      { entitiesByUri: new Map() },
    );
    expect(items).toHaveLength(0);
  });

  it('sorts newest-first when fed an out-of-order array', () => {
    const items = buildPromotionEvents(
      [
        { rootUri: 'urn:e:older', agent: 'did:dkg:agent:alice', opUri: 'urn:op:a', publishedAt: '2026-05-20T00:00:00Z' },
        { rootUri: 'urn:e:newer', agent: 'did:dkg:agent:bob',   opUri: 'urn:op:b', publishedAt: '2026-05-22T00:00:00Z' },
      ],
      { entitiesByUri: new Map() },
    );
    expect(items.map(i => i.entity.uri)).toEqual(['urn:e:newer', 'urn:e:older']);
  });

  // Codex Code4 (PR #656) — a single `WorkspaceOperation` that
  // promotes multiple roots produces one event per root in the raw
  // event log. The id keyed off `opUri` + `at` alone would collide
  // between those rows, so `buildActivityId` now includes `rootUri`
  // for promotion events. Without this fix React reconciliation would
  // treat both as the same list child and one would silently disappear.
  it('emits distinct ids for two roots promoted by the same workspace operation (Code4)', () => {
    const items = buildPromotionEvents(
      [
        { rootUri: 'urn:e:root-a', agent: 'did:dkg:agent:bob', opUri: 'urn:op:multi', publishedAt: '2026-05-22T10:00:00Z' },
        { rootUri: 'urn:e:root-b', agent: 'did:dkg:agent:bob', opUri: 'urn:op:multi', publishedAt: '2026-05-22T10:00:00Z' },
      ],
      { entitiesByUri: new Map() },
    );
    expect(items).toHaveLength(2);
    expect(items[0].id).not.toEqual(items[1].id);
    const uris = items.map(i => i.entity.uri).sort();
    expect(uris).toEqual(['urn:e:root-a', 'urn:e:root-b']);
  });

  // Local-1 (PR #656) — the daemon sometimes ships wrapped
  // (`<urn:...>`) bindings in `_shared_memory_meta` rows, while
  // `entitiesByUri` is canonicalised (`buildEntities` strips the
  // angle brackets). Without canonicalising on lookup, every
  // wrapped-URI promotion would fall through to the stub branch
  // and render as a non-clickable static row, even when the
  // entity is loaded. Same C8 / R2-1 canonicalisation pattern as
  // the earlier #639 fixes.
  it('resolves wrapped <urn:...> rootUri to a canonical entity, keeping the row clickable (Local-1)', () => {
    const canonical = 'urn:e:wrapped';
    const entity: MemoryEntity = {
      uri: canonical,
      label: 'Wrapped Entity',
      types: [],
      trustLevel: 'shared',
      layers: new Set(['shared']),
      subGraphs: new Set(),
      properties: new Map(),
      connections: [],
    };
    const items = buildPromotionEvents(
      [{
        rootUri: `<${canonical}>`,
        agent: 'did:dkg:agent:bob',
        opUri: 'urn:op:wrapped',
        publishedAt: '2026-05-22T10:00:00Z',
      }],
      { entitiesByUri: new Map([[canonical, entity]]) },
    );
    expect(items).toHaveLength(1);
    expect(items[0].clickable).toBe(true);
    expect(items[0].entity.uri).toBe(canonical);
    // Stable id keys off canonical so a mixed wrapped/unwrapped feed
    // for the same root doesn't render two rows.
    expect(items[0].id).toBe(
      buildActivityId('promoted', 'urn:op:wrapped', new Date('2026-05-22T10:00:00Z'), canonical),
    );
  });
});

// `buildActivityId` is a pure helper exported alongside the joiner.
// These unit tests pin its contract — id stability across renders,
// per-event discrimination (Code1), and per-root distinctness for
// promotion events (Code4).
describe('buildActivityId — id contract', () => {
  it('returns the same id for the same (event, subject, at) tuple', () => {
    const at = new Date('2026-05-22T10:00:00Z');
    expect(buildActivityId('added', 'urn:e:1', at)).toBe(buildActivityId('added', 'urn:e:1', at));
  });

  it('produces distinct ids for the same subject with different event kinds (Code1)', () => {
    const at = new Date('2026-05-22T10:00:00Z');
    expect(buildActivityId('added', 'urn:e:1', at)).not.toBe(buildActivityId('promoted', 'urn:e:1', at));
  });

  it('produces distinct ids for two roots from the same op + timestamp (Code4)', () => {
    const at = new Date('2026-05-22T10:00:00Z');
    const idA = buildActivityId('promoted', 'urn:op:multi', at, 'urn:e:root-a');
    const idB = buildActivityId('promoted', 'urn:op:multi', at, 'urn:e:root-b');
    expect(idA).not.toBe(idB);
  });

  it('omits the rootUri segment when it equals the subjectUri (entity-derived rows)', () => {
    const at = new Date('2026-05-22T10:00:00Z');
    const withRoot = buildActivityId('added', 'urn:e:1', at, 'urn:e:1');
    const withoutRoot = buildActivityId('added', 'urn:e:1', at);
    expect(withRoot).toBe(withoutRoot);
  });
});
