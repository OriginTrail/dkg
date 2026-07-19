import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await import('@origintrail-official/dkg-agent');
const legacyAgent = await import('@origintrail-official/dkg-agent/dist/dkg-agent.js');
const require = createRequire(import.meta.url);
const packageManifest = require('@origintrail-official/dkg-agent/package.json');

if (
  typeof root.DKGAgent !== 'function'
  || typeof legacyAgent.DKGAgent !== 'function'
  || typeof root.Rfc64PublicCatalogSuccessorProducerV1 !== 'function'
) {
  throw new Error('published agent entry points did not expose required root APIs');
}
if (packageManifest.name !== '@origintrail-official/dkg-agent') {
  throw new Error('historical package.json subpath no longer resolves');
}
const publicRfc64Modules = [
  'author-catalog-producer.js',
  'catalog-row-authorship.js',
  'inventory-v1/candidate.js',
  'inventory-v1/index.js',
  'inventory-v1/lifecycle-adapter.js',
  'inventory-v1/open.js',
  'inventory-v1/scalars.js',
  'inventory-v1/sql.js',
  'inventory-v1/statements.js',
];
const blockedRfc64Modules = [
  'control-object-store-v1-internal.js',
  'control-object-store-v1.js',
  'durable-file-store-v1.js',
  'ka-bundle-store-v1-internal.js',
  'ka-bundle-store-v1.js',
  'open-catalog-policy-v1.js',
  'persistence-layout-v1.js',
  'persistence-root-ownership-v1-internal.js',
  'persistence-v1.js',
  'policy-cell-v1.js',
  'public-catalog-native-reconciler-v1.js',
  'public-catalog-native-receiver-v1.js',
  'public-catalog-native-transport-v1.js',
  'public-catalog-reconciliation-failure-v1.js',
  'public-catalog-receiver-v1.js',
  'public-catalog-service-v1.js',
  'public-catalog-issuer-delegation-v1.js',
  'public-catalog-successor-producer-v1.js',
  'public-catalog-transport-v1.js',
  'secure-filesystem-policy-v1.js',
];
const packageExports = packageManifest.exports;
const emittedRfc64Modules = await listEmittedRfc64Modules();
const classifiedRfc64Modules = new Set([
  ...publicRfc64Modules,
  ...blockedRfc64Modules,
]);

for (const path of emittedRfc64Modules) {
  const subpath = `./dist/rfc64/${path}`;
  if (!Object.hasOwn(packageExports, subpath) || !classifiedRfc64Modules.has(path)) {
    throw new Error(`emitted RFC-64 module is not explicitly classified: ${path}`);
  }
}
for (const path of classifiedRfc64Modules) {
  if (!emittedRfc64Modules.includes(path)) {
    throw new Error(`classified RFC-64 module was not emitted: ${path}`);
  }
}
for (const path of publicRfc64Modules) {
  const subpath = `./dist/rfc64/${path}`;
  if (packageExports[subpath] !== subpath) {
    throw new Error(`legacy RFC-64 module is not explicitly public: ${path}`);
  }
  await import(`@origintrail-official/dkg-agent/dist/rfc64/${path}`);
}

for (const path of blockedRfc64Modules) {
  const subpath = `./dist/rfc64/${path}`;
  if (packageExports[subpath] !== null) {
    throw new Error(`internal RFC-64 module is not explicitly blocked: ${path}`);
  }
  try {
    await import(`@origintrail-official/dkg-agent/dist/rfc64/${path}`);
    throw new Error(`internal RFC-64 module unexpectedly resolved: ${path}`);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  }
}

if (packageExports['./dist/rfc64/*'] !== null) {
  throw new Error('unclassified RFC-64 deep imports are not blocked by default');
}
if (packageExports['./dist/*'] !== './dist/*') {
  throw new Error('historical non-RFC-64 ./dist/* compatibility was not preserved');
}

async function listEmittedRfc64Modules() {
  const rootPath = fileURLToPath(new URL('../dist/rfc64/', import.meta.url));
  const pending = [rootPath];
  const modules = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        modules.push(relative(rootPath, entryPath).split(sep).join('/'));
      }
    }
  }
  return modules.sort();
}
