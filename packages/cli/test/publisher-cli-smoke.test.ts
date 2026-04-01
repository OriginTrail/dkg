import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { generateEd25519Keypair, TypedEventBus } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { publisherWalletsPath } from '../src/publisher-wallets.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

describe.sequential('publisher CLI smoke', () => {
  let dkgHome: string;

  beforeAll(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-cli-smoke-'));
    await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
    await writeFile(
      join(dkgHome, 'config.json'),
      JSON.stringify({
        name: 'smoke-node',
        apiPort: 9200,
        listenPort: 0,
        nodeRole: 'edge',
        paranets: [],
        store: {
          backend: 'oxigraph-worker',
          options: { path: join(dkgHome, 'store.nq') },
        },
      }),
    );
  });

  afterAll(async () => {
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('supports wallet add, enable, jobs, and job payload inspection', async () => {
    const wallet = ethers.Wallet.createRandom();
    const env = { ...process.env, DKG_HOME: dkgHome };

    await execFileAsync('node', [CLI_ENTRY, 'publisher', 'wallet', 'add', wallet.privateKey], { env });
    const walletList = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'wallet', 'list'], { env });
    expect(walletList.stdout).toContain(wallet.address);
    expect(walletList.stdout).toContain(publisherWalletsPath(dkgHome));

    const enabled = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'enable', '--poll-interval', '1000', '--error-backoff', '1000'], { env });
    expect(enabled.stdout).toContain('Async publisher enabled');

    const store = await createTripleStore({
      backend: 'oxigraph-worker',
      options: { path: join(dkgHome, 'store.nq') },
    });
    const keypair = await generateEd25519Keypair();
    const dkgPublisher = new DKGPublisher({
      store,
      chain: new MockChainAdapter('mock:31337', wallet.address),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
    const write = await dkgPublisher.writeToWorkspace('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });
    const inspector = new (await import('@origintrail-official/dkg-publisher')).TripleStoreAsyncLiftPublisher(store);
    const jobId = await inspector.lift({
      workspaceId: 'workspace-main',
      workspaceOperationId: write.workspaceOperationId,
      roots: ['urn:local:/rihana'],
      paranetId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    });

    const jobs = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'jobs'], { env });
    expect(jobs.stdout).toContain(jobId);
    expect(jobs.stdout).toContain('accepted');

    await expect(
      execFileAsync('node', [CLI_ENTRY, 'publisher', 'jobs', '--status', 'bogus'], { env }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Invalid publisher job status: bogus'),
    });

    const job = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'job', jobId], { env });
    expect(job.stdout).toContain(jobId);
    expect(job.stdout).toContain('jobSlug');

    const payload = await execFileAsync('node', [CLI_ENTRY, 'publisher', 'job', jobId, '--payload'], { env });
    expect(payload.stdout).toContain('publishOptions');
    expect(payload.stdout).toContain('music-social');

    await store.close();
  });
});
