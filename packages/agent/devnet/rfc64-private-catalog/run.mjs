// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { assertGate2ExecutedRuntimeMatchesBuildV1 } from '../../../../devnet/rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';
import { PROJECTION_DIGEST, roleAgentAddress } from './fixture.mjs';
import { sanitizeGateFailureV1 } from './gate-artifact.mjs';
import { isExpectedPrivateCatalogDenialResultV1 } from './denial-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(HERE, '..', '..');
const AGENT_PROCESS = join(HERE, 'agent-process.mjs');
const RUNTIME_LOAD_HOOK = resolve(
  HERE,
  '../../../../devnet/rfc64-gate2-multi-asset-completeness/runtime-load-hook.ts',
);
export const RFC64_PRIVATE_GATE_ARTIFACT_PATH = join(HERE, 'artifacts', 'latest.json');
const ROLES = Object.freeze(['owner', 'provider2', 'receiver', 'outsider']);
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
        NODE_ENV: 'production',
        DKG_RFC64_PRIVATE_ROLE: role,
        DKG_RFC64_PRIVATE_MODE: mode,
        DKG_RFC64_PRIVATE_DATA_DIR: dataDir,
        ...(manifestPath === undefined ? {} : {
          DKG_RFC64_PRIVATE_MANIFEST: manifestPath,
        }),
        ...(runtimeProvenance === undefined ? {} : {
          DKG_RFC64_GATE2_RUNTIME_MANIFEST_DIGEST:
            runtimeProvenance.runtimeManifestDigest,
          DKG_RFC64_GATE2_RUNTIME_SOURCE_COMMIT: runtimeProvenance.sourceRevision,
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
          waiter.reject(new Error(`${role}: ${event.message}`));
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

  async request(cmd, expectedEvent, timeoutMs = RUN_TIMEOUT_MS) {
    const requestId = `${this.role}-${++requestSequence}`;
    this.proc.stdin.write(`${JSON.stringify({ ...cmd, requestId })}\n`);
    return this.waitFor(expectedEvent, { requestId, timeoutMs });
  }

  async stop() {
    if (this.exited) return this.exit;
    let handshakeFailure = null;
    try {
      const stopped = await this.request(
        { cmd: 'stop' },
        'stopping',
        this.stopTimeouts.handshake,
      );
      this.executedRuntimeManifest = stopped.executedRuntimeManifest;
    } catch (error) {
      handshakeFailure = error;
    }
    let result = this.exited ? await this.exit : null;
    if (result === null && handshakeFailure === null) {
      result = await waitForExit(this.exit, this.stopTimeouts.gracefulExit);
    }
    let forced = false;
    if (result === null) {
      forced = true;
      this.proc.kill('SIGTERM');
      result = await waitForExit(this.exit, this.stopTimeouts.sigtermExit);
    }
    if (result === null) {
      this.proc.kill('SIGKILL');
      result = await waitForExit(this.exit, this.stopTimeouts.sigkillExit);
    }
    if (result === null) {
      const terminationFailure = new Error(
        `${this.role}: process did not exit after bounded SIGTERM and SIGKILL`,
      );
      throw handshakeFailure === null
        ? terminationFailure
        : new AggregateError([handshakeFailure, terminationFailure], terminationFailure.message);
    }
    if (forced && handshakeFailure !== null) {
      throw result.error === null
        ? handshakeFailure
        : new AggregateError(
          [handshakeFailure, result.error],
          `${this.role}: stop handshake failed; forced process exit completed`,
        );
    }
    if (result.error !== null) throw result.error;
    return result;
  }
}

export async function executeRfc64PrivateReleaseGateV1({
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
  const runRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-private-release-gate-'));
  const manifestPath = join(runRoot, 'manifest.json');
  const dataDirs = Object.fromEntries(ROLES.map((role) => [role, join(runRoot, role)]));
  const active = new Set();
  let artifact;
  try {
    await Promise.all(Object.values(dataDirs).map((path) => mkdir(path, { recursive: true })));

    const probeEntries = await Promise.all(ROLES.map(async (role) => {
      const child = new AgentChild(role, dataDirs[role], undefined, 'probe', {
        runtimeProvenance,
      });
      const ready = await child.waitFor('ready');
      assertReadyRuntimeManifest(ready, runtimeManifest.manifestDigest);
      const stopped = await child.waitFor('stopping');
      const exit = await child.exit;
      if (exit.error !== null) throw exit.error;
      return [role, {
        loaded: requiredExecutedRuntimeManifest(stopped, `${role} probe`),
        ready,
      }];
    }));
    const probed = Object.fromEntries(probeEntries);
    const peerIds = Object.fromEntries(ROLES.map((role) => [role, probed[role].ready.peerId]));
    await writeFile(manifestPath, `${JSON.stringify({ peerIds }, null, 2)}\n`, { mode: 0o600 });

    const owner = await startRole(
      'owner', dataDirs, manifestPath, peerIds, active, runtimeProvenance,
    );
    const published = await owner.request({ cmd: 'publish' }, 'published');

    const provider2 = await startRole(
      'provider2', dataDirs, manifestPath, peerIds, active, runtimeProvenance,
    );
    await connectBothWays(owner, provider2);
    const provider2Bootstrap = await provider2.request({
      cmd: 'wait-bootstrap',
      expectedHeadDigest: published.headObjectDigest,
      timeoutMs: RUN_TIMEOUT_MS,
    }, 'bootstrap-applied');
    const provider2State = await provider2.request({
      cmd: 'inspect',
      expectedHeadDigest: published.headObjectDigest,
    }, 'inspection');

    const ownerExit = await owner.stop();
    active.delete(owner);
    const ownerListenerClosed = await waitForTcpListenerClosed(owner.ready.multiaddr);
    if (!ownerListenerClosed) {
      throw new Error('owner: listener remained dialable after process exit');
    }
    const provider2ListenerDialable = await tcpListenerIsDialable(provider2.ready.multiaddr);
    if (!provider2ListenerDialable) {
      throw new Error('provider2: listener is not dialable after owner exit');
    }
    const provider2StateAfterOwnerExit = await provider2.request({
      cmd: 'inspect',
      expectedHeadDigest: published.headObjectDigest,
    }, 'inspection');
    if (
      provider2StateAfterOwnerExit.exactExpectedHead !== true
      || !hasExactMemoryContents(provider2StateAfterOwnerExit)
    ) {
      throw new Error('provider2: exact head, SWM, or VM changed after owner exit');
    }

    const receiver = await startRole(
      'receiver', dataDirs, manifestPath, peerIds, active, runtimeProvenance,
    );
    await connectBothWays(provider2, receiver);
    const receiverBootstrap = await receiver.request({
      cmd: 'wait-bootstrap',
      expectedHeadDigest: published.headObjectDigest,
      timeoutMs: RUN_TIMEOUT_MS,
    }, 'bootstrap-applied');
    const receiverState = await receiver.request({
      cmd: 'inspect',
      expectedHeadDigest: published.headObjectDigest,
    }, 'inspection');

    const outsider = await startRole(
      'outsider', dataDirs, manifestPath, peerIds, active, runtimeProvenance,
    );
    await dial(outsider, provider2);
    const outsiderDenial = await outsider.request({
      cmd: 'sync-denied',
      providerPeerIds: [peerIds.provider2],
    }, 'sync-denial-result');
    const outsiderState = await outsider.request({
      cmd: 'inspect',
      expectedHeadDigest: published.headObjectDigest,
    }, 'inspection');
    const providerAccessState = await provider2.request({
      cmd: 'inspect',
      expectedHeadDigest: published.headObjectDigest,
    }, 'inspection');

    await provider2.stop();
    active.delete(provider2);
    await receiver.stop();
    active.delete(receiver);
    const restartedReceiver = await startRole(
      'receiver',
      dataDirs,
      manifestPath,
      peerIds,
      active,
      runtimeProvenance,
    );
    const restartState = await restartedReceiver.request({
      cmd: 'inspect',
      expectedHeadDigest: published.headObjectDigest,
    }, 'inspection');

    await outsider.stop();
    active.delete(outsider);
    await restartedReceiver.stop();
    active.delete(restartedReceiver);

    const runtimeProcesses = [
      ...ROLES.map((role) => ({ id: `probe-${role}`, loaded: probed[role].loaded })),
      { id: 'owner', loaded: requiredChildRuntimeManifest(owner) },
      { id: 'provider2', loaded: requiredChildRuntimeManifest(provider2) },
      { id: 'receiver', loaded: requiredChildRuntimeManifest(receiver) },
      { id: 'outsider', loaded: requiredChildRuntimeManifest(outsider) },
      { id: 'receiver-restart', loaded: requiredChildRuntimeManifest(restartedReceiver) },
    ];
    for (const processEvidence of runtimeProcesses) {
      assertGate2ExecutedRuntimeMatchesBuildV1(processEvidence.loaded, runtimeManifest);
    }

    const checks = Object.freeze({
      fourStableUniqueDaemonIdentities:
        new Set(Object.values(peerIds)).size === 4
        && ROLES.every((role) => probed[role].ready.agentClass === 'DKGAgent'),
      productionCatalogServiceOnAllRoles:
        [owner.ready, provider2.ready, receiver.ready, outsider.ready, restartedReceiver.ready]
          .every((ready) => ready.catalogServiceStarted === true),
      exactTwoAssetPrivateCatalog:
        published.inventoryRowCount === '2'
        && published.catalogVersion === '2',
      provider2ReceivedExactHead:
        provider2Bootstrap.appliedHeadDigest === published.headObjectDigest
        && provider2State.exactExpectedHead === true
        && provider2State.inventoryRowCount === '2',
      provider2HasExactSwmAndVm: hasExactMemoryContents(provider2State),
      receiverUsedProvider2AfterOwnerStopped:
        receiverBootstrap.appliedHeadDigest === published.headObjectDigest
        && receiverBootstrap.providerPeerId === peerIds.provider2,
      ownerExitedBeforeReceiverRuntimeStarted:
        ownerExit.error === null
        && ownerListenerClosed
        && provider2ListenerDialable
        && owner.exitSequence < receiver.spawnSequence,
      receiverHasExactSwmAndVm: hasExactMemoryContents(receiverState),
      finalizedChainPathExecuted:
        provider2State.rpcCalls > 0 && receiverState.rpcCalls > 0,
      outsiderDeniedBeforeApplication:
        isExpectedPrivateCatalogDenialResultV1(outsiderDenial)
        && outsiderState.appliedHeadDigest === null,
      outsiderReceivedNoPrivateGraphs:
        outsiderState.graphCounts.every(({ swm, vm }) => swm === 0 && vm === 0),
      nonmemberQueryIsEmpty: providerAccessState.outsiderVisibleVmBindings === 0,
      restartPreservedIdentityAndExactHead:
        restartedReceiver.ready.peerId === peerIds.receiver
        && restartState.exactExpectedHead === true
        && restartState.inventoryRowCount === '2',
      restartPreservedExactSwmAndVm: hasExactMemoryContents(restartState),
      allChildRuntimeBytesMatchCleanBuild: runtimeProcesses.length === 9,
    });
    const status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
    artifact = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status,
      limitation:
        'Uses a deterministic finalized-chain adapter and loopback RPC, not scripts/devnet.sh Hardhat or the CLI daemon.',
      topology: {
        ownerProvider: safeRole(probed.owner.ready),
        authorizedProviderReceiver: safeRole(probed.provider2.ready),
        authorizedReceiver: safeRole(probed.receiver.ready),
        unauthorizedNode: safeRole(probed.outsider.ready),
      },
      runtimeManifestDigest: runtimeManifest.manifestDigest,
      runtimeProvenance: {
        schema: 'dkg-rfc64-private-runtime-provenance-v1',
        sourceBuild: runtimeManifest,
        processes: runtimeProcesses,
      },
      checks,
      catalog: {
        headObjectDigest: published.headObjectDigest,
        policyDigest: published.policyDigest,
        catalogVersion: published.catalogVersion,
        inventoryRowCount: published.inventoryRowCount,
      },
      provider2: safeState(provider2State, provider2Bootstrap),
      failoverBarrier: {
        ownerExitCode: ownerExit.code,
        ownerExitedAt: ownerExit.exitedAt,
        ownerExitedBeforeReceiverSpawn: owner.exitSequence < receiver.spawnSequence,
        ownerListenerClosed,
        provider2ExactHeadAfterOwnerExit:
          provider2StateAfterOwnerExit.exactExpectedHead === true,
        provider2ListenerDialable,
        receiverSpawnedAt: receiver.spawnedAt,
      },
      failoverReceiver: safeState(receiverState, receiverBootstrap),
      outsider: {
        denied: outsiderDenial.denied,
        failureClass: outsiderDenial.failureClass,
        failureCode: outsiderDenial.failureCode,
        appliedHeadDigest: outsiderState.appliedHeadDigest,
        graphCounts: outsiderState.graphCounts,
      },
      restartedReceiver: safeState(restartState, null),
    };
    if (status !== 'PASS') process.exitCode = 1;
  } finally {
    await Promise.all([...active].map((child) => child.stop().catch(() => undefined)));
    if (process.env.DKG_RFC64_PRIVATE_KEEP_RUN !== '1') {
      await rm(runRoot, { recursive: true, force: true });
    } else {
      process.stdout.write('RFC-64 private gate retained its local run directory.\n');
    }
  }
  return artifact;
}

async function startRole(
  role,
  dataDirs,
  manifestPath,
  expectedPeerIds,
  active,
  runtimeProvenance,
) {
  const child = new AgentChild(role, dataDirs[role], manifestPath, 'run', {
    runtimeProvenance,
  });
  active.add(child);
  child.ready = await child.waitFor('ready');
  assertReadyRuntimeManifest(
    child.ready,
    runtimeProvenance.runtimeManifestDigest,
  );
  if (child.ready.peerId !== expectedPeerIds[role]) {
    throw new Error(`${role}: persisted peer identity changed after probe`);
  }
  return child;
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

function requiredChildRuntimeManifest(child) {
  return requiredExecutedRuntimeManifest(
    { executedRuntimeManifest: child.executedRuntimeManifest },
    child.role,
  );
}

async function connectBothWays(left, right) {
  await Promise.all([dial(left, right), dial(right, left)]);
}

async function dial(from, to) {
  await from.request({
    cmd: 'dial',
    multiaddr: to.ready.multiaddr,
    peerId: to.ready.peerId,
  }, 'dialed', 30_000);
}

export function hasExactMemoryContents(state) {
  return state.graphCounts.length === 2
    && state.graphCounts.every(({ swm, swmDigest, vm, vmDigest }) => (
      swm === 2
      && vm === 2
      && swmDigest === PROJECTION_DIGEST
      && vmDigest === PROJECTION_DIGEST
    ));
}

function safeRole(ready) {
  return {
    agentClass: ready.agentClass,
    peerId: ready.peerId,
    agentAddress: roleAgentAddress(ready.role),
  };
}

function safeState(state, bootstrap) {
  return {
    appliedHeadDigest: state.appliedHeadDigest,
    catalogVersion: state.catalogVersion,
    inventoryRowCount: state.inventoryRowCount,
    graphCounts: state.graphCounts,
    rpcCalls: state.rpcCalls,
    receiver: {
      applied: state.receiverStats?.applied ?? 0,
      failed: state.receiverStats?.failed ?? 0,
    },
    ...(bootstrap === null ? {} : {
      bootstrap: {
        outcome: bootstrap.outcome,
        providerPeerId: bootstrap.providerPeerId,
        attempts: bootstrap.attempts,
      },
    }),
  };
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
