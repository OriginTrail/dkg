import { join } from 'node:path';
import { ethers } from 'ethers';
import { DKGAgentWallet } from '@origintrail-official/dkg-agent';
import {
  EVMChainAdapter,
  NoChainAdapter,
  buildKnowledgeAssetUal,
  mergeRpcUsageWindows,
  type CanonicalFinalizationReceipt,
  type ChainAdapter,
  type OnChainPublishResult,
  type RpcUsageWindow,
} from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  TypedEventBus,
  type Ed25519Keypair,
} from '@origintrail-official/dkg-core';
import {
  ACKCollector,
  AsyncLiftRunner,
  DKGPublisher,
  FileWorkspacePublicSnapshotStore,
  TripleStoreAsyncLiftPublisher,
  wrapAsRpcPreconditionIfApplicable,
  type ACKTransport,
  type ACKTransportFactory,
  type AsyncKnowledgeAssetVmPublishRecoveryEvidence,
  type AsyncKnowledgeAssetVmPublishRecoveryResolver,
  type AsyncLiftDetailedRetrier,
  type AsyncLiftPublishExecutionInput,
  type AsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
  type AsyncLiftChainProofLookup,
  type AsyncLiftChainProofResolution,
  type AsyncLiftPublisherRecoveryResult,
  type VmPublisherControl,
  type LiftJobBroadcast,
  type LiftJobHex,
  type LiftJobIncluded,
  type PublishOptions,
  type V10ACKProviderParams,
  type SnapshotPageIndexStore,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import {
  loadNetworkConfig,
  loadResolvedNetworkConfig,
  isPublisherRuntimeEnabled,
  resolvePublisherRetryTuning,
  resolveReadyChainConfig,
  type DkgConfig,
  type PublisherRetryTuning,
} from './config.js';
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
  /**
   * GH#2270 — also the detailed retrier, so `dkg publisher retry` reports the same three
   * counts with or without a running daemon. `AsyncLiftRetryStateReader` is deliberately NOT
   * exposed here: this instance is built without the operator's `config.publisher` retry
   * knobs, so its `autoRetryEligible` could contradict the lane that actually runs. The
   * detailed retry counts carry no such dependency (the manual path ignores the kill-switch).
   */
  readonly publisher: AsyncLiftPublisher & AsyncLiftDetailedRetrier;
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
  knowledgeAssetVmPublishHandler?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<PublisherRuntime | null> {
  if (!isPublisherRuntimeEnabled(args.config.publisher)) {
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
      // GH#2270 — this is the ONE runtime whose retry scheduler and claim-time
      // sweep actually run, so the kill-switch and backoff knobs are dead
      // config unless they travel this hop (the #1836 bug class).
      retryTuning: resolvePublisherRetryTuning(args.config.publisher),
      config: args.config,
      ackTransportFactory: args.ackTransportFactory,
      publishEncryptionFactory: args.publishEncryptionFactory,
      knowledgeAssetVmPublishHandler: args.knowledgeAssetVmPublishHandler,
      publicSnapshotStore: args.publicSnapshotStore,
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
  if (!isPublisherRuntimeEnabled(config.publisher)) {
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
  if (!isPublisherRuntimeEnabled(args.config.publisher)) {
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
  /** GH#2270 — validated `config.publisher` retry knobs; unset knobs keep the library defaults. */
  retryTuning?: PublisherRetryTuning;
  ackTransportFactory?: ACKTransportFactory;
  v10ACKProviderFactory?: () => PublishOptions['v10ACKProvider'];
  publishEncryptionFactory?: PublishEncryptionFactory;
  knowledgeAssetVmPublishHandler?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  closeStoreOnStop: boolean;
  // #1829 — daemon-only append-only journal writes (OFF for standalone `dkg publisher run`).
  journalWrites?: boolean;
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

  const { network } = await loadResolvedNetworkConfig(args.config, loadNetworkConfig);
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
    retryTuning: resolvePublisherRetryTuning(args.config.publisher),
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
  options: {
    publicSnapshotStore?: WorkspacePublicSnapshotStore;
    maxRetries?: number;
    /**
     * GH#2270 — the same knobs the runtime instance gets. This instance runs no
     * scheduler, but it DERIVES the `retryState` the job-detail routes serve, and that
     * derivation reads `autoRetryEnabled`: without the knob the route would report a job
     * as auto-retry-eligible on a node where the operator switched the lane off (#1836).
     */
    retryTuning?: PublisherRetryTuning;
  } = {},
): VmPublisherControl {
  // The daemon admission instance also serves the #1828 recovery lookup (route)
  // and the boot index backfill — segregated capabilities the base
  // AsyncLiftPublisher runtime contract intentionally does NOT carry.
  return new TripleStoreAsyncLiftPublisher(store, {
    publicSnapshotStore: options.publicSnapshotStore,
    maxRetries: options.maxRetries,
    ...options.retryTuning,
    // #1829 — daemon admission instance: enable append-only journal writes. Left OFF
    // for the CLI inspector + standalone runner so a second OS process never races the
    // node-local per-lineageKey seq allocation.
    journalWrites: true,
  });
}

export async function createPublisherRuntimeFromAgent(args: {
  dataDir: string;
  store: TripleStore;
  keypair: Ed25519Keypair;
  chainBase?: RuntimeEvmChainConfig;
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  maxRetries?: number;
  retryTuning?: PublisherRetryTuning;
  config?: Pick<DkgConfig, 'sharedMemoryPublicSnapshotStorage'>;
  ackTransportFactory?: ACKTransportFactory;
  v10ACKProviderFactory?: () => PublishOptions['v10ACKProvider'];
  publishEncryptionFactory?: PublishEncryptionFactory;
  knowledgeAssetVmPublishHandler?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<PublisherRuntime> {
  return createPublisherRuntimeFromBase({
    dataDir: args.dataDir,
    keypair: args.keypair,
    store: args.store,
    chainBase: args.chainBase,
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
    maxRetries: args.maxRetries,
    retryTuning: args.retryTuning,
    ackTransportFactory: args.ackTransportFactory,
    v10ACKProviderFactory: args.v10ACKProviderFactory,
    publishEncryptionFactory: args.publishEncryptionFactory,
    knowledgeAssetVmPublishHandler: args.knowledgeAssetVmPublishHandler,
    publicSnapshotStore: args.publicSnapshotStore
      ?? createPublicSnapshotStore(args.dataDir, args.config),
    closeStoreOnStop: false,
    // #1829 — this is the daemon publisher runtime (processes named-KA jobs), so it
    // journals. Standalone `dkg publisher run` (createPublisherRuntime) does not set this.
    journalWrites: true,
  });
}

/**
 * Bind every named-KA queue lifecycle callback to the wallet that owns the
 * claimed job. Keeping this as one handler prevents execution, preflight, and
 * recovery from accidentally selecting different publisher instances.
 */
export function scopeKnowledgeAssetVmPublishHandler(
  publishers: Map<string, DKGPublisher>,
  handler: AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'],
): AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'] {
  if (!handler) return undefined;
  const publisherFor = (walletId: string): DKGPublisher => {
    const publisher = publishers.get(walletId);
    if (!publisher) throw new Error(`No publisher configured for wallet ${walletId}`);
    return publisher;
  };
  return {
    execute: (input) => handler.execute({ ...input, publisher: publisherFor(input.walletId) }),
    preflight: handler.preflight
      ? (input) => handler.preflight!({ ...input, publisher: publisherFor(input.walletId) })
      : undefined,
    finalizeRecovered: handler.finalizeRecovered
      ? (input) => handler.finalizeRecovered!({ ...input, publisher: publisherFor(input.walletId) })
      : undefined,
  };
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
  const hasChainRecovery = [...publishers.values()].some(hasChainPublishLookup);

  const scopedKnowledgeAssetVmPublishHandler = scopeKnowledgeAssetVmPublishHandler(
    publishers,
    args.knowledgeAssetVmPublishHandler,
  );
  const asyncPublisher = new TripleStoreAsyncLiftPublisher(args.store, {
    chainRecoveryResolver: hasChainRecovery ? createChainProofResolver(publishers) : undefined,
    knowledgeAssetVmPublishRecoveryResolver: hasChainRecovery
      ? createKnowledgeAssetVmPublishRecoveryResolver(publishers)
      : undefined,
    maxRetries: args.maxRetries,
    // GH#2270 — spread rather than four copied fields, so a knob added to
    // PublisherRetryTuning reaches the constructor without a further edit here.
    ...args.retryTuning,
    publicSnapshotStore: args.publicSnapshotStore,
    journalWrites: args.journalWrites ?? false,
    knowledgeAssetVmPublishHandler: scopedKnowledgeAssetVmPublishHandler,
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

/**
 * Can this publisher's chain adapter be asked whether a broadcast tx published?
 *
 * GH#2270 — EITHER lookup qualifies. `resolvePublishTransaction` is the surface
 * {@link createChainProofResolver} prefers, so an adapter offering only that one
 * must not silently lose chain recovery; an adapter offering only the legacy
 * `resolvePublishByTxHash` keeps the recovery it has always had.
 */
export function hasChainPublishLookup(publisher: DKGPublisher): boolean {
  const chain = (publisher as unknown as {
    chain?: { resolvePublishByTxHash?: unknown; resolvePublishTransaction?: unknown };
  }).chain;
  return typeof chain?.resolvePublishByTxHash === 'function'
    || typeof chain?.resolvePublishTransaction === 'function';
}

/**
 * GH#2270 — the runner's implementation of the publisher's chain-proof contract.
 *
 * The VERDICT VOCABULARY is not defined here: `AsyncLiftChainProofResolution` belongs to the
 * publisher, which is what dispatches on it. This module's job is the one rule that union cannot
 * state — that an absence must be ESTABLISHED. Every unknown this side can produce collapses into
 * `inconclusive` and never into `not-found`: an RPC error, a wallet with no publisher, an adapter
 * with no publish lookup, a contract address that would not resolve, a chain result the lift mapper
 * rejected, and — deliberately — a `null` from an adapter offering only the two-state
 * {@link ChainAdapter.resolvePublishByTxHash}, which cannot tell a mempool transaction from an
 * unknown one.
 *
 * The publisher holds forever on `inconclusive`, so an unknown that leaked in here as `not-found`
 * would become a resend of a transaction that may be in flight.
 *
 * PR-3 r1 — and the adapter's own `not-found` is NOT one of those establishings. A transaction
 * lookup is point-in-time and backend-local: a broadcast whose response timed out can be sitting
 * in a mempool this endpoint cannot see, and be mined a minute later. `not-found` is therefore
 * EARNED here, from nonce consumption at finality, or it is downgraded.
 */
export function createChainProofResolver(
  publishers: Map<string, DKGPublisher>,
): (lookup: AsyncLiftChainProofLookup) => Promise<AsyncLiftChainProofResolution> {
  return async (lookup) => {
    const resolution = await resolvePublishTransactionState(lookup, publishers);
    if (resolution.status === 'not-found') {
      return await isNonceProvenConsumed(lookup, publishers)
        ? { status: 'not-found' }
        : { status: 'inconclusive' };
    }
    if (resolution.status !== 'confirmed') return resolution;
    const recovery = await mapConfirmedPublishToLiftRecovery(resolution.publish, resolution.chain);
    // The chain confirmed a publish this node cannot turn into recovery evidence
    // (no knowledge-assets contract, or fields the mapper rejects). That is a
    // gap in what we can USE, not a fact about the chain: it must not read as
    // absence.
    return recovery ? { status: 'recovered', recovery } : { status: 'inconclusive' };
  };
}

/**
 * GH#2270 PR-3 r1 — is this transaction PROVABLY unable to mine?
 *
 * The adapter has just told us it cannot find the transaction. On its own that means nothing: the
 * lookup is a point-in-time answer from one backend, and the classic loss case is a broadcast
 * whose HTTP response timed out while the node accepted it anyway. Treating that as absence is how
 * a job gets resent while its first transaction is still perfectly capable of mining.
 *
 * What settles it is the nonce. Every signed transaction reserves one slot on its wallet, and the
 * pre-send write-ahead records which. If the wallet's account nonce at a FINALIZED block is
 * strictly greater than that slot, then the slot has been spent — and since the transaction is not
 * on chain, it was spent by something ELSE. It can never mine now, and a resend is safe.
 *
 * Every gap is fail-closed: no recorded nonce (records written before the field existed, and
 * inherited hashes, which name a transaction some earlier attempt signed), no adapter support for
 * the read, an endpoint that cannot serve `finalized`, or a read that throws — all answer `false`,
 * and the job keeps its hold and its operator exit.
 */
async function isNonceProvenConsumed(
  lookup: AsyncLiftChainProofLookup,
  publishers: Map<string, DKGPublisher>,
): Promise<boolean> {
  if (lookup.nonce === undefined) return false;
  const chain = (publishers.get(lookup.walletId) as unknown as { chain?: ChainAdapter } | undefined)?.chain;
  if (!chain?.getFinalizedAccountNonce) return false;
  try {
    const finalizedNonce = await chain.getFinalizedAccountNonce(lookup.walletId);
    // `getTransactionCount` is the NEXT nonce, so `> lookup.nonce` means this slot is behind the
    // finalized frontier. Equality is not enough: the slot is still the next one to be used.
    return finalizedNonce !== null && finalizedNonce > lookup.nonce;
  } catch {
    return false;
  }
}

export function createKnowledgeAssetVmPublishRecoveryResolver(
  publishers: Map<string, DKGPublisher>,
): AsyncKnowledgeAssetVmPublishRecoveryResolver {
  return async (job) => {
    const recovered = await resolveCanonicalOnChainPublish(job, publishers);
    if (!recovered) return null;
    const evidence = mapCanonicalFinalizationReceiptToKnowledgeAssetVmRecovery(
      recovered.receipt,
      recovered.chain.chainId,
      recovered.knowledgeAssetsContract,
    );
    if (!evidence) return null;

    // The chain receipt identifies the minted token by its packed id, so the
    // generic recovery mapper correctly reconstructs the public
    // contract/token UAL. A graph-scoped named-KA job, however, persisted its
    // exact WM/SWM/VM graphs under the immutable author/KA-number UAL. Preserve
    // that queued identity for local materialization; the agent independently
    // binds it to the receipt's packed batch/start/end id and signed author.
    const request = job.request?.jobType === 'knowledge-asset-vm-publish'
      ? job.request.knowledgeAssetVmPublish
      : undefined;
    if (
      request?.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION
      || request.kaUal === undefined
    ) {
      return evidence;
    }
    return {
      ...evidence,
      finalization: {
        ...evidence.finalization,
        ual: request.kaUal,
      },
    };
  };
}

async function resolveCanonicalOnChainPublish(
  job: LiftJobBroadcast | LiftJobIncluded,
  publishers: Map<string, DKGPublisher>,
): Promise<{
  receipt: CanonicalFinalizationReceipt;
  chain: ChainAdapter;
  knowledgeAssetsContract: string;
} | null> {
  const publisher = publishers.get(job.broadcast.walletId);
  if (!publisher) return null;
  const chain = (publisher as unknown as { chain?: ChainAdapter }).chain;
  if (!chain?.resolveCanonicalFinalizationReceipt) return null;

  let resolution;
  try {
    resolution = await chain.resolveCanonicalFinalizationReceipt(job.broadcast.txHash);
  } catch {
    return null;
  }
  if (resolution.status !== 'confirmed') return null;

  let knowledgeAssetsContract = resolution.receipt.knowledgeAssetsContract;
  if (!knowledgeAssetsContract && chain.getDKGKnowledgeAssetsAddress) {
    try {
      knowledgeAssetsContract = await chain.getDKGKnowledgeAssetsAddress();
    } catch {
      return null;
    }
  }
  return knowledgeAssetsContract
    ? { receipt: resolution.receipt, chain, knowledgeAssetsContract }
    : null;
}

function asLiftJobHex(value: string): LiftJobHex | null {
  return ethers.isHexString(value) ? value as LiftJobHex : null;
}

function asLiftJobBigInt(value: bigint | undefined): `${bigint}` | undefined {
  return value?.toString() as `${bigint}` | undefined;
}

export function mapOnChainPublishResultToLiftRecovery(
  result: OnChainPublishResult,
  chainId: string,
  knowledgeAssetsContract: string,
): AsyncLiftPublisherRecoveryResult | null {
  const txHash = asLiftJobHex(result.txHash);
  const publisherAddress = asLiftJobHex(result.publisherAddress);
  if (!txHash || !publisherAddress) return null;

  const recoveredKaId = result.kaId ?? result.startKAId ?? result.batchId;
  return {
    inclusion: {
      txHash,
      blockNumber: result.blockNumber,
      blockTimestamp: result.blockTimestamp,
    },
    finalization: {
      mode: 'published',
      txHash,
      ual: buildKnowledgeAssetUal(chainId, knowledgeAssetsContract, recoveredKaId),
      batchId: result.batchId.toString() as `${bigint}`,
      startKAId: asLiftJobBigInt(result.startKAId),
      endKAId: asLiftJobBigInt(result.endKAId),
      publisherAddress,
    },
  };
}

function mapCanonicalFinalizationReceiptToKnowledgeAssetVmRecovery(
  receipt: CanonicalFinalizationReceipt,
  chainId: string,
  knowledgeAssetsContract: string,
): AsyncKnowledgeAssetVmPublishRecoveryEvidence | null {
  const txHash = asLiftJobHex(receipt.txHash);
  const blockHash = asLiftJobHex(receipt.blockHash);
  const merkleRoot = asLiftJobHex(ethers.hexlify(receipt.merkleRoot));
  const publisherAddress = asLiftJobHex(receipt.publisherAddress);
  const authorAddress = receipt.authorAddress
    ? asLiftJobHex(receipt.authorAddress)
    : null;
  if (
    !txHash
    || !blockHash
    || !merkleRoot
    || !publisherAddress
    || !authorAddress
    || !ethers.isHexString(blockHash, 32)
    || !ethers.isHexString(merkleRoot, 32)
    || !ethers.isAddress(publisherAddress)
    || !ethers.isAddress(authorAddress)
    || !Number.isSafeInteger(receipt.blockNumber)
    || receipt.blockNumber < 0
    || !Number.isSafeInteger(receipt.txIndex)
    || receipt.txIndex < 0
  ) return null;
  return {
    inclusion: {
      txHash,
      blockNumber: receipt.blockNumber,
      blockHash,
    },
    finalization: {
      mode: 'published',
      txHash,
      ual: buildKnowledgeAssetUal(chainId, knowledgeAssetsContract, receipt.kaId),
      batchId: receipt.batchId.toString() as `${bigint}`,
      startKAId: receipt.startKAId.toString() as `${bigint}`,
      endKAId: receipt.endKAId.toString() as `${bigint}`,
      publisherAddress,
    },
    publishProof: { merkleRoot, authorAddress, txIndex: receipt.txIndex },
  };
}

/**
 * The chain lookup for one broadcast job, reported as the chain fact.
 *
 * GH#2270 — the adapter's tri-state {@link ChainAdapter.resolvePublishTransaction}
 * is used when it exists, because it is the only surface that asks the node for
 * the TRANSACTION and can therefore return a `not-found` that means something.
 * An adapter offering only `resolvePublishByTxHash` is not downgraded to a
 * guess: its `null` becomes `inconclusive`, never `not-found`, so an adapter
 * that cannot see the mempool can never authorise a resend.
 */
async function resolvePublishTransactionState(
  lookup: AsyncLiftChainProofLookup,
  publishers: Map<string, DKGPublisher>,
): Promise<
  | { status: 'confirmed'; publish: OnChainPublishResult; chain: ChainAdapter }
  | Exclude<AsyncLiftChainProofResolution, { status: 'recovered' }>
> {
  const publisher = publishers.get(lookup.walletId);
  if (!publisher) return { status: 'inconclusive' };
  const chain = (publisher as unknown as { chain?: ChainAdapter }).chain;
  if (!chain) return { status: 'inconclusive' };

  try {
    if (chain.resolvePublishTransaction) {
      const resolution = await chain.resolvePublishTransaction(lookup.txHash);
      return resolution.status === 'confirmed'
        ? { status: 'confirmed', publish: resolution.publish, chain }
        : resolution;
    }
    if (!chain.resolvePublishByTxHash) return { status: 'inconclusive' };
    const publish = await chain.resolvePublishByTxHash(lookup.txHash);
    return publish ? { status: 'confirmed', publish, chain } : { status: 'inconclusive' };
  } catch {
    // Transient RPC/provider errors establish nothing — report that rather than
    // crashing the daemon, so the recovery timeout mechanism handles it.
    return { status: 'inconclusive' };
  }
}

/** The confirmed publish, mapped to lift recovery evidence, or `null` if this node cannot. */
async function mapConfirmedPublishToLiftRecovery(
  publish: OnChainPublishResult,
  chain: ChainAdapter,
): Promise<AsyncLiftPublisherRecoveryResult | null> {
  let knowledgeAssetsContract = publish.knowledgeAssetsContract;
  if (!knowledgeAssetsContract && chain.getDKGKnowledgeAssetsAddress) {
    try {
      knowledgeAssetsContract = await chain.getDKGKnowledgeAssetsAddress();
    } catch {
      return null;
    }
  }
  if (!knowledgeAssetsContract) return null;
  return mapOnChainPublishResultToLiftRecovery(publish, chain.chainId, knowledgeAssetsContract);
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
  pageIndexStore?: SnapshotPageIndexStore,
): WorkspacePublicSnapshotStore | undefined {
  const snapshotConfig = config?.sharedMemoryPublicSnapshotStorage;
  if (snapshotConfig?.enabled === false) {
    return undefined;
  }
  return new FileWorkspacePublicSnapshotStore(
    snapshotConfig?.directory ?? join(dataDir, 'swm-public-snapshots'),
    pageIndexStore,
  );
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
