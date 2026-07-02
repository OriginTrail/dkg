import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { DKGPublisher } from '@origintrail-official/dkg-publisher';
import { addPublisherWallet, loadPublisherWallets, publisherWalletsPath, removePublisherWallet } from '../src/publisher-wallets.js';
import { createPublisherInspector, createPublisherInspectorFromStore, createPublisherRuntime, createPublisherRuntimeFromAgent, startPublisherRuntimeIfEnabled } from '../src/publisher-runner.js';
import { parsePositiveIntegerOption, parsePositiveMsOption } from '../src/cli-option-parsers.js';

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

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

    await expect(loadPublisherWallets(dataDir)).rejects.toThrow(
      /json|parse|parsing|malformed|unexpected|invalid|syntax/i,
    );
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

  it('reaps a stale publisher wallet lock from a dead process', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-wallets-'));
    const wallet = ethers.Wallet.createRandom();
    const lockPath = `${publisherWalletsPath(dataDir)}.lock`;

    await writeFile(lockPath, JSON.stringify({ pid: 999999, createdAt: Date.now() - 10 * 60 * 1000 }), 'utf-8');

    const result = await addPublisherWallet(dataDir, wallet.privateKey);
    expect(result.wallets).toHaveLength(1);
    expect(result.wallets[0]?.address).toBe(wallet.address);
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
          contextGraphs: [],
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
          contextGraphs: [],
          store: { backend: 'oxigraph' },
        },
      }),
    ).rejects.toThrow('dkg publisher wallet add <privateKey>');
  });

  it('resolves publisher chain defaults from config.networkConfig', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    await addPublisherWallet(dataDir, wallet.privateKey);

    // Selecting a still-pre-deployment mainnet must surface the network
    // readiness gate before any chain wiring. NeuroWeb is the remaining gated
    // chain (Base + Gnosis were un-gated in #1292), so use it here.
    await expect(
      createPublisherRuntime({
        dataDir,
        config: {
          name: 'test-node',
          networkConfig: 'mainnet-neuroweb',
          apiPort: 9200,
          listenPort: 0,
          nodeRole: 'edge',
          contextGraphs: [],
          store: { backend: 'oxigraph' },
        },
      }),
    ).rejects.toThrow(/DKG V10 NeuroWeb Mainnet is marked pre-deployment/);
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

  it('passes v10ACKProvider through the daemon-integrated async runtime when supplied', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();

    await addPublisherWallet(dataDir, wallet.privateKey);

    const writer = new DKGPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const write = await writer.writeToWorkspace('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    let v10ACKProviderWasPassed = false;
    const runtime = await createPublisherRuntimeFromAgent({
      dataDir,
      store,
      keypair,
      chainBase: undefined,
      pollIntervalMs: 10,
      errorBackoffMs: 10,
      maxRetries: 10,
      v10ACKProviderFactory: () => {
        v10ACKProviderWasPassed = true;
        return async () => [];
      },
    });

    const jobId = await runtime.publisher.lift({
      swmId: 'swm-main',
      shareOperationId: write.shareOperationId,
      roots: ['urn:local:/rihana'],
      contextGraphId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    });
    expect((await runtime.publisher.getStatus(jobId))?.retries.maxRetries).toBe(10);

    const processed = await runtime.publisher.processNext(wallet.address);

    expect(v10ACKProviderWasPassed).toBe(true);
    expect(processed).not.toBeNull();

    await runtime.stop();
    await store.close();
  });

  it('bootstraps publisher runtime with an identityless publisher wallet on a reachable chain', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    const { rpcUrl, hubAddress } = getSharedContext();
    let runtime: Awaited<ReturnType<typeof createPublisherRuntimeFromAgent>> | undefined;

    await addPublisherWallet(dataDir, wallet.privateKey);
    await expect(createEVMAdapter(wallet.privateKey).getIdentityId()).resolves.toBe(0n);

    try {
      runtime = await createPublisherRuntimeFromAgent({
        dataDir,
        store,
        keypair,
        chainBase: { rpcUrl, hubAddress },
        pollIntervalMs: 10,
        errorBackoffMs: 10,
      });

      expect(runtime.walletIds).toEqual([wallet.address]);
      expect(runtime.walletIdentities).toEqual([{ address: wallet.address, identityId: 0n }]);
    } finally {
      await runtime?.stop();
      await store.close();
    }
  });

  it('does not skip identityless wallets in a mixed publisher wallet pool', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const identityfulWallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    const identitylessWallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    const { rpcUrl, hubAddress } = getSharedContext();
    let runtime: Awaited<ReturnType<typeof createPublisherRuntimeFromAgent>> | undefined;

    await addPublisherWallet(dataDir, identityfulWallet.privateKey);
    await addPublisherWallet(dataDir, identitylessWallet.privateKey);

    try {
      runtime = await createPublisherRuntimeFromAgent({
        dataDir,
        store,
        keypair,
        chainBase: { rpcUrl, hubAddress },
        pollIntervalMs: 10,
        errorBackoffMs: 10,
      });

      expect(new Set(runtime.walletIds)).toEqual(new Set([identityfulWallet.address, identitylessWallet.address]));
      expect(runtime.walletIdentities).toEqual(
        expect.arrayContaining([
          { address: identityfulWallet.address, identityId: BigInt(getSharedContext().coreProfileId) },
          { address: identitylessWallet.address, identityId: 0n },
        ]),
      );
    } finally {
      await runtime?.stop();
      await store.close();
    }
  });

  it('reports publisher wallet attribution through the daemon startup logger', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    const logs: string[] = [];
    let runtime: Awaited<ReturnType<typeof startPublisherRuntimeIfEnabled>> | undefined;

    await addPublisherWallet(dataDir, wallet.privateKey);

    try {
      runtime = await startPublisherRuntimeIfEnabled({
        dataDir,
        config: {
          name: 'test-node',
          apiPort: 9200,
          listenPort: 0,
          nodeRole: 'edge',
          contextGraphs: [],
          publisher: { enabled: true },
        },
        store,
        keypair,
        chainBase: undefined,
        log: (message) => logs.push(message),
      });

      expect(runtime?.walletIdentities).toEqual([{ address: wallet.address, identityId: 0n }]);
      expect(logs.join('\n')).toContain('no-attribution mode');
      expect(logs.join('\n')).toContain(wallet.address);
    } finally {
      await runtime?.stop();
      await store.close();
    }
  });

  it('skips daemon-integrated publisher startup with a warning when no wallets exist', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    const logs: string[] = [];

    const runtime = await startPublisherRuntimeIfEnabled({
      dataDir,
      config: {
        name: 'test-node',
        apiPort: 9200,
        listenPort: 0,
        nodeRole: 'edge',
        contextGraphs: [],
        publisher: { enabled: true },
      },
      store,
      keypair,
      chainBase: undefined,
      log: (message) => logs.push(message),
    });

    expect(runtime).toBeNull();
    expect(logs.join('\n')).toContain('Publisher startup skipped');
    expect(logs.join('\n')).toContain('dkg publisher wallet add <privateKey>');
    await store.close();
  });

  it('keeps chain RPC failures hard during publisher wallet identity resolution', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();

    await addPublisherWallet(dataDir, wallet.privateKey);

    await expect(
      createPublisherRuntimeFromAgent({
        dataDir,
        store,
        keypair,
        chainBase: {
          rpcUrl: 'http://127.0.0.1:65535',
          hubAddress: '0x1111111111111111111111111111111111111111',
        },
      }),
    ).rejects.toThrow(/connect|refused|ECONNREFUSED|rpc|provider|network|fetch|timeout|url|unreachable|chain/i);

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

  it('validates positive integer CLI options', () => {
    expect(parsePositiveIntegerOption('10', '--max-retries')).toBe(10);
    expect(() => parsePositiveIntegerOption('0', '--max-retries')).toThrow(
      '--max-retries must be a positive integer',
    );
  });

  it('can inspect persisted publisher jobs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-inspector-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const inspector = createPublisherInspectorFromStore(store, false);
    const keypair = await generateEd25519Keypair();
    const dkgPublisher = new DKGPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const write = await dkgPublisher.writeToWorkspace('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    await inspector.publisher.lift({
      swmId: 'swm-main',
      shareOperationId: write.shareOperationId,
      roots: ['urn:local:/rihana'],
      contextGraphId: 'music-social',
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
    expect(job?.jobSlug).toContain('music-social/person-profile/create/');
    expect(job?.jobSlug).toContain('/rihana');

    const payload = await inspector.publisher.inspectPreparedPayload(jobs[0]!.jobId);
    expect(payload?.contextGraphId).toBe('music-social');
    expect(payload?.publishOptions.quads.length).toBeGreaterThan(0);
    expect(payload?.subtraction?.alreadyPublishedPublicCount).toBe(0);

    await inspector.stop();
    await store.close();
  });
});
