import assert from 'node:assert/strict';

const publisher = await import('@origintrail-official/dkg-publisher');
assert.equal(typeof publisher.DKGPublisher, 'function');

const legacyWorkspaceResolution = await import(
  '@origintrail-official/dkg-publisher/dist/workspace-resolution.js'
);
assert.equal(
  typeof legacyWorkspaceResolution.storeKnowledgeAssetWorkspaceHead,
  'function',
);

await assert.rejects(
  import('@origintrail-official/dkg-publisher/dist/promote-replay-safety.js'),
  (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
);

await assert.rejects(
  import('@origintrail-official/dkg-publisher/dist/dkg-publisher.js'),
  (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
);
