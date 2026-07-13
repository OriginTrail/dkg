import { join } from 'node:path';
import { DKGAgentWallet } from '@origintrail-official/dkg-agent';
import { EVMChainAdapter, NoChainAdapter, mergeRpcUsageWindows, type ChainAdapter, type RpcUsageWindow } from '@origintrail-official/dkg-chain';
import { TypedEventBus, type Ed25519Keypair } from '@origintrail-official/dkg-core';
import { ACKCollector, AsyncLiftRunner, DKGPublisher, FileWorkspacePublicSnapshotStore, TripleStoreAsyncLiftPublisher, wrapAsRpcPreconditionIfApplicable, type ACKTransport, type ACKTransportFactory, type AsyncLiftPublishExecutionInput, type AsyncLiftPublisher, type AsyncLiftPublisherConfig, type AsyncLiftPublisherRecoveryResult, type LiftJobBroadcast, type LiftJobIncluded, type PublishOptions, type V10ACKProviderParams, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { loadNetworkConfig, resolveNetworkConfigName, resolveReadyChainConfig, type DkgConfig } from './config.js';
import {
  projectRuntimeEvmChainConfig,
  type RuntimeEvmChainConfig,
} from './runtime-chain-config.js';
import { loadPublisherWallets } from './publisher-wallets.js';

export type { ACKTransportFactory } from '@origintrail-official/dkg-publisher';

/** Single construction boundary for every async-publisher wallet adapter. */
export function createPublisherWalletChain(
  chainBase: RuntimeEvmChainConfig | undefined,
  privateKey: string,
): ChainAdapter {
  return chainBase
    ? new EVMChainAdapter({ ...chainBase, privateKey, allowNoAdminSigner: true })
    : new NoChainAdapter();
}

export interface PublisherRuntime {
  readonly runner: AsyncLiftRunner;
  readonly publisher: AsyncLiftPublisher;
  readonly walletIds: string[];
  readonly wallets: readonly PublisherRuntimeWallet[];
  readonly stop: () => Promise<void>;
  /** RpcUsageDrainable: merged window across every per-wallet chain adapter. */
  readonly drainRpcUsage: () => RpcUsageWindow;
}

export interface PublisherRuntimeWallet {
  readonly address: string;
  readonly identityId: bigint;
}

export type AsyncPublisherUnavailableReason =
  | 'publisher_disabled'
  | 'publisher_starting'
  | 'no_publisher_wallets'
  | 'publisher_startup_failed';

type PublisherDisabledAvailability = {
  available: false;
  reason: 'publisher_disabled';
  retryable: false;
  operatorActionRequired: true;
};

type PublisherStartingAvailability = {
  available: false;
  reason: 'publisher_starting';
  retryable: true;
  operatorActionRequired: false;
};

type NoPublisherWalletsAvailability = {
  available: false;
  reason: 'no_publisher_wallets';
  retryable: false;
  operatorActionRequired: true;
};

type PublisherStartupFailedAvailability = {
  available: false;
  reason: 'publisher_startup_failed';
  retryable: false;
  operatorActionRequired: true;
};

type AsyncPublisherUnavailableAvailability =
  | PublisherDisabledAvailability
  | PublisherStartingAvailability
  | NoPublisherWalletsAvailability
  | PublisherStartupFailedAvailability;

export type AsyncPublisherAvailability =
  | { available: true }
  | AsyncPublisherUnavailableAvailability;

function unavailablePublisherAvailability(reason: 'publisher_disabled'): PublisherDisabledAvailability;
function unavailablePublisherAvailability(reason: 'publisher_starting'): PublisherStartingAvailability;
function unavailablePublisherAvailability(reason: 'no_publisher_wallets'): NoPublisherWalletsAvailability;
function unavailablePublisherAvailability(reason: 'publisher_startup_failed'): PublisherStartupFailedAvailability;
function unavailablePublisherAvailability(reason: AsyncPublisherUnavailableReason): AsyncPublisherUnavailableAvailability;
function unavailablePublisherAvailability(
  reason: AsyncPublisherUnavailableReason,
): AsyncPublisherUnavailableAvailability {
  switch (reason) {
    case 'publisher_starting':
      return { available: false, reason, retryable: true, operatorActionRequired: false };
    case 'publisher_disabled':
    case 'no_publisher_wallets':
    case 'publisher_startup_failed':
      return { available: false, reason, retryable: false, operatorActionRequired: true };
  }
}

/**
 * Canonical readiness boundary for every async-ingress route. Lifecycle may
 * supply an explicit starting/failure state; otherwise the runtime/config
 * shape is classified consistently for direct route tests and embedded users.
 */
export function resolveAsyncPublisherAvailability(args: {
  config: DkgConfig;
  runtime: PublisherRuntime | null;
  lifecycleReason?: AsyncPublisherUnavailableReason;
}): AsyncPublisherAvailability {
  if (args.runtime?.walletIds.length) return { available: true };
  const reason = args.lifecycleReason
    ?? (args.runtime
      ? 'no_publisher_wallets'
      : args.config.publisher?.enabled
        ? 'publisher_startup_failed'
        : 'publisher_disabled');
  return unavailablePublisherAvailability(reason);
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
  /** The wallet's own chain adapter — also the wallet's RpcUsageDrainable source. */
  readonly chain: ChainAdapter;
}

export async function startPublisherRuntimeIfEnabled(args: {
  dataDir: string;
  config: DkgConfig;
  store: TripleStore;
  keypair: Ed25519Keypair;
  chainBase?: RuntimeEvmChainConfig;
  log: (message: string) => void;
  ackTransportFactory?: ACKTransportFactory;
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

export type PublisherStartupOutcome =
  | {
      runtime: PublisherRuntime;
      availability: Extract<AsyncPublisherAvailability, { available: true }>;
    }
  | {
      runtime: null;
      availability: PublisherDisabledAvailability;
    }
  | {
      runtime: null;
      availability: NoPublisherWalletsAvailability;
    }
  | {
      runtime: null;
      availability: PublisherStartupFailedAvailability;
      error: unknown;
    };

export type PublisherState =
  | PublisherStartupOutcome
  | {
      runtime: null;
      availability: PublisherStartingAvailability;
    };

/**
 * Initial daemon state before the deferred publisher bootstrap settles. Routes
 * receive this whole discriminated value, so runtime and readiness cannot
 * disagree in a request context.
 */
export function createInitialPublisherState(config: DkgConfig): PublisherState {
  if (!config.publisher?.enabled) {
    return {
      runtime: null,
      availability: unavailablePublisherAvailability('publisher_disabled'),
    };
  }
  return {
    runtime: null,
    availability: unavailablePublisherAvailability('publisher_starting'),
  };
}

/**
 * Explicit daemon-startup boundary. The compatibility helper above retains its
 * historical nullable return, while lifecycle code consumes this discriminant
 * and never has to guess which unavailable state a null runtime represents.
 */
export async function startPublisherRuntimeWithOutcome(
  args: Parameters<typeof startPublisherRuntimeIfEnabled>[0],
): Promise<PublisherStartupOutcome> {
  if (!args.config.publisher?.enabled) {
    return {
      runtime: null,
      availability: unavailablePublisherAvailability('publisher_disabled'),
    };
  }

  try {
    const runtime = await startPublisherRuntimeIfEnabled(args);
    if (!runtime) {
      return {
        runtime: null,
        availability: unavailablePublisherAvailability('no_publisher_wallets'),
      };
    }
    return { runtime, availability: { available: true } };
  } catch (error) {
    return {
      runtime: null,
      availability: unavailablePublisherAvailability('publisher_startup_failed'),
      error,
    };
  }
}

interface PublisherRuntimeBaseArgs {
  dataDir: string;
  keypair: Ed25519Keypair;
  store: TripleStore;
  chainBase?: RuntimeEvmChainConfig;
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  maxRetries?: number;
  ackTransportFactory?: ACKTransportFactory;
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

  const network = await loadNetworkConfig(resolveNetworkConfigName(args.config));
  const keypair = await loadOrCreateAgentWallet(args.dataDir);
  const store = await createPublisherStore(args.dataDir, args.config);
  const publicSnapshotStore = createPublicSnapshotStore(args.dataDir, args.config);
  // Field-merge config + network/<env>.json#chain, then guard for the
  // strict { rpcUrl, hubAddress, chainId? } shape the publisher runtime
  // expects. If either required field is missing, pass undefined and let
  // the runtime fall back to NoChainAdapter (publisher won't have on-chain
  // finality but still functions).
  const merged = resolveReadyChainConfig(args.config, network);
  const chainBase = projectRuntimeEvmChainConfig(merged);
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
  chainBase?: RuntimeEvmChainConfig;
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  maxRetries?: number;
  config?: Pick<DkgConfig, 'sharedMemoryPublicSnapshotStorage'>;
  ackTransportFactory?: ACKTransportFactory;
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
    const chain = createPublisherWalletChain(args.chainBase, wallet.privateKey);
    const identityId = await chain.getIdentityId();
    wallets.push({
      address: wallet.address,
      identityId,
      chain,
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
    drainRpcUsage: () => mergeRpcUsageWindows(...wallets.map((w) => w.chain.drainRpcUsage?.())),
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

function createV10ACKProviderForPublisher(
  publisher: DKGPublisher,
  transport?: ACKTransport,
): PublishOptions['v10ACKProvider'] | undefined {
  if (!transport) return undefined;
  const chain = (publisher as unknown as {
    chain?: {
      isV10Ready?: () => boolean;
      verifyACKIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
      verifyACKIdentityDetailed?: (
        recoveredAddress: string,
        claimedIdentityId: bigint,
      ) => Promise<{ valid: boolean; reason?: 'key-not-registered' | 'not-in-sharding-table' | 'rpc-error' }>;
      getMinimumRequiredSignatures?: () => Promise<number>;
      getEvmChainId?: () => Promise<bigint>;
      getKnowledgeAssetsLifecycleAddress?: () => Promise<string>;
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
  if (typeof chain.getKnowledgeAssetsLifecycleAddress !== 'function') return undefined;

  const collector = new ACKCollector({
    gossipPublish: transport.gossipPublish,
    sendP2P: transport.sendP2P,
    getConnectedCorePeers: transport.getConnectedCorePeers,
    verifyIdentity: async (recoveredAddress: string, claimedIdentityId: bigint) => chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId),
    // Prefer the structured verifier when the chain adapter exposes it
    // so the rejection log can report the specific failing gate.
    ...(typeof chain.verifyACKIdentityDetailed === 'function' ? {
      verifyIdentityDetailed: async (recoveredAddress: string, claimedIdentityId: bigint) =>
        chain.verifyACKIdentityDetailed!(recoveredAddress, claimedIdentityId),
    } : {}),
    log: transport.log,
  });

  return async (params: V10ACKProviderParams) => {
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
      cgIdBigInt = BigInt(params.contextGraphId);
    } catch {
      throw new Error(
        `Async V10 publish requires a numeric on-chain context graph id; ` +
        `got '${params.contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    if (cgIdBigInt <= 0n) {
      throw new Error(
        `Async V10 publish requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
        `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
      );
    }
    if (!Number.isInteger(params.merkleLeafCount) || params.merkleLeafCount < 1) {
      throw new Error(
        `Async V10 publish requires a positive integer merkleLeafCount; got ${params.merkleLeafCount}. ` +
        'Publishers must pass the V10 flat-KC leaf count computed by V10MerkleTree.',
      );
    }
    // PR3 / RC11: wrap each chain pre-flight read in its own try/catch
    // so a failure is promoted to the typed `RpcPreconditionError`
    // (rather than the opaque "V10 ACK collection failed" string).
    // Mirrors the agent-side V10 ACK provider in
    // `dkg-agent.ts:createV10ACKProvider` so the daemon log surfaces
    // the same shape regardless of which entry point produced the
    // publish. `wrapAsRpcPreconditionIfApplicable` is a no-op when
    // the error is already typed.
    let requiredACKs: number | undefined;
    if (typeof chain.getMinimumRequiredSignatures === 'function') {
      try {
        requiredACKs = await chain.getMinimumRequiredSignatures();
      } catch (err) {
        throw wrapAsRpcPreconditionIfApplicable(err, 'getMinimumRequiredSignatures');
      }
    }
    let chainIdBig: bigint;
    try {
      chainIdBig = await chain.getEvmChainId!();
    } catch (err) {
      throw wrapAsRpcPreconditionIfApplicable(err, 'getEvmChainId');
    }
    let kav10Address: string;
    try {
      kav10Address = await chain.getKnowledgeAssetsLifecycleAddress!();
    } catch (err) {
      throw wrapAsRpcPreconditionIfApplicable(err, 'getKnowledgeAssetsLifecycleAddress');
    }
    const result = await collector.collect({
      merkleRoot: params.merkleRoot,
      contextGraphId: cgIdBigInt,
      contextGraphIdStr: params.contextGraphId,
      publisherPeerId: transport.publisherPeerId,
      publicByteSize: params.publicByteSize,
      isPrivate: params.ackMode.kind !== 'public',
      kaCount: params.kaCount,
      rootEntities: params.rootEntities,
      chainId: chainIdBig,
      kav10Address,
      requiredACKs,
      stagingQuads: params.stagingQuads,
      epochs: params.epochs,
      tokenAmount: params.tokenAmount,
      swmGraphId: params.swmGraphId,
      subGraphName: params.subGraphName,
      merkleLeafCount: params.merkleLeafCount,
      assetUal: params.assetUal,
      ackMode: params.ackMode,
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

async function createPublisherStore(dataDir: string, config: DkgConfig): Promise<TripleStore> {
  if (config.store) {
    const storeConfig = config.store as any;
    return await createTripleStore({
      ...storeConfig,
      // OT-RFC-59 §5.3: the daemon-down CLI publisher is a SECOND writer against
      // the same store. It MUST NOT maintain the change log — a second in-memory
      // seq allocator would fork the log (commit order ≠ seq order across
      // processes). Only the single-writer daemon owns the changelog; force it
      // off here regardless of config.store.changelog.
      changelog: false,
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
