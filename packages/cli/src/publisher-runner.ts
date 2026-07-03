import { join } from 'node:path';
import { DKGAgentWallet } from '@origintrail-official/dkg-agent';
import { EVMChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import { AsyncLiftRunner, DKGPublisher, FileWorkspacePublicSnapshotStore, TripleStoreAsyncLiftPublisher, type AsyncLiftPublishExecutionInput, type AsyncLiftPublisher, type AsyncLiftPublisherConfig, type AsyncLiftPublisherRecoveryResult, type LiftJobBroadcast, type LiftJobIncluded, type PublishOptions, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { createV10ACKProviderForPublisher, type ACKTransportFactory } from './ack-provider.js';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { loadNetworkConfig, resolveReadyChainConfig, type DkgConfig } from './config.js';
import { loadPublisherWallets } from './publisher-wallets.js';

export interface PublisherRuntime {
  readonly runner: AsyncLiftRunner;
  readonly publisher: AsyncLiftPublisher;
  readonly walletIds: string[];
  readonly wallets: readonly PublisherRuntimeWallet[];
  readonly stop: () => Promise<void>;
}

export interface PublisherRuntimeWallet {
  readonly address: string;
  readonly identityId: bigint;
}

export interface PublisherInspector {
  readonly publisher: AsyncLiftPublisher;
  readonly stop: () => Promise<void>;
}

type PublishEncryptionFactory = (publishOptions: PublishOptions) =>
  | Promise<Pick<PublishOptions, 'encryptInlinePayload' | 'encryptInlineChunked'> | undefined>
  | Pick<PublishOptions, 'encryptInlinePayload' | 'encryptInlineChunked'>
  | undefined;

interface ConfiguredPublisherWallet extends PublisherRuntimeWallet {
  readonly publisher: DKGPublisher;
}

export async function startPublisherRuntimeIfEnabled(args: {
  dataDir: string;
  config: DkgConfig;
  store: TripleStore;
  keypair: Ed25519Keypair;
  chainBase?: {
    rpcUrl: string;
    rpcUrls?: string[];
    hubAddress: string;
    tokenAddress?: string;
    chainId?: string;
  };
  log: (message: string) => void;
  ackTransportFactory?: () => ACKTransportFactory;
  publishEncryptionFactory?: PublishEncryptionFactory;
  knowledgeAssetVmPublishExecutor?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishExecutor'];
  knowledgeAssetVmPublishPreflight?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishPreflight'];
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
      maxRetries: args.config.publisher.maxRetries,
      config: args.config,
      ackTransportFactory: args.ackTransportFactory,
      publishEncryptionFactory: args.publishEncryptionFactory,
      knowledgeAssetVmPublishExecutor: args.knowledgeAssetVmPublishExecutor,
      knowledgeAssetVmPublishPreflight: args.knowledgeAssetVmPublishPreflight,
    });
    await runtime.runner.start();
    logPublisherWalletAttribution(runtime.wallets, args.log);
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
    rpcUrls?: string[];
    hubAddress: string;
    tokenAddress?: string;
    chainId?: string;
  };
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  maxRetries?: number;
  ackTransportFactory?: () => ACKTransportFactory;
  v10ACKProviderFactory?: () => PublishOptions['v10ACKProvider'];
  publishEncryptionFactory?: PublishEncryptionFactory;
  knowledgeAssetVmPublishExecutor?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishExecutor'];
  knowledgeAssetVmPublishPreflight?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishPreflight'];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  closeStoreOnStop: boolean;
}

export async function createPublisherRuntime(args: {
  dataDir: string;
  config: DkgConfig;
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  maxRetries?: number;
}): Promise<PublisherRuntime> {
  const publisherWallets = await loadPublisherWallets(args.dataDir);
  if (publisherWallets.wallets.length === 0) {
    throw new Error('No publisher wallets configured. Use `dkg publisher wallet add <privateKey>` first.');
  }

  const network = await loadNetworkConfig(args.config.networkConfig);
  const keypair = await loadOrCreateAgentWallet(args.dataDir);
  const store = await createPublisherStore(args.dataDir, args.config);
  const publicSnapshotStore = createPublicSnapshotStore(args.dataDir, args.config);
  // Field-merge config + network/<env>.json#chain, then guard for the
  // strict { rpcUrl, hubAddress, chainId? } shape the publisher runtime
  // expects. If either required field is missing, pass undefined and let
  // the runtime fall back to NoChainAdapter (publisher won't have on-chain
  // finality but still functions).
  const merged = resolveReadyChainConfig(args.config, network);
  const chainBase = merged?.rpcUrl && merged?.hubAddress
    ? { rpcUrl: merged.rpcUrl, rpcUrls: merged.rpcUrls, hubAddress: merged.hubAddress, tokenAddress: merged.tokenAddress, chainId: merged.chainId }
    : undefined;
  return createPublisherRuntimeFromBase({
    dataDir: args.dataDir,
    keypair: keypair.keypair,
    store,
    chainBase,
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
    maxRetries: args.maxRetries ?? args.config.publisher?.maxRetries,
    publicSnapshotStore,
    closeStoreOnStop: true,
  });
}

export async function createPublisherInspector(args: {
  dataDir: string;
  config: DkgConfig;
}): Promise<PublisherInspector> {
  const store = await createPublisherStore(args.dataDir, args.config);
  return createPublisherInspectorFromStore(store, true, createPublicSnapshotStore(args.dataDir, args.config));
}

export function createPublisherInspectorFromStore(
  store: TripleStore,
  closeStoreOnStop = false,
  publicSnapshotStore?: WorkspacePublicSnapshotStore,
): PublisherInspector {
  return {
    publisher: new TripleStoreAsyncLiftPublisher(store, { publicSnapshotStore }),
    stop: async () => {
      if (closeStoreOnStop) {
        await store.close();
      }
    },
  };
}

export function createPublisherControlFromStore(
  store: TripleStore,
  publicSnapshotStore?: WorkspacePublicSnapshotStore,
): AsyncLiftPublisher {
  return new TripleStoreAsyncLiftPublisher(store, { publicSnapshotStore });
}

export async function createPublisherRuntimeFromAgent(args: {
  dataDir: string;
  store: TripleStore;
  keypair: Ed25519Keypair;
  chainBase?: {
    rpcUrl: string;
    rpcUrls?: string[];
    hubAddress: string;
    tokenAddress?: string;
    chainId?: string;
  };
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  maxRetries?: number;
  config?: Pick<DkgConfig, 'sharedMemoryPublicSnapshotStorage'>;
  ackTransportFactory?: () => ACKTransportFactory;
  v10ACKProviderFactory?: () => PublishOptions['v10ACKProvider'];
  publishEncryptionFactory?: PublishEncryptionFactory;
  knowledgeAssetVmPublishExecutor?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishExecutor'];
  knowledgeAssetVmPublishPreflight?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishPreflight'];
}): Promise<PublisherRuntime> {
  return createPublisherRuntimeFromBase({
    dataDir: args.dataDir,
    keypair: args.keypair,
    store: args.store,
    chainBase: args.chainBase,
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
    maxRetries: args.maxRetries,
    ackTransportFactory: args.ackTransportFactory,
    v10ACKProviderFactory: args.v10ACKProviderFactory,
    publishEncryptionFactory: args.publishEncryptionFactory,
    knowledgeAssetVmPublishExecutor: args.knowledgeAssetVmPublishExecutor,
    knowledgeAssetVmPublishPreflight: args.knowledgeAssetVmPublishPreflight,
    publicSnapshotStore: createPublicSnapshotStore(args.dataDir, args.config),
    closeStoreOnStop: false,
  });
}

async function createPublisherRuntimeFromBase(args: PublisherRuntimeBaseArgs): Promise<PublisherRuntime> {
  const publisherWallets = await loadPublisherWallets(args.dataDir);
  if (publisherWallets.wallets.length === 0) {
    throw new Error('No publisher wallets configured. Use `dkg publisher wallet add <privateKey>` first.');
  }

  const eventBus = new TypedEventBus();
  const wallets: ConfiguredPublisherWallet[] = [];

  for (const wallet of publisherWallets.wallets) {
    const chain = args.chainBase
      ? new EVMChainAdapter({
          rpcUrl: args.chainBase.rpcUrl,
          rpcUrls: args.chainBase.rpcUrls,
          privateKey: wallet.privateKey,
          hubAddress: args.chainBase.hubAddress,
          tokenAddress: args.chainBase.tokenAddress,
          chainId: args.chainBase.chainId,
          allowNoAdminSigner: true,
        })
      : new NoChainAdapter();
    const identityId = await chain.getIdentityId();
    wallets.push({
      address: wallet.address,
      identityId,
      publisher: new DKGPublisher({
        store: args.store,
        chain,
        eventBus,
        keypair: args.keypair,
        publisherNodeIdentityId: identityId,
        publisherPrivateKey: wallet.privateKey,
        publicSnapshotStore: args.publicSnapshotStore,
      }),
    });
  }

  const publishers = new Map<string, DKGPublisher>(
    wallets.map((wallet) => [wallet.address, wallet.publisher]),
  );
  const hasChainRecovery = [...publishers.values()].some((p) => {
    const chain = (p as unknown as { chain?: { resolvePublishByTxHash?: unknown } }).chain;
    return typeof chain?.resolvePublishByTxHash === 'function';
  });

  const asyncPublisher = new TripleStoreAsyncLiftPublisher(args.store, {
    chainRecoveryResolver: hasChainRecovery ? createChainRecoveryResolver(publishers) : undefined,
    maxRetries: args.maxRetries,
    publicSnapshotStore: args.publicSnapshotStore,
    knowledgeAssetVmPublishPreflight: args.knowledgeAssetVmPublishPreflight
      ? async (input) => {
          const publisher = publishers.get(input.walletId);
          if (!publisher) {
            throw new Error(`No publisher configured for wallet ${input.walletId}`);
          }
          return args.knowledgeAssetVmPublishPreflight!({ ...input, publisher });
        }
      : undefined,
    knowledgeAssetVmPublishExecutor: args.knowledgeAssetVmPublishExecutor
      ? async (input) => {
          const publisher = publishers.get(input.walletId);
          if (!publisher) {
            throw new Error(`No publisher configured for wallet ${input.walletId}`);
          }
          return args.knowledgeAssetVmPublishExecutor!({ ...input, publisher });
        }
      : undefined,
    publishExecutor: async ({ walletId, publishOptions }: AsyncLiftPublishExecutionInput) => {
      const publisher = publishers.get(walletId);
      if (!publisher) {
        throw new Error(`No publisher configured for wallet ${walletId}`);
      }
      const encryption = await args.publishEncryptionFactory?.(publishOptions);
      // GH #1121 — the agent-resolved, chainKey-bound AEAD closure MUST win over
      // any callback already on publishOptions. The async-lift mapper now
      // pre-populates a fail-closed default `encryptInlinePayload` for non-public
      // CGs (so plaintext can never silently ship); that default must only apply
      // when the real factory yields nothing — otherwise it would shadow the
      // real curated-publish encryption and make every private async publish
      // throw. Hence: real factory first, mapper default as the fallback.
      const publishOptionsWithEncryption: PublishOptions = {
        ...publishOptions,
        encryptInlinePayload: encryption?.encryptInlinePayload ?? publishOptions.encryptInlinePayload,
        encryptInlineChunked: encryption?.encryptInlineChunked ?? publishOptions.encryptInlineChunked,
      };
      const v10ACKProvider = publishOptionsWithEncryption.v10ACKProvider
        ?? args.v10ACKProviderFactory?.()
        ?? createV10ACKProviderForPublisher(publisher, args.ackTransportFactory?.());
      const publishOptionsWithACKs = v10ACKProvider
        ? { ...publishOptionsWithEncryption, v10ACKProvider }
        : publishOptionsWithEncryption;
      // Capability gate: use `isV10Ready()` (the authoritative V10 runtime
      // signal) rather than probing for `createKnowledgeAssets`. Since the
      // interface made the method required, `NoChainAdapter` now implements
      // it as a throwing stub, so a `typeof === 'function'` probe would
      // mis-route no-chain mode into the V10 ACK-gated path and crash.
      const chain = (publisher as unknown as { chain?: { isV10Ready?: () => boolean } }).chain;
      if (chain?.isV10Ready?.() && !publishOptionsWithACKs.v10ACKProvider) {
        throw new Error(
          'Async publisher cannot publish to a V10 ACK-gated chain without a v10ACKProvider. ' +
          'Use the synchronous agent publish path or add ACK collection support to the async runtime.',
        );
      }
      return await publisher.publish(publishOptionsWithACKs);
    },
  });

  const validWalletIds = [...publishers.keys()];

  const runner = new AsyncLiftRunner({
    publisher: asyncPublisher,
    walletIds: validWalletIds,
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
    hasIncludedRecoveryResolver: hasChainRecovery,
  });

  return {
    runner,
    publisher: asyncPublisher,
    walletIds: validWalletIds,
    wallets: wallets.map(({ address, identityId }) => ({ address, identityId })),
    stop: async () => {
      await runner.stop();
      if (args.closeStoreOnStop) {
        await args.store.close();
      }
    },
  };
}

function logPublisherWalletAttribution(
  wallets: readonly PublisherRuntimeWallet[],
  log: (message: string) => void,
): void {
  const attributedWallets = wallets
    .filter((wallet) => wallet.identityId !== 0n)
    .map((wallet) => `${wallet.address} (identityId=${wallet.identityId.toString()})`);
  const noAttributionWallets = wallets
    .filter((wallet) => wallet.identityId === 0n)
    .map((wallet) => wallet.address);

  if (attributedWallets.length > 0) {
    const verb = attributedWallets.length === 1 ? 'has' : 'have';
    log(
      `[publisher] ${attributedWallets.length} publisher wallet${attributedWallets.length === 1 ? '' : 's'} ` +
      `${verb} node attribution: ${attributedWallets.join(', ')}`,
    );
  }
  if (noAttributionWallets.length > 0) {
    log(
      `[publisher] ${noAttributionWallets.length} publisher wallet${noAttributionWallets.length === 1 ? '' : 's'} ` +
      `will publish in no-attribution mode (identityId=0): ${noAttributionWallets.join(', ')}`,
    );
  }
}

function createChainRecoveryResolver(
  publishers: Map<string, DKGPublisher>,
): (job: LiftJobBroadcast | LiftJobIncluded) => Promise<AsyncLiftPublisherRecoveryResult | null> {
  return async (job) => {
    const publisher = publishers.get(job.broadcast.walletId);
    if (!publisher) return null;
    const chain = (publisher as unknown as { chain?: { resolvePublishByTxHash?: (txHash: string) => Promise<any> } }).chain;
    if (!chain?.resolvePublishByTxHash) return null;
    let result: any;
    try {
      result = await chain.resolvePublishByTxHash(job.broadcast.txHash);
    } catch {
      // Transient RPC/provider errors — treat as inconclusive (null) so the
      // recovery timeout mechanism handles it rather than crashing the daemon.
      return null;
    }
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

async function createPublisherStore(dataDir: string, config: DkgConfig): Promise<TripleStore> {
  if (config.store) {
    const storeConfig = config.store as any;
    return await createTripleStore({
      ...storeConfig,
      largeLiteralStorage: config.largeLiteralStorage ?? (
        isLocalOxigraphStoreConfig(storeConfig)
          ? defaultLargeLiteralStorage(dataDir, config)
          : undefined
      ),
    });
  }

  return await createTripleStore({
    backend: 'oxigraph-worker',
    options: { path: join(dataDir, 'store.nq') },
    largeLiteralStorage: defaultLargeLiteralStorage(dataDir, config),
  });
}

function defaultLargeLiteralStorage(dataDir: string, config: DkgConfig) {
  return {
    enabled: config.largeLiteralStorage?.enabled ?? true,
    thresholdBytes: config.largeLiteralStorage?.thresholdBytes,
    directory: config.largeLiteralStorage?.directory ?? join(dataDir, 'literal-blobs'),
  };
}

export function createPublicSnapshotStore(
  dataDir: string,
  config?: Pick<DkgConfig, 'sharedMemoryPublicSnapshotStorage'>,
): WorkspacePublicSnapshotStore | undefined {
  const snapshotConfig = config?.sharedMemoryPublicSnapshotStorage;
  if (snapshotConfig?.enabled === false) {
    return undefined;
  }
  return new FileWorkspacePublicSnapshotStore(snapshotConfig?.directory ?? join(dataDir, 'swm-public-snapshots'));
}

function isLocalOxigraphStoreConfig(storeConfig: { backend?: unknown }): boolean {
  return storeConfig.backend === 'oxigraph'
    || storeConfig.backend === 'oxigraph-worker'
    || storeConfig.backend === 'oxigraph-persistent';
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
