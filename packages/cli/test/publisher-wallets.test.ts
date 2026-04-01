import { describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { addPublisherWallet, loadPublisherWallets, publisherWalletsPath, removePublisherWallet } from '../src/publisher-wallets.js';
import { createPublisherInspector, createPublisherRuntime, createPublisherRuntimeFromAgent, parsePositiveMsOption } from '../src/publisher-runner.js';

describe('publisher wallets', () => {
  it('adds, loads, and removes publisher wallets', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-wallets-'));
    const wallet = ethers.Wallet.createRandom();

    const added = await addPublisherWallet(dataDir, wallet.privateKey);
    expect(added.wallets).toHaveLength(1);
    expect(added.wallets[0]?.address).toBe(wallet.address);

    const loaded = await loadPublisherWallets(dataDir);
    expect(loaded.wallets).toHaveLength(1);
    expect(loaded.wallets[0]?.address).toBe(wallet.address);

    const removed = await removePublisherWallet(dataDir, wallet.address);
    expect(removed.wallets).toHaveLength(0);
  });

  it('rejects duplicate publisher wallets', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-wallets-'));
    const wallet = ethers.Wallet.createRandom();

    await addPublisherWallet(dataDir, wallet.privateKey);
    await expect(addPublisherWallet(dataDir, wallet.privateKey)).rejects.toThrow(
      `Publisher wallet already exists: ${wallet.address}`,
    );
  });

  it('rejects malformed publisher wallet files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-wallets-'));
    await writeFile(publisherWalletsPath(dataDir), '{bad json\n', 'utf-8');

    await expect(loadPublisherWallets(dataDir)).rejects.toThrow();
  });

  it('rejects address/private-key mismatches in publisher-wallets.json', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-wallets-'));
    const wallet = ethers.Wallet.createRandom();
    await writeFile(
      publisherWalletsPath(dataDir),
      JSON.stringify({ wallets: [{ address: '0x1111111111111111111111111111111111111111', privateKey: wallet.privateKey }] }),
      'utf-8',
    );

    await expect(loadPublisherWallets(dataDir)).rejects.toThrow('Address mismatch in publisher-wallets.json');
  });

  it('removing a missing publisher wallet fails clearly', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-wallets-'));

    await expect(removePublisherWallet(dataDir, '0x1111111111111111111111111111111111111111')).rejects.toThrow(
      'Publisher wallet not found',
    );
  });

  it('enforces secure publisher wallet file permissions on save', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-wallets-'));
    const wallet = ethers.Wallet.createRandom();

    await addPublisherWallet(dataDir, wallet.privateKey);
    await chmod(publisherWalletsPath(dataDir), 0o644);
    await addPublisherWallet(dataDir, ethers.Wallet.createRandom().privateKey);

    const stats = await import('node:fs/promises').then((fs) => fs.stat(publisherWalletsPath(dataDir)));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('fails runner bootstrap when no publisher wallets are configured', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));

    await expect(
      createPublisherRuntime({
        dataDir,
        config: {
          name: 'test-node',
          apiPort: 9200,
          listenPort: 0,
          nodeRole: 'edge',
          paranets: [],
          store: { backend: 'oxigraph' },
        },
      }),
    ).rejects.toThrow('No publisher wallets configured. Use `dkg publisher wallet add <privateKey>` first.');
  });

  it('surfaces actionable guidance when no publisher wallets are configured', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));

    await expect(
      createPublisherRuntime({
        dataDir,
        config: {
          name: 'test-node',
          apiPort: 9200,
          listenPort: 0,
          nodeRole: 'edge',
          paranets: [],
          store: { backend: 'oxigraph' },
        },
      }),
    ).rejects.toThrow('dkg publisher wallet add <privateKey>');
  });

  it('bootstraps publisher runtime from an existing agent store', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();

    await addPublisherWallet(dataDir, wallet.privateKey);

    const runtime = await createPublisherRuntimeFromAgent({
      dataDir,
      store,
      keypair,
      chainBase: undefined,
      pollIntervalMs: 10,
      errorBackoffMs: 10,
    });

    expect(runtime.walletIds).toEqual([wallet.address]);
    await runtime.stop();
    await store.close();
  });

  it('validates positive millisecond CLI options', () => {
    expect(parsePositiveMsOption('1000', '--poll-interval')).toBe(1000);
    expect(() => parsePositiveMsOption('0', '--poll-interval')).toThrow(
      '--poll-interval must be a positive integer in milliseconds',
    );
    expect(() => parsePositiveMsOption('nan', '--error-backoff')).toThrow(
      '--error-backoff must be a positive integer in milliseconds',
    );
  });

  it('can inspect persisted publisher jobs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-inspector-'));
    const inspector = await createPublisherInspector({
      dataDir,
      config: {
        name: 'test-node',
        apiPort: 9200,
        listenPort: 0,
        nodeRole: 'edge',
        paranets: [],
        store: { backend: 'oxigraph' },
      },
    });

    await inspector.publisher.lift({
      workspaceId: 'workspace-main',
      workspaceOperationId: 'ws-1',
      roots: ['urn:local:/rihana'],
      paranetId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    });

    const jobs = await inspector.publisher.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('accepted');
    expect(jobs[0]?.jobId).toBeDefined();

    const job = await inspector.publisher.getStatus(jobs[0]!.jobId);
    expect(job?.jobId).toBe(jobs[0]?.jobId);
    expect(job?.jobSlug).toContain('music-social/person-profile/create/ws-1/');

    await inspector.stop();
  });
});
