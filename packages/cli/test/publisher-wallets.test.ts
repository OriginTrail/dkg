import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { DKGPublisher, type PublishOptions } from '@origintrail-official/dkg-publisher';
import { createKnowledgeAssetVmPublishExecutor } from '../src/daemon/lifecycle.js';
import { addPublisherWallet, loadPublisherWallets, publisherWalletsPath, removePublisherWallet } from '../src/publisher-wallets.js';
import { createPublisherInspector, createPublisherInspectorFromStore, createPublisherRuntime, createPublisherRuntimeFromAgent, startPublisherRuntimeIfEnabled } from '../src/publisher-runner.js';
import { parseOptionalPositiveInteger, parsePositiveIntegerOption, parsePositiveMsOption } from '../src/cli-option-parsers.js';

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

  it('boots and closes the standalone publisher runtime with the persistent fallback when config has no store block', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    await addPublisherWallet(dataDir, wallet.privateKey);

    const runtime = await createPublisherRuntime({
      dataDir,
      config: {
        name: 'test-node',
        apiPort: 9200,
        listenPort: 0,
        nodeRole: 'edge',
        contextGraphs: [],
        chain: { type: 'mock' },
      },
      pollIntervalMs: 10,
      errorBackoffMs: 10,
    });

    await runtime.publisher.lift({
      swmId: 'swm-main',
      shareOperationId: 'share-no-store-fallback',
      roots: ['urn:local:/fallback'],
      contextGraphId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:fallback' },
    });

    await runtime.stop();
    const persistentStore = await createTripleStore({
      backend: 'oxigraph-persistent',
      options: { path: join(dataDir, 'store.nq') },
    });
    const inspector = createPublisherInspectorFromStore(persistentStore, true);
    const jobs = await inspector.publisher.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobId).toBeDefined();
    await inspector.stop();
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
      expect(runtime.wallets).toMatchObject([{ address: wallet.address, identityId: 0n }]);
    } finally {
      await runtime?.stop();
      await store.close();
    }
  });

  it('processes a queued KA VM publish with an identityless publisher wallet', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-publisher-runtime-'));
    const wallet = ethers.Wallet.createRandom();
    const store = await createTripleStore({ backend: 'oxigraph' });
    const keypair = await generateEd25519Keypair();
    const { rpcUrl, hubAddress } = getSharedContext();
    let runtime: Awaited<ReturnType<typeof createPublisherRuntimeFromAgent>> | undefined;
    let agent: DKGAgent | undefined;

    await addPublisherWallet(dataDir, wallet.privateKey);
    await expect(createEVMAdapter(wallet.privateKey).getIdentityId()).resolves.toBe(0n);

    const writer = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
    });
    const share = await writer.share('music-social', [
      { subject: 'urn:local:/identityless-runtime', predicate: 'http://schema.org/name', object: '"Identityless Runtime"', graph: '' },
    ], { publisherPeerId: 'peer-identityless' });

    const agentChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const sealChainId = await agentChain.getEvmChainId();
    const sealKav10Address = await agentChain.getKnowledgeAssetsLifecycleAddress();
    agent = await DKGAgent.create({
      name: 'IdentitylessQueuedPublishAgent',
      listenHost: '127.0.0.1',
      listenPort: 0,
      bootstrapPeers: [],
      store,
      chainAdapter: agentChain,
    });

    try {
      const publishCalls: PublishOptions[] = [];
      const realExecutor = createKnowledgeAssetVmPublishExecutor(agent);
      type KnowledgeAssetVmPublishExecutorInput = Parameters<typeof realExecutor>[0];
      runtime = await createPublisherRuntimeFromAgent({
        dataDir,
        store,
        keypair,
        chainBase: { rpcUrl, hubAddress },
        pollIntervalMs: 10,
        errorBackoffMs: 10,
        knowledgeAssetVmPublishExecutor: async (input: KnowledgeAssetVmPublishExecutorInput) => {
          const publisher = input.publisher;
          if (!publisher) {
            throw new Error('identityless queued publish test expected a publisher override');
          }
          const originalPublish = publisher.publish.bind(publisher);
          publisher.publish = async (opts: PublishOptions) => {
            const publisherAddress = await publisher.publisherFallbackAuthorAddress();
            expect(publisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
            expect(publisher.getIdentityId()).toBe(0n);
            publishCalls.push(opts);
            return {
              status: 'tentative' as const,
              ual: 'did:dkg:test/identityless-runtime',
              merkleRoot: ethers.getBytes(opts.precomputedAttestation?.expectedMerkleRoot ?? `0x${'12'.repeat(32)}`),
              kaManifest: [],
            };
          };
          try {
            return await realExecutor({
              ...input,
              publishOptions: {
                ...input.publishOptions,
                publisherPeerId: 'peer-identityless-runtime',
                publishContextGraphId: '1',
              },
            });
          } finally {
            publisher.publish = originalPublish;
          }
        },
      });

      expect(runtime.wallets).toMatchObject([{ address: wallet.address, identityId: 0n }]);

      const intent = {
        contextGraphId: 'music-social',
        name: 'identityless-runtime',
        agentAddress: '0x00000000000000000000000000000000000000b2',
        shareOperationId: share.shareOperationId,
        roots: ['urn:local:/identityless-runtime'],
        seal: {
          merkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
          authorAddress: '0x1111111111111111111111111111111111111111' as `0x${string}`,
          signature: {
            r: `0x${'34'.repeat(32)}` as `0x${string}`,
            vs: `0x${'56'.repeat(32)}` as `0x${string}`,
          },
          schemeVersion: 1,
          reservedKaId: '0',
        },
        sealChainId: sealChainId.toString() as `${bigint}`,
        sealKav10Address: sealKav10Address as `0x${string}`,
        sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
        sealMerkleRoot: `0x${'12'.repeat(32)}` as `0x${string}`,
        publisherNodeIdentityIdOverride: '0',
        intentKey: `sha256:${'cd'.repeat(32)}`,
      };

      const jobId = await runtime.publisher.enqueueKnowledgeAssetVmPublish(intent);
      const processed = await runtime.publisher.processNext(wallet.address);

      expect(processed?.jobId).toBe(jobId);
      expect(publishCalls, JSON.stringify((processed as { failure?: unknown } | null)?.failure)).toHaveLength(1);
      expect(processed?.status, JSON.stringify((processed as { failure?: unknown } | null)?.failure)).toBe('finalized');
      expect(publishCalls[0]).toMatchObject({
        contextGraphId: 'music-social',
        publisherPeerId: 'peer-identityless-runtime',
        skipContextGraphEnsure: true,
      });
      expect(publishCalls[0]?.precomputedAttestation?.reservedKaId).toBe(0n);
      expect(publishCalls[0]?.quads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subject: 'urn:local:/identityless-runtime',
            graph: '',
          }),
        ]),
      );
    } finally {
      await runtime?.stop();
      await agent?.stop().catch(() => {});
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
      expect(runtime.wallets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ address: identityfulWallet.address, identityId: BigInt(getSharedContext().coreProfileId) }),
          expect.objectContaining({ address: identitylessWallet.address, identityId: 0n }),
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

      expect(runtime?.wallets).toMatchObject([{ address: wallet.address, identityId: 0n }]);
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
    expect(parsePositiveMsOption(' 1000 ', '--poll-interval')).toBe(1000);
    expect(() => parsePositiveMsOption('0', '--poll-interval')).toThrow(
      '--poll-interval must be a positive integer in milliseconds',
    );
    expect(() => parsePositiveMsOption('10ms', '--poll-interval')).toThrow(
      '--poll-interval must be a positive integer in milliseconds',
    );
    expect(() => parsePositiveMsOption('9007199254740992', '--poll-interval')).toThrow(
      '--poll-interval must be a positive integer in milliseconds',
    );
    expect(() => parsePositiveMsOption('nan', '--error-backoff')).toThrow(
      '--error-backoff must be a positive integer in milliseconds',
    );
  });

  it('validates positive integer CLI options', () => {
    expect(parsePositiveIntegerOption('10', '--max-retries')).toBe(10);
    expect(parsePositiveIntegerOption(' 10 ', '--max-retries')).toBe(10);
    expect(() => parsePositiveIntegerOption('0', '--max-retries')).toThrow(
      '--max-retries must be a positive integer',
    );
    expect(() => parsePositiveIntegerOption('1.5', '--max-retries')).toThrow(
      '--max-retries must be a positive integer',
    );
    expect(() => parsePositiveIntegerOption('9007199254740992', '--max-retries')).toThrow(
      '--max-retries must be a positive integer',
    );
  });

  it('validates optional positive integer CLI options', () => {
    expect(parseOptionalPositiveInteger(undefined, '--limit')).toBeUndefined();
    expect(parseOptionalPositiveInteger(' 25 ', '--limit')).toBe(25);
    expect(() => parseOptionalPositiveInteger('10items', '--limit')).toThrow(
      '--limit must be a positive integer',
    );
    expect(() => parseOptionalPositiveInteger('9007199254740992', '--limit')).toThrow(
      '--limit must be a positive integer',
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
