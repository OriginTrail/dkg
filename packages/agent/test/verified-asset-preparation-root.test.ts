import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import { partitionVerifiedGraphScopedAssets } from '../src/sync/requester/verified-asset-preparation.js';

const contextGraphId = 'verified-root';
const ual = `did:dkg:otp:2043/0x${'1'.repeat(40)}/1`;
const assertionGraph = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/0x${'1'.repeat(40)}/1`;
const predicate = 'http://dkg.io/ontology/merkleRoot';
function metadata(roots: string[]): Quad[] {
  return [
    ['contentScopeVersion', '"2"'], ['kaUal', ual], ['assertionVersion', '"1"'],
    ['assertionGraph', assertionGraph], ['contextGraph', `did:dkg:context-graph:${contextGraphId}`],
    ['publicTripleCount', '"1"'], ['privateTripleCount', '"0"'],
    ...roots.map(root => ['merkleRoot', `"${root}"`]),
  ].map(([name, object]) => ({ subject: ual, predicate: `http://dkg.io/ontology/${name}`,
    object: object!, graph: `did:dkg:context-graph:${contextGraphId}/_meta` }));
}
function partition(roots: string[]) {
  return partitionVerifiedGraphScopedAssets(contextGraphId, [], metadata(roots), [assertionGraph]);
}
describe('verified asset root boundary', () => {
  it('carries the normalized root without rewriting the received metadata', () => {
    const root = 'AB'.repeat(32);
    const asset = partition([root]).assets[0]!;
    expect(asset.merkleRootHex).toBe(root.toLowerCase());
    expect(asset.metadataQuads.find(row => row.predicate === predicate)?.object).toBe(`"${root}"`);
  });
  it.each([[], ['ab'.repeat(32), 'ab'.repeat(32)], ['ab'.repeat(31)], ['z'.repeat(64)]])(
    'rejects missing, duplicate or malformed roots: %j', (...roots: string[]) => {
      expect(() => partition(roots)).toThrow();
    },
  );
});
