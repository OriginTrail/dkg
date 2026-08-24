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
  type AsyncLiftUpdateChainProofLookup,
  type AsyncLiftChainProofResolution,
  type AsyncLiftPublisherRecoveryResult,
  type VmPublisherControl,
  type LiftJob,
  type LiftJobHex,
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
// GH#2270 PR-3 r3 — chain-proof POLICY lives in its own module; this file stays the
// composition root that hands it the adapters and wires the result into the publisher.
import {
  asLiftJobBigInt,
  asLiftJobHex,
  chainAdaptersForWallets,
  createChainProofResolver,
  hasChainPublishLookup,
  hasChainRecoveryCapabilityFor,
  mapOnChainPublishResultToLiftRecovery,
  verifyCanonicalUpdateFacts,
  type PublisherChainAdapters,
} from './publisher-chain-proof.js';

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
  /**
   * GH#2270 follow-up (🔴 3822987482) — can THIS runtime settle a held job signed by this
   * wallet, for this operation kind? The daemon's ADMISSION instance is a separate, deliberately
   * resolver-less publisher (it runs no scheduler), so asking it whether an automatic exit exists
   * always answered "no" — every pending-chain-proof rejection claimed there was no automatic
   * recovery even on a node where recovery was configured and running. Admission now asks the
   * live runtime through this probe instead of inferring from its own wiring.
   */
  readonly canSettleHeldJob: (walletId: string, operationKind: 'create' | 'update' | undefined) => boolean;
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

/** Resolve the operator maintenance switch once at a CLI/daemon boundary. */
export function resolvePublisherStartPaused(value: string | undefined): boolean {
  return value === '1';
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
      recoveryIntervalMs: args.config.publisher.recoveryIntervalMs,
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
      startPaused: resolvePublisherStartPaused(process.env.DKG_PUBLISHER_START_PAUSED),
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
  recoveryIntervalMs?: number;
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
  /** Explicit startup mode resolved by the CLI or daemon boundary. */
  startPaused?: boolean;
}

export async function createPublisherRuntime(args: {
  dataDir: string;
  config: DkgConfig;
  pollIntervalMs?: number;
  errorBackoffMs?: number;
  recoveryIntervalMs?: number;
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
    recoveryIntervalMs: args.recoveryIntervalMs ?? args.config.publisher?.recoveryIntervalMs,
    maxRetries: args.maxRetries ?? args.config.publisher?.maxRetries,
    retryTuning: resolvePublisherRetryTuning(args.config.publisher),
    publicSnapshotStore,
    startPaused: resolvePublisherStartPaused(process.env.DKG_PUBLISHER_START_PAUSED),
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

/**
 * GH#2270 follow-up (🔴 3822987482, 🟡 3823952750) — the admission-to-runtime capability
 * bridge, as a named function so the seam itself is testable.
 *
 * The daemon builds its admission publisher BEFORE the runtime exists, and admission is what
 * answers "does this held job have an automatic exit". Reading that from the admission instance's
 * own wiring always said no, because that instance deliberately holds no resolver. This closes
 * over the late-bound state instead, so it answers `false` until the runtime is up and delegates
 * to it thereafter — forwarding both the wallet and the operation kind, since the runtime's answer
 * is per wallet AND per operation.
 */
/**
 * GH#2270 follow-up (🔴 3824531105) — the RUNTIME half of the capability bridge, as a named
 * factory so the production answer is reachable by a test rather than only by booting a daemon.
 *
 * This is the one function both sides use: the runtime's own publisher takes it as
 * `chainProofCapableForWallet`, and the runtime handle exposes it as `canSettleHeldJob` for the
 * daemon's admission instance to ask. Sharing it by identity is what keeps those two answers from
 * drifting; exporting it is what lets a test prove the answer is right rather than merely present.
 */
export function createRuntimeRecoveryCapability(
  chainAdapters: PublisherChainAdapters,
): (walletId: string, operationKind: 'create' | 'update' | undefined) => boolean {
  return (walletId, operationKind) => {
    const chain = chainAdapters.get(walletId);
    return chain !== undefined && hasChainRecoveryCapabilityFor(chain, operationKind);
  };
}

export function createAdmissionRecoveryCapabilityProbe(
  readState: () => { runtime?: { canSettleHeldJob: (w: string, k: 'create' | 'update' | undefined) => boolean } | null },
): (walletId: string, operationKind: 'create' | 'update' | undefined) => boolean {
  return (walletId, operationKind) => readState().runtime?.canSettleHeldJob(walletId, operationKind) ?? false;
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
    /**
     * GH#2270 follow-up (🔴 3822987482) — the capability oracle for the LIVE runtime. This
     * instance deliberately holds no resolver, but it is the one that answers admission, so it
     * must ask the lane that would actually do the work rather than infer from its own wiring.
     * Late-bound on purpose: the runtime starts after this instance is built.
     */
    chainProofCapableForWallet?: (
      walletId: string,
      operationKind: 'create' | 'update' | undefined,
    ) => boolean;
  } = {},
): VmPublisherControl {
  // The daemon admission instance also serves the #1828 recovery lookup (route)
  // and the boot index backfill — segregated capabilities the base
  // AsyncLiftPublisher runtime contract intentionally does NOT carry.
  return new TripleStoreAsyncLiftPublisher(store, {
    chainProofCapableForWallet: options.chainProofCapableForWallet,
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
  recoveryIntervalMs?: number;
  maxRetries?: number;
  retryTuning?: PublisherRetryTuning;
  config?: Pick<DkgConfig, 'sharedMemoryPublicSnapshotStorage'>;
  ackTransportFactory?: ACKTransportFactory;
  v10ACKProviderFactory?: () => PublishOptions['v10ACKProvider'];
  publishEncryptionFactory?: PublishEncryptionFactory;
  knowledgeAssetVmPublishHandler?: AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler'];
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  startPaused?: boolean;
}): Promise<PublisherRuntime> {
  return createPublisherRuntimeFromBase({
    dataDir: args.dataDir,
    keypair: args.keypair,
    store: args.store,
    chainBase: args.chainBase,
    pollIntervalMs: args.pollIntervalMs,
    errorBackoffMs: args.errorBackoffMs,
    recoveryIntervalMs: args.recoveryIntervalMs,
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
    startPaused: args.startPaused,
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
  // GH#2270 PR-3 r2 — the recovery factories take adapters, not publishers. Built here, from the
  // wallets, where `chain` is a public field rather than something to assert through.
  const chainAdapters = chainAdaptersForWallets(wallets);
  const hasChainRecovery = [...chainAdapters.values()].some(hasChainPublishLookup);
  // GH#2270 follow-up (🟡 3823952723) — ONE closure, used by both the runtime's own publisher and
  // the runtime handle the daemon's admission instance asks. These two answers are required to be
  // identical; computing them twice is precisely the drift this bridge exists to prevent, so they
  // share function identity rather than a copied body.
  const canSettleHeldJob = createRuntimeRecoveryCapability(chainAdapters);

  const scopedKnowledgeAssetVmPublishHandler = scopeKnowledgeAssetVmPublishHandler(
    publishers,
    args.knowledgeAssetVmPublishHandler,
  );
  // PR #2300 r2 (🟡 3809616683) — no shared verifier instance: the `recovered` verdict CARRIES
  // its canonical update evidence to the finalizer, so a recognized update is verified once per
  // recovery by construction, with no cache and no temporal coupling between the factories.
  const asyncPublisher = new TripleStoreAsyncLiftPublisher(args.store, {
    chainProofResolver: hasChainRecovery ? createChainProofResolver(chainAdapters) : undefined,
    // Receipt waiting is detached only when this runtime has the independent chain-proof lane
    // that can move the resulting tx-bearing `broadcast` record. Direct library consumers retain
    // the historical blocking `processNext()` contract by default.
    detachReceiptReconciliation: hasChainRecovery,
    // r20 (🔴 3815617109) — `hasChainRecovery` is `.some(...)`, so on a node mixing a capable
    // adapter with a legacy one the resolvers are installed for the whole node. The honesty
    // contract is per JOB, so admission must ask about the wallet that actually signs it rather
    // than inherit the node-wide answer.
    chainProofCapableForWallet: canSettleHeldJob,
    knowledgeAssetVmPublishRecoveryResolver: hasChainRecovery
      ? createKnowledgeAssetVmPublishRecoveryResolver(chainAdapters)
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
    recoveryIntervalMs: args.recoveryIntervalMs,
    // Operator-only maintenance seam. Recovery still reconciles signed transactions, but wallet
    // loops cannot claim released jobs while a closed run is being removed from the queue.
    startPaused: args.startPaused ?? false,
    hasIncludedRecoveryResolver: hasChainRecovery,
  });

  return {
    runner,
    publisher: asyncPublisher,
    walletIds: validWalletIds,
    wallets: wallets.map(({ address, identityId }) => ({ address, identityId })),
    drainRpcUsage: () => mergeRpcUsageWindows(...wallets.map((w) => w.chain.drainRpcUsage?.())),
    // The SAME question the runtime's own publisher answers, from the same adapter map, so the
    // daemon's admission instance and the lane that would do the work cannot disagree.
    canSettleHeldJob,
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


export function createKnowledgeAssetVmPublishRecoveryResolver(
  adapters: PublisherChainAdapters,
): AsyncKnowledgeAssetVmPublishRecoveryResolver {
  return async (job, lookup, verdictRecovery, options) => {
    // GH#2270 PR-3 r4 — an UPDATE transaction has no publish receipt to resolve canonically; its
    // proof is the update-verification machinery, against the exact root the queued seal
    // intended. PR #2300 r2 — when the dispatcher's verdict already CARRIES the canonical
    // evidence, it is consumed directly (one verification per recovery, no shared state); the
    // LIVE interrupted lane arrives with no verdict and verifies once here, behind the same
    // finality gate.
    if (lookup.operationKind === 'update') {
      return resolveCanonicalUpdateRecoveryEvidence(job, lookup, adapters, verdictRecovery, options);
    }
    const recovered = await resolveCanonicalOnChainPublish(lookup, adapters, options);
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

/**
 * GH#2270 PR-3 r4 — recovery evidence for a queued named-KA UPDATE. PR #2300 r1 (🟡 3809054830):
 * the ESTABLISHMENT lives in the shared {@link CanonicalUpdateVerifier} — the same verification
 * the dispatcher's verdict came from, so a recovery that reached this finalizer never re-proves
 * the transaction, and the two consumers cannot drift on the binding rules. This is only the
 * mapping of those verified facts to the named lane's evidence shape: singleton batch range
 * pinned to the reserved id, the graph-local queued UAL for materialization, and the publish
 * proof carrying the chain-verified root plus the request's sealed author. Every gap answers
 * `null`, and the publisher keeps the job held — including facts verified without a canonical
 * block hash or tx index, which cannot make durable evidence.
 */
async function resolveCanonicalUpdateRecoveryEvidence(
  job: LiftJob,
  lookup: AsyncLiftUpdateChainProofLookup,
  adapters: PublisherChainAdapters,
  verdictRecovery: AsyncLiftPublisherRecoveryResult | undefined,
  options?: { readonly signal?: AbortSignal },
): Promise<AsyncKnowledgeAssetVmPublishRecoveryEvidence | null> {
  const request = job.request?.jobType === 'knowledge-asset-vm-publish'
    ? job.request.knowledgeAssetVmPublish
    : undefined;
  if (
    request?.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION
    || request.kaUal === undefined
    || lookup.publishIdentityKaId === undefined
  ) {
    return null;
  }
  // PR #2300 r2 — the verdict's canonical evidence is the SAME verification this recovery was
  // dispatched on; consume it rather than re-proving the transaction. The kaId comes from the
  // lookup the verification was bound to. Only a verdict-less arrival (the LIVE interrupted
  // lane) verifies here — once, behind the same finality gate.
  let kaId: bigint;
  try {
    kaId = BigInt(lookup.publishIdentityKaId);
  } catch {
    return null;
  }
  const facts = verdictRecovery?.canonicalUpdate
    ? {
        kaId,
        onChainRoot: verdictRecovery.canonicalUpdate.onChainRoot,
        blockNumber: verdictRecovery.inclusion.blockNumber,
        ...(verdictRecovery.canonicalUpdate.merkleRootCount !== undefined
          ? { merkleRootCount: verdictRecovery.canonicalUpdate.merkleRootCount }
          : {}),
        blockHash: verdictRecovery.canonicalUpdate.blockHash,
        txIndex: verdictRecovery.canonicalUpdate.txIndex,
      }
    : await verifyCanonicalUpdateFacts(lookup, adapters, options);
  if (!facts) return null;
  if (facts.txIndex === undefined) return null;
  const blockHash = facts.blockHash ? asLiftJobHex(facts.blockHash) : null;
  if (!blockHash) return null;
  const authorAddress = asLiftJobHex(request.seal.authorAddress);
  const publisherAddress = asLiftJobHex(lookup.walletId);
  if (!authorAddress || !publisherAddress) return null;

  return {
    inclusion: {
      txHash: lookup.txHash,
      blockNumber: facts.blockNumber,
      blockHash,
    },
    finalization: {
      mode: 'published',
      txHash: lookup.txHash,
      ual: request.kaUal,
      batchId: facts.kaId.toString() as `${bigint}`,
      startKAId: facts.kaId.toString() as `${bigint}`,
      endKAId: facts.kaId.toString() as `${bigint}`,
      publisherAddress,
    },
    publishProof: {
      merkleRoot: facts.onChainRoot,
      authorAddress,
      txIndex: facts.txIndex,
      ...(facts.merkleRootCount !== undefined ? { merkleRootCount: facts.merkleRootCount } : {}),
      operationKind: 'update',
    },
  };
}

async function resolveCanonicalOnChainPublish(
  lookup: AsyncLiftChainProofLookup,
  adapters: PublisherChainAdapters,
  options?: { readonly signal?: AbortSignal },
): Promise<{
  receipt: CanonicalFinalizationReceipt;
  chain: ChainAdapter;
  knowledgeAssetsContract: string;
} | null> {
  const chain = adapters.get(lookup.walletId);
  if (!chain?.resolveCanonicalFinalizationReceipt) return null;

  let resolution;
  try {
    resolution = await chain.resolveCanonicalFinalizationReceipt(lookup.txHash, options);
  } catch {
    return null;
  }
  if (resolution.status !== 'confirmed') return null;

  // r14 (3814018304) — the same finality rule every other mined verdict in this chain follows. This
  // is the CREATE branch's own resolver path: it reads a canonical receipt directly rather than
  // going through the gated verdict, so without this it could begin finalizing from a receipt a
  // reorg can still rewrite while every finality row on the update branch stayed green.
  if (!chain.isReceiptBlockFinalAndCanonical) return null;
  try {
    // r25 (🔴 3820711175) — the finality gate takes the pass deadline like every other read on
    // this branch; it was the one left detached after the receipt lookup was threaded.
    const final = await chain.isReceiptBlockFinalAndCanonical({
      txHash: lookup.txHash,
      blockNumber: resolution.receipt.blockNumber,
      blockHash: resolution.receipt.blockHash,
    }, options);
    if (!final) return null;
  } catch {
    return null;
  }

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
    publishProof: { merkleRoot, authorAddress, txIndex: receipt.txIndex, operationKind: 'create' },
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
  pageIndexStore?: SnapshotPageIndexStore,
  log?: (message: string) => void,
): WorkspacePublicSnapshotStore | undefined {
  const snapshotConfig = config?.sharedMemoryPublicSnapshotStorage;
  if (snapshotConfig?.enabled === false) {
    return undefined;
  }
  return new FileWorkspacePublicSnapshotStore(
    snapshotConfig?.directory ?? join(dataDir, 'swm-public-snapshots'),
    pageIndexStore,
    { gc: snapshotConfig?.gc, log },
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
