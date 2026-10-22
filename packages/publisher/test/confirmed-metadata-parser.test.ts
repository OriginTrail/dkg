import { describe, expect, it, vi } from 'vitest';
import {
  MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  generateGraphKnowledgeAssetMetadata,
  parseConfirmedGraphKnowledgeAssetMetadataEnvelope,
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
