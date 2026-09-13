// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { it } from 'vitest';

import { decodeRfc64DaemonCertificationStatusV1 } from '@origintrail-official/dkg-agent';
import { loadBuildInfo } from '../src/daemon/manifest.js';

import {
  createRemoteCanaryCohortRefV1,
  executeRemoteCanaryCertificationV1,
  validateRemoteCanaryConfigV1,
} from '../../../devnet/rfc64-remote-canary/certify.mjs';
import { CANARY_SUBJECT_PREFIX } from '../../../devnet/rfc64-remote-canary/canary-vocabulary.mjs';
import { CATALOG_SWM_ASK, CG } from '../../../devnet/rfc64-remote-canary/test-support.mjs';
import {
  createCertificationRouteState,
  createCertificationSynchronization,
  startCertificationRouteServer,
} from './helpers/rfc64-certification-route-daemon.js';

const FALLBACK_NODE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const BUILD_INFO_COMMIT = loadBuildInfo().commit;
const NODE_COMMIT = BUILD_INFO_COMMIT === 'uncommitted'
  ? FALLBACK_NODE_COMMIT
  : BUILD_INFO_COMMIT;
const NODE_ADDRESS = '0x1111111111111111111111111111111111111111';
const RECEIVER_SECRET_FILE = '/tmp/daemon-contract-receiver-token';
const RECEIVER_TOKEN = 'daemon-contract-receiver-token';

interface DaemonStatusResponse {
  readonly commit: unknown;
  readonly rfc64Certification: unknown;
}

it('required gate certifies through the production status, KA, and query handlers', async () => {
  const sourceState = createCertificationRouteState('source');
  const receiverState = createCertificationRouteState('receiver');
  const synchronization = createCertificationSynchronization(receiverState);
  const source = await startCertificationRouteServer(
    sourceState,
    routeOptions(),
    synchronization,
  );
  const receiver = await startCertificationRouteServer(receiverState, routeOptions());
  try {
    const liveStatus = await readDaemonStatus(source.baseUrl);
    assert.equal(liveStatus.commit, NODE_COMMIT);
    assert.ok(isRecord(liveStatus.rfc64Certification));
    assert.equal(
      liveStatus.rfc64Certification.schema,
      'dkg-rfc64-daemon-certification-status-v1',
    );
    const certificationStatus = decodeRfc64DaemonCertificationStatusV1(
      liveStatus.rfc64Certification,
    );
    assert.equal(certificationStatus.commit, NODE_COMMIT);
    assert.equal(certificationStatus.daemonIdentity, '12D3KooDaemonContractsource');
    assert.equal(certificationStatus.catalog.contextGraphs.length, 1);
    const receiverStatus = await readDaemonStatus(receiver.baseUrl);
    const receiverCertificationStatus = decodeRfc64DaemonCertificationStatusV1(
      receiverStatus.rfc64Certification,
    );
    assert.equal(receiverCertificationStatus.commit, NODE_COMMIT);
    assert.equal(receiverCertificationStatus.daemonIdentity, '12D3KooDaemonContractreceiver');
    assert.notEqual(
      certificationStatus.daemonIdentity,
      receiverCertificationStatus.daemonIdentity,
    );

    const config = createContractConfig(source.baseUrl, receiver.baseUrl, NODE_COMMIT);
    const normalized = validateRemoteCanaryConfigV1(config);
    const cohortRef = createRemoteCanaryCohortRefV1(normalized);
    const fetchFn = createContractFetch();
    const runCommand = async ({ argv }: { readonly argv: readonly string[] }) => {
      if (argv[1] === 'stop') {
        await receiver.stop();
        synchronization.receiverStopped();
      } else {
        await receiver.start();
        synchronization.receiverStarted();
      }
      return { code: 0, signal: null, stdout: '' };
    };
    const artifact = await executeRemoteCanaryCertificationV1(config, {
      fetchFn,
      runCommand,
      sleep: async () => undefined,
      now: () => new Date('2026-09-11T00:02:30.000Z'),
      readFileFn: async (path: string) => {
        if (path === RECEIVER_SECRET_FILE) return RECEIVER_TOKEN;
        assert.equal(path, '/tmp/daemon-contract-rpc-evidence.json');
        return JSON.stringify({
          schema: 'dkg-rpc-usage-minutes-v1',
          scope: 'certified-cohort',
          expectedCommit: NODE_COMMIT,
          cohortRef,
          samples: [{
            windowStartedAt: '2026-09-11T00:01:00.000Z',
            windowEndedAt: '2026-09-11T00:02:00.000Z',
            total: 2,
            byMethod: { eth_blockNumber: 2 },
          }],
        });
      },
    });

    assert.equal(artifact.status, 'PASS');
    const routeCalls = [...sourceState.routeCalls, ...receiverState.routeCalls];
    assert.ok(routeCalls.some(({ method, path }) => method === 'GET' && path === '/api/status'));
    assert.equal(
      sourceState.routeCalls.filter(
        ({ method, path }) => method === 'POST' && path === '/api/knowledge-assets',
      ).length,
      2,
    );
    assert.ok(receiverState.routeCalls.some(
      ({ method, path }) => method === 'POST' && path === '/api/query',
    ));
    assert.notEqual(sourceState.sharedSubjects, receiverState.sharedSubjects);
    assert.equal(sourceState.sharedSubjects.size, 2);
    assert.equal(receiverState.sharedSubjects.size, 2);
    assert.deepEqual(synchronization.stats(), {
      liveDeliveries: 1,
      queuedDeliveries: 1,
      catchupDeliveries: 1,
    });
    assert.equal(
      [...receiverState.sharedSubjects].every(
        (subject) => subject.startsWith(CANARY_SUBJECT_PREFIX),
      ),
      true,
    );
  } finally {
    await Promise.all([source.close(), receiver.close()]);
  }
});

it('certification fails when independent receiver delivery is disabled', async () => {
  const sourceState = createCertificationRouteState('source');
  const receiverState = createCertificationRouteState('receiver');
  const synchronization = createCertificationSynchronization(
    receiverState,
    { enabled: false },
  );
  const source = await startCertificationRouteServer(
    sourceState,
    routeOptions(),
    synchronization,
  );
  const receiver = await startCertificationRouteServer(receiverState, routeOptions());
  try {
    const liveStatus = await readDaemonStatus(source.baseUrl);
    assert.equal(liveStatus.commit, NODE_COMMIT);
    assert.equal(
      decodeRfc64DaemonCertificationStatusV1(liveStatus.rfc64Certification).commit,
      NODE_COMMIT,
    );
    const config = createContractConfig(source.baseUrl, receiver.baseUrl, NODE_COMMIT);
    await assert.rejects(
      executeRemoteCanaryCertificationV1(config, {
        fetchFn: createContractFetch(),
        runCommand: async () => { throw new Error('lifecycle must not start'); },
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => new Date('2026-09-11T00:02:30.000Z'),
        readFileFn: async (path: string) => {
          if (path === RECEIVER_SECRET_FILE) return RECEIVER_TOKEN;
          throw new Error('RPC evidence must not be read');
        },
      }),
      (error: unknown) => isRecord(error)
        && error.code === 'swm-propagation-timeout'
        && error.phase === 'live-swm-propagation',
    );
    assert.equal(sourceState.sharedSubjects.size, 1);
    assert.equal(receiverState.sharedSubjects.size, 0);
    assert.deepEqual(synchronization.stats(), {
      liveDeliveries: 0,
      queuedDeliveries: 0,
      catchupDeliveries: 0,
    });
  } finally {
    await Promise.all([source.close(), receiver.close()]);
  }
});

function createContractConfig(
  sourceBaseUrl: string,
  receiverBaseUrl: string,
  expectedCommit: string,
) {
  return {
    schema: 'dkg-rfc64-remote-canary-config-v1',
    expectedCommit,
    nodes: [
      { id: 'source-node', role: 'source', baseUrl: sourceBaseUrl, auth: { kind: 'none' } },
      {
        id: 'receiver-node',
        role: 'receiver',
        baseUrl: receiverBaseUrl,
        auth: { kind: 'bearer-file', secretFile: RECEIVER_SECRET_FILE },
      },
    ],
    contextGraphs: [{
      id: CG,
      expectedMode: 'catalog',
      sourceNodeId: 'source-node',
      receiverNodeId: 'receiver-node',
      vmAskSparql: 'ASK { <urn:known:vm-subject> ?p ?o }',
      catalogSwmAskSparql: CATALOG_SWM_ASK,
    }],
    lifecycle: {
      receiverNodeId: 'receiver-node',
      stop: { argv: ['node-control', 'stop', 'receiver-node'] },
      start: { argv: ['node-control', 'start', 'receiver-node'] },
      stopTimeoutMs: 1_000,
      readyTimeoutMs: 1_000,
    },
    authorizationChecks: {
      unauthorized: {
        kind: 'http',
        nodeId: 'receiver-node',
        method: 'GET',
        path: '/api/rfc64/unauthorized-probe',
        authentication: 'none',
        expectedStatuses: [403],
        bodyCodePointer: '/code',
        expectedCodes: ['RFC64_DENIED'],
      },
      revoked: {
        kind: 'http',
        nodeId: 'receiver-node',
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
      path: '/tmp/daemon-contract-rpc-evidence.json',
    },
    timing: {
      requestTimeoutMs: 1_000,
      pollIntervalMs: 250,
      propagationTimeoutMs: 1_000,
      catchupTimeoutMs: 1_000,
      parityTimeoutMs: 1_000,
    },
  };
}

function createContractFetch(): typeof fetch {
  return async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/api/rfc64/unauthorized-probe') {
      return jsonResponse({ code: 'RFC64_DENIED' }, 403);
    }
    if (url.pathname === '/api/rfc64/revoked-probe') {
      return jsonResponse({ code: 'RFC64_REVOKED' }, 403);
    }
    return fetch(input, options);
  };
}

async function readDaemonStatus(baseUrl: string): Promise<DaemonStatusResponse> {
  const response = await fetch(`${baseUrl}/api/status`);
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(isRecord(body));
  assert.ok('commit' in body);
  assert.ok('rfc64Certification' in body);
  return body as unknown as DaemonStatusResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function routeOptions() {
  return {
    contextGraphId: CG,
    catalogSwmAsk: CATALOG_SWM_ASK,
    nodeAddress: NODE_ADDRESS,
    nodeCommit: NODE_COMMIT,
    networkId: 'otp-testnet-2160',
  };
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
