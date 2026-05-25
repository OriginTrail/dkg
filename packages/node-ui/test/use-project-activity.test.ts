// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  useProjectActivity,
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
  uri: string;
  event: ActivityEvent;
  kindUri: string | null;
  at: string | null;
  author: string | null;
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
    uri: item.entity.uri,
    event: item.event,
    kindUri: item.kindUri,
    at: item.at?.toISOString() ?? null,
    author: item.authorUri,
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
