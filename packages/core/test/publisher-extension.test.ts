import { describe, expect, it } from 'vitest';
import {
  createDkgPublisherExtension,
  escapeDkgRdfLiteral,
  isDkgRdfTerm,
  normalizeDkgPublisherObject,
  normalizeDkgPublisherQuads,
  type DkgPublisherExtensionTransport,
} from '../src/publisher-extension.js';

function createTransport(): DkgPublisherExtensionTransport & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    async createAssertion(...args) {
      calls.push(['createAssertion', args]);
      return { assertionUri: 'did:dkg:context-graph:cg/assertion/agent/memory', alreadyExists: false };
    },
    async writeAssertion(...args) {
      calls.push(['writeAssertion', args]);
      return { written: 2 };
    },
    async promoteAssertion(...args) {
      calls.push(['promoteAssertion', args]);
      return { promotedCount: 2 };
    },
    async discardAssertion(...args) {
      calls.push(['discardAssertion', args]);
      return { discarded: true };
    },
    async share(...args) {
      calls.push(['share', args]);
      return { shareOperationId: 'swm-1' };
    },
    async publish(...args) {
      calls.push(['publish', args]);
      return { kcId: '1', kas: [{ tokenId: '1', rootEntity: 'did:dkg:entity:1' }] };
    },
    async publishSharedMemory(...args) {
      calls.push(['publishSharedMemory', args]);
      return { kcId: '2', kas: [{ tokenId: '2', rootEntity: 'did:dkg:entity:2' }] };
    },
  };
}

describe('DkgPublisherExtension', () => {
  it('normalizes plugin-friendly object values into RDF terms', () => {
    expect(isDkgRdfTerm('https://example.org/entity')).toBe(true);
    expect(isDkgRdfTerm('urn:dkg:entity:1')).toBe(true);
    expect(isDkgRdfTerm('did:dkg:agent:abc')).toBe(true);
    expect(isDkgRdfTerm('_:blank')).toBe(true);
    expect(isDkgRdfTerm('"already literal"')).toBe(true);
    expect(isDkgRdfTerm('plain text')).toBe(false);

    expect(normalizeDkgPublisherObject('Alpha')).toBe('"Alpha"');
    expect(normalizeDkgPublisherObject('https://example.org/entity')).toBe('https://example.org/entity');
    expect(normalizeDkgPublisherObject('"42"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe(
      '"42"^^<http://www.w3.org/2001/XMLSchema#integer>',
    );
    expect(escapeDkgRdfLiteral('a "quote"\nnext')).toBe('a \\"quote\\"\\nnext');
  });

  it('normalizes full quads without changing URI, literal, or blank-node RDF terms', () => {
    expect(normalizeDkgPublisherQuads([
      { subject: 'did:dkg:entity:1', predicate: 'http://schema.org/name', object: 'Alpha' },
      { subject: 'did:dkg:entity:1', predicate: 'http://schema.org/knows', object: 'did:dkg:entity:2', graph: 'g' },
      { subject: 'did:dkg:entity:1', predicate: 'http://schema.org/hasPart', object: '_:b0' },
    ])).toEqual([
      { subject: 'did:dkg:entity:1', predicate: 'http://schema.org/name', object: '"Alpha"', graph: '' },
      { subject: 'did:dkg:entity:1', predicate: 'http://schema.org/knows', object: 'did:dkg:entity:2', graph: 'g' },
      { subject: 'did:dkg:entity:1', predicate: 'http://schema.org/hasPart', object: '_:b0', graph: '' },
    ]);
  });

  it('covers the local workspace create and write flow', async () => {
    const transport = createTransport();
    const publisher = createDkgPublisherExtension(transport);

    await publisher.createLocalWorkspace({
      contextGraphId: 'cg',
      assertionName: 'scratch',
      subGraphName: 'research',
    });
    await publisher.writeLocalWorkspace({
      contextGraphId: 'cg',
      assertionName: 'memory',
      subGraphName: 'research',
      quads: [{ subject: 'did:dkg:e:1', predicate: 'http://schema.org/name', object: 'Alpha' }],
    });

    expect(transport.calls).toEqual([
      ['createAssertion', ['cg', 'scratch', { subGraphName: 'research' }]],
      ['createAssertion', ['cg', 'memory', { subGraphName: 'research' }]],
      ['writeAssertion', [
        'cg',
        'memory',
        [{ subject: 'did:dkg:e:1', predicate: 'http://schema.org/name', object: '"Alpha"', graph: '' }],
        { subGraphName: 'research' },
      ]],
    ]);
  });

  it('can write to shared memory without creating a workspace assertion', async () => {
    const transport = createTransport();
    const publisher = createDkgPublisherExtension(transport);

    await publisher.writeSharedMemory({
      contextGraphId: 'cg',
      localOnly: false,
      quads: [{ subject: 'did:dkg:e:1', predicate: 'http://schema.org/url', object: 'https://example.org/a' }],
    });

    expect(transport.calls).toEqual([
      ['share', [
        'cg',
        [{ subject: 'did:dkg:e:1', predicate: 'http://schema.org/url', object: 'https://example.org/a', graph: '' }],
        { localOnly: false, subGraphName: undefined },
      ]],
    ]);
  });

  it('publishes fresh quads and existing shared memory into verified memory', async () => {
    const transport = createTransport();
    const publisher = createDkgPublisherExtension(transport);

    await publisher.publishVerifiedMemory({
      contextGraphId: 'cg',
      quads: [{ subject: 'did:dkg:e:1', predicate: 'http://schema.org/name', object: 'Alpha' }],
    });
    await publisher.publishSharedMemory({
      contextGraphId: 'cg',
      rootEntities: ['did:dkg:e:1'],
      clearAfter: false,
      subGraphName: 'research',
    });

    expect(transport.calls).toEqual([
      ['publish', [
        'cg',
        [{ subject: 'did:dkg:e:1', predicate: 'http://schema.org/name', object: '"Alpha"', graph: '' }],
        undefined,
        { accessPolicy: undefined, allowedPeers: undefined },
      ]],
      ['publishSharedMemory', [
        'cg',
        { rootEntities: ['did:dkg:e:1'], clearAfter: false, subGraphName: 'research' },
      ]],
    ]);
  });
});
