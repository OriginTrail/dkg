import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import {
  atomicWriteStableJson,
  readCleanRepositoryHead,
  stableJson,
} from './evidence.js';

const EVENT_PREFIX = 'RFC64_GATE0_EVENT ';
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const AGENT_PROCESS = join(import.meta.dirname, 'agent-process.ts');
const LEASE_PROBE = join(import.meta.dirname, 'lease-probe.ts');
const DEFAULT_ARTIFACT = join(import.meta.dirname, 'artifacts/gate0-result.json');
const CONTROL_ROOT_RELATIVE = 'rfc64-sync/control-objects-v1';
const INVENTORY_RELATIVE = 'rfc64-sync/inventory-v1.sqlite3';
const LEASE_RELATIVE = 'rfc64-sync/inventory-v1.lease.sqlite3';
const PROCESS_TIMEOUT_MS = 60_000;

interface ProcessEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

interface AgentHandle {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: ProcessEvent;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

interface ContentFileEvidence {
  readonly kind: 'object' | 'signature';
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mode: string | null;
}

interface ContentSnapshot {
  readonly counts: { readonly objects: number; readonly signatures: number };
  readonly inventoryFileMode: string | null;
  readonly leaseFileMode: string | null;
  readonly namespaceDirectoryModes: readonly {
    readonly relativePath: string;
    readonly mode: string | null;
  }[];
  readonly files: readonly ContentFileEvidence[];
}

function log(message: string): void {
  process.stdout.write(`[rfc64-gate0] ${message}\n`);
}

function parseEvent(line: string): ProcessEvent | null {
  if (!line.startsWith(EVENT_PREFIX)) return null;
  return JSON.parse(line.slice(EVENT_PREFIX.length)) as ProcessEvent;
}

function childArguments(script: string, extra: readonly string[] = []): string[] {
  return ['--experimental-sqlite', '--import', 'tsx', script, ...extra];
}

function spawnAgent(dataDir: string, stage: boolean): Promise<AgentHandle> {
  return new Promise((resolveReady, rejectReady) => {
    const child = spawn(process.execPath, childArguments(AGENT_PROCESS, stage ? ['--stage'] : []), {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DKG_RFC64_GATE0_DATA_DIR: dataDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectReady(new Error(`agent process timed out before ready\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, PROCESS_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        let event: ProcessEvent | null = null;
        try { event = parseEvent(line); } catch { /* parent reports complete output on timeout/exit */ }
        if (event?.event !== 'ready' || settled) continue;
        settled = true;
        clearTimeout(timeout);
        resolveReady({ child, ready: event, stdout: () => stdout, stderr: () => stderr });
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectReady(new Error(
        `agent exited before ready: code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ));
    });
  });
}

async function stopAgent(
  handle: AgentHandle,
  signal: 'SIGTERM' | 'SIGKILL',
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  const exit = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        handle.child.kill('SIGKILL');
        rejectExit(new Error(
          `agent did not exit after ${signal}\nstdout:\n${handle.stdout()}\nstderr:\n${handle.stderr()}`,
        ));
      }, PROCESS_TIMEOUT_MS);
      handle.child.once('exit', (code, exitSignal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal: exitSignal });
      });
    },
  );
  handle.child.kill(signal);
  return await exit;
}

async function probeLease(dataDir: string): Promise<ProcessEvent> {
  const child = spawn(process.execPath, childArguments(LEASE_PROBE), {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DKG_RFC64_GATE0_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        rejectExit(new Error(`lease probe timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, PROCESS_TIMEOUT_MS);
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolveExit({ code, signal });
      });
    },
  );
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`lease probe failed: ${JSON.stringify(exit)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  const event = stdout.split('\n').map(parseEvent).find((value) => value?.event === 'lease-probe');
  if (event === undefined) {
    throw new Error(`lease probe emitted no result\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return event;
}

function posixMode(path: string): string | null {
  if (process.platform === 'win32') return null;
  return (statSync(path).mode & 0o777).toString(8).padStart(4, '0');
}

function slashPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function walkDirectories(root: string): string[] {
  const directories: string[] = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(...walkDirectories(join(root, entry.name)));
  }
  return directories;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function sha256(bytes: Buffer): string {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

function snapshotContent(dataDir: string): ContentSnapshot {
  const controlRoot = join(dataDir, CONTROL_ROOT_RELATIVE);
  const files = walkFiles(controlRoot)
    .filter((path) => path.endsWith('.jcs'))
    .map((path): ContentFileEvidence => {
      const bytes = readFileSync(path);
      const controlRelative = slashPath(relative(controlRoot, path));
      const kind = controlRelative.startsWith('objects/') ? 'object' : 'signature';
      return {
        kind,
        relativePath: slashPath(relative(dataDir, path)),
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
        mode: posixMode(path),
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const namespaceDirectoryModes = walkDirectories(join(dataDir, 'rfc64-sync'))
    .map((path) => ({
      relativePath: slashPath(relative(dataDir, path)),
      mode: posixMode(path),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    counts: {
      objects: files.filter((file) => file.kind === 'object').length,
      signatures: files.filter((file) => file.kind === 'signature').length,
    },
    inventoryFileMode: posixMode(join(dataDir, INVENTORY_RELATIVE)),
    leaseFileMode: posixMode(join(dataDir, LEASE_RELATIVE)),
    namespaceDirectoryModes,
    files,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertReady(event: ProcessEvent, expectedStage: boolean): void {
  assert(event.agentClass === 'DKGAgent', 'child did not run the production DKGAgent class');
  assert(event.agentStarted === true, 'DKGAgent was not started');
  assert(event.inventoryOperational === true, 'agent-owned inventory operation failed');
  assert(event.persistenceClosed === false, 'agent-owned persistence was already closed');
  assert(event.verifiedRead === true, 'agent-owned control-object verification read failed');
  assert(event.staged === expectedStage, `unexpected staged=${String(event.staged)}`);
}

function assertLeaseBusy(event: ProcessEvent): void {
  assert(event.acquired === false, 'contender unexpectedly acquired the live inventory lease');
  assert(event.errorCode === 'database-busy', `contender failed with ${String(event.errorCode)}, not database-busy`);
}

function assertExactSnapshot(snapshot: ContentSnapshot): void {
  assert(snapshot.counts.objects === 1, `expected one object, got ${snapshot.counts.objects}`);
  assert(snapshot.counts.signatures === 1, `expected one signature, got ${snapshot.counts.signatures}`);
  if (process.platform !== 'win32') {
    assert(snapshot.inventoryFileMode === '0600', `inventory mode was ${snapshot.inventoryFileMode}`);
    assert(snapshot.leaseFileMode === '0600', `lease mode was ${snapshot.leaseFileMode}`);
    for (const file of snapshot.files) assert(file.mode === '0600', `${file.relativePath} mode was ${file.mode}`);
    for (const directory of snapshot.namespaceDirectoryModes) {
      assert(directory.mode === '0700', `${directory.relativePath} mode was ${directory.mode}`);
    }
  }
}

const artifactPath = resolve(process.env.DKG_RFC64_GATE0_ARTIFACT ?? DEFAULT_ARTIFACT);
const testedRepositoryHead = readCleanRepositoryHead(REPO_ROOT);
log(`testing clean repository HEAD ${testedRepositoryHead}`);
const dataDir = mkdtempSync(join(tmpdir(), 'dkg-rfc64-gate0-'));
const active = new Set<ChildProcessWithoutNullStreams>();

try {
  log('phase 1/3: start production DKGAgent and stage deterministic control object');
  const initial = await spawnAgent(dataDir, true);
  active.add(initial.child);
  initial.child.once('exit', () => active.delete(initial.child));
  assertReady(initial.ready, true);
  const initialProbe = await probeLease(dataDir);
  assertLeaseBusy(initialProbe);
  const initialSnapshot = snapshotContent(dataDir);
  assertExactSnapshot(initialSnapshot);
  const initialExit = await stopAgent(initial, 'SIGTERM');
  assert(initialExit.code === 0 && initialExit.signal === null, 'graceful stop did not exit cleanly');

  log('phase 2/3: restart, re-read exact bytes, then simulate unclean process death');
  const gracefulRestart = await spawnAgent(dataDir, false);
  active.add(gracefulRestart.child);
  gracefulRestart.child.once('exit', () => active.delete(gracefulRestart.child));
  assertReady(gracefulRestart.ready, false);
  const gracefulProbe = await probeLease(dataDir);
  assertLeaseBusy(gracefulProbe);
  const gracefulSnapshot = snapshotContent(dataDir);
  assertExactSnapshot(gracefulSnapshot);
  assert(
    stableJson(gracefulSnapshot.files) === stableJson(initialSnapshot.files),
    'durable control-object bytes changed across graceful restart',
  );
  const crashExit = await stopAgent(gracefulRestart, 'SIGKILL');
  assert(crashExit.code === null && crashExit.signal === 'SIGKILL', 'unclean stop was not SIGKILL');

  log('phase 3/3: recover OS lease, re-read and re-verify exact durable bytes');
  const recovered = await spawnAgent(dataDir, false);
  active.add(recovered.child);
  recovered.child.once('exit', () => active.delete(recovered.child));
  assertReady(recovered.ready, false);
  const recoveredProbe = await probeLease(dataDir);
  assertLeaseBusy(recoveredProbe);
  const recoveredSnapshot = snapshotContent(dataDir);
  assertExactSnapshot(recoveredSnapshot);
  assert(
    stableJson(recoveredSnapshot.files) === stableJson(initialSnapshot.files),
    'durable control-object bytes changed after OS-lease recovery',
  );
  const recoveredExit = await stopAgent(recovered, 'SIGTERM');
  assert(recoveredExit.code === 0 && recoveredExit.signal === null, 'recovered agent did not stop cleanly');

  const finalRepositoryHead = readCleanRepositoryHead(REPO_ROOT);
  assert(
    finalRepositoryHead === testedRepositoryHead,
    `repository HEAD changed during harness execution: ${testedRepositoryHead} -> ${finalRepositoryHead}`,
  );
  const artifact = {
    schemaVersion: 'dkg-rfc64-gate0-persistence-evidence-v2',
    gate: 'OT-RFC-64 Gate 0',
    productionBaselineCommit: testedRepositoryHead,
    invocation: 'pnpm test:gate0:rfc64-persistence-lifecycle',
    repository: {
      testedHeadCommit: testedRepositoryHead,
      trackedSourceCleanBeforeSpawn: true,
      trackedSourceCleanAfterProcesses: true,
    },
    runtimeBoundary: {
      agentClass: 'DKGAgent',
      processModel: 'three independent production agent processes',
      controlChannel: 'stdio and POSIX process signals only',
      publicDebugEndpointAdded: false,
    },
    fixture: {
      objectDigest: initial.ready.objectDigest,
      signatureVariantDigest: initial.ready.signatureVariantDigest,
      objectFileSha256: initialSnapshot.files.find((file) => file.kind === 'object')?.sha256,
      signatureFileSha256: initialSnapshot.files.find((file) => file.kind === 'signature')?.sha256,
    },
    phases: {
      initialRunningOwner: {
        inventoryOperational: initial.ready.inventoryOperational,
        namespaceDurability: initial.ready.namespaceDurability,
        contender: initialProbe,
        snapshot: initialSnapshot,
      },
      gracefulRestart: {
        priorExit: initialExit,
        verifiedRead: gracefulRestart.ready.verifiedRead,
        contender: gracefulProbe,
        exactContentFilesEqual: true,
        snapshot: gracefulSnapshot,
      },
      operatingSystemLeaseRecovery: {
        uncleanExit: crashExit,
        verifiedRead: recovered.ready.verifiedRead,
        contender: recoveredProbe,
        exactContentFilesEqual: true,
        finalGracefulExit: recoveredExit,
        snapshot: recoveredSnapshot,
      },
    },
    checks: {
      productionAgentStarted: true,
      inventoryOperationalWhileRunning: true,
      competingLeaseRejectedWhileRunning: true,
      gracefulRestartSucceeded: true,
      operatingSystemLeaseRecoveredAfterSigkill: true,
      durableControlObjectBytesPreserved: true,
      storedEnvelopeSignatureReverifiedOnEveryStart: true,
      exactObjectCount: 1,
      exactSignatureCount: 1,
      ownerOnlyFileModes: process.platform === 'win32' ? 'not-applicable' : true,
      publicRuntimeDebugEndpointAdded: false,
    },
    harnessChecksPassed: true,
    gateEvaluation: {
      status: 'not-evaluated',
      reason: 'final RFC-64 integration has not been assembled',
    },
  };
  const publication = atomicWriteStableJson(artifactPath, artifact);
  log(`harness checks complete; evidence written to ${artifactPath}`);
  log(`artifact publication durability: ${publication.durability}`);
  log(`artifact SHA-256: ${publication.sha256}`);
  log('Gate 0 remains not evaluated until the final RFC-64 integration is assembled');
} finally {
  for (const child of active) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  rmSync(dataDir, { recursive: true, force: true });
}
