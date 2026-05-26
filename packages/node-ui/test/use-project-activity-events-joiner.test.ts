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
  const items = useProjectActivityEvents(entities, opts);
  return React.createElement('div', {
    id: 'probe',
    'data-events': items.map(i => i.event).join('|'),
  });
}

function readEvents(container: HTMLElement): string[] {
  const probe = container.querySelector('#probe');
  if (!probe) return [];
  const raw = probe.getAttribute('data-events') ?? '';
  return raw.split('|').filter(Boolean);
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
