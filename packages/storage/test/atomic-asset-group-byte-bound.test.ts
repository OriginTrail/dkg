import { afterEach, expect, it, vi } from 'vitest';
import { ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES, buildAtomicAssetGroupUpdate, type AtomicAssetReplacement } from '../src/atomic-asset-group.js';
import { buildBulkAssetGroupPlan } from '../src/adapters/bulk-asset-group.js';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';

// Each literal is legal (60,000 bytes), but the full eight-member group crosses
// 32 MiB. Non-ASCII text distinguishes encoded bytes from JS string length.
function group(rows: number): AtomicAssetReplacement[] {
  const object = JSON.stringify('€'.repeat(20_000));
  return Array.from({ length: 8 }, (_, index) => ({
    graphUri: `urn:bound:data:${index}`, metaGraphUri: 'urn:bound:meta', metadataSubject: `urn:bound:asset:${index}`,
    graphQuads: Array.from({ length: rows }, (_, row) => ({ graph: `urn:bound:data:${index}`,
      subject: `urn:bound:entity:${row}`, predicate: 'urn:value', object })), metadataQuads: [],
  }));
}
afterEach(() => vi.unstubAllGlobals());
it.each(['sparql', 'native'] as const)('bounds the actual %s serialization on both sides of 32 MiB', plan => {
  const encoded = plan === 'sparql' ? buildAtomicAssetGroupUpdate(group(69)).update : buildBulkAssetGroupPlan(group(34))!.nquads;
  expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES);
  expect(Buffer.byteLength(encoded)).toBeGreaterThan(31 * 1024 * 1024);
  expect(encoded.length).toBeLessThan(ATOMIC_ASSET_GROUP_MAX_UPDATE_BYTES);
  expect(() => plan === 'sparql' ? buildAtomicAssetGroupUpdate(group(70)) : buildBulkAssetGroupPlan(group(35)))
    .toThrow('byte allowance exceeded');
}, 30_000);
it.each(['oxigraph', 'sparql', 'native'] as const)('rejects an oversized group before %s dispatch', async backend => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const store = backend === 'oxigraph' ? new OxigraphStore() : backend === 'native'
    ? new BlazegraphStore('http://fixture.invalid/sparql')
    : new SparqlHttpStore({ queryEndpoint: 'http://fixture.invalid/sparql', consistencyProfile: 'atomic-update' });
  try {
    if (backend === 'oxigraph') await store.insert([{ graph: 'urn:bound:data:0', subject: 'urn:old', predicate: 'urn:value', object: '"keep"' }]);
    await expect(store.replaceAssetGroup(group(backend === 'native' ? 35 : 70))).rejects.toThrow('byte allowance exceeded');
    expect(fetcher).not.toHaveBeenCalled();
    if (backend === 'oxigraph') expect(await store.query('ASK { GRAPH <urn:bound:data:0> { <urn:old> <urn:value> "keep" } }'))
      .toEqual({ type: 'boolean', value: true });
  } finally { await store.close(); }
}, 30_000);
