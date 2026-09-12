// SPDX-License-Identifier: Apache-2.0

import {
  createRemoteCanaryCohortRefV1,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import { createRfc64DaemonCertificationStatusV1 } from '../../src/rfc64/daemon-certification-status-v1.ts';

export const COMMIT = '0123456789abcdef0123456789abcdef01234567';
export const CG = '0x1111111111111111111111111111111111111111/testnet-canary';
export const SECOND_CG = '0x2222222222222222222222222222222222222222/testnet-canary';
export const SOURCE_URL = 'https://source.internal.example';
export const RECEIVER_URL = 'https://receiver.internal.example';
export const SOURCE_SECRET = 'source-super-secret-token';
export const RECEIVER_SECRET = 'receiver-super-secret-token';
export const CATALOG_SWM_ASK = 'ASK { <urn:known:catalog-swm-subject> ?p ?o }';

export function baseConfig(overrides = {}) {
  return {
    schema: 'dkg-rfc64-remote-canary-config-v1',
    expectedCommit: COMMIT,
    nodes: [
      {
        id: 'alpha-source',
        role: 'source',
        baseUrl: SOURCE_URL,
        auth: { kind: 'bearer-file', secretFile: '/run/secrets/source' },
      },
      {
        id: 'beta-receiver',
        role: 'receiver',
        baseUrl: RECEIVER_URL,
        auth: { kind: 'bearer-file', secretFile: '/run/secrets/receiver' },
      },
    ],
    contextGraphs: [{
      id: CG,
      expectedMode: 'catalog',
      sourceNodeId: 'alpha-source',
      receiverNodeId: 'beta-receiver',
      vmAskSparql: 'ASK { <urn:known:vm-subject> ?p ?o }',
      catalogSwmAskSparql: CATALOG_SWM_ASK,
    }],
    lifecycle: {
      receiverNodeId: 'beta-receiver',
      stop: { argv: ['node-control', 'stop', 'beta-receiver'] },
      start: { argv: ['node-control', 'start', 'beta-receiver'] },
    },
    authorizationChecks: {
      unauthorized: {
        kind: 'http',
        nodeId: 'beta-receiver',
        method: 'GET',
        path: '/api/rfc64/unauthorized-probe',
        authentication: 'none',
        expectedStatuses: [403],
        bodyCodePointer: '/code',
        expectedCodes: ['RFC64_DENIED'],
      },
      revoked: {
        kind: 'http',
        nodeId: 'beta-receiver',
        method: 'GET',
        path: '/api/rfc64/revoked-probe',
        authentication: 'node',
        expectedStatuses: [403],
        bodyCodePointer: '/code',
        expectedCodes: ['RFC64_REVOKED'],
      },
    },
    rpcUsage: {
      kind: 'evidence-file',
      path: '/tmp/redacted-rpc-evidence.json',
      minimumSamples: 2,
    },
    ...overrides,
  };
}

export function statusBody({ legacySyncAllowed = false, contextGraphIds = [CG] } = {}) {
  const digest = `0x${'ab'.repeat(32)}`;
  const inventory = `0x${'cd'.repeat(32)}`;
  const status = {
    commit: COMMIT,
    commitShort: COMMIT.slice(0, 8),
    peerId: '12D3KooWNeverPersistThisPeer',
    networkId: 'otp-testnet-2160',
    syncLifecycle: { syncReconcilerEnabled: true },
    chain: { configured: true, rpcEndpointCount: 3, chainId: 2160 },
    rfc64Catalog: {
      enabled: true,
      rollout: {
        killSwitch: false,
        contextGraphModes: Object.fromEntries(contextGraphIds.map((id) => [id, 'catalog'])),
      },
      contextGraphs: contextGraphIds.map((contextGraphId) => ({
        contextGraphId,
        effectiveMode: 'catalog',
        legacySyncAllowed,
        phase: 'complete',
        authorityState: 'accepted',
        authorityFreshness: 'current',
        catalogServiceStarted: true,
        expectedCatalogHeadDigest: digest,
        appliedCatalogHeadDigest: digest,
        expectedInventoryDigest: inventory,
        appliedInventoryDigest: inventory,
        expectedRowCount: '2',
        appliedRowCount: '2',
        missingRowCount: '0',
        catalogVersion: '7',
        lastSuccessfulAdvanceAt: '1893456000',
      })),
    },
  };
  status.rfc64Certification = createRfc64DaemonCertificationStatusV1({
    commit: status.commit,
    networkId: status.networkId,
    syncReconcilerEnabled: status.syncLifecycle.syncReconcilerEnabled,
    chain: status.chain,
    catalog: {
      enabled: status.rfc64Catalog.enabled,
      killSwitch: status.rfc64Catalog.rollout.killSwitch,
      contextGraphModes: status.rfc64Catalog.rollout.contextGraphModes,
      contextGraphs: status.rfc64Catalog.contextGraphs,
    },
  });
  return status;
}

export function rpcEvidence(config = baseConfig()) {
  const normalized = config.nodes?.every((node) => typeof node.nodeRef === 'string')
    ? config
    : validateRemoteCanaryConfigV1(config);
  const cohortRef = createRemoteCanaryCohortRefV1(normalized);
  return JSON.stringify({
    schema: 'dkg-rpc-usage-minutes-v1',
    scope: 'certified-cohort',
    expectedCommit: COMMIT,
    cohortRef,
    samples: [
      {
        windowStartedAt: '2026-09-11T00:00:00.000Z',
        windowEndedAt: '2026-09-11T00:01:00.000Z',
        total: 12,
        byMethod: { eth_blockNumber: 2, eth_call: 10 },
      },
      {
        windowStartedAt: '2026-09-11T00:01:00.000Z',
        windowEndedAt: '2026-09-11T00:02:00.000Z',
        total: 8,
        byMethod: { eth_blockNumber: 2, eth_call: 6 },
      },
    ],
  });
}


export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
