import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { hostname } from 'node:os';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { buildGate2RuntimeManifestV1 } from
  '../rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';
import {
  SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
  type SelectiveCoverageEdgeRestartReceiptV1,
  type SelectiveCoverageRuntimeReadyV1,
  type SelectiveCoverageRuntimeRole,
} from './runtime.ts';
import type {
  CoreAutomaticRoundV1,
  CoreFinalObservationV1,
  EdgeGraphObservationV1,
  EdgeSyncOperationV1,
  GraphObservationV1,
  SyncCoverageJournalReferenceV1,
} from './manifest.ts';
import {
  observeGraph,
  readTestnetOperatorConfig,
  resolveTestnetOperatorShutdownExitTimeoutMs,
  requestJson,
  requireJson,
  type TestnetOperatorConfigV1,
  type TestnetOperatorGraphV1,
  type TestnetOperatorRoleV1,
} from './testnet-operator-common.ts';

const COMMAND_SCHEMA = 'dkg-rfc64-m1-selective-coverage-runtime-command-v1';
const RESULT_SCHEMA = 'dkg-rfc64-m1-selective-coverage-runtime-result-v1';
const RESULT_PREFIX = 'DKG_RFC64_M1_RESULT ';
const REMOTE_PID_PREFIX = 'DKG_RFC64_M1_REMOTE_PID=';
const configPath = requiredEnvironment('DKG_RFC64_M1_OPERATOR_CONFIG');
const config = readTestnetOperatorConfig(resolve(configPath));

interface RuntimeCommand {
  readonly schema: typeof COMMAND_SCHEMA;
  readonly protocol: typeof SELECTIVE_COVERAGE_RUNTIME_PROTOCOL;
  readonly sessionNonce: string;
  readonly sequence: number;
  readonly command: string;
  readonly payload: Record<string, unknown>;
}

interface RuntimeProcess {
  readonly role: SelectiveCoverageRuntimeRole;
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: SelectiveCoverageRuntimeReadyV1;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

class TestnetOperatorController {
  private readonly processes = new Map<SelectiveCoverageRuntimeRole, RuntimeProcess>();
  private readonly edgeProducingJobIds = new Map<string, string>();
  private readonly coreJobIds = new Map<string, Set<string>>();
  private lastCoreSequence = 0;

  constructor(private readonly cfg: TestnetOperatorConfigV1) {}

  async handle(command: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'start':
        return await this.start(role(payload['role']));
      case 'stop':
        await this.stop(role(payload['role']));
        return null;
      case 'publish-wave':
        return await this.publishWave(wave(payload['wave']));
      case 'observe-edge':
        return await this.observeEdge();
      case 'synchronize-edge':
        return await this.synchronizeEdge(payload);
      case 'restart-edge':
        return await this.restartEdge();
      case 'wait-edge-reconciler':
        return await this.waitEdgeReconciler(requiredText(payload['contextGraphId'], 'contextGraphId'));
      case 'core-automatic-round':
        return await this.coreAutomaticRound(nonNegativeInteger(payload['round'], 'round'));
      case 'observe-core-final':
        return await this.observeCoreFinal();
      case 'shutdown':
        await this.stopAll();
        return null;
      default:
        throw new Error(`unsupported M1 operator command: ${command}`);
    }
  }

  async start(roleName: SelectiveCoverageRuntimeRole): Promise<SelectiveCoverageRuntimeReadyV1> {
    if (this.processes.has(roleName)) throw new Error(`${roleName} is already running`);
    const roleConfig = this.cfg.roles[roleName];
    const provenance = await runtimeProvenance(roleConfig);
    const hostIdentity = await roleCapture(roleConfig, ['hostname']);
    const durableDirectoryIdentity = await dataDirectoryIdentity(roleConfig);
    const launched = launchRole(roleName, roleConfig);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
      launched.child.once('exit', (code, signal) => done({ code, signal }));
    });
    launched.child.stdout.on('data', (chunk: Buffer) => {
      process.stderr.write(`[${roleName}] ${chunk.toString('utf8')}`);
    });
    launched.child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(`[${roleName}] ${chunk.toString('utf8')}`);
    });
    try {
      const [status, journal, pid] = await Promise.race([
        Promise.all([
          waitForStatus(roleConfig, this.cfg),
          waitForJournal(roleConfig, this.cfg),
          launched.pid,
        ]),
        exit.then(({ code, signal }) => {
          throw new FatalPollError(
            `${roleName} exited before readiness (code=${String(code)} signal=${String(signal)})`,
          );
        }),
      ]);
      const peerId = requiredText(status['peerId'], `${roleName} peerId`);
      const networkId = requiredText(status['networkId'], `${roleName} networkId`);
      const reportedCommit = requiredText(status['commit'], `${roleName} reported commit`);
      if (!provenance.sourceCommit.startsWith(reportedCommit)
        || reportedCommit.length < 7) {
        throw new Error(
          `${roleName} running commit ${reportedCommit} does not match tested head ${provenance.sourceCommit}`,
        );
      }
      const nodeRole = status['nodeRole'];
      if ((roleName === 'core' && nodeRole !== 'core')
        || (roleName !== 'core' && nodeRole !== 'edge')) {
        throw new Error(`${roleName} started with unexpected nodeRole=${String(nodeRole)}`);
      }
      const processStartedAt = nonNegativeInteger(journal['processStartedAt'], 'processStartedAt');
      const evidenceWaveId = requiredText(journal['waveId'], 'evidence waveId');
      const ready: SelectiveCoverageRuntimeReadyV1 = {
        protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
        role: roleName,
        hostIdentity: hostIdentity.trim(),
        pid,
        peerId,
        networkId,
        testedHeadCommit: provenance.sourceCommit,
        runtimeManifestDigest: provenance.runtimeManifestDigest,
        processStartedAt,
        processInstanceId: evidenceWaveId,
        dataDirectoryIdentity: durableDirectoryIdentity,
        evidenceWaveId,
      };
      this.processes.set(roleName, { role: roleName, child: launched.child, ready, exited: exit });
      return ready;
    } catch (error) {
      launched.child.kill('SIGTERM');
      throw error;
    }
  }

  async stop(roleName: SelectiveCoverageRuntimeRole): Promise<void> {
    const running = this.processes.get(roleName);
    if (!running) return;
    const roleConfig = this.cfg.roles[roleName];
    let outcome: { code: number | null; signal: NodeJS.Signals | null };
    try {
      const shutdown = await requestJson(roleConfig, '/api/shutdown', { method: 'POST' });
      if (shutdown.status !== 200) {
        throw new Error(`${roleName} shutdown request failed (${shutdown.status})`);
      }
      outcome = await withTimeout(
        running.exited,
        resolveTestnetOperatorShutdownExitTimeoutMs(
          this.cfg.roles[roleName],
          this.cfg.operationTimeoutMs,
        ),
        `${roleName} process exit after shutdown`,
      );
    } finally {
      this.processes.delete(roleName);
    }
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(
        `${roleName} exited abnormally (code=${String(outcome.code)} signal=${String(outcome.signal)})`,
      );
    }
  }

  async stopAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const roleName of ['core', 'edge', 'publisher'] as const) {
      try { await this.stop(roleName); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'M1 operator node shutdown failed');
  }

  async publishWave(selectedWave: 'selected' | 'final'): Promise<readonly GraphObservationV1[]> {
    this.requireRunning('publisher');
    const publisher = this.cfg.roles.publisher;
    for (const graph of this.cfg.graphs) {
      const waveAssets = graph.assets.filter((candidate) => candidate.wave === selectedWave);
      // A confirmed VM publish intentionally consumes that asset's SWM root.
      // Use distinct plane assets and publish VM first so the stable snapshot
      // contains a real finalized VM asset plus a real off-chain SWM asset.
      for (const asset of waveAssets.filter((candidate) => candidate.plane === 'vm')) {
        await requireJson(
          publisher,
          `/api/knowledge-assets/${encodeURIComponent(asset.name)}/swm/share`,
          { method: 'POST', body: JSON.stringify({ contextGraphId: graph.contextGraphId }) },
        );
        const published = await requireJson(
          publisher,
          `/api/knowledge-assets/${encodeURIComponent(asset.name)}/vm/publish`,
          { method: 'POST', body: JSON.stringify({ contextGraphId: graph.contextGraphId }) },
        );
        const returnedUal = published['ual'];
        if (typeof returnedUal === 'string' && returnedUal.toLowerCase() !== asset.ual.toLowerCase()) {
          throw new Error(`${graph.contextGraphId}/${asset.name} published an unexpected UAL`);
        }
      }
      for (const asset of waveAssets.filter((candidate) => candidate.plane === 'swm')) {
        const shared = await requireJson(
          publisher,
          `/api/knowledge-assets/${encodeURIComponent(asset.name)}/swm/share`,
          { method: 'POST', body: JSON.stringify({ contextGraphId: graph.contextGraphId }) },
        );
        if (shared['swmShared'] !== true || shared['sealed'] !== true) {
          throw new Error(`${graph.contextGraphId}/${asset.name} did not produce a sealed SWM share`);
        }
      }
    }
    const expectedAssets = selectedWave === 'selected' ? 1 : 2;
    return await this.waitForObservations('publisher', (rows) =>
      rows.every((row) => row.vm.assetCount === expectedAssets && row.swm.assetCount === expectedAssets));
  }

  async observeEdge(): Promise<readonly EdgeGraphObservationV1[]> {
    this.requireRunning('edge');
    const rows = await this.observeAll('edge');
    const subscriptions = await requireJson(
      this.cfg.roles.edge,
      '/api/context-graph/subscriptions',
    );
    const subscriptionRows = Array.isArray(subscriptions['subscriptions'])
      ? subscriptions['subscriptions']
      : [];
    const modeById = new Map<string, 'always-on' | 'on-demand'>();
    for (const value of subscriptionRows) {
      const item = looseRecord(value);
      if (!item) continue;
      const id = item['contextGraphId'];
      const mode = item['syncMode'];
      if (typeof id === 'string' && (mode === 'always-on' || mode === 'on-demand')) {
        modeById.set(id, mode);
      }
    }
    return rows.map((row): EdgeGraphObservationV1 => {
      const payloadPresent = row.vm.assetCount > 0 || row.swm.assetCount > 0;
      return {
        ...row,
        runtimeSyncMode: modeById.get(row.contextGraphId) ?? null,
        producingJobId: payloadPresent
          ? this.edgeProducingJobIds.get(row.contextGraphId) ?? null
          : null,
      };
    });
  }

  async synchronizeEdge(payload: Record<string, unknown>): Promise<{
    operation: Omit<EdgeSyncOperationV1, 'sequence'>;
  }> {
    this.requireRunning('edge');
    const contextGraphId = requiredText(payload['contextGraphId'], 'contextGraphId');
    const phase = payload['phase'];
    const syncMode = payload['syncMode'];
    const completedWave = payload['wave'];
    if ((phase !== 'selection' && phase !== 'post-restart-explicit')
      || (syncMode !== 'always-on' && syncMode !== 'on-demand')
      || (completedWave !== 'selected' && completedWave !== 'final')) {
      throw new TypeError('synchronize-edge payload is malformed');
    }
    const graph = this.graph(contextGraphId);
    const response = await requireJson(this.cfg.roles.edge, '/api/context-graph/subscribe', {
      method: 'POST',
      body: JSON.stringify({ contextGraphId, includeSharedMemory: true, syncMode }),
    });
    const catchup = requiredRecord(response['catchup'], 'catchup response');
    const jobId = requiredText(catchup['jobId'], 'catchup jobId');
    await this.waitForCatchup(jobId);
    const snapshot = await this.waitForGraphSnapshot('edge', graph, completedWave === 'selected' ? 1 : 2);
    this.edgeProducingJobIds.set(contextGraphId, jobId);
    return {
      operation: {
        phase,
        source: 'user',
        syncMode,
        contextGraphId,
        jobId,
        completedWave,
        completedSnapshot: snapshot,
      },
    };
  }

  async restartEdge(): Promise<SelectiveCoverageEdgeRestartReceiptV1> {
    const previous = this.requireRunning('edge').ready;
    await this.stop('edge');
    const exitedAt = Date.now();
    const current = await this.start('edge');
    return {
      previous: {
        hostIdentity: previous.hostIdentity,
        pid: previous.pid,
        processInstanceId: previous.processInstanceId,
        exitedAt,
      },
      current,
    };
  }

  async waitEdgeReconciler(contextGraphId: string): Promise<{
    operation: Omit<EdgeSyncOperationV1, 'sequence'>;
    journal: SyncCoverageJournalReferenceV1;
  }> {
    this.requireRunning('edge');
    const journal = await this.waitForJournalEntry('edge', 0, (entry) =>
      entry['kind'] === 'edge-reconciler-job'
        && entry['contextGraphId'] === contextGraphId
        && entry['state'] === 'complete');
    const entry = journal.entry;
    const jobId = requiredText(entry['jobId'], 'Edge reconciler jobId');
    const graph = this.graph(contextGraphId);
    const snapshot = await this.waitForGraphSnapshot('edge', graph, 2);
    this.edgeProducingJobIds.set(contextGraphId, jobId);
    return {
      operation: {
        phase: 'post-restart-auto',
        source: 'reconciler',
        syncMode: 'always-on',
        contextGraphId,
        jobId,
        completedWave: 'final',
        completedSnapshot: snapshot,
      },
      journal: { snapshot: journal.snapshot, sequence: journal.sequence },
    };
  }

  async coreAutomaticRound(round: number): Promise<{
    round: CoreAutomaticRoundV1;
    journal: SyncCoverageJournalReferenceV1;
  }> {
    this.requireRunning('core');
    const journal = await this.waitForJournalEntry('core', this.lastCoreSequence, (entry) =>
      entry['kind'] === 'core-automatic-round' && entry['state'] === 'complete');
    this.lastCoreSequence = journal.sequence;
    const entry = journal.entry;
    const contextGraphIds = stringArray(entry['automaticContextGraphIds'], 'automatic CG IDs');
    const explicit = stringArray(entry['explicitSelectedContextGraphIds'], 'explicit CG IDs');
    const jobId = requiredText(entry['jobId'], 'Core round jobId');
    const completions = [];
    for (const contextGraphId of contextGraphIds) {
      const graph = this.graph(contextGraphId);
      const completedSnapshot = await this.waitForGraphSnapshot('core', graph, 2);
      completions.push({ contextGraphId, completedWave: 'final' as const, completedSnapshot });
      const jobs = this.coreJobIds.get(contextGraphId) ?? new Set<string>();
      jobs.add(jobId);
      this.coreJobIds.set(contextGraphId, jobs);
    }
    return {
      round: {
        round,
        jobId,
        planningLane: requiredText(entry['planningLane'], 'Core planning lane'),
        source: 'automatic-core-public',
        configuredBatchSize: nonNegativeInteger(entry['configuredBatchSize'], 'configuredBatchSize'),
        explicitSelectedContextGraphIds: explicit,
        contextGraphIds,
        completions,
      },
      journal: { snapshot: journal.snapshot, sequence: journal.sequence },
    };
  }

  async observeCoreFinal(): Promise<readonly CoreFinalObservationV1[]> {
    this.requireRunning('core');
    const observations = await this.observeAll('core');
    return observations.map((observation): CoreFinalObservationV1 => ({
      ...observation,
      automaticJobIds: [...(this.coreJobIds.get(observation.contextGraphId) ?? [])],
    }));
  }

  private async observeAll(
    roleName: 'publisher' | 'edge' | 'core',
  ): Promise<readonly GraphObservationV1[]> {
    const roleConfig = this.cfg.roles[roleName];
    return await Promise.all(this.cfg.graphs.map((graph) => observeGraph(roleConfig, graph)));
  }

  private async waitForObservations(
    roleName: 'publisher' | 'edge' | 'core',
    accept: (observations: readonly GraphObservationV1[]) => boolean,
  ): Promise<readonly GraphObservationV1[]> {
    return await poll(
      `${roleName} exact graph observations`,
      this.cfg,
      async () => {
        const observations = await this.observeAll(roleName);
        return accept(observations) ? observations : undefined;
      },
    );
  }

  private async waitForGraphSnapshot(
    roleName: 'edge' | 'core',
    graph: TestnetOperatorGraphV1,
    expectedAssets: number,
  ) {
    const observation = await poll(
      `${roleName} ${graph.contextGraphId} ${expectedAssets}-asset snapshot`,
      this.cfg,
      async () => {
        const row = await observeGraph(this.cfg.roles[roleName], graph);
        return row.vm.assetCount === expectedAssets && row.swm.assetCount === expectedAssets
          ? row
          : undefined;
      },
    );
    if (!observation.vm.reportedComplete || !observation.swm.reportedComplete
      || observation.vm.headDigest === null || observation.vm.inventoryDigest === null
      || observation.swm.headDigest === null || observation.swm.inventoryDigest === null) {
      throw new Error(`${roleName} ${graph.contextGraphId} snapshot is incomplete`);
    }
    return {
      vm: {
        headDigest: observation.vm.headDigest,
        inventoryDigest: observation.vm.inventoryDigest,
        assetCount: observation.vm.assetCount,
        dataTripleCount: observation.vm.dataTripleCount,
      },
      swm: {
        headDigest: observation.swm.headDigest,
        inventoryDigest: observation.swm.inventoryDigest,
        assetCount: observation.swm.assetCount,
        dataTripleCount: observation.swm.dataTripleCount,
      },
    };
  }

  private async waitForCatchup(jobId: string): Promise<void> {
    await poll(`Edge catch-up ${jobId}`, this.cfg, async () => {
      const status = await requireJson(
        this.cfg.roles.edge,
        `/api/sync/catchup-status?jobId=${encodeURIComponent(jobId)}`,
      );
      if (status['status'] === 'failed' || status['status'] === 'denied'
        || status['status'] === 'unreachable') {
        throw new FatalPollError(
          `Edge catch-up ${jobId} failed: ${JSON.stringify(status).slice(0, 1_000)}`,
        );
      }
      const convergence = looseRecord(status['convergence']);
      return status['status'] === 'done' && convergence?.['state'] === 'complete'
        ? true
        : undefined;
    });
  }

  private async waitForJournalEntry(
    roleName: 'edge' | 'core',
    afterSequence: number,
    accept: (entry: Record<string, unknown>) => boolean,
  ): Promise<{ snapshot: Record<string, unknown>; entry: Record<string, unknown>; sequence: number }> {
    return await poll(`${roleName} automatic journal entry`, this.cfg, async () => {
      const snapshot = await requireJson(
        this.cfg.roles[roleName],
        `/api/diagnostics/sync-coverage-evidence?afterSequence=${afterSequence}`,
      );
      const entries = Array.isArray(snapshot['entries']) ? snapshot['entries'] : [];
      for (const value of entries) {
        const entry = looseRecord(value);
        if (!entry || !accept(entry)) continue;
        const sequence = nonNegativeInteger(entry['sequence'], 'journal sequence');
        return { snapshot, entry, sequence };
      }
      return undefined;
    });
  }

  private requireRunning(roleName: SelectiveCoverageRuntimeRole): RuntimeProcess {
    const running = this.processes.get(roleName);
    if (!running) throw new Error(`${roleName} is not running`);
    return running;
  }

  private graph(contextGraphId: string): TestnetOperatorGraphV1 {
    const graph = this.cfg.graphs.find((candidate) => candidate.contextGraphId === contextGraphId);
    if (!graph) throw new Error(`context graph is outside the operator plan: ${contextGraphId}`);
    return graph;
  }
}

const controller = new TestnetOperatorController(config);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let commandTail = Promise.resolve();
let closing = false;

lines.on('line', (line) => {
  commandTail = commandTail.then(async () => {
    const request = parseCommand(line);
    try {
      const value = await controller.handle(request.command, request.payload);
      emit(request, true, value);
      if (request.command === 'shutdown') {
        closing = true;
        lines.close();
      }
    } catch (error) {
      emit(request, false, error instanceof Error ? error.message : String(error));
    }
  }).catch((error) => {
    process.stderr.write(`[rfc64-m1-adapter] command loop failed: ${String(error)}\n`);
    process.exitCode = 1;
    lines.close();
  });
});

lines.on('close', () => {
  void commandTail.finally(async () => {
    if (!closing) await controller.stopAll().catch(() => undefined);
  });
});

function launchRole(
  roleName: SelectiveCoverageRuntimeRole,
  roleConfig: TestnetOperatorRoleV1,
): { child: ChildProcessWithoutNullStreams; pid: Promise<number> } {
  if (roleConfig.transport === 'local') {
    const child = spawn(roleConfig.command[0]!, [...roleConfig.command.slice(1)], {
      cwd: roleConfig.repoRoot,
      env: { ...process.env, ...roleConfig.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid === undefined) throw new Error(`${roleName} local process has no PID`);
    return { child, pid: Promise.resolve(child.pid) };
  }
  const remote = [
    `cd ${shellQuote(roleConfig.repoRoot)}`,
    `printf '${REMOTE_PID_PREFIX}%s\\n' "$$" >&2`,
    `exec env ${Object.entries(roleConfig.environment)
      .map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')} `
      + roleConfig.command.map(shellQuote).join(' '),
  ].join(' && ');
  const child = spawn('ssh', ['-T', roleConfig.sshTarget!, remote], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = new Promise<number>((resolvePid, rejectPid) => {
    let buffer = '';
    const timeout = setTimeout(() => rejectPid(new Error('remote PID marker timed out')), 30_000);
    child.stderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = new RegExp(`${REMOTE_PID_PREFIX}(\\d+)`, 'u').exec(buffer);
      if (!match) return;
      clearTimeout(timeout);
      const value = Number(match[1]);
      if (!Number.isSafeInteger(value) || value < 1) rejectPid(new Error('remote PID is invalid'));
      else resolvePid(value);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectPid(new Error(`remote process exited before PID marker (${String(code)}/${String(signal)})`));
    });
  });
  return { child, pid };
}

async function runtimeProvenance(role: TestnetOperatorRoleV1): Promise<{
  sourceCommit: string;
  runtimeManifestDigest: string;
}> {
  if (role.transport === 'local') {
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: role.repoRoot,
      encoding: 'utf8',
    }).trim();
    const manifest = buildGate2RuntimeManifestV1(role.repoRoot, sourceCommit);
    return { sourceCommit, runtimeManifestDigest: manifest.manifestDigest };
  }
  const output = await roleCapture(role, [
    'node',
    '--import',
    'tsx',
    'devnet/rfc64-m1-selective-coverage/print-runtime-provenance.ts',
    role.repoRoot,
  ], role.repoRoot);
  let parsed: unknown;
  try { parsed = JSON.parse(output.trim().split(/\r?\n/u).at(-1) ?? ''); } catch (error) {
    throw new Error('remote runtime provenance is not JSON', { cause: error });
  }
  const row = requiredRecord(parsed, 'remote runtime provenance');
  return {
    sourceCommit: requiredText(row['sourceCommit'], 'remote source commit'),
    runtimeManifestDigest: requiredText(row['runtimeManifestDigest'], 'remote runtime digest'),
  };
}

async function waitForStatus(
  role: TestnetOperatorRoleV1,
  cfg: TestnetOperatorConfigV1,
): Promise<Record<string, unknown>> {
  return await poll('node status', cfg, async () => {
    const response = await requestJson(role, '/api/status').catch(() => undefined);
    return response?.status === 200 && looseRecord(response.body)
      ? response.body as Record<string, unknown>
      : undefined;
  });
}

async function waitForJournal(
  role: TestnetOperatorRoleV1,
  cfg: TestnetOperatorConfigV1,
): Promise<Record<string, unknown>> {
  return await poll('node sync evidence journal', cfg, async () => {
    const response = await requestJson(
      role,
      '/api/diagnostics/sync-coverage-evidence?afterSequence=0',
    ).catch(() => undefined);
    return response?.status === 200 && looseRecord(response.body)
      ? response.body as Record<string, unknown>
      : undefined;
  });
}

async function dataDirectoryIdentity(role: TestnetOperatorRoleV1): Promise<string> {
  if (role.transport === 'local') {
    const path = realpathSync(role.dataDir);
    const stat = statSync(path);
    return `${hostname()}|${stat.dev}:${stat.ino}|${path}`;
  }
  const output = await roleCapture(role, [
    'sh', '-lc',
    `path=$(readlink -f ${shellQuote(role.dataDir)}) && stat -Lc '%d:%i' "$path" && printf '%s\\n' "$path"`,
  ]);
  const parts = output.trim().split(/\r?\n/u);
  if (parts.length !== 2) throw new Error('remote data directory identity is malformed');
  return `${(await roleCapture(role, ['hostname'])).trim()}|${parts[0]}|${parts[1]}`;
}

async function roleCapture(
  role: TestnetOperatorRoleV1,
  command: readonly string[],
  cwd?: string,
): Promise<string> {
  if (role.transport === 'local') {
    return execFileSync(command[0]!, [...command.slice(1)], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...role.environment },
    });
  }
  const remote = `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}${command.map(shellQuote).join(' ')}`;
  return execFileSync('ssh', ['-T', role.sshTarget!, remote], { encoding: 'utf8' });
}

async function poll<T>(
  label: string,
  cfg: TestnetOperatorConfigV1,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + cfg.operationTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== undefined) return result;
    } catch (error) {
      if (error instanceof FatalPollError) throw error;
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, cfg.pollIntervalMs));
  }
  throw new Error(`timed out waiting for ${label}`, { cause: lastError });
}

class FatalPollError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseCommand(line: string): RuntimeCommand {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch (error) {
    throw new Error('M1 operator command is not JSON', { cause: error });
  }
  const row = requiredRecord(parsed, 'M1 operator command');
  if (row['schema'] !== COMMAND_SCHEMA
    || row['protocol'] !== SELECTIVE_COVERAGE_RUNTIME_PROTOCOL
    || typeof row['sessionNonce'] !== 'string'
    || !/^[0-9a-f]{64}$/u.test(row['sessionNonce'])
    || !Number.isSafeInteger(row['sequence'])
    || (row['sequence'] as number) < 0
    || typeof row['command'] !== 'string') {
    throw new TypeError('M1 operator command envelope is invalid');
  }
  return {
    schema: COMMAND_SCHEMA,
    protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
    sessionNonce: row['sessionNonce'],
    sequence: row['sequence'] as number,
    command: row['command'],
    payload: requiredRecord(row['payload'], 'M1 operator command payload'),
  };
}

function emit(command: RuntimeCommand, ok: boolean, value: unknown): void {
  const result = ok
    ? { schema: RESULT_SCHEMA, protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
        sessionNonce: command.sessionNonce, sequence: command.sequence, ok: true, value }
    : { schema: RESULT_SCHEMA, protocol: SELECTIVE_COVERAGE_RUNTIME_PROTOCOL,
        sessionNonce: command.sessionNonce, sequence: command.sequence, ok: false, error: value };
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

function role(value: unknown): SelectiveCoverageRuntimeRole {
  if (value !== 'publisher' && value !== 'edge' && value !== 'core') {
    throw new TypeError('runtime role is invalid');
  }
  return value;
}

function wave(value: unknown): 'selected' | 'final' {
  if (value !== 'selected' && value !== 'final') throw new TypeError('publication wave is invalid');
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const row = looseRecord(value);
  if (!row) throw new TypeError(`${label} must be a plain object`);
  return row;
}

function looseRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${label} must be a string array`);
  }
  return [...value] as string[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
