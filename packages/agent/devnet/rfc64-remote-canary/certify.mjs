// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const CONFIG_SCHEMA = 'dkg-rfc64-remote-canary-config-v1';
const ARTIFACT_SCHEMA = 'dkg-rfc64-remote-canary-certificate-v1';
const RPC_EVIDENCE_SCHEMA = 'dkg-rpc-usage-minutes-v1';
const DEFAULT_TIMING = Object.freeze({
  requestTimeoutMs: 10_000,
  pollIntervalMs: 2_000,
  propagationTimeoutMs: 120_000,
  catchupTimeoutMs: 240_000,
  parityTimeoutMs: 120_000,
});
const MAX_HTTP_BODY_BYTES = 1_048_576;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const DENIAL_STATUSES = new Set([401, 403, 404]);

export class RemoteCanaryError extends Error {
  constructor(code, phase, options = {}) {
    super(code, options);
    this.name = 'RemoteCanaryError';
    this.code = code;
    this.phase = phase;
  }
}

/** Strict runtime validation complements config.schema.json without dependencies. */
export function validateRemoteCanaryConfigV1(input) {
  assertRecord(input, 'config');
  exactKeys(input, [
    'schema',
    'expectedCommit',
    'nodes',
    'contextGraphs',
    'lifecycle',
    'authorizationChecks',
    'rpcUsage',
    'timing',
  ], 'config');
  if (input.schema !== CONFIG_SCHEMA) invalid('config-schema');
  if (typeof input.expectedCommit !== 'string' || !/^[0-9a-f]{40}$/iu.test(input.expectedCommit)) {
    invalid('expected-commit');
  }

  if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 16) {
    invalid('nodes-cardinality');
  }
  const nodeIds = new Set();
  const nodes = input.nodes.map((node, index) => validateNode(node, index, nodeIds));
  if (!nodes.some(({ role }) => role === 'source')) invalid('source-node-required');
  if (!nodes.some(({ role }) => role === 'receiver')) invalid('receiver-node-required');

  if (
    !Array.isArray(input.contextGraphs)
    || input.contextGraphs.length < 1
    || input.contextGraphs.length > 32
  ) invalid('context-graphs-cardinality');
  const contextGraphIds = new Set();
  const contextGraphs = input.contextGraphs.map((entry, index) => {
    assertRecord(entry, `contextGraphs[${index}]`);
    exactKeys(entry, [
      'id', 'expectedMode', 'sourceNodeId', 'receiverNodeId', 'vmAskSparql',
    ], `contextGraphs[${index}]`);
    boundedString(entry.id, 1, 512, 'context-graph-id');
    if (contextGraphIds.has(entry.id)) invalid('duplicate-context-graph');
    contextGraphIds.add(entry.id);
    if (entry.expectedMode !== 'catalog') invalid('canary-mode-must-be-catalog');
    if (!nodeIds.has(entry.sourceNodeId) || !nodeIds.has(entry.receiverNodeId)) {
      invalid('context-graph-node-reference');
    }
    if (entry.sourceNodeId === entry.receiverNodeId) invalid('source-receiver-must-differ');
    const source = nodes.find(({ id }) => id === entry.sourceNodeId);
    const receiver = nodes.find(({ id }) => id === entry.receiverNodeId);
    if (source.role !== 'source' || receiver.role !== 'receiver') invalid('context-graph-node-role');
    if (entry.vmAskSparql !== undefined) validateAskSparql(entry.vmAskSparql);
    return Object.freeze({ ...entry });
  });
  const receiverNodeIds = new Set(contextGraphs.map(({ receiverNodeId }) => receiverNodeId));
  if (receiverNodeIds.size !== 1) invalid('exactly-one-receiver-required');
  const receiverNodeId = [...receiverNodeIds][0];

  const lifecycle = input.lifecycle === undefined || input.lifecycle === null
    ? null
    : validateLifecycle(input.lifecycle, nodeIds, receiverNodeId);
  const authorizationChecks = validateAuthorizationChecks(
    input.authorizationChecks,
    nodeIds,
  );
  const rpcUsage = validateRpcUsage(input.rpcUsage);
  const timing = validateTiming(input.timing);

  return Object.freeze({
    schema: CONFIG_SCHEMA,
    expectedCommit: input.expectedCommit.toLowerCase(),
    nodes: Object.freeze(nodes),
    contextGraphs: Object.freeze(contextGraphs),
    lifecycle,
    authorizationChecks,
    rpcUsage,
    timing,
  });
}

/** A network-free plan. It deliberately does not read auth or evidence files. */
export function createRemoteCanaryDryRunArtifactV1(config, now = () => new Date()) {
  const validated = validateRemoteCanaryConfigV1(config);
  return Object.freeze({
    schema: ARTIFACT_SCHEMA,
    status: 'DRY_RUN',
    phase: 'planned',
    startedAt: now().toISOString(),
    finishedAt: now().toISOString(),
    expectedCommit: validated.expectedCommit,
    topology: redactedTopology(validated),
    plan: Object.freeze({
      preflight: 'exact-build-network-sync-and-catalog-mode',
      liveSwmPropagationChecks: validated.contextGraphs.length,
      offlineCatchup: validated.lifecycle === null ? 'EVIDENCE_REQUIRED' : 'PLANNED',
      vmParityChecks: validated.contextGraphs.length,
      authorization: authorizationPlan(validated.authorizationChecks),
      rpcUsage: validated.rpcUsage.kind === 'required' ? 'EVIDENCE_REQUIRED' : 'PLANNED',
    }),
  });
}

/**
 * Execute one bounded certification run. Raw responses, URLs, credentials,
 * commands, CG ids, peer ids, and query text never enter the returned artifact.
 */
export async function executeRemoteCanaryCertificationV1(config, dependencies = {}) {
  const validated = validateRemoteCanaryConfigV1(config);
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') invalid('fetch-unavailable');
  const readFileFn = dependencies.readFileFn ?? readFile;
  const runCommand = dependencies.runCommand ?? runBoundedCommandV1;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? (() => new Date());
  const secrets = new Map();
  const nodeById = new Map(validated.nodes.map((node) => [node.id, node]));
  const nodeRefs = createNodeRefs(validated.nodes);
  const request = createRequester({ fetchFn, readFileFn, secrets, timing: validated.timing });
  const startedAt = now().toISOString();
  let phase = 'preflight';

  try {
    const preflightStatuses = await preflightAllNodes({
      config: validated,
      request,
      nodeRefs,
    });

    phase = 'live-swm-propagation';
    const liveSwmPropagation = [];
    for (const contextGraph of validated.contextGraphs) {
      const marker = createMarker();
      const source = nodeById.get(contextGraph.sourceNodeId);
      const receiver = nodeById.get(contextGraph.receiverNodeId);
      await shareMarker(source, contextGraph.id, marker, request);
      await pollUntil(
        async () => askMarker(receiver, contextGraph.id, marker, 'shared-working-memory', request),
        validated.timing.propagationTimeoutMs,
        validated.timing.pollIntervalMs,
        sleep,
        'swm-propagation-timeout',
        phase,
      );
      liveSwmPropagation.push(Object.freeze({
        contextGraphRef: opaqueRef('cg', contextGraph.id),
        markerRef: opaqueRef('marker', marker.subject),
        status: 'PASS',
      }));
    }

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
    const vmParity = [];
    for (const contextGraph of validated.contextGraphs) {
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
          askConfiguredVmQuery(node, contextGraph, request)
        )));
        if (!queryPassed.every(Boolean)) throw failure('vm-query-parity-failed', phase);
      }
      vmParity.push(Object.freeze({
        contextGraphRef: opaqueRef('cg', contextGraph.id),
        status: contextGraph.vmAskSparql === undefined ? 'EVIDENCE_REQUIRED' : 'PASS',
        statusParity: 'PASS',
        cursorPresent: parity.cursorPresent,
        digestParity: parity.digestParity,
        rowCountParity: parity.rowCountParity,
        vmQueryChecked: contextGraph.vmAskSparql !== undefined,
        ...(contextGraph.vmAskSparql === undefined
          ? { requirement: 'vm-ask-query' }
          : {}),
      }));
    }

    phase = 'authorization';
    const authorization = Object.freeze({
      unauthorized: await runAuthorizationCheck(
        validated.authorizationChecks.unauthorized,
        nodeById,
        request,
      ),
      revoked: await runAuthorizationCheck(
        validated.authorizationChecks.revoked,
        nodeById,
        request,
      ),
    });

    phase = 'rpc-usage';
    const rpcUsage = await collectRpcUsageEvidence(
      validated.rpcUsage,
      { readFileFn, runCommand },
    );

    const incomplete = offlineCatchup.status !== 'PASS'
      || vmParity.some((entry) => entry.status !== 'PASS')
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
      topology: redactedTopology(validated),
      preflight: Object.freeze({ status: 'PASS', nodes: preflightStatuses }),
      checks: Object.freeze({
        liveSwmPropagation: Object.freeze(liveSwmPropagation),
        offlineCatchup,
        vmParity: Object.freeze(vmParity),
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

/** Atomically replace prior results; a stale PASS cannot survive a new run. */
export async function runRemoteCanaryArtifactLifecycleV1({
  config,
  artifactPath,
  dryRun = false,
  dependencies = {},
}) {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  await writeArtifactAtomicV1(artifactPath, {
    schema: ARTIFACT_SCHEMA,
    status: 'INCOMPLETE',
    phase: 'starting',
    startedAt,
  });
  try {
    const artifact = dryRun
      ? createRemoteCanaryDryRunArtifactV1(config, now)
      : await executeRemoteCanaryCertificationV1(config, { ...dependencies, now });
    await writeArtifactAtomicV1(artifactPath, artifact);
    return artifact;
  } catch (error) {
    const failed = Object.freeze({
      schema: ARTIFACT_SCHEMA,
      status: 'FAIL',
      phase: error instanceof RemoteCanaryError ? error.phase : 'failed',
      startedAt,
      finishedAt: now().toISOString(),
      failure: Object.freeze({
        code: error instanceof RemoteCanaryError
          ? error.code
          : 'unexpected-execution-failure',
      }),
    });
    try {
      await writeArtifactAtomicV1(artifactPath, failed);
    } catch (artifactError) {
      throw new AggregateError([error, artifactError], 'certificate-and-artifact-write-failed');
    }
    throw error;
  }
}

export async function writeArtifactAtomicV1(artifactPath, artifact) {
  const directory = dirname(artifactPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${stableJson(artifact)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
      flag: 'wx',
    });
    await rename(temporaryPath, artifactPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function runBoundedCommandV1(command, timeoutMs = 60_000) {
  validateCommand(command, 'runtime-command');
  const [file, ...args] = command.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    let terminationError = null;
    let killTimer;
    const terminate = (error) => {
      if (terminationError !== null) return;
      terminationError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const timer = setTimeout(() => {
      terminate(failure('command-timeout', 'command'));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES) {
        terminate(failure('command-output-too-large', 'command'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminate(failure('command-output-too-large', 'command'));
      }
    });
    child.once('error', () => finish(failure('command-start-failed', 'command')));
    child.once('exit', (code, signal) => {
      finish(terminationError, Object.freeze({ code, signal, stdout }));
    });
  });
}

async function preflightAllNodes({ config, request, nodeRefs }) {
  const raw = new Map();
  for (const node of config.nodes) {
    const status = await request.json(node, 'GET', '/api/status');
    validateNodePreflight(status, node, config);
    raw.set(node.id, status);
  }
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
      }))),
    });
  }));
}

function validateNodePreflight(status, node, config) {
  assertRecord(status, 'status', 'preflight-status-malformed');
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
  ) {
    throw failure('chain-rpc-not-configured', 'preflight');
  }
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
  }
}

async function verifyOfflineCatchup({
  config,
  lifecycle,
  nodeById,
  request,
  runCommand,
  sleep,
}) {
  const receiver = nodeById.get(lifecycle.receiverNodeId);
  let stopInvoked = false;
  let primaryFailure = null;
  let startFailure = null;
  const markers = [];
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
    for (const contextGraph of config.contextGraphs) {
      const marker = createMarker();
      markers.push([contextGraph, marker]);
      await shareMarker(
        nodeById.get(contextGraph.sourceNodeId),
        contextGraph.id,
        marker,
        request,
      );
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (stopInvoked) {
      const started = await runCommand(lifecycle.start, lifecycle.commandTimeoutMs)
        .catch(() => null);
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

  const evidence = [];
  for (const [contextGraph, marker] of markers) {
    await pollUntil(
      async () => askMarker(
        receiver,
        contextGraph.id,
        marker,
        'shared-working-memory',
        request,
      ),
      config.timing.catchupTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      'offline-catchup-timeout',
      'offline-catchup',
    );
    evidence.push(Object.freeze({
      contextGraphRef: opaqueRef('cg', contextGraph.id),
      markerRef: opaqueRef('marker', marker.subject),
      status: 'PASS',
    }));
  }
  return Object.freeze({ status: 'PASS', receiverCount: 1, contextGraphs: evidence });
}

async function shareMarker(node, contextGraphId, marker, request) {
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
  if (result.swmShared !== true) throw failure('swm-share-not-confirmed', 'live-swm-propagation');
}

async function askMarker(node, contextGraphId, marker, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql: `ASK { <${marker.subject}> <${marker.predicate}> ${JSON.stringify(marker.value)} . }`,
    contextGraphId,
    view,
  });
  return result.result?.type === 'boolean' && result.result.value === true;
}

async function askConfiguredVmQuery(node, contextGraph, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql: contextGraph.vmAskSparql,
    contextGraphId: contextGraph.id,
    view: 'verifiable-memory',
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
  const keys = [
    'appliedCatalogHeadDigest',
    'appliedInventoryDigest',
    'appliedRowCount',
    'catalogVersion',
  ];
  if (!keys.every((key) => sourceOperational[key] === receiverOperational[key])) return false;
  return Object.freeze({
    cursorPresent: true,
    digestParity: true,
    rowCountParity: true,
  });
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
    return Object.freeze({
      status: 'EVIDENCE_REQUIRED',
      reasonCode: check.reasonCode,
    });
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
    const body = await parseResponseJson(response, 'authorization-response-malformed');
    const code = jsonPointer(body, check.bodyCodePointer);
    if (!check.expectedCodes.includes(code)) {
      throw failure('authorization-denial-code-mismatch', 'authorization');
    }
  }
  return Object.freeze({ status: 'PASS', denialObserved: true });
}

async function collectRpcUsageEvidence(config, { readFileFn, runCommand }) {
  if (config.kind === 'required') {
    return Object.freeze({
      status: 'EVIDENCE_REQUIRED',
      requirement: RPC_EVIDENCE_SCHEMA,
      acceptedSources: Object.freeze(['evidence-file', 'command']),
    });
  }
  let text;
  if (config.kind === 'evidence-file') {
    text = await readFileFn(config.path, 'utf8').catch(() => {
      throw failure('rpc-evidence-read-failed', 'rpc-usage');
    });
  } else {
    const result = await runCommand(config.command, config.commandTimeoutMs);
    if (result.code !== 0) throw failure('rpc-evidence-command-failed', 'rpc-usage');
    text = result.stdout;
  }
  if (Buffer.byteLength(text) > MAX_COMMAND_OUTPUT_BYTES) {
    throw failure('rpc-evidence-too-large', 'rpc-usage');
  }
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch {
    throw failure('rpc-evidence-malformed', 'rpc-usage');
  }
  const samples = validateRpcEvidence(evidence, config.minimumSamples);
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
    sampleCount: samples.length,
    measuredSeconds: durationSeconds,
    total,
    requestsPerMinute: durationSeconds === 0 ? 0 : round(total * 60 / durationSeconds),
    byMethod: Object.freeze(Object.fromEntries(Object.entries(byMethod).sort())),
  });
}

function validateRpcEvidence(evidence, minimumSamples = 1) {
  assertRecord(evidence, 'rpc-evidence', 'rpc-evidence-malformed');
  exactKeys(evidence, ['schema', 'scope', 'samples'], 'rpc-evidence', 'rpc-evidence-malformed');
  if (
    evidence.schema !== RPC_EVIDENCE_SCHEMA
    || evidence.scope !== 'certified-cohort'
    || !Array.isArray(evidence.samples)
  ) {
    throw failure('rpc-evidence-malformed', 'rpc-usage');
  }
  if (evidence.samples.length < (minimumSamples ?? 1) || evidence.samples.length > 1440) {
    throw failure('rpc-evidence-sample-count', 'rpc-usage');
  }
  let precedingEnd = -Infinity;
  return evidence.samples.map((sample) => {
    assertRecord(sample, 'rpc-sample', 'rpc-evidence-malformed');
    exactKeys(
      sample,
      ['windowStartedAt', 'windowEndedAt', 'total', 'byMethod'],
      'rpc-sample',
      'rpc-evidence-malformed',
    );
    const start = canonicalInstant(sample.windowStartedAt);
    const end = canonicalInstant(sample.windowEndedAt);
    const durationMs = end - start;
    if (durationMs < 45_000 || durationMs > 75_000 || start < precedingEnd) {
      throw failure('rpc-evidence-window-not-minutely', 'rpc-usage');
    }
    precedingEnd = end;
    if (!Number.isSafeInteger(sample.total) || sample.total < 0) {
      throw failure('rpc-evidence-count-invalid', 'rpc-usage');
    }
    assertRecord(sample.byMethod, 'rpc-sample.byMethod', 'rpc-evidence-malformed');
    let methodTotal = 0;
    for (const [method, count] of Object.entries(sample.byMethod)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/u.test(method)) {
        throw failure('rpc-evidence-method-invalid', 'rpc-usage');
      }
      if (!Number.isSafeInteger(count) || count < 0) {
        throw failure('rpc-evidence-count-invalid', 'rpc-usage');
      }
      methodTotal += count;
    }
    if (methodTotal !== sample.total) throw failure('rpc-evidence-total-mismatch', 'rpc-usage');
    return sample;
  });
}

function createRequester({ fetchFn, readFileFn, secrets, timing }) {
  async function authorization(node, override = 'node') {
    if (override === 'none' || node.auth.kind === 'none') return {};
    let secret = secrets.get(node.id);
    if (secret === undefined) {
      let secretText;
      try {
        secretText = await readFileFn(node.auth.secretFile, 'utf8');
      } catch (error) {
        throw failure('auth-secret-read-failed', 'authentication', error);
      }
      secret = secretText.trim();
      if (secret.length < 1 || secret.length > 4096 || /[\r\n]/u.test(secret)) {
        throw failure('auth-secret-malformed', 'authentication');
      }
      secrets.set(node.id, secret);
    }
    return { Authorization: `Bearer ${secret}` };
  }
  async function raw(node, method, path, body, authOverride = 'node') {
    const url = safeNodeUrl(node.baseUrl, path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timing.requestTimeoutMs);
    try {
      return await fetchFn(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...await authorization(node, authOverride),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw failure('node-request-failed', 'http', error);
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    raw,
    async json(node, method, path, body) {
      const response = await raw(node, method, path, body);
      if (response.status < 200 || response.status >= 300) {
        throw failure('node-http-status-failed', 'http');
      }
      return parseResponseJson(response, 'node-json-malformed');
    },
    async reachable(node) {
      try {
        await raw(node, 'HEAD', '/api/status');
        return true;
      } catch {
        return false;
      }
    },
  });
}

async function parseResponseJson(response, code) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_HTTP_BODY_BYTES) throw failure('node-response-too-large', 'http');
  try {
    return JSON.parse(text);
  } catch {
    throw failure(code, 'http');
  }
}

async function pollUntil(check, timeoutMs, intervalMs, sleep, code, phase) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const result = await check();
      if (result) return result;
    } catch {
      // A bounded polling check treats transient request failures as not ready.
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw failure(code, phase);
}

function validateNode(node, index, nodeIds) {
  assertRecord(node, `nodes[${index}]`);
  exactKeys(node, ['id', 'role', 'baseUrl', 'auth', 'allowTailscaleHttp'], `nodes[${index}]`);
  if (typeof node.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(node.id)) invalid('node-id');
  if (nodeIds.has(node.id)) invalid('duplicate-node-id');
  nodeIds.add(node.id);
  if (!['source', 'receiver', 'observer'].includes(node.role)) invalid('node-role');
  if (node.allowTailscaleHttp !== undefined && typeof node.allowTailscaleHttp !== 'boolean') {
    invalid('allow-tailscale-http-must-be-boolean');
  }
  const baseUrl = validateBaseUrl(node.baseUrl, node.allowTailscaleHttp === true);
  assertRecord(node.auth, `nodes[${index}].auth`);
  if (node.auth.kind === 'none') {
    exactKeys(node.auth, ['kind'], `nodes[${index}].auth`);
  } else if (node.auth.kind === 'bearer-file') {
    exactKeys(node.auth, ['kind', 'secretFile'], `nodes[${index}].auth`);
    if (typeof node.auth.secretFile !== 'string' || !isAbsolute(node.auth.secretFile)) {
      invalid('auth-secret-file-must-be-absolute');
    }
  } else invalid('node-auth-kind');
  return Object.freeze({ ...node, baseUrl, auth: Object.freeze({ ...node.auth }) });
}

function validateBaseUrl(value, allowTailscaleHttp) {
  if (typeof value !== 'string') invalid('node-base-url');
  let url;
  try { url = new URL(value); } catch { invalid('node-base-url'); }
  if (url.username || url.password || url.search || url.hash) invalid('node-base-url-credentials-or-query');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'https:'
    && !(url.protocol === 'http:' && (loopback || allowTailscaleHttp))
  ) {
    invalid('node-base-url-requires-https');
  }
  if (url.pathname !== '/' && url.pathname !== '') invalid('node-base-url-path');
  return url.origin;
}

function validateLifecycle(value, nodeIds, receiverNodeId) {
  assertRecord(value, 'lifecycle');
  exactKeys(value, [
    'receiverNodeId', 'stop', 'start', 'commandTimeoutMs', 'stopTimeoutMs', 'readyTimeoutMs',
  ], 'lifecycle');
  if (!nodeIds.has(value.receiverNodeId) || value.receiverNodeId !== receiverNodeId) {
    invalid('lifecycle-receiver-mismatch');
  }
  const stop = validateCommand(value.stop, 'lifecycle.stop');
  const start = validateCommand(value.start, 'lifecycle.start');
  return Object.freeze({
    receiverNodeId: value.receiverNodeId,
    stop,
    start,
    commandTimeoutMs: boundedInteger(value.commandTimeoutMs ?? 60_000, 1_000, 120_000),
    stopTimeoutMs: boundedInteger(value.stopTimeoutMs ?? 60_000, 1_000, 120_000),
    readyTimeoutMs: boundedInteger(value.readyTimeoutMs ?? 180_000, 1_000, 300_000),
  });
}

function validateAuthorizationChecks(value, nodeIds) {
  assertRecord(value, 'authorizationChecks');
  exactKeys(value, ['unauthorized', 'revoked'], 'authorizationChecks');
  return Object.freeze({
    unauthorized: validateAuthorizationCheck(value.unauthorized, 'unauthorized', nodeIds),
    revoked: validateAuthorizationCheck(value.revoked, 'revoked', nodeIds),
  });
}

function validateAuthorizationCheck(value, label, nodeIds) {
  assertRecord(value, `authorizationChecks.${label}`);
  if (value.kind === 'not-exposed') {
    exactKeys(value, ['kind', 'reasonCode'], `authorizationChecks.${label}`);
    const expected = label === 'unauthorized'
      ? 'catalog-protocol-api-not-exposed'
      : 'revocation-api-not-exposed';
    if (value.reasonCode !== expected) invalid('authorization-gap-reason');
    return Object.freeze({ ...value });
  }
  if (value.kind !== 'http') invalid('authorization-check-kind');
  exactKeys(value, [
    'kind', 'nodeId', 'method', 'path', 'authentication', 'body',
    'expectedStatuses', 'bodyCodePointer', 'expectedCodes',
  ], `authorizationChecks.${label}`);
  if (!nodeIds.has(value.nodeId)) invalid('authorization-node-reference');
  if (!['GET', 'POST'].includes(value.method)) invalid('authorization-method');
  if (typeof value.path !== 'string' || !value.path.startsWith('/api/')) {
    invalid('authorization-path');
  }
  if (value.path.includes('#') || value.path.startsWith('//')) invalid('authorization-path');
  if (value.method === 'POST' && value.path.split('?')[0] !== '/api/query') {
    invalid('authorization-post-must-be-read-only-query');
  }
  if (!['none', 'node'].includes(value.authentication)) invalid('authorization-auth-mode');
  if (value.body !== undefined) assertJsonData(value.body, 'authorization-body');
  if (
    !Array.isArray(value.expectedStatuses)
    || value.expectedStatuses.length < 1
    || !value.expectedStatuses.every((status) => DENIAL_STATUSES.has(status))
  ) invalid('authorization-statuses');
  if ((value.bodyCodePointer === undefined) !== (value.expectedCodes === undefined)) {
    invalid('authorization-code-pair');
  }
  if (value.bodyCodePointer !== undefined) {
    if (typeof value.bodyCodePointer !== 'string' || !value.bodyCodePointer.startsWith('/')) {
      invalid('authorization-code-pointer');
    }
    if (
      !Array.isArray(value.expectedCodes)
      || value.expectedCodes.length < 1
      || !value.expectedCodes.every((entry) => typeof entry === 'string' && entry.length <= 128)
    ) invalid('authorization-expected-codes');
  }
  return Object.freeze({
    ...value,
    expectedStatuses: Object.freeze([...new Set(value.expectedStatuses)]),
    ...(value.expectedCodes === undefined
      ? {}
      : { expectedCodes: Object.freeze([...new Set(value.expectedCodes)]) }),
  });
}

function validateRpcUsage(value) {
  assertRecord(value, 'rpcUsage');
  if (value.kind === 'required') {
    exactKeys(value, ['kind'], 'rpcUsage');
    return Object.freeze({ kind: 'required' });
  }
  if (value.kind === 'evidence-file') {
    exactKeys(value, ['kind', 'path', 'minimumSamples'], 'rpcUsage');
    if (typeof value.path !== 'string' || !isAbsolute(value.path)) {
      invalid('rpc-evidence-path-must-be-absolute');
    }
    return Object.freeze({
      kind: value.kind,
      path: value.path,
      minimumSamples: boundedInteger(value.minimumSamples ?? 1, 1, 1440),
    });
  }
  if (value.kind === 'command') {
    exactKeys(value, ['kind', 'command', 'minimumSamples', 'commandTimeoutMs'], 'rpcUsage');
    return Object.freeze({
      kind: value.kind,
      command: validateCommand(value.command, 'rpcUsage.command'),
      minimumSamples: boundedInteger(value.minimumSamples ?? 1, 1, 1440),
      commandTimeoutMs: boundedInteger(value.commandTimeoutMs ?? 60_000, 1_000, 120_000),
    });
  }
  invalid('rpc-usage-kind');
}

function validateCommand(value, field) {
  assertRecord(value, field);
  exactKeys(value, ['argv'], field);
  if (
    !Array.isArray(value.argv)
    || value.argv.length < 1
    || value.argv.length > 64
    || !value.argv.every((arg) => typeof arg === 'string' && arg.length >= 1 && arg.length <= 4096)
  ) invalid('command-argv');
  for (const arg of value.argv) {
    if (
      /^Bearer\s/iu.test(arg)
      || /:\/\/[^/@:]+:[^/@]+@/u.test(arg)
      || /^--?(?:password|token|api[-_]?key|secret)(?:=|$)/iu.test(arg)
    ) invalid('inline-command-secret-rejected');
  }
  return Object.freeze({ argv: Object.freeze([...value.argv]) });
}

function validateTiming(value) {
  if (value === undefined) return DEFAULT_TIMING;
  assertRecord(value, 'timing');
  exactKeys(value, Object.keys(DEFAULT_TIMING), 'timing');
  return Object.freeze({
    requestTimeoutMs: boundedInteger(value.requestTimeoutMs ?? 10_000, 1_000, 60_000),
    pollIntervalMs: boundedInteger(value.pollIntervalMs ?? 2_000, 250, 30_000),
    propagationTimeoutMs: boundedInteger(value.propagationTimeoutMs ?? 120_000, 1_000, 300_000),
    catchupTimeoutMs: boundedInteger(value.catchupTimeoutMs ?? 240_000, 1_000, 600_000),
    parityTimeoutMs: boundedInteger(value.parityTimeoutMs ?? 120_000, 1_000, 300_000),
  });
}

function validateAskSparql(value) {
  boundedString(value, 1, 32768, 'vm-ask-sparql');
  if (!/\bASK\b/iu.test(value)) invalid('vm-query-must-be-ask');
  if (/\b(?:INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|MOVE|COPY|ADD|WITH)\b/iu.test(value)) {
    invalid('vm-query-must-be-read-only');
  }
}

function safeNodeUrl(baseUrl, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw failure('unsafe-node-path', 'http');
  }
  const base = new URL(baseUrl);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin || resolved.username || resolved.password || resolved.hash) {
    throw failure('unsafe-node-path', 'http');
  }
  return resolved;
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
    lifecycleReceiverCount: config.lifecycle === null ? 0 : 1,
  });
}

function authorizationPlan(checks) {
  return Object.freeze(Object.fromEntries(Object.entries(checks).map(([key, value]) => [
    key,
    value.kind === 'http' ? 'PLANNED' : 'EVIDENCE_REQUIRED',
  ])));
}

function createNodeRefs(nodes) {
  const counts = new Map();
  return new Map(nodes.map((node) => {
    const ordinal = (counts.get(node.role) ?? 0) + 1;
    counts.set(node.role, ordinal);
    return [node.id, `${node.role}-${ordinal}`];
  }));
}

function createMarker() {
  const nonce = randomUUID();
  return Object.freeze({
    assetName: `rfc64-canary-${nonce.replaceAll('-', '')}`,
    subject: `urn:dkg:rfc64-canary:${nonce}`,
    predicate: 'urn:dkg:rfc64-canary:marker',
    value: nonce,
  });
}

function opaqueRef(namespace, value) {
  return `${namespace}-${createHash('sha256').update(`${namespace}\0${value}`).digest('hex').slice(0, 16)}`;
}

function canonicalChainId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && /^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(value)) return value.toLowerCase();
  throw failure('chain-id-malformed', 'preflight');
}

function jsonPointer(value, pointer) {
  let cursor = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (cursor === null || typeof cursor !== 'object' || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function assertJsonData(value, field, seen = new Set()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (typeof value !== 'object' || seen.has(value)) invalid(field);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonData(item, field, seen);
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (/password|token|authorization|api[-_]?key|secret/iu.test(key)) {
        invalid('inline-authorization-secret-rejected');
      }
      assertJsonData(item, field, seen);
    }
  }
  seen.delete(value);
}

function assertRecord(value, field, code = 'invalid-config') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (code === 'invalid-config') invalid(field);
    throw failure(code, code.startsWith('rpc-') ? 'rpc-usage' : 'validation');
  }
}

function exactKeys(value, allowed, field, code = 'invalid-config') {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    if (code === 'invalid-config') invalid(`${field}-unknown-field`);
    throw failure(code, code.startsWith('rpc-') ? 'rpc-usage' : 'validation');
  }
}

function boundedString(value, minimum, maximum, field) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid(field);
  return value;
}

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid('bounded-integer');
  return value;
}

function canonicalInstant(value) {
  if (typeof value !== 'string') throw failure('rpc-evidence-time-invalid', 'rpc-usage');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw failure('rpc-evidence-time-invalid', 'rpc-usage');
  }
  return timestamp;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function invalid(code) {
  throw failure(code, 'validation');
}

function failure(code, phase, cause) {
  return new RemoteCanaryError(code, phase, cause === undefined ? {} : { cause });
}
