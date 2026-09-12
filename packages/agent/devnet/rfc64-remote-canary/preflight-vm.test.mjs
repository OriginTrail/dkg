// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteCanaryError,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import { preflightAllNodesV1, validateNodePreflightV1 } from './preflight.mjs';
import { baseConfig, CG, statusBody } from './test-support.mjs';
import { completeOperationalParityV1, verifyVmParityV1 } from './vm.mjs';

test('preflight fails closed for every release-defining status condition', () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  const node = config.contextGraphs[0].source;
  const cases = [
    ['build', (status) => {
      status.rfc64Certification.commit = 'f'.repeat(40);
    }, 'node-build-mismatch'],
    ['reconciler', (status) => {
      status.rfc64Certification.syncReconcilerEnabled = false;
    }, 'sync-reconciler-disabled'],
    ['kill switch', (status) => {
      status.rfc64Certification.catalog.killSwitch = true;
    }, 'rfc64-kill-switch-active'],
    ['catalog enabled', (status) => {
      status.rfc64Certification.catalog.enabled = false;
    }, 'rfc64-catalog-disabled'],
    ['catalog service', (status) => {
      status.rfc64Certification.catalog.contextGraphs[0].catalogServiceStarted = false;
    }, 'rfc64-catalog-service-not-started'],
    ['configured mode', (status) => {
      status.rfc64Certification.catalog.contextGraphModes[CG] = 'shadow';
    }, 'rfc64-mode-mismatch'],
    ['operational mode', (status) => {
      status.rfc64Certification.catalog.contextGraphs[0].effectiveMode = 'shadow';
    }, 'rfc64-operational-mode-missing'],
    ['chain', (status) => {
      status.rfc64Certification.chain.configured = false;
    }, 'chain-rpc-not-configured'],
    ['network', (status) => {
      status.rfc64Certification.networkId = '';
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
          rfc64Certification: {
            ...statusBody().rfc64Certification,
            networkId: node.role === 'source' ? 'otp-testnet-2160' : 'otp-other',
          },
        }),
      },
    }),
    (error) => error instanceof RemoteCanaryError && error.code === 'node-network-mismatch',
  );
});

test('preflight fails closed when the versioned daemon certification contract is malformed', () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  const node = config.contextGraphs[0].source;
  for (const mutate of [
    (status) => { delete status.rfc64Certification.schema; },
    (status) => { status.rfc64Certification.chain.chainId = 2160; },
    (status) => {
      status.rfc64Certification.catalog.contextGraphs[0].authorityFreshness = 'stale';
    },
  ]) {
    const status = structuredClone(statusBody());
    mutate(status);
    assert.throws(
      () => validateNodePreflightV1(status, node, config),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'preflight-status-malformed',
    );
  }
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
  assert.notEqual(completeOperationalParityV1(statusBody().rfc64Certification, CG), null);
  for (const field of required) {
    const status = structuredClone(statusBody());
    delete status.rfc64Certification.catalog.contextGraphs[0][field];
    assert.equal(completeOperationalParityV1(status.rfc64Certification, CG), null, field);
  }
  for (const [field, value] of [
    ['appliedCatalogHeadDigest', `0x${'AB'.repeat(32)}`],
    ['appliedRowCount', '01'],
    ['catalogVersion', '-1'],
    ['lastSuccessfulAdvanceAt', 1893456000],
  ]) {
    const status = structuredClone(statusBody());
    status.rfc64Certification.catalog.contextGraphs[0][field] = value;
    assert.equal(completeOperationalParityV1(status.rfc64Certification, CG), null, field);
  }
});

test('VM parity rejects every internally valid cross-node cursor divergence', async () => {
  const normalized = validateRemoteCanaryConfigV1(baseConfig());
  const config = {
    ...normalized,
    timing: {
      ...normalized.timing,
      parityTimeoutMs: 20,
      pollIntervalMs: 1,
    },
  };
  const matching = await verifyVmParityV1({
    config,
    request: vmParityRequester(statusBody(), statusBody()),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.equal(matching[0].status, 'PASS');

  for (const [label, mutate] of [
    ['catalog digest', (cursor) => {
      const digest = `0x${'ef'.repeat(32)}`;
      cursor.expectedCatalogHeadDigest = digest;
      cursor.appliedCatalogHeadDigest = digest;
    }],
    ['inventory digest', (cursor) => {
      const digest = `0x${'12'.repeat(32)}`;
      cursor.expectedInventoryDigest = digest;
      cursor.appliedInventoryDigest = digest;
    }],
    ['row count', (cursor) => {
      cursor.expectedRowCount = '3';
      cursor.appliedRowCount = '3';
    }],
    ['catalog version', (cursor) => { cursor.catalogVersion = '8'; }],
  ]) {
    const receiverStatus = structuredClone(statusBody());
    mutate(receiverStatus.rfc64Certification.catalog.contextGraphs[0]);
    assert.notEqual(
      completeOperationalParityV1(receiverStatus.rfc64Certification, CG),
      null,
      label,
    );
    await assert.rejects(
      verifyVmParityV1({
        config,
        request: vmParityRequester(statusBody(), receiverStatus),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      }),
      (error) => error instanceof RemoteCanaryError && error.code === 'vm-parity-timeout',
      label,
    );
  }
});

test('VM parity reads each participating node once per shared polling round', async () => {
  const secondContextGraphId = 'second-canary';
  const input = baseConfig();
  input.contextGraphs.push({
    ...input.contextGraphs[0],
    id: secondContextGraphId,
  });
  const normalized = validateRemoteCanaryConfigV1(input);
  const config = {
    ...normalized,
    timing: { ...normalized.timing, parityTimeoutMs: 50, pollIntervalMs: 1 },
  };
  const matchingStatus = structuredClone(statusBody());
  matchingStatus.rfc64Certification.catalog.contextGraphs.push({
    ...matchingStatus.rfc64Certification.catalog.contextGraphs[0],
    contextGraphId: secondContextGraphId,
  });
  const firstReceiverStatus = structuredClone(matchingStatus);
  firstReceiverStatus.rfc64Certification.catalog.contextGraphs[1].catalogVersion = '8';
  const statusReads = new Map(config.nodes.map((node) => [node.id, 0]));
  const result = await verifyVmParityV1({
    config,
    request: {
      json: async (node, method, path) => {
        if (path !== '/api/status') return { result: { type: 'boolean', value: true } };
        const read = statusReads.get(node.id) + 1;
        statusReads.set(node.id, read);
        return node.role === 'receiver' && read === 1 ? firstReceiverStatus : matchingStatus;
      },
    },
    sleep: async () => undefined,
  });

  assert.deepEqual(result.map(({ status }) => status), ['PASS', 'PASS']);
  assert.deepEqual([...statusReads.values()], [2, 2]);
});

function vmParityRequester(sourceStatus, receiverStatus) {
  return {
    json: async (node, method, path) => (
      path === '/api/status'
        ? (node.role === 'source' ? sourceStatus : receiverStatus)
        : { result: { type: 'boolean', value: true } }
    ),
  };
}
