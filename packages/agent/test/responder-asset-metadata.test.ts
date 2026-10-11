import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { generateGraphKnowledgeAssetMetadata, parseConfirmedGraphKnowledgeAssetMetadataEnvelope } from '@origintrail-official/dkg-publisher';
import { parseResponderAssetMetadata } from '../src/sync/responder/asset-metadata.js';

const DKG = 'http://dkg.io/ontology/';
const input = { contextGraphId: 'responder-metadata',
  ual: 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/3' };
const graph = knowledgeAssetLayerGraphUri(input.contextGraphId, MemoryLayer.VerifiableMemory,
  createGraphKnowledgeAssetScope(input.ual, 1));
function fixture() {
  return generateGraphKnowledgeAssetMetadata({ ...input, assertionVersion: '1', assertionGraph: graph,
    publisherPeerId: 'publisher', merkleRoot: new Uint8Array(32).fill(3), timestamp: new Date(0),
    publicTripleCount: 20, privateTripleCount: 0, accessPolicy: 'public',
  }, { status: 'confirmed', confirmation: { kind: 'transaction',
    provenance: { batchId: 3n, txHash: `0x${'11'.repeat(32)}` } } })
    .map(({ predicate, object }) => ({ predicate, object }));
}

describe('responder asset metadata', () => {
  it('returns the canonical envelope with validated rows in their fetched order', () => {
    const rows = fixture(), original = structuredClone(rows);
    const parsed = parseResponderAssetMetadata(rows, input)!;
    expect(parsed.confirmed).toEqual(parseConfirmedGraphKnowledgeAssetMetadataEnvelope(rows, input));
    expect(parsed.confirmed.state).toBe('confirmed');
    expect(parsed.bindings).toEqual(rows);
    expect(parsed.bindings).not.toBe(rows);
    expect(rows).toEqual(original);
    expect(parseResponderAssetMetadata([...rows].reverse(), input)?.identity).toBe(parsed.identity);
  });

  it('uses Unicode code point order for every raw predicate and object', () => {
    const rows = [
      { predicate: 'urn:𐀀', object: '"a"' },
      { predicate: 'urn:private-use', object: '"𐀀"' },
      { predicate: 'urn:private-use', object: '"\ue000"' },
      { predicate: 'urn:\ue000', object: '"z"' },
    ];
    const expected = createHash('sha256').update(JSON.stringify([
      ['urn:private-use', '"\ue000"'], ['urn:private-use', '"𐀀"'],
      ['urn:\ue000', '"z"'], ['urn:𐀀', '"a"'],
    ])).digest('hex');
    expect(parseResponderAssetMetadata(rows, input)?.identity).toBe(expected);
    expect(parseResponderAssetMetadata(rows, input)?.confirmed).toEqual({ state: 'absent' });
  });

  it.each(['unknown-predicate', 'duplicate-row', 'literal-spelling'] as const)(
    'keeps %s in the full identity even when the envelope stays equal', change => {
      const rows = fixture(), first = parseResponderAssetMetadata(rows, input)!;
      if (change === 'unknown-predicate') rows.push({ predicate: 'urn:extra', object: '"metadata"' });
      else if (change === 'duplicate-row') rows.push({ ...rows.find(row => row.predicate === `${DKG}accessPolicy`)! });
      else rows.find(row => row.predicate === `${DKG}merkleRoot`)!.object = `"0x${'03'.repeat(32)}"`;
      const second = parseResponderAssetMetadata(rows, input)!;
      expect(second.confirmed).toEqual(first.confirmed);
      expect(second.identity).not.toBe(first.identity);
    });

  it.each([null, undefined, 1, 'row', {}, { predicate: 'urn:p' },
    { object: '"value"' }, { predicate: 1, object: '"value"' }, { predicate: 'urn:p', object: false }])(
    'rejects malformed fetched bindings before parsing or identity use: %j', row => {
      expect(parseResponderAssetMetadata([...fixture(), row], input)).toBeNull();
    });

  it.each([
    { values: [], expected: 'absent' },
    { values: ['"public"'], expected: 'public' },
    { values: ['"public"^^<http://www.w3.org/2001/XMLSchema#string>'], expected: 'public' },
    { values: ['"public"@en'], expected: 'non-public' },
    { values: ['"private"'], expected: 'non-public' },
    { values: ['"unknown"'], expected: 'non-public' },
    { values: ['"public"', '"public"'], expected: 'non-public' },
    { values: ['"public"', '"private"'], expected: 'non-public' },
  ])('classifies $values without creating an authority grant', ({ values, expected }) => {
    const rows = fixture().filter(row => row.predicate !== `${DKG}accessPolicy`);
    rows.push(...values.map(object => ({ predicate: `${DKG}accessPolicy`, object })));
    expect(parseResponderAssetMetadata(rows, input)?.accessPolicy).toBe(expected);
  });
});
