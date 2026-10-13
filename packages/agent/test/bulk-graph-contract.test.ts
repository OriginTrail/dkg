import { describe, expect, it } from 'vitest';
import { BULK_GRAPH_MAX_ASSETS } from '@origintrail-official/dkg-core';
import { validateBulkGraphRequest } from '../src/sync/bulk-graph-contract.js';

const ual = (id: number) => `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${id}`;
const request = (assetUals: unknown[]) => ({ version: 1, contextGraphId: 'bulk-fixture',
  snapshotDigest: 'a'.repeat(64), assetUals });

describe('bulk graph request identity validation', () => {
  it('accepts the full bulk selection in request order, independently of the ten-asset exact limit', () => {
    const selection = Array.from({ length: BULK_GRAPH_MAX_ASSETS }, (_, i) => ual(BULK_GRAPH_MAX_ASSETS - i));
    expect(validateBulkGraphRequest(request(selection)).assetUals).toEqual(selection);
    expect(() => validateBulkGraphRequest(request([...selection, ual(BULK_GRAPH_MAX_ASSETS + 1)]))).toThrow();
  });
  it.each([[], [ual(1), ual(1)], [ual(1), 2], [ual(1), null], ['not-a-ual'],
    [ual(1).replace('/1', '/01')], [ual(1).replace('did:dkg:', 'DID:DKG:')]])(
    'rejects empty, duplicate, non-string, malformed or noncanonical identities: %j', (...selection) => {
      expect(() => validateBulkGraphRequest(request(selection))).toThrow();
    });
});
