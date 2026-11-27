import fs from 'node:fs';
import path from 'node:path';
import { unsigned } from './inventory-commitments.mjs';
import { computeAuthorCatalogHeadObjectDigestV1, computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogBucketObjectDigestV1 } from '../../packages/core/dist/index.js';

/** Read the same on-disk object closure used by snapshot.mjs, retaining partial evidence on failure. */
export function collectCatalogs(objectRoot, applied, contextGraphId) {
  const catalogs = [];
  function read(digest) {
    const hex = Buffer.isBuffer(digest) ? digest.toString('hex') : digest.replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) throw Error('Invalid catalog object reference');
    return JSON.parse(fs.readFileSync(path.join(objectRoot, hex.slice(0, 2), hex + '.jcs'), 'utf8'));
  }
  try {
    for (const record of applied) {
      const head = read(record.current_catalog_head_digest);
      if (head.payload.contextGraphId !== contextGraphId) continue;
      const catalog = { head, rows: [], objects: [head] }; catalogs.push(catalog);
      const headDigest = computeAuthorCatalogHeadObjectDigestV1(unsigned(head));
      const expected = Buffer.isBuffer(record.current_catalog_head_digest) ? '0x' + record.current_catalog_head_digest.toString('hex') : record.current_catalog_head_digest;
      if (headDigest !== expected) throw Error('Catalog head does not match stored reference');
      const visited = new Set([headDigest]);
      function walk(digest, type) {
        if (visited.has(digest)) throw Error('Repeated catalog object reference');
        visited.add(digest);
        const object = read(digest); catalog.objects.push(object);
        if (object.objectType !== type) throw Error('Mistyped catalog object reference');
        const actual = type === 'AuthorCatalogBucketV1'
          ? computeAuthorCatalogBucketObjectDigestV1(unsigned(object))
          : computeAuthorCatalogDirectoryNodeObjectDigestV1(unsigned(object), head.payload.bucketCount);
        if (actual !== digest) throw Error('Catalog object does not match stored reference');
        if (type === 'AuthorCatalogBucketV1') { catalog.rows.push(...object.payload.rows); return; }
        // The core canonical validator above enforces zero digest AND byte length for absent buckets.
        for (const entry of object.payload.entries) {
          if (object.payload.level === '0') {
            if (entry.rowCount !== '0') walk(entry.bucketDigest, 'AuthorCatalogBucketV1');
          } else walk(entry.childDigest, 'AuthorCatalogDirectoryNodeV1');
        }
      }
      walk(head.payload.directoryRootDigest, 'AuthorCatalogDirectoryNodeV1');
    }
    return catalogs;
  } catch (error) { error.catalogs = catalogs; throw error; }
}
