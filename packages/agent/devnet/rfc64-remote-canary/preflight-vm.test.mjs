// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteCanaryError,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import { preflightAllNodesV1, validateNodePreflightV1 } from './preflight.mjs';
import { baseConfig, CG, statusBody } from './test-support.mjs';
import { completeOperationalParityV1 } from './vm.mjs';

test('preflight fails closed for every release-defining status condition', () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  const node = config.contextGraphs[0].source;
  const cases = [
    ['build', (status) => { status.commit = 'f'.repeat(40); }, 'node-build-mismatch'],
    ['reconciler', (status) => {
      status.syncLifecycle.syncReconcilerEnabled = false;
    }, 'sync-reconciler-disabled'],
    ['kill switch', (status) => {
      status.rfc64Catalog.rollout.killSwitch = true;
    }, 'rfc64-kill-switch-active'],
    ['catalog enabled', (status) => {
      status.rfc64Catalog.enabled = false;
    }, 'rfc64-catalog-disabled'],
    ['catalog service', (status) => {
      status.rfc64Catalog.contextGraphs[0].catalogServiceStarted = false;
    }, 'rfc64-catalog-service-not-started'],
    ['configured mode', (status) => {
      status.rfc64Catalog.rollout.contextGraphModes[CG] = 'shadow';
    }, 'rfc64-mode-mismatch'],
    ['operational mode', (status) => {
      status.rfc64Catalog.contextGraphs[0].effectiveMode = 'shadow';
    }, 'rfc64-operational-mode-missing'],
    ['chain', (status) => {
      status.chain.configured = false;
    }, 'chain-rpc-not-configured'],
    ['network', (status) => {
      status.networkId = '';
    }, 'node-network-missing'],
  ];
  for (const [label, mutate, expectedCode] of cases) {
    const status = structuredClone(statusBody());
    mutate(status);
    assert.throws(
      () => validateNodePreflightV1(status, node, config),
      (error) => error instanceof RemoteCanaryError && error.code === expectedCode,
      label,
    );
  }
});

test('preflight rejects a cross-node network identity mismatch', async () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  await assert.rejects(
    preflightAllNodesV1({
      config,
      request: {
        json: async (node) => ({
          ...statusBody(),
          networkId: node.role === 'source' ? 'otp-testnet-2160' : 'otp-other',
        }),
      },
    }),
    (error) => error instanceof RemoteCanaryError && error.code === 'node-network-mismatch',
  );
});

test('complete VM parity requires every canonical cursor field', () => {
  const required = [
    'expectedCatalogHeadDigest',
    'appliedCatalogHeadDigest',
    'expectedInventoryDigest',
    'appliedInventoryDigest',
    'expectedRowCount',
    'appliedRowCount',
    'missingRowCount',
    'catalogVersion',
    'lastSuccessfulAdvanceAt',
  ];
  assert.notEqual(completeOperationalParityV1(statusBody(), CG), null);
  for (const field of required) {
    const status = structuredClone(statusBody());
    delete status.rfc64Catalog.contextGraphs[0][field];
    assert.equal(completeOperationalParityV1(status, CG), null, field);
  }
  for (const [field, value] of [
    ['appliedCatalogHeadDigest', `0x${'AB'.repeat(32)}`],
    ['appliedRowCount', '01'],
    ['catalogVersion', '-1'],
    ['lastSuccessfulAdvanceAt', 1893456000],
  ]) {
    const status = structuredClone(statusBody());
    status.rfc64Catalog.contextGraphs[0][field] = value;
    assert.equal(completeOperationalParityV1(status, CG), null, field);
  }
});
