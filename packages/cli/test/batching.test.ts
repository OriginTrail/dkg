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

  it('rejects a single canonical-root group that exceeds the quad limit when splitting is disabled', () => {
    const quads: PublishQuad[] = Array.from({ length: 3 }, (_, index) => ({
      subject: index === 0 ? 'urn:test:entity:huge' : `urn:test:entity:huge/.well-known/genid/${index}`,
      predicate: 'http://schema.org/name',
      object: '"x"',
      graph: 'did:dkg:paranet:test',
    }));

    expect(() =>
      batchEntityQuads(quads, {
        maxBatchQuads: 2,
      })).toThrow('Single entity batch exceeds maxBatchQuads');
  });

  it('splits oversized canonical-root groups across quad-sized batches when enabled', () => {
    const quads: PublishQuad[] = Array.from({ length: 5 }, (_, index) => ({
      subject: index === 0 ? 'urn:test:entity:huge' : `urn:test:entity:huge/.well-known/genid/${index}`,
      predicate: 'http://schema.org/name',
      object: `"value-${index}"`,
      graph: 'did:dkg:paranet:test',
    }));

    const batches = batchEntityQuads(quads, {
      maxBatchQuads: 2,
      splitOversizedEntities: true,
    });

    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.flat()).toEqual(quads);
  });

  it('keeps a root entity and its genid descendants in the same batch', () => {
    const quads: PublishQuad[] = [
      {
        subject: 'urn:test:entity:1',
        predicate: 'http://schema.org/name',
        object: '"Entity"',
        graph: 'did:dkg:paranet:test',
      },
      {
        subject: 'urn:test:entity:1/.well-known/genid/1',
        predicate: 'http://schema.org/name',
        object: '"Blank 1"',
        graph: 'did:dkg:paranet:test',
      },
      {
        subject: 'urn:test:entity:2',
        predicate: 'http://schema.org/name',
        object: '"Other"',
        graph: 'did:dkg:paranet:test',
      },
    ];

    const batches = batchEntityQuads(quads, {
      maxBatchBytes: 350,
      estimateBatchBytes: (batch) => new TextEncoder().encode(JSON.stringify({ contextGraphId: 'test', quads: batch })).length,
    });

    expect(batches).toHaveLength(2);
    expect(batches[0]?.map((quad) => quad.subject)).toEqual([
      'urn:test:entity:1',
      'urn:test:entity:1/.well-known/genid/1',
    ]);
    expect(batches[1]?.map((quad) => quad.subject)).toEqual([
      'urn:test:entity:2',
    ]);
  });
});
