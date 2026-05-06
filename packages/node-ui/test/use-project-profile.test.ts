import { describe, expect, it } from 'vitest';

import { buildQueryCatalogState } from '../src/ui/hooks/useProjectProfile.js';

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
