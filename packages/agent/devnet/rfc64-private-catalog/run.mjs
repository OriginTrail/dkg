// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { roleAgentAddress } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = join(HERE, '..', '..');
const AGENT_PROCESS = join(HERE, 'agent-process.mjs');
const ARTIFACT = join(HERE, 'artifacts', 'latest.json');
const ROLES = Object.freeze(['owner', 'provider2', 'receiver', 'outsider']);
const RUN_TIMEOUT_MS = 90_000;

let requestSequence = 0;

class AgentChild {
  constructor(role, dataDir, manifestPath, mode = 'run') {
    this.role = role;
    this.events = [];
    this.waiters = [];
    this.exited = false;
    this.proc = spawn(process.execPath, [AGENT_PROCESS], {
      cwd: AGENT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DKG_RFC64_PRIVATE_ROLE: role,
        DKG_RFC64_PRIVATE_MODE: mode,
        DKG_RFC64_PRIVATE_DATA_DIR: dataDir,
        ...(manifestPath === undefined ? {} : {
          DKG_RFC64_PRIVATE_MANIFEST: manifestPath,
        }),
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const marker = 'RFC64_PRIVATE_EVENT ';
      if (!line.startsWith(marker)) return;
      const event = JSON.parse(line.slice(marker.length));
      this.events.push(event);
      for (const waiter of [...this.waiters]) {
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
      this.proc.once('error', (error) => {
        this.exited = true;
        for (const waiter of this.waiters.splice(0)) waiter.reject(error);
        resolve({ code: null, signal: null, error });
      });
      this.proc.once('exit', (code, signal) => {
        this.exited = true;
        if (code !== 0 && signal !== 'SIGTERM') {
          const error = new Error(`${role}: process exited with ${code ?? signal}`);
          for (const waiter of this.waiters.splice(0)) waiter.reject(error);
          resolve({ code, signal, error });
          return;
        }
        resolve({ code, signal, error: null });
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
    if (this.exited) return;
    try {
      await this.request({ cmd: 'stop' }, 'stopping', 5_000);
      await Promise.race([this.exit, delay(5_000)]);
    } finally {
      if (!this.exited) this.proc.kill('SIGTERM');
    }
  }
}

async function main() {
  const runRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-private-release-gate-'));
  const manifestPath = join(runRoot, 'manifest.json');
  const dataDirs = Object.fromEntries(ROLES.map((role) => [role, join(runRoot, role)]));
  const active = new Set();
  let artifact;
  try {
    await Promise.all(Object.values(dataDirs).map((path) => mkdir(path, { recursive: true })));

    const probeEntries = await Promise.all(ROLES.map(async (role) => {
      const child = new AgentChild(role, dataDirs[role], undefined, 'probe');
      const ready = await child.waitFor('ready');
      const exit = await child.exit;
      if (exit.error !== null) throw exit.error;
      return [role, ready];
    }));
    const probed = Object.fromEntries(probeEntries);
    const peerIds = Object.fromEntries(ROLES.map((role) => [role, probed[role].peerId]));
    await writeFile(manifestPath, `${JSON.stringify({ peerIds }, null, 2)}\n`, { mode: 0o600 });

    const owner = await startRole('owner', dataDirs, manifestPath, peerIds, active);
    const published = await owner.request({ cmd: 'publish' }, 'published');

    const provider2 = await startRole('provider2', dataDirs, manifestPath, peerIds, active);
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

    await owner.stop();
    active.delete(owner);

    const receiver = await startRole('receiver', dataDirs, manifestPath, peerIds, active);
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

    const outsider = await startRole('outsider', dataDirs, manifestPath, peerIds, active);
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
    );
    const restartState = await restartedReceiver.request({
      cmd: 'inspect',
      expectedHeadDigest: published.headObjectDigest,
    }, 'inspection');

    const checks = Object.freeze({
      fourStableUniqueDaemonIdentities:
        new Set(Object.values(peerIds)).size === 4
        && ROLES.every((role) => probed[role].agentClass === 'DKGAgent'),
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
      provider2HasExactSwmAndVm: exactMemoryCounts(provider2State),
      receiverUsedProvider2AfterOwnerStopped:
        receiverBootstrap.appliedHeadDigest === published.headObjectDigest
        && receiverBootstrap.providerPeerId === peerIds.provider2,
      receiverHasExactSwmAndVm: exactMemoryCounts(receiverState),
      finalizedChainPathExecuted:
        provider2State.rpcCalls > 0 && receiverState.rpcCalls > 0,
      outsiderDeniedBeforeApplication:
        outsiderDenial.denied === true
        && outsiderDenial.applied === false
        && outsiderState.appliedHeadDigest === null,
      outsiderReceivedNoPrivateGraphs:
        outsiderState.graphCounts.every(({ swm, vm }) => swm === 0 && vm === 0),
      nonmemberQueryIsEmpty: providerAccessState.outsiderVisibleVmBindings === 0,
      restartPreservedIdentityAndExactHead:
        restartedReceiver.ready.peerId === peerIds.receiver
        && restartState.exactExpectedHead === true
        && restartState.inventoryRowCount === '2',
      restartPreservedExactSwmAndVm: exactMemoryCounts(restartState),
    });
    const status = Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL';
    artifact = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status,
      limitation:
        'Uses a deterministic finalized-chain adapter and loopback RPC, not scripts/devnet.sh Hardhat or the CLI daemon.',
      topology: {
        ownerProvider: safeRole(probed.owner),
        authorizedProviderReceiver: safeRole(probed.provider2),
        authorizedReceiver: safeRole(probed.receiver),
        unauthorizedNode: safeRole(probed.outsider),
      },
      checks,
      catalog: {
        headObjectDigest: published.headObjectDigest,
        policyDigest: published.policyDigest,
        catalogVersion: published.catalogVersion,
        inventoryRowCount: published.inventoryRowCount,
      },
      provider2: safeState(provider2State, provider2Bootstrap),
      failoverReceiver: safeState(receiverState, receiverBootstrap),
      outsider: {
        denied: outsiderDenial.denied,
        failureClass: outsiderDenial.failureClass,
        appliedHeadDigest: outsiderState.appliedHeadDigest,
        graphCounts: outsiderState.graphCounts,
      },
      restartedReceiver: safeState(restartState, null),
    };
    await mkdir(dirname(ARTIFACT), { recursive: true });
    await writeFile(ARTIFACT, `${stableJson(artifact)}\n`);
    process.stdout.write(`${stableJson(artifact)}\n`);
    process.stdout.write(`RFC-64 private Releases 1-3 four-process gate: ${status}\n`);
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

async function startRole(role, dataDirs, manifestPath, expectedPeerIds, active) {
  const child = new AgentChild(role, dataDirs[role], manifestPath);
  active.add(child);
  child.ready = await child.waitFor('ready');
  if (child.ready.peerId !== expectedPeerIds[role]) {
    throw new Error(`${role}: persisted peer identity changed after probe`);
  }
  return child;
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

function exactMemoryCounts(state) {
  return state.graphCounts.length === 2
    && state.graphCounts.every(({ swm, vm }) => swm === 2 && vm === 2);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`RFC-64 private release gate failed: ${message}\n`);
  try {
    const prior = await readFile(ARTIFACT, 'utf8');
    if (prior.length === 0) process.stderr.write('No prior gate artifact exists.\n');
  } catch { /* no prior artifact */ }
  process.exitCode = 1;
});
