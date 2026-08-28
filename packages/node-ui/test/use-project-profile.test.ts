// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildQueryCatalogState, useProjectProfile, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';
import { ROOT_SLUG_SENTINEL } from '../src/ui/lib/subGraphs.js';
import { readProfileQueryCatalog } from '../src/ui/api.js';
import {
  decodeQueryCatalogBindings,
  QUERY_CATALOG_READ_CAPABILITIES,
  QUERY_CATALOG_SCHEMA_VERSION,
} from '@origintrail-official/dkg-core/query-catalog';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/ui/api.js', () => ({
  executeQuery: vi.fn(async () => ({ result: { bindings: [] } })),
  readProfileQueryCatalog: vi.fn(async () => ({
    schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
    capabilities: {
      canonicalItems: true,
      queryParameters: true,
      executionView: true,
      graphScopeIri: true,
    },
    contextGraphId: 'cg-test',
    graph: 'did:dkg:context-graph:cg-test/meta',
    items: [],
    result: { type: 'bindings', bindings: [] },
  })),
}));

function queryCatalogResponse(
  bindings: Array<Record<string, unknown>>,
  contextGraphId = 'cg-test',
) {
  return {
    schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
    capabilities: QUERY_CATALOG_READ_CAPABILITIES,
    contextGraphId,
    graph: `did:dkg:context-graph:${contextGraphId}/meta`,
    items: decodeQueryCatalogBindings(bindings, { contextGraphId }),
    result: { type: 'bindings' as const, bindings },
  };
}

describe('buildQueryCatalogState', () => {
  it('groups saved queries into explicit catalogs and sorts them by rank', () => {
    const state = buildQueryCatalogState(
      [
        {
          catalog: '<urn:dkg:profile:demo:catalog:triage>',
          subGraph: 'tasks',
          name: 'Task triage',
          description: 'Important task filters',
          rank: '2',
        },
        {
          catalog: { value: 'urn:dkg:profile:demo:catalog:ops' },
          subGraph: { value: 'tasks' },
          name: { value: 'Operations' },
          rank: { value: '1' },
        },
      ],
      [
        {
          q: '<urn:dkg:profile:demo:query:blocked>',
          subGraph: 'tasks',
          catalog: '<urn:dkg:profile:demo:catalog:triage>',
          name: 'Blocked tasks',
          sparql: 'SELECT ?task WHERE { ?task ?p ?o }',
          column: 'task',
          rank: '2',
        },
        {
          q: '<urn:dkg:profile:demo:query:high-priority>',
          subGraph: 'tasks',
          catalog: '<urn:dkg:profile:demo:catalog:triage>',
          name: 'High priority tasks',
          sparql: 'SELECT ?task WHERE { ?task ?p ?o }',
          column: 'task',
          rank: '1',
        },
        {
          q: { value: 'urn:dkg:profile:demo:query:handoffs' },
          subGraph: { value: 'tasks' },
          catalog: { value: 'urn:dkg:profile:demo:catalog:ops' },
          name: { value: 'Handoffs' },
          sparql: { value: 'SELECT ?task WHERE { ?task ?p ?o }' },
          column: { value: 'task' },
          rank: { value: '1' },
        },
      ],
    );

    expect(state.queryCatalogs).toHaveLength(2);
    expect(state.queryCatalogs[0].slug).toBe('ops');
    expect(state.queryCatalogs[1].slug).toBe('triage');
    expect(state.queryCatalogs[1].queries.map(query => query.slug)).toEqual([
      'high-priority',
      'blocked',
    ]);
    expect(state.queriesBySubGraph.get('tasks')?.map(query => query.slug)).toEqual([
      'handoffs',
      'high-priority',
      'blocked',
    ]);
  });

  it('creates an implicit default catalog for legacy saved queries without catalog links', () => {
    const state = buildQueryCatalogState([], [
      {
        q: '<urn:dkg:profile:demo:query:legacy>',
        subGraph: 'github',
        name: 'Legacy query',
        sparql: 'SELECT ?pr WHERE { ?pr ?p ?o }',
        column: 'pr',
      },
    ]);

    expect(state.queryCatalogs).toHaveLength(1);
    expect(state.queryCatalogs[0]).toMatchObject({
      slug: 'default:github',
      subGraph: 'github',
      name: 'Queries',
    });
    expect(state.queryCatalogs[0].queries[0]).toMatchObject({
      slug: 'legacy',
      catalogSlug: 'default:github',
      catalogName: 'Queries',
    });
  });

  it('preserves an explicit execution view returned by the profile catalog endpoint', () => {
    const state = buildQueryCatalogState([], [{
      q: '<urn:dkg:profile:demo:query:verified-trace>',
      subGraph: '__context_graph',
      name: 'Verified trace',
      sparql: 'SELECT ?record WHERE { ?record ?p ?o }',
      executionView: 'verifiable-memory',
    }]);

    expect(state.queryCatalogs[0].queries[0]).toMatchObject({
      slug: 'verified-trace',
      view: 'verifiable-memory',
    });
  });

  it('parses runtime parameter definitions returned by the profile catalog endpoint', () => {
    const state = buildQueryCatalogState([], [{
      q: '<urn:dkg:profile:demo:query:configuration-trace>',
      subGraph: '__context_graph',
      name: 'Configuration trace',
      sparql: 'SELECT ?record WHERE { ?record <urn:configuration> {{configurationId}} }',
      queryParameters: '[{"name":"configurationId","type":"string","label":"Configuration ID"}]',
    }]);

    expect(state.queryCatalogs[0].queries[0]).toMatchObject({
      slug: 'configuration-trace',
      parameters: [{ name: 'configurationId', type: 'string', label: 'Configuration ID' }],
    });
  });
});

describe('useProjectProfile — forSubGraph Root binding (S3, Codex Bug E)', () => {
  let root: Root;
  let container: HTMLDivElement;
  let captured: ProjectProfile | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    captured = null;
    vi.mocked(readProfileQueryCatalog).mockResolvedValue(queryCatalogResponse([]));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Probe({ contextGraphId }: { contextGraphId: string }) {
    const profile = useProjectProfile(contextGraphId);
    captured = profile;
    return null;
  }

  // The breadcrumb strip (S2) and every other consumer that resolves
  // the active sub-graph identity via `profile.forSubGraph(slug)`
  // would have rendered the raw sentinel `__root__` plus the
  // generic `•` fallback icon before this fix. Centralising the
  // Root binding at the resolver level ensures every consumer
  // reads the same icon/label/description.
  it('returns the synthesized Root binding for ROOT_SLUG_SENTINEL', async () => {
    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'cg-test' }));
    });
    // SPARQL mock resolves on the microtask queue.
    await act(async () => { await Promise.resolve(); });

    expect(captured).toBeTruthy();
    const binding = captured!.forSubGraph(ROOT_SLUG_SENTINEL);
    expect(binding).toBeTruthy();
    expect(binding!.slug).toBe(ROOT_SLUG_SENTINEL);
    expect(binding!.displayName).toBe('Root');
    expect(binding!.icon).toBe('⊘');
    expect(binding!.description).toBe('Entities not in any subgraph (Context Graph root)');
  });

  it('keeps the daemon-resolved binding path intact for non-Root slugs', async () => {
    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'cg-test' }));
    });
    await act(async () => { await Promise.resolve(); });

    // Daemon mock returns no bindings → falls back to the default
    // shape. The point of this case is the Root short-circuit
    // didn't accidentally hijack other slugs.
    const binding = captured!.forSubGraph('recipes');
    expect(binding!.slug).toBe('recipes');
    expect(binding!.displayName).toBe('recipes');
    expect(binding!.icon).toBe('•');
  });

  it('loads saved queries through the dedicated profile catalog endpoint', async () => {
    vi.mocked(readProfileQueryCatalog).mockResolvedValueOnce(queryCatalogResponse([{
          q: 'urn:listenerboi:query:open-incidents',
          subGraph: 'incidents',
          catalog: 'urn:listenerboi:catalog:investigations',
          name: 'Open incidents',
          description: 'Find incidents that still need attention.',
          sparql: 'SELECT ?incident WHERE { ?incident ?p ?o }',
          resultColumn: 'incident',
          rank: '1',
          catalogName: 'ListenerBoi investigations',
          catalogDescription: 'Reusable incident investigation queries.',
          catalogRank: '2',
    }]));

    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'cg-test' }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(readProfileQueryCatalog).toHaveBeenCalledWith('cg-test');
    expect(captured!.error).toBeUndefined();
    expect(captured!.queryCatalogs).toEqual([expect.objectContaining({
      slug: 'investigations',
      name: 'ListenerBoi investigations',
      description: 'Reusable incident investigation queries.',
      rank: 2,
      queries: [expect.objectContaining({
        slug: 'open-incidents',
        name: 'Open incidents',
        resultColumn: 'incident',
        view: 'working-memory',
      })],
    })]);
  });

  it('surfaces catalog read failures instead of reporting an empty catalog', async () => {
    vi.mocked(readProfileQueryCatalog).mockRejectedValueOnce(new Error('catalog read failed'));

    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'cg-test' }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(captured!.error).toBe('catalog read failed');
    expect(captured!.loading).toBe(false);
  });

  it('fails explicitly when an older daemon omits the catalog capability envelope', async () => {
    vi.mocked(readProfileQueryCatalog).mockResolvedValueOnce({
      contextGraphId: 'cg-test',
      graph: 'did:dkg:context-graph:cg-test/meta/query-catalog',
      result: { type: 'bindings', bindings: [] },
    } as never);

    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'cg-test' }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(captured!.error).toContain('Incompatible query-catalog daemon contract');
    expect(captured!.queryCatalogs).toEqual([]);
    expect(captured!.savedQueries).toEqual([]);
  });

  it('clears project A state and indexes when project B catalog loading fails', async () => {
    vi.mocked(readProfileQueryCatalog).mockResolvedValueOnce(queryCatalogResponse([{
          q: 'urn:dkg:profile:project-a:query:trace',
          subGraph: 'shared-slug',
          catalog: 'urn:dkg:profile:project-a:catalog:operations',
          name: 'Project A trace',
          sparql: 'SELECT ?record WHERE { ?record ?p ?o }',
          resultColumn: 'record',
    }], 'project-a'));

    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'project-a' }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(captured!.savedQueriesFor('shared-slug')).toHaveLength(1);

    vi.mocked(readProfileQueryCatalog).mockRejectedValueOnce(new Error('project B unavailable'));
    await act(async () => {
      root.render(React.createElement(Probe, { contextGraphId: 'project-b' }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(captured!.contextGraphId).toBe('project-b');
    expect(captured!.displayName).toBe('project-b');
    expect(captured!.error).toBe('project B unavailable');
    expect(captured!.savedQueries).toEqual([]);
    expect(captured!.queryCatalogs).toEqual([]);
    expect(captured!.savedQueriesFor('shared-slug')).toEqual([]);
    expect(captured!.savedQueryCatalogsFor('shared-slug')).toEqual([]);
  });
});
