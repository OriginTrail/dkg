// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import {
  useProjectActivityEvents,
  type ActivityItem,
  type UseProjectActivityEventsOptions,
} from '../src/ui/hooks/useProjectActivity.js';
import {
  buildMemoryEntities,
  type LayeredTriple,
  type MemoryEntity,
} from '../src/ui/hooks/useMemoryEntities.js';
import type { AssertionLifecycleEvent } from '../src/ui/hooks/useAssertionLifecycleEvents.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DC_CREATED = 'http://purl.org/dc/terms/created';

function entitiesFrom(triples: LayeredTriple[]): MemoryEntity[] {
  return [...buildMemoryEntities(triples).values()];
}

function Probe({
  entities,
  opts,
}: {
  entities: MemoryEntity[];
  opts: UseProjectActivityEventsOptions;
}) {
  // PR #694 Comment 13 — the joiner returns `{ items, hasMore }`
  // now. `data-has-more` lets the saturation badge be exercised
  // alongside the row stream without a second probe.
  const { items, hasMore } = useProjectActivityEvents(entities, opts);
  return React.createElement('div', {
    id: 'probe',
    'data-events': items.map(i => i.event).join('|'),
    'data-has-more': hasMore ? '1' : '0',
  });
}

function readEvents(container: HTMLElement): string[] {
  const probe = container.querySelector('#probe');
  if (!probe) return [];
  const raw = probe.getAttribute('data-events') ?? '';
  return raw.split('|').filter(Boolean);
}

function readHasMore(container: HTMLElement): boolean {
  return container.querySelector('#probe')?.getAttribute('data-has-more') === '1';
}

// PR #694 review fix — the `lifecycleEvents` prop is presence-keyed,
// not size-keyed. Passing it (even as an empty array) opts INTO the
// lifecycle contract: `'added'` rows from the entity-list
// `dcterms:created` path are suppressed, and the only `'promoted'`
// rows come from the lifecycle stream (zero when the array is
// empty). Passing `undefined` keeps the legacy path. This guard
// prevents the Overview shape from silently changing the moment a
// project records its first `dkg:AssertionCreated` event.
describe('useProjectActivityEvents — lifecycleEvents presence semantics (PR #694)', () => {
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

  function importedEntities(): MemoryEntity[] {
    // Two imported entities with `dcterms:created` triples — these
    // would surface as `'added'` rows on the legacy path.
    return entitiesFrom([
      { subject: 'urn:e:doc-1', predicate: RDF_TYPE, object: 'http://schema.org/CreativeWork', layer: 'working' },
      { subject: 'urn:e:doc-1', predicate: DC_CREATED, object: '"2026-05-20T08:00:00Z"', layer: 'working' },
      { subject: 'urn:e:doc-2', predicate: RDF_TYPE, object: 'http://schema.org/CreativeWork', layer: 'working' },
      { subject: 'urn:e:doc-2', predicate: DC_CREATED, object: '"2026-05-21T08:00:00Z"', layer: 'working' },
    ]);
  }

  it('legacy path: `lifecycleEvents` undefined → `added` rows from entity-list survive', () => {
    act(() => {
      root.render(React.createElement(Probe, {
        entities: importedEntities(),
        opts: {},
      }));
    });
    const events = readEvents(container);
    // Two imported entities → two `added` rows. Legacy contract preserved.
    expect(events.filter(e => e === 'added')).toHaveLength(2);
  });

  it('empty array opts INTO the lifecycle contract: `added` rows from entity-list ARE suppressed', () => {
    // The regression: pre-fix this case fell through to the legacy
    // path (`useLifecycle = lifecycleEvents && lifecycleEvents.length > 0`
    // evaluated false on empty array), so the Overview would surface
    // 2 `added` rows for the imported entities — then silently flip
    // to 0 of them the moment the first AssertionCreated event landed.
    act(() => {
      root.render(React.createElement(Probe, {
        entities: importedEntities(),
        opts: { lifecycleEvents: [] },
      }));
    });
    const events = readEvents(container);
    expect(events).toHaveLength(0);
    expect(events).not.toContain('added');
  });

  it('non-empty array: lifecycle promoted rows merge in; entity-list `added` rows still suppressed', () => {
    const lifecycle: AssertionLifecycleEvent[] = [
      {
        eventUri: 'urn:evt:promote-1',
        kind: 'promoted',
        assertionUri: 'urn:assert:doc-1',
        assertionName: 'doc-1',
        agentUri: 'did:dkg:agent:bob',
        publishedAt: '2026-05-22T10:00:00Z',
        entityCount: 3,
      },
    ];
    act(() => {
      root.render(React.createElement(Probe, {
        entities: importedEntities(),
        opts: { lifecycleEvents: lifecycle },
      }));
    });
    const events = readEvents(container);
    expect(events).toEqual(['promoted']);
  });
});

// PR #694 Comment 13 — `hasMore` is the pre-slice honest signal so
// the title saturation badge doesn't lie at the boundary. The prior
// `items.length >= effectiveLimit` heuristic in the consumer
// rendered `${limit}+` for projects with *exactly* `limit` rows
// (no rows dropped). The joiner now reports `hasMore = merged.length
// > cap`, computed before the slice.
describe('useProjectActivityEvents — hasMore signal (PR #694 Comment 13)', () => {
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

  function nLifecycleEvents(n: number): AssertionLifecycleEvent[] {
    const out: AssertionLifecycleEvent[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        eventUri: `urn:evt:promote-${i}`,
        kind: 'promoted',
        assertionUri: `urn:assert:doc-${i}`,
        assertionName: `doc-${i}`,
        agentUri: 'did:dkg:agent:bob',
        // Distinct timestamps so the sort is deterministic.
        publishedAt: `2026-05-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      });
    }
    return out;
  }

  it('hasMore is FALSE at the exact boundary (merged.length === cap)', () => {
    // Reviewer's named case: project with exactly `limit` rows. The
    // saturation badge must NOT show `${limit}+`; the count is exact.
    act(() => {
      root.render(React.createElement(Probe, {
        entities: [],
        opts: { lifecycleEvents: nLifecycleEvents(10), limit: 10 },
      }));
    });
    const events = readEvents(container);
    expect(events).toHaveLength(10);
    expect(readHasMore(container)).toBe(false);
  });

  it('hasMore is TRUE when merged.length > cap (rows dropped by the slice)', () => {
    act(() => {
      root.render(React.createElement(Probe, {
        entities: [],
        opts: { lifecycleEvents: nLifecycleEvents(15), limit: 10 },
      }));
    });
    const events = readEvents(container);
    expect(events).toHaveLength(10);
    expect(readHasMore(container)).toBe(true);
  });

  it('hasMore is FALSE when below the cap', () => {
    act(() => {
      root.render(React.createElement(Probe, {
        entities: [],
        opts: { lifecycleEvents: nLifecycleEvents(3), limit: 10 },
      }));
    });
    const events = readEvents(container);
    expect(events).toHaveLength(3);
    expect(readHasMore(container)).toBe(false);
  });

  // PR #694 Comment 14 — the typed/decision rows must survive even
  // when a flood of imports ranks above them. Pre-fix, the base hook
  // sliced first and the joiner filtered second, so the typed rows
  // below the 200-cap would be silently dropped. Post-fix, the
  // joiner pushes `excludeEvents: ['added']` into base, so the slice
  // operates on the post-filter set.
  it('typed rows survive when imports outrank them within the cap (Comment 14)', () => {
    const TYPE_DECISION = 'http://dkg.io/ontology/decisions/Decision';
    const triples: LayeredTriple[] = [];
    // 50 imports, newest first — these would have filled the cap pre-fix.
    for (let i = 0; i < 50; i++) {
      const ts = new Date(Date.UTC(2026, 4, 25 - Math.floor(i / 2), 12, i % 60, 0)).toISOString();
      triples.push(
        { subject: `urn:doc:${i}`, predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
        { subject: `urn:doc:${i}`, predicate: DC_CREATED, object: `"${ts}"`, layer: 'working' },
      );
    }
    // 5 typed Decision rows ranked OLDER than the imports — would be
    // pushed out of a 10-cap window pre-fix.
    for (let i = 0; i < 5; i++) {
      const ts = new Date(Date.UTC(2026, 3, 5 - i, 12, 0, 0)).toISOString();
      triples.push(
        { subject: `urn:decision:${i}`, predicate: RDF_TYPE, object: TYPE_DECISION, layer: 'working' },
        { subject: `urn:decision:${i}`, predicate: DC_CREATED, object: `"${ts}"`, layer: 'working' },
      );
    }
    const lifecycle: AssertionLifecycleEvent[] = [
      {
        eventUri: 'urn:evt:promote-bundle',
        kind: 'promoted',
        assertionUri: 'urn:assert:bundle',
        assertionName: 'bundle',
        agentUri: 'did:dkg:agent:bob',
        publishedAt: '2026-05-30T10:00:00Z',
        entityCount: 50,
      },
    ];
    act(() => {
      root.render(React.createElement(Probe, {
        entities: entitiesFrom(triples),
        opts: { lifecycleEvents: lifecycle, limit: 10 },
      }));
    });
    const events = readEvents(container);
    // 5 typed rows + 1 lifecycle promoted; NO `'added'` rows because
    // lifecycle is the authoritative source.
    expect(events.filter(e => e === 'added')).toHaveLength(0);
    expect(events.filter(e => e === 'typed')).toHaveLength(5);
    expect(events.filter(e => e === 'promoted')).toHaveLength(1);
  });

  // PR #694 Comment 15 — the saturation badge must be honest on the
  // legacy (non-lifecycle, non-swm) path too. Pre-fix, the joiner
  // hard-coded `hasMore: false` for that path; the title badge then
  // displayed `200` on an over-capped AgentProfileView feed instead
  // of `200+`. Post-fix, the base hook surfaces its own `hasMore`
  // and the joiner propagates it.
  it('hasMore propagates from base on the legacy path (Comment 15)', () => {
    const triples: LayeredTriple[] = [];
    for (let i = 0; i < 15; i++) {
      const ts = new Date(Date.UTC(2026, 4, 1, 12, i, 0)).toISOString();
      triples.push(
        { subject: `urn:doc:${i}`, predicate: RDF_TYPE, object: 'http://schema.org/Article', layer: 'working' },
        { subject: `urn:doc:${i}`, predicate: DC_CREATED, object: `"${ts}"`, layer: 'working' },
      );
    }
    act(() => {
      root.render(React.createElement(Probe, {
        entities: entitiesFrom(triples),
        // No lifecycleEvents, no swmEvents — pure legacy path.
        opts: { limit: 10 },
      }));
    });
    expect(readEvents(container)).toHaveLength(10);
    expect(readHasMore(container)).toBe(true);
  });
});
