import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { publisherWalletsPath } from '../src/publisher-wallets.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');
const SMOKE_API_PORT = '19291';

describe.sequential('publisher CLI smoke', () => {
  let dkgHome: string;
  let daemon: ReturnType<typeof spawn> | undefined;

  beforeAll(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-cli-smoke-'));
    if (!existsSync(CLI_ENTRY)) {
      await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
    }
    await writeFile(join(dkgHome, 'smoke.nt'), '<urn:local:/rihana> <http://schema.org/name> "Rihana" .\n');
    await writeFile(
      join(dkgHome, 'config.json'),
      JSON.stringify({
        name: 'smoke-node',
        apiPort: Number.parseInt(SMOKE_API_PORT, 10),
        listenPort: 0,
        nodeRole: 'edge',
        paranets: [],
        auth: { enabled: false },
        store: {
          backend: 'oxigraph-worker',
          options: { path: join(dkgHome, 'store.nq') },
        },
      }),
    );
  });

  afterAll(async () => {
    if (daemon) {
      daemon.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => daemon?.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)).then(() => {
          daemon?.kill('SIGKILL');
        }),
      ]);
    }
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('supports wallet add, enable, jobs, and job payload inspection', async () => {
    const wallet = ethers.Wallet.createRandom();
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: SMOKE_API_PORT };

    await execFileAsync('node', [CLI_ENTRY, 'publisher', 'wallet', 'add', wallet.privateKey], { env });
    const walletList = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'wallet', 'list'], { env });
    expect(walletList.stdout).toContain(wallet.address);
    expect(walletList.stdout).toContain(publisherWalletsPath(dkgHome));

    const enabled = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'enable', '--poll-interval', '1000', '--error-backoff', '1000'], { env });
    expect(enabled.stdout).toContain('Async publisher enabled');
    const disabled = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'disable'], { env });
    expect(disabled.stdout).toContain('Async publisher disabled');

    daemon = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
      env,
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 120; i += 1) {
      if (daemon.exitCode !== null) {
        throw new Error(`daemon-worker exited early with code ${daemon.exitCode}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${SMOKE_API_PORT}/api/status`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // wait for daemon readiness
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(ready).toBe(true);

    const staged = await execFileAsync('node', [CLI_ENTRY, 'shared-memory', 'write', 'music-social', '--file', join(dkgHome, 'smoke.nt')], { env });
    expect(staged.stdout).toContain('Written to shared memory for "music-social":');
    const stagedMatch = staged.stdout.match(/Share operation:\s+(\S+)/);
    expect(stagedMatch?.[1]).toBeDefined();
    const shareOperationId = stagedMatch![1];

    // Stop the daemon before publisher file-based commands. The daemon's
    // in-memory Oxigraph store can flush to the same .nq file and overwrite
    // data written by the CLI's own store instances, causing flaky "not found".
    // Use the /api/shutdown endpoint for an orderly exit, then wait for the
    // process to terminate — this gives the store's 50ms debounced flush time
    // to persist shared-memory data before the process exits.
    const daemonExited = daemon.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => daemon?.once('exit', resolve));
    const killTimeout = setTimeout(() => { daemon?.kill('SIGKILL'); }, 5000);
    await fetch(`http://127.0.0.1:${SMOKE_API_PORT}/api/shutdown`, { method: 'POST' }).catch(() => {});
    await daemonExited;
    clearTimeout(killTimeout);
    daemon = undefined;

    const enqueue = await execFileAsync('node', [
      CLI_ENTRY,
      'publisher',
      'enqueue',
      'music-social',
      '--share-operation-id',
      shareOperationId,
      '--root',
      'urn:local:/rihana',
      '--namespace',
      'aloha',
      '--scope',
      'person-profile',
      '--authority-proof-ref',
      'proof:owner:1',
    ], { env });
    const match = enqueue.stdout.match(/Job ID:\s+(\S+)/);
    expect(match?.[1]).toBeDefined();
    const jobId = match![1];

    const jobs = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'jobs'], { env });
    expect(jobs.stdout).toContain(jobId);
    expect(jobs.stdout).toMatch(/accepted|claimed|validated|broadcast|included|finalized|failed/);

    await expect(
      execFileAsync('node', [CLI_ENTRY, 'publisher', 'jobs', '--status', 'bogus'], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Invalid publisher job status: bogus'),
    });

    const job = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'job', jobId], { env });
    expect(job.stdout).toContain(jobId);
    expect(job.stdout).toContain('"status":');
    expect(job.stdout).toContain('jobSlug');

    let payload: Awaited<ReturnType<typeof execFileAsync>> | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        payload = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'job', jobId, '--payload'], { env });
        break;
      } catch (error: any) {
        const stderr = String(error?.stderr ?? '');
        if (!stderr.includes('No shared-memory roots found')) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(payload).toBeDefined();
    if (!payload) {
      throw new Error('publisher job --payload did not become available in time');
    }
    expect(payload.stdout).toContain('"status": "accepted"');
    expect(payload.stdout).toContain('publishOptions');
    expect(payload.stdout).toContain('music-social');
  }, 45000);
});
