import { join } from 'node:path';
import { DKGAgentWallet } from '@origintrail-official/dkg-agent';
import { EVMChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import { ACKCollector, AsyncLiftRunner, DKGPublisher, FileWorkspacePublicSnapshotStore, TripleStoreAsyncLiftPublisher, type AsyncLiftPublishExecutionInput, type AsyncLiftPublisher, type AsyncLiftPublisherRecoveryResult, type LiftJobBroadcast, type LiftJobIncluded, type PublishOptions, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { loadNetworkConfig, resolveChainConfig, type DkgConfig } from './config.js';
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
      maxRetries: args.config.publisher.maxRetries,
      config: args.config,
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
  maxRetries?: number;
  ackTransportFactory?: () => ACKTransportFactory;
  v10ACKProviderFactory?: () => PublishOptions['v10ACKProvider'];
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

  const network = await loadNetworkConfig();
  const keypair = await loadOrCreateAgentWallet(args.dataDir);
  const store = await createPublisherStore(args.dataDir, args.config);
  const publicSnapshotStore = createPublicSnapshotStore(args.dataDir, args.config);
  // Field-merge config + network/<env>.json#chain, then guard for the
  // strict { rpcUrl, hubAddress, chainId? } shape the publisher runtime
  // expects. If either required field is missing, pass undefined and let
  // the runtime fall back to NoChainAdapter (publisher won't have on-chain
  // finality but still functions).
  const merged = resolveChainConfig(args.config, network);
  const chainBase = merged?.rpcUrl && merged?.hubAddress
    ? { rpcUrl: merged.rpcUrl, hubAddress: merged.hubAddress, chainId: merged.chainId }
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
    hubAddress: string;
    chainId?: string;
  };
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  maxRetries?: number;
  config?: Pick<DkgConfig, 'sharedMemoryPublicSnapshotStorage'>;
  ackTransportFactory?: () => ACKTransportFactory;
  v10ACKProviderFactory?: () => PublishOptions['v10ACKProvider'];
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
  const publishers = new Map<string, DKGPublisher>();
  const invalidWallets: string[] = [];

  for (const wallet of publisherWallets.wallets) {
    const chain = args.chainBase
      ? new EVMChainAdapter({
          rpcUrl: args.chainBase.rpcUrl,
          privateKey: wallet.privateKey,
          hubAddress: args.chainBase.hubAddress,
          chainId: args.chainBase.chainId,
          allowNoAdminSigner: true,
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
        publicSnapshotStore: args.publicSnapshotStore,
      }),
    );
  }

  if (invalidWallets.length > 0) {
    if (publishers.size === 0) {
      const noun = invalidWallets.length === 1 ? 'wallet is' : 'wallets are';
      throw new Error(
        `Publisher startup blocked: the following publisher ${noun} missing an on-chain identity: ${invalidWallets.join(', ')}. ` +
        'Run `dkg identity create` for each wallet or remove it from publisher-wallets.json.',
      );
    }
    const noun = invalidWallets.length === 1 ? 'wallet' : 'wallets';
    console.warn(
      `[publisher] Skipping ${invalidWallets.length} ${noun} missing on-chain identity: ${invalidWallets.join(', ')}. ` +
      `Continuing with ${publishers.size} valid wallet(s).`,
    );
  }

  const hasChainRecovery = [...publishers.values()].some((p) => {
    const chain = (p as unknown as { chain?: { resolvePublishByTxHash?: unknown } }).chain;
    return typeof chain?.resolvePublishByTxHash === 'function';
  });

  const asyncPublisher = new TripleStoreAsyncLiftPublisher(args.store, {
    chainRecoveryResolver: hasChainRecovery ? createChainRecoveryResolver(publishers) : undefined,
    maxRetries: args.maxRetries,
    publicSnapshotStore: args.publicSnapshotStore,
    publishExecutor: async ({ walletId, publishOptions }: AsyncLiftPublishExecutionInput) => {
      const publisher = publishers.get(walletId);
      if (!publisher) {
        throw new Error(`No publisher configured for wallet ${walletId}`);
      }
      const v10ACKProvider = publishOptions.v10ACKProvider
        ?? args.v10ACKProviderFactory?.()
        ?? createV10ACKProviderForPublisher(publisher, args.ackTransportFactory?.());
      const publishOptionsWithACKs = v10ACKProvider
        ? { ...publishOptions, v10ACKProvider }
        : publishOptions;
      // Capability gate: use `isV10Ready()` (the authoritative V10 runtime
      // signal) rather than probing for `createKnowledgeAssetsV10`. Since the
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
      isV10Ready?: () => boolean;
      verifyACKIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
      getMinimumRequiredSignatures?: () => Promise<number>;
      getEvmChainId?: () => Promise<bigint>;
      getKnowledgeAssetsV10Address?: () => Promise<string>;
    };
  }).chain;
  // `isV10Ready()` is the authoritative capability gate — rejects
  // NoChainAdapter (returns false) and unresolved EVM adapters.
  if (!chain?.isV10Ready?.()) return undefined;
  if (typeof chain.verifyACKIdentity !== 'function') return undefined;
  // The H5 prefix requires both a numeric chain id AND the deployed KAV10
  // address. Without them the collector cannot build a digest that matches
  // what core-node handlers sign, so refuse to hand back a provider at all.
  if (typeof chain.getEvmChainId !== 'function') return undefined;
  if (typeof chain.getKnowledgeAssetsV10Address !== 'function') return undefined;

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
    swmGraphId,
    subGraphName,
    merkleLeafCount,
    isEncryptedPayload,
  ) => {
    // Fail loud on non-numeric or non-positive CG ids. V10 publish requires
    // a real on-chain context graph; `ZeroContextGraphId` at
    // `KnowledgeAssetsV10.sol:379` rejects cgId 0 on chain. Reject `<= 0n`
    // rather than `=== 0n` so `BigInt("-1") === -1n` is caught here instead
    // of dying in ethers' uint256 encoder inside the evm-adapter.
    // `contextGraphId` here is the TARGET on-chain numeric id; `swmGraphId`
    // (optional) is the source SWM graph name and is NOT required to be
    // numeric.
    let cgIdBigInt: bigint;
    try {
      cgIdBigInt = BigInt(contextGraphId);
    } catch {
      throw new Error(
        `Async V10 publish requires a numeric on-chain context graph id; ` +
        `got '${contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    if (cgIdBigInt <= 0n) {
      throw new Error(
        `Async V10 publish requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
        `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    if (!Number.isInteger(merkleLeafCount) || merkleLeafCount < 1) {
      throw new Error(
        `Async V10 publish requires a positive integer merkleLeafCount; got ${merkleLeafCount}. ` +
        'Publishers must pass the V10 flat-KC leaf count computed by V10MerkleTree.',
      );
    }
    const requiredACKs = typeof chain.getMinimumRequiredSignatures === 'function'
      ? await chain.getMinimumRequiredSignatures()
      : undefined;
    // Both values are guaranteed present here by the adapter-capability
    // check at the top of this factory — re-resolving on every publish
    // keeps the provider agnostic to hot adapter swaps.
    const chainIdBig = await chain.getEvmChainId!();
    const kav10Address = await chain.getKnowledgeAssetsV10Address!();
    const result = await collector.collect({
      merkleRoot,
      contextGraphId: cgIdBigInt,
      contextGraphIdStr: contextGraphId,
      publisherPeerId: transport.publisherPeerId,
      publicByteSize,
      isPrivate: isEncryptedPayload === true,
      kaCount,
      rootEntities,
      chainId: chainIdBig,
      kav10Address,
      requiredACKs,
      stagingQuads,
      epochs,
      tokenAmount,
      swmGraphId,
      subGraphName,
      merkleLeafCount,
      isEncryptedPayload,
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

export function parsePositiveMsOption(value: string, optionName: '--poll-interval' | '--error-backoff'): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer in milliseconds`);
  }
  return parsed;
}

export function parsePositiveIntegerOption(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
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
