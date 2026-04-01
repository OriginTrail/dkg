import { join } from 'node:path';
import { DKGAgentWallet } from '@origintrail-official/dkg-agent';
import { EVMChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import { AsyncLiftRunner, DKGPublisher, TripleStoreAsyncLiftPublisher, type AsyncLiftPublishExecutionInput } from '@origintrail-official/dkg-publisher';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { loadNetworkConfig, type DkgConfig } from './config.js';
import { loadPublisherWallets } from './publisher-wallets.js';

export interface PublisherRuntime {
  readonly runner: AsyncLiftRunner;
  readonly walletIds: string[];
  readonly stop: () => Promise<void>;
}

export interface PublisherInspector {
  readonly publisher: TripleStoreAsyncLiftPublisher;
  readonly stop: () => Promise<void>;
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
  return {
    publisher: new TripleStoreAsyncLiftPublisher(store),
    stop: async () => {
      await store.close();
    },
  };
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
}): Promise<PublisherRuntime> {
  return createPublisherRuntimeFromBase({
    dataDir: args.dataDir,
    keypair: args.keypair,
    store: args.store,
    chainBase: args.chainBase,
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
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

  for (const wallet of publisherWallets.wallets) {
    const chain = args.chainBase
      ? new EVMChainAdapter({
          rpcUrl: args.chainBase.rpcUrl,
          privateKey: wallet.privateKey,
          hubAddress: args.chainBase.hubAddress,
          chainId: args.chainBase.chainId,
        })
      : new NoChainAdapter();
    publishers.set(
      wallet.address,
      new DKGPublisher({
        store: args.store,
        chain,
        eventBus,
        keypair: args.keypair,
        publisherPrivateKey: wallet.privateKey,
      }),
    );
  }

  const asyncPublisher = new TripleStoreAsyncLiftPublisher(args.store, {
    publishExecutor: async ({ walletId, publishOptions }: AsyncLiftPublishExecutionInput) => {
      const publisher = publishers.get(walletId);
      if (!publisher) {
        throw new Error(`No publisher configured for wallet ${walletId}`);
      }
      return await publisher.publish(publishOptions);
    },
  });

  const runner = new AsyncLiftRunner({
    publisher: asyncPublisher,
    walletIds: publisherWallets.wallets.map((wallet) => wallet.address),
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
    hasIncludedRecoveryResolver: false,
  });

  return {
    runner,
    walletIds: publisherWallets.wallets.map((wallet) => wallet.address),
    stop: async () => {
      await runner.stop();
      if (args.closeStoreOnStop) {
        await args.store.close();
      }
    },
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
