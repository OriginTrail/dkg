import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
  contextGraphOnChainIdBindingQuery,
} from '../src/context-graph-on-chain-binding.js';

const PREDICATE = 'https://dkg.network/ontology#ContextGraphOnChainId';

describe('context graph on-chain id binding query', () => {
  it('pins the predicate earlier builds wrote', () => {
    expect(CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE).toBe(PREDICATE);
  });

  it('reads the ontology binding first and falls back to the graph’s own _meta', () => {
    const query = contextGraphOnChainIdBindingQuery('team-a');
    const ontology = `GRAPH <did:dkg:context-graph:ontology> { <did:dkg:context-graph:team-a> <${PREDICATE}> ?ontologyId }`;
    const meta = `GRAPH <did:dkg:context-graph:team-a/_meta> { <did:dkg:context-graph:team-a> <${PREDICATE}> ?metaId }`;

    expect(query).toMatch(/^SELECT \?id WHERE \{/);
    expect(query).toContain(`OPTIONAL { ${ontology} }`);
    expect(query).toContain(`OPTIONAL { ${meta} }`);
    expect(query).toContain('BIND(COALESCE(?ontologyId, ?metaId) AS ?id)');
    expect(query).toContain('FILTER(BOUND(?id))');
    expect(query).toMatch(/\} LIMIT 1$/);
  });

  it('restricts each graph to the allowed ids before preferring the ontology copy', () => {
    const query = contextGraphOnChainIdBindingQuery('team-a', { onChainIds: ['33', '7'] });

    expect(query).toContain(
      `OPTIONAL { GRAPH <did:dkg:context-graph:ontology> { <did:dkg:context-graph:team-a> <${PREDICATE}> ?ontologyId }`
      + ' FILTER(STR(?ontologyId) IN ("33", "7")) }',
    );
    expect(query).toContain(
      `OPTIONAL { GRAPH <did:dkg:context-graph:team-a/_meta> { <did:dkg:context-graph:team-a> <${PREDICATE}> ?metaId }`
      + ' FILTER(STR(?metaId) IN ("33", "7")) }',
    );
    expect(query).toContain('BIND(COALESCE(?ontologyId, ?metaId) AS ?id)');
    // No list, no filter. An empty list matches nothing, in a form every
    // backend accepts, and still reads both graphs.
    const all = contextGraphOnChainIdBindingQuery('team-a', {});
    expect(all).not.toContain('FILTER(STR(');
    expect(all).not.toContain('FILTER(false)');
    const none = contextGraphOnChainIdBindingQuery('team-a', { onChainIds: [] });
    expect(none).not.toContain('IN (');
    expect(none.match(/\} FILTER\(false\) \}/g)).toHaveLength(2);
    expect(none).toContain('BIND(COALESCE(?ontologyId, ?metaId) AS ?id)');
  });

  it('names only the requested graph', () => {
    const query = contextGraphOnChainIdBindingQuery('team-b');
    const graphs = [...query.matchAll(/GRAPH <([^>]+)>/g)].map((match) => match[1]);

    expect(graphs).toEqual(['did:dkg:context-graph:ontology', 'did:dkg:context-graph:team-b/_meta']);
    expect(query).not.toContain('team-a');
  });
});
