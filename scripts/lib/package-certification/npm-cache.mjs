// Versioned acquisition boundary for npm's bundled cacache. No dependency from
// the checkout is loaded into the product container, and no additional npm
// installation contaminates the fresh cache being observed.
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { CACHE_READER_ID, hash, validateCacheReader } from './bundle.mjs';

export async function readNpmCache({ npmExecutable, npmVersion, cacheDirectory, manifest }) {
  const npmRequire = createRequire(npmExecutable);
  const reader = { id: CACHE_READER_ID, npmVersion, cacacheVersion: npmRequire('cacache/package.json').version };
  validateCacheReader(reader, npmVersion);
  const cache = npmRequire('cacache');
  const directory = path.join(cacheDirectory, '_cacache');
  const entries = Object.values(await cache.ls(directory));
  const archives = await archiveRecords({ entries, manifest, readBytes: integrity => cache.get.byDigest(directory, integrity) });
  return { reader, archives };
}

// Pure interpretation of acquired cache entries; tests can supply fetched bytes
// without depending on npm's module layout or on-disk representation.
export async function archiveRecords({ entries, manifest, readBytes }) {
  const prefix = 'make-fetch-happen:request-cache:';
  const cached = new Set(entries.map(entry => entry.integrity));
  const archives = {};
  for (const entry of entries) {
    if (!entry.key.startsWith(prefix)) continue;
    const resolved = entry.key.slice(prefix.length);
    if (resolved.includes('/registry/tarballs/')) {
      const prepared = manifest.packages.find(pkg => resolved.endsWith(`/registry/${pkg.tarball}`));
      assert.ok(prepared, 'unexpected candidate archive request');
      const bytes = await readBytes(entry.integrity);
      const integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`;
      assert.equal(integrity, prepared.integrity, 'candidate cache archive differs');
      archives[`${prepared.name}@${prepared.version}`] = { integrity, resolved };
      continue;
    }
    if (resolved.includes('.tgz')) continue;
    const bytes = await readBytes(entry.integrity);
    if (bytes[0] !== 123) continue;
    let metadata;
    try { metadata = JSON.parse(bytes); } catch { continue; }
    if (!metadata.name || metadata.name.startsWith('@origintrail-official/')) continue;
    for (const version of Object.values(metadata.versions ?? {})) {
      if (version.dist?.integrity && cached.has(version.dist.integrity)) {
        archives[`${metadata.name}@${version.version}`] = { integrity: version.dist.integrity, resolved: version.dist.tarball };
      }
    }
  }
  return archives;
}
