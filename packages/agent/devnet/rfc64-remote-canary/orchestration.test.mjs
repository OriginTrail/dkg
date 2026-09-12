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
  CATALOG_SWM_ASK,
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
  const markerQueries = runtime.state.requests.filter(({ sparql, view }) => (
    view === 'shared-working-memory' && sparql?.startsWith('ASK { <urn:dkg:rfc64-canary:')
  ));
  assert.equal(markerQueries.length, 2);
  assert.equal(markerQueries.every(({ origin }) => origin === RECEIVER_URL), true);
  const catalogQueries = runtime.state.requests.filter(({ sparql }) => sparql === CATALOG_SWM_ASK);
  assert.equal(catalogQueries.length, 4);
  assert.equal(catalogQueries.filter(({ origin }) => origin === SOURCE_URL).length, 2);
  assert.equal(catalogQueries.filter(({ origin }) => origin === RECEIVER_URL).length, 2);
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

test('catalog evidence must predate all fresh canary markers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-swm-test-'));
  const artifactPath = join(directory, 'latest.json');
  const runtime = createCertificationRuntime({
    catalogSwmPresent: false,
    catalogSwmPresentAfterMarker: true,
  });
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
    assert.equal(runtime.state.sourceMarkers.size, 0);
    assert.equal(runtime.state.receiverMarkers.size, 0);
    assert.deepEqual(runtime.state.commands, []);
    const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
    assert.equal(artifact.status, 'FAIL');
    assert.equal(artifact.phase, 'catalog-swm-evidence');
    assert.equal(artifact.failure.code, 'catalog-swm-query-failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('catalog evidence is mandatory on both source and receiver', async () => {
  for (const missingRole of ['source', 'receiver']) {
    const runtime = createCertificationRuntime({
      catalogSwmPresent: {
        source: missingRole !== 'source',
        receiver: missingRole !== 'receiver',
      },
    });
    await assert.rejects(
      executeRemoteCanaryCertificationV1(baseConfig(), runtime),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'catalog-swm-query-failed'
        && error.phase === 'catalog-swm-evidence',
      missingRole,
    );
    const queries = runtime.state.requests.filter(({ sparql }) => sparql === CATALOG_SWM_ASK);
    assert.equal(queries.some(({ origin }) => origin === SOURCE_URL), true, missingRole);
    assert.equal(queries.some(({ origin }) => origin === RECEIVER_URL), true, missingRole);
    assert.equal(runtime.state.sourceMarkers.size, 0, missingRole);
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

test('final preflight rejects a node build that changed during certification', async () => {
  const observerUrl = 'https://observer.internal.example';
  const config = baseConfig();
  config.nodes.push({
    id: 'gamma-observer',
    role: 'observer',
    baseUrl: observerUrl,
    auth: { kind: 'none' },
  });
  const runtime = createCertificationRuntime({ rpcEvidenceConfig: config });
  const delegateFetch = runtime.fetchFn;
  let observerStatusReads = 0;
  runtime.fetchFn = async (input, options) => {
    const response = await delegateFetch(input, options);
    const url = new URL(input);
    if (
      url.origin !== observerUrl
      || url.pathname !== '/api/status'
      || (options?.method ?? 'GET') !== 'GET'
    ) return response;
    observerStatusReads += 1;
    if (observerStatusReads === 1) return response;
    const body = await response.json();
    body.commit = 'f'.repeat(40);
    body.commitShort = 'ffffffff';
    body.rfc64Certification.commit = 'f'.repeat(40);
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    executeRemoteCanaryCertificationV1(config, runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'node-build-mismatch'
      && error.category === 'invariant'
      && error.phase === 'final-preflight',
  );
  assert.equal(observerStatusReads, 2);
  assert.deepEqual(runtime.state.commands, ['stop', 'start']);
});

test('final preflight rejects catalog state that becomes blocked after VM parity', async () => {
  const runtime = createCertificationRuntime();
  const delegateFetch = runtime.fetchFn;
  let sourceStatusReads = 0;
  runtime.fetchFn = async (input, options) => {
    const response = await delegateFetch(input, options);
    const url = new URL(input);
    if (
      url.origin !== SOURCE_URL
      || url.pathname !== '/api/status'
      || (options?.method ?? 'GET') !== 'GET'
    ) return response;
    sourceStatusReads += 1;
    if (sourceStatusReads < 3) return response;
    const body = await response.json();
    const operational = body.rfc64Certification.catalog.contextGraphs[0];
    operational.phase = 'blocked';
    operational.authorityState = 'blocked';
    operational.authorityFreshness = 'unknown';
    for (const field of [
      'expectedCatalogHeadDigest',
      'appliedCatalogHeadDigest',
      'expectedInventoryDigest',
      'appliedInventoryDigest',
      'expectedRowCount',
      'appliedRowCount',
      'missingRowCount',
      'catalogVersion',
      'lastSuccessfulAdvanceAt',
    ]) operational[field] = null;
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    executeRemoteCanaryCertificationV1(baseConfig(), runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rfc64-operational-incomplete'
      && error.category === 'invariant'
      && error.phase === 'final-preflight',
  );
  assert.equal(sourceStatusReads, 3);
  assert.deepEqual(runtime.state.commands, ['stop', 'start']);
});

test('final preflight rejects complete source and receiver cursors that diverge after VM parity', async () => {
  const runtime = createCertificationRuntime();
  const delegateFetch = runtime.fetchFn;
  let sourceStatusReads = 0;
  runtime.fetchFn = async (input, options) => {
    const response = await delegateFetch(input, options);
    const url = new URL(input);
    if (
      url.origin !== SOURCE_URL
      || url.pathname !== '/api/status'
      || (options?.method ?? 'GET') !== 'GET'
    ) return response;
    sourceStatusReads += 1;
    if (sourceStatusReads < 3) return response;
    const body = await response.json();
    const operational = body.rfc64Certification.catalog.contextGraphs[0];
    operational.expectedCatalogHeadDigest = `0x${'ef'.repeat(32)}`;
    operational.appliedCatalogHeadDigest = operational.expectedCatalogHeadDigest;
    operational.expectedInventoryDigest = `0x${'12'.repeat(32)}`;
    operational.appliedInventoryDigest = operational.expectedInventoryDigest;
    operational.catalogVersion = '8';
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    executeRemoteCanaryCertificationV1(baseConfig(), runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rfc64-operational-parity-changed'
      && error.category === 'invariant'
      && error.phase === 'final-preflight',
  );
  assert.equal(sourceStatusReads, 3);
  assert.deepEqual(runtime.state.commands, ['stop', 'start']);
});

test('a false configured VM ASK from either node blocks full certification', async () => {
  for (const role of ['source', 'receiver']) {
    const runtime = createCertificationRuntime({ vmQueryFalseFor: role });
    await assert.rejects(
      executeRemoteCanaryCertificationV1(baseConfig(), runtime),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'vm-query-parity-failed'
        && error.phase === 'vm-parity',
      role,
    );
    assert.deepEqual(runtime.state.commands, ['stop', 'start'], role);
    assert.equal(runtime.state.receiverOnline, true, role);
  }
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

test('phase boundaries give domain and transport failures the same execution stage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-phase-test-'));
  try {
    for (const scenario of [
      {
        label: 'domain',
        runtime: createCertificationRuntime({ confirmLiveShare: false }),
        code: 'swm-share-not-confirmed',
        category: 'swm',
      },
      {
        label: 'transport',
        runtime: createCertificationRuntime(),
        code: 'node-request-failed',
        category: 'http',
      },
    ]) {
      if (scenario.label === 'transport') {
        const delegateFetch = scenario.runtime.fetchFn;
        scenario.runtime.fetchFn = async (input, options) => {
          if (new URL(input).pathname === '/api/knowledge-assets') {
            throw new TypeError('unreachable');
          }
          return delegateFetch(input, options);
        };
      }
      const artifactPath = join(directory, `${scenario.label}.json`);
      await assert.rejects(
        runRemoteCanaryArtifactLifecycleV1({
          loadConfig: () => baseConfig(),
          artifactPath,
          dependencies: scenario.runtime,
        }),
        (error) => error instanceof RemoteCanaryError
          && error.code === scenario.code
          && error.category === scenario.category
          && error.phase === 'live-swm-propagation',
        scenario.label,
      );
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
      assert.equal(artifact.phase, 'live-swm-propagation', scenario.label);
      assert.equal(artifact.failure.code, scenario.code, scenario.label);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
