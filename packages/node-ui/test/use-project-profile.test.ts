// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildQueryCatalogState, useProjectProfile, type ProjectProfile } from '../src/ui/hooks/useProjectProfile.js';
import { ROOT_SLUG_SENTINEL } from '../src/ui/lib/subGraphs.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/ui/api.js', () => ({
  // The hook fires four SPARQL queries on mount; every one resolves to
  // empty so the profile falls back to defaults (which is all we need
  // for the resolver-level Root assertion).
  executeQuery: vi.fn(async () => ({ result: { bindings: [] } })),
}));

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
});
