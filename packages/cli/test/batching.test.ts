import { describe, expect, it } from 'vitest';
import { batchEntityQuads, type PublishQuad } from '../src/batching.js';

describe('batchEntityQuads', () => {
  it('splits batches when the estimated payload size would exceed the limit', () => {
    const entity = (subject: string, value: string): PublishQuad[] => [
      {
        subject,
        predicate: 'http://schema.org/name',
        object: JSON.stringify(value.repeat(600)),
        graph: 'did:dkg:paranet:test',
      },
    ];

    const quads = [
      ...entity('urn:test:entity:1', 'a'),
      ...entity('urn:test:entity:2', 'b'),
      ...entity('urn:test:entity:3', 'c'),
    ];

    const batches = batchEntityQuads(quads, {
      maxBatchQuads: 500,
      maxBatchBytes: 1500,
      estimateBatchBytes: (batch) => new TextEncoder().encode(JSON.stringify({ paranetId: 'test', quads: batch })).length,
    });

    expect(batches).toHaveLength(2);
    expect(batches.map((batch) => batch.map((quad) => quad.subject))).toEqual([
      ['urn:test:entity:1', 'urn:test:entity:2'],
      ['urn:test:entity:3'],
    ]);
  });

  it('rejects a single entity that cannot fit inside the byte limit', () => {
    const quads: PublishQuad[] = [
      {
        subject: 'urn:test:entity:huge',
        predicate: 'http://schema.org/name',
        object: JSON.stringify('x'.repeat(5000)),
        graph: 'did:dkg:paranet:test',
      },
    ];

    expect(() =>
      batchEntityQuads(quads, {
        maxBatchBytes: 1024,
        estimateBatchBytes: (batch) => new TextEncoder().encode(JSON.stringify({ quads: batch })).length,
      }),
    ).toThrow('Single entity batch exceeds maxBatchBytes');
  });

  it('can split a large single entity when explicitly enabled', () => {
    const quads: PublishQuad[] = Array.from({ length: 775 }, (_, index) => ({
      subject: 'urn:test:entity:large',
      predicate: `http://schema.org/p/${index}`,
      object: '"value"',
      graph: 'did:dkg:paranet:test',
    }));

    const batches = batchEntityQuads(quads, {
      maxBatchQuads: 500,
      splitOversizedEntities: true,
    });

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(500);
    expect(batches[1]).toHaveLength(275);
  });
});
