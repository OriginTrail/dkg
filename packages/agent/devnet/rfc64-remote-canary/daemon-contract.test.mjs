// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createAllowedHttpAuthentication } from '../../../cli/src/auth.ts';
import { handleKnowledgeAssetsRoutes } from '../../../cli/src/daemon/routes/knowledge-assets.ts';
import { handleQueryRoutes } from '../../../cli/src/daemon/routes/query.ts';
import { handleStatusRoutes } from '../../../cli/src/daemon/routes/status.ts';
import { decodeRfc64DaemonCertificationStatusV1 } from '../../src/rfc64/daemon-certification-status-v1.ts';

import {
  createRemoteCanaryCohortRefV1,
  executeRemoteCanaryCertificationV1,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import { CANARY_SUBJECT_PREFIX } from './canary-vocabulary.mjs';
import { CATALOG_SWM_ASK, CG } from './test-support.mjs';

const OPERATIONAL_DIGEST = `0x${'ab'.repeat(32)}`;
const INVENTORY_DIGEST = `0x${'cd'.repeat(32)}`;
const NODE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const NODE_ADDRESS = '0x1111111111111111111111111111111111111111';
const RECEIVER_SECRET_FILE = '/tmp/daemon-contract-receiver-token';
const RECEIVER_TOKEN = 'daemon-contract-receiver-token';

test('required gate certifies through the production status, KA, and query handlers', async () => {
  const sourceState = createRouteState('source');
  const receiverState = createRouteState('receiver');
  const synchronization = createSynchronizationHarness(receiverState);
  const source = await startRouteServer(createRouteAgent(sourceState, synchronization), sourceState);
  const receiver = await startRouteServer(createRouteAgent(receiverState), receiverState);
  try {
    const liveStatus = await fetch(`${source.baseUrl}/api/status`).then((response) => response.json());
    assert.match(liveStatus.commit, /^[0-9a-f]{40}$/u);
    assert.equal(
      liveStatus.rfc64Certification.schema,
      'dkg-rfc64-daemon-certification-status-v1',
    );
    const certificationStatus = decodeRfc64DaemonCertificationStatusV1(
      liveStatus.rfc64Certification,
    );
    assert.equal(certificationStatus.catalog.contextGraphs.length, 1);

    const config = createContractConfig(source.baseUrl, receiver.baseUrl, liveStatus.commit);
    const normalized = validateRemoteCanaryConfigV1(config);
    const cohortRef = createRemoteCanaryCohortRefV1(normalized);
    const fetchFn = createContractFetch();
    const runCommand = async ({ argv }) => {
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
      readFileFn: async (path) => {
        if (path === RECEIVER_SECRET_FILE) return RECEIVER_TOKEN;
        assert.equal(path, '/tmp/daemon-contract-rpc-evidence.json');
        return JSON.stringify({
          schema: 'dkg-rpc-usage-minutes-v1',
          scope: 'certified-cohort',
          expectedCommit: liveStatus.commit,
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

test('certification fails when independent receiver delivery is disabled', async () => {
  const sourceState = createRouteState('source');
  const receiverState = createRouteState('receiver');
  const synchronization = createSynchronizationHarness(receiverState, { enabled: false });
  const source = await startRouteServer(createRouteAgent(sourceState, synchronization), sourceState);
  const receiver = await startRouteServer(createRouteAgent(receiverState), receiverState);
  try {
    const liveStatus = await fetch(`${source.baseUrl}/api/status`).then(
      (response) => response.json(),
    );
    assert.match(liveStatus.commit, /^[0-9a-f]{40}$/u);
    const config = createContractConfig(source.baseUrl, receiver.baseUrl, liveStatus.commit);
    await assert.rejects(
      executeRemoteCanaryCertificationV1(config, {
        fetchFn: createContractFetch(),
        runCommand: async () => { throw new Error('lifecycle must not start'); },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => new Date('2026-09-11T00:02:30.000Z'),
        readFileFn: async (path) => {
          if (path === RECEIVER_SECRET_FILE) return RECEIVER_TOKEN;
          throw new Error('RPC evidence must not be read');
        },
      }),
      (error) => error?.code === 'swm-propagation-timeout'
        && error?.phase === 'live-swm-propagation',
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

function createContractConfig(sourceBaseUrl, receiverBaseUrl, expectedCommit) {
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

function createContractFetch() {
  return async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/api/rfc64/unauthorized-probe') {
      return jsonResponse({ code: 'RFC64_DENIED' }, 403);
    }
    if (url.pathname === '/api/rfc64/revoked-probe') {
      return jsonResponse({ code: 'RFC64_REVOKED' }, 403);
    }
    return fetch(input, options);
  };
}

function createRouteState(role) {
  return {
    role,
    writtenByName: new Map(),
    sharedSubjects: new Set(),
    routeCalls: [],
  };
}

function createSynchronizationHarness(receiverState, { enabled = true } = {}) {
  // Model the production network seam without sharing either daemon's store:
  // live announcements apply to the receiver only while it is online; missed
  // announcements remain detached until the receiver's restart reconciliation.
  let receiverOnline = true;
  const queued = [];
  let liveDeliveries = 0;
  let queuedDeliveries = 0;
  let catchupDeliveries = 0;
  const apply = (quads) => {
    for (const quad of quads) receiverState.sharedSubjects.add(quad.subject);
  };
  return Object.freeze({
    publish(quads) {
      if (!enabled) return;
      const detached = structuredClone(quads);
      if (receiverOnline) {
        apply(detached);
        liveDeliveries += 1;
      } else {
        queued.push(detached);
        queuedDeliveries += 1;
      }
    },
    receiverStopped() {
      receiverOnline = false;
    },
    receiverStarted() {
      receiverOnline = true;
      for (const quads of queued.splice(0)) {
        apply(quads);
        catchupDeliveries += 1;
      }
    },
    stats: () => Object.freeze({ liveDeliveries, queuedDeliveries, catchupDeliveries }),
  });
}

function createRouteAgent(state, synchronization) {
  return {
    peerId: `12D3KooDaemonContract${state.role}`,
    multiaddrs: [],
    node: {
      libp2p: { getConnections: () => [] },
      getRelayStats: () => null,
    },
    publisher: { getIdentityId: () => 1n },
    getSyncContextGraphIds: () => [CG],
    readRfc64CatalogOperationalStatusV1: async () => [{
      contextGraphId: CG,
      effectiveMode: 'catalog',
      legacySyncAllowed: false,
      phase: 'complete',
      authorityState: 'accepted',
      authorityFreshness: 'current',
      catalogServiceStarted: true,
      expectedCatalogHeadDigest: OPERATIONAL_DIGEST,
      appliedCatalogHeadDigest: OPERATIONAL_DIGEST,
      expectedInventoryDigest: INVENTORY_DIGEST,
      appliedInventoryDigest: INVENTORY_DIGEST,
      expectedRowCount: '2',
      appliedRowCount: '2',
      missingRowCount: '0',
      catalogVersion: '7',
      lastSuccessfulAdvanceAt: '1893456000',
    }],
    getDefaultAgentAddress: () => NODE_ADDRESS,
    resolveAgentByToken: () => undefined,
    listContextGraphs: async () => [{
      id: CG,
      uri: `did:dkg:context-graph:${CG}`,
      subscribed: true,
      synced: true,
    }],
    contextGraphExists: async (contextGraphId) => contextGraphId === CG,
    assertion: {
      history: async () => null,
      create: async (_contextGraphId, name) => `urn:assertion:${name}`,
      write: async (_contextGraphId, name, quads) => {
        state.writtenByName.set(name, structuredClone(quads));
      },
      finalize: async () => ({
        merkleRoot: new Uint8Array(32),
        authorAddress: NODE_ADDRESS,
      }),
      promote: async (_contextGraphId, name) => {
        const quads = state.writtenByName.get(name) ?? [];
        for (const quad of quads) {
          state.sharedSubjects.add(quad.subject);
        }
        synchronization?.publish(quads);
        return { promotedCount: 1, sealed: true, publishReady: true };
      },
    },
    query: async (sparql) => {
      const subject = sparql.match(/<([^>]+)>/u)?.[1];
      const value = sparql === CATALOG_SWM_ASK
        || sparql.includes('urn:known:vm-subject')
        || (subject !== undefined && state.sharedSubjects.has(subject));
      return { bindings: [{ result: String(value) }] };
    },
  };
}

async function startRouteServer(agent, state) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    state.routeCalls.push({ method: req.method, path });
    const authentication = createAllowedHttpAuthentication({ mode: 'public' });
    const activation = {
      enabled: true,
      selectedContextGraphs: [CG],
      selectedPublicContextGraphs: [CG],
      selectedPrivateContextGraphs: [],
      rollout: { killSwitch: false, contextGraphModes: { [CG]: 'catalog' } },
    };
    const tracker = {
      start: () => undefined,
      startPhase: () => undefined,
      completePhase: () => undefined,
      complete: () => undefined,
      fail: () => undefined,
      cancel: () => undefined,
    };
    const context = {
      req,
      res,
      agent,
      publisherControl: {},
      publisherState: {
        runtime: null,
        availability: {
          available: false,
          reason: 'publisher_disabled',
          retryable: false,
          operatorActionRequired: true,
        },
      },
      config: {
        name: 'rfc64-canary-route-contract',
        nodeRole: 'edge',
        syncReconcilerEnabled: true,
        chain: {
          type: 'evm',
          rpcUrl: 'https://rpc.invalid',
          hubAddress: NODE_ADDRESS,
          chainId: '2160',
        },
      },
      rfc64Catalog: activation,
      rfc64PublicCatalog: activation,
      startedAt: Date.now(),
      dashDb: {},
      opWallets: {},
      network: { networkId: 'otp-testnet-2160', networkName: 'testnet' },
      tracker,
      memoryManager: {},
      bridgeAuthToken: undefined,
      nodeVersion: '10.0.0-test',
      nodeCommit: NODE_COMMIT,
      catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
      extractionRegistry: {},
      fileStore: {},
      extractionStatus: new Map(),
      assertionImportLocks: new Map(),
      vectorStore: {},
      embeddingProvider: null,
      validTokens: new Set(),
      apiHost: '127.0.0.1',
      apiPortRef: { value: 0 },
      admission: { inFlight: 0, max: 0, rejectedTotal: 0 },
      url,
      path,
      requestAgentAddress: NODE_ADDRESS,
      authentication,
      emitMemoryGraphChanged: () => undefined,
      emitNotification: () => undefined,
    };
    try {
      if (path === '/api/status') await handleStatusRoutes(context);
      else if (path === '/api/knowledge-assets') await handleKnowledgeAssetsRoutes(context);
      else if (path === '/api/query') await handleQueryRoutes(context);
      if (!res.writableEnded) jsonNodeResponse(res, 404, { error: 'not found' });
    } catch (error) {
      if (!res.writableEnded) {
        jsonNodeResponse(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  const listen = (port) => new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const stop = () => new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  await listen(0);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('route server did not bind');
  const port = address.port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    start: () => server.listening ? Promise.resolve() : listen(port),
    stop,
    close: stop,
  };
}

function jsonNodeResponse(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
