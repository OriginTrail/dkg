import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REQUIRED_PRODUCTION_ADAPTER_OPERATIONS,
  appliedReadBackFromTransfer,
  semanticReadBackFromTransfer,
  type Gate1TransferEvidence,
} from './model.js';

const transfer: Gate1TransferEvidence = {
  activatedQuadCount: 2,
  authorAddress: `0x${'11'.repeat(20)}`,
  bundleByteLength: 300,
  bundleDigest: `0x${'22'.repeat(32)}`,
  catalogRowDigest: `0x${'33'.repeat(32)}`,
  contentByteLength: 168,
  contentDigest: `0x${'44'.repeat(32)}`,
  head: {
    appliedInventoryDigest: `0x${'55'.repeat(32)}`,
    catalogHeadDigest: `0x${'66'.repeat(32)}`,
    catalogVersion: '1',
    previousCatalogHeadDigest: `0x${'77'.repeat(32)}`,
  },
  inventoryRowCount: 1,
  kaUal: `did:dkg:otp:20430/0x${'11'.repeat(20)}/7`,
  swmGraph: `did:dkg:swm:0x${'88'.repeat(20)}/gate-1/0x${'11'.repeat(20)}/7`,
};

test('the six-operation adapter boundary remains exact and product-facing', () => {
  assert.deepEqual(REQUIRED_PRODUCTION_ADAPTER_OPERATIONS, [
    'publishGenesis',
    'publishSuccessor',
    'announce',
    'appliedHeadReadback',
    'exactInventoryReadback',
    'killRestart',
  ]);
});

test('applied and semantic readbacks are selected from runtime transfer evidence', () => {
  assert.deepEqual(appliedReadBackFromTransfer(transfer), {
    appliedInventoryDigest: transfer.head.appliedInventoryDigest,
    catalogVersion: '1',
    currentCatalogHeadDigest: transfer.head.catalogHeadDigest,
    inventoryRowCount: 1,
  });
  assert.deepEqual(semanticReadBackFromTransfer(transfer), {
    activatedQuadCount: 2,
    catalogHeadDigest: transfer.head.catalogHeadDigest,
    catalogRowDigest: transfer.catalogRowDigest,
    contentDigest: transfer.contentDigest,
    kaUal: transfer.kaUal,
    swmGraph: transfer.swmGraph,
  });
});
