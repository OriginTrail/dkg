// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  createFinalizedChainFixture,
} from './fixture.mjs';
import { initializeRfc64PrivateAuthorityStateV1 } from './finalized-chain-fixture.mjs';
import {
  createGateCommandFailureV1,
  sanitizeGateFailureV1,
} from './gate-artifact.mjs';
import {
  createRfc64PrivateRuntimeEvidenceCollectorV1,
} from './runtime-provenance.mjs';
import { buildRfc64PrivateReleaseArtifactV1 } from './scenario-artifact.mjs';
import {
  hasExactMemoryContents,
  hasExactSourceSwmContents,
} from './scenario-artifact.mjs';
import {
  RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1,
  childCommandDescriptorV1,
} from './child-protocol.mjs';
import {
  RFC64_PRIVATE_PROBE_ACTORS_V1,
  RFC64_PRIVATE_RUNTIME_ROLES_V1,
} from './scenario-actors.ts';

export {
  RFC64_PRIVATE_GATE_RPC_BUDGET_V1,
  isWithinRpcBudgetV1,
  isWithinRpcCeilingV1,
  rpcEvidenceV1,
} from './rpc-evidence.mjs';
export {
  EXPECTED_MEMORY_CONTENTS,
  hasExactMemoryContents,
  hasExactSourceSwmContents,
} from './scenario-artifact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(HERE, '..', '..');
const AGENT_PROCESS = join(HERE, 'agent-process.mjs');
const RUNTIME_LOAD_HOOK = resolve(
  HERE,
  '../../../../devnet/rfc64-runtime-load-hook.mts',
);
export const RFC64_PRIVATE_GATE_ARTIFACT_PATH = join(HERE, 'artifacts', 'latest.json');
const RUN_TIMEOUT_MS = 90_000;
let requestSequence = 0;
let lifecycleSequence = 0;

export class AgentChild {
  constructor(role, dataDir, manifestPath, mode = 'run', options = {}) {
    this.role = role;
    this.spawnSequence = ++lifecycleSequence;
    this.spawnedAt = new Date().toISOString();
    this.events = [];
    this.waiters = [];
    this.exited = false;
    this.stopTimeouts = Object.freeze({
      // The provenance-bearing acknowledgement is emitted only after the
      // real agent and its bootstrap workers stop, which can include a
      // bounded in-flight peer-resolution timeout.
      handshake: options.stopHandshakeTimeoutMs ?? 30_000,
      gracefulExit: options.gracefulExitTimeoutMs ?? 10_000,
      sigtermExit: options.sigtermExitTimeoutMs ?? 5_000,
      sigkillExit: options.sigkillExitTimeoutMs ?? 5_000,
    });
    const runtimeProvenance = options.runtimeProvenance;
    const childEnv = { ...process.env };
    if (runtimeProvenance !== undefined) {
      delete childEnv.NODE_OPTIONS;
      delete childEnv.NODE_PATH;
      delete childEnv.TSX_TSCONFIG_PATH;
    }
    const agentProcess = options.agentProcess ?? AGENT_PROCESS;
    const args = runtimeProvenance === undefined
      ? [agentProcess]
      : ['--import', 'tsx', '--import', RUNTIME_LOAD_HOOK, agentProcess];
    this.proc = spawn(process.execPath, args, {
      cwd: options.agentRoot ?? AGENT_ROOT,
      env: {
        ...childEnv,
        ...boundedChildEnvironmentV1(options.childEnvironment),
        NODE_ENV: 'production',
        DKG_RFC64_PRIVATE_ROLE: role,
        DKG_RFC64_PRIVATE_MODE: mode,
        DKG_RFC64_PRIVATE_DATA_DIR: dataDir,
        ...(manifestPath === undefined ? {} : {
          DKG_RFC64_PRIVATE_MANIFEST: manifestPath,
        }),
        ...(runtimeProvenance === undefined ? {} : {
          DKG_RFC64_RUNTIME_MANIFEST_DIGEST:
            runtimeProvenance.runtimeManifestDigest,
          DKG_RFC64_RUNTIME_SOURCE_COMMIT: runtimeProvenance.sourceRevision,
        }),
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const marker = 'RFC64_PRIVATE_EVENT ';
      if (!line.startsWith(marker)) return;
      const event = JSON.parse(line.slice(marker.length));
      this.events.push(event);
      for (const waiter of this.waiters.slice()) {
        if (
          waiter.event === event.event
          && (waiter.requestId === undefined || waiter.requestId === event.requestId)
        ) {
          waiter.resolve(event);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
        } else if (
          event.event === 'command-error'
          && waiter.requestId !== undefined
          && waiter.requestId === event.requestId
        ) {
          waiter.reject(createGateCommandFailureV1(
            waiter.event,
            new Error(`${role}: ${event.message}`),
          ));
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
        } else if (event.event === 'boot-failed') {
          waiter.reject(new Error(`${role}: ${event.message}`));
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
        }
      }
    });
    this.exit = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        this.exited = true;
        this.exitSequence = ++lifecycleSequence;
        this.exitedAt = new Date().toISOString();
        resolve({ ...result, exitedAt: this.exitedAt });
      };
      this.proc.once('error', (error) => {
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
        finish({ code: null, signal: null, error });
      });
      this.proc.once('exit', (code, signal) => {
        if (code !== 0 && signal !== 'SIGTERM') {
          const error = new Error(`${role}: process exited with ${code ?? signal}`);
          for (const waiter of this.waiters.splice(0)) waiter.reject(error);
          finish({ code, signal, error });
          return;
        }
        finish({ code, signal, error: null });
      });
    });
  }

  waitFor(event, { requestId, timeoutMs = RUN_TIMEOUT_MS } = {}) {
    const existing = this.events.find((item) => (
      item.event === event && (requestId === undefined || item.requestId === requestId)
    ));
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`${this.role}: timed out waiting for ${event}`));
      }, timeoutMs);
      const waiter = {
        event,
        requestId,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.waiters.push(waiter);
    });
  }

  async request(cmd, options = {}) {
    const descriptor = childCommandDescriptorV1(cmd);
    const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
    const requestId = `${this.role}-${++requestSequence}`;
    this.proc.stdin.write(`${JSON.stringify({ ...cmd, requestId })}\n`);
    return this.waitFor(descriptor.responseEvent, { requestId, timeoutMs });
  }

  async stop() {
    if (this.shutdownReceipt !== undefined) return this.shutdownReceipt;
    if (this.exited) {
      const exit = await this.exit;
      if (exit.error !== null) throw exit.error;
      throw new Error(`${this.role}: process exited without a runtime-evidence shutdown receipt`);
    }
    let handshakeFailure = null;
    let executedRuntimeManifest;
    let stoppedEvent;
    try {
      stoppedEvent = await this.request(
        { cmd: 'stop' },
        { timeoutMs: this.stopTimeouts.handshake },
      );
      executedRuntimeManifest = requiredExecutedRuntimeManifest(stoppedEvent, this.role);
    } catch (error) {
      handshakeFailure = error;
    }
    if (handshakeFailure !== null) {
      let forcedExit;
      try {
        forcedExit = await this.forceStop();
      } catch (terminationFailure) {
        throw new AggregateError(
          [handshakeFailure, terminationFailure],
          `${this.role}: stop handshake and forced termination failed`,
        );
      }
      throw forcedExit.error === null
        ? new Error(
          `${this.role}: stop handshake failed; forced process exit completed`,
          { cause: handshakeFailure },
        )
        : new AggregateError(
          [handshakeFailure, forcedExit.error],
          `${this.role}: stop handshake failed; forced process exit completed`,
        );
    }
    let result = this.exited
      ? await this.exit
      : await waitForExit(this.exit, this.stopTimeouts.gracefulExit);
    if (result === null) result = await this.forceStop();
    if (result.error !== null) throw result.error;
    this.shutdownReceipt = Object.freeze({
      exit: Object.freeze(result),
      executedRuntimeManifest,
      rpcCallCounts: requiredRpcCallCounts(stoppedEvent, this.role),
    });
    return this.shutdownReceipt;
  }

  /** Bounded process reaping for failures that cannot produce provenance. */
  async forceStop() {
    if (this.exited) return this.exit;
    this.proc.kill('SIGTERM');
    let result = await waitForExit(this.exit, this.stopTimeouts.sigtermExit);
    if (result === null) {
      this.proc.kill('SIGKILL');
      result = await waitForExit(this.exit, this.stopTimeouts.sigkillExit);
    }
    if (result === null) {
      throw new Error(`${this.role}: process did not exit after bounded SIGTERM and SIGKILL`);
    }
    return result;
  }
}

export async function executeRfc64PrivateReleaseGateV1({
  childEnvironment,
  createProbeChild = (...args) => new AgentChild(...args),
  probeReadyTimeoutMs = RUN_TIMEOUT_MS,
  runtimeManifest,
  sourceRevision,
}) {
  if (runtimeManifest?.sourceCommit !== sourceRevision) {
    throw new Error('RFC-64 private gate runtime manifest does not bind its source revision');
  }
  const runtimeProvenance = Object.freeze({
    runtimeManifestDigest: runtimeManifest.manifestDigest,
    sourceRevision,
  });
  const runtimeEvidence = createRfc64PrivateRuntimeEvidenceCollectorV1(runtimeManifest);
  const runRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-private-release-gate-'));
  const authorityStatePath = join(runRoot, 'authority.json');
  const manifestPath = join(runRoot, 'manifest.json');
  const dataDirs = Object.fromEntries(
    RFC64_PRIVATE_RUNTIME_ROLES_V1.map((role) => [role, join(runRoot, role)]),
  );
  const scenario = new PrivateReleaseScenarioContext({
    childEnvironment,
    createProbeChild,
    dataDirs,
    manifestPath,
    probeReadyTimeoutMs,
    runtimeEvidence,
    runtimeProvenance,
  });
  let artifact;
  try {
    await Promise.all(Object.values(dataDirs).map((path) => mkdir(path, { recursive: true })));
    await initializeRfc64PrivateAuthorityStateV1(
      authorityStatePath,
      createFinalizedChainFixture(),
    );
    const probed = await scenario.probeRoles();
    const peerIds = Object.fromEntries(RFC64_PRIVATE_RUNTIME_ROLES_V1.map(
      (role) => [role, probed[role].ready.peerId],
    ));
    scenario.bindPeerIds(peerIds);
    await writeFile(
      manifestPath,
      `${JSON.stringify({ authorityStatePath, peerIds }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const baseline = await establishBaselineV1(scenario);
    const failover = await exerciseFailoverV1(scenario, baseline);
    const revocation = await exerciseRevocationV1(scenario, baseline, failover);
    await inspectRestartV1(scenario, baseline, failover, revocation);
    artifact = buildRfc64PrivateReleaseArtifactV1(
      scenario.sealEvidence(),
      runtimeManifest.manifestDigest,
    );
    const { status } = artifact;
    if (status !== 'PASS') process.exitCode = 1;
  } finally {
    // Any child still owned here is on a failure path and cannot contribute a
    // trustworthy shutdown receipt. Reap it directly instead of waiting for a
    // provenance handshake that may never have reached readiness.
    await scenario.forceStopAll();
    if (process.env.DKG_RFC64_PRIVATE_KEEP_RUN !== '1') {
      await rm(runRoot, { recursive: true, force: true });
    } else {
      process.stdout.write('RFC-64 private gate retained its local run directory.\n');
    }
  }
  return artifact;
}

class PrivateReleaseScenarioContext {
  constructor(options) {
    Object.assign(this, options);
    this.active = new Set();
    this.peerIds = null;
    this.processes = new Map();
    this.sealed = false;
  }

  bindPeerIds(peerIds) {
    if (this.peerIds !== null) throw new Error('private release peer identities already bound');
    this.peerIds = Object.freeze({ ...peerIds });
  }

  async probeRoles() {
    const entries = await Promise.all(RFC64_PRIVATE_PROBE_ACTORS_V1.map(async ({
      processId,
      role,
    }) => {
      const child = this.createProbeChild(
        role,
        this.dataDirs[role],
        undefined,
        'probe',
        { runtimeProvenance: this.runtimeProvenance },
      );
      this.active.add(child);
      let shutdownRecorded = false;
      try {
        const ready = await child.waitFor(
          RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready,
          { timeoutMs: this.probeReadyTimeoutMs },
        );
        assertReadyRuntimeManifest(ready, this.runtimeProvenance.runtimeManifestDigest);
        this.recordReady(processId, role, child, ready);
        await this.stop(child, processId);
        shutdownRecorded = true;
        return [role, { ready }];
      } finally {
        if (!shutdownRecorded) {
          await child.forceStop();
          this.active.delete(child);
        }
      }
    }));
    return Object.freeze(Object.fromEntries(entries));
  }

  async start(role, processId = role) {
    if (this.peerIds === null) throw new Error('private release peer identities are not bound');
    const child = new AgentChild(role, this.dataDirs[role], this.manifestPath, 'run', {
      runtimeProvenance: this.runtimeProvenance,
      childEnvironment: this.childEnvironment,
    });
    this.active.add(child);
    child.ready = await child.waitFor(RFC64_PRIVATE_CHILD_LIFECYCLE_EVENTS_V1.ready);
    assertReadyRuntimeManifest(child.ready, this.runtimeProvenance.runtimeManifestDigest);
    if (child.ready.peerId !== this.peerIds[role]) {
      throw new Error(`${role}: persisted peer identity changed after probe`);
    }
    this.recordReady(processId, role, child, child.ready);
    return child;
  }

  async stop(child, processId) {
    const shutdown = await child.stop();
    const process = this.requireProcess(processId);
    if (process.shutdown !== undefined) {
      throw new Error(`private release process already stopped: ${processId}`);
    }
    if (!Number.isSafeInteger(child.exitSequence) || child.exitSequence < 1) {
      throw new Error(`private release process has no valid exit sequence: ${processId}`);
    }
    process.exitSequence = child.exitSequence;
    process.shutdown = shutdown;
    this.runtimeEvidence.record(processId, shutdown);
    this.active.delete(child);
    return shutdown;
  }

  async forceStopAll() {
    await Promise.all([...this.active].map((child) => (
      child.forceStop().catch(() => undefined)
    )));
  }

  observe(processId, key, value) {
    const process = this.requireProcess(processId);
    if (Object.hasOwn(process.observations, key)) {
      throw new Error(`private release observation already recorded: ${processId}.${key}`);
    }
    process.observations[key] = value;
  }

  recordReady(processId, role, child, ready) {
    if (this.processes.has(processId)) {
      throw new Error(`private release process already recorded: ${processId}`);
    }
    this.processes.set(processId, {
      observations: {},
      processId,
      ready,
      role,
      spawnedAt: child.spawnedAt,
      spawnSequence: child.spawnSequence,
    });
  }

  requireProcess(processId) {
    const process = this.processes.get(processId);
    if (process === undefined) {
      throw new Error(`private release process is not recorded: ${processId}`);
    }
    return process;
  }

  sealEvidence() {
    if (this.sealed) throw new Error('private release scenario evidence already sealed');
    if (this.peerIds === null) throw new Error('private release peer identities are not bound');
    this.sealed = true;
    const processes = Object.fromEntries([...this.processes.entries()].map(([id, process]) => [
      id,
      Object.freeze({
        ...process,
        observations: Object.freeze({ ...process.observations }),
      }),
    ]));
    return Object.freeze({
      peerIds: this.peerIds,
      processes: Object.freeze(processes),
      runtimeProvenance: this.runtimeEvidence.seal(),
    });
  }
}

async function establishBaselineV1(scenario) {
  const owner = await scenario.start('owner', 'owner');
  const baseline = await owner.request({ cmd: 'publish' });
  scenario.observe('owner', 'baseline', baseline);
  const provider2 = await scenario.start('provider2', 'provider2');
  await connectBothWays(owner, provider2);
  await provider2.request({
    cmd: 'wait-bootstrap',
    expectedHeadDigest: baseline.headObjectDigest,
    expectedMemory: 'finalized-vm-v1',
    timeoutMs: RUN_TIMEOUT_MS,
  }, { timeoutMs: RUN_TIMEOUT_MS + 10_000 });

  // Populate the receiver through a real authorized catalog sync while the
  // finalized VM and catalog both name v1. Its durable store then supplies
  // the positive older-VM proof required when the later SWM-v2 head arrives.
  const receiverSeed = await scenario.start('receiver', 'receiver-seed');
  await connectBothWays(provider2, receiverSeed);
  const receiverSeedBootstrap = await receiverSeed.request({
    cmd: 'wait-bootstrap',
    expectedHeadDigest: baseline.headObjectDigest,
    expectedMemory: 'finalized-vm-v1',
    timeoutMs: RUN_TIMEOUT_MS,
  }, { timeoutMs: RUN_TIMEOUT_MS + 10_000 });
  const receiverSeedState = await receiverSeed.request({
    cmd: 'inspect',
    expectedHeadDigest: baseline.headObjectDigest,
  });
  scenario.observe('receiver-seed', 'bootstrap', receiverSeedBootstrap);
  scenario.observe('receiver-seed', 'state', receiverSeedState);
  const receiverSeedShutdown = await scenario.stop(receiverSeed, 'receiver-seed');

  const published = await owner.request({ cmd: 'publish-update' });
  scenario.observe('owner', 'published', published);
  const provider2Bootstrap = await provider2.request({
    cmd: 'wait-bootstrap',
    expectedHeadDigest: published.headObjectDigest,
    timeoutMs: RUN_TIMEOUT_MS,
  }, { timeoutMs: RUN_TIMEOUT_MS + 10_000 });
  const provider2State = await provider2.request({
    cmd: 'inspect',
    expectedHeadDigest: published.headObjectDigest,
  });
  const ownerSourceState = await owner.request({
    cmd: 'inspect',
    expectedHeadDigest: published.headObjectDigest,
  });
  scenario.observe('provider2', 'bootstrap', provider2Bootstrap);
  scenario.observe('provider2', 'state', provider2State);
  scenario.observe('owner', 'sourceState', ownerSourceState);
  if (!hasExactSourceSwmContents(ownerSourceState)) {
    throw new Error(
      `owner: fixture source is missing the exact version-2 SWM head; `
      + `state=${JSON.stringify(safeMemorySummary(ownerSourceState))}`,
    );
  }
  return Object.freeze({
    baseline,
    owner,
    ownerSourceState,
    provider2,
    provider2Bootstrap,
    provider2State,
    published,
    receiverSeedBootstrap,
    receiverSeedReady: receiverSeed.ready,
    receiverSeedShutdown,
    receiverSeedState,
  });
}

async function exerciseFailoverV1(scenario, baseline) {
  const ownerShutdown = await scenario.stop(baseline.owner, 'owner');
  const ownerExit = ownerShutdown.exit;
  const ownerListenerClosed = await waitForTcpListenerClosed(baseline.owner.ready.multiaddr);
  if (!ownerListenerClosed) throw new Error('owner: listener remained dialable after process exit');
  const provider2ListenerDialable = await tcpListenerIsDialable(baseline.provider2.ready.multiaddr);
  if (!provider2ListenerDialable) {
    throw new Error('provider2: listener is not dialable after owner exit');
  }
  const provider2StateAfterOwnerExit = await baseline.provider2.request({
    cmd: 'inspect',
    expectedHeadDigest: baseline.published.headObjectDigest,
  });
  scenario.observe('owner', 'listenerClosed', ownerListenerClosed);
  scenario.observe('provider2', 'listenerDialableAfterOwnerExit', provider2ListenerDialable);
  scenario.observe('provider2', 'stateAfterOwnerExit', provider2StateAfterOwnerExit);
  if (
    provider2StateAfterOwnerExit.exactExpectedHead !== true
    || !hasExactMemoryContents(provider2StateAfterOwnerExit)
  ) {
    throw new Error(
      'provider2: exact head, SWM, or VM changed after owner exit; '
      + `before=${JSON.stringify(safeMemorySummary(baseline.provider2State))}; `
      + `after=${JSON.stringify(safeMemorySummary(provider2StateAfterOwnerExit))}`,
    );
  }

  const receiver = await scenario.start('receiver', 'receiver');
  await connectBothWays(baseline.provider2, receiver);
  const receiverBootstrap = await receiver.request({
    cmd: 'wait-bootstrap',
    expectedHeadDigest: baseline.published.headObjectDigest,
    timeoutMs: RUN_TIMEOUT_MS,
  }, { timeoutMs: RUN_TIMEOUT_MS + 10_000 });
  const receiverState = await receiver.request({
    cmd: 'inspect',
    expectedHeadDigest: baseline.published.headObjectDigest,
  });
  scenario.observe('receiver', 'bootstrap', receiverBootstrap);
  scenario.observe('receiver', 'state', receiverState);
  return Object.freeze({
    ownerExit,
    ownerListenerClosed,
    ownerShutdown,
    provider2ListenerDialable,
    provider2StateAfterOwnerExit,
    receiver,
    receiverBootstrap,
    receiverState,
  });
}

async function exerciseRevocationV1(scenario, baseline, failover) {
  const outsider = await scenario.start('outsider', 'outsider');
  await dial(outsider, baseline.provider2);
  const outsiderDenial = await outsider.request({
    cmd: 'sync-denied',
    providerPeerIds: [scenario.peerIds.provider2],
  });
  const outsiderState = await outsider.request({
    cmd: 'inspect',
    expectedHeadDigest: baseline.published.headObjectDigest,
  });
  const providerAccessState = await baseline.provider2.request({
    cmd: 'inspect',
    expectedHeadDigest: baseline.published.headObjectDigest,
  });
  scenario.observe('outsider', 'denial', outsiderDenial);
  scenario.observe('outsider', 'state', outsiderState);
  scenario.observe('provider2', 'accessState', providerAccessState);

  // Advance the provider's finalized authority high-water after the receiver
  // has proved it was previously authorized. The receiver deliberately keeps
  // its old local snapshot so its next pull reaches the serving-side gate.
  const ownerRevoker = await scenario.start('owner', 'owner-revoker');
  await connectBothWays(ownerRevoker, baseline.provider2);
  const ownerRevocation = await ownerRevoker.request({ cmd: 'revoke-receiver' });
  const receiverRevocation = await baseline.provider2.request({
    cmd: 'observe-receiver-revocation',
  });
  const revokedReceiverDenial = await failover.receiver.request({
    cmd: 'sync-denied',
    providerPeerIds: [scenario.peerIds.provider2],
  });
  const provider2StateAfterRevocation = await baseline.provider2.request({
    cmd: 'inspect',
    expectedHeadDigest: baseline.published.headObjectDigest,
  });
  const receiverStateAfterRevocation = await failover.receiver.request({
    cmd: 'inspect',
    expectedHeadDigest: baseline.published.headObjectDigest,
  });
  scenario.observe('owner-revoker', 'revocation', ownerRevocation);
  scenario.observe('provider2', 'revocationObservation', receiverRevocation);
  scenario.observe('provider2', 'stateAfterRevocation', provider2StateAfterRevocation);
  scenario.observe('receiver', 'revokedDenial', revokedReceiverDenial);
  scenario.observe('receiver', 'stateAfterRevocation', receiverStateAfterRevocation);
  const ownerRevokerShutdown = await scenario.stop(ownerRevoker, 'owner-revoker');
  return Object.freeze({
    outsider,
    outsiderDenial,
    outsiderState,
    ownerRevocation,
    ownerRevokerReady: ownerRevoker.ready,
    ownerRevokerShutdown,
    provider2StateAfterRevocation,
    providerAccessState,
    receiverRevocation,
    receiverStateAfterRevocation,
    revokedReceiverDenial,
  });
}

async function inspectRestartV1(scenario, baseline, failover, revocation) {
  const provider2Shutdown = await scenario.stop(baseline.provider2, 'provider2');
  const receiverShutdown = await scenario.stop(failover.receiver, 'receiver');
  const restartedReceiver = await scenario.start('receiver', 'receiver-restart');
  const restartState = await restartedReceiver.request({
    cmd: 'inspect-persisted',
    expectedHeadDigest: baseline.published.headObjectDigest,
  });
  scenario.observe('receiver-restart', 'state', restartState);
  const outsiderShutdown = await scenario.stop(revocation.outsider, 'outsider');
  const restartedReceiverShutdown = await scenario.stop(
    restartedReceiver,
    'receiver-restart',
  );
  return Object.freeze({
    outsiderShutdown,
    provider2Shutdown,
    receiverShutdown,
    restartState,
    restartedReceiverReady: restartedReceiver.ready,
    restartedReceiverShutdown,
  });
}

function boundedChildEnvironmentV1(value) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('RFC-64 private child environment must be an object');
  }
  const entries = Object.entries(value);
  const supportedKeys = new Set([
    'DKG_RFC64_PRIVATE_AUTHORITY_FAULT',
    'DKG_RFC64_PRIVATE_CATALOG_PROOF_FAULT',
  ]);
  if (entries.some(([key, entry]) => (
    !supportedKeys.has(key)
    || typeof entry !== 'string'
    || entry.length === 0
    || entry.length > 128
  ))) {
    throw new TypeError('RFC-64 private child environment contains an unsupported entry');
  }
  return Object.fromEntries(entries);
}

function assertReadyRuntimeManifest(ready, expectedDigest) {
  if (ready.runtimeBuildManifestDigest !== expectedDigest) {
    throw new Error(`${ready.role}: runtime build manifest differs from the clean build`);
  }
}

function requiredExecutedRuntimeManifest(event, label) {
  const manifest = event?.executedRuntimeManifest;
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${label}: child did not report executed runtime provenance`);
  }
  return manifest;
}

function requiredRpcCallCounts(event, label) {
  const counts = event?.rpcCallCounts;
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error(`${label}: child did not report final RPC accounting`);
  }
  const entries = Object.entries(counts);
  if (entries.some(([method, count]) => (
    method.length === 0
    || method.length > 128
    || !Number.isSafeInteger(count)
    || count < 0
  ))) {
    throw new Error(`${label}: child reported invalid final RPC accounting`);
  }
  return Object.freeze(Object.fromEntries(entries));
}

async function connectBothWays(left, right) {
  await Promise.all([dial(left, right), dial(right, left)]);
}

async function dial(from, to) {
  await from.request({
    cmd: 'dial',
    multiaddr: to.ready.multiaddr,
    peerId: to.ready.peerId,
  }, { timeoutMs: 30_000 });
}

function safeMemorySummary(state) {
  return Object.freeze({
    appliedHeadDigest: state.appliedHeadDigest,
    catalogVersion: state.catalogVersion,
    exactExpectedHead: state.exactExpectedHead,
    graphCounts: state.graphCounts,
    inventoryRowCount: state.inventoryRowCount,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(exit, timeoutMs) {
  return Promise.race([exit, delay(timeoutMs).then(() => null)]);
}

async function waitForTcpListenerClosed(multiaddr, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tcpListenerIsDialable(multiaddr))) return true;
    await delay(50);
  }
  return false;
}

async function tcpListenerIsDialable(multiaddr) {
  const endpoint = parseTcpMultiaddr(multiaddr);
  return new Promise((resolve) => {
    const socket = createConnection(endpoint);
    const finish = (dialable) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(dialable);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function parseTcpMultiaddr(value) {
  const match = /^\/ip4\/([^/]+)\/tcp\/(\d+)(?:\/|$)/u.exec(value);
  if (match === null) throw new Error(`unsupported local TCP multiaddr: ${value}`);
  return { host: match[1], port: Number(match[2]) };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failure = sanitizeGateFailureV1(new Error('clean-build launcher required'));
  process.stderr.write(
    `RFC-64 private release gate requires launch-live.ts (${failure.failureClass})\n`,
  );
  process.exitCode = 1;
}
