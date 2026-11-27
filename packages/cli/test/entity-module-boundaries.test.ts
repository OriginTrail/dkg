import { expect, it, vi } from 'vitest';

vi.mock('../src/entity-search/documents.js', () => { throw new Error('Pure entity contracts must not load the graph adapter'); });
vi.mock('@origintrail-official/dkg-agent', () => { throw new Error('Pure entity contracts must not load the agent runtime'); });

it('loads persistence, identities and request validation independently of graph reads', async () => {
  const { EntityIndexStore } = await import('../src/entity-search/store.js');
  const { documentKey } = await import('../src/entity-search/identity.js');
  const { parseIndexRequest } = await import('../src/entity-search/requests.js');
  expect(EntityIndexStore).toBeTypeOf('function');
  expect(documentKey({ sourceGraph: 'urn:graph', entityUri: 'urn:entity' })).toBe('["urn:graph","urn:entity"]');
  expect(parseIndexRequest({ contextGraphId: 'catalog', view: 'verifiable-memory', textPredicates: ['urn:text'] }))
    .toMatchObject({ contextGraphId: 'catalog', textPredicates: ['urn:text'], types: [], timeoutMs: 30000 });
});
