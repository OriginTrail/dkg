import { parseGraphKnowledgeAssetStructure } from '../src/graph-metadata-envelope.js';
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  GRAPH_KNOWLEDGE_ASSET_ENVELOPE_PREDICATES,
  generateGraphKnowledgeAssetMetadata,
  parseConfirmedGraphKnowledgeAssetMetadataEnvelope,
  parseGraphKnowledgeAssetMetadataEnvelope,
  readConfirmedGraphKnowledgeAssetMetadataEnvelope,
} from '../src/metadata.js';

const DKG = 'http://dkg.io/ontology/';
const input = { contextGraphId: 'confirmed-parser',
  ual: 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/7' };

function fixture(privateCount = 0, subGraphName?: string) {
  const graph = knowledgeAssetLayerGraphUri(input.contextGraphId, MemoryLayer.VerifiableMemory,
    createGraphKnowledgeAssetScope(input.ual, 3), subGraphName);
  return generateGraphKnowledgeAssetMetadata({ ...input, assertionVersion: '3', assertionGraph: graph,
    publisherPeerId: 'publisher', merkleRoot: new Uint8Array(32).fill(7),
    timestamp: new Date(0), publicTripleCount: 2, privateTripleCount: privateCount,
    ...(privateCount ? { privateMerkleRoot: new Uint8Array(32).fill(9) } : {}),
    ...(subGraphName ? { subGraphName } : {}),
  }, { status: 'confirmed', confirmation: { kind: 'transaction',
    provenance: { batchId: 7n, txHash: `0x${'11'.repeat(32)}` } } });
}

async function compareWithReader(rows: readonly Pick<Quad, 'predicate' | 'object'>[]) {
  const bindings = rows.map(row => ({ ...row }));
  const query = vi.fn(async (_sparql: string) => ({ type: 'bindings' as const, bindings }));
  const parsed = parseConfirmedGraphKnowledgeAssetMetadataEnvelope(rows, input);
  const projected = rows.filter(row => GRAPH_KNOWLEDGE_ASSET_ENVELOPE_PREDICATES.includes(row.predicate));
  expect(parseConfirmedGraphKnowledgeAssetMetadataEnvelope(projected, input)).toEqual(parsed);
  expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope({ query } as unknown as TripleStore, input)).toEqual(parsed);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.length).toBe(1);
  return parsed;
}

describe('confirmed graph metadata parser', () => {
  it.each([{ privateCount: 0 }, { privateCount: 2, subGraphName: 'documents' }])(
    'matches the IO reader for a confirmed envelope with $privateCount private rows', async options => {
      const rows = fixture(options.privateCount, options.subGraphName);
      const parsed = await compareWithReader(rows);
      expect(parsed.state).toBe('confirmed');
      if (parsed.state !== 'confirmed') throw new Error('Confirmed fixture absent');
      expect(parsed.envelope).toMatchObject({ assertionVersion: '3', publicTripleCount: 2,
        privateTripleCount: options.privateCount, batchId: 7n, transactionHash: `0x${'11'.repeat(32)}` });
      expect(parseConfirmedGraphKnowledgeAssetMetadataEnvelope([...rows].reverse(), input)).toEqual(parsed);
    });

  it('accepts locally authenticated confirmation without a receipt and keeps the input unchanged', async () => {
    const rows = fixture().filter(row => row.predicate !== `${DKG}transactionHash`);
    const original = structuredClone(rows);
    const parsed = await compareWithReader(Object.freeze(rows.map(row => Object.freeze(row))));
    expect(parsed.state).toBe('confirmed');
    if (parsed.state !== 'confirmed') throw new Error('Confirmed fixture absent');
    expect(parsed.envelope.transactionHash).toBeUndefined();
    expect(rows).toEqual(original);
  });

  it.each(['empty', 'legacy'] as const)('preserves %s absence', async shape => {
    const rows = shape === 'empty' ? [] : fixture().filter(row => row.predicate !== `${DKG}contentScopeVersion`);
    expect(await compareWithReader(rows)).toEqual({ state: 'absent' });
  });

  it.each(['duplicate-version', 'wrong-graph', 'wrong-ual', 'tentative', 'unsafe-count',
    'private-root-with-zero-count', 'private-count-without-root', 'invalid-receipt'] as const)(
    'preserves structural refusal for %s', async fault => {
      const rows = fixture();
      const replace = (predicate: string, object: string) => { rows.find(row => row.predicate === `${DKG}${predicate}`)!.object = object; };
      if (fault === 'duplicate-version') rows.push({ ...rows.find(row => row.predicate === `${DKG}assertionVersion`)! });
      else if (fault === 'wrong-graph') replace('assertionGraph', 'urn:other-graph');
      else if (fault === 'wrong-ual') replace('kaUal', `${input.ual}/other`);
      else if (fault === 'tentative') replace('status', '"tentative"');
      else if (fault === 'unsafe-count') replace('publicTripleCount', '"9007199254740992"');
      else if (fault === 'private-root-with-zero-count') rows.push({ ...rows[0]!, predicate: `${DKG}privateMerkleRoot`, object: `"${'22'.repeat(32)}"` });
      else if (fault === 'private-count-without-root') replace('privateTripleCount', '"1"');
      else replace('transactionHash', '"0xinvalid"');
      expect(await compareWithReader(rows)).toEqual({ state: 'invalid' });
    });

  it('preserves IO errors for incomplete bindings and unexpected result kinds', async () => {
    const query = vi.fn().mockResolvedValueOnce({ type: 'bindings', bindings: [{ predicate: `${DKG}status` }] })
      .mockResolvedValueOnce({ type: 'boolean', value: true });
    const store = { query } as unknown as TripleStore;
    await expect(readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, input)).rejects.toThrow('incomplete binding');
    await expect(readConfirmedGraphKnowledgeAssetMetadataEnvelope(store, input)).rejects.toThrow('expected a bindings result');
  });
});

it('preserves tentative envelopes without requiring chain provenance or upgrading their status', () => {
  const rows = fixture().filter(q => ![`${DKG}batchId`, `${DKG}transactionHash`].includes(q.predicate))
    .map(q => q.predicate === `${DKG}status` ? { ...q, object: '"tentative"' } : q);
  expect(parseConfirmedGraphKnowledgeAssetMetadataEnvelope(rows, input)).toEqual({ state: 'invalid' });
  expect(parseGraphKnowledgeAssetMetadataEnvelope(rows, input)).toMatchObject({ state: 'tentative', envelope: { assertionVersion: '3' } });
  const corrupt = rows.map(q => q.predicate === `${DKG}assertionGraph` ? { ...q, object: 'urn:wrong' } : q);
  expect(parseGraphKnowledgeAssetMetadataEnvelope(corrupt, input)).toEqual({ state: 'invalid' });
  expect(parseGraphKnowledgeAssetMetadataEnvelope([...rows, { ...rows[0]!, predicate: `${DKG}status`, object: '"confirmed"' }], input)).toEqual({ state: 'invalid' });
});


describe('shared structural parsing policies', () => {
  it.each(['canonical', 'duplicate', 'leading-zero', 'bare-number', 'scope-version'])(
    'preserves wire versus stored acceptance for %s', fault => {
      const rows = fixture(2, 'documents');
      const version = rows.find(row => row.predicate === `${DKG}assertionVersion`)!;
      if (fault === 'duplicate') rows.push({ ...version });
      if (fault === 'leading-zero') version.object = '"03"';
      if (fault === 'bare-number') version.object = '3';
      if (fault === 'scope-version') rows.find(row => row.predicate === `${DKG}contentScopeVersion`)!.object = '"999"';
      const wire = parseGraphKnowledgeAssetStructure(rows, input, { syntax: 'wire', context: 'required' });
      expect(wire).toMatchObject({ assertionVersion: '3', contextGraphId: input.contextGraphId,
        publicTripleCount: 2, privateTripleCount: 2, subGraphName: 'documents' });
      const stored = parseGraphKnowledgeAssetMetadataEnvelope(rows, input, 'stored-context');
      expect(stored.state).toBe(fault === 'canonical' ? 'confirmed' : 'invalid');
      if (stored.state === 'confirmed') {
        expect(stored.envelope.merkleRoot).toEqual(wire.merkleRoot);
        expect(stored.envelope.privateMerkleRoot).toEqual(wire.privateMerkleRoot);
      }
    });

  it.each(['missing-context', 'wrong-context', 'wrong-meta-graph', 'rootEntity', 'partOf'])(
    'enforces stored context admission without changing external confirmed readers (%s)', fault => {
      let rows = fixture();
      if (fault === 'missing-context') rows = rows.filter(row => row.predicate !== `${DKG}contextGraph`);
      else if (fault === 'wrong-context') rows.find(row => row.predicate === `${DKG}contextGraph`)!.object = 'did:dkg:context-graph:other';
      else if (fault === 'wrong-meta-graph') rows = rows.map(row => ({ ...row, graph: 'urn:wrong' }));
      else rows.push({ ...rows[0]!, predicate: `${DKG}${fault}`, object: 'urn:legacy' });
      expect(parseGraphKnowledgeAssetMetadataEnvelope(rows, input).state).toBe('confirmed');
      expect(parseGraphKnowledgeAssetMetadataEnvelope(rows, input, 'stored-context')).toEqual({ state: 'invalid' });
      expect(() => parseGraphKnowledgeAssetStructure(rows, input, { syntax: 'wire', context: 'required' })).toThrow();
    });
});
