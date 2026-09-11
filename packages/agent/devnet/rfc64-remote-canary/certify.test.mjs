// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  RemoteCanaryError,
  createRemoteCanaryCohortRefV1,
  createRemoteCanaryDryRunArtifactV1,
  executeRemoteCanaryCertificationV1,
  runBoundedCommandV1,
  runRemoteCanaryArtifactLifecycleV1,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import { isRetryableNodeRequestErrorV1, pollUntilV1 } from './phase-helpers.mjs';
import { preflightAllNodesV1, validateNodePreflightV1 } from './preflight.mjs';
import {
  collectRpcUsageEvidenceV1,
  validateRpcEvidenceV1,
} from './rpc-evidence.mjs';
import { completeOperationalParityV1 } from './vm.mjs';

const execFileAsync = promisify(execFile);
const RUNNER_PATH = fileURLToPath(new URL('./run.mjs', import.meta.url));
const AGENT_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url));

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CG = '0x1111111111111111111111111111111111111111/testnet-canary';
const SECOND_CG = '0x2222222222222222222222222222222222222222/testnet-canary';
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

function statusBody({ legacySyncAllowed = false, contextGraphIds = [CG] } = {}) {
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
}

function rpcEvidence(config = baseConfig()) {
  const cohortRef = createRemoteCanaryCohortRefV1(validateRemoteCanaryConfigV1(config));
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

function fakeRuntime({
  failOfflineShare = false,
  catalogSwmPresent = true,
  legacySyncAllowed = false,
  contextGraphIds = [CG],
  rpcEvidenceConfig = baseConfig(),
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
    const authorization = new Headers(options.headers).get('authorization');
    state.requests.push({ origin: url.origin, path: url.pathname, method, authorization });
    if (isReceiver && !state.receiverOnline) throw new TypeError('offline endpoint details');
    if (url.pathname === '/api/status') {
      return new Response(method === 'HEAD' ? null : JSON.stringify(statusBody({
        legacySyncAllowed,
        contextGraphIds,
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
      if (body.sparql === CATALOG_SWM_ASK || body.sparql.includes('known:second-swm-subject')) {
        return jsonResponse({ result: { type: 'boolean', value: catalogSwmPresent } });
      }
      const marker = body.sparql.match(/<([^>]+)>/)?.[1];
      const present = isReceiver
        ? state.receiverMarkers.has(marker)
        : state.sourceMarkers.has(marker);
      return jsonResponse({ result: { type: 'boolean', value: present } });
    }
    if (url.pathname === '/api/rfc64/unauthorized-probe') {
      if (authorization !== null) return jsonResponse({ code: 'WRONG_AUTH_MODE' }, 500);
      return jsonResponse({ code: 'RFC64_DENIED', detail: SOURCE_SECRET }, 403);
    }
    if (url.pathname === '/api/rfc64/revoked-probe') {
      if (authorization !== `Bearer ${RECEIVER_SECRET}`) {
        return jsonResponse({ code: 'WRONG_AUTH_MODE' }, 500);
      }
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
    if (path === '/tmp/redacted-rpc-evidence.json') return rpcEvidence(rpcEvidenceConfig);
    throw new Error('unexpected read');
  };
  const now = () => new Date('2026-09-11T00:02:30.000Z');
  return { state, fetchFn, runCommand, readFileFn, now };
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

test('operator CLI dry-run performs no network, secret, evidence, or command I/O', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-cli-dry-run-'));
  const artifactPath = join(directory, 'result.json');
  const configPath = join(directory, 'config.json');
  const sensitive = [
    'https://unreachable-source.invalid',
    'https://unreachable-receiver.invalid',
    '/definitely/missing/source-secret',
    '/definitely/missing/receiver-secret',
    '/definitely/missing/rpc-evidence.json',
    'must-never-run-lifecycle-command',
  ];
  const config = baseConfig({
    nodes: [
      {
        id: 'alpha-source',
        role: 'source',
        baseUrl: sensitive[0],
        auth: { kind: 'bearer-file', secretFile: sensitive[2] },
      },
      {
        id: 'beta-receiver',
        role: 'receiver',
        baseUrl: sensitive[1],
        auth: { kind: 'bearer-file', secretFile: sensitive[3] },
      },
    ],
    lifecycle: {
      receiverNodeId: 'beta-receiver',
      stop: { argv: [sensitive[5], 'stop'] },
      start: { argv: [sensitive[5], 'start'] },
    },
    rpcUsage: { kind: 'evidence-file', path: sensitive[4], minimumSamples: 2 },
  });
  try {
    await writeFile(configPath, JSON.stringify(config));
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--import', 'tsx',
      RUNNER_PATH,
      '--config', configPath,
      '--artifact', artifactPath,
      '--dry-run',
    ], { cwd: AGENT_DIRECTORY });
    assert.match(stdout, /^DRY_RUN /u);
    assert.equal(stderr, '');
    const artifactText = await readFile(artifactPath, 'utf8');
    assert.equal(JSON.parse(artifactText).status, 'DRY_RUN');
    for (const value of [...sensitive, CG, 'alpha-source', 'beta-receiver']) {
      assert.equal(artifactText.includes(value), false, value);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test('the standards-based config validator enforces authorization body shape', () => {
  const valid = baseConfig();
  assert.doesNotThrow(() => validateRemoteCanaryConfigV1(valid));

  const invalid = baseConfig();
  invalid.authorizationChecks.unauthorized.body = 'probe';
  assert.throws(
    () => validateRemoteCanaryConfigV1(invalid),
    (error) => error instanceof RemoteCanaryError && error.code === 'config-shape',
  );
});

test('normalization resolves the canonical execution topology once', () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  const contextGraph = config.contextGraphs[0];
  assert.equal(contextGraph.source, config.nodes[0]);
  assert.equal(contextGraph.receiver, config.nodes[1]);
  assert.equal(config.lifecycle.receiver, contextGraph.receiver);
  assert.equal(config.authorizationChecks.unauthorized.node, contextGraph.receiver);
  assert.match(contextGraph.contextGraphRef, /^cg:[0-9a-f]{20}$/u);
  assert.match(contextGraph.source.nodeRef, /^node:[0-9a-f]{20}$/u);
});

test('schema owns numeric bounds while normalization applies canonical defaults', () => {
  const normalized = validateRemoteCanaryConfigV1(baseConfig({ timing: {} }));
  assert.deepEqual(normalized.timing, {
    requestTimeoutMs: 10_000,
    pollIntervalMs: 2_000,
    propagationTimeoutMs: 120_000,
    catchupTimeoutMs: 240_000,
    parityTimeoutMs: 120_000,
  });
  const config = baseConfig({ timing: { requestTimeoutMs: 999 } });
  assert.throws(
    () => validateRemoteCanaryConfigV1(config),
    (error) => error instanceof RemoteCanaryError && error.code === 'config-shape',
  );
});

test('config requires mandatory basic graph patterns for both ASK evidence fields', () => {
  for (const field of ['vmAskSparql', 'catalogSwmAskSparql']) {
    for (const sparql of [
      'ASK {}',
      'ASK { BIND("constant" AS ?x) }',
      'ASK { OPTIONAL { <urn:known> ?p ?o } }',
      'ASK { { <urn:known> ?p ?o } UNION {} }',
      'ASK { ?s ?p ?o }',
    ]) {
      const config = baseConfig();
      config.contextGraphs[0][field] = sparql;
      assert.throws(
        () => validateRemoteCanaryConfigV1(config),
        (error) => error instanceof RemoteCanaryError
          && error.code.endsWith('query-must-depend-on-data'),
        `${field}: ${sparql}`,
      );
    }
  }
});

test('standards ASK parsing preserves ordinary prefixed and literal syntax', () => {
  for (const sparql of [
    'ASK WHERE { <urn:known> a "value"@en . }',
    'PREFIX ex: <urn:example:> ASK { ex:subject ex:count 42 . }',
    'ASK { <urn:known> <urn:value> "1"^^<http://www.w3.org/2001/XMLSchema#integer> }',
  ]) {
    const config = baseConfig();
    config.contextGraphs[0].vmAskSparql = sparql;
    assert.doesNotThrow(() => validateRemoteCanaryConfigV1(config), sparql);
  }
});

test('standards ASK parsing rejects updates and non-ASK queries', () => {
  for (const [sparql, expectedCode] of [
    ['INSERT DATA { <urn:x> <urn:y> <urn:z> }', 'vm-query-must-be-read-only'],
    ['SELECT * WHERE { <urn:x> ?p ?o }', 'vm-query-must-be-ask'],
  ]) {
    const config = baseConfig();
    config.contextGraphs[0].vmAskSparql = sparql;
    assert.throws(
      () => validateRemoteCanaryConfigV1(config),
      (error) => error instanceof RemoteCanaryError && error.code === expectedCode,
    );
  }
});

test('config rejects swapped authorization modes and common inline secret forms', () => {
  for (const [field, authentication, code] of [
    ['unauthorized', 'node', 'unauthorized-authentication-mode'],
    ['revoked', 'none', 'revoked-authentication-mode'],
  ]) {
    const config = baseConfig();
    config.authorizationChecks[field].authentication = authentication;
    assert.throws(
      () => validateRemoteCanaryConfigV1(config),
      (error) => error instanceof RemoteCanaryError && error.code === code,
    );
  }
  for (const secretArgv of [
    ['curl', '-H', 'Authorization: Bearer top-secret'],
    ['curl', '--user', 'operator:password'],
    ['env', 'QUICKNODE_API_KEY=top-secret', 'collector'],
  ]) {
    const config = baseConfig();
    config.lifecycle.stop = { argv: secretArgv };
    assert.throws(
      () => validateRemoteCanaryConfigV1(config),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'inline-command-secret-rejected',
    );
  }
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
  const runtime = fakeRuntime({
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

test('polling retries only explicitly classified failures', async () => {
  const transient = new RemoteCanaryError('node-request-failed', 'http');
  let attempts = 0;
  const result = await pollUntilV1(
    async () => {
      attempts += 1;
      if (attempts === 1) return false;
      if (attempts === 2) throw transient;
      return 'ready';
    },
    1_000,
    1,
    async () => undefined,
    () => new Error('timeout'),
    { retryError: isRetryableNodeRequestErrorV1 },
  );
  assert.equal(result, 'ready');
  assert.equal(attempts, 3);

  const invariant = new RemoteCanaryError('node-build-mismatch', 'preflight');
  await assert.rejects(
    pollUntilV1(
      async () => { throw invariant; },
      1_000,
      1,
      async () => undefined,
      () => new Error('timeout'),
    ),
    (error) => error === invariant,
  );
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

test('HTTP timeout covers a stalled response body and still restarts the receiver', async () => {
  const runtime = fakeRuntime();
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

test('generic 404 cannot certify authorization even with a plausible denial body', async () => {
  const runtime = fakeRuntime();
  const delegateFetch = runtime.fetchFn;
  runtime.fetchFn = async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/api/typo') {
      runtime.state.requests.push({
        origin: url.origin,
        path: url.pathname,
        method: options.method,
        authorization: new Headers(options.headers).get('authorization'),
      });
      return jsonResponse({ code: 'RFC64_DENIED' }, 404);
    }
    return delegateFetch(input, options);
  };
  const config = baseConfig();
  config.authorizationChecks.unauthorized = {
    kind: 'http',
    nodeId: 'beta-receiver',
    method: 'GET',
    path: '/api/typo',
    authentication: 'none',
    expectedStatuses: [404],
    bodyCodePointer: '/code',
    expectedCodes: ['RFC64_DENIED'],
    notFoundControlNodeId: 'alpha-source',
  };
  await assert.rejects(
    executeRemoteCanaryCertificationV1(config, runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'authorization-not-found-control-failed',
  );
  const probes = runtime.state.requests.filter(({ path }) => path === '/api/typo');
  assert.equal(probes[0].authorization, null);
  assert.equal(probes[1].authorization, `Bearer ${SOURCE_SECRET}`);
});

test('the shared standards validator enforces RPC evidence date-time formats', async () => {
  const runtime = fakeRuntime();
  const evidence = JSON.parse(rpcEvidence());
  evidence.samples[0].windowStartedAt = 'not-a-date';
  runtime.readFileFn = async (path) => {
    if (path === '/run/secrets/source') return SOURCE_SECRET;
    if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
    return JSON.stringify(evidence);
  };
  await assert.rejects(
    executeRemoteCanaryCertificationV1(baseConfig(), runtime),
    (error) => error instanceof RemoteCanaryError && error.code === 'rpc-evidence-malformed',
  );
});

test('RPC evidence rejects non-minutely windows', async () => {
  const runtime = fakeRuntime();
  const valid = JSON.parse(rpcEvidence());
  runtime.readFileFn = async (path) => {
    if (path === '/run/secrets/source') return SOURCE_SECRET;
    if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
    return JSON.stringify({
      ...valid,
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

test('RPC evidence rejects a minutely sample whose method counts do not match total', async () => {
  const runtime = fakeRuntime();
  const evidence = JSON.parse(rpcEvidence());
  evidence.samples = [{
    windowStartedAt: '2026-09-11T00:01:00.000Z',
    windowEndedAt: '2026-09-11T00:02:00.000Z',
    total: 99,
    byMethod: { eth_call: 1 },
  }];
  runtime.readFileFn = async (path) => {
    if (path === '/run/secrets/source') return SOURCE_SECRET;
    if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
    return JSON.stringify(evidence);
  };
  await assert.rejects(
    executeRemoteCanaryCertificationV1(baseConfig({
      rpcUsage: {
        kind: 'evidence-file',
        path: '/tmp/redacted-rpc-evidence.json',
        minimumSamples: 1,
      },
    }), runtime),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-total-mismatch',
  );
});

test('RPC evidence rejects unsafe counts and checked aggregate overflow', async () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  const cohortRef = createRemoteCanaryCohortRefV1(config);
  const evidence = {
    schema: 'dkg-rpc-usage-minutes-v1',
    scope: 'certified-cohort',
    expectedCommit: COMMIT,
    cohortRef,
    samples: [
      {
        windowStartedAt: '2026-09-11T00:00:00.000Z',
        windowEndedAt: '2026-09-11T00:01:00.000Z',
        total: Number.MAX_SAFE_INTEGER,
        byMethod: { eth_call: Number.MAX_SAFE_INTEGER },
      },
      {
        windowStartedAt: '2026-09-11T00:01:00.000Z',
        windowEndedAt: '2026-09-11T00:02:00.000Z',
        total: 1,
        byMethod: { eth_call: 1 },
      },
    ],
  };
  const validationContext = {
    startedAt: '2026-09-11T00:02:30.000Z',
    observedAt: '2026-09-11T00:02:30.000Z',
    expectedCommit: COMMIT,
    cohortRef,
  };
  await assert.rejects(
    collectRpcUsageEvidenceV1(config.rpcUsage, {
      readFileFn: async () => JSON.stringify(evidence),
      ...validationContext,
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-count-overflow',
  );

  const unsafeEvidence = structuredClone(evidence);
  unsafeEvidence.samples = [{
    windowStartedAt: '2026-09-11T00:01:00.000Z',
    windowEndedAt: '2026-09-11T00:02:00.000Z',
    total: Number.MAX_SAFE_INTEGER + 1,
    byMethod: { eth_call: Number.MAX_SAFE_INTEGER + 1 },
  }];
  assert.throws(
    () => validateRpcEvidenceV1(unsafeEvidence, 1, validationContext),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-count-out-of-range',
  );
  await assert.rejects(
    collectRpcUsageEvidenceV1(config.rpcUsage, {
      readFileFn: async () => JSON.stringify(unsafeEvidence),
      ...validationContext,
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-malformed',
  );

  const sampleOverflow = structuredClone(evidence);
  sampleOverflow.samples = [{
    windowStartedAt: '2026-09-11T00:01:00.000Z',
    windowEndedAt: '2026-09-11T00:02:00.000Z',
    total: Number.MAX_SAFE_INTEGER,
    byMethod: { eth_call: Number.MAX_SAFE_INTEGER, eth_blockNumber: 1 },
  }];
  assert.throws(
    () => validateRpcEvidenceV1(sampleOverflow, 1, validationContext),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'rpc-evidence-count-overflow',
  );
});

test('RPC evidence rejects stale and future windows bound to the right release cohort', async () => {
  for (const [windowStartedAt, windowEndedAt, expectedCode] of [
    ['2026-09-10T23:00:00.000Z', '2026-09-10T23:01:00.000Z', 'rpc-evidence-stale'],
    ['2026-09-11T00:10:00.000Z', '2026-09-11T00:11:00.000Z', 'rpc-evidence-future'],
  ]) {
    const runtime = fakeRuntime();
    const evidence = JSON.parse(rpcEvidence());
    evidence.samples = [{
      windowStartedAt,
      windowEndedAt,
      total: 1,
      byMethod: { eth_call: 1 },
    }];
    runtime.readFileFn = async (path) => {
      if (path === '/run/secrets/source') return SOURCE_SECRET;
      if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
      return JSON.stringify(evidence);
    };
    await assert.rejects(
      executeRemoteCanaryCertificationV1(baseConfig({
        rpcUsage: {
          kind: 'evidence-file',
          path: '/tmp/redacted-rpc-evidence.json',
          minimumSamples: 1,
        },
      }), runtime),
      (error) => error instanceof RemoteCanaryError && error.code === expectedCode,
    );
  }
});

test('RPC evidence accepts old history when its final sample is fresh for this run', async () => {
  const runtime = fakeRuntime();
  const evidence = JSON.parse(rpcEvidence());
  evidence.samples.unshift({
    windowStartedAt: '2026-09-10T23:00:00.000Z',
    windowEndedAt: '2026-09-10T23:01:00.000Z',
    total: 3,
    byMethod: { eth_call: 3 },
  });
  runtime.readFileFn = async (path) => {
    if (path === '/run/secrets/source') return SOURCE_SECRET;
    if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
    return JSON.stringify(evidence);
  };
  const artifact = await executeRemoteCanaryCertificationV1(baseConfig(), runtime);
  assert.equal(artifact.checks.rpcUsage.status, 'PASS');
  assert.equal(artifact.checks.rpcUsage.sampleCount, 3);
});

test('command-backed RPC evidence crosses the real subprocess boundary', async () => {
  const config = baseConfig({
    rpcUsage: {
      kind: 'command',
      command: { argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '{}'] },
      minimumSamples: 2,
      commandTimeoutMs: 5_000,
    },
  });
  config.rpcUsage.command.argv[3] = rpcEvidence(config);
  const runtime = fakeRuntime();
  const lifecycleCommand = runtime.runCommand;
  runtime.runCommand = (command, timeoutMs) => (
    command.argv[0] === process.execPath
      ? runBoundedCommandV1(command, timeoutMs)
      : lifecycleCommand(command, timeoutMs)
  );
  const artifact = await executeRemoteCanaryCertificationV1(config, runtime);
  assert.equal(artifact.checks.rpcUsage.status, 'PASS');
  assert.equal(artifact.checks.rpcUsage.source, 'command');
});

test('RPC evidence must identify the certified commit and cohort', async () => {
  for (const [mutate, expectedCode] of [
    [(evidence) => { evidence.expectedCommit = 'f'.repeat(40); }, 'rpc-evidence-commit-mismatch'],
    [(evidence) => { evidence.cohortRef = `cohort:${'f'.repeat(20)}`; }, 'rpc-evidence-cohort-mismatch'],
  ]) {
    const runtime = fakeRuntime();
    const evidence = JSON.parse(rpcEvidence());
    mutate(evidence);
    runtime.readFileFn = async (path) => {
      if (path === '/run/secrets/source') return SOURCE_SECRET;
      if (path === '/run/secrets/receiver') return RECEIVER_SECRET;
      return JSON.stringify(evidence);
    };
    await assert.rejects(
      executeRemoteCanaryCertificationV1(baseConfig(), runtime),
      (error) => error instanceof RemoteCanaryError && error.code === expectedCode,
    );
  }
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

test('runner invalidates a stale PASS before reading malformed configuration JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rfc64-remote-canary-runner-test-'));
  const artifactPath = join(directory, 'latest.json');
  const configPath = join(directory, 'config.json');
  try {
    await writeFile(artifactPath, JSON.stringify({ status: 'PASS', secret: SOURCE_SECRET }));
    await writeFile(configPath, '{"schema":');
    await assert.rejects(execFileAsync(process.execPath, [
      RUNNER_PATH,
      '--config', configPath,
      '--artifact', artifactPath,
    ]));
    const artifactText = await readFile(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactText);
    assert.equal(artifact.status, 'FAIL');
    assert.equal(artifact.failure.code, 'unexpected-execution-failure');
    assert.equal(artifactText.includes(SOURCE_SECRET), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
