import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  KNOWLEDGE_ASSET_SKOLEM_PREFIX,
  skolemizeKnowledgeAsset,
  skolemizeKnowledgeAssetParts,
} from '../src/auto-partition.js';

describe('graph-scoped KA skolemization', () => {
  it('preserves every subject as data instead of partitioning by roots', async () => {
    const quads: Quad[] = Array.from({ length: 1_000 }, (_, index) => ({
      subject: `urn:entity:${index}`,
      predicate: 'urn:predicate:value',
      object: `"${index}"`,
      graph: '',
    }));

    const normalized = await skolemizeKnowledgeAsset(quads);
    expect(normalized).toHaveLength(1_000);
    expect(new Set(normalized.map((quad) => quad.subject)).size).toBe(1_000);
    expect(new Set(normalized.map((quad) => quad.object))).toEqual(
      new Set(quads.map((quad) => quad.object)),
    );
    expect(normalized).not.toBe(quads);
  });

  it('assigns deterministic KA-local skolem IRIs independent of input order and labels', async () => {
    const quads: Quad[] = [
      { subject: '_:z', predicate: 'urn:p', object: '_:a', graph: '' },
      { subject: '_:a', predicate: 'urn:q', object: '"value"', graph: '' },
    ];

    const relabelled: Quad[] = [
      { subject: '_:other', predicate: 'urn:q', object: '"value"', graph: 'urn:g:2' },
      { subject: '_:root', predicate: 'urn:p', object: '_:other', graph: 'urn:g:1' },
    ];

    const forward = await skolemizeKnowledgeAsset(quads);
    const reverseAndRelabel = await skolemizeKnowledgeAsset(relabelled);
    expect(forward).toEqual(reverseAndRelabel);
    expect(forward.every((quad) => quad.graph === '')).toBe(true);
    expect(forward.every(
      (quad) => !quad.subject.startsWith('_:') && !quad.object.startsWith('_:'),
    )).toBe(true);
    expect(forward.some((quad) => quad.subject.startsWith(KNOWLEDGE_ASSET_SKOLEM_PREFIX))).toBe(true);
    await expect(skolemizeKnowledgeAsset(forward, {
      allowCanonicalSkolemTerms: true,
    })).resolves.toEqual(forward);
  });

  it('flattens named graphs, deduplicates the RDF set, and rejects skolem collisions', async () => {
    const duplicate: Quad = {
      subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: 'urn:g:1',
    };
    await expect(skolemizeKnowledgeAsset([
      duplicate,
      { ...duplicate, graph: 'urn:g:2' },
    ])).resolves.toEqual([{ ...duplicate, graph: '' }]);

    await expect(skolemizeKnowledgeAsset([{
      subject: `${KNOWLEDGE_ASSET_SKOLEM_PREFIX}c14n0`,
      predicate: 'urn:p',
      object: '"forged"',
      graph: '',
    }])).rejects.toMatchObject({ code: 'KA_SKOLEM_NAMESPACE_RESERVED' });
  });

  it('assigns one collision-free blank-node namespace across public and private content', async () => {
    const first = await skolemizeKnowledgeAssetParts(
      [{ subject: '_:public', predicate: 'urn:p', object: '"visible"', graph: '' }],
      [{ subject: '_:private', predicate: 'urn:p', object: '"hidden"', graph: '' }],
    );
    const relabelled = await skolemizeKnowledgeAssetParts(
      [{ subject: '_:x', predicate: 'urn:p', object: '"visible"', graph: 'urn:ignored' }],
      [{ subject: '_:y', predicate: 'urn:p', object: '"hidden"', graph: 'urn:also-ignored' }],
    );

    expect(first).toEqual(relabelled);
    expect(first.publicQuads[0]?.subject).toMatch(/^urn:dkg:ka-skolem:c14n[0-9]+$/);
    expect(first.privateQuads[0]?.subject).toMatch(/^urn:dkg:ka-skolem:c14n[0-9]+$/);
    expect(first.publicQuads[0]?.subject).not.toBe(first.privateQuads[0]?.subject);
  });

  it('preserves an intentionally shared blank node across visibility partitions', async () => {
    const parts = await skolemizeKnowledgeAssetParts(
      [{ subject: 'urn:public', predicate: 'urn:links', object: '_:shared', graph: '' }],
      [{ subject: '_:shared', predicate: 'urn:secret', object: '"hidden"', graph: '' }],
    );

    expect(parts.publicQuads[0]?.object).toBe(parts.privateQuads[0]?.subject);
  });
});
