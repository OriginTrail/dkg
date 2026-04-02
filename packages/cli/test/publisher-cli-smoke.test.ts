import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
    await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
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
    for (let i = 0; i < 40; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${SMOKE_API_PORT}/api/status`);
        if (response.ok) {
          break;
        }
      } catch {
        // wait for daemon readiness
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const staged = await execFileAsync('node', [CLI_ENTRY, 'publish', 'music-social', '--file', join(dkgHome, 'smoke.nt'), '--workspace'], { env });
    expect(staged.stdout).toContain('Staged to workspace for "music-social":');
    const stagedMatch = staged.stdout.match(/Workspace operation:\s+(\S+)/);
    expect(stagedMatch?.[1]).toBeDefined();
    const workspaceOperationId = stagedMatch![1];

    const enqueue = await execFileAsync('node', [
      CLI_ENTRY,
      'publisher',
      'enqueue',
      'music-social',
      '--workspace-operation-id',
      workspaceOperationId,
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

    const payload = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'job', jobId, '--payload'], { env });
    expect(payload.stdout).toContain('"status": "accepted"');
    expect(payload.stdout).toContain('"failure":');
    expect(payload.stdout).toContain('publishOptions');
    expect(payload.stdout).toContain('music-social');

    daemon.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => daemon?.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)).then(() => {
        daemon?.kill('SIGKILL');
      }),
    ]);
    daemon = undefined;
  }, 30000);
});
