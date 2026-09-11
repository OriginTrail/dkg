// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RemoteCanaryError,
  createRemoteCanaryDryRunArtifactV1,
  executeRemoteCanaryCertificationV1,
  runRemoteCanaryArtifactLifecycleV1,
} from './certify.mjs';
import {
  CG,
  RECEIVER_SECRET,
  RECEIVER_URL,
  SECOND_CG,
  SOURCE_SECRET,
  SOURCE_URL,
  baseConfig,
} from './test-support.mjs';
import { createCertificationRuntime } from './orchestration-fixture.mjs';

test('full run certifies propagation, one-node catch-up, VM parity, denials, and RPC usage', async () => {
  const runtime = createCertificationRuntime();
  const artifact = await executeRemoteCanaryCertificationV1(baseConfig(), runtime);
  assert.equal(artifact.status, 'PASS');
  assert.deepEqual(runtime.state.commands, ['stop', 'start']);
  assert.equal(artifact.checks.liveSwmPropagation[0].status, 'PASS');
  assert.equal(artifact.checks.offlineCatchup.status, 'PASS');
  assert.equal(artifact.checks.vmParity[0].status, 'PASS');
  assert.equal(artifact.checks.vmParity[0].statusParity, 'PASS');
  assert.deepEqual(artifact.checks.catalogSwm[0], {
    contextGraphRef: artifact.topology.contextGraphs[0].contextGraphRef,
    status: 'PASS',
    queryChecked: true,
    sourceQueryPassed: true,
    receiverQueryPassed: true,
  });
  assert.equal(artifact.checks.authorization.unauthorized.status, 'PASS');
  assert.equal(artifact.checks.authorization.revoked.status, 'PASS');
  assert.deepEqual(artifact.checks.rpcUsage, {
    status: 'PASS',
    source: 'evidence-file',
    cohortRef: artifact.cohortRef,
    windowStartedAt: '2026-09-11T00:00:00.000Z',
    windowEndedAt: '2026-09-11T00:02:00.000Z',
    sampleCount: 2,
    measuredSeconds: 120,
    total: 20,
    requestsPerMinute: 10,
    byMethod: { eth_blockNumber: 4, eth_call: 16 },
  });
  const unauthorizedRequest = runtime.state.requests.find(({ path }) => (
    path === '/api/rfc64/unauthorized-probe'
  ));
  const revokedRequest = runtime.state.requests.find(({ path }) => (
    path === '/api/rfc64/revoked-probe'
  ));
  assert.equal(unauthorizedRequest.authorization, null);
  assert.equal(revokedRequest.authorization, `Bearer ${RECEIVER_SECRET}`);
  const serialized = JSON.stringify(artifact);
  for (const sensitive of [
    SOURCE_URL,
    RECEIVER_URL,
    SOURCE_SECRET,
    RECEIVER_SECRET,
    CG,
    '/run/secrets',
    '/tmp/redacted-rpc-evidence.json',
    'alpha-source',
    'beta-receiver',
    '12D3KooWNeverPersistThisPeer',
    'urn:must-not-persist',
    'urn:known:catalog-swm-subject',
  ]) assert.equal(serialized.includes(sensitive), false, sensitive);
});

test('parallel graph checks preserve configuration order in certificate evidence', async () => {
  const config = baseConfig({
    contextGraphs: [
      ...baseConfig().contextGraphs,
      {
        id: SECOND_CG,
        expectedMode: 'catalog',
        sourceNodeId: 'alpha-source',
        receiverNodeId: 'beta-receiver',
        vmAskSparql: 'ASK { <urn:known:second-vm-subject> ?p ?o }',
        catalogSwmAskSparql: 'ASK { <urn:known:second-swm-subject> ?p ?o }',
      },
    ],
  });
  const runtime = createCertificationRuntime({
    contextGraphIds: [CG, SECOND_CG],
    rpcEvidenceConfig: config,
  });
  const delegateFetch = runtime.fetchFn;
  runtime.fetchFn = async (input, options) => {
    const url = new URL(input);
    if (
      url.pathname === '/api/knowledge-assets'
      && JSON.parse(options.body).contextGraphId === CG
    ) await new Promise((resolve) => setTimeout(resolve, 10));
    return delegateFetch(input, options);
  };
  const artifact = await executeRemoteCanaryCertificationV1(config, runtime);
  const expectedOrder = artifact.topology.contextGraphs.map(({ contextGraphRef }) => contextGraphRef);
  assert.deepEqual(
    artifact.checks.liveSwmPropagation.map(({ contextGraphRef }) => contextGraphRef),
    expectedOrder,
  );
  assert.deepEqual(
    artifact.checks.vmParity.map(({ contextGraphRef }) => contextGraphRef),
    expectedOrder,
  );
  assert.deepEqual(
    artifact.checks.catalogSwm.map(({ contextGraphRef }) => contextGraphRef),
    expectedOrder,
  );
});

test('missing live-only surfaces remain explicit and cannot produce PASS', async () => {
  const runtime = createCertificationRuntime();
  const config = baseConfig({
    lifecycle: null,
    authorizationChecks: {
      unauthorized: {
        kind: 'not-exposed',
        reasonCode: 'catalog-protocol-api-not-exposed',
      },
      revoked: {
        kind: 'not-exposed',
        reasonCode: 'revocation-api-not-exposed',
      },
    },
    rpcUsage: { kind: 'required' },
  });
  delete config.contextGraphs[0].catalogSwmAskSparql;
  delete config.contextGraphs[0].vmAskSparql;
  const dryRun = createRemoteCanaryDryRunArtifactV1(config);
  assert.equal(dryRun.plan.offlineCatchup, 'EVIDENCE_REQUIRED');
  assert.equal(dryRun.plan.vmParityEvidence, 'EVIDENCE_REQUIRED');
  assert.equal(dryRun.plan.catalogSwmEvidence, 'EVIDENCE_REQUIRED');
  assert.equal(dryRun.plan.authorization.unauthorized, 'EVIDENCE_REQUIRED');
  assert.equal(dryRun.plan.authorization.revoked, 'EVIDENCE_REQUIRED');
  assert.equal(dryRun.plan.rpcUsage, 'EVIDENCE_REQUIRED');
  const artifact = await executeRemoteCanaryCertificationV1(config, runtime);
  assert.equal(artifact.status, 'INCOMPLETE');
  assert.equal(artifact.checks.offlineCatchup.status, 'EVIDENCE_REQUIRED');
  assert.equal(artifact.checks.authorization.revoked.status, 'EVIDENCE_REQUIRED');
  assert.equal(artifact.checks.rpcUsage.status, 'EVIDENCE_REQUIRED');
  assert.equal(artifact.checks.vmParity[0].status, 'EVIDENCE_REQUIRED');
  assert.deepEqual(artifact.checks.catalogSwm[0], {
    contextGraphRef: artifact.topology.contextGraphs[0].contextGraphRef,
    status: 'EVIDENCE_REQUIRED',
    requirement: 'known-catalog-swm-ask-query',
    queryChecked: false,
  });
  assert.deepEqual(runtime.state.commands, []);
});

test('fresh markers and VM parity cannot hide missing catalog-owned SWM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-swm-test-'));
  const artifactPath = join(directory, 'latest.json');
  const runtime = createCertificationRuntime({ catalogSwmPresent: false });
  try {
    await assert.rejects(
      runRemoteCanaryArtifactLifecycleV1({
        loadConfig: () => baseConfig(),
        artifactPath,
        dependencies: runtime,
      }),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'catalog-swm-query-failed',
    );
    assert.equal(runtime.state.sourceMarkers.size, 2);
    assert.equal(runtime.state.receiverMarkers.size, 2);
    assert.deepEqual(runtime.state.commands, ['stop', 'start']);
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    assert.equal(artifact.status, 'FAIL');
    assert.equal(artifact.phase, 'catalog-swm-evidence');
    assert.equal(artifact.failure.code, 'catalog-swm-query-failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('catalog preflight rejects compatibility authority with legacy sync allowed', async () => {
  const runtime = createCertificationRuntime({ legacySyncAllowed: true });
  await assert.rejects(
    executeRemoteCanaryCertificationV1(baseConfig(), runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rfc64-legacy-sync-allowed'
      && error.phase === 'preflight',
  );
  assert.deepEqual(runtime.state.commands, []);
  assert.equal(runtime.state.sourceMarkers.size, 0);
});

test('catalog status parity alone cannot certify VM queryability', async () => {
  const runtime = createCertificationRuntime();
  const config = baseConfig();
  delete config.contextGraphs[0].vmAskSparql;
  const artifact = await executeRemoteCanaryCertificationV1(config, runtime);
  assert.equal(artifact.status, 'INCOMPLETE');
  assert.deepEqual(artifact.checks.vmParity[0], {
    contextGraphRef: artifact.topology.contextGraphs[0].contextGraphRef,
    status: 'EVIDENCE_REQUIRED',
    statusParity: 'PASS',
    cursorPresent: true,
    digestParity: true,
    rowCountParity: true,
    vmQueryChecked: false,
    requirement: 'vm-ask-query',
  });
});

test('receiver recovery runs when an offline share fails', async () => {
  const runtime = createCertificationRuntime({ failOfflineShare: true });
  await assert.rejects(
    executeRemoteCanaryCertificationV1(baseConfig(), runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'node-http-status-failed',
  );
  assert.deepEqual(runtime.state.commands, ['stop', 'start']);
  assert.equal(runtime.state.receiverOnline, true);
});

test('HTTP timeout covers a stalled response body and still restarts the receiver', async () => {
  const runtime = createCertificationRuntime();
  const delegateFetch = runtime.fetchFn;
  runtime.fetchFn = async (input, options) => {
    const url = new URL(input);
    if (!runtime.state.receiverOnline && url.pathname === '/api/knowledge-assets') {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"swmShared":'));
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return delegateFetch(input, options);
  };
  await assert.rejects(
    executeRemoteCanaryCertificationV1(baseConfig({
      timing: { requestTimeoutMs: 1_000 },
    }), runtime),
    (error) => error instanceof RemoteCanaryError && error.code === 'node-request-failed',
  );
  assert.deepEqual(runtime.state.commands, ['stop', 'start']);
  assert.equal(runtime.state.receiverOnline, true);
});
