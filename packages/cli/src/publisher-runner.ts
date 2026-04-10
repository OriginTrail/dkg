import { join } from 'node:path';
import { DKGAgentWallet } from '@origintrail-official/dkg-agent';
import { EVMChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import { ACKCollector, AsyncLiftRunner, DKGPublisher, TripleStoreAsyncLiftPublisher, type AsyncLiftPublishExecutionInput, type AsyncLiftPublisher, type AsyncLiftPublisherRecoveryResult, type LiftJobBroadcast, type LiftJobIncluded, type PublishOptions } from '@origintrail-official/dkg-publisher';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { loadNetworkConfig, type DkgConfig } from './config.js';
import { loadPublisherWallets } from './publisher-wallets.js';

export interface PublisherRuntime {
  readonly runner: AsyncLiftRunner;
  readonly publisher: AsyncLiftPublisher;
  readonly walletIds: string[];
  readonly stop: () => Promise<void>;
}

export interface PublisherInspector {
  readonly publisher: AsyncLiftPublisher;
  readonly stop: () => Promise<void>;
}

interface ACKTransportFactory {
  publisherPeerId: string;
  gossipPublish: (topic: string, data: Uint8Array) => Promise<void>;
  sendP2P: (peerId: string, protocol: string, data: Uint8Array) => Promise<Uint8Array>;
  getConnectedCorePeers: () => string[];
  log?: (message: string) => void;
}

export async function startPublisherRuntimeIfEnabled(args: {
  dataDir: string;
  config: DkgConfig;
  store: TripleStore;
  keypair: Ed25519Keypair;
  chainBase?: {
    rpcUrl: string;
    hubAddress: string;
    chainId?: string;
  };
  log: (message: string) => void;
  ackTransportFactory?: () => ACKTransportFactory;
}): Promise<PublisherRuntime | null> {
  if (!args.config.publisher?.enabled) {
    return null;
  }

  try {
    const runtime = await createPublisherRuntimeFromAgent({
      dataDir: args.dataDir,
      store: args.store,
      keypair: args.keypair,
      chainBase: args.chainBase,
      pollIntervalMs: args.config.publisher.pollIntervalMs,
      errorBackoffMs: args.config.publisher.errorBackoffMs,
        ackTransportFactory: args.ackTransportFactory,
    });
    await runtime.runner.start();
    args.log(`Async publisher runner started (${runtime.walletIds.length} wallet${runtime.walletIds.length === 1 ? '' : 's'})`);
    return runtime;
  } catch (err: any) {
    const message = err?.message ?? String(err);
    if (message.includes('No publisher wallets configured')) {
      args.log(`Publisher startup skipped: ${message}`);
      args.log('Add a wallet with `dkg publisher wallet add <privateKey>` and re-enable publisher startup if needed.');
      return null;
    }
    throw err;
  }
}

interface PublisherRuntimeBaseArgs {
  dataDir: string;
  keypair: Ed25519Keypair;
  store: TripleStore;
  chainBase?: {
    rpcUrl: string;
    hubAddress: string;
    chainId?: string;
  };
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  ackTransportFactory?: () => ACKTransportFactory;
  closeStoreOnStop: boolean;
}

export async function createPublisherRuntime(args: {
  dataDir: string;
  config: DkgConfig;
  pollIntervalMs?: number;
  errorBackoffMs?: number;
}): Promise<PublisherRuntime> {
  const publisherWallets = await loadPublisherWallets(args.dataDir);
  if (publisherWallets.wallets.length === 0) {
    throw new Error('No publisher wallets configured. Use `dkg publisher wallet add <privateKey>` first.');
  }

  const network = await loadNetworkConfig();
  const keypair = await loadOrCreateAgentWallet(args.dataDir);
  const store = await createPublisherStore(args.dataDir, args.config);
  return createPublisherRuntimeFromBase({
    dataDir: args.dataDir,
    keypair: keypair.keypair,
    store,
    chainBase: args.config.chain ?? network?.chain,
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
    closeStoreOnStop: true,
  });
}

export async function createPublisherInspector(args: {
  dataDir: string;
  config: DkgConfig;
}): Promise<PublisherInspector> {
  const store = await createPublisherStore(args.dataDir, args.config);
  return createPublisherInspectorFromStore(store, true);
}

export function createPublisherInspectorFromStore(store: TripleStore, closeStoreOnStop = false): PublisherInspector {
  return {
    publisher: new TripleStoreAsyncLiftPublisher(store),
    stop: async () => {
      if (closeStoreOnStop) {
        await store.close();
      }
    },
  };
}

export function createPublisherControlFromStore(store: TripleStore): AsyncLiftPublisher {
  return new TripleStoreAsyncLiftPublisher(store);
}

export async function createPublisherRuntimeFromAgent(args: {
  dataDir: string;
  store: TripleStore;
  keypair: Ed25519Keypair;
  chainBase?: {
    rpcUrl: string;
    hubAddress: string;
    chainId?: string;
  };
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  ackTransportFactory?: () => ACKTransportFactory;
}): Promise<PublisherRuntime> {
  return createPublisherRuntimeFromBase({
    dataDir: args.dataDir,
    keypair: args.keypair,
    store: args.store,
    chainBase: args.chainBase,
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
      ackTransportFactory: args.ackTransportFactory,
    closeStoreOnStop: false,
  });
}

async function createPublisherRuntimeFromBase(args: PublisherRuntimeBaseArgs): Promise<PublisherRuntime> {
  const publisherWallets = await loadPublisherWallets(args.dataDir);
  if (publisherWallets.wallets.length === 0) {
    throw new Error('No publisher wallets configured. Use `dkg publisher wallet add <privateKey>` first.');
  }

  const eventBus = new TypedEventBus();
  const publishers = new Map<string, DKGPublisher>();
  const invalidWallets: string[] = [];

  for (const wallet of publisherWallets.wallets) {
    const chain = args.chainBase
      ? new EVMChainAdapter({
          rpcUrl: args.chainBase.rpcUrl,
          privateKey: wallet.privateKey,
          hubAddress: args.chainBase.hubAddress,
          chainId: args.chainBase.chainId,
        })
      : new NoChainAdapter();
    const identityId = await chain.getIdentityId();
    if (args.chainBase && identityId === 0n) {
      invalidWallets.push(wallet.address);
      continue;
    }
    publishers.set(
      wallet.address,
      new DKGPublisher({
        store: args.store,
        chain,
        eventBus,
        keypair: args.keypair,
        publisherNodeIdentityId: identityId,
        publisherPrivateKey: wallet.privateKey,
      }),
    );
  }

  if (invalidWallets.length > 0) {
    const noun = invalidWallets.length === 1 ? 'wallet is' : 'wallets are';
    throw new Error(
      `Publisher startup blocked: the following publisher ${noun} missing an on-chain identity: ${invalidWallets.join(', ')}. ` +
      'Run `dkg identity create` for each wallet or remove it from publisher-wallets.json.',
    );
  }

  const asyncPublisher = new TripleStoreAsyncLiftPublisher(args.store, {
    chainRecoveryResolver: createChainRecoveryResolver(publishers),
    publishExecutor: async ({ walletId, publishOptions }: AsyncLiftPublishExecutionInput) => {
      const publisher = publishers.get(walletId);
      if (!publisher) {
        throw new Error(`No publisher configured for wallet ${walletId}`);
      }
      const v10ACKProvider = publishOptions.v10ACKProvider
        ?? createV10ACKProviderForPublisher(publisher, args.ackTransportFactory?.());
      const publishOptionsWithACKs = v10ACKProvider
        ? { ...publishOptions, v10ACKProvider }
        : publishOptions;
      const chain = (publisher as unknown as { chain?: { createKnowledgeAssetsV10?: unknown } }).chain;
      if (chain && typeof chain.createKnowledgeAssetsV10 === 'function' && !publishOptionsWithACKs.v10ACKProvider) {
        throw new Error(
          'Async publisher cannot publish to a V10 ACK-gated chain without a v10ACKProvider. ' +
          'Use the synchronous agent publish path or add ACK collection support to the async runtime.',
        );
      }
      return await publisher.publish(publishOptionsWithACKs);
    },
  });

  const runner = new AsyncLiftRunner({
    publisher: asyncPublisher,
    walletIds: publisherWallets.wallets.map((wallet) => wallet.address),
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
    hasIncludedRecoveryResolver: true,
  });

  return {
    runner,
    publisher: asyncPublisher,
    walletIds: publisherWallets.wallets.map((wallet) => wallet.address),
    stop: async () => {
      await runner.stop();
      if (args.closeStoreOnStop) {
        await args.store.close();
      }
    },
  };
}

function createV10ACKProviderForPublisher(
  publisher: DKGPublisher,
  transport?: ACKTransportFactory,
): PublishOptions['v10ACKProvider'] | undefined {
  if (!transport) return undefined;
  const chain = (publisher as unknown as {
    chain?: {
      createKnowledgeAssetsV10?: unknown;
      verifyACKIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
      getMinimumRequiredSignatures?: () => Promise<number>;
    };
  }).chain;
  if (!chain || typeof chain.createKnowledgeAssetsV10 !== 'function') return undefined;
  if (typeof chain.verifyACKIdentity !== 'function') return undefined;

  const collector = new ACKCollector({
    gossipPublish: transport.gossipPublish,
    sendP2P: transport.sendP2P,
    getConnectedCorePeers: transport.getConnectedCorePeers,
    verifyIdentity: async (recoveredAddress: string, claimedIdentityId: bigint) => chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId),
    log: transport.log,
  });

  return async (
    merkleRoot,
    contextGraphId,
    kaCount,
    rootEntities,
    publicByteSize,
    stagingQuads,
    epochs,
    tokenAmount,
  ) => {
    let cgIdBigInt: bigint;
    try {
      cgIdBigInt = BigInt(contextGraphId);
    } catch {
      cgIdBigInt = 0n;
    }
    const requiredACKs = typeof chain.getMinimumRequiredSignatures === 'function'
      ? await chain.getMinimumRequiredSignatures()
      : undefined;
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: cgIdBigInt,
      contextGraphIdStr: contextGraphId,
      publisherPeerId: transport.publisherPeerId,
      publicByteSize,
      isPrivate: false,
      kaCount,
      rootEntities,
      requiredACKs,
      stagingQuads,
      epochs,
      tokenAmount,
    });
    return result.acks;
  };
}

function createChainRecoveryResolver(
  publishers: Map<string, DKGPublisher>,
): (job: LiftJobBroadcast | LiftJobIncluded) => Promise<AsyncLiftPublisherRecoveryResult | null> {
  return async (job) => {
    const publisher = publishers.get(job.broadcast.walletId);
    if (!publisher) return null;
    const chain = (publisher as unknown as { chain?: { resolvePublishByTxHash?: (txHash: string) => Promise<any> } }).chain;
    if (!chain?.resolvePublishByTxHash) return null;
    const result = await chain.resolvePublishByTxHash(job.broadcast.txHash);
    if (!result) return null;

    return {
      inclusion: {
        txHash: result.txHash as `0x${string}`,
        blockNumber: result.blockNumber,
        blockTimestamp: result.blockTimestamp,
      },
      finalization: {
        mode: 'published',
        txHash: result.txHash as `0x${string}`,
        batchId: result.batchId.toString() as `${bigint}`,
        startKAId: result.startKAId?.toString() as `${bigint}` | undefined,
        endKAId: result.endKAId?.toString() as `${bigint}` | undefined,
        publisherAddress: result.publisherAddress as `0x${string}`,
      },
    };
  };
}

export function parsePositiveMsOption(value: string, optionName: '--poll-interval' | '--error-backoff'): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer in milliseconds`);
  }
  return parsed;
}

async function createPublisherStore(dataDir: string, config: DkgConfig): Promise<TripleStore> {
  if (config.store) {
    return await createTripleStore(config.store as any);
  }

  return await createTripleStore({
    backend: 'oxigraph-worker',
    options: { path: join(dataDir, 'store.nq') },
  });
}

async function loadOrCreateAgentWallet(dataDir: string): Promise<DKGAgentWallet> {
  try {
    return await DKGAgentWallet.load(dataDir);
  } catch {
    const wallet = await DKGAgentWallet.generate();
    await wallet.save(dataDir);
    return wallet;
  }
}
