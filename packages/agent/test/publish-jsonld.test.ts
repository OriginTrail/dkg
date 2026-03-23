import { describe, it, expect, afterEach, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

const agents: DKGAgent[] = [];

async function createAgent(name: string) {
  const agent = await DKGAgent.create({
    name,
    listenPort: 0,
    skills: [],
    chainAdapter: new MockChainAdapter(),
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch { /* teardown best-effort */ }
  }
  agents.length = 0;
});

describe('publishJsonLd', () => {
  it('bare JSON-LD doc defaults to private quads', async () => {
    const agent = await createAgent('BarePrivateBot');
    await agent.createParanet({ id: 'bare-priv', name: 'BP', description: '' });

    const publisherSpy = vi.spyOn(agent['publisher'], 'publish');

    const result = await agent.publish('bare-priv', {
      '@context': 'http://schema.org/',
      '@id': 'http://example.org/Alice',
      '@type': 'Person',
      'name': 'Alice',
    });
    expect(result.status).toBe('confirmed');

    expect(publisherSpy).toHaveBeenCalledOnce();
    const publishArgs = publisherSpy.mock.calls[0][0];

    // Private quads should contain the JSON-LD-derived triples
    expect(publishArgs.privateQuads.length).toBeGreaterThan(0);
    const privateType = publishArgs.privateQuads.find(
      (q: { predicate: string }) => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    );
    expect(privateType).toBeDefined();
    expect(privateType!.subject).toBe('http://example.org/Alice');

    // Public quads should have a synthetic anchor (since no public content was provided)
    expect(publishArgs.quads.length).toBeGreaterThan(0);
  }, 15000);

  it('envelope { public } puts quads in public set', async () => {
    const agent = await createAgent('PubEnvBot');
    await agent.createParanet({ id: 'pub-env', name: 'PE', description: '' });

    const publisherSpy = vi.spyOn(agent['publisher'], 'publish');

    const result = await agent.publish('pub-env', {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Bob',
        '@type': 'Person',
        'name': 'Bob',
      },
    });
    expect(result.status).toBe('confirmed');

    const publishArgs = publisherSpy.mock.calls[0][0];

    const publicType = publishArgs.quads.find(
      (q: { predicate: string }) => q.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    );
    expect(publicType).toBeDefined();
    expect(publicType!.subject).toBe('http://example.org/Bob');

    expect(publishArgs.privateQuads.length).toBe(0);
  }, 15000);

  it('envelope { public, private } splits quads correctly', async () => {
    const agent = await createAgent('SplitBot');
    await agent.createParanet({ id: 'split-test', name: 'Split', description: '' });

    const publisherSpy = vi.spyOn(agent['publisher'], 'publish');

    const result = await agent.publish('split-test', {
      public: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Carol',
        '@type': 'Person',
        'name': 'Carol',
      },
      private: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Carol',
        'email': 'carol@example.org',
      },
    });
    expect(result.status).toBe('confirmed');

    const publishArgs = publisherSpy.mock.calls[0][0];

    const publicName = publishArgs.quads.find(
      (q: { predicate: string }) => q.predicate === 'http://schema.org/name',
    );
    expect(publicName).toBeDefined();

    const privateEmail = publishArgs.privateQuads.find(
      (q: { predicate: string }) => q.predicate === 'http://schema.org/email',
    );
    expect(privateEmail).toBeDefined();
    expect(privateEmail!.subject).toBe('http://example.org/Carol');
  }, 15000);

  it('private-only envelope generates synthetic public anchor', async () => {
    const agent = await createAgent('PrivOnlyBot');
    await agent.createParanet({ id: 'priv-only', name: 'PO', description: '' });

    const publisherSpy = vi.spyOn(agent['publisher'], 'publish');

    const result = await agent.publish('priv-only', {
      private: {
        '@context': 'http://schema.org/',
        '@id': 'http://example.org/Secret',
        '@type': 'Thing',
        'name': 'Top Secret',
      },
    });
    expect(result.status).toBe('confirmed');

    const publishArgs = publisherSpy.mock.calls[0][0];

    expect(publishArgs.privateQuads.length).toBeGreaterThan(0);

    expect(publishArgs.quads.length).toBeGreaterThan(0);
    const anchor = publishArgs.quads.find(
      (q: { predicate: string }) => q.predicate.includes('privateDataAnchor'),
    );
    expect(anchor).toBeDefined();
  }, 15000);

  it('preserves typed literals in quad objects', async () => {
    const agent = await createAgent('LiteralBot');
    await agent.createParanet({ id: 'literal-test', name: 'Lit', description: '' });

    const publisherSpy = vi.spyOn(agent['publisher'], 'publish');

    await agent.publish('literal-test', {
      public: {
        '@context': {
          'schema': 'http://schema.org/',
          'xsd': 'http://www.w3.org/2001/XMLSchema#',
        },
        '@id': 'http://example.org/Event1',
        '@type': 'schema:Event',
        'schema:startDate': {
          '@value': '2024-01-01T00:00:00Z',
          '@type': 'xsd:dateTime',
        },
      },
    });

    const publishArgs = publisherSpy.mock.calls[0][0];
    const dateQuad = publishArgs.quads.find(
      (q: { predicate: string }) => q.predicate === 'http://schema.org/startDate',
    );
    expect(dateQuad).toBeDefined();
    expect(dateQuad!.object).toContain('2024-01-01T00:00:00Z');
    expect(dateQuad!.object).toContain('^^');
    expect(dateQuad!.object).toContain('dateTime');
  }, 15000);

  it('forwards accessPolicy and allowedPeers opts', async () => {
    const agent = await createAgent('OptsBot');
    await agent.createParanet({ id: 'opts-test', name: 'Opts', description: '' });

    const publisherSpy = vi.spyOn(agent['publisher'], 'publish');

    await agent.publish(
      'opts-test',
      {
        public: {
          '@context': 'http://schema.org/',
          '@id': 'http://example.org/Secret',
          '@type': 'Thing',
          'name': 'Classified',
        },
      },
      {
        accessPolicy: 'allowList',
        allowedPeers: ['peer-a', 'peer-b'],
      },
    );

    const publishArgs = publisherSpy.mock.calls[0][0];
    expect(publishArgs.accessPolicy).toBe('allowList');
    expect(publishArgs.allowedPeers).toEqual(['peer-a', 'peer-b']);
  }, 15000);

  it('throws on JSON-LD that produces no quads', async () => {
    const agent = await createAgent('ErrorBot');
    await agent.createParanet({ id: 'error-test', name: 'Err', description: '' });

    await expect(agent.publish('error-test', {})).rejects.toThrow(
      'JSON-LD document produced no RDF quads',
    );
  }, 15000);

  it('existing Quad[] publish still works unchanged', async () => {
    const agent = await createAgent('QuadBot');
    await agent.createParanet({ id: 'quad-test', name: 'QT', description: '' });

    const result = await agent.publish('quad-test', [
      { subject: 'did:dkg:test:X', predicate: 'http://schema.org/name', object: '"X"', graph: '' },
    ]);
    expect(result.status).toBe('confirmed');
  }, 15000);
});
