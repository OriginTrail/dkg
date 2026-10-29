import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectCatalogs } from './catalog-collector.mjs';
import { inventoryScopeFixture } from './inventory-scope-fixture.mjs';
import { verifyInventoryScope } from './inventory-scope.mjs';
import { computeAuthorCatalogScopeDigestV1, deriveAuthorCatalogScopeFromHeadV1, computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1, computeAuthorCatalogBucketObjectDigestV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1 } from '../../packages/core/dist/index.js';
const campaign = { contextGraphId: 'collector', author: '0x' + '11'.repeat(20) };
function store(root, fixture) {
  const head = fixture.catalogs[0].head;
  for (const object of fixture.catalogs[0].objects) {
    const digest = (object.objectType === 'AuthorCatalogHeadV1' ? computeAuthorCatalogHeadObjectDigestV1(object)
      : object.objectType === 'AuthorCatalogBucketV1' ? computeAuthorCatalogBucketObjectDigestV1(object)
        : computeAuthorCatalogDirectoryNodeObjectDigestV1(object, head.payload.bucketCount)).slice(2);
    const file = path.join(root, digest.slice(0, 2), digest + '.jcs'); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(object));
  }
}
function sparse() {
  const f = inventoryScopeFixture(campaign, [], [{ assertionCoordinate: 'asset' }], '1');
  const [head, directory, bucket] = f.catalogs[0].objects;
  const scope = { ...deriveAuthorCatalogScopeFromHeadV1(head.payload), bucketCount: '2' }, scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  Object.assign(bucket.payload, { catalogScopeDigest: scopeDigest, bucketCount: '2' });
  Object.assign(directory.payload, { catalogScopeDigest: scopeDigest });
  directory.payload.entries = [{ bucketId: '0', rowCount: '1', bucketDigest: computeAuthorCatalogBucketObjectDigestV1(bucket),
    byteLength: String(canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload).byteLength) },
  { bucketId: '1', rowCount: '0', byteLength: '0', bucketDigest: '0x' + '00'.repeat(32) }];
  Object.assign(head.payload, { bucketCount: '2', directoryRootDigest: computeAuthorCatalogDirectoryNodeObjectDigestV1(directory, '2') });
  const digest = computeAuthorCatalogHeadObjectDigestV1(head);
  Object.assign(f.capture.applied[0], { catalog_scope_digest: scopeDigest, current_catalog_head_digest: digest });
  Object.assign(f.status.value.rfc64Catalog.contextGraphs[0], { expectedCatalogHeadDigest: digest, appliedCatalogHeadDigest: digest });
  return f;
}
test('snapshot filesystem collector preserves empty obsolete and sparse current catalogs in either order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-collector-'));
  try {
    const old = inventoryScopeFixture(campaign, [], [], '0'), current = sparse();
    store(root, old); store(root, current);
    for (const fixtures of [[old, current], [current, old]]) {
      const applied = fixtures.flatMap(f => f.capture.applied);
      // Actual SQLite callers pass Buffer digests; exercise that representation too.
      const catalogs = collectCatalogs(root, applied.map(r => ({ ...r, current_catalog_head_digest: Buffer.from(r.current_catalog_head_digest.slice(2), 'hex') })), campaign.contextGraphId);
      assert.deepEqual(catalogs.map(c => c.rows.length), fixtures.map(f => f.catalogs[0].rows.length));
      const capture = { ...current.capture, scopes: fixtures.flatMap(f => f.capture.scopes), applied };
      const proof = verifyInventoryScope(campaign, capture, catalogs, current.status);
      assert.equal(proof.valid, true, JSON.stringify(proof.errors)); assert.equal(proof.catalogRows.length, 1);
      assert.equal(proof.excludedCatalogHeads.length, 1);
    }
    assert.equal(fs.existsSync(path.join(root, '00', '00'.repeat(32) + '.jcs')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('snapshot filesystem collector refuses malformed absent descriptors and retains partial objects on missing files', () => {
  for (const corrupt of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-collector-failure-'));
    try {
      const f = sparse(); store(root, f);
      const directory = f.catalogs[0].objects[1], digest = f.catalogs[0].head.payload.directoryRootDigest.slice(2);
      if (corrupt) {
        directory.payload.entries[1].byteLength = '1';
        fs.writeFileSync(path.join(root, digest.slice(0, 2), digest + '.jcs'), JSON.stringify(directory));
      } else {
        const bucketDigest = directory.payload.entries[0].bucketDigest.slice(2);
        fs.unlinkSync(path.join(root, bucketDigest.slice(0, 2), bucketDigest + '.jcs'));
      }
      assert.throws(() => collectCatalogs(root, f.capture.applied, campaign.contextGraphId), error => {
        assert.equal(error.catalogs.length, 1); assert.equal(error.catalogs[0].objects.length, 2);
        assert.deepEqual(error.catalogs[0].objects[1], directory); assert.ok(error.message); return true;
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
