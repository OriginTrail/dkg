// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectProfileContext, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';
import { SubGraphDetailView } from '../src/ui/views/project/components.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  executeQuery: vi.fn(async () => ({
    result: { type: 'bindings', bindings: [{ entity: 'urn:entity:demo' }] },
  })),
}));

vi.mock('../src/ui/api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/ui/api.js')>(),
  executeQuery: apiMocks.executeQuery,
}));

const entity = {
  uri: 'urn:entity:demo',
  label: 'Demo entity',
  types: [],
  trustLevel: 'working',
  layers: new Set(['working']),
  subGraphs: new Set(['incidents']),
  properties: new Map(),
  connections: [],
};

const rawMemory = {
  entities: new Map([[entity.uri, entity]]),
  entityList: [entity],
  allTriples: [],
  graphTriples: [],
  trustMap: new Map(),
  counts: { wm: 1, swm: 0, vm: 0, total: 1 },
  loading: false,
  error: null,
  partial: false,
  refresh: vi.fn(),
} as any;

function profile(): ProjectProfile {
  const catalog = {
    slug: 'investigations',
    subGraph: 'incidents',
    name: 'Investigations',
    rank: 1,
    queries: [
      {
        slug: 'open-incidents',
        subGraph: 'incidents',
        catalogSlug: 'investigations',
        catalogName: 'Investigations',
        catalogRank: 1,
        name: 'Open incidents',
        sparql: 'SELECT ?entity WHERE { ?entity ?p ?o }',
        resultColumn: 'entity',
        rank: 1,
        view: 'working-memory' as const,
        parameters: [],
      },
      {
        slug: 'incident-by-id',
        subGraph: 'incidents',
        catalogSlug: 'investigations',
        catalogName: 'Investigations',
        catalogRank: 1,
        name: 'Incident by ID',
        sparql: 'SELECT ?entity WHERE { ?entity <urn:id> {{id}} }',
        resultColumn: 'entity',
        rank: 2,
        parameters: [{ name: 'id', type: 'string' as const }],
      },
    ],
  };
  return {
    contextGraphId: 'cg-test',
    displayName: 'Test',
    primaryColor: '#000',
    accentColor: '#fff',
    subGraphs: [],
    typeBindings: [],
    views: [],
    filterChips: [],
    queryCatalogs: [catalog],
    savedQueries: catalog.queries,
    loading: false,
    forSubGraph: (slug) => ({ slug, displayName: slug, rank: 1 }),
    forType: () => ({} as any),
    view: () => undefined,
    chipsFor: () => [],
    savedQueryCatalogsFor: () => [catalog],
    savedQueriesFor: () => catalog.queries,
  };
}

describe('SubGraphDetailView query catalog execution', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container?.remove();
    apiMocks.executeQuery.mockClear();
  });

  it('forwards exact view and subgraph and redirects parameterized templates', async () => {
    const onOpenQueryCatalog = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        React.createElement(ProjectProfileContext.Provider, { value: profile() },
          React.createElement(SubGraphDetailView, {
            slug: 'incidents',
            rawMemory,
            contextGraphId: 'cg-test',
            onNodeClick: vi.fn(),
            onSelectEntity: vi.fn(),
            onOpenQueryCatalog,
          })),
      );
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const openIncidents = buttons.find((button) => button.textContent?.includes('Open incidents'))!;
    await act(async () => openIncidents.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(apiMocks.executeQuery).toHaveBeenCalledWith(
      'SELECT ?entity WHERE { ?entity ?p ?o }',
      { contextGraphId: 'cg-test', subGraphName: 'incidents', view: 'working-memory' },
    );

    apiMocks.executeQuery.mockClear();
    const byId = buttons.find((button) => button.textContent?.includes('Incident by ID'))!;
    expect(byId.title).toContain('Open Query Catalogue to enter parameters');
    await act(async () => byId.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(apiMocks.executeQuery).not.toHaveBeenCalled();
    expect(onOpenQueryCatalog).toHaveBeenCalledTimes(1);
  });
});
