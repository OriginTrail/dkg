import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');
const RUN_CLI_PRIVATE_CG_E2E = process.env.RUN_CLI_PRIVATE_CG_E2E === '1';

interface DaemonHandle {
  home: string;
  apiPort: number;
  listenPort: number;
  process?: ChildProcess;
}

async function ensureCliBuild() {
  if (!existsSync(CLI_ENTRY)) {
    await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
  }
}

function daemonEnv(home: string, apiPort: number) {
  return {
    ...process.env,
    DKG_HOME: home,
    DKG_API_PORT: String(apiPort),
    DKG_NO_BLUE_GREEN: '1',
  };
}

async function writeDaemonConfig(home: string, apiPort: number, listenPort: number, name: string, mockIdentityId: string) {
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      name,
      apiPort,
      listenPort,
      nodeRole: 'edge',
      auth: { enabled: false },
      store: {
        backend: 'oxigraph-worker',
        options: { path: join(home, 'store.nq') },
      },
      chain: {
        type: 'mock',
        rpcUrl: 'mock://local',
        hubAddress: '0x0000000000000000000000000000000000000000',
        chainId: 'mock:31337',
        mockIdentityId,
      },
      paranets: [],
    }),
  );
}

async function startDaemon(name: string, apiPort: number, listenPort: number, mockIdentityId: string): Promise<DaemonHandle> {
  const home = await mkdtemp(join(tmpdir(), `dkg-cli-private-cg-${name}-`));
  await writeDaemonConfig(home, apiPort, listenPort, name, mockIdentityId);
  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: daemonEnv(home, apiPort),
    stdio: 'ignore',
  });

  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${name} daemon exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
      if (response.ok) {
        return { home, apiPort, listenPort, process: child };
      }
    } catch {
      // wait for readiness
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  child.kill('SIGKILL');
  throw new Error(`${name} daemon did not become ready in time`);
}

async function stopDaemon(handle: DaemonHandle | undefined) {
  if (!handle?.process) return;
  const child = handle.process;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)).then(() => child.kill('SIGKILL')),
  ]);
  await rm(handle.home, { recursive: true, force: true });
}

async function runCli(handle: DaemonHandle, args: string[]) {
  return execFileAsync('node', [CLI_ENTRY, ...args], {
    env: daemonEnv(handle.home, handle.apiPort),
  });
}

async function postJson(handle: DaemonHandle, path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${handle.apiPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForCatchupDone(handle: DaemonHandle, contextGraphId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await runCli(handle, ['sync', 'catchup-status', contextGraphId]);
      if (stdout.includes('Status:        done')) return stdout;
      if (stdout.includes('Status:        failed')) {
        throw new Error(`catchup failed for ${contextGraphId}\n${stdout}`);
      }
    } catch {
      // queued/not found yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for catch-up on ${contextGraphId}`);
}

const describeCliPrivateCg = RUN_CLI_PRIVATE_CG_E2E ? describe.sequential : describe.skip;

describeCliPrivateCg('CLI E2E: private GuardianTest late join sync (opt-in)', () => {
  let curator: DaemonHandle;
  let syncerA: DaemonHandle;
  let syncerB: DaemonHandle;

  beforeAll(async () => {
    await ensureCliBuild();
    curator = await startDaemon('guardian-curator', 19311, 19411, '11');
    syncerA = await startDaemon('guardian-syncer-a', 19312, 19412, '12');
    syncerB = await startDaemon('guardian-syncer-b', 19313, 19413, '13');
  }, 60_000);

  afterAll(async () => {
    await stopDaemon(curator);
    await stopDaemon(syncerA);
    await stopDaemon(syncerB);
  }, 20_000);

  it('documents the full black-box flow using real daemons and mostly CLI commands', async () => {
    const curatorStatus = await (await fetch(`http://127.0.0.1:${curator.apiPort}/api/status`)).json() as { multiaddrs: string[] };
    const curatorAddr = curatorStatus.multiaddrs.find((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
    expect(curatorAddr).toBeTruthy();

    // There is currently no CLI `dkg connect <multiaddr>` command, so the black-box
    // test has to use the daemon API for peer dialing.
    await postJson(syncerA, '/api/connect', { multiaddr: curatorAddr });

    await runCli(curator, [
      'context-graph',
      'create',
      'GuardianTest',
      '--name',
      'GuardianTest',
      '--description',
      'CLI black-box late join sync scenario',
      '--private',
      '--participant-identity-id',
      '11',
      '--participant-identity-id',
      '12',
      '--participant-identity-id',
      '13',
    ]);

    // First invited syncer subscribes/catches up through the CLI.
    await runCli(syncerA, ['subscribe', 'GuardianTest']);
    await waitForCatchupDone(syncerA, 'GuardianTest');

    // Curator stages shared-memory data through the CLI using a real RDF file.
    const swmFile = join(curator.home, 'guardian-swm.nt');
    await writeFile(
      swmFile,
      [
        '<urn:e2e:guardian:swm:1> <http://schema.org/text> "Guardian shared memory" .',
        '<urn:e2e:guardian:swm:1> <http://schema.org/author> "curator" .',
      ].join('\n'),
    );
    const writeResult = await runCli(curator, ['shared-memory', 'write', 'GuardianTest', '--file', swmFile]);
    expect(writeResult.stdout).toContain('Written to shared memory for "GuardianTest"');

    // NOTE: exact durable private publish / async-publisher integration is not wired
    // here yet. This scaffold focuses on the
    // real daemon + CLI transport shape and the staggered catch-up mechanics.

    const earlyQuery = await runCli(
      syncerA,
      ['query', 'GuardianTest', '--sparql', 'SELECT ?text WHERE { <urn:e2e:guardian:swm:1> <http://schema.org/text> ?text }'],
    );
    expect(earlyQuery.stdout).toContain('Guardian shared memory');

    // Deliberately late join for the third participant.
    await postJson(syncerB, '/api/connect', { multiaddr: curatorAddr });
    await runCli(syncerB, ['subscribe', 'GuardianTest']);
    await waitForCatchupDone(syncerB, 'GuardianTest');

    const lateQuery = await runCli(
      syncerB,
      ['query', 'GuardianTest', '--sparql', 'SELECT ?text WHERE { <urn:e2e:guardian:swm:1> <http://schema.org/text> ?text }'],
    );
    expect(lateQuery.stdout).toContain('Guardian shared memory');
  }, 90_000);
});
