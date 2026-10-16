import { describe, expect, it } from 'vitest';
import { BULK_GRAPH_MAX_ASSETS } from '@origintrail-official/dkg-core';
import { validateBulkGraphRequest, bulkJson, parseBulkAssetHeader, parseBulkChunkEnd, parseBulkRefusal } from '../src/sync/bulk-graph-contract.js';

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

const header = { encodedBytes: 10, plainBytes: 20, offset: 0, digest: 'a'.repeat(64), metadata: 'YQ==' };
describe('bulk control payload validation', () => {
  it('constructs closed headers and preserves open control-record acceptance', () => {
    expect(parseBulkAssetHeader(bulkJson(header))).toEqual(header);
    expect(() => parseBulkAssetHeader(bulkJson({ ...header, extra: true }))).toThrow();
    expect(() => validateBulkGraphRequest({ ...request([ual(1)]), extra: true })).toThrow();
    expect(parseBulkChunkEnd(bulkJson({ digest: 'opaque', assets: -1, encodedBytes: 0.5, extra: true })))
      .toEqual({ digest: 'opaque', assets: -1, encodedBytes: 0.5 }); // Receiver owns matching the final directory.
    expect(parseBulkRefusal(bulkJson({ code: 'RESOURCE_LIMIT', extra: true }))).toEqual({ code: 'RESOURCE_LIMIT' });
  });
  it.each(['encodedBytes', 'plainBytes', 'offset', 'digest', 'metadata'] as const)('rejects missing or wrongly typed %s', key => {
    const missing: Record<string, unknown> = { ...header }; delete missing[key];
    expect(() => parseBulkAssetHeader(bulkJson(missing))).toThrow();
    expect(() => parseBulkAssetHeader(bulkJson({ ...header, [key]: null }))).toThrow();
  });
  it.each([null, [], false, 1, 'record'])('rejects a non-record payload: %j', value => {
    for (const parse of [parseBulkAssetHeader, parseBulkChunkEnd, parseBulkRefusal])
      expect(() => parse(bulkJson(value))).toThrow();
  });
});
