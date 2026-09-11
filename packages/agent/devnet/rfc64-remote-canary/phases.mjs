// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';

import {
  ARTIFACT_SCHEMA,
  MAX_COMMAND_OUTPUT_BYTES,
  RPC_EVIDENCE_CLOCK_SKEW_MS,
  RPC_EVIDENCE_MAX_PRECEDING_MS,
  RPC_EVIDENCE_SCHEMA,
  RemoteCanaryError,
  canonicalChainId,
  canonicalInstant,
  createMarker,
  failure,
  jsonPointer,
  opaqueRef,
  round,
} from './common.mjs';
import {
  assertRpcEvidenceShapeV1,
  createRemoteCanaryCohortRefV1,
  validateRemoteCanaryConfigV1,
} from './config.mjs';
import {
  createRequesterV1,
  parseResponseJsonV1,
  runBoundedCommandV1,
} from './transport.mjs';

const PHASE_CONCURRENCY = 4;

/** A network-free plan. It deliberately does not read auth or evidence files. */
export function createRemoteCanaryDryRunArtifactV1(config, now = () => new Date()) {
  const validated = validateRemoteCanaryConfigV1(config);
  const timestamp = now().toISOString();
  return Object.freeze({
    schema: ARTIFACT_SCHEMA,
    status: 'DRY_RUN',
    phase: 'planned',
    startedAt: timestamp,
    finishedAt: timestamp,
    expectedCommit: validated.expectedCommit,
    cohortRef: createRemoteCanaryCohortRefV1(validated),
    topology: redactedTopology(validated),
    plan: Object.freeze({
      preflight: 'exact-build-network-sync-and-catalog-mode',
      liveSwmPropagationChecks: validated.contextGraphs.length,
      offlineCatchup: validated.lifecycle === null ? 'EVIDENCE_REQUIRED' : 'PLANNED',
      vmParityChecks: validated.contextGraphs.length,
      catalogSwmEvidence: validated.contextGraphs.every((entry) => (
        entry.catalogSwmAskSparql !== undefined
      )) ? 'PLANNED' : 'EVIDENCE_REQUIRED',
      authorization: authorizationPlan(validated.authorizationChecks),
      rpcUsage: validated.rpcUsage.kind === 'required' ? 'EVIDENCE_REQUIRED' : 'PLANNED',
    }),
  });
}

/** Execute the ordered certification phases, parallelizing only independent checks. */
export async function executeRemoteCanaryCertificationV1(config, dependencies = {}) {
  const validated = validateRemoteCanaryConfigV1(config);
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') throw failure('fetch-unavailable', 'config');
  const readFileFn = dependencies.readFileFn ?? readFile;
  const runCommand = dependencies.runCommand ?? runBoundedCommandV1;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? (() => new Date());
  const secrets = new Map();
  const nodeById = new Map(validated.nodes.map((node) => [node.id, node]));
  const nodeRefs = createNodeRefs(validated.nodes);
  const request = createRequesterV1({ fetchFn, readFileFn, secrets, timing: validated.timing });
  const startedAt = now().toISOString();
  const cohortRef = createRemoteCanaryCohortRefV1(validated);
  let phase = 'preflight';

  try {
    const preflightStatuses = await preflightAllNodes({
      config: validated,
      request,
      nodeRefs,
    });

    phase = 'live-swm-propagation';
    const liveSwmPropagation = await mapConcurrentOrdered(
      validated.contextGraphs,
      PHASE_CONCURRENCY,
      async (contextGraph) => {
        const marker = createMarker();
        const source = nodeById.get(contextGraph.sourceNodeId);
        const receiver = nodeById.get(contextGraph.receiverNodeId);
        await shareMarker(source, contextGraph.id, marker, request, phase);
        await pollUntil(
          async () => askMarker(receiver, contextGraph.id, marker, 'shared-working-memory', request),
          validated.timing.propagationTimeoutMs,
          validated.timing.pollIntervalMs,
          sleep,
          'swm-propagation-timeout',
          phase,
        );
        return Object.freeze({
          contextGraphRef: opaqueRef('cg', contextGraph.id),
          markerRef: opaqueRef('marker', marker.subject),
          status: 'PASS',
        });
      },
    );

    phase = 'offline-catchup';
    const offlineCatchup = validated.lifecycle === null
      ? Object.freeze({ status: 'EVIDENCE_REQUIRED', requirement: 'single-receiver-stop-start' })
      : await verifyOfflineCatchup({
          config: validated,
          lifecycle: validated.lifecycle,
          nodeById,
          request,
          runCommand,
          sleep,
        });

    phase = 'vm-parity';
    const vmParity = await mapConcurrentOrdered(
      validated.contextGraphs,
      PHASE_CONCURRENCY,
      async (contextGraph) => {
        const source = nodeById.get(contextGraph.sourceNodeId);
        const receiver = nodeById.get(contextGraph.receiverNodeId);
        const parity = await pollUntil(
          async () => readVmParity(source, receiver, contextGraph, request),
          validated.timing.parityTimeoutMs,
          validated.timing.pollIntervalMs,
          sleep,
          'vm-parity-timeout',
          phase,
        );
        if (contextGraph.vmAskSparql !== undefined) {
          const queryPassed = await Promise.all([source, receiver].map((node) => (
            askConfiguredQuery(node, contextGraph, contextGraph.vmAskSparql, 'verifiable-memory', request)
          )));
          if (!queryPassed.every(Boolean)) throw failure('vm-query-parity-failed', phase);
        }
        return Object.freeze({
          contextGraphRef: opaqueRef('cg', contextGraph.id),
          status: contextGraph.vmAskSparql === undefined ? 'EVIDENCE_REQUIRED' : 'PASS',
          statusParity: 'PASS',
          cursorPresent: parity.cursorPresent,
          digestParity: parity.digestParity,
          rowCountParity: parity.rowCountParity,
          vmQueryChecked: contextGraph.vmAskSparql !== undefined,
          ...(contextGraph.vmAskSparql === undefined ? { requirement: 'vm-ask-query' } : {}),
        });
      },
    );

    phase = 'catalog-swm-evidence';
    const catalogSwm = await mapConcurrentOrdered(
      validated.contextGraphs,
      PHASE_CONCURRENCY,
      async (contextGraph) => {
        if (contextGraph.catalogSwmAskSparql === undefined) {
          return Object.freeze({
            contextGraphRef: opaqueRef('cg', contextGraph.id),
            status: 'EVIDENCE_REQUIRED',
            requirement: 'known-catalog-swm-ask-query',
            queryChecked: false,
          });
        }
        const source = nodeById.get(contextGraph.sourceNodeId);
        const receiver = nodeById.get(contextGraph.receiverNodeId);
        const [sourceQueryPassed, receiverQueryPassed] = await Promise.all([
          askConfiguredQuery(
            source,
            contextGraph,
            contextGraph.catalogSwmAskSparql,
            'shared-working-memory',
            request,
          ),
          askConfiguredQuery(
            receiver,
            contextGraph,
            contextGraph.catalogSwmAskSparql,
            'shared-working-memory',
            request,
          ),
        ]);
        if (!sourceQueryPassed || !receiverQueryPassed) {
          throw failure('catalog-swm-query-failed', phase);
        }
        return Object.freeze({
          contextGraphRef: opaqueRef('cg', contextGraph.id),
          status: 'PASS',
          queryChecked: true,
          sourceQueryPassed,
          receiverQueryPassed,
        });
      },
    );

    phase = 'authorization';
    const [unauthorized, revoked] = await Promise.all([
      runAuthorizationCheck(validated.authorizationChecks.unauthorized, nodeById, request),
      runAuthorizationCheck(validated.authorizationChecks.revoked, nodeById, request),
    ]);
    const authorization = Object.freeze({ unauthorized, revoked });

    phase = 'rpc-usage';
    const rpcUsage = await collectRpcUsageEvidence(validated.rpcUsage, {
      readFileFn,
      runCommand,
      startedAt,
      observedAt: now().toISOString(),
      expectedCommit: validated.expectedCommit,
      cohortRef,
    });

    const incomplete = offlineCatchup.status !== 'PASS'
      || vmParity.some((entry) => entry.status !== 'PASS')
      || catalogSwm.some((entry) => entry.status !== 'PASS')
      || authorization.unauthorized.status !== 'PASS'
      || authorization.revoked.status !== 'PASS'
      || rpcUsage.status !== 'PASS';
    return Object.freeze({
      schema: ARTIFACT_SCHEMA,
      status: incomplete ? 'INCOMPLETE' : 'PASS',
      phase: incomplete ? 'evidence-required' : 'complete',
      startedAt,
      finishedAt: now().toISOString(),
      expectedCommit: validated.expectedCommit,
      cohortRef,
      topology: redactedTopology(validated),
      preflight: Object.freeze({ status: 'PASS', nodes: preflightStatuses }),
      checks: Object.freeze({
        liveSwmPropagation: Object.freeze(liveSwmPropagation),
        offlineCatchup,
        vmParity: Object.freeze(vmParity),
        catalogSwm: Object.freeze(catalogSwm),
        authorization,
        rpcUsage,
      }),
    });
  } catch (error) {
    if (error instanceof RemoteCanaryError) throw error;
    throw failure('unexpected-execution-failure', phase, error);
  } finally {
    secrets.clear();
  }
}

async function preflightAllNodes({ config, request, nodeRefs }) {
  const statuses = await mapConcurrentOrdered(config.nodes, PHASE_CONCURRENCY, async (node) => {
    const status = await request.json(node, 'GET', '/api/status');
    validateNodePreflight(status, node, config);
    return [node, status];
  });
  const raw = new Map(statuses.map(([node, status]) => [node.id, status]));
  const networkKeys = new Set([...raw.values()].map((status) => (
    `${String(status.networkId)}:${String(status.chain?.chainId)}`
  )));
  if (networkKeys.size !== 1) throw failure('node-network-mismatch', 'preflight');
  return Object.freeze(config.nodes.map((node) => {
    const status = raw.get(node.id);
    const relevant = config.contextGraphs.filter((entry) => (
      entry.sourceNodeId === node.id || entry.receiverNodeId === node.id
    ));
    return Object.freeze({
      nodeRef: nodeRefs.get(node.id),
      role: node.role,
      commit: status.commit,
      chainId: canonicalChainId(status.chain?.chainId),
      syncReconcilerEnabled: true,
      catalogServiceEnabled: status.rfc64Catalog.enabled === true,
      contextGraphs: Object.freeze(relevant.map((entry) => Object.freeze({
        contextGraphRef: opaqueRef('cg', entry.id),
        mode: 'catalog',
        legacySyncAllowed: false,
      }))),
    });
  }));
}

function validateNodePreflight(status, node, config) {
  if (status === null || typeof status !== 'object' || Array.isArray(status)) {
    throw failure('preflight-status-malformed', 'preflight');
  }
  if (status.commit !== config.expectedCommit) throw failure('node-build-mismatch', 'preflight');
  if (typeof status.networkId !== 'string' || status.networkId.length < 1) {
    throw failure('node-network-missing', 'preflight');
  }
  if (status.syncLifecycle?.syncReconcilerEnabled !== true) {
    throw failure('sync-reconciler-disabled', 'preflight');
  }
  if (status.rfc64Catalog?.enabled !== true) throw failure('rfc64-catalog-disabled', 'preflight');
  if (status.rfc64Catalog?.rollout?.killSwitch !== false) {
    throw failure('rfc64-kill-switch-active', 'preflight');
  }
  if (
    status.chain?.configured !== true
    || !Number.isSafeInteger(status.chain?.rpcEndpointCount)
    || status.chain.rpcEndpointCount < 1
  ) throw failure('chain-rpc-not-configured', 'preflight');
  canonicalChainId(status.chain.chainId);
  for (const entry of config.contextGraphs.filter((candidate) => (
    candidate.sourceNodeId === node.id || candidate.receiverNodeId === node.id
  ))) {
    if (status.rfc64Catalog?.rollout?.contextGraphModes?.[entry.id] !== entry.expectedMode) {
      throw failure('rfc64-mode-mismatch', 'preflight');
    }
    const operational = operationalStatus(status, entry.id);
    if (operational === null || operational.effectiveMode !== entry.expectedMode) {
      throw failure('rfc64-operational-mode-missing', 'preflight');
    }
    if (operational.catalogServiceStarted !== true) {
      throw failure('rfc64-catalog-service-not-started', 'preflight');
    }
    if (operational.legacySyncAllowed !== false) {
      throw failure('rfc64-legacy-sync-allowed', 'preflight');
    }
  }
}

async function verifyOfflineCatchup({ config, lifecycle, nodeById, request, runCommand, sleep }) {
  const receiver = nodeById.get(lifecycle.receiverNodeId);
  let stopInvoked = false;
  let primaryFailure = null;
  let startFailure = null;
  let markers = [];
  try {
    stopInvoked = true;
    const stopped = await runCommand(lifecycle.stop, lifecycle.commandTimeoutMs);
    if (stopped.code !== 0) throw failure('receiver-stop-command-failed', 'offline-catchup');
    await pollUntil(
      async () => !(await request.reachable(receiver)),
      lifecycle.stopTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      'receiver-did-not-stop',
      'offline-catchup',
    );
    markers = await mapConcurrentOrdered(config.contextGraphs, PHASE_CONCURRENCY, async (contextGraph) => {
      const marker = createMarker();
      await shareMarker(
        nodeById.get(contextGraph.sourceNodeId),
        contextGraph.id,
        marker,
        request,
        'offline-catchup',
      );
      return [contextGraph, marker];
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (stopInvoked) {
      const started = await runCommand(lifecycle.start, lifecycle.commandTimeoutMs).catch(() => null);
      if (started === null || started.code !== 0) {
        startFailure = failure('receiver-start-command-failed', 'offline-catchup');
      }
    }
  }
  if (startFailure !== null) {
    throw primaryFailure === null
      ? startFailure
      : failure(
          'receiver-start-command-failed',
          'offline-catchup',
          new AggregateError([primaryFailure, startFailure], 'receiver-recovery-failed'),
        );
  }
  if (primaryFailure !== null) throw primaryFailure;

  await pollUntil(
    async () => {
      try {
        const status = await request.json(receiver, 'GET', '/api/status');
        validateNodePreflight(status, receiver, config);
        return true;
      } catch {
        return false;
      }
    },
    lifecycle.readyTimeoutMs,
    config.timing.pollIntervalMs,
    sleep,
    'receiver-did-not-recover',
    'offline-catchup',
  );

  const evidence = await mapConcurrentOrdered(markers, PHASE_CONCURRENCY, async ([contextGraph, marker]) => {
    await pollUntil(
      async () => askMarker(receiver, contextGraph.id, marker, 'shared-working-memory', request),
      config.timing.catchupTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      'offline-catchup-timeout',
      'offline-catchup',
    );
    return Object.freeze({
      contextGraphRef: opaqueRef('cg', contextGraph.id),
      markerRef: opaqueRef('marker', marker.subject),
      status: 'PASS',
    });
  });
  return Object.freeze({ status: 'PASS', receiverCount: 1, contextGraphs: evidence });
}

async function shareMarker(node, contextGraphId, marker, request, phase) {
  const result = await request.json(node, 'POST', '/api/knowledge-assets', {
    contextGraphId,
    name: marker.assetName,
    quads: [{
      subject: marker.subject,
      predicate: marker.predicate,
      object: JSON.stringify(marker.value),
    }],
    alsoShareSwm: true,
  });
  if (result.swmShared !== true) throw failure('swm-share-not-confirmed', phase);
}

async function askMarker(node, contextGraphId, marker, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql: `ASK { <${marker.subject}> <${marker.predicate}> ${JSON.stringify(marker.value)} . }`,
    contextGraphId,
    view,
  });
  return result.result?.type === 'boolean' && result.result.value === true;
}

async function askConfiguredQuery(node, contextGraph, sparql, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql,
    contextGraphId: contextGraph.id,
    view,
  });
  return result.result?.type === 'boolean' && result.result.value === true;
}

async function readVmParity(source, receiver, contextGraph, request) {
  const [sourceStatus, receiverStatus] = await Promise.all([
    request.json(source, 'GET', '/api/status'),
    request.json(receiver, 'GET', '/api/status'),
  ]);
  const sourceOperational = completeOperationalParity(sourceStatus, contextGraph.id);
  const receiverOperational = completeOperationalParity(receiverStatus, contextGraph.id);
  if (sourceOperational === null || receiverOperational === null) return false;
  const keys = ['appliedCatalogHeadDigest', 'appliedInventoryDigest', 'appliedRowCount', 'catalogVersion'];
  if (!keys.every((key) => sourceOperational[key] === receiverOperational[key])) return false;
  return Object.freeze({ cursorPresent: true, digestParity: true, rowCountParity: true });
}

function completeOperationalParity(status, contextGraphId) {
  const operational = operationalStatus(status, contextGraphId);
  if (operational === null) return null;
  if (
    operational.effectiveMode !== 'catalog'
    || operational.phase !== 'complete'
    || operational.authorityState !== 'accepted'
    || operational.authorityFreshness !== 'current'
    || operational.missingRowCount !== '0'
    || operational.catalogVersion === null
    || operational.catalogVersion === undefined
    || operational.lastSuccessfulAdvanceAt === null
    || operational.lastSuccessfulAdvanceAt === undefined
    || operational.appliedCatalogHeadDigest === null
    || operational.appliedInventoryDigest === null
    || operational.appliedRowCount === null
    || operational.expectedCatalogHeadDigest !== operational.appliedCatalogHeadDigest
    || operational.expectedInventoryDigest !== operational.appliedInventoryDigest
    || operational.expectedRowCount !== operational.appliedRowCount
  ) return null;
  return operational;
}

function operationalStatus(status, contextGraphId) {
  const entries = status.rfc64Catalog?.contextGraphs;
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => entry?.contextGraphId === contextGraphId) ?? null;
}

async function runAuthorizationCheck(check, nodeById, request) {
  if (check.kind === 'not-exposed') {
    return Object.freeze({ status: 'EVIDENCE_REQUIRED', reasonCode: check.reasonCode });
  }
  const node = nodeById.get(check.nodeId);
  const response = await request.raw(
    node,
    check.method,
    check.path,
    check.body,
    check.authentication,
  );
  if (!check.expectedStatuses.includes(response.status)) {
    throw failure('authorization-denial-status-mismatch', 'authorization');
  }
  if (check.bodyCodePointer !== undefined) {
    const body = parseResponseJsonV1(response, 'authorization-response-malformed');
    const code = jsonPointer(body, check.bodyCodePointer);
    if (!check.expectedCodes.includes(code)) {
      throw failure('authorization-denial-code-mismatch', 'authorization');
    }
  }
  if (response.status === 404) {
    const controlNode = nodeById.get(check.notFoundControlNodeId);
    const control = await request.raw(controlNode, check.method, check.path, check.body, 'node');
    if (control.status < 200 || control.status >= 300) {
      throw failure('authorization-not-found-control-failed', 'authorization');
    }
  }
  return Object.freeze({ status: 'PASS', denialObserved: true });
}

async function collectRpcUsageEvidence(config, context) {
  if (config.kind === 'required') {
    return Object.freeze({
      status: 'EVIDENCE_REQUIRED',
      requirement: RPC_EVIDENCE_SCHEMA,
      acceptedSources: Object.freeze(['evidence-file', 'command']),
    });
  }
  let text;
  if (config.kind === 'evidence-file') {
    text = await context.readFileFn(config.path, 'utf8').catch(() => {
      throw failure('rpc-evidence-read-failed', 'rpc-usage');
    });
  } else {
    const result = await context.runCommand(config.command, config.commandTimeoutMs);
    if (result.code !== 0) throw failure('rpc-evidence-command-failed', 'rpc-usage');
    text = result.stdout;
  }
  if (Buffer.byteLength(text) > MAX_COMMAND_OUTPUT_BYTES) {
    throw failure('rpc-evidence-too-large', 'rpc-usage');
  }
  let evidence;
  try {
    evidence = JSON.parse(text);
    assertRpcEvidenceShapeV1(evidence);
  } catch {
    throw failure('rpc-evidence-malformed', 'rpc-usage');
  }
  const samples = validateRpcEvidence(evidence, config.minimumSamples, context);
  const byMethod = {};
  let total = 0;
  let durationSeconds = 0;
  for (const sample of samples) {
    total += sample.total;
    durationSeconds += (Date.parse(sample.windowEndedAt) - Date.parse(sample.windowStartedAt)) / 1000;
    for (const [method, count] of Object.entries(sample.byMethod)) {
      byMethod[method] = (byMethod[method] ?? 0) + count;
    }
  }
  return Object.freeze({
    status: 'PASS',
    source: config.kind,
    cohortRef: context.cohortRef,
    windowStartedAt: samples[0].windowStartedAt,
    windowEndedAt: samples.at(-1).windowEndedAt,
    sampleCount: samples.length,
    measuredSeconds: durationSeconds,
    total,
    requestsPerMinute: durationSeconds === 0 ? 0 : round(total * 60 / durationSeconds),
    byMethod: Object.freeze(Object.fromEntries(Object.entries(byMethod).sort())),
  });
}

function validateRpcEvidence(evidence, minimumSamples, context) {
  if (evidence.expectedCommit.toLowerCase() !== context.expectedCommit) {
    throw failure('rpc-evidence-commit-mismatch', 'rpc-usage');
  }
  if (evidence.cohortRef !== context.cohortRef) {
    throw failure('rpc-evidence-cohort-mismatch', 'rpc-usage');
  }
  if (evidence.samples.length < minimumSamples) {
    throw failure('rpc-evidence-sample-count', 'rpc-usage');
  }
  let precedingEnd = -Infinity;
  const samples = evidence.samples.map((sample) => {
    const start = canonicalInstant(sample.windowStartedAt);
    const end = canonicalInstant(sample.windowEndedAt);
    const durationMs = end - start;
    if (durationMs < 45_000 || durationMs > 75_000 || start < precedingEnd) {
      throw failure('rpc-evidence-window-not-minutely', 'rpc-usage');
    }
    precedingEnd = end;
    const methodTotal = Object.values(sample.byMethod).reduce((sum, count) => sum + count, 0);
    if (methodTotal !== sample.total) throw failure('rpc-evidence-total-mismatch', 'rpc-usage');
    return sample;
  });
  const runStart = Date.parse(context.startedAt);
  const observed = Date.parse(context.observedAt);
  const earliest = Date.parse(samples[0].windowStartedAt);
  const latest = Date.parse(samples.at(-1).windowEndedAt);
  if (earliest < runStart - RPC_EVIDENCE_MAX_PRECEDING_MS) {
    throw failure('rpc-evidence-stale', 'rpc-usage');
  }
  if (earliest > observed + RPC_EVIDENCE_CLOCK_SKEW_MS || latest > observed + RPC_EVIDENCE_CLOCK_SKEW_MS) {
    throw failure('rpc-evidence-future', 'rpc-usage');
  }
  return samples;
}

async function pollUntil(check, timeoutMs, intervalMs, sleep, code, phase) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // Bounded polling treats transient request failures as not ready.
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw failure(code, phase);
}

async function mapConcurrentOrdered(items, concurrency, mapper) {
  const results = Array.from({ length: items.length });
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  ));
  return results;
}

function redactedTopology(config) {
  const refs = createNodeRefs(config.nodes);
  return Object.freeze({
    nodeCount: config.nodes.length,
    nodes: Object.freeze(config.nodes.map((node) => Object.freeze({
      nodeRef: refs.get(node.id),
      role: node.role,
      authentication: node.auth.kind,
    }))),
    contextGraphs: Object.freeze(config.contextGraphs.map((entry) => Object.freeze({
      contextGraphRef: opaqueRef('cg', entry.id),
      sourceNodeRef: refs.get(entry.sourceNodeId),
      receiverNodeRef: refs.get(entry.receiverNodeId),
      expectedMode: entry.expectedMode,
    }))),
  });
}

function authorizationPlan(checks) {
  return Object.freeze({
    unauthorized: checks.unauthorized.kind === 'http' ? 'PLANNED' : 'EVIDENCE_REQUIRED',
    revoked: checks.revoked.kind === 'http' ? 'PLANNED' : 'EVIDENCE_REQUIRED',
  });
}

function createNodeRefs(nodes) {
  return new Map(nodes.map((node) => [node.id, opaqueRef('node', node.id)]));
}
