// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RemoteCanaryError,
  createRemoteCanaryDryRunArtifactV1,
  executeRemoteCanaryCertificationV1,
  runRemoteCanaryArtifactLifecycleV1,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CG = '0x1111111111111111111111111111111111111111/testnet-canary';
const SOURCE_URL = 'https://source.internal.example';
const RECEIVER_URL = 'https://receiver.internal.example';
const SOURCE_SECRET = 'source-super-secret-token';
const RECEIVER_SECRET = 'receiver-super-secret-token';
const CATALOG_SWM_ASK = 'ASK { <urn:known:catalog-swm-subject> ?p ?o }';

function baseConfig(overrides = {}) {
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

function statusBody({ legacySyncAllowed = false } = {}) {
  const digest = `0x${'ab'.repeat(32)}`;
  const inventory = `0x${'cd'.repeat(32)}`;
  return {
    commit: COMMIT,
    commitShort: COMMIT.slice(0, 8),
    peerId: '12D3KooWNeverPersistThisPeer',
    networkId: 'otp-testnet-2160',
    syncLifecycle: { syncReconcilerEnabled: true },
    chain: { configured: true, rpcEndpointCount: 3, chainId: 2160 },
    rfc64Catalog: {
      enabled: true,
      rollout: { killSwitch: false, contextGraphModes: { [CG]: 'catalog' } },
      contextGraphs: [{
        contextGraphId: CG,
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
      }],
    },
  };
}

function rpcEvidence() {
  return JSON.stringify({
    schema: 'dkg-rpc-usage-minutes-v1',
    scope: 'certified-cohort',
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

function fakeRuntime({
  failOfflineShare = false,
  catalogSwmPresent = true,
  legacySyncAllowed = false,
} = {}) {
  const state = {
    receiverOnline: true,
    receiverMarkers: new Set(),
    sourceMarkers: new Set(),
    pendingMarkers: new Set(),
    commands: [],
    requests: [],
  };
  const fetchFn = async (input, options = {}) => {
    const url = new URL(input);
    const isReceiver = url.origin === RECEIVER_URL;
    const method = options.method ?? 'GET';
    state.requests.push({ origin: url.origin, path: url.pathname, method });
    if (isReceiver && !state.receiverOnline) throw new TypeError('offline endpoint details');
    if (url.pathname === '/api/status') {
      return new Response(method === 'HEAD' ? null : JSON.stringify(statusBody({
        legacySyncAllowed,
      })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.pathname === '/api/knowledge-assets' && method === 'POST') {
      if (failOfflineShare && !state.receiverOnline) return jsonResponse({ error: 'sensitive' }, 500);
      const body = JSON.parse(options.body);
      const marker = body.quads[0].subject;
      state.sourceMarkers.add(marker);
      if (state.receiverOnline) state.receiverMarkers.add(marker);
      else state.pendingMarkers.add(marker);
      return jsonResponse({ swmShared: true, assertionUri: 'urn:must-not-persist' });
    }
    if (url.pathname === '/api/query' && method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.view === 'verifiable-memory') {
        return jsonResponse({ result: { type: 'boolean', value: true } });
      }
      if (body.sparql === CATALOG_SWM_ASK) {
        return jsonResponse({ result: { type: 'boolean', value: catalogSwmPresent } });
      }
      const marker = body.sparql.match(/<([^>]+)>/)?.[1];
      const present = isReceiver
        ? state.receiverMarkers.has(marker)
        : state.sourceMarkers.has(marker);
      return jsonResponse({ result: { type: 'boolean', value: present } });
    }
    if (url.pathname === '/api/rfc64/unauthorized-probe') {
      return jsonResponse({ code: 'RFC64_DENIED', detail: SOURCE_SECRET }, 403);
    }
    if (url.pathname === '/api/rfc64/revoked-probe') {
      return jsonResponse({ code: 'RFC64_REVOKED', detail: RECEIVER_SECRET }, 403);
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  const runCommand = async (command) => {
    state.commands.push(command.argv[1]);
    if (command.argv[1] === 'stop') state.receiverOnline = false;
    if (command.argv[1] === 'start') {
      state.receiverOnline = true;
      for (const marker of state.pendingMarkers) state.receiverMarkers.add(marker);
    }
    return { code: 0, signal: null, stdout: '' };
  };
  const readFileFn = async (path) => {
    if (path === '/run/secrets/source') return SOURCE_SECRET;
    if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
    if (path === '/tmp/redacted-rpc-evidence.json') return rpcEvidence();
    throw new Error('unexpected read');
  };
  return { state, fetchFn, runCommand, readFileFn };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('dry-run validates without reading secrets, calling nodes, or running commands', () => {
  const artifact = createRemoteCanaryDryRunArtifactV1(baseConfig(), () => (
    new Date('2026-09-11T01:00:00.000Z')
  ));
  assert.equal(artifact.status, 'DRY_RUN');
  assert.equal(artifact.plan.offlineCatchup, 'PLANNED');
  assert.equal(artifact.plan.catalogSwmEvidence, 'PLANNED');
  assert.equal(artifact.plan.rpcUsage, 'PLANNED');
  const serialized = JSON.stringify(artifact);
  for (const sensitive of [SOURCE_URL, RECEIVER_URL, CG, '/run/secrets', 'alpha-source', 'beta-receiver']) {
    assert.equal(serialized.includes(sensitive), false);
  }
});

test('strict config rejects inline credentials and multiple receivers', () => {
  assert.throws(
    () => validateRemoteCanaryConfigV1(baseConfig({
      lifecycle: {
        receiverNodeId: 'beta-receiver',
        stop: { argv: ['control', '--token=inline'] },
        start: { argv: ['control', 'start'] },
      },
    })),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'inline-command-secret-rejected',
  );

  const config = baseConfig();
  config.nodes.push({
    id: 'gamma-receiver',
    role: 'receiver',
    baseUrl: 'https://gamma.internal.example',
    auth: { kind: 'none' },
  });
  config.contextGraphs.push({
    id: 'second-canary',
    expectedMode: 'catalog',
    sourceNodeId: 'alpha-source',
    receiverNodeId: 'gamma-receiver',
  });
  assert.throws(
    () => validateRemoteCanaryConfigV1(config),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'exactly-one-receiver-required',
  );
});

test('full run certifies propagation, one-node catch-up, VM parity, denials, and RPC usage', async () => {
  const runtime = fakeRuntime();
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
    sampleCount: 2,
    measuredSeconds: 120,
    total: 20,
    requestsPerMinute: 10,
    byMethod: { eth_blockNumber: 4, eth_call: 16 },
  });
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

test('missing live-only surfaces remain explicit and cannot produce PASS', async () => {
  const runtime = fakeRuntime();
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
  const artifact = await executeRemoteCanaryCertificationV1(config, runtime);
  assert.equal(artifact.status, 'INCOMPLETE');
  assert.equal(artifact.checks.offlineCatchup.status, 'EVIDENCE_REQUIRED');
  assert.equal(artifact.checks.authorization.revoked.status, 'EVIDENCE_REQUIRED');
  assert.equal(artifact.checks.rpcUsage.status, 'EVIDENCE_REQUIRED');
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
  const runtime = fakeRuntime({ catalogSwmPresent: false });
  try {
    await assert.rejects(
      runRemoteCanaryArtifactLifecycleV1({
        config: baseConfig(),
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
  const runtime = fakeRuntime({ legacySyncAllowed: true });
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
  const runtime = fakeRuntime();
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

test('receiver start runs from finally when an offline share fails', async () => {
  const runtime = fakeRuntime({ failOfflineShare: true });
  await assert.rejects(
    executeRemoteCanaryCertificationV1(baseConfig(), runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'node-http-status-failed',
  );
  assert.deepEqual(runtime.state.commands, ['stop', 'start']);
  assert.equal(runtime.state.receiverOnline, true);
});

test('RPC evidence rejects non-minutely windows and mismatched totals', async () => {
  const runtime = fakeRuntime();
  runtime.readFileFn = async (path) => {
    if (path === '/run/secrets/source') return SOURCE_SECRET;
    if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
    return JSON.stringify({
      schema: 'dkg-rpc-usage-minutes-v1',
      scope: 'certified-cohort',
      samples: [{
        windowStartedAt: '2026-09-11T00:00:00.000Z',
        windowEndedAt: '2026-09-11T00:00:10.000Z',
        total: 99,
        byMethod: { eth_call: 1 },
      }],
    });
  };
  const config = baseConfig({
    rpcUsage: {
      kind: 'evidence-file',
      path: '/tmp/redacted-rpc-evidence.json',
      minimumSamples: 1,
    },
  });
  await assert.rejects(
    executeRemoteCanaryCertificationV1(config, runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-window-not-minutely',
  );
});

test('artifact lifecycle replaces a stale PASS with sanitized FAIL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-test-'));
  const artifactPath = join(directory, 'latest.json');
  try {
    await writeFile(artifactPath, JSON.stringify({ status: 'PASS', secret: SOURCE_SECRET }));
    const runtime = fakeRuntime();
    runtime.fetchFn = async () => {
      throw new Error(`sensitive ${SOURCE_URL} ${SOURCE_SECRET}`);
    };
    await assert.rejects(runRemoteCanaryArtifactLifecycleV1({
      config: baseConfig(),
      artifactPath,
      dependencies: runtime,
    }));
    const artifactText = await readFile(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactText);
    assert.equal(artifact.status, 'FAIL');
    assert.equal(artifact.failure.code, 'node-request-failed');
    assert.equal(artifactText.includes(SOURCE_SECRET), false);
    assert.equal(artifactText.includes(SOURCE_URL), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
