import { createRequire } from 'node:module';

const root = await import('@origintrail-official/dkg-agent');
const legacyAgent = await import('@origintrail-official/dkg-agent/dist/dkg-agent.js');
const require = createRequire(import.meta.url);
const packageManifest = require('@origintrail-official/dkg-agent/package.json');
const legacyCatalogProducer = await import(
  '@origintrail-official/dkg-agent/dist/rfc64/author-catalog-producer.js'
);
const legacyInventory = await import(
  '@origintrail-official/dkg-agent/dist/rfc64/inventory-v1/index.js'
);

if (typeof root.DKGAgent !== 'function' || typeof legacyAgent.DKGAgent !== 'function') {
  throw new Error('published agent entry points did not expose DKGAgent');
}
if (packageManifest.name !== '@origintrail-official/dkg-agent') {
  throw new Error('historical package.json subpath no longer resolves');
}
if (
  typeof legacyCatalogProducer.produceEmptyAuthorCatalogGenesisV1 !== 'function'
  || typeof legacyInventory.openInventoryV1 !== 'function'
) {
  throw new Error('historical RFC-64 deep imports no longer resolve');
}

const blockedRfc64Modules = [
  'control-object-store-v1-internal.js',
  'control-object-store-v1.js',
  'durable-file-store-v1.js',
  'persistence-layout-v1.js',
  'persistence-root-ownership-v1-internal.js',
  'persistence-v1.js',
  'secure-filesystem-policy-v1.js',
];

for (const path of blockedRfc64Modules) {
  try {
    await import(`@origintrail-official/dkg-agent/dist/rfc64/${path}`);
    throw new Error(`internal RFC-64 module unexpectedly resolved: ${path}`);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
  }
}
