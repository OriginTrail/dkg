import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus, DKGEvent,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE, PROTOCOL_STORAGE_ACK, PROTOCOL_VERIFY_PROPOSAL, PROTOCOL_JOIN_REQUEST,
  paranetPublishTopic, paranetWorkspaceTopic, paranetAppTopic, paranetUpdateTopic, paranetFinalizationTopic,
  paranetDataGraphUri, paranetMetaGraphUri, paranetWorkspaceGraphUri, paranetWorkspaceMetaGraphUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiedMemoryUri, contextGraphVerifiedMemoryMetaUri,
  contextGraphMetaUri, assertionLifecycleUri, contextGraphAssertionUri,
  MemoryLayer,
  computeACKDigest,
  encodePublishRequest,
  encodeKAUpdateRequest,
  encodeFinalizationMessage, type FinalizationMessageMsg,
  getGenesisQuads, computeNetworkId, SYSTEM_PARANETS, DKG_ONTOLOGY,
  Logger, createOperationContext, withRetry, sparqlString, escapeSparqlLiteral,
  type DKGNodeConfig, type OperationContext, type GetView, type AssertionDescriptor, type AssertionEvent, type AssertionState,
} from '@origintrail-official/dkg-core';
import { GraphManager, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateOnChainContextGraphParams, type CreateOnChainContextGraphResult } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, SharedMemoryHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  ACKCollector, StorageACKHandler,
  VerifyCollector, VerifyProposalHandler, buildVerificationMetadata,
  computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot, autoPartition,
  type PublishResult, type PhaseCallback, type KAMetadata, type CASCondition,
  type CollectedACK,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import {
  DKGQueryEngine, QueryHandler,
  type QueryRequest, type QueryResponse, type QueryAccessConfig, type LookupType,
} from '@origintrail-official/dkg-query';
import { DKGAgentWallet, type AgentWallet } from './agent-wallet.js';
import { ProfileManager } from './profile-manager.js';
import { DiscoveryClient, type SkillSearchOptions, type DiscoveredAgent, type DiscoveredOffering } from './discovery.js';
import { MessageHandler, type SkillHandler, type SkillRequest, type SkillResponse, type ChatHandler } from './messaging.js';
import { ed25519ToX25519Private, ed25519ToX25519Public } from './encryption.js';
import { AGENT_REGISTRY_CONTEXT_GRAPH, type AgentProfileConfig } from './profile.js';
import {
  generateCustodialAgent, registerSelfSovereignAgent, agentFromPrivateKey,
  hashAgentToken,
  type AgentKeyRecord,
} from './agent-keystore.js';
import { GossipPublishHandler } from './gossip-publish-handler.js';
import { FinalizationHandler } from './finalization-handler.js';
import { multiaddr } from '@multiformats/multiaddr';
import { buildCclPolicyQuads, buildPolicyApprovalQuads, buildPolicyRevocationQuads, hashCclPolicy, type CclPolicyRecord, type PolicyApprovalBinding } from './ccl-policy.js';
import { CclEvaluator, parseCclPolicy, validateCclPolicy, type CclEvaluationResult, type CclFactTuple } from './ccl-evaluator.js';
import { buildCclEvaluationQuads } from './ccl-evaluation-publish.js';
import { buildManualCclFacts, resolveFactsFromSnapshot, type CclFactResolutionMode } from './ccl-fact-resolution.js';

export interface CclPublishedResultEntry {
  entryUri: string;
  kind: 'derived' | 'decision';
  name: string;
  tuple: unknown[];
}

export interface CclPublishedEvaluationRecord {
  evaluationUri: string;
  policyUri: string;
  factSetHash: string;
   factQueryHash?: string;
   factResolverVersion?: string;
   factResolutionMode?: CclFactResolutionMode;
  createdAt?: string;
  view?: string;
  snapshotId?: string;
  scopeUal?: string;
  contextType?: string;
  results: CclPublishedResultEntry[];
}

interface PublishOpts {
  onPhase?: PhaseCallback;
  operationCtx?: OperationContext;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
  /** Target sub-graph within the context graph (e.g. "code", "decisions"). */
  subGraphName?: string;
}

type JsonLdDocument = Record<string, unknown> | Record<string, unknown>[];
type JsonLdContent = JsonLdDocument | { public?: JsonLdDocument; private?: JsonLdDocument };

const SYNC_PAGE_SIZE = 500;
const SYNC_PAGE_RETRY_ATTEMPTS = 3;
const SYNC_TOTAL_TIMEOUT_MS = 120_000;
/** Per-page timeout for sync when we have budget (relay links can be slow). */
const SYNC_PAGE_TIMEOUT_MS = 45_000;
/** ProtocolRouter.send retries internally 3 times with the same timeout; cap so 3× fits in remaining budget. */
const SYNC_ROUTER_ATTEMPTS = 3;
const SYNC_PROTOCOL_CHECK_ATTEMPTS = 3;
const SYNC_PROTOCOL_CHECK_DELAY_MS = 500;
const SYNC_AUTH_MAX_AGE_MS = 90_000;

/**
 * Wire-level sentinel returned by the sync responder when ACL authorization
 * fails for a request. Distinguishes an explicit denial from an empty page
 * (peer is up but has no data) and a transport error (peer unreachable).
 * Chosen to never collide with nquads output (nquads lines always contain
 * `<…>` tokens and end with `.`; this is a `#`-comment string).
 */
const SYNC_ACCESS_DENIED_MARKER = '#DKG-SYNC-ACCESS-DENIED';

/**
 * Thrown by `fetchSyncPages` when the remote responder returned
 * SYNC_ACCESS_DENIED_MARKER. Caught by `syncFromPeer` and surfaced as a
 * per-CG denial observation to the caller via its `onAccessDenied` hook,
 * so higher-level flows (catch-up job) can distinguish ACL denial from
 * transport errors without heuristics.
 */
class SyncAccessDeniedError extends Error {
  readonly contextGraphId: string;
  constructor(contextGraphId: string) {
    super(`Sync access denied for context graph "${contextGraphId}"`);
    this.name = 'SyncAccessDeniedError';
    this.contextGraphId = contextGraphId;
  }
}
const META_REFRESH_COOLDOWN_MS = 30_000;
const SYNC_MIN_GRAPH_BUDGET_MS = 10_000;
const DEFAULT_SWM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SWM_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // run cleanup every 15 minutes
const SYNC_DENIED_RESPONSE = '__DKG_SYNC_DENIED__';
/**
 * How long to wait between reconnect-on-gossip dial attempts for the same peer.
 * A CG with chatty gossip could otherwise produce a dial per message; this
 * throttles us to at most one attempted dial per peer per window.
 */
const GOSSIP_DIAL_COOLDOWN_MS = 30_000;
/** Per-dial-attempt timeout for reconnect-on-gossip so a stuck dial can't starve the gossip handler path. */
const GOSSIP_DIAL_TIMEOUT_MS = 10_000;
/**
 * Cooldown for catchup-on-connection:open: suppresses duplicate catchup kicks
 * when the same peer briefly has overlapping direct + relayed connections
 * (each of which fires its own connection:open).
 */
const CATCHUP_ON_CONNECT_COOLDOWN_MS = 60_000;

interface SyncRequestEnvelope {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  phase?: 'data' | 'meta';
  targetPeerId?: string;
  requesterPeerId?: string;
  requestId?: string;
  issuedAtMs?: number;
  requesterIdentityId?: string;
  requesterAgentAddress?: string;
  requesterSignatureR?: string;
  requesterSignatureVS?: string;
}

/** Health status of a peer from the last ping round. */
export interface PeerHealth {
  peerId: string;
  alive: boolean;
  latencyMs: number | null;
  lastSeen: number | null;
  lastChecked: number;
}

/** Tracks the subscription and sync state of a context graph. */
export interface ContextGraphSub {
  name?: string;
  /** GossipSub topics are active for this context graph. */
  subscribed: boolean;
  /** Definition triples exist in the local triple store. */
  synced: boolean;
  /**
   * Whether the `_meta` graph (allowlist, registration status) has been
   * fetched via authenticated sync or is known from local creation.
   * When false, the gossip handler denies writes to prevent unauthorized
   * access during the window before _meta arrives.
   */
  metaSynced?: boolean;
  /** On-chain context graph ID (keccak256 hash), if known. */
  onChainId?: string;
  /** Local participant identities used for private SWM authorization before anchoring. */
  participantIdentityIds?: bigint[];
  /** Participant agent addresses (V10 agent identity model). */
  participantAgents?: string[];
}

/** @deprecated Use ContextGraphSub */
export type ParanetSub = ContextGraphSub;

export interface DurableSyncDiagnostics {
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  emptyResponses: number;
  metaOnlyResponses: number;
  dataRejectedMissingMeta: number;
  rejectedKcs: number;
  failedPeers: number;
}

export interface SharedMemorySyncDiagnostics {
  fetchedMetaTriples: number;
  fetchedDataTriples: number;
  insertedMetaTriples: number;
  insertedDataTriples: number;
  emptyResponses: number;
  droppedDataTriples: number;
  failedPeers: number;
}

export interface CatchupSyncDiagnostics {
  noProtocolPeers: number;
  durable: DurableSyncDiagnostics;
  sharedMemory: SharedMemorySyncDiagnostics;
}

interface DurableSyncResult extends DurableSyncDiagnostics {
  insertedTriples: number;
}

interface SharedMemorySyncResult extends SharedMemorySyncDiagnostics {
  insertedTriples: number;
}

export interface DKGAgentConfig {
  name: string;
  framework?: string;
  description?: string;
  listenPort?: number;
  /** IP address to listen on. Default: '0.0.0.0' (all interfaces). Use '127.0.0.1' for tests. */
  listenHost?: string;
  bootstrapPeers?: string[];
  /** Multiaddrs of relay nodes for NAT traversal. */
  relayPeers?: string[];
  /** Multiaddrs to announce to the network (for VPS/cloud nodes with a public IP not on the interface). */
  announceAddresses?: string[];
  skills?: Array<{
    skillType: string;
    pricePerCall?: number;
    currency?: string;
    handler: SkillHandler;
  }>;
  dataDir?: string;
  store?: TripleStore;
  /** Triple store backend configuration (e.g. oxigraph-worker, blazegraph). If omitted, defaults to oxigraph-worker when dataDir is set. */
  storeConfig?: TripleStoreConfig;
  /** Node deployment tier: 'core' (cloud, relay) or 'edge' (personal, behind NAT). Default: 'edge'. */
  nodeRole?: 'core' | 'edge';
  /** Pre-built chain adapter (for testing). If provided, chainConfig is ignored. */
  chainAdapter?: ChainAdapter;
  /** Private key for the V10 ACK signer. When omitted, falls back to chainConfig.operationalKeys[0]. */
  ackSignerKey?: string;
  /**
   * EVM chain configuration. If omitted, publishing won't have on-chain finality.
   * `operationalKeys` are the private keys for operational wallets.
   * The first key is the primary signer (identity, staking); all are used
   * round-robin for publish TXs to avoid nonce collisions on parallel publishes.
   */
  chainConfig?: {
    rpcUrl: string;
    hubAddress: string;
    operationalKeys: string[];
    chainId?: string;
  };
  /** Cross-agent query access configuration. */
  queryAccess?: QueryAccessConfig;
  /** Additional context graph IDs to sync on peer connect (beyond system context graphs). */
  syncContextGraphs?: string[];
  /** TTL for shared memory data in milliseconds. Expired operations are periodically cleaned up. Default: 48 hours. Set to 0 to disable. */
  sharedMemoryTtlMs?: number;
}

/**
 * High-level facade that ties together all DKG agent capabilities:
 * identity, networking, publishing, querying, discovery, and messaging.
 *
 * Usage:
 *   const agent = await DKGAgent.create({ name: 'MyBot', skills: [...] });
 *   await agent.start();
 *   const offerings = await agent.findSkills({ skillType: 'ImageAnalysis' });
 *   const response = await agent.invokeSkill(offerings[0], inputData);
 *   await agent.stop();
 */
export class DKGAgent {
  readonly wallet: AgentWallet;
  readonly node: DKGNode;
  readonly store: TripleStore;
  readonly publisher: DKGPublisher;
  readonly queryEngine: DKGQueryEngine;
  readonly discovery: DiscoveryClient;
  readonly profileManager: ProfileManager;
  gossip!: GossipSubManager;
  router!: ProtocolRouter;
  readonly eventBus: TypedEventBus;
  private readonly chain: ChainAdapter;
  /** Shared memory-owned root entities per context graph: entity → creatorPeerId. Used by publisher and shared memory handler. */
  private readonly workspaceOwnedEntities: Map<string, Map<string, string>>;
  /** Shared write locks so gossip writes serialize against local CAS writes. */
  private readonly writeLocks: Map<string, Promise<void>>;
  private sharedMemoryHandler?: InstanceType<typeof SharedMemoryHandler>;
  private gossipPublishHandler?: GossipPublishHandler;
  private finalizationHandler?: FinalizationHandler;
  private readonly log = new Logger('DKGAgent');

  private messageHandler: MessageHandler | null = null;
  private chainPoller: ChainEventPoller | null = null;
  private swmCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: DKGAgentConfig;
  private started = false;
  private readonly subscribedContextGraphs = new Map<string, ContextGraphSub>();
  private readonly gossipRegistered = new Set<string>();
  private readonly seenOnChainIds = new Set<string>();
  private readonly peerHealth = new Map<string, PeerHealth>();
  private readonly knownCorePeerIds = new Set<string>();
  private readonly syncingPeers = new Set<string>();
  private readonly seenPrivateSyncRequestIds = new Map<string, number>();
  private readonly metaRefreshTimestamps = new Map<string, number>();
  private readonly preferredSyncPeers = new Map<string, string>();
  /**
   * Remembers the libp2p peer ID that delivered each pending join request
   * to this curator. Keyed by `${contextGraphId}::${agentAddress_lower}`.
   *
   * This is the authoritative source when we later need to notify that
   * requester about approval/rejection — the agent registry can be stale
   * (a requester may P2P-reach us before their agent profile has indexed
   * locally), so without this map we'd drop notifications and leave the
   * invitee stuck on "Join request sent, awaiting approval". See
   * `notifyJoinApproval` / `notifyJoinRejection`.
   *
   * In-memory only: survives for the curator's process lifetime, which
   * matches the approval window in practice. On restart we fall back to
   * the agent registry.
   */
  private readonly joinRequestOriginPeers = new Map<string, string>();
  /**
   * Per-peer timestamp of the last reconnect-on-gossip dial we attempted.
   * Prevents a noisy topic from generating a dial storm against a peer we
   * already tried recently. See DOC: p2p-resilience.md.
   */
  private readonly gossipDialAttemptedAt = new Map<string, number>();
  /**
   * Per-peer timestamp of the last catchup-on-connect we queued, to dedupe
   * connection:open events when the same peer briefly churns between
   * direct + relayed connections within a short window.
   */
  private readonly catchupOnConnectAt = new Map<string, number>();

  /** Registered agents on this node: agentAddress → AgentKeyRecord */
  private readonly localAgents = new Map<string, AgentKeyRecord>();
  /** Agent token → agentAddress lookup for Bearer-based agent resolution */
  private readonly agentTokenIndex = new Map<string, string>();
  /** The default "owner" agent address (first operational wallet, auto-registered on boot) */
  private defaultAgentAddress: string | undefined;

  private constructor(
    config: DKGAgentConfig,
    wallet: DKGAgentWallet,
    node: DKGNode,
    store: TripleStore,
    publisher: DKGPublisher,
    queryEngine: DKGQueryEngine,
    eventBus: TypedEventBus,
    chain: ChainAdapter,
    workspaceOwnedEntities: Map<string, Map<string, string>>,
    writeLocks: Map<string, Promise<void>>,
  ) {
    this.config = config;
    this.wallet = wallet;
    this.node = node;
    this.store = store;
    this.publisher = publisher;
    this.queryEngine = queryEngine;
    this.workspaceOwnedEntities = workspaceOwnedEntities;
    this.writeLocks = writeLocks;
    this.eventBus = eventBus;
    this.chain = chain;
    this.discovery = new DiscoveryClient(queryEngine);
    this.profileManager = new ProfileManager(publisher, store);
  }

  static async create(config: DKGAgentConfig): Promise<DKGAgent> {
    let wallet: DKGAgentWallet;
    if (config.dataDir) {
      try {
        wallet = await DKGAgentWallet.load(config.dataDir);
      } catch {
        wallet = await DKGAgentWallet.generate();
        await wallet.save(config.dataDir);
      }
    } else {
      wallet = await DKGAgentWallet.generate();
    }
    const log = new Logger('DKGAgent');
    const ctx = createOperationContext('system');
    let store: TripleStore;
    if (config.store) {
      store = config.store;
    } else if (config.storeConfig) {
      store = await createTripleStore(config.storeConfig);
      log.info(ctx, `Triple store backend: ${config.storeConfig.backend}`);
    } else if (config.dataDir) {
      const { join } = await import('node:path');
      const persistPath = join(config.dataDir, 'store.nq');
      store = await createTripleStore({ backend: 'oxigraph-worker', options: { path: persistPath } });
      log.info(ctx, `Persistent triple store (worker thread): ${persistPath}`);
    } else {
      store = await createTripleStore({ backend: 'oxigraph' });
      log.warn(ctx, `No dataDir — triple store is in-memory (data will be lost on restart)`);
    }

    let chain: ChainAdapter;
    let opKeys = config.chainConfig?.operationalKeys;
    if (config.chainAdapter) {
      chain = config.chainAdapter;
      if (!opKeys?.length && typeof (chain as any).getOperationalPrivateKey === 'function') {
        opKeys = [(chain as any).getOperationalPrivateKey()];
      }
    } else if (config.chainConfig && opKeys?.length) {
      chain = new EVMChainAdapter({
        rpcUrl: config.chainConfig.rpcUrl,
        privateKey: opKeys[0],
        additionalKeys: opKeys.slice(1),
        hubAddress: config.chainConfig.hubAddress,
        chainId: config.chainConfig.chainId,
      });
    } else {
      chain = new NoChainAdapter();
    }

    const eventBus = new TypedEventBus();
    const keypair = wallet.keypair;

    // Load genesis knowledge into the store (idempotent)
    await DKGAgent.loadGenesis(store);

    const port = config.listenPort ?? 0;
    const host = config.listenHost ?? '0.0.0.0';
    const nodeRole = config.nodeRole ?? 'edge';
    const nodeConfig: DKGNodeConfig = {
      listenAddresses: [`/ip4/${host}/tcp/${port}`],
      announceAddresses: config.announceAddresses,
      bootstrapPeers: config.bootstrapPeers,
      relayPeers: config.relayPeers,
      enableMdns: !config.bootstrapPeers?.length && !config.relayPeers?.length,
      privateKey: keypair.secretKey,
      nodeRole,
    };

    const node = new DKGNode(nodeConfig);
    const workspaceOwnedEntities = new Map<string, Map<string, string>>();
    const writeLocks = new Map<string, Promise<void>>();
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: opKeys?.[0],
      sharedMemoryOwnedEntities: workspaceOwnedEntities,
      writeLocks,
    });

    try {
      const restored = await publisher.reconstructWorkspaceOwnership();
      if (restored > 0) {
        const log = new Logger('DKGAgent');
        log.info(createOperationContext('init'), `Restored ${restored} shared memory ownership entries from store`);
      }
    } catch (err) {
      const log = new Logger('DKGAgent');
      log.warn(createOperationContext('init'), `Failed to reconstruct shared memory ownership, continuing without: ${err instanceof Error ? err.message : String(err)}`);
    }

    const queryEngine = new DKGQueryEngine(store);

    return new DKGAgent(
      config, wallet, node, store, publisher, queryEngine, eventBus, chain,
      workspaceOwnedEntities, writeLocks,
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    const ctx = createOperationContext('connect');
    this.log.info(ctx, `Starting DKG node`);

    await this.node.start();
    this.started = true;
    this.log.info(ctx, `Node started, peer ID: ${this.node.peerId.toString()}`);

    // Load registered agents from triple store; auto-register default if none exist.
    // loadAgentsFromStore restores defaultAgentAddress from the persisted
    // isDefaultAgent marker, avoiding reliance on SPARQL result ordering.
    await this.loadAgentsFromStore();
    if (this.localAgents.size === 0) {
      await this.autoRegisterDefaultAgent();
    }
    if (!this.defaultAgentAddress && this.localAgents.size > 0) {
      // Fallback: no persisted marker — pick first and persist for next boot
      const first = this.localAgents.values().next().value!;
      this.defaultAgentAddress = first.agentAddress;
      await this.markDefaultAgent(first.agentAddress).catch(() => {});
    }

    this.router = new ProtocolRouter(this.node);
    this.gossip = new GossipSubManager(this.node, this.eventBus);

    // Register protocol handlers
    const accessHandler = new AccessHandler(this.store, this.eventBus);
    this.router.register(PROTOCOL_ACCESS, accessHandler.handler);

    const journal = this.config.dataDir ? new PublishJournal(this.config.dataDir) : undefined;
    const publishHandler = new PublishHandler(this.store, this.eventBus, { journal });
    this.router.register(PROTOCOL_PUBLISH, publishHandler.handler);
    if (journal) {
      try {
        await publishHandler.restorePendingPublishes();
      } catch (err) {
        this.log.warn(ctx, `Journal restore failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Register cross-agent query handler (deny-by-default for security)
    const queryAccessConfig: QueryAccessConfig = this.config.queryAccess ?? {
      defaultPolicy: 'deny',
    };
    if (this.config.queryAccess?.defaultPolicy === 'public') {
      this.log.warn(ctx, 'Query access policy is "public" — all remote queries will be accepted. Set queryAccess.defaultPolicy to "deny" for stricter security.');
    }
    const queryRemoteHandler = new QueryHandler(this.queryEngine, queryAccessConfig);
    this.router.register(PROTOCOL_QUERY_REMOTE, queryRemoteHandler.handler);

    const effectiveRole = this.config.nodeRole ?? 'edge';

    // Auto-detect or register on-chain identity.
    // Edge nodes skip profile creation — they operate with agent identity only.
    if (this.chain.chainId !== 'none') {
      let identityId = 0n;
      try {
        identityId = await this.chain.getIdentityId();
        if (identityId === 0n && effectiveRole === 'core') {
          this.log.info(ctx, `No on-chain identity found, creating profile and staking...`);
          identityId = await this.chain.ensureProfile({
            nodeName: this.config.name,
          });
          this.log.info(ctx, `On-chain profile created, identityId=${identityId}`);
        } else if (identityId === 0n) {
          this.log.info(ctx, `Edge node — skipping on-chain profile creation (agent identity only)`);
        } else {
          this.log.info(ctx, `On-chain identity found: identityId=${identityId}`);
        }
      } catch (err) {
        this.log.warn(ctx, `ensureProfile error: ${err instanceof Error ? err.message : String(err)}`);
        try {
          identityId = await this.chain.getIdentityId();
          if (identityId > 0n) {
            this.log.info(ctx, `Recovered identityId=${identityId} after partial failure`);
          }
        } catch { /* ignore */ }
      }
      if (identityId > 0n) {
        this.publisher.setIdentityId(identityId);
        this.log.info(ctx, `Publisher using identityId=${identityId}`);
      } else if (effectiveRole === 'core') {
        this.log.warn(ctx, `No valid on-chain identity — on-chain publishes will be skipped`);
      }
    }

    // Register V10 StorageACK handler AFTER ensureProfile so identity is resolved.
    // Only core nodes register the StorageACK handler — edge nodes cannot
    // sign ACKs (the handler would reject immediately) and advertising the
    // protocol confuses peer-role detection based on protocol support.
    if (effectiveRole === 'core') {
      const ackSignerKeyStr = this.config.ackSignerKey
        ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined);
      if (ackSignerKeyStr) {
        try {
          const ackSignerWallet = new ethers.Wallet(ackSignerKeyStr);
          const identityId = await this.chain.getIdentityId();
          if (identityId > 0n) {
            // The V10 ACK digest includes a (chainid, kav10Address) H5 prefix
            // per KnowledgeAssetsV10.sol:362-373. Resolve both from the chain
            // adapter BEFORE constructing the handler so the handler can sign
            // digests that actually verify on-chain. The handler itself has
            // no provider-backed dependency, so both values are passed in at
            // construction.
            const chainIdForHandler = typeof this.chain.getEvmChainId === 'function'
              ? await this.chain.getEvmChainId()
              : undefined;
            const kav10AddressForHandler = typeof this.chain.getKnowledgeAssetsV10Address === 'function'
              ? await this.chain.getKnowledgeAssetsV10Address()
              : undefined;
            if (chainIdForHandler === undefined || kav10AddressForHandler === undefined) {
              this.log.warn(
                ctx,
                `Skipping V10 StorageACK handler: chain adapter does not expose ` +
                `getEvmChainId() + getKnowledgeAssetsV10Address(); handler cannot build the ` +
                `H5-prefixed ACK digest that KnowledgeAssetsV10 verifies on-chain`,
              );
            } else {
              const ackHandler = new StorageACKHandler(this.store, {
                nodeRole: effectiveRole,
                nodeIdentityId: typeof identityId === 'bigint' ? identityId : BigInt(identityId),
                signerWallet: ackSignerWallet,
                contextGraphSharedMemoryUri,
                chainId: chainIdForHandler,
                kav10Address: kav10AddressForHandler,
              }, this.eventBus);
              this.router.register(PROTOCOL_STORAGE_ACK, ackHandler.handler);
              this.log.info(ctx, `Registered V10 StorageACK handler (identity=${identityId})`);
            }
          } else {
            this.log.warn(ctx, `Skipping V10 StorageACK handler registration — identity not yet provisioned`);
          }
        } catch (err) {
          this.log.warn(ctx, `Skipping V10 StorageACK handler: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (typeof this.chain.signACKDigest === 'function') {
        this.log.info(ctx, `V10 StorageACK: adapter has signACKDigest but no extractable key — handler registration deferred until callback signing is supported`);
      }
    } else {
      this.log.info(ctx, `Node role is '${effectiveRole}' — skipping StorageACK handler registration (core-only)`);
    }

    // Register VERIFY proposal handler — responds to incoming M-of-N proposals.
    // Agents on the allowList sign the verify digest when they agree with the data.
    // Uses the ACK signer key (core nodes) or first operational key (edge nodes).
    const verifySignerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (verifySignerKey) {
      const verifyWallet = new ethers.Wallet(verifySignerKey);
      const verifyHandler = new VerifyProposalHandler({
        store: this.store,
        agentPrivateKey: verifySignerKey,
        agentAddress: verifyWallet.address,
        getBatchMerkleRoot: async (cgId: string, batchId: bigint) => {
          const metaGraph = paranetMetaGraphUri(cgId);
          // Try typed literal first, fallback to untyped for backward compat
          for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
            const result = await this.store.query(
              `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <https://dkg.network/ontology#merkleRoot> ?root . ?kc <https://dkg.network/ontology#batchId> ${literal} } } LIMIT 1`,
            );
            if (result.type === 'bindings' && result.bindings.length > 0) {
              const hex = (result.bindings[0] as Record<string, string>)['root'];
              if (!hex) return null;
              return ethers.getBytes(hex.startsWith('"') ? hex.slice(1, -1) : hex);
            }
          }
          return null;
        },
        getContextGraphIdOnChain: async (cgId: string) => {
          const sub = this.subscribedContextGraphs.get(cgId);
          return sub?.onChainId ? BigInt(sub.onChainId) : null;
        },
      });
      this.router.register(PROTOCOL_VERIFY_PROPOSAL, verifyHandler.handler);
      this.log.info(ctx, 'Registered VERIFY proposal handler');
    }

    // Start chain event poller for trustless confirmation of tentative publishes
    // and discovery of on-chain context graphs. Only with a real chain adapter.
    if (this.chain.chainId !== 'none') {
      this.chainPoller = new ChainEventPoller({
        chain: this.chain,
        publishHandler,
        onContextGraphCreated: async ({ contextGraphId, creator, accessPolicy, blockNumber }) => {
          this.log.info(ctx, `Discovered on-chain context graph ${contextGraphId.slice(0, 16)}… (block ${blockNumber}, creator ${creator.slice(0, 10)}…, policy ${accessPolicy})`);

          // Track the hash for dedup but don't pollute subscribedContextGraphs.
          // Gossip topics are keyed by cleartext name, not the on-chain hash.
          // The context graph will be fully subscribed once ontology sync or
          // discoverContextGraphsFromChain resolves the cleartext name.
          const alreadyKnown = this.seenOnChainIds.has(contextGraphId)
            || [...this.subscribedContextGraphs.values()].some(s => s.onChainId === contextGraphId);
          if (!alreadyKnown) {
            this.seenOnChainIds.add(contextGraphId);
            this.log.info(ctx, `Noted on-chain context graph ${contextGraphId.slice(0, 16)}… — will subscribe once cleartext name is resolved`);
          }
        },
      });
      this.chainPoller.start();
      this.log.info(ctx, `Chain event poller started`);
    }

    // Set up messaging
    const x25519Priv = ed25519ToX25519Private(this.wallet.keypair.secretKey);
    this.messageHandler = new MessageHandler(
      this.router,
      this.wallet.keypair,
      x25519Priv,
      this.node.peerId,
      this.eventBus,
    );

    // Wire up pending chat handler
    if (this._pendingChatHandler) {
      this.messageHandler.onChat(this._pendingChatHandler);
      this._pendingChatHandler = null;
    }

    // Register skill handlers
    if (this.config.skills) {
      for (const skill of this.config.skills) {
        const uri = `https://dkg.origintrail.io/skill#${skill.skillType}`;
        this.messageHandler.registerSkill(uri, skill.handler);
      }
    }

    // Register sync handler: responds with a page of data OR meta triples.
    // Request: JSON SyncRequestEnvelope (authenticated for private CGs) or
    //          pipe-delimited "contextGraphId|offset|limit[|meta]".
    // The "phase" field ('data' or 'meta') controls which graph is queried.
    // Meta is fetched separately (paginated) to avoid exceeding the 10 MB
    // stream read limit that occurred when the full meta graph was bundled
    // with the first data page.
    this.router.register(PROTOCOL_SYNC, async (data, peerId) => {
      const request = this.parseSyncRequest(data);
      const offset = Math.max(0, Math.min(Number.isSafeInteger(Number(request.offset)) ? Number(request.offset) : 0, 1_000_000));
      const limit = Math.max(1, Math.min(Number.isSafeInteger(Number(request.limit)) ? Number(request.limit) : SYNC_PAGE_SIZE, SYNC_PAGE_SIZE));
      const phase = request.phase ?? 'data';
      const isWorkspace = request.includeSharedMemory;
      const contextGraphId = request.contextGraphId;
      if (!contextGraphId || typeof contextGraphId !== 'string') {
        return new TextEncoder().encode('');
      }
      const nquads: string[] = [];

      if (!(await this.authorizeSyncRequest(request, peerId.toString()))) {
        this.log.warn(createOperationContext('sync'), `Denied sync request for "${contextGraphId}" from peer ${peerId} (phase=${phase})`);
        // Emit the explicit denial sentinel (vs. empty body which would
        // be indistinguishable from "peer has no data for this CG").
        return new TextEncoder().encode(`${SYNC_ACCESS_DENIED_MARKER}\n`);
      }

      if (isWorkspace) {
        const wsGraph = paranetWorkspaceGraphUri(contextGraphId);
        const wsMetaGraph = paranetWorkspaceMetaGraphUri(contextGraphId);
        const wsTtl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
        const cutoff = wsTtl > 0 ? new Date(Date.now() - wsTtl).toISOString() : null;

        if (phase === 'meta') {
          const metaQuery = cutoff != null
            ? `SELECT ?s ?p ?o WHERE {
                GRAPH <${wsMetaGraph}> { ?s ?p ?o }
                FILTER EXISTS {
                  GRAPH <${wsMetaGraph}> {
                    ?s <http://dkg.io/ontology/publishedAt> ?ts .
                    FILTER(?ts >= "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
                  }
                }
              } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`
            : `SELECT ?s ?p ?o WHERE { GRAPH <${wsMetaGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`;

          const metaResult = await this.store.query(metaQuery);
          if (metaResult.type === 'bindings') {
            for (const b of metaResult.bindings) {
              const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
              nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${wsMetaGraph}> .`);
            }
          }
        } else {
          // Apply TTL/root-entity filter inside SPARQL before pagination so that
          // we return the first N non-expired triples. Only include exact root subject
          // or skolemized children (/.well-known/genid/...) to avoid pulling unrelated
          // entities that share a URI prefix (e.g. urn:x vs urn:x/other).
          const wsQuery =
            cutoff != null
              ? `SELECT DISTINCT ?s ?p ?o WHERE {
  GRAPH <${wsMetaGraph}> {
    ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
    ?op <http://dkg.io/ontology/publishedAt> ?ts .
    ?op <http://dkg.io/ontology/rootEntity> ?re .
    FILTER(?ts >= "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
  }
  GRAPH <${wsGraph}> { ?s ?p ?o }
  FILTER(?s = ?re || STRSTARTS(STR(?s), CONCAT(STR(?re), "/.well-known/genid/")))
} ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`
              : `SELECT ?s ?p ?o WHERE { GRAPH <${wsGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`;

          const wsResult = await this.store.query(wsQuery);
          if (wsResult.type !== 'bindings' || wsResult.bindings.length === 0) {
            return new TextEncoder().encode('');
          }
          for (const b of wsResult.bindings) {
            const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
            nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${wsGraph}> .`);
          }
        }

        if (nquads.length === 0) return new TextEncoder().encode('');
      } else {
        const dataGraph = paranetDataGraphUri(contextGraphId);
        const metaGraph = paranetMetaGraphUri(contextGraphId);

        if (phase === 'meta') {
          // Whitelist approach: only sync _meta triples that are either
          // CG-level metadata (always safe) or assertion metadata for
          // assertions that have been promoted out of WM.
          //
          // CG-level subjects (always included):
          //  - did:dkg:context-graph:{id}  (CG definition)
          //  - did:dkg:activity:*           (CG creation provenance)
          //  - did:dkg:join-request:*       (access control)
          //
          // Assertion-level subjects (only if memoryLayer != WM):
          //  - urn:dkg:assertion:*          (lifecycle entities)
          //  - urn:dkg:assertion:*/event/*  (event entities)
          //  - */assertion/*                (import metadata)
          //
          // Everything else is excluded by default.
          const DKG_NS = 'http://dkg.io/ontology/';
          const cgEntity = `did:dkg:context-graph:${contextGraphId}`;
          const metaResult = await this.store.query(
            `SELECT ?s ?p ?o WHERE {
              GRAPH <${metaGraph}> { ?s ?p ?o }
              FILTER(
                STR(?s) = "${cgEntity}" ||
                STRSTARTS(STR(?s), "did:dkg:activity:") ||
                STRSTARTS(STR(?s), "did:dkg:join-request:") ||
                EXISTS {
                  GRAPH <${metaGraph}> {
                    ?lc <${DKG_NS}memoryLayer> ?layer .
                    FILTER(?layer != "${MemoryLayer.WorkingMemory}")
                    {
                      FILTER(?lc = ?s)
                    } UNION {
                      ?lc <${DKG_NS}assertionGraph> ?s .
                    } UNION {
                      ?lc <${DKG_NS}assertionName> ?aname .
                      FILTER(
                        CONTAINS(STR(?s), "/assertion/") &&
                        STRENDS(STR(?s), CONCAT("/", STR(?aname)))
                      )
                    }
                  }
                } ||
                EXISTS {
                  GRAPH <${metaGraph}> {
                    { ?evt_src <http://www.w3.org/ns/prov#generated> ?parent }
                    UNION
                    { ?evt_src <http://www.w3.org/ns/prov#used> ?parent }
                    FILTER(?evt_src = ?s)
                    ?parent <${DKG_NS}memoryLayer> ?elayer .
                    FILTER(?elayer != "${MemoryLayer.WorkingMemory}")
                  }
                }
              )
            } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`,
          );
          if (metaResult.type === 'bindings') {
            for (const b of metaResult.bindings) {
              const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
              nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${metaGraph}> .`);
            }
          }
        } else {
          // Sync all graphs under the CG prefix EXCEPT:
          //  - _meta graphs (bookkeeping, synced in the meta phase)
          //  - _private graphs (never shared)
          //  - assertion graphs still in Working Memory (WM)
          //
          // Assertions promoted to SWM or VM ARE included. The lifecycle
          // entity links to the graph via dkg:assertionGraph and tracks
          // the current layer via dkg:memoryLayer. Assertion graphs with
          // no lifecycle record are treated as WM (safe default).
          const cgUriPrefix = `did:dkg:context-graph:${contextGraphId}`;
          const metaGraph = `${cgUriPrefix}/_meta`;
          const DKG_NS = 'http://dkg.io/ontology/';
          const dataResult = await this.store.query(
            `SELECT ?s ?p ?o ?g WHERE {
              GRAPH ?g { ?s ?p ?o }
              FILTER(
                (STR(?g) = "${cgUriPrefix}" || STRSTARTS(STR(?g), "${cgUriPrefix}/")) &&
                !STRENDS(STR(?g), "/_meta") &&
                !CONTAINS(STR(?g), "/_private")
              )
              FILTER(
                !CONTAINS(STR(?g), "/assertion/") ||
                EXISTS {
                  GRAPH <${metaGraph}> {
                    ?lifecycle <${DKG_NS}assertionGraph> ?g .
                    ?lifecycle <${DKG_NS}memoryLayer> ?layer .
                    FILTER(?layer != "${MemoryLayer.WorkingMemory}")
                  }
                }
              )
            } ORDER BY ?g ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`,
          );
          if (dataResult.type !== 'bindings' || dataResult.bindings.length === 0) {
            return new TextEncoder().encode('');
          }
          for (const b of dataResult.bindings) {
            const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
            const graph = b['g'] ?? dataGraph;
            nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${graph}> .`);
          }
        }
      }

      return new TextEncoder().encode(nquads.join('\n'));
    });

    // Join-request protocol: receives signed join requests forwarded by peers.
    // Stores them locally if this node is the curator; ACKs with "ok" or "error".
    this.router.register(PROTOCOL_JOIN_REQUEST, async (data, peerId) => {
      try {
        const payload = JSON.parse(new TextDecoder().decode(data));

        // Handle "join-approved" notifications from curator → requester.
        // Only process if this node owns the target agentAddress.
        if (payload.type === 'join-approved') {
          const { contextGraphId, agentAddress: approvedAddr } = payload;
          if (contextGraphId) {
            const isLocalAgent = approvedAddr && [...this.localAgents.keys()].some(
              (addr) => addr.toLowerCase() === approvedAddr.toLowerCase(),
            );
            if (approvedAddr && !isLocalAgent) {
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            this.preferredSyncPeers.set(contextGraphId, peerId.toString());
            this.log.info(createOperationContext('system'), `Join request approved for "${contextGraphId}" — auto-subscribing`);
            this.subscribeToContextGraph(contextGraphId);
            this.syncContextGraphFromConnectedPeers(contextGraphId, { includeSharedMemory: true }).catch(() => {});
            this.eventBus.emit(DKGEvent.JOIN_APPROVED, {
              contextGraphId,
              agentAddress: approvedAddr,
            });
          }
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        // Handle "join-rejected" notifications from curator → requester.
        // Symmetric to join-approved: filter by localAgents and emit an
        // event so the UI can surface a notification instead of leaving
        // the invitee's Join modal stuck on "Join request sent…" forever.
        //
        // IMPORTANT: this payload is NOT signed by the curator (same as
        // join-approved today), so we deliberately do NOT mutate any
        // local subscription/ACL state here — a malicious or stale peer
        // could otherwise forge a rejection to hide a project the user
        // has legitimately been approved for. We only surface a UI
        // notification; cleanup of any phantom auto-discovery entry is
        // left to the normal catch-up denial path (daemon), which is
        // gated on the curator's actual ACL response. Proper signing is
        // tracked as a follow-up for the whole approve/reject pair.
        if (payload.type === 'join-rejected') {
          const { contextGraphId, agentAddress: rejectedAddr } = payload;
          if (contextGraphId) {
            const isLocalAgent = rejectedAddr && [...this.localAgents.keys()].some(
              (addr) => addr.toLowerCase() === rejectedAddr.toLowerCase(),
            );
            if (rejectedAddr && !isLocalAgent) {
              return new TextEncoder().encode(JSON.stringify({ ok: true, skipped: true }));
            }
            this.log.info(createOperationContext('system'), `Join request rejected for "${contextGraphId}"`);
            this.eventBus.emit(DKGEvent.JOIN_REJECTED, {
              contextGraphId,
              agentAddress: rejectedAddr,
            });
          }
          return new TextEncoder().encode(JSON.stringify({ ok: true }));
        }

        const { contextGraphId, agentAddress, signature, timestamp, agentName } = payload;
        if (!contextGraphId || !agentAddress || !signature || !timestamp) {
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'missing fields' }));
        }
        // Only store if this node is the curator (creator) of the CG
        const owner = await this.getContextGraphOwner(contextGraphId);
        if (!owner) {
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'unknown CG' }));
        }
        const selfDid = `did:dkg:agent:${this.peerId}`;
        const selfAgentDid = this.defaultAgentAddress ? `did:dkg:agent:${this.defaultAgentAddress}` : null;
        const isCurator = owner === selfDid ||
          (selfAgentDid && owner === selfAgentDid) ||
          [...this.localAgents.keys()].some((addr) => owner === `did:dkg:agent:${addr}`);
        if (!isCurator) {
          return new TextEncoder().encode(JSON.stringify({ ok: false, error: 'not curator' }));
        }
        this.verifyJoinRequest(contextGraphId, agentAddress, timestamp, signature);
        await this.storePendingJoinRequest(contextGraphId, agentAddress, signature, timestamp, agentName);
        // Remember which peer actually delivered this request so we can
        // send approval/rejection back to the same peer later, even if
        // the agent registry hasn't indexed them yet.
        this.joinRequestOriginPeers.set(
          `${contextGraphId}::${agentAddress.toLowerCase()}`,
          peerId.toString(),
        );
        this.eventBus.emit(DKGEvent.JOIN_REQUEST_RECEIVED, {
          contextGraphId,
          agentAddress,
          agentName,
        });
        return new TextEncoder().encode(JSON.stringify({ ok: true }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new TextEncoder().encode(JSON.stringify({ ok: false, error: msg }));
      }
    });

    // Subscribe to both system context graph GossipSub topics
    for (const systemContextGraph of [SYSTEM_PARANETS.AGENTS, SYSTEM_PARANETS.ONTOLOGY]) {
      this.subscribeToContextGraph(systemContextGraph);
    }

    // Connect to bootstrap peers
    if (this.config.bootstrapPeers) {
      for (const addr of this.config.bootstrapPeers) {
        try {
          await this.node.libp2p.dial(multiaddr(addr));
        } catch {
          // Bootstrap peer may be unreachable
        }
      }
    }

    // On new peer connection, request sync of system context graphs so we discover
    // agents that published their profiles before we came online.
    // Wait for protocol identification to complete, then only sync with
    // peers that actually support the sync protocol (skips raw relay nodes).
    const handleSyncError = (remotePeer: string, err: unknown): void => {
      const shortPeer = remotePeer.slice(-8);
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(ctx, `Sync-on-connect failed for ${shortPeer}: ${message}`);
    };

    this.node.libp2p.addEventListener('peer:connect', (evt) => {
      const remotePeer = evt.detail.toString();
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
    });

    // Also fire on connection:open so that a *reconnecting* peer (same
    // peer-id, new connection after a prior drop) triggers a fresh sync
    // attempt. peer:connect fires only on the first connection to a new
    // peer, so without this handler a peer that temporarily disconnected
    // after its first sync failed would never get a retry. The cooldown
    // dedupes overlapping direct+relayed connections for the same peer.
    this.node.libp2p.addEventListener('connection:open', (evt) => {
      const remotePeer = evt.detail.remotePeer.toString();
      if (remotePeer === this.node.libp2p.peerId.toString()) return;
      const now = Date.now();
      const last = this.catchupOnConnectAt.get(remotePeer) ?? 0;
      if (now - last < CATCHUP_ON_CONNECT_COOLDOWN_MS) return;
      this.catchupOnConnectAt.set(remotePeer, now);
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
    });

    // Reconnect-on-gossip: when a gossip message arrives from a peer we're
    // not currently connected to, best-effort dial them. This catches the
    // case where two NAT'd edge nodes briefly lose their direct path but
    // gossipsub still routes their messages to each other via the mesh —
    // the arriving message is both proof-of-life *and* a cheap trigger to
    // rebuild the direct link so subsequent sync requests have a path.
    this.eventBus.on(DKGEvent.GOSSIP_MESSAGE, (data) => {
      const from = (data as { from?: string })?.from;
      if (!from || from === 'unknown') return;
      this.maybeDialGossipSender(from).catch(() => {
        // Swallow: reconnect-on-gossip is best-effort; failures are already
        // logged inside the method and we don't want to disrupt gossip
        // delivery if a single peer happens to be unreachable.
      });
    });

    // Sync from peers already connected (e.g. relay dialed during node.start())
    const alreadyConnected = this.node.libp2p.getPeers();
    for (const pid of alreadyConnected) {
      const remotePeer = pid.toString();
      setTimeout(() => {
        this.trySyncFromPeer(remotePeer).catch((err: unknown) => {
          handleSyncError(remotePeer, err);
        });
      }, 3000);
    }

    // Start periodic shared memory cleanup
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    if (ttl > 0) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
    }
  }

  /**
   * Pull all triples for the given context graphs from a remote peer and merge
   * them into our local store. Used on peer:connect for initial catch-up,
   * with a per-peer guard to avoid overlapping sync storms.
   */
  private async trySyncFromPeer(remotePeer: string): Promise<void> {
    const ctx = createOperationContext('sync');
    const shortPeer = remotePeer.slice(-8);

    if (this.syncingPeers.has(remotePeer)) return;
    this.syncingPeers.add(remotePeer);

    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const pid = peerIdFromString(remotePeer);
      const peer = await this.node.libp2p.peerStore.get(pid);
      const protocols = peer.protocols ?? [];

      // Track which peers are core nodes by checking StorageACK protocol
      // support. Only core nodes register this protocol, so its presence
      // is a reliable role indicator. Used by getConnectedCorePeers().
      if (protocols.includes(PROTOCOL_STORAGE_ACK)) {
        this.knownCorePeerIds.add(remotePeer);
      } else {
        this.knownCorePeerIds.delete(remotePeer);
      }

      const hasSync = protocols.includes(PROTOCOL_SYNC);
      if (!hasSync) {
        this.log.info(ctx, `Peer ${shortPeer} does not support sync protocol (protocols: ${protocols.join(', ')})`);
        return;
      }

      this.log.info(ctx, `Syncing from peer ${shortPeer}...`);
      const knownCgsBefore = new Set(this.config.syncContextGraphs ?? []);
      const synced = await this.syncFromPeer(remotePeer);
      this.log.info(ctx, `Synced ${synced} data triples from peer ${shortPeer}`);

      const syncScope = new Set<string>([
        SYSTEM_PARANETS.AGENTS,
        SYSTEM_PARANETS.ONTOLOGY,
        ...(this.config.syncContextGraphs ?? []),
      ]);
      await this.refreshMetaSyncedFlags(syncScope);

      // After syncing ONTOLOGY, discover and auto-subscribe to any new context graphs
      await this.discoverContextGraphsFromStore();

      // Sync durable data for any CGs discovered after the initial sync pass.
      // Without this, newly discovered private CGs would only sync on the next
      // peer connection since they weren't in syncContextGraphs during the
      // first syncFromPeer call.
      const allCgsAfter = this.config.syncContextGraphs ?? [];
      const newlyDiscovered = allCgsAfter.filter((id) => !knownCgsBefore.has(id));
      if (newlyDiscovered.length > 0) {
        this.log.info(ctx, `Discovered ${newlyDiscovered.length} new CG(s) — syncing durable data from ${shortPeer}`);
        const discoverSynced = await this.syncFromPeer(remotePeer, newlyDiscovered);
        this.log.info(ctx, `Synced ${discoverSynced} durable triples for newly discovered CG(s) from ${shortPeer}`);
        await this.refreshMetaSyncedFlags(newlyDiscovered);
      }

      const wsContextGraphIds = this.config.syncContextGraphs ?? [];
      if (wsContextGraphIds.length > 0) {
        const wsSynced = await this.syncSharedMemoryFromPeer(remotePeer, wsContextGraphIds);
        this.log.info(ctx, `Synced ${wsSynced} shared memory triples from peer ${shortPeer}`);
      }
    } finally {
      this.syncingPeers.delete(remotePeer);
    }
  }

  /**
   * Reconnect-on-gossip: ensure we have a live libp2p path to the sender of
   * a gossip message we just received. GossipSub delivers messages signed by
   * their original publisher, so `from` is the author regardless of how many
   * mesh hops the message took to reach us — making it a reliable signal
   * that the author is online *right now*.
   *
   * Why: two edge nodes behind NAT can briefly lose their direct circuit
   * without either side noticing until the next publish fails. By reacting
   * to incoming gossip with an opportunistic dial, we restore the path long
   * before the application-layer sync protocol is invoked.
   *
   * Best-effort only: we try peerStore-known multiaddrs first, then fall
   * back to constructing `/p2p-circuit` multiaddrs through each configured
   * relay. Failures are logged but never surface to the caller.
   */
  private async maybeDialGossipSender(peerIdStr: string): Promise<void> {
    const selfPeerId = this.node.libp2p.peerId.toString();
    if (peerIdStr === selfPeerId) return;

    // Already connected → nothing to do.
    const connected = this.node.libp2p.getPeers().some(p => p.toString() === peerIdStr);
    if (connected) return;

    // Cooldown: a single chatty CG can produce many gossip messages/second.
    // One dial-attempt per peer per GOSSIP_DIAL_COOLDOWN_MS is enough.
    const now = Date.now();
    const last = this.gossipDialAttemptedAt.get(peerIdStr) ?? 0;
    if (now - last < GOSSIP_DIAL_COOLDOWN_MS) return;
    this.gossipDialAttemptedAt.set(peerIdStr, now);

    const ctx = createOperationContext('connect');
    const shortPeer = peerIdStr.slice(-8);

    const { peerIdFromString } = await import('@libp2p/peer-id');
    let peerId: ReturnType<typeof peerIdFromString>;
    try {
      peerId = peerIdFromString(peerIdStr);
    } catch (err) {
      this.log.warn(ctx, `Skipping gossip redial for invalid peer id ${shortPeer}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // First pass: let libp2p try whatever addresses it already knows about
    // for this peer (direct multiaddrs from identify, previous relay
    // addresses from peerStore, etc.).
    try {
      await this.node.libp2p.dial(peerId, { signal: AbortSignal.timeout(GOSSIP_DIAL_TIMEOUT_MS) });
      this.log.info(ctx, `Reconnect-on-gossip: dialed ${shortPeer} via peerStore`);
      return;
    } catch (err) {
      this.log.info(ctx, `Reconnect-on-gossip: peerStore dial to ${shortPeer} failed (${err instanceof Error ? err.message : String(err)}); trying relay fallbacks`);
    }

    // Relay fallback: for each configured relay, construct an explicit
    // circuit-relay multiaddr and dial. The first relay with a valid
    // reservation for the sender wins.
    const relays = this.config.relayPeers ?? [];
    for (const relayAddr of relays) {
      const circuitAddr = `${relayAddr}/p2p-circuit/p2p/${peerIdStr}`;
      try {
        await this.node.libp2p.dial(
          multiaddr(circuitAddr),
          { signal: AbortSignal.timeout(GOSSIP_DIAL_TIMEOUT_MS) },
        );
        this.log.info(ctx, `Reconnect-on-gossip: dialed ${shortPeer} via ${relayAddr.slice(-16)}`);
        return;
      } catch {
        // Try next relay. We don't log per-relay failures at INFO to avoid
        // log spam when a peer simply has no reservation anywhere right now.
      }
    }

    this.log.info(ctx, `Reconnect-on-gossip: no path to ${shortPeer} via peerStore or ${relays.length} relay(s); will retry after cooldown`);
  }

  /**
   * Pull triples for the given context graphs from a remote peer in pages,
   * verify merkle roots against the KC metadata, and only insert
   * triples that pass verification.
   *
   * Meta and data are fetched in separate pagination loops so that neither
   * response can exceed the 10 MB stream read limit.
   */
  async syncFromPeer(
    remotePeerId: string,
    contextGraphIds: string[] = [SYSTEM_PARANETS.AGENTS, SYSTEM_PARANETS.ONTOLOGY, ...(this.config.syncContextGraphs ?? [])],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
  ): Promise<number> {
    const result = await this.syncFromPeerDetailed(remotePeerId, contextGraphIds, onPhase, onAccessDenied);
    return result.insertedTriples;
  }

  private async syncFromPeerDetailed(
    remotePeerId: string,
    contextGraphIds: string[],
    onPhase?: PhaseCallback,
    onAccessDenied?: (contextGraphId: string) => void,
  ): Promise<DurableSyncResult> {
    const ctx = createOperationContext('sync');
    const summary: DurableSyncResult = {
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 0,
    };

    try {
      // Loop per CG so one CG's ACL denial (or transport error) doesn't
      // abort syncing of the others in the same peer session.
      for (const [index, pid] of contextGraphIds.entries()) {
        try {
        const dataGraph = paranetDataGraphUri(pid);
        const metaGraph = paranetMetaGraphUri(pid);
        const deadline = this.createContextGraphSyncDeadline(contextGraphIds.length - index);

        this.log.info(ctx, `Syncing context graph "${pid}" from ${remotePeerId}`);

        onPhase?.('fetch', 'start');

        const metaQuads = await this.fetchSyncPages(ctx, remotePeerId, pid, false, 'meta', metaGraph, deadline);
        this.log.info(ctx, `  meta: ${metaQuads.length} triples fetched`);
        summary.fetchedMetaTriples += metaQuads.length;

        const dataQuads = await this.fetchSyncPages(ctx, remotePeerId, pid, false, 'data', dataGraph, deadline);
        this.log.info(ctx, `  data: ${dataQuads.length} triples fetched`);
        summary.fetchedDataTriples += dataQuads.length;

        onPhase?.('fetch', 'end');

        if (dataQuads.length === 0 && metaQuads.length === 0) {
          summary.emptyResponses += 1;
          continue;
        }

        const isSystemContextGraph = (Object.values(SYSTEM_PARANETS) as string[]).includes(pid);
        if (!isSystemContextGraph && dataQuads.length > 0 && metaQuads.length === 0) {
          this.log.warn(ctx, `Rejecting sync for "${pid}": received ${dataQuads.length} data triples but no meta — cannot verify merkle roots`);
          summary.dataRejectedMissingMeta += 1;
          continue;
        }
        if (!isSystemContextGraph && metaQuads.length > 0 && dataQuads.length === 0) {
          this.log.warn(ctx, `Sync for "${pid}": received ${metaQuads.length} meta triples but no data — peer may have empty or pruned data graph`);
          summary.metaOnlyResponses += 1;
        }

        onPhase?.('verify', 'start');
        const verified = verifySyncedData(dataQuads, metaQuads, ctx, this.log, isSystemContextGraph);
        onPhase?.('verify', 'end');

        onPhase?.('store', 'start');
        if (verified.data.length > 0) {
          await this.store.insert(verified.data);
          summary.insertedTriples += verified.data.length;
          summary.insertedDataTriples += verified.data.length;
        }
        if (verified.meta.length > 0) {
          await this.store.insert(verified.meta);
          summary.insertedTriples += verified.meta.length;
          summary.insertedMetaTriples += verified.meta.length;
        }
        onPhase?.('store', 'end');

        if (verified.rejected > 0) {
          this.log.warn(ctx, `Rejected ${verified.rejected} KCs with invalid merkle roots from ${remotePeerId}`);
          summary.rejectedKcs += verified.rejected;
        }
      } catch (err) {
        if (err instanceof SyncAccessDeniedError) {
          this.log.info(ctx, `Sync for "${pid}" from ${remotePeerId} denied by ACL`);
          onAccessDenied?.(pid);
          continue;
        }
        // Non-ACL failure (transport error, timeout, malformed response,
        // store write error, …). Track it so the caller can tell the
        // difference between "every peer errored out" and "peers
        // responded cleanly but had 0 new triples for us" — otherwise
        // the daemon's catchup-status endpoint flips to "synced" even
        // when nothing actually synced. See daemon.ts subscribe job.
        summary.failedPeers += 1;
        this.log.warn(ctx, `Sync from ${remotePeerId} for "${pid}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      }
      if (summary.insertedTriples > 0) {
        this.log.info(ctx, `Sync complete: ${summary.insertedTriples} verified triples from ${remotePeerId}`);
      }
    } catch (err) {
      this.log.warn(ctx, `Sync from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
      summary.failedPeers += 1;
    }
    return summary;
  }

  /**
   * Paginate through sync pages for a single graph (data or meta).
   * Uses buildSyncRequest to produce authenticated requests for private CGs.
   */
  private async fetchSyncPages(
    ctx: OperationContext,
    remotePeerId: string,
    contextGraphId: string,
    includeSharedMemory: boolean,
    phase: 'data' | 'meta',
    graphUri: string,
    deadline: number,
  ): Promise<Quad[]> {
    const allQuads: Quad[] = [];
    let offset = 0;
    let timedOut = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }

      const remainingMs = Math.max(0, deadline - Date.now());
      const timeoutMs = Math.min(
        SYNC_PAGE_TIMEOUT_MS,
        Math.max(2000, Math.floor(remainingMs / SYNC_ROUTER_ATTEMPTS)),
      );

      // Build a fresh request (with unique requestId + signature) per attempt
      // so that authenticated private-sync retries aren't rejected as replays.
      const curOffset = offset;
      const responseBytes = await withRetry(
        async () => {
          const requestBytes = await this.buildSyncRequest(contextGraphId, curOffset, SYNC_PAGE_SIZE, includeSharedMemory, remotePeerId, phase);
          return this.router.send(remotePeerId, PROTOCOL_SYNC, requestBytes, timeoutMs);
        },
        {
          maxAttempts: SYNC_PAGE_RETRY_ATTEMPTS,
          baseDelayMs: 1000,
          onRetry: (attempt, delay, err) => {
            this.log.warn(ctx, `Sync page retry ${attempt}/${SYNC_PAGE_RETRY_ATTEMPTS} for offset ${offset} (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`);
          },
        },
      );

      const nquadsText = new TextDecoder().decode(responseBytes).trim();
      if (nquadsText === SYNC_DENIED_RESPONSE) {
        throw new Error(`Sync denied by ${remotePeerId} for "${contextGraphId}" (${phase})`);
      }
      if (!nquadsText) break;

      // Explicit ACL denial from the responder. Throwing here lets
      // syncFromPeer distinguish denial from an empty page / transport
      // error instead of having higher-level code guess from a 0-triple
      // result.
      if (nquadsText === SYNC_ACCESS_DENIED_MARKER) {
        throw new SyncAccessDeniedError(contextGraphId);
      }

      const quads = parseNQuads(nquadsText);
      if (quads.length === 0) break;

      // Accept quads from the expected graph OR from any sub-graph of the CG
      // (e.g. assertion sub-graphs like did:dkg:context-graph:{id}/assertion/...).
      const cgUriPrefix = `did:dkg:context-graph:${contextGraphId}/`;
      const validQuads = quads.filter(q =>
        q.graph === graphUri || q.graph.startsWith(cgUriPrefix)
      );
      allQuads.push(...validQuads);

      offset += quads.length;
      if (quads.length < SYNC_PAGE_SIZE) break;
    }
    if (timedOut) {
      const scope = includeSharedMemory ? 'shared-memory' : 'durable';
      this.log.warn(
        ctx,
        `Sync timeout for ${scope} ${phase} phase of "${contextGraphId}" (${allQuads.length} triples received so far for ${graphUri})`,
      );
    }
    return allQuads;
  }

  /**
   * Pull shared memory triples for the given context graphs from a remote peer.
   * SWM data is not merkle-verified (no chain finality) — it is
   * accepted as-is and merged into the local shared memory + SWM meta graphs.
   * The workspaceOwnedEntities set is updated so Rule 4 stays consistent.
   */
  async syncSharedMemoryFromPeer(
    remotePeerId: string,
    contextGraphIds: string[] = [...(this.config.syncContextGraphs ?? [])],
  ): Promise<number> {
    const result = await this.syncSharedMemoryFromPeerDetailed(remotePeerId, contextGraphIds);
    return result.insertedTriples;
  }

  private async syncSharedMemoryFromPeerDetailed(
    remotePeerId: string,
    contextGraphIds: string[],
  ): Promise<SharedMemorySyncResult> {
    const ctx = createOperationContext('sync');
    const summary: SharedMemorySyncResult = {
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 0,
    };

    try {
      for (const [index, pid] of contextGraphIds.entries()) {
        const wsGraph = paranetWorkspaceGraphUri(pid);
        const wsMetaGraph = paranetWorkspaceMetaGraphUri(pid);
        const deadline = this.createContextGraphSyncDeadline(contextGraphIds.length - index);

        this.log.info(ctx, `Syncing shared memory for context graph "${pid}" from ${remotePeerId}`);

        const wsMetaQuads = await this.fetchSyncPages(ctx, remotePeerId, pid, true, 'meta', wsMetaGraph, deadline);
        const wsDataQuads = await this.fetchSyncPages(ctx, remotePeerId, pid, true, 'data', wsGraph, deadline);
        this.log.info(ctx, `  shared memory: ${wsDataQuads.length} data + ${wsMetaQuads.length} meta triples fetched`);
        summary.fetchedMetaTriples += wsMetaQuads.length;
        summary.fetchedDataTriples += wsDataQuads.length;

        if (wsDataQuads.length === 0 && wsMetaQuads.length === 0) {
          summary.emptyResponses += 1;
          continue;
        }

        const wsQuads = wsDataQuads;

        // Only accept roots from meta subjects that are valid shared memory operations (type + publishedAt).
        // Rejects fake rootEntity from malicious peers that would poison workspaceOwnedEntities.
        const DKG_ROOT_ENTITY = 'http://dkg.io/ontology/rootEntity';
        const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
        const DKG_WORKSPACE_OP = 'http://dkg.io/ontology/WorkspaceOperation';
        const DKG_PUBLISHED_AT = 'http://dkg.io/ontology/publishedAt';

        const opsWithType = new Set<string>();
        const opsWithPublishedAt = new Set<string>();
        for (const q of wsMetaQuads) {
          if (q.predicate === RDF_TYPE && q.object === DKG_WORKSPACE_OP) opsWithType.add(q.subject);
          if (q.predicate === DKG_PUBLISHED_AT) opsWithPublishedAt.add(q.subject);
        }
        const validOps = new Set<string>([...opsWithType].filter(s => opsWithPublishedAt.has(s)));

        const allowedRoots = new Set<string>();
        for (const q of wsMetaQuads) {
          if (q.predicate === DKG_ROOT_ENTITY && validOps.has(q.subject)) {
            const entity = q.object.startsWith('"') ? stripLiteral(q.object) : q.object;
            allowedRoots.add(entity);
          }
        }

        // Validate shared memory quads: subject must be an allowed root or skolemized child (root + /.well-known/genid/).
        const SKOLEM_PREFIX = '/.well-known/genid/';
        const isValidSubject = (s: string): boolean => {
          if (allowedRoots.has(s)) return true;
          for (const root of allowedRoots) {
            if (s.startsWith(root + SKOLEM_PREFIX)) return true;
          }
          return false;
        };
        const validWsQuads = wsQuads.filter(q => isValidSubject(q.subject));
        const dropped = wsQuads.length - validWsQuads.length;
        if (dropped > 0) {
          this.log.warn(ctx, `SWM sync dropped ${dropped} triples with invalid subjects (not in meta rootEntity or skolemized child)`);
          summary.droppedDataTriples += dropped;
        }

        const graphManager = new GraphManager(this.store);
        await graphManager.ensureParanet(pid);

        if (validWsQuads.length > 0) {
          await this.store.insert(validWsQuads);
          summary.insertedTriples += validWsQuads.length;
          summary.insertedDataTriples += validWsQuads.length;
        }
        if (wsMetaQuads.length > 0) {
          await this.store.insert(wsMetaQuads);
          summary.insertedTriples += wsMetaQuads.length;
          summary.insertedMetaTriples += wsMetaQuads.length;
        }

        // Update workspaceOwnedEntities only from validated meta (rootEntity + creator peerId).
        const PROV_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';
        const opCreators = new Map<string, string>();
        for (const q of wsMetaQuads) {
          if (q.predicate === PROV_ATTRIBUTED_TO && validOps.has(q.subject)) {
            opCreators.set(q.subject, q.object.startsWith('"') ? stripLiteral(q.object) : q.object);
          }
        }
        const entityCreators = new Map<string, string>();
        for (const q of wsMetaQuads) {
          if (q.predicate === DKG_ROOT_ENTITY && validOps.has(q.subject)) {
            const entity = q.object.startsWith('"') ? stripLiteral(q.object) : q.object;
            const creator = opCreators.get(q.subject);
            if (creator && !entityCreators.has(entity)) {
              entityCreators.set(entity, creator);
            }
          }
        }

        if (!this.workspaceOwnedEntities.has(pid)) {
          this.workspaceOwnedEntities.set(pid, new Map());
        }
        const ownedMap = this.workspaceOwnedEntities.get(pid)!;
        for (const [entity, creator] of entityCreators) {
          if (!ownedMap.has(entity)) {
            ownedMap.set(entity, creator);
          }
        }

        this.log.info(ctx, `SWM sync for "${pid}": ${validWsQuads.length} data + ${wsMetaQuads.length} meta triples`);
      }
      if (summary.insertedTriples > 0) {
        this.log.info(ctx, `SWM sync complete: ${summary.insertedTriples} triples from ${remotePeerId}`);
      }
    } catch (err) {
      this.log.warn(ctx, `SWM sync from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
      summary.failedPeers += 1;
    }
    return summary;
  }

  private createContextGraphSyncDeadline(remainingContextGraphs: number): number {
    const divisor = Math.max(1, remainingContextGraphs);
    const budgetMs = Math.max(SYNC_MIN_GRAPH_BUDGET_MS, Math.floor(SYNC_TOTAL_TIMEOUT_MS / divisor));
    return Date.now() + budgetMs;
  }

  /**
   * Catch up a single context graph from currently connected peers that advertise
   * the sync protocol. Useful after runtime subscribe so historical data is
   * backfilled immediately (not only future gossip messages).
   */
  async syncContextGraphFromConnectedPeers(
    contextGraphId: string,
    options?: { includeSharedMemory?: boolean },
  ): Promise<{
    connectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    dataSynced: number;
    sharedMemorySynced: number;
    accessDeniedPeers: number;
    diagnostics: CatchupSyncDiagnostics;
  }> {
    const ctx = createOperationContext('sync');
    const includeSharedMemory = options?.includeSharedMemory ?? false;
    const isPrivateContextGraph = await this.isPrivateContextGraph(contextGraphId);

    this.trackSyncContextGraph(contextGraphId);

    const preferredPeerId = await this.resolvePreferredSyncPeerId(contextGraphId);
    if (preferredPeerId) {
      await this.ensurePeerConnected(preferredPeerId);
    }

    // Attempt to connect to all known peers from the agent registry so that
    // curated CGs hosted by non-relay nodes are reachable (e.g. Node 3 needs
    // to connect to Node 2 even if only Node 1/relay is in libp2p connections).
    try {
      const agents = await this.discovery.findAgents();
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const { multiaddr } = await import('@multiformats/multiaddr');
      for (const a of agents) {
        if (a.peerId === this.peerId) continue;
        const existingConns = this.node.libp2p.getConnections()
          .filter((c) => c.remotePeer.toString() === a.peerId);
        if (existingConns.length > 0) continue;
        if (a.relayAddress) {
          try {
            const circuitAddr = multiaddr(`${a.relayAddress}/p2p-circuit/p2p/${a.peerId}`);
            const pid = peerIdFromString(a.peerId);
            await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
            await this.node.libp2p.dial(pid);
          } catch {
            // Non-fatal — peer may be unreachable
          }
        }
      }
    } catch {
      // Discovery unavailable or dial failures are non-fatal
    }

    const peers = this.selectCatchupPeers(
      [...new Map(
        this.node.libp2p.getConnections().map((conn) => [conn.remotePeer.toString(), conn.remotePeer]),
      ).values()],
      preferredPeerId,
      isPrivateContextGraph,
    );
    let syncCapablePeers = 0;
    let peersTried = 0;
    let dataSynced = 0;
    let sharedMemorySynced = 0;
    let noProtocolPeers = 0;
    const diagnostics: CatchupSyncDiagnostics = {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        emptyResponses: 0,
        droppedDataTriples: 0,
        failedPeers: 0,
      },
    };

    // Resolve sync-capable peers first (sequential metadata lookup is cheap)
    const syncCapable: string[] = [];
    for (const pid of peers) {
      const hasSync = await this.waitForSyncProtocol(pid);
      if (!hasSync) {
        noProtocolPeers++;
        continue;
      }
      syncCapable.push(pid.toString());
    }
    syncCapablePeers = syncCapable.length;
    peersTried = syncCapable.length;

    // Run per-peer syncs in parallel. Without parallelism a curated CG
    // denial walks the whole peer set sequentially with 30s+ timeouts
    // each, causing the /api/subscribe catchup job to take minutes to
    // report denial and the UI to give up. Uses the *Detailed variants
    // so we can still feed HEAD's CatchupSyncDiagnostics counters.
    const emptyDurable = (): DurableSyncResult => ({
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 1,
    });
    const emptyShared = (): SharedMemorySyncResult => ({
      insertedTriples: 0,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      emptyResponses: 0,
      droppedDataTriples: 0,
      failedPeers: 1,
    });
    const results = await Promise.all(syncCapable.map(async (remotePeerId) => {
      let denied = false;
      const durable = await this.syncFromPeerDetailed(
        remotePeerId,
        [contextGraphId],
        undefined,
        () => { denied = true; },
      ).catch(emptyDurable);
      const shared = includeSharedMemory
        ? await this.syncSharedMemoryFromPeerDetailed(remotePeerId, [contextGraphId]).catch(emptyShared)
        : null;
      return { durable, shared, denied };
    }));
    let accessDeniedPeers = 0;
    for (const r of results) {
      dataSynced += r.durable.insertedTriples;
      diagnostics.durable.fetchedMetaTriples += r.durable.fetchedMetaTriples;
      diagnostics.durable.fetchedDataTriples += r.durable.fetchedDataTriples;
      diagnostics.durable.insertedMetaTriples += r.durable.insertedMetaTriples;
      diagnostics.durable.insertedDataTriples += r.durable.insertedDataTriples;
      diagnostics.durable.emptyResponses += r.durable.emptyResponses;
      diagnostics.durable.metaOnlyResponses += r.durable.metaOnlyResponses;
      diagnostics.durable.dataRejectedMissingMeta += r.durable.dataRejectedMissingMeta;
      diagnostics.durable.rejectedKcs += r.durable.rejectedKcs;
      diagnostics.durable.failedPeers += r.durable.failedPeers;
      if (r.shared) {
        sharedMemorySynced += r.shared.insertedTriples;
        diagnostics.sharedMemory.fetchedMetaTriples += r.shared.fetchedMetaTriples;
        diagnostics.sharedMemory.fetchedDataTriples += r.shared.fetchedDataTriples;
        diagnostics.sharedMemory.insertedMetaTriples += r.shared.insertedMetaTriples;
        diagnostics.sharedMemory.insertedDataTriples += r.shared.insertedDataTriples;
        diagnostics.sharedMemory.emptyResponses += r.shared.emptyResponses;
        diagnostics.sharedMemory.droppedDataTriples += r.shared.droppedDataTriples;
        diagnostics.sharedMemory.failedPeers += r.shared.failedPeers;
      }
      if (r.denied) accessDeniedPeers++;
    }
    diagnostics.noProtocolPeers = noProtocolPeers;

    this.log.info(
      ctx,
      `Catch-up sync for "${contextGraphId}": peers=${peersTried}/${syncCapablePeers} data=${dataSynced} sharedMemory=${sharedMemorySynced} denied=${accessDeniedPeers}`,
    );

    await this.refreshMetaSyncedFlags([contextGraphId]);

    if (dataSynced > 0 || sharedMemorySynced > 0) {
      this.eventBus.emit(DKGEvent.PROJECT_SYNCED, {
        contextGraphId,
        dataSynced,
        sharedMemorySynced,
      });
    }

    return {
      connectedPeers: peers.length,
      syncCapablePeers,
      peersTried,
      dataSynced,
      sharedMemorySynced,
      accessDeniedPeers,
      diagnostics,
    };
  }

  private selectCatchupPeers(
    peers: Array<{ toString(): string }>,
    preferredPeerId?: string,
    privateOnly = false,
  ): Array<{ toString(): string }> {
    if (!preferredPeerId) return peers;

    if (privateOnly) {
      const preferredPeer = peers.find((peer) => peer.toString() === preferredPeerId);
      if (preferredPeer) return [preferredPeer];
    }

    return [...peers].sort((a, b) => {
      if (a.toString() === preferredPeerId) return -1;
      if (b.toString() === preferredPeerId) return 1;
      return 0;
    });
  }

  private async resolvePreferredSyncPeerId(contextGraphId: string): Promise<string | undefined> {
    const preferredPeerId = this.preferredSyncPeers.get(contextGraphId);
    if (preferredPeerId) return preferredPeerId;

    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (curatorPeerId) {
      this.preferredSyncPeers.set(contextGraphId, curatorPeerId);
    }
    return curatorPeerId;
  }

  private async ensurePeerConnected(peerId: string): Promise<void> {
    const existingConnections = this.node.libp2p.getConnections()
      .filter((conn) => conn.remotePeer.toString() === peerId);
    if (existingConnections.length > 0) {
      return;
    }

    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const pid = peerIdFromString(peerId);

      try {
        await this.node.libp2p.dial(pid);
        return;
      } catch {
        const agent = await this.discovery.findAgentByPeerId(peerId);
        if (!agent?.relayAddress) return;

        const { multiaddr } = await import('@multiformats/multiaddr');
        const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${peerId}`);
        await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
        await this.node.libp2p.dial(pid);
      }
    } catch {
      // Non-fatal — peer may be unreachable.
    }
  }

  private async waitForSyncProtocol(pid: { toString(): string }): Promise<boolean> {
    for (let attempt = 0; attempt < SYNC_PROTOCOL_CHECK_ATTEMPTS; attempt++) {
      try {
        const peer = await this.node.libp2p.peerStore.get(pid as any);
        if (peer.protocols.includes(PROTOCOL_SYNC)) {
          return true;
        }
      } catch {
        // Peer metadata might not be available yet.
      }

      if (attempt < SYNC_PROTOCOL_CHECK_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, SYNC_PROTOCOL_CHECK_DELAY_MS));
      }
    }

    return false;
  }

  private async refreshMetaSyncedFlags(contextGraphIds: Iterable<string>): Promise<void> {
    for (const contextGraphId of contextGraphIds) {
      const sub = this.subscribedContextGraphs.get(contextGraphId);
      if (!sub || sub.metaSynced === true) continue;
      if (await this.hasConfirmedMetaState(contextGraphId)) {
        sub.metaSynced = true;
      }
    }
  }

  private async hasConfirmedMetaState(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_PARANETS) as string[]).includes(contextGraphId)) {
      return true;
    }

    const metaGraph = paranetMetaGraphUri(contextGraphId);
    const metaResult = await this.store.query(
      `ASK WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } }`,
    );
    if (metaResult.type === 'boolean' && metaResult.value === true) {
      return true;
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const contextGraphUri = paranetDataGraphUri(contextGraphId);
    const ontologyResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${ontologyGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
        }
      }`,
    );
    return ontologyResult.type === 'boolean' && ontologyResult.value === true;
  }

  /**
   * Update the shared memory TTL at runtime. Takes effect immediately for queries
   * and the next cleanup cycle without requiring a restart.
   */
  setSharedMemoryTtlMs(ttlMs: number): void {
    const oldTtl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    (this.config as any).sharedMemoryTtlMs = ttlMs;

    if (oldTtl <= 0 && ttlMs > 0 && !this.swmCleanupTimer) {
      this.cleanupExpiredSharedMemory().catch(() => {});
      this.swmCleanupTimer = setInterval(() => {
        this.cleanupExpiredSharedMemory().catch(() => {});
      }, SWM_CLEANUP_INTERVAL_MS);
      if (this.swmCleanupTimer.unref) this.swmCleanupTimer.unref();
    } else if (ttlMs <= 0 && this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
  }

  /**
   * Remove expired shared memory operations and their data.
   * Queries SWM meta for operations with publishedAt older than the TTL,
   * deletes the corresponding triples from shared memory and SWM meta,
   * and removes the root entities from workspaceOwnedEntities.
   */
  async cleanupExpiredSharedMemory(): Promise<number> {
    const ttl = this.config.sharedMemoryTtlMs ?? DEFAULT_SWM_TTL_MS;
    if (ttl <= 0) return 0;

    const ctx = createOperationContext('share');
    const cutoff = new Date(Date.now() - ttl).toISOString();
    let totalDeleted = 0;

    try {
      const graphManager = new GraphManager(this.store);
      const contextGraphs = await graphManager.listParanets();

      for (const pid of contextGraphs) {
        const wsGraph = paranetWorkspaceGraphUri(pid);
        const wsMetaGraph = paranetWorkspaceMetaGraphUri(pid);
        let graphDeleted = 0;

        const expiredOps = await this.store.query(
          `SELECT ?op WHERE {
            GRAPH <${wsMetaGraph}> {
              ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
              ?op <http://dkg.io/ontology/publishedAt> ?ts .
              FILTER(?ts < "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
            }
          }`,
        );

        if (expiredOps.type !== 'bindings' || expiredOps.bindings.length === 0) continue;

        for (const row of expiredOps.bindings) {
          const opUri = row['op'];
          if (!opUri) continue;

          const rootEntitiesResult = await this.store.query(
            `SELECT ?re WHERE {
              GRAPH <${wsMetaGraph}> {
                <${opUri}> <http://dkg.io/ontology/rootEntity> ?re .
              }
            }`,
          );

          const rootEntities: string[] = [];
          if (rootEntitiesResult.type === 'bindings') {
            for (const r of rootEntitiesResult.bindings) {
              if (r['re']) rootEntities.push(r['re']);
            }
          }

          for (const re of rootEntities) {
            // Exact root only; then skolemized descendants only (prefix would over-delete e.g. urn:foo vs urn:foobar)
            const exactDeleted = await this.store.deleteByPattern({ graph: wsGraph, subject: re });
            graphDeleted += exactDeleted;
            const childPrefix = `${re}/.well-known/genid/`;
            const childDeleted = await this.store.deleteBySubjectPrefix(wsGraph, childPrefix);
            graphDeleted += childDeleted;
          }

          // Exact subject delete for this operation's metadata (prefix would match opUri that are prefixes of others, e.g. ...:ws-123 vs ...:ws-1234)
          const metaDeleted = await this.store.deleteByPattern({ graph: wsMetaGraph, subject: opUri });
          graphDeleted += metaDeleted;

          for (const re of rootEntities) {
            const ownerDeleted = await this.store.deleteByPattern({
              graph: wsMetaGraph, subject: re, predicate: 'http://dkg.io/ontology/workspaceOwner',
            });
            graphDeleted += ownerDeleted;
          }

          const ownedSet = this.workspaceOwnedEntities.get(pid);
          if (ownedSet) {
            for (const re of rootEntities) {
              ownedSet.delete(re);
            }
          }
        }

        totalDeleted += graphDeleted;
        if (expiredOps.bindings.length > 0) {
          this.log.info(ctx, `SWM cleanup for "${pid}": evicted ${expiredOps.bindings.length} expired operation(s), ${graphDeleted} triples`);
        }
      }
    } catch (err) {
      this.log.warn(ctx, `SWM cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return totalDeleted;
  }

  async publishProfile(): Promise<PublishResult> {
    const pubKeyBase64 = Buffer.from(this.wallet.keypair.publicKey).toString('base64');
    const relayAddrs = this.config.relayPeers;

    const profileConfig: AgentProfileConfig = {
      peerId: this.node.peerId,
      name: this.config.name,
      description: this.config.description,
      framework: this.config.framework,
      nodeRole: this.config.nodeRole ?? 'edge',
      publicKey: pubKeyBase64,
      relayAddress: relayAddrs?.[0],
      agentAddress: this.defaultAgentAddress,
      skills: (this.config.skills ?? []).map(s => ({
        skillType: s.skillType,
        pricePerCall: s.pricePerCall,
        currency: s.currency ?? 'TRAC',
        pricingModel: s.pricePerCall ? 'PerInvocation' as const : 'Free' as const,
      })),
    };

    const profileCtx = createOperationContext('publish');
    this.log.info(profileCtx, `Publishing agent profile`);
    const result = await this.profileManager.publishProfile(profileConfig);
    await this.broadcastPublish(AGENT_REGISTRY_CONTEXT_GRAPH, result, profileCtx);

    return result;
  }

  async findAgents(options?: { framework?: string }): Promise<DiscoveredAgent[]> {
    return this.discovery.findAgents(options);
  }

  async findSkills(options?: SkillSearchOptions): Promise<DiscoveredOffering[]> {
    return this.discovery.findSkillOfferings(options);
  }

  async findAgentByPeerId(peerId: string): Promise<DiscoveredAgent | null> {
    return this.discovery.findAgentByPeerId(peerId);
  }

  // ---------------------------------------------------------------------------
  // Agent Registry — multi-agent identity management
  // ---------------------------------------------------------------------------

  private static readonly AGENT_SYSTEM_GRAPH = 'did:dkg:system/agents';

  /**
   * Register a new agent on this node.
   * - Custodial (publicKey omitted): node generates secp256k1 keypair
   * - Self-sovereign (publicKey provided): agent holds its own key
   */
  async registerAgent(
    name: string,
    opts?: { publicKey?: string; framework?: string },
  ): Promise<AgentKeyRecord> {
    for (const existing of this.localAgents.values()) {
      if (existing.name === name) {
        throw new Error(`Agent name "${name}" already registered on this node`);
      }
    }

    const record = opts?.publicKey
      ? registerSelfSovereignAgent(name, opts.publicKey, opts.framework)
      : generateCustodialAgent(name, opts?.framework);

    this.localAgents.set(record.agentAddress, record);
    this.agentTokenIndex.set(record.authToken, record.agentAddress);
    await this.persistAgentToStore(record);
    await this.saveToKeystore(record);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Registered agent "${name}" (${record.mode}) → ${record.agentAddress}`);
    return record;
  }

  /**
   * List all agents registered on this node.
   * Private keys are NOT included in the response.
   */
  listLocalAgents(): Array<Omit<AgentKeyRecord, 'privateKey'>> {
    return [...this.localAgents.values()].map(({ privateKey: _, ...rest }) => rest);
  }

  /**
   * Resolve an agent address from a Bearer token.
   * Returns undefined if the token is not an agent token (could be a node-level token).
   */
  resolveAgentByToken(token: string): string | undefined {
    return this.agentTokenIndex.get(token);
  }

  /**
   * Get the default agent address for this node.
   * Used when requests come in with a node-level token.
   */
  getDefaultAgentAddress(): string | undefined {
    return this.defaultAgentAddress;
  }

  /**
   * Resolve the agent address for a request: first try agent token, then fall
   * back to the default agent (for node-level tokens / backward compatibility).
   */
  resolveAgentAddress(token: string | undefined): string {
    if (token) {
      const addr = this.agentTokenIndex.get(token);
      if (addr) return addr;
    }
    if (this.defaultAgentAddress) return this.defaultAgentAddress;
    return this.peerId;
  }

  private async persistAgentToStore(record: AgentKeyRecord): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const agentUri = `did:dkg:agent:${record.agentAddress}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const SCHEMA_NAME = 'https://schema.org/name';

    const quads: Quad[] = [
      { subject: agentUri, predicate: RDF_TYPE, object: `${DKG}Agent`, graph },
      { subject: agentUri, predicate: SCHEMA_NAME, object: `"${escapeSparqlLiteral(record.name)}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentAddress`, object: `"${record.agentAddress}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentMode`, object: `"${record.mode}"`, graph },
      { subject: agentUri, predicate: `${DKG}agentAuthTokenHash`, object: `"${hashAgentToken(record.authToken)}"`, graph },
      { subject: agentUri, predicate: `${DKG}createdAt`, object: `"${record.createdAt}"`, graph },
    ];
    if (record.publicKey) {
      quads.push({ subject: agentUri, predicate: `${DKG}publicKey`, object: `"${record.publicKey}"`, graph });
    }
    if (record.framework) {
      quads.push({ subject: agentUri, predicate: 'https://dkg.origintrail.io/skill#framework', object: `"${record.framework}"`, graph });
    }

    await this.store.insert(quads);
  }

  /**
   * Load previously registered agents from the triple store on startup.
   */
  private async loadAgentsFromStore(): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';

    // Load raw tokens and custodial keys from the on-disk keystore
    const keystore = await this.loadKeystore();

    const sparql = `
      SELECT ?agent ?name ?address ?mode ?tokenHash ?legacyToken ?publicKey ?framework ?createdAt ?isDefault WHERE {
        GRAPH <${graph}> {
          ?agent a <${DKG}Agent> ;
                 <https://schema.org/name> ?name ;
                 <${DKG}agentAddress> ?address ;
                 <${DKG}agentMode> ?mode .
          OPTIONAL { ?agent <${DKG}agentAuthTokenHash> ?tokenHash }
          OPTIONAL { ?agent <${DKG}agentAuthToken> ?legacyToken }
          OPTIONAL { ?agent <${DKG}publicKey> ?publicKey }
          OPTIONAL { ?agent <https://dkg.origintrail.io/skill#framework> ?framework }
          OPTIONAL { ?agent <${DKG}createdAt> ?createdAt }
          OPTIONAL { ?agent <${DKG}isDefaultAgent> ?isDefault }
        }
      }
    `;
    let markedDefaultAddr: string | undefined;
    const needsMigration: AgentKeyRecord[] = [];
    try {
      const result = await this.store.query(sparql);
      if (result.type !== 'bindings') return;
      const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
      for (const row of result.bindings) {
        const addr = strip(row['address']);
        const ksEntry = keystore[addr.toLowerCase()];
        const legacyToken = strip(row['legacyToken']);

        // Token resolution: prefer keystore file → legacy plaintext → empty
        let authToken = ksEntry?.authToken ?? '';
        if (!authToken && legacyToken) {
          authToken = legacyToken;
        }

        const record: AgentKeyRecord = {
          agentAddress: addr,
          publicKey: strip(row['publicKey']) || '',
          name: strip(row['name']),
          framework: strip(row['framework']) || undefined,
          mode: strip(row['mode']) as 'custodial' | 'self-sovereign',
          authToken,
          createdAt: strip(row['createdAt']) || '',
        };

        // Restore private key: prefer keystore file, fall back to operational keys
        if (record.mode === 'custodial' && !record.privateKey) {
          if (ksEntry?.privateKey) {
            record.privateKey = ksEntry.privateKey;
          } else {
            const opKeys = this.config.chainConfig?.operationalKeys;
            if (opKeys?.length) {
              for (const key of opKeys) {
                try {
                  const w = new ethers.Wallet(key);
                  if (w.address.toLowerCase() === record.agentAddress.toLowerCase()) {
                    record.privateKey = key;
                    break;
                  }
                } catch { /* skip invalid keys */ }
              }
            }
          }
        }

        this.localAgents.set(record.agentAddress, record);
        if (record.authToken) {
          this.agentTokenIndex.set(record.authToken, record.agentAddress);
        }

        if (strip(row['isDefault']) === 'true') {
          markedDefaultAddr = record.agentAddress;
        }

        // Schedule migration: plaintext token in RDF but no keystore entry yet
        if (legacyToken && !ksEntry?.authToken) {
          needsMigration.push(record);
        }
      }
      if (markedDefaultAddr) {
        this.defaultAgentAddress = markedDefaultAddr;
      }
      if (this.localAgents.size > 0) {
        const ctx = createOperationContext('system');
        this.log.info(ctx, `Loaded ${this.localAgents.size} registered agent(s) from store`);
      }
      // Migrate legacy plaintext tokens: save to keystore, replace RDF with hash
      for (const rec of needsMigration) {
        await this.saveToKeystore(rec);
        await this.migrateTokenToHash(rec);
      }
    } catch {
      // Graph may not exist yet on first boot
    }
  }

  /**
   * Auto-register the default "owner" agent from the first operational wallet.
   * Called on boot when no agents have been previously registered.
   */
  private async autoRegisterDefaultAgent(): Promise<void> {
    let opKey = this.config.chainConfig?.operationalKeys?.[0];
    if (!opKey && typeof (this.chain as any).getOperationalPrivateKey === 'function') {
      try {
        opKey = (this.chain as any).getOperationalPrivateKey();
      } catch { /* adapter without key — skip */ }
    }
    if (!opKey) return;

    const record = agentFromPrivateKey(
      opKey,
      this.config.name ?? 'owner',
      this.config.framework,
    );

    this.localAgents.set(record.agentAddress, record);
    this.agentTokenIndex.set(record.authToken, record.agentAddress);
    this.defaultAgentAddress = record.agentAddress;
    await this.persistAgentToStore(record);
    await this.markDefaultAgent(record.agentAddress);
    await this.saveToKeystore(record);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Auto-registered default agent "${record.name}" → ${record.agentAddress}`);
  }

  // ---------------------------------------------------------------------------
  // Agent keystore — secrets kept out of queryable RDF
  // ---------------------------------------------------------------------------

  private keystorePath(): string | null {
    if (!this.config.dataDir) return null;
    return `${this.config.dataDir}/agent-keystore.json`;
  }

  private async loadKeystore(): Promise<Record<string, { authToken?: string; privateKey?: string }>> {
    const ksPath = this.keystorePath();
    if (!ksPath) return {};
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(ksPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async saveToKeystore(record: AgentKeyRecord): Promise<void> {
    const ksPath = this.keystorePath();
    if (!ksPath) return;
    try {
      const { readFile, writeFile, mkdir, chmod } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      let existing: Record<string, { authToken?: string; privateKey?: string }> = {};
      try {
        const raw = await readFile(ksPath, 'utf-8');
        existing = JSON.parse(raw);
      } catch { /* first write */ }
      existing[record.agentAddress.toLowerCase()] = {
        authToken: record.authToken,
        ...(record.privateKey ? { privateKey: record.privateKey } : {}),
      };
      await mkdir(dirname(ksPath), { recursive: true });
      await writeFile(ksPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
      await chmod(ksPath, 0o600);
    } catch {
      // Non-fatal — agent still works, just won't survive restart
    }
  }

  /**
   * One-time migration: replace a legacy plaintext agentAuthToken triple
   * with an agentAuthTokenHash triple so future SPARQL queries never
   * reveal the raw token.
   */
  private async migrateTokenToHash(record: AgentKeyRecord): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';
    const agentUri = `did:dkg:agent:${record.agentAddress}`;
    try {
      await this.store.delete([{
        subject: agentUri,
        predicate: `${DKG}agentAuthToken`,
        object: `"${record.authToken}"`,
        graph,
      }]);
      await this.store.insert([{
        subject: agentUri,
        predicate: `${DKG}agentAuthTokenHash`,
        object: `"${hashAgentToken(record.authToken)}"`,
        graph,
      }]);
      const ctx = createOperationContext('system');
      this.log.info(ctx, `Migrated plaintext auth token to hash for agent ${record.agentAddress}`);
    } catch {
      // Non-fatal — old token remains readable until next migration attempt
    }
  }

  /**
   * Persist an explicit default-agent marker in the triple store so the
   * default agent is deterministic across restarts (independent of SPARQL
   * result ordering).
   */
  private async markDefaultAgent(agentAddress: string): Promise<void> {
    const graph = DKGAgent.AGENT_SYSTEM_GRAPH;
    const DKG = 'https://dkg.network/ontology#';
    // Clear any existing default marker
    try {
      const existing = await this.store.query(
        `SELECT ?agent WHERE { GRAPH <${graph}> { ?agent <${DKG}isDefaultAgent> "true" } }`,
      );
      if (existing.type === 'bindings') {
        for (const row of existing.bindings) {
          const agentUri = row['agent'];
          if (agentUri) {
            await this.store.delete([{
              subject: agentUri, predicate: `${DKG}isDefaultAgent`, object: `"true"`, graph,
            }]);
          }
        }
      }
    } catch { /* ignore */ }
    const agentUri = `did:dkg:agent:${agentAddress}`;
    await this.store.insert([{
      subject: agentUri, predicate: `${DKG}isDefaultAgent`, object: `"true"`, graph,
    }]);
  }

  /**
   * Check whether any locally registered agent is the curator/creator
   * of the given context graph.
   */
  async isCuratorOf(contextGraphId: string): Promise<boolean> {
    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) return false;
    const selfDid = `did:dkg:agent:${this.peerId}`;
    if (owner === selfDid) return true;
    for (const addr of this.localAgents.keys()) {
      if (owner === `did:dkg:agent:${addr}`) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------

  async sendChat(recipientPeerId: string, text: string): Promise<{ delivered: boolean; error?: string }> {
    if (!this.messageHandler) throw new Error('Agent not started');
    await this.ensureCircuitRelayAddress(recipientPeerId);
    return this.messageHandler.sendChat(recipientPeerId, text);
  }

  onChat(handler: ChatHandler): void {
    if (!this.messageHandler) {
      this._pendingChatHandler = handler;
      return;
    }
    this.messageHandler.onChat(handler);
  }

  private _pendingChatHandler: ChatHandler | null = null;

  async invokeSkill(
    recipientPeerId: string,
    skillUri: string,
    inputData: Uint8Array,
  ): Promise<SkillResponse> {
    if (!this.messageHandler) throw new Error('Agent not started');
    await this.ensureCircuitRelayAddress(recipientPeerId);

    return this.messageHandler.sendSkillRequest(recipientPeerId, {
      skillUri,
      inputData,
      callback: 'inline',
    });
  }

  async connectTo(multiaddress: string): Promise<void> {
    await this.node.libp2p.dial(multiaddr(multiaddress));
  }

  /**
   * Ensure libp2p knows how to reach a peer via circuit relay. If the peer
   * isn't directly connected and their profile advertises a relay address, we
   * add a /p2p-circuit multiaddr to the peer store so dialProtocol can route
   * through the relay.
   */
  private async ensureCircuitRelayAddress(peerIdStr: string): Promise<void> {
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const peerId = peerIdFromString(peerIdStr);

      const conns = this.node.libp2p.getConnections(peerId);
      if (conns.length > 0) return;

      const agent = await this.discovery.findAgentByPeerId(peerIdStr);
      if (!agent?.relayAddress) return;

      const circuitAddr = multiaddr(
        `${agent.relayAddress}/p2p-circuit/p2p/${peerIdStr}`,
      );
      await this.node.libp2p.peerStore.merge(peerId, {
        multiaddrs: [circuitAddr],
      });
    } catch {
      // Best-effort: if peer ID is invalid or lookup fails, let the
      // caller proceed — it will get a proper error from dialProtocol.
    }
  }

  // Overload: raw quads
  async publish(contextGraphId: string, quads: Quad[], privateQuads?: Quad[], opts?: PublishOpts): Promise<PublishResult>;
  // Overload: JSON-LD (bare doc = private, or { public?, private? } envelope)
  async publish(contextGraphId: string, content: JsonLdContent, opts?: PublishOpts): Promise<PublishResult>;
  async publish(
    contextGraphId: string,
    input: Quad[] | JsonLdContent,
    thirdArg?: Quad[] | PublishOpts,
    fourthArg?: PublishOpts,
  ): Promise<PublishResult> {
    // JSON-LD: convert to quads, then publish
    if (!Array.isArray(input)) {
      const { publicQuads, privateQuads } = await jsonLdToQuads(input);
      return this._publish(contextGraphId, publicQuads, privateQuads, thirdArg as PublishOpts);
    }
    // Quad[]: pass through directly
    if (Array.isArray(thirdArg)) {
      return this._publish(contextGraphId, input as Quad[], thirdArg, fourthArg);
    }
    return this._publish(contextGraphId, input as Quad[], undefined, thirdArg ?? fourthArg);
  }

  private async _publish(
    contextGraphId: string,
    quads: Quad[],
    privateQuads?: Quad[],
    opts?: PublishOpts,
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('publish');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting publish to context graph "${contextGraphId}" with ${quads.length} triples`);

    const isSystem = contextGraphId === SYSTEM_PARANETS.AGENTS || contextGraphId === SYSTEM_PARANETS.ONTOLOGY;
    if (!isSystem) {
      const exists = await this.contextGraphExists(contextGraphId);
      if (!exists) {
        throw new Error(
          `Context graph "${contextGraphId}" does not exist. Create it first with createContextGraph().`,
        );
      }
    }
    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);

    const onChainId = await this.getContextGraphOnChainId(contextGraphId);

    const result = await this.publisher.publish({
      contextGraphId,
      quads,
      privateQuads,
      publisherPeerId: this.peerId,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
      subGraphName: opts?.subGraphName,
      operationCtx: ctx,
      onPhase,
      v10ACKProvider,
      publishContextGraphId: onChainId ?? undefined,
    });

    onPhase?.('broadcast', 'start');
    this.log.info(ctx, `Local publish complete, broadcasting to peers`);
    await this.broadcastPublish(contextGraphId, result, ctx);
    onPhase?.('broadcast', 'end');
    this.log.info(ctx, `Publish complete — status=${result.status} kcId=${result.kcId}`);
    return result;
  }

  async update(
    kcId: bigint, contextGraphId: string, quads: Quad[], privateQuads?: Quad[],
    opts?: { onPhase?: PhaseCallback; operationCtx?: OperationContext },
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('update');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting update of kcId=${kcId} in context graph "${contextGraphId}" with ${quads.length} triples`);
    const result = await this.publisher.update(kcId, {
      contextGraphId,
      quads,
      privateQuads,
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      onPhase,
    });
    this.log.info(ctx, `Update complete — status=${result.status}`);

    onPhase?.('broadcast', 'start');
    if (result.onChainResult && result.publicQuads) {
      try {
        const dataGraph = `did:dkg:context-graph:${contextGraphId}`;
        const nquadsStr = result.publicQuads
          .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${dataGraph}> .`)
          .join('\n');
        const nquadsBytes = new TextEncoder().encode(nquadsStr);
        const message = encodeKAUpdateRequest({
          paranetId: contextGraphId,
          batchId: kcId,
          nquads: nquadsBytes,
          manifest: result.kaManifest.map((m) => ({
            rootEntity: m.rootEntity,
            privateMerkleRoot: m.privateMerkleRoot,
            privateTripleCount: m.privateTripleCount ?? 0,
          })),
          publisherPeerId: this.node.peerId.toString(),
          publisherAddress: result.onChainResult.publisherAddress,
          txHash: result.onChainResult.txHash,
          blockNumber: result.onChainResult.blockNumber,
          newMerkleRoot: result.merkleRoot,
          timestampMs: Date.now(),
          operationId: ctx.operationId,
        });
        const topic = paranetUpdateTopic(contextGraphId);
        await this.gossip.publish(topic, message);
        this.log.info(ctx, `Broadcast KA update for batchId=${kcId} on ${topic}`);
      } catch (err) {
        this.log.warn(ctx, `Failed to broadcast KA update: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    onPhase?.('broadcast', 'end');

    return result;
  }

  /**
   * Write quads to the context graph's shared memory (no chain, no TRAC).
   * When localOnly is false (default), replicates via GossipSub shared memory topic.
   * When localOnly is true, stores locally without broadcasting — use for private data.
   */
  async share(contextGraphId: string, quads: Quad[], opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string }): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `Sharing ${quads.length} quads to SWM for context graph ${contextGraphId}${sgLabel}${opts?.localOnly ? ' (local-only)' : ''}`);
    const { shareOperationId, message } = await this.publisher.writeToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      subGraphName: opts?.subGraphName,
    });
    if (!opts?.localOnly) {
      const topic = paranetWorkspaceTopic(contextGraphId);
      try {
        await this.gossip.publish(topic, message);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }
    }
    return { shareOperationId };
  }

  /**
   * Compare-and-swap shared memory write. Verifies each condition against the
   * current shared memory graph before applying the write atomically.
   * Throws StaleWriteError if any condition fails.
   */
  async conditionalShare(
    contextGraphId: string,
    quads: Quad[],
    conditions: CASCondition[],
    opts?: { localOnly?: boolean; operationCtx?: OperationContext; subGraphName?: string },
  ): Promise<{ shareOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('share');
    const sgLabel = opts?.subGraphName ? ` (sub-graph: ${opts.subGraphName})` : '';
    this.log.info(ctx, `CAS write: ${quads.length} quads, ${conditions.length} conditions for ${contextGraphId}${sgLabel}`);
    const { shareOperationId, message } = await this.publisher.writeConditionalToWorkspace(contextGraphId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      conditions,
      subGraphName: opts?.subGraphName,
    });
    if (!opts?.localOnly) {
      const topic = paranetWorkspaceTopic(contextGraphId);
      try {
        await this.gossip.publish(topic, message);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }
    }
    return { shareOperationId };
  }

  /**
   * Publish shared memory content: read from SWM graph and publish with full finality (data graph + chain).
   * After on-chain confirmation, broadcasts a lightweight FinalizationMessage so peers with matching
   * SWM state can promote it to canonical without re-downloading the full payload.
   */
  async publishFromSharedMemory(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: {
      clearSharedMemoryAfter?: boolean;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      /** @deprecated Use subContextGraphId */
      contextGraphId?: string | bigint;
      subContextGraphId?: string | bigint;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
      /** Target sub-graph within the context graph (e.g. "code", "decisions"). */
      subGraphName?: string;
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('publishFromSWM');
    const effectiveSubCG = options?.subContextGraphId ?? options?.contextGraphId;
    const ctxGraphIdStr = effectiveSubCG != null ? String(effectiveSubCG) : undefined;

    const onChainId = ctxGraphIdStr ?? (await this.getContextGraphOnChainId(contextGraphId)) ?? undefined;

    const v10ACKProvider = this.createV10ACKProvider(contextGraphId);
    const result = await this.publisher.publishFromSharedMemory(contextGraphId, selection, {
      operationCtx: ctx,
      clearSharedMemoryAfter: options?.clearSharedMemoryAfter,
      onPhase: options?.onPhase,
      publishContextGraphId: ctxGraphIdStr,
      onChainContextGraphId: onChainId,
      contextGraphSignatures: options?.contextGraphSignatures,
      v10ACKProvider,
      subGraphName: options?.subGraphName,
    });

    if (result.status === 'confirmed' && result.onChainResult) {
      const rootEntities = result.kaManifest.map(ka => ka.rootEntity);

      const msg: FinalizationMessageMsg = {
        ual: result.ual,
        paranetId: contextGraphId,
        kcMerkleRoot: result.merkleRoot,
        txHash: result.onChainResult.txHash ?? '',
        blockNumber: result.onChainResult.blockNumber ?? 0,
        batchId: result.onChainResult.batchId ?? 0n,
        startKAId: result.onChainResult.startKAId ?? 0n,
        endKAId: result.onChainResult.endKAId ?? 0n,
        publisherAddress: result.onChainResult.publisherAddress ?? '',
        rootEntities,
        timestampMs: Date.now(),
        operationId: ctx.operationId,
        contextGraphId: result.contextGraphError ? undefined : ctxGraphIdStr,
        subGraphName: options?.subGraphName,
      };

      const topic = paranetFinalizationTopic(contextGraphId);
      try {
        await this.gossip.publish(topic, encodeFinalizationMessage(msg));
        this.log.info(ctx, `Broadcast finalization for ${result.ual} to ${topic}${ctxGraphIdStr ? ` (contextGraph=${ctxGraphIdStr})` : ''}${result.contextGraphError ? ' (ctx-graph registration failed, omitting contextGraphId)' : ''}`);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }
    }

    return result;
  }

  /** @deprecated Use publishFromSharedMemory. Will be removed in V10.1. */
  async enshrineFromWorkspace(
    ...args: Parameters<DKGAgent['publishFromSharedMemory']>
  ): ReturnType<DKGAgent['publishFromSharedMemory']> {
    return this.publishFromSharedMemory(...args);
  }

  /**
   * Register a new M/N signature-gated context graph on-chain.
   */
  async registerContextGraphOnChain(params: CreateOnChainContextGraphParams): Promise<CreateOnChainContextGraphResult> {
    const ctx = createOperationContext('system');
    if (typeof this.chain.createOnChainContextGraph !== 'function') {
      throw new Error('createOnChainContextGraph not available on chain adapter');
    }
    const result = await this.chain.createOnChainContextGraph(params);
    this.log.info(ctx, `Created on-chain context graph ${result.contextGraphId} (M=${params.requiredSignatures}, N=${params.participantIdentityIds.length})`);
    return result;
  }

  /**
   * Link an already-published KC batch to a context graph.
   * Collects participant signatures and calls addBatchToContextGraph on-chain.
   */
  async addBatchToContextGraph(params: {
    contextGraphId: string | bigint;
    batchId: bigint;
    merkleRoot?: Uint8Array;
    participantSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
  }): Promise<{ success: boolean }> {
    const ctx = createOperationContext('system');
    if (typeof this.chain.verify !== 'function') {
      throw new Error('verify not available on chain adapter');
    }

    let merkleRoot = params.merkleRoot;
    if (!merkleRoot) {
      const batch = (this.chain as any).getBatch?.(params.batchId);
      merkleRoot = batch?.merkleRoot;
    }

    const result = await this.chain.verify({
      contextGraphId: BigInt(params.contextGraphId),
      batchId: params.batchId,
      merkleRoot,
      signerSignatures: params.participantSignatures ?? [],
    });
    this.log.info(ctx, `addBatchToContextGraph: batch=${params.batchId} → ctxGraph=${params.contextGraphId} success=${result.success}`);
    return { success: result.success };
  }

  /**
   * (Re-)attempt on-chain identity registration. Safe to call multiple times.
   * Returns the identityId (>0n on success, 0n if chain is not configured).
   */
  async ensureIdentity(): Promise<bigint> {
    if (this.chain.chainId === 'none') return 0n;
    const effectiveRole = this.config.nodeRole ?? 'edge';
    const ctx = createOperationContext('system');
    let identityId = 0n;
    try {
      identityId = await this.chain.getIdentityId();
      if (identityId === 0n && effectiveRole === 'core') {
        this.log.info(ctx, 'ensureIdentity: no on-chain identity, creating profile...');
        identityId = await this.chain.ensureProfile({ nodeName: this.config.name });
        this.log.info(ctx, `ensureIdentity: profile created, identityId=${identityId}`);
      } else if (identityId === 0n) {
        return 0n;
      }
    } catch (err) {
      this.log.warn(ctx, `ensureIdentity error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        identityId = await this.chain.getIdentityId();
      } catch { /* ignore */ }
    }
    if (identityId > 0n) {
      this.publisher.setIdentityId(identityId);
    }
    return identityId;
  }

  async query(
    sparql: string,
    options?: string | {
      contextGraphId?: string;
      /** @deprecated Use contextGraphId */
      paranetId?: string;
      graphSuffix?: '_shared_memory';
      includeSharedMemory?: boolean;
      /** @deprecated Use includeSharedMemory */
      includeWorkspace?: boolean;
      operationCtx?: OperationContext;
      view?: GetView;
      agentAddress?: string;
      verifiedGraph?: string;
      assertionName?: string;
      subGraphName?: string;
    },
  ) {
    const rawOpts = typeof options === 'string' ? { contextGraphId: options } : options ?? {};
    const opts = {
      ...rawOpts,
      contextGraphId: rawOpts.contextGraphId ?? rawOpts.paranetId,
      includeSharedMemory: rawOpts.includeSharedMemory ?? rawOpts.includeWorkspace,
    };
    const ctx = opts.operationCtx ?? createOperationContext('query');
    const sgLabel = opts.subGraphName ? `/${opts.subGraphName}` : '';
    const viewLabel = opts.view ? ` view=${opts.view}` : '';
    this.log.info(ctx, `Query on contextGraph="${opts.contextGraphId ?? 'all'}"${sgLabel}${viewLabel} sparql="${sparql.slice(0, 80)}"`);

    if (opts.contextGraphId && !(await this.canReadContextGraph(opts.contextGraphId))) {
      this.log.info(ctx, `Query denied for private context graph "${opts.contextGraphId}"`);
      return { bindings: [] };
    }

    // When no context graph is specified, exclude private CGs the caller cannot
    // read to prevent data leakage via unscoped or FROM-less SPARQL.
    let excludeGraphPrefixes: string[] | undefined;
    if (!opts.contextGraphId) {
      excludeGraphPrefixes = await this.getDisallowedGraphPrefixes();
      // Per spec Axiom 1 every shared query must be resolved within a CG.
      // Reject explicit GRAPH/FROM clauses that reference private CGs the
      // caller cannot read — post-filtering alone cannot prevent leaks via
      // aggregates (ASK, COUNT) or projections that omit graph/subject.
      if (excludeGraphPrefixes.length > 0 && this.sparqlReferencesPrivateGraphs(sparql, excludeGraphPrefixes)) {
        this.log.info(ctx, 'Query denied: SPARQL references private context graphs the caller cannot read');
        return { bindings: [] };
      }
    }

    const result = await this.queryEngine.query(sparql, {
      paranetId: opts.contextGraphId,
      excludeGraphPrefixes,
      graphSuffix: opts.graphSuffix,
      includeSharedMemory: opts.includeSharedMemory,
      view: opts.view,
      agentAddress: opts.agentAddress ?? (opts.view === 'working-memory' ? this.peerId : undefined),
      verifiedGraph: opts.verifiedGraph,
      assertionName: opts.assertionName,
      subGraphName: opts.subGraphName,
    });
    this.log.info(ctx, `Query returned ${result.bindings?.length ?? 0} bindings`);
    return result;
  }

  private async canReadContextGraph(contextGraphId: string): Promise<boolean> {
    if (!(await this.isPrivateContextGraph(contextGraphId))) {
      return true;
    }

    const participants = await this.getPrivateContextGraphParticipants(contextGraphId);

    // No participant list at all → allow creator / locally-subscribed nodes
    if (!participants || participants.length === 0) {
      return this.subscribedContextGraphs.has(contextGraphId)
        || (this.config.syncContextGraphs ?? []).includes(contextGraphId);
    }

    // Check if any local agent address is in the participants list
    const myAgentAddress = this.defaultAgentAddress;
    if (myAgentAddress && participants.some((p) => p.toLowerCase() === myAgentAddress.toLowerCase())) {
      return true;
    }

    // Check if the local identity ID is in the participants list
    let myIdentityId = 0n;
    try {
      myIdentityId = await this.chain.getIdentityId();
      if (myIdentityId > 0n && participants.includes(String(myIdentityId))) {
        return true;
      }
    } catch { /* identity lookup failed — continue to deny */ }

    // Legacy peer-ID allowlist: `inviteToContextGraph` writes `DKG_ALLOWED_PEER`
    // quads. Honor them for local reads so a peer-ID-invited node can query
    // the data it just synced.
    const allowedPeers = await this.getContextGraphAllowedPeers(contextGraphId);
    if (allowedPeers?.includes(this.peerId)) {
      return true;
    }

    // Edge nodes without an on-chain identity (identityId 0n) fall back to
    // subscription-based access — the subscription itself is an authorization
    // (the node was invited or created this CG).
    if (myIdentityId === 0n) {
      return this.subscribedContextGraphs.has(contextGraphId);
    }

    return false;
  }

  /**
   * Returns graph URI prefixes for private CGs the caller cannot read.
   * Used to exclude them from unscoped queries.
   */
  private async getDisallowedGraphPrefixes(): Promise<string[]> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const result = await this.store.query(
      `SELECT ?cg WHERE {
        GRAPH <${ontologyGraph}> {
          ?cg <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> "private"
        }
      }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return [];

    const prefixes: string[] = [];
    for (const row of result.bindings) {
      const cgUri = row['cg'];
      if (!cgUri) continue;
      // cgUri is like "did:dkg:context-graph:some-id" — extract the ID
      const match = cgUri.match(/^<?did:dkg:context-graph:([^>]+)>?$/);
      if (!match) continue;
      const contextGraphId = match[1];
      if (await this.canReadContextGraph(contextGraphId)) continue;
      // Exclude all named graphs under this CG (data, _meta, _shared_memory, etc.)
      prefixes.push(`did:dkg:context-graph:${contextGraphId}`);
    }
    return prefixes;
  }

  private sparqlReferencesPrivateGraphs(sparql: string, disallowedPrefixes: string[]): boolean {
    if (disallowedPrefixes.length === 0) return false;
    const upper = sparql.toUpperCase();
    if (!upper.includes('GRAPH') && !upper.includes('FROM')) return false;
    return disallowedPrefixes.some(prefix => sparql.includes(prefix));
  }

  /**
   * Send a cross-agent query to a remote peer via the /dkg/query/2.0.0 protocol.
   */
  async queryRemote(
    peerId: string,
    request: Omit<QueryRequest, 'operationId'>,
  ): Promise<QueryResponse> {
    const ctx = createOperationContext('query');
    const operationId = crypto.randomUUID();
    const fullRequest: QueryRequest = { ...request, operationId };

    this.log.info(ctx, `Remote query to ${peerId.slice(-8)} type=${request.lookupType}`);

    const payload = new TextEncoder().encode(JSON.stringify(fullRequest));
    const responseBytes = await this.router.send(peerId, PROTOCOL_QUERY_REMOTE, payload);
    const response = JSON.parse(new TextDecoder().decode(responseBytes)) as QueryResponse;

    this.log.info(ctx, `Remote query response: status=${response.status} resultCount=${response.resultCount}`);
    return response;
  }

  /**
   * Look up a specific knowledge asset on a remote peer by UAL.
   */
  async lookupEntity(peerId: string, ual: string): Promise<QueryResponse> {
    return this.queryRemote(peerId, { lookupType: 'ENTITY_BY_UAL', ual });
  }

  /**
   * Find entities of a given RDF type on a remote peer's context graph.
   */
  async findEntitiesByType(
    peerId: string,
    contextGraphId: string,
    rdfType: string,
    limit?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITIES_BY_TYPE',
      paranetId: contextGraphId,
      rdfType,
      limit,
    });
  }

  /**
   * Get all triples for a specific entity from a remote peer's context graph.
   */
  async getEntityTriples(
    peerId: string,
    contextGraphId: string,
    entityUri: string,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITY_TRIPLES',
      paranetId: contextGraphId,
      entityUri,
    });
  }

  /**
   * Run a SPARQL query on a remote peer (if they allow it).
   */
  async queryRemoteSparql(
    peerId: string,
    contextGraphId: string,
    sparql: string,
    limit?: number,
    timeout?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'SPARQL_QUERY',
      paranetId: contextGraphId,
      sparql,
      limit,
      timeout,
    });
  }

  subscribeToContextGraph(contextGraphId: string, options?: { trackSyncScope?: boolean }): void {
    if (options?.trackSyncScope !== false) {
      this.trackSyncContextGraph(contextGraphId);
    }

    // Idempotent: skip if gossip handlers already installed for this context graph.
    if (this.gossipRegistered.has(contextGraphId)) {
      const existing = this.subscribedContextGraphs.get(contextGraphId);
      if (!existing?.subscribed) {
        this.subscribedContextGraphs.set(contextGraphId, { ...existing, subscribed: true, synced: existing?.synced ?? false });
      }
      return;
    }
    this.gossipRegistered.add(contextGraphId);

    const publishTopic = paranetPublishTopic(contextGraphId);
    const swmTopic = paranetWorkspaceTopic(contextGraphId);
    const appTopic = paranetAppTopic(contextGraphId);

    this.gossip.subscribe(publishTopic);
    this.gossip.subscribe(swmTopic);
    this.gossip.subscribe(appTopic);

    const existing = this.subscribedContextGraphs.get(contextGraphId);
    this.subscribedContextGraphs.set(contextGraphId, { ...existing, subscribed: true, synced: existing?.synced ?? false });

    this.gossip.onMessage(publishTopic, async (_topic, data, from) => {
      const gph = this.getOrCreateGossipPublishHandler();
      await gph.handlePublishMessage(data, contextGraphId, undefined, from);
    });

    this.gossip.onMessage(swmTopic, async (_topic, data, from) => {
      const wh = this.getOrCreateSharedMemoryHandler();
      await wh.handle(data, from);
    });

    const updateTopic = paranetUpdateTopic(contextGraphId);
    this.gossip.subscribe(updateTopic);
    this.gossip.onMessage(updateTopic, async (_topic, data, from) => {
      const uh = this.getOrCreateUpdateHandler();
      await uh.handle(data, from);
    });

    const finalizationTopic = paranetFinalizationTopic(contextGraphId);
    this.gossip.subscribe(finalizationTopic);
    this.gossip.onMessage(finalizationTopic, async (_topic, data) => {
      const fh = this.getOrCreateFinalizationHandler();
      await fh.handleFinalizationMessage(data, contextGraphId);
    });
  }

  /**
   * Add a context graph to runtime sync scope so sync-on-connect includes it.
   * System context graphs are already included by default and are skipped here.
   */
  private trackSyncContextGraph(contextGraphId: string): void {
    const systemContextGraphs = new Set<string>(Object.values(SYSTEM_PARANETS) as string[]);
    if (systemContextGraphs.has(contextGraphId)) return;

    const syncSet = new Set<string>(this.config.syncContextGraphs ?? []);
    if (syncSet.has(contextGraphId)) return;
    syncSet.add(contextGraphId);
    this.config.syncContextGraphs = [...syncSet];
  }

  private getOrCreateGossipPublishHandler(): GossipPublishHandler {
    if (!this.gossipPublishHandler) {
      this.gossipPublishHandler = new GossipPublishHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        this.subscribedContextGraphs,
        {
          contextGraphExists: (id) => this.contextGraphExists(id),
          getContextGraphOwner: (id) => this.getContextGraphOwner(id),
          subscribeToContextGraph: (id, options) => this.subscribeToContextGraph(id, options),
        },
      );
    }
    return this.gossipPublishHandler;
  }

  private getOrCreateSharedMemoryHandler(): InstanceType<typeof SharedMemoryHandler> {
    if (!this.sharedMemoryHandler) {
      this.sharedMemoryHandler = new SharedMemoryHandler(this.store, this.eventBus, {
        sharedMemoryOwnedEntities: this.workspaceOwnedEntities,
        writeLocks: this.writeLocks,
      });
    }
    return this.sharedMemoryHandler;
  }

  private updateHandler?: UpdateHandler;

  private getOrCreateUpdateHandler(): UpdateHandler {
    if (!this.updateHandler) {
      this.updateHandler = new UpdateHandler(this.store, this.chain, this.eventBus, {
        knownBatchContextGraphs: this.publisher.knownBatchContextGraphs,
      });
    }
    return this.updateHandler;
  }

  private getOrCreateFinalizationHandler(): FinalizationHandler {
    if (!this.finalizationHandler) {
      this.finalizationHandler = new FinalizationHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
      );
    }
    return this.finalizationHandler;
  }

  /**
   * Create a context graph. All CGs start as free, P2P collaborative spaces.
   * No blockchain transaction is required. On-chain registration is a separate
   * explicit step via {@link registerContextGraph}.
   *
   * The `private` flag still works for truly local-only CGs (no gossip, no sync).
   * For curated CGs, provide `allowedPeers` to restrict gossip writes to listed peers.
   */
  async createContextGraph(opts: {
    id: string;
    name: string;
    description?: string;
    replicationPolicy?: string;
    accessPolicy?: number;
    /** @deprecated Use allowedAgents. Peer allowlist for curated CGs. */
    allowedPeers?: string[];
    /** Agent address allowlist for curated CGs. Omit for open CGs. */
    allowedAgents?: string[];
    /** Identity IDs for private CG access control (chain-based). */
    participantIdentityIds?: bigint[];
    /** Required signatures threshold for participant-based CGs. */
    requiredSignatures?: number;
    /** Participant agent addresses for on-chain context graphs. */
    participantAgents?: string[];
    /** When true, skips gossip subscription and broadcast. Data stays local-only. */
    private?: boolean;
    /** Caller's agent address (resolved from token). Used for curator/creator triples. */
    callerAgentAddress?: string;
  }): Promise<void> {
    const ctx = createOperationContext('system');
    const gm = new GraphManager(this.store);
    const paranetUri = `did:dkg:context-graph:${opts.id}`;
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      throw new Error(`Context graph "${opts.id}" already exists`);
    }

    const isCurated = opts.accessPolicy === 1 || (opts.allowedAgents && opts.allowedAgents.length > 0);

    if (opts.private) {
      this.log.info(ctx, `Creating private context graph "${opts.id}" (local-only, no gossip)`);
    } else if (isCurated) {
      this.log.info(ctx, `Creating curated context graph "${opts.id}" (invite-only, definition hidden from ONTOLOGY)`);
    } else {
      this.log.info(ctx, `Creating context graph "${opts.id}" (P2P, no chain)`);
    }

    // Curated CGs store definition triples in their own _meta graph so they
    // are NOT discoverable via ONTOLOGY sync. Only invited/subscribed nodes
    // will see them. Open CGs go to ONTOLOGY for network-wide discovery.
    const defGraph = isCurated ? cgMetaGraph : ontologyGraph;

    const quads: Quad[] = [
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${this.peerId}`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${paranetPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"${opts.replicationPolicy ?? 'full'}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: `"${isCurated || opts.private ? 'private' : 'public'}"`, graph: defGraph },
    ];

    // Store registration status and curator in _meta
    quads.push(
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"unregistered"`, graph: cgMetaGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${opts.callerAgentAddress ?? this.defaultAgentAddress ?? this.peerId}`, graph: cgMetaGraph },
    );

    // Store peer allowlist for curated CGs (with validation)
    if (opts.allowedPeers && opts.allowedPeers.length > 0) {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      for (const peer of opts.allowedPeers) {
        try { peerIdFromString(peer); } catch {
          throw new Error(`Invalid peer ID in allowedPeers: "${peer}". Expected a libp2p peer ID (e.g. 12D3KooW…).`);
        }
        quads.push({
          subject: paranetUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
          object: `"${escapeSparqlLiteral(peer)}"`,
          graph: cgMetaGraph,
        });
      }
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${this.peerId}"`,
        graph: cgMetaGraph,
      });
    }

    // Store agent allowlist (V10 agent identity model)
    if (opts.allowedAgents && opts.allowedAgents.length > 0) {
      const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
      for (const addr of opts.allowedAgents) {
        if (!ethAddrRe.test(addr)) {
          throw new Error(`Invalid Ethereum address in allowedAgents: "${addr}".`);
        }
        quads.push({
          subject: paranetUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${addr}"`,
          graph: cgMetaGraph,
        });
      }
    }
    // Auto-include creator in allowlist for curated/private CGs
    if (isCurated || opts.private) {
      const creatorAddr = opts.callerAgentAddress ?? this.defaultAgentAddress;
      if (creatorAddr) {
        quads.push({
          subject: paranetUri,
          predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
          object: `"${creatorAddr}"`,
          graph: cgMetaGraph,
        });
      }
    }

    // Store participant identity IDs for private CG access control (chain-based, legacy)
    const creatorIdentityId = await this.chain.getIdentityId();
    const participantIdentityIds = new Set<bigint>(opts.participantIdentityIds ?? []);
    if (creatorIdentityId > 0n) {
      participantIdentityIds.add(creatorIdentityId);
    }
    for (const participantIdentityId of participantIdentityIds) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID,
        object: `"${participantIdentityId.toString()}"`,
        graph: cgMetaGraph,
      });
    }
    if (participantIdentityIds.size > 0 && typeof opts.requiredSignatures === 'number' && opts.requiredSignatures > 0) {
      const reqSig = Math.floor(opts.requiredSignatures);
      if (reqSig < 1) {
        throw new Error(`requiredSignatures must be >= 1, got ${opts.requiredSignatures}`);
      }
      if (reqSig > participantIdentityIds.size) {
        throw new Error(`requiredSignatures (${reqSig}) exceeds participant count (${participantIdentityIds.size})`);
      }
      quads.push({
        subject: paranetUri,
        predicate: `${DKG_ONTOLOGY.DKG_PARANET}RequiredSignatures`,
        object: `"${reqSig}"`,
        graph: cgMetaGraph,
      });
    }

    if (opts.description) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    // Provenance activity
    const activityUri = `did:dkg:activity:create-context-graph:${opts.id}:${Date.now()}`;
    quads.push(
      { subject: paranetUri, predicate: DKG_ONTOLOGY.PROV_GENERATED_BY, object: activityUri, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.PROV_ACTIVITY, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ASSOCIATED_WITH, object: `did:dkg:agent:${this.peerId}`, graph: defGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ENDED_AT_TIME, object: `"${now}"`, graph: defGraph },
    );

    await this.store.insert(quads);
    await gm.ensureParanet(opts.id);

    this.subscribedContextGraphs.set(opts.id, {
      name: opts.name,
      subscribed: !opts.private,
      synced: true,
      metaSynced: true,
    });

    // Auto-register on-chain (V10 ContextGraphs contract) when the chain
    // adapter supports it and the node has an on-chain identity. This gives
    // the context graph a numeric on-chain ID required by publishDirect and
    // enables Verified Memory (publishFromSWM).
    if (
      this.chain.chainId !== 'none' &&
      !this.chain.chainId.startsWith('mock') &&
      creatorIdentityId > 0n &&
      typeof this.chain.createOnChainContextGraph === 'function'
    ) {
      try {
        const sortedParticipants = [...participantIdentityIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const result = await this.chain.createOnChainContextGraph({
          participantIdentityIds: sortedParticipants,
          requiredSignatures: opts.requiredSignatures ?? 1,
          publishPolicy: 1,
        });
        const numericId = result.contextGraphId.toString();
        const sub = this.subscribedContextGraphs.get(opts.id);
        if (sub) sub.onChainId = numericId;

        const cgMetaGraph = paranetMetaGraphUri(opts.id);
        const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
        await this.store.deleteByPattern({
          graph: cgMetaGraph,
          subject: paranetUri,
          predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
        });
        await this.store.insert([
          { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
          { subject: paranetUri, predicate: `${DKG_ONTOLOGY.DKG_PARANET}OnChainId`, object: `"${numericId}"`, graph: ontologyGraph },
        ]);
        this.log.info(ctx, `Auto-registered context graph "${opts.id}" on-chain (V10 id=${numericId})`);
      } catch (err) {
        this.log.warn(ctx, `Auto-register on-chain skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!opts.private) {
      this.subscribeToContextGraph(opts.id);

      // Curated CGs: definition lives in _meta, NOT in ONTOLOGY. Do not
      // broadcast to the network — only invited nodes will discover it via
      // the explicit subscribe→sync flow.
      if (!isCurated) {
        const ontologyTopic = paranetPublishTopic(SYSTEM_PARANETS.ONTOLOGY);
        const broadcastQuads = quads.filter(q => q.graph === ontologyGraph);
        const nquads = broadcastQuads.map(q => {
          const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
          return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
        }).join('\n');

        const msg = encodePublishRequest({
          ual: `did:dkg:context-graph:${opts.id}`,
          nquads: new TextEncoder().encode(nquads),
          paranetId: SYSTEM_PARANETS.ONTOLOGY,
          kas: [],
          publisherIdentity: this.wallet.keypair.publicKey,
          publisherAddress: '',
          startKAId: 0,
          endKAId: 0,
          chainId: '',
          publisherSignatureR: new Uint8Array(0),
          publisherSignatureVs: new Uint8Array(0),
        });

        try {
          await this.gossip.publish(ontologyTopic, msg);
        } catch {
          // No peers subscribed — ok for now
        }
      }
    }
  }

  /**
   * Register an existing context graph on-chain. This is the explicit upgrade
   * step that unlocks Verified Memory, chain-based discovery, and economic
   * participation. Requires a funded wallet with TRAC.
   */
  async registerContextGraph(id: string, opts?: {
    revealOnChain?: boolean;
    accessPolicy?: number;
  }): Promise<{ onChainId: string; txHash?: string }> {
    const ctx = createOperationContext('system');

    const exists = await this.contextGraphExists(id);
    if (!exists) {
      throw new Error(`Context graph "${id}" does not exist locally. Create it first.`);
    }

    if (this.chain.chainId === 'none') {
      throw new Error('On-chain registration requires a configured chain adapter');
    }

    // Only the curator/creator can register a CG on-chain
    const owner = await this.getContextGraphOwner(id);
    const selfDid = `did:dkg:agent:${this.peerId}`;
    if (!owner) {
      throw new Error(
        `Context graph "${id}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    if (owner !== selfDid) {
      throw new Error(
        `Only the context graph creator can register it on-chain. ` +
        `Creator=${owner}, current=${selfDid}`,
      );
    }

    // Check if already registered
    const cgMetaGraph = paranetMetaGraphUri(id);
    const paranetUri = `did:dkg:context-graph:${id}`;
    const statusResult = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
    );
    if (statusResult.type === 'bindings' && statusResult.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered') {
      const existingOnChainId = this.subscribedContextGraphs.get(id)?.onChainId;
      throw new Error(`Context graph "${id}" is already registered on-chain${existingOnChainId ? ` (${existingOnChainId})` : ''}`);
    }

    // Read existing description and access policy. Curated CGs store
    // definition in _meta rather than ONTOLOGY, so check both locations.
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const descResult = await this.store.query(
      `SELECT ?desc WHERE {
        { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc } }
        UNION
        { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc } }
      } LIMIT 1`,
    );
    const description = descResult.type === 'bindings' ? descResult.bindings[0]?.['desc']?.replace(/^"|"$/g, '') : undefined;

    let resolvedAccessPolicy = opts?.accessPolicy;
    if (resolvedAccessPolicy === undefined) {
      const apResult = await this.store.query(
        `SELECT ?ap WHERE {
          { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
          UNION
          { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
        } LIMIT 1`,
      );
      const apValue = apResult.type === 'bindings' ? apResult.bindings[0]?.['ap']?.replace(/^"|"$/g, '') : undefined;
      resolvedAccessPolicy = apValue === 'private' ? 1 : 0;

      // A CG created with allowedPeers but no explicit accessPolicy stores
      // "public" in the ontology graph. Detect the allowlist and promote to
      // private so the on-chain policy matches the curator's intent.
      if (resolvedAccessPolicy === 0) {
        const peers = await this.getContextGraphAllowedPeers(id);
        if (peers !== null && peers.length > 0) {
          resolvedAccessPolicy = 1;
        }
      }
    }

    const participantsResult = await this.store.query(
      `SELECT ?identityId WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?identityId } }`,
    );
    const participantIdentityIds = participantsResult.type === 'bindings'
      ? participantsResult.bindings
          .map((binding) => binding['identityId']?.replace(/^"|"$/g, ''))
          .filter((value): value is string => !!value)
          .map((value) => BigInt(value))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .filter((value, index, arr) => index === 0 || value !== arr[index - 1])
      : [];

    const requiredSignaturesResult = await this.store.query(
      `SELECT ?required WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_PARANET}RequiredSignatures> ?required } } LIMIT 1`,
    );
    const storedRequiredSignatures = requiredSignaturesResult.type === 'bindings'
      ? Number(requiredSignaturesResult.bindings[0]?.['required']?.replace(/^"|"$/g, ''))
      : NaN;

    // Check if already registered on-chain (prevents duplicate minting)
    const existingOnChainId = await this.getContextGraphOnChainId(id);
    if (existingOnChainId) {
      this.log.info(ctx, `Context graph "${id}" already has on-chain ID ${existingOnChainId} — skipping chain call`);
      await this.store.deleteByPattern({
        graph: cgMetaGraph,
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
      });
      await this.store.insert([
        { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
      ]);
      return { onChainId: existingOnChainId, txHash: undefined };
    }

    let effectiveParticipantIdentityIds = participantIdentityIds;
    if (effectiveParticipantIdentityIds.length === 0) {
      const selfIdentityId = await this.ensureIdentity();
      if (selfIdentityId === 0n) {
        throw new Error(
          `Context graph "${id}" cannot be registered on-chain without an on-chain identity. ` +
          'Create/ensure the curator identity first.',
        );
      }
      effectiveParticipantIdentityIds = [selfIdentityId];
    }

    const effectiveRequiredSignatures = Number.isInteger(storedRequiredSignatures) && storedRequiredSignatures > 0
      ? storedRequiredSignatures
      : 1;

    const result = await this.registerContextGraphOnChain({
      participantIdentityIds: effectiveParticipantIdentityIds,
      requiredSignatures: effectiveRequiredSignatures,
      publishPolicy: resolvedAccessPolicy,
    });
    const onChainId = result.contextGraphId.toString();

    this.log.info(ctx, `Context graph "${id}" registered on-chain: ${onChainId}`);

    // Update _meta with registered status and on-chain ID
    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: paranetUri,
      predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS,
    });
    await this.store.insert([
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REGISTRATION_STATUS, object: `"registered"`, graph: cgMetaGraph },
      { subject: paranetUri, predicate: `${DKG_ONTOLOGY.DKG_PARANET}OnChainId`, object: `"${onChainId}"`, graph: ontologyGraph },
    ]);

    // Update in-memory subscription record and ensure we're subscribed
    const sub = this.subscribedContextGraphs.get(id);
    if (sub) {
      sub.onChainId = onChainId;
      if (!sub.subscribed) {
        sub.subscribed = true;
        this.subscribeToContextGraph(id, { trackSyncScope: true });
        this.log.info(ctx, `Subscribed to newly registered context graph "${id}"`);
      }
    }

    // Registration status is in _meta — it propagates to peers via sync, not
    // gossip, so that only the authenticated sync path can update it.
    // Broadcast the ontology-graph OnChainId quad so peers see the link.
    try {
      const onChainNquad = `<${paranetUri}> <${DKG_ONTOLOGY.DKG_PARANET}OnChainId> "${onChainId}" <${ontologyGraph}> .`;
      const ontologyTopic = paranetPublishTopic(SYSTEM_PARANETS.ONTOLOGY);
      const regMsg = encodePublishRequest({
        ual: `did:dkg:context-graph:${id}`,
        nquads: new TextEncoder().encode(onChainNquad),
        paranetId: SYSTEM_PARANETS.ONTOLOGY,
        kas: [],
        publisherIdentity: this.wallet.keypair.publicKey,
        publisherAddress: '',
        startKAId: 0,
        endKAId: 0,
        chainId: '',
        publisherSignatureR: new Uint8Array(0),
        publisherSignatureVs: new Uint8Array(0),
      });
      await this.gossip.publish(ontologyTopic, regMsg);
    } catch (err) {
      this.log.debug(ctx, `Registration gossip broadcast failed (peers may not be subscribed yet): ${err instanceof Error ? err.message : String(err)}`);
    }

    return { onChainId };
  }

  /**
   * Invite a peer to join an existing context graph.
   * Adds the peer to the local allowlist in `_meta`.
   */
  async inviteToContextGraph(contextGraphId: string, peerId: string): Promise<void> {
    const ctx = createOperationContext('system');

    // Validate peer ID format (libp2p Ed25519 base58btc, e.g. 12D3KooW…)
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      peerIdFromString(peerId);
    } catch {
      throw new Error(`Invalid peer ID format: "${peerId}". Expected a libp2p peer ID (e.g. 12D3KooW…).`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    // Only the curator/creator can manage the allowlist
    const owner = await this.getContextGraphOwner(contextGraphId);
    const selfDid = `did:dkg:agent:${this.peerId}`;
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    if (owner !== selfDid) {
      throw new Error(
        `Only the context graph creator can manage invitations. ` +
        `Creator=${owner}, current=${selfDid}`,
      );
    }

    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = `did:dkg:context-graph:${contextGraphId}`;
    const escapedPeerId = escapeSparqlLiteral(peerId);

    const existingAllowlist = await this.getContextGraphAllowedPeers(contextGraphId);
    const quadsToInsert: Quad[] = [];

    // If this is the first allowlist entry (CG was open), also add our own
    // peer ID so the curator doesn't lock themselves out.
    if (existingAllowlist === null || existingAllowlist.length === 0) {
      const curatorPeerId = escapeSparqlLiteral(this.peerId);
      quadsToInsert.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
        object: `"${curatorPeerId}"`,
        graph: cgMetaGraph,
      });
    }

    // Skip if already in the allowlist (idempotent)
    if (existingAllowlist?.includes(peerId)) {
      this.log.info(ctx, `Peer ${peerId} already in allowlist for "${contextGraphId}" — skipping`);
      return;
    }

    quadsToInsert.push({
      subject: paranetUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_PEER,
      object: `"${escapedPeerId}"`,
      graph: cgMetaGraph,
    });

    await this.store.insert(quadsToInsert);

    // Allowlist updates are in _meta and propagate to peers via the
    // authenticated sync protocol, not unauthenticated gossip.

    this.log.info(ctx, `Invited peer ${peerId} to context graph "${contextGraphId}"`);
  }

  /**
   * Invite an agent (by Ethereum address) to join an existing context graph.
   * Adds the agent to the local allowlist in `_meta`.
   */
  async inviteAgentToContextGraph(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const ctx = createOperationContext('system');
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage invitations');

    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);
    const quadsToInsert: Quad[] = [];

    // If first allowlist entry, also add our own agent so the curator doesn't lock themselves out
    const existingParticipants = await this.getPrivateContextGraphParticipants(contextGraphId);
    if ((!existingParticipants || existingParticipants.length === 0) && this.defaultAgentAddress) {
      quadsToInsert.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${this.defaultAgentAddress}"`,
        graph: cgMetaGraph,
      });
    }

    quadsToInsert.push({
      subject: paranetUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress}"`,
      graph: cgMetaGraph,
    });

    await this.store.insert(quadsToInsert);

    this.log.info(ctx, `Invited agent ${agentAddress} to context graph "${contextGraphId}"`);
  }

  /**
   * Remove an agent from a context graph's allowlist.
   */
  async removeAgentFromContextGraph(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const ctx = createOperationContext('system');
    const ethAddrRe = /^0x[0-9a-fA-F]{40}$/;
    if (!ethAddrRe.test(agentAddress)) {
      throw new Error(`Invalid Ethereum address: "${agentAddress}".`);
    }

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) {
      throw new Error(`Context graph "${contextGraphId}" does not exist`);
    }

    const owner = await this.getContextGraphOwner(contextGraphId);
    if (!owner) {
      throw new Error(
        `Context graph "${contextGraphId}" has no known creator. ` +
        `Wait for sync to complete or create it locally first.`,
      );
    }
    this.assertCallerIsOwner(owner, callerAgentAddress, 'manage participants');

    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);

    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: paranetUri,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${agentAddress}"`,
    });

    this.log.info(ctx, `Removed agent ${agentAddress} from context graph "${contextGraphId}"`);
  }

  /**
   * List allowed agents for a context graph.
   */
  async getContextGraphAllowedAgents(contextGraphId: string): Promise<string[]> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          <${paranetUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent
        }
      }`,
    );
    if (result.type !== 'bindings') return [];
    return result.bindings
      .map((row) => (row as Record<string, string>)['agent'])
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.replace(/^"|"$/g, ''));
  }

  // ---------------------------------------------------------------------------
  // Join Request — signed request / approval flow for curated CGs
  // ---------------------------------------------------------------------------

  /**
   * Create a signed join request for a curated context graph.
   * The requesting agent signs `keccak256(contextGraphId ‖ agentAddress ‖ timestamp)`
   * with its custodial wallet, producing a verifiable proof of identity.
   */
  async signJoinRequest(
    contextGraphId: string,
    agentAddress?: string,
  ): Promise<{ contextGraphId: string; agentAddress: string; timestamp: number; signature: string }> {
    const addr = agentAddress ?? this.defaultAgentAddress;
    if (!addr) throw new Error('No agent address available');

    const agent = this.localAgents.get(addr);
    if (!agent?.privateKey) {
      throw new Error(`No private key for agent ${addr} — self-sovereign agents must sign externally`);
    }

    const timestamp = Date.now();
    const digest = ethers.solidityPackedKeccak256(
      ['string', 'string', 'uint256'],
      [contextGraphId, addr.toLowerCase(), timestamp],
    );
    const wallet = new ethers.Wallet(agent.privateKey);
    const signature = await wallet.signMessage(ethers.getBytes(digest));
    return { contextGraphId, agentAddress: addr, timestamp, signature };
  }

  /**
   * Verify a signed join request by recovering the signer address.
   * Returns the recovered Ethereum address if valid, throws on failure.
   */
  verifyJoinRequest(
    contextGraphId: string,
    agentAddress: string,
    timestamp: number,
    signature: string,
  ): string {
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
    if (Date.now() - timestamp > MAX_AGE_MS) {
      throw new Error('Join request expired');
    }
    const digest = ethers.solidityPackedKeccak256(
      ['string', 'string', 'uint256'],
      [contextGraphId, agentAddress.toLowerCase(), timestamp],
    );
    const recovered = ethers.verifyMessage(ethers.getBytes(digest), signature);
    if (recovered.toLowerCase() !== agentAddress.toLowerCase()) {
      throw new Error(`Signature mismatch: expected ${agentAddress}, recovered ${recovered}`);
    }
    return recovered;
  }

  /**
   * Store a pending join request in the CG's _meta graph.
   * The curator can later approve or reject it.
   */
  async storePendingJoinRequest(
    contextGraphId: string,
    agentAddress: string,
    signature: string,
    timestamp: number,
    agentName?: string,
  ): Promise<void> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const SCHEMA_NAME = 'https://schema.org/name';

    // Remove any prior pending request from this agent
    await this.store.deleteByPattern({ graph: cgMetaGraph, subject: requestUri });

    const quads: Quad[] = [
      { subject: requestUri, predicate: RDF_TYPE, object: `${DKG}JoinRequest`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}agentAddress`, object: `"${agentAddress}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}contextGraphId`, object: `"${contextGraphId}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}signature`, object: `"${signature}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestTimestamp`, object: `"${timestamp}"`, graph: cgMetaGraph },
      { subject: requestUri, predicate: `${DKG}requestStatus`, object: `"pending"`, graph: cgMetaGraph },
    ];
    if (agentName) {
      quads.push({ subject: requestUri, predicate: SCHEMA_NAME, object: `"${agentName}"`, graph: cgMetaGraph });
    }
    await this.store.insert(quads);
    const ctx = createOperationContext('system');
    this.log.info(ctx, `Stored pending join request from ${agentAddress} for "${contextGraphId}"`);
  }

  /**
   * List pending join requests for a context graph.
   */
  async listPendingJoinRequests(
    contextGraphId: string,
  ): Promise<Array<{ agentAddress: string; name?: string; signature: string; timestamp: number; status: string }>> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const DKG = 'https://dkg.network/ontology#';
    const result = await this.store.query(
      `SELECT ?addr ?name ?sig ?ts ?status WHERE {
        GRAPH <${cgMetaGraph}> {
          ?req a <${DKG}JoinRequest> ;
               <${DKG}agentAddress> ?addr ;
               <${DKG}signature> ?sig ;
               <${DKG}requestTimestamp> ?ts ;
               <${DKG}requestStatus> ?status .
          OPTIONAL { ?req <https://schema.org/name> ?name }
        }
      }`,
    );
    if (result.type !== 'bindings') return [];
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    return result.bindings.map((row) => ({
      agentAddress: strip(row['addr']),
      name: row['name'] ? strip(row['name']) : undefined,
      signature: strip(row['sig']),
      timestamp: parseInt(strip(row['ts']), 10) || 0,
      status: strip(row['status']),
    })).filter((r) => r.status === 'pending');
  }

  /**
   * Approve a pending join request: verify the signature, add the agent
   * to the allowlist, and mark the request as approved.
   */
  async approveJoinRequest(contextGraphId: string, agentAddress: string, callerAgentAddress?: string): Promise<void> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    // Fetch the stored request to verify the signature
    const result = await this.store.query(
      `SELECT ?sig ?ts WHERE {
        GRAPH <${cgMetaGraph}> {
          <${requestUri}> <${DKG}signature> ?sig ;
                          <${DKG}requestTimestamp> ?ts ;
                          <${DKG}requestStatus> "pending" .
        }
      } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      throw new Error(`No pending join request found from ${agentAddress}`);
    }
    const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '') ?? '';
    const signature = strip(result.bindings[0]['sig']);
    const timestamp = parseInt(strip(result.bindings[0]['ts']), 10) || 0;

    // Verify the signature (30-minute expiry is relaxed for approvals — curator may take time)
    const digest = ethers.solidityPackedKeccak256(
      ['string', 'string', 'uint256'],
      [contextGraphId, agentAddress.toLowerCase(), timestamp],
    );
    const recovered = ethers.verifyMessage(ethers.getBytes(digest), signature);
    if (recovered.toLowerCase() !== agentAddress.toLowerCase()) {
      throw new Error(`Signature verification failed: expected ${agentAddress}, recovered ${recovered}`);
    }

    // Add agent to allowlist
    await this.inviteAgentToContextGraph(contextGraphId, agentAddress, callerAgentAddress);

    // Mark request as approved
    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"approved"`,
      graph: cgMetaGraph,
    }]);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Approved join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so they can auto-subscribe
    this.notifyJoinApproval(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of approval: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the approved agent so their node
   * automatically retries the subscription.
   *
   * Delivers the message ONLY to the requester's peer, resolved via the
   * local agent registry. The earlier implementation broadcast to every
   * connected peer and relied on each recipient's handler to filter by
   * `agentAddress`. That leaked membership information for curated
   * context graphs: every peer on the P2P network learned that
   * `agentAddress` had just been invited to `contextGraphId`, which is
   * exactly the metadata a curated CG is supposed to hide.
   *
   * If the requester isn't in the local registry we fall back to a
   * best-effort dial through their relay address when available. We do
   * NOT broadcast in any case — the invitee will re-learn on their next
   * subscribe attempt if the direct notification fails.
   */
  private async notifyJoinApproval(contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-approved',
      contextGraphId,
      agentAddress,
    });
    return this.deliverPrivateJoinNotification(contextGraphId, agentAddress, payload, 'join-approval');
  }

  /**
   * Reject a pending join request.
   */
  async rejectJoinRequest(contextGraphId: string, agentAddress: string): Promise<void> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const requestUri = `did:dkg:join-request:${contextGraphId}:${agentAddress.toLowerCase()}`;
    const DKG = 'https://dkg.network/ontology#';

    await this.store.deleteByPattern({
      graph: cgMetaGraph,
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
    });
    await this.store.insert([{
      subject: requestUri,
      predicate: `${DKG}requestStatus`,
      object: `"rejected"`,
      graph: cgMetaGraph,
    }]);

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Rejected join request from ${agentAddress} for "${contextGraphId}"`);

    // Notify the requester via P2P so their UI can flip from the stale
    // "Join request sent, awaiting approval" state to a clear denied
    // state. Non-fatal: if the invitee is unreachable they'll just
    // re-learn on their next subscribe attempt.
    this.notifyJoinRejection(contextGraphId, agentAddress).catch((err) => {
      this.log.warn(ctx, `Failed to notify ${agentAddress} of rejection: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Send a P2P notification to the rejected agent. Same privacy model
   * as `notifyJoinApproval` — delivered only to the rejectee's peer,
   * never broadcast. See that method's doc comment for rationale.
   */
  private async notifyJoinRejection(contextGraphId: string, agentAddress: string): Promise<void> {
    const payload = JSON.stringify({
      type: 'join-rejected',
      contextGraphId,
      agentAddress,
    });
    return this.deliverPrivateJoinNotification(contextGraphId, agentAddress, payload, 'join-rejection');
  }

  /**
   * Resolve the target agent's peer ID and send the payload only to that
   * peer. Never broadcasts — leaking a curated CG's membership to every
   * peer on the network is a real privacy violation, and dropping the
   * notification is a far milder failure (the invitee relearns on next
   * subscribe).
   *
   * Two resolution sources, in order:
   *
   *   1. `joinRequestOriginPeers` — the peer that actually delivered the
   *      original join request over P2P. Set by the handler at register
   *      time and persists for the curator's process lifetime. This
   *      avoids a regression from the old broadcast implementation: the
   *      requester may reach us via P2P before their agent profile is
   *      indexed locally, so relying on `findAgents()` alone would drop
   *      every approval/rejection until registry replication catches up.
   *   2. `discovery.findAgents()` fallback for the case where the
   *      curator restarted between receiving the request and acting on
   *      it (and thus lost the in-memory peer mapping).
   *
   * @returns void (logged success/failure; callers treat this as
   *          fire-and-forget)
   */
  private async deliverPrivateJoinNotification(
    contextGraphId: string,
    agentAddress: string,
    payload: string,
    label: 'join-approval' | 'join-rejection',
  ): Promise<void> {
    const payloadBytes = new TextEncoder().encode(payload);
    const ctx = createOperationContext('system');
    const addrLower = agentAddress.toLowerCase();

    let targetPeerId: string | null = null;
    let targetRelayAddress: string | undefined;

    // Preferred source: the peer that actually delivered the join
    // request. This is always correct for the common flow and doesn't
    // depend on registry replication timing.
    const originKey = `${contextGraphId}::${addrLower}`;
    const rememberedPeerId = this.joinRequestOriginPeers.get(originKey);
    if (rememberedPeerId) {
      targetPeerId = rememberedPeerId;
    } else {
      // Fallback: agent registry (covers curator-restart case).
      try {
        const agents = await this.discovery.findAgents();
        const match = agents.find((a) => a.agentAddress?.toLowerCase() === addrLower);
        if (match) {
          targetPeerId = match.peerId;
          targetRelayAddress = match.relayAddress;
        }
      } catch {
        // Registry unavailable — we'll just skip delivery below.
      }
    }

    if (!targetPeerId) {
      this.log.warn(
        ctx,
        `Cannot deliver ${label} for "${contextGraphId}" to ${agentAddress} — no origin peer remembered and agent not in local registry. ` +
          `Dropping notification (invitee will re-learn on next subscribe).`,
      );
      return;
    }

    if (targetPeerId === this.peerId) {
      this.log.info(ctx, `Skipping ${label} to ${agentAddress}: target is this node`);
      return;
    }

    // Ensure we actually have a path to the target before attempting to
    // send. If we're not connected and we have a relay hint from the
    // registry, try a circuit dial once.
    const hasConnection = this.node.libp2p
      .getConnections()
      .some((c) => c.remotePeer.toString() === targetPeerId);
    if (!hasConnection && targetRelayAddress) {
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const { multiaddr } = await import('@multiformats/multiaddr');
        const circuitAddr = multiaddr(`${targetRelayAddress}/p2p-circuit/p2p/${targetPeerId}`);
        const pid = peerIdFromString(targetPeerId);
        await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
        await this.node.libp2p.dial(pid);
      } catch (dialErr) {
        this.log.warn(
          ctx,
          `Could not dial ${targetPeerId} via relay for ${label} notification: ` +
            (dialErr instanceof Error ? dialErr.message : String(dialErr)),
        );
      }
    }

    try {
      await this.router.send(targetPeerId, PROTOCOL_JOIN_REQUEST, payloadBytes, 5000);
      this.log.info(ctx, `Delivered ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId})`);
      // The join request is finalised now — forget the origin peer so
      // the map doesn't grow unbounded over the curator's lifetime.
      this.joinRequestOriginPeers.delete(originKey);
    } catch (err) {
      this.log.warn(
        ctx,
        `Could not deliver ${label} for "${contextGraphId}" to ${agentAddress} (${targetPeerId}): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /**
   * Forward a signed join request to all connected peers via P2P.
   * Used by the requesting node to deliver the request to the curator.
   * Returns the number of peers that accepted the request.
   */
  async forwardJoinRequest(
    contextGraphId: string,
    agentAddress: string,
    signature: string,
    timestamp: number,
    agentName?: string,
  ): Promise<{ delivered: number; errors: string[] }> {
    const payload = JSON.stringify({ contextGraphId, agentAddress, signature, timestamp, agentName });
    const payloadBytes = new TextEncoder().encode(payload);
    const peers = this.node.libp2p.getPeers();
    let delivered = 0;
    const errors: string[] = [];

    for (const pid of peers) {
      const remotePeerId = pid.toString();
      if (remotePeerId === this.peerId) continue;
      try {
        const responseBytes = await this.router.send(remotePeerId, PROTOCOL_JOIN_REQUEST, payloadBytes, 5000);
        const response = JSON.parse(new TextDecoder().decode(responseBytes));
        if (response.ok) {
          delivered++;
        } else if (response.error !== 'unknown CG') {
          errors.push(`${remotePeerId.slice(-8)}: ${response.error}`);
        }
      } catch {
        // Peer doesn't support protocol or timeout — skip
      }
    }

    const ctx = createOperationContext('system');
    this.log.info(ctx, `Forwarded join request for "${contextGraphId}" from ${agentAddress}: ${delivered} curator(s) received`);
    return { delivered, errors };
  }

  /**
   * Check whether a context graph has been registered on-chain.
   */
  async isContextGraphRegistered(contextGraphId: string): Promise<boolean> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?status WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status } } LIMIT 1`,
    );
    return result.type === 'bindings' && result.bindings[0]?.['status']?.replace(/^"|"$/g, '') === 'registered';
  }

  async getContextGraphOnChainId(contextGraphId: string): Promise<string | null> {
    const subscribed = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (subscribed) return subscribed;

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const paranetUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_PARANET}OnChainId> ?id } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    const value = result.bindings[0]?.['id'];
    return typeof value === 'string' ? value.replace(/^"|"$/g, '') : null;
  }

  /**
   * Get the peer allowlist for a context graph (if curated).
   * Returns null if no allowlist is set (open CG).
   */
  async getContextGraphAllowedPeers(contextGraphId: string): Promise<string[] | null> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const paranetUri = paranetDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?peer WHERE { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }
    return result.bindings
      .map(row => row['peer'])
      .filter((v): v is string => typeof v === 'string')
      .map(v => v.replace(/^"|"$/g, ''));
  }

  // ── Sub-Graph Management ───────────────────────────────────────────────

  /**
   * Create a named sub-graph within a context graph.
   * Registers it in the CG's `_meta` graph and creates the named graph in storage.
   * Sub-graphs use convention-based URI partitioning — no on-chain enforcement in V10.0.
   *
   * V10.0 replication behavior:
   * - Registration triples are stored locally by the admin. Peers also auto-register
   *   sub-graphs on gossip publish, SWM write, and finalization replay paths:
   *   `gossip-publish-handler.ts`, `workspace-handler.ts`, and
   *   `finalization-handler.ts` call `ensureSubGraph()` and backfill the full
   *   `_meta` registration when it is missing.
   * - Because `subGraphName` is carried on the wire (in the workspace publish request
   *   and the N-Quads' named-graph field), replicated data is routed into the correct
   *   sub-graph named graph on receiving nodes — not into the root data graph.
   * - On-chain contracts are unaware of sub-graphs; enforcement remains convention-based.
   */
  async createSubGraph(contextGraphId: string, subGraphName: string, opts?: {
    description?: string;
    authorizedWriters?: string[];
  }): Promise<{ uri: string }> {
    const { validateSubGraphName, contextGraphSubGraphUri: sgUri } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const exists = await this.contextGraphExists(contextGraphId);
    if (!exists) throw new Error(`Context graph "${contextGraphId}" does not exist`);

    const gm = new GraphManager(this.store);
    const uri = sgUri(contextGraphId, subGraphName);

    // Idempotency: check if already registered before inserting
    const existing = await this.listSubGraphs(contextGraphId);
    if (existing.some(sg => sg.name === subGraphName)) {
      this.log.info(
        createOperationContext('system'),
        `Sub-graph "${subGraphName}" already exists in context graph "${contextGraphId}" → ${uri}`,
      );
      return { uri };
    }

    const { generateSubGraphRegistration } = await import('@origintrail-official/dkg-publisher');
    const registrationQuads = generateSubGraphRegistration({
      contextGraphId,
      subGraphName,
      createdBy: this.peerId,
      authorizedWriters: opts?.authorizedWriters,
      description: opts?.description,
      timestamp: new Date(),
    });

    await gm.ensureSubGraph(contextGraphId, subGraphName);
    await this.store.insert(registrationQuads);

    this.log.info(
      createOperationContext('system'),
      `Created sub-graph "${subGraphName}" in context graph "${contextGraphId}" → ${uri}`,
    );
    return { uri };
  }

  /**
   * List registered sub-graphs for a context graph.
   * Queries the CG's `_meta` graph for `dkg:SubGraph` registrations.
   */
  async listSubGraphs(contextGraphId: string): Promise<Array<{
    uri: string;
    name: string;
    createdBy: string;
    createdAt?: string;
    description?: string;
  }>> {
    const { subGraphDiscoverySparql } = await import('@origintrail-official/dkg-publisher');
    const sparql = subGraphDiscoverySparql(contextGraphId);
    const result = await this.store.query(sparql);
    if (result.type !== 'bindings') return [];
    return result.bindings.map(row => ({
      uri: row['subGraph'] ?? '',
      name: stripLiteral(row['name'] ?? ''),
      createdBy: row['createdBy'] ?? '',
      createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
      description: row['description'] ? stripLiteral(row['description']) : undefined,
    }));
  }

  /**
   * Remove a sub-graph registration from `_meta` and drop its named graphs.
   * Does NOT delete on-chain data — this is a local bookkeeping operation.
   */
  async removeSubGraph(contextGraphId: string, subGraphName: string): Promise<void> {
    const { validateSubGraphName } = await import('@origintrail-official/dkg-core');
    const validation = validateSubGraphName(subGraphName);
    if (!validation.valid) throw new Error(`Invalid sub-graph name "${subGraphName}": ${validation.reason}`);

    const gm = new GraphManager(this.store);

    const { subGraphDeregistrationSparql } = await import('@origintrail-official/dkg-publisher');
    try {
      await this.store.query(subGraphDeregistrationSparql(contextGraphId, subGraphName));
    } catch {
      // SPARQL DELETE WHERE may not be supported — delete quads manually
      const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
      const subGraphUri = `did:dkg:context-graph:${contextGraphId}/${subGraphName}`;
      await this.store.deleteByPattern({ graph: metaGraph, subject: subGraphUri });
    }

    const dataUri = gm.subGraphUri(contextGraphId, subGraphName);
    const metaUri = gm.subGraphMetaUri(contextGraphId, subGraphName);
    const privateUri = gm.subGraphPrivateUri(contextGraphId, subGraphName);
    const swmUri = gm.sharedMemoryUri(contextGraphId, subGraphName);
    const swmMetaUri = gm.sharedMemoryMetaUri(contextGraphId, subGraphName);
    for (const uri of [dataUri, metaUri, privateUri, swmUri, swmMetaUri]) {
      try { await this.store.dropGraph(uri); } catch { /* graph may not exist */ }
    }

    // Drop assertion graphs under the sub-graph prefix
    const sgPrefix = `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/`;
    const allGraphs = await this.store.listGraphs();
    for (const g of allGraphs) {
      if (g.startsWith(sgPrefix)) {
        try { await this.store.dropGraph(g); } catch { /* graph may not exist */ }
      }
    }

    // Clear SWM ownership cache for this sub-graph
    const ownershipKey = `${contextGraphId}\0${subGraphName}`;
    this.publisher.clearSubGraphOwnership(ownershipKey);

    this.log.info(
      createOperationContext('system'),
      `Removed sub-graph "${subGraphName}" from context graph "${contextGraphId}"`,
    );
  }

  /**
   * Idempotent "ensure" variant of createContextGraph for boot-time defaults.
   * If the context graph already exists locally, just ensures GossipSub subscription
   * and registry entry. If not, inserts definition triples. No on-chain registration
   * — use {@link registerContextGraph} for that.
   *
   * For curated CGs (detected by access policy in existing triples, or by the
   * caller passing `curated: true`), definition triples are written to the CG's
   * own `_meta` graph — never to ONTOLOGY — so they don't leak to the network.
   */
  async ensureContextGraphLocal(opts: {
    id: string;
    name: string;
    description?: string;
    curated?: boolean;
  }): Promise<void> {
    const ctx = createOperationContext('system');

    const exists = await this.contextGraphExists(opts.id);
    if (exists) {
      this.subscribeToContextGraph(opts.id);
      this.subscribedContextGraphs.set(opts.id, {
        name: opts.name,
        subscribed: true,
        synced: true,
        metaSynced: true,
        onChainId: this.subscribedContextGraphs.get(opts.id)?.onChainId,
      });
      return;
    }

    const gm = new GraphManager(this.store);
    const paranetUri = paranetDataGraphUri(opts.id);
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(opts.id);
    const now = new Date().toISOString();

    // Curated CGs write definition triples to _meta so they stay invisible
    // to other nodes that sync ONTOLOGY. Open CGs go to ONTOLOGY for
    // network-wide discovery.
    const defGraph = opts.curated ? cgMetaGraph : ontologyGraph;

    const quads: Quad[] = [
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${paranetPublishTopic(opts.id)}"`, graph: defGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"full"`, graph: defGraph },
    ];

    if (opts.curated) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: `"private"`,
        graph: defGraph,
      });
    }

    if (opts.description) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: defGraph,
      });
    }

    await this.store.insert(quads);
    await gm.ensureParanet(opts.id);

    this.subscribeToContextGraph(opts.id);
    this.subscribedContextGraphs.set(opts.id, {
      name: opts.name,
      subscribed: true,
      synced: true,
      metaSynced: true,
    });

    this.log.info(ctx, `Ensured context graph "${opts.id}" locally (${opts.curated ? 'curated' : 'open'})`);
  }

  // ── ENDORSE ─���────────────────────────────────────────────────────────

  /**
   * Endorse a published Knowledge Asset. Publishes a `dkg:endorses` triple
   * to the Context Graph's data graph. Endorsements ride regular PUBLISH
   * batches — no separate chain transaction required.
   */
  async endorse(opts: {
    contextGraphId: string;
    knowledgeAssetUal: string;
    agentAddress?: string;
  }): Promise<PublishResult> {
    const { buildEndorsementQuads } = await import('./endorse.js');
    const quads = buildEndorsementQuads(
      this.peerId,
      opts.knowledgeAssetUal,
      opts.contextGraphId,
    );
    return this.publish(opts.contextGraphId, quads);
  }

  // ── VERIFY ────────────────────────────────────────────────────────

  /**
   * Propose verification for a published batch: collect M-of-N approvals,
   * anchor on-chain, and promote triples to Verified Memory.
   */
  async verify(opts: {
    contextGraphId: string;
    verifiedMemoryId: string;
    batchId: bigint;
    requiredSignatures?: number;
    timeoutMs?: number;
  }): Promise<{
    txHash: string;
    blockNumber: number;
    verifiedMemoryId: string;
    signers: string[];
  }> {
    const ctx = createOperationContext('verify');

    // 1. Look up batch merkle root from local metadata (use typed literal for batchId)
    const metaGraph = paranetMetaGraphUri(opts.contextGraphId);
    // Try typed literal first, fallback to untyped for backward compat
    let batchBindings: Record<string, string>[] | null = null;
    for (const literal of [`"${opts.batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${opts.batchId}"`]) {
      const r = await this.store.query(
        `SELECT ?root WHERE { GRAPH <${metaGraph}> { ?kc <https://dkg.network/ontology#merkleRoot> ?root . ?kc <https://dkg.network/ontology#batchId> ${literal} } } LIMIT 1`,
      );
      if (r.type === 'bindings' && r.bindings.length > 0) {
        batchBindings = r.bindings as Record<string, string>[];
        break;
      }
    }
    if (!batchBindings) {
      throw new Error(`Batch ${opts.batchId} not found in context graph ${opts.contextGraphId}`);
    }
    const rootHex = batchBindings[0]['root'];
    const merkleRoot = ethers.getBytes(rootHex.startsWith('"') ? rootHex.slice(1, -1) : rootHex);

    // 2. Look up context graph on-chain config
    const sub = this.subscribedContextGraphs.get(opts.contextGraphId);
    const contextGraphIdOnChain = sub?.onChainId ? BigInt(sub.onChainId) : null;
    if (!contextGraphIdOnChain) {
      throw new Error(`Context graph ${opts.contextGraphId} not found on-chain`);
    }

    // 3. Get required signatures from chain config or opts
    let requiredSignatures = opts.requiredSignatures ?? 0;
    if (requiredSignatures === 0 && typeof (this.chain as any).getContextGraphConfig === 'function') {
      try {
        const cgConfig = await (this.chain as any).getContextGraphConfig(contextGraphIdOnChain);
        const raw = cgConfig?.requiredSignatures;
        const parsed = raw != null ? Number(raw) : 0;
        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`getContextGraphConfig returned invalid requiredSignatures: ${raw} (must be a positive integer)`);
        }
        requiredSignatures = parsed;
      } catch (err: any) {
        throw new Error(
          `Cannot determine requiredSignatures for context graph ${contextGraphIdOnChain}: ${err?.message ?? err}. ` +
          `Pass opts.requiredSignatures explicitly or fix the chain adapter connection.`,
        );
      }
    }
    if (requiredSignatures === 0) {
      requiredSignatures = 1;
      this.log.warn(ctx, `requiredSignatures defaults to 1 — adapter does not implement getContextGraphConfig. ` +
        `For M-of-N context graphs, pass --required-signatures via CLI or requiredSignatures in the API body.`);
    }

    // 4. Sign the verify digest as proposer
    const signerKey = this.config.ackSignerKey
      ?? (typeof this.chain.getACKSignerKey === 'function' ? this.chain.getACKSignerKey() : undefined)
      ?? this.config.chainConfig?.operationalKeys?.[0];
    if (!signerKey) throw new Error('No signer key available for verify');

    const digest = computeACKDigest(contextGraphIdOnChain, merkleRoot);
    const prefixedHash = ethers.hashMessage(digest);
    const signingKey = new ethers.SigningKey(signerKey);
    const proposerSig = signingKey.sign(prefixedHash);
    const proposerAddress = ethers.computeAddress(signingKey.publicKey);

    // 5. Collect M-of-N approvals
    const collector = new VerifyCollector({
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => this.router.send(peerId, protocol, data),
      getParticipantPeers: (cgId?: string) => {
        const allPeers = this.node.libp2p.getPeers().map(p => p.toString()).filter(id => id !== this.peerId);
        // TODO: Filter by on-chain participant set once getContextGraphParticipants() is available.
        // Currently relies on signature recovery + identityId resolution to reject non-participants.
        return allPeers;
      },
      log: (msg: string) => this.log.info(ctx, msg),
    });

    const entities = await this.getRootEntities(opts.contextGraphId, opts.batchId);

    const result = await collector.collect({
      contextGraphId: opts.contextGraphId,
      contextGraphIdOnChain,
      verifiedMemoryId: (() => {
        try { return BigInt(opts.verifiedMemoryId); }
        catch { throw new Error(`verifiedMemoryId must be a numeric string, got: "${opts.verifiedMemoryId}"`); }
      })(),
      batchId: opts.batchId,
      merkleRoot,
      entities,
      proposerSignature: { r: ethers.getBytes(proposerSig.r), vs: ethers.getBytes(proposerSig.yParityAndS) },
      requiredSignatures,
      timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000, // 30 min default
    });

    // 6. Submit on-chain
    if (typeof this.chain.verify !== 'function') {
      throw new Error('Chain adapter does not support verify');
    }

    // 6. Resolve identity IDs for each approver before on-chain submission.
    const resolvedSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> = [
      {
        identityId: this.identityId,
        r: ethers.getBytes(proposerSig.r),
        vs: ethers.getBytes(proposerSig.yParityAndS),
      },
    ];
    for (const a of result.approvals) {
      let id = a.identityId;
      if ((!id || id === 0n) && typeof (this.chain as any).getIdentityIdForAddress === 'function') {
        try { id = await (this.chain as any).getIdentityIdForAddress(a.approverAddress); } catch { /* use 0n */ }
      }
      resolvedSignatures.push({ identityId: id, r: a.signatureR, vs: a.signatureVS });
    }
    if (resolvedSignatures.length < requiredSignatures) {
      throw new Error(`verify_identity_resolution: only ${resolvedSignatures.length}/${requiredSignatures} signers have resolvable identities (including proposer)`);
    }

    const txResult = await this.chain.verify({
      contextGraphId: contextGraphIdOnChain,
      batchId: opts.batchId,
      merkleRoot,
      signerSignatures: resolvedSignatures,
    });

    // 7. Promote triples to Verified Memory
    await this.promoteToVerifiedMemory(
      opts.contextGraphId,
      opts.verifiedMemoryId,
      opts.batchId,
      txResult.hash,
      txResult.blockNumber,
      [proposerAddress, ...result.approvals.map((a: { approverAddress: string }) => a.approverAddress)],
    );

    this.log.info(ctx, `Verified batch ${opts.batchId} → _verified_memory/${opts.verifiedMemoryId} (tx=${txResult.hash.slice(0, 16)}...)`);

    return {
      txHash: txResult.hash,
      blockNumber: txResult.blockNumber,
      verifiedMemoryId: opts.verifiedMemoryId,
      signers: [proposerAddress, ...result.approvals.map((a: { approverAddress: string }) => a.approverAddress)],
    };
  }

  private async promoteToVerifiedMemory(
    contextGraphId: string,
    verifiedMemoryId: string,
    batchId: bigint,
    txHash: string,
    blockNumber: number,
    signers: string[],
  ): Promise<void> {
    // Query only the triples belonging to this batch via root entities in _meta
    const rootEntities = await this.getRootEntities(contextGraphId, batchId);
    if (rootEntities.length === 0) {
      this.log.warn(createOperationContext('verify'), `No root entities found for batch ${batchId} — skipping VM promotion`);
      return;
    }
    const dataGraph = paranetDataGraphUri(contextGraphId);
    // Query root entities AND their skolemized children (subjects starting
    // with the root entity URI, e.g. <root>/.well-known/genid/...).
    // We use FILTER with STRSTARTS to capture the full closure instead of
    // an exact VALUES match, which would miss child/blank-node subjects.
    const filterClauses = rootEntities
      .map(e => `(STR(?s) = ${JSON.stringify(e)} || STRSTARTS(STR(?s), ${JSON.stringify(e + '/.well-known/genid/')}))`)
      .join(' || ');
    const result = await this.store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${dataGraph}> { ?s ?p ?o . FILTER(${filterClauses}) } }`,
    );
    if (result.type !== 'bindings') return;

    const vmGraph = contextGraphVerifiedMemoryUri(contextGraphId, verifiedMemoryId);
    const vmQuads: Quad[] = (result.bindings as Record<string, string>[]).map(row => ({
      subject: row['s'],
      predicate: row['p'],
      object: row['o'],
      graph: vmGraph,
    }));
    if (vmQuads.length > 0) {
      await this.store.insert(vmQuads);
    }

    // Write verification metadata
    const vmMetaGraph = contextGraphVerifiedMemoryMetaUri(contextGraphId, verifiedMemoryId);
    const metaQuads = buildVerificationMetadata({
      contextGraphId,
      verifiedMemoryId,
      batchId,
      txHash,
      blockNumber,
      signers,
      verifiedAt: new Date(),
      graph: vmMetaGraph,
    });
    await this.store.insert(metaQuads);
  }

  private async getRootEntities(contextGraphId: string, batchId: bigint): Promise<string[]> {
    const metaGraph = paranetMetaGraphUri(contextGraphId);
    // Try typed literal first, fallback to untyped for backward compat
    for (const literal of [`"${batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, `"${batchId}"`]) {
      const result = await this.store.query(
        `SELECT ?entity WHERE { GRAPH <${metaGraph}> { ?ka <https://dkg.network/ontology#rootEntity> ?entity . ?ka <https://dkg.network/ontology#batchId> ${literal} } }`,
      );
      if (result.type === 'bindings' && result.bindings.length > 0) {
        return (result.bindings as Record<string, string>[]).map(r => r['entity']).filter(Boolean);
      }
    }
    return [];
  }

  // ── CCL ──────────────────────────────────────────────────────────────

  async publishCclPolicy(opts: {
    paranetId: string;
    name: string;
    version: string;
    content: string;
    description?: string;
    contextType?: string;
    language?: string;
    format?: string;
  }): Promise<{ policyUri: string; hash: string; status: 'proposed' }> {
    const ctx = createOperationContext('system');
    if (!(await this.contextGraphExists(opts.paranetId))) {
      throw new Error(`Context Graph "${opts.paranetId}" does not exist. Create it first.`);
    }

    validateCclPolicy(opts.content, { expectedName: opts.name, expectedVersion: opts.version });

    const existing = (await this.listCclPolicies({ paranetId: opts.paranetId, name: opts.name }))
      .find(policy => policy.version === opts.version);
    const existingHash = existing?.hash;
    const nextHash = hashCclPolicy(opts.content);
    if (existingHash && existingHash !== nextHash) {
      throw new Error(`CCL policy ${opts.paranetId}/${opts.name}@${opts.version} already exists with different content`);
    }
    if (existing?.policyUri && existingHash === nextHash) {
      return { policyUri: existing.policyUri, hash: existing.hash, status: 'proposed' };
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const now = new Date().toISOString();
    const { policyUri, hash, quads } = buildCclPolicyQuads(opts, `did:dkg:agent:${this.peerId}`, ontologyGraph, now);
    await this.store.insert(quads);
    await this.publishOntologyQuads(policyUri, quads);
    this.log.info(ctx, `Published CCL policy ${opts.name}@${opts.version} for paranet "${opts.paranetId}"`);
    return { policyUri, hash, status: 'proposed' };
  }

  async approveCclPolicy(opts: {
    paranetId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; approvedAt: string }> {
    const ctx = createOperationContext('system');
    await this.assertParanetOwner(opts.paranetId);
    const record = await this.getCclPolicyByUri(opts.policyUri, { includeBody: true });
    if (!record) throw new Error(`CCL policy not found: ${opts.policyUri}`);
    if (record.paranetId !== opts.paranetId) {
      throw new Error(`CCL policy ${opts.policyUri} belongs to paranet "${record.paranetId}", not "${opts.paranetId}"`);
    }
    if (record.contextType && opts.contextType && record.contextType !== opts.contextType) {
      throw new Error(`CCL policy contextType mismatch: policy=${record.contextType}, requested=${opts.contextType}`);
    }
    if (!record.body) throw new Error(`CCL policy body missing: ${opts.policyUri}`);
    validateCclPolicy(record.body, { expectedName: record.name, expectedVersion: record.version });

    // Guard against duplicate approvals for the same policy+scope
    const existingBindings = await this.listCclPolicyBindings({ paranetId: opts.paranetId, name: record.name });
    const activeForScope = existingBindings.find(
      b => b.policyUri === opts.policyUri && b.status === 'approved' &&
           (b.contextType ?? '') === (opts.contextType ?? record.contextType ?? ''),
    );
    if (activeForScope) {
      return { policyUri: opts.policyUri, bindingUri: activeForScope.bindingUri, contextType: activeForScope.contextType, approvedAt: activeForScope.approvedAt };
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const approvedAt = new Date().toISOString();
    const effectiveContextType = opts.contextType ?? record.contextType;
    const { bindingUri, quads } = buildPolicyApprovalQuads({
      paranetId: opts.paranetId,
      policyUri: opts.policyUri,
      policyName: record.name,
      creator: `did:dkg:agent:${this.peerId}`,
      graph: ontologyGraph,
      approvedAt,
      contextType: effectiveContextType,
    });

    quads.push(
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_POLICY_STATUS, object: sparqlString('approved'), graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_BY, object: `did:dkg:agent:${this.peerId}`, graph: ontologyGraph },
      { subject: opts.policyUri, predicate: DKG_ONTOLOGY.DKG_APPROVED_AT, object: sparqlString(approvedAt), graph: ontologyGraph },
    );

    await this.store.insert(quads);
    await this.publishOntologyQuads(bindingUri, quads);
    this.log.info(ctx, `Approved CCL policy ${record.name}@${record.version} for paranet "${opts.paranetId}"${effectiveContextType ? ` (context ${effectiveContextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri, contextType: effectiveContextType, approvedAt };
  }

  async revokeCclPolicy(opts: {
    paranetId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<{ policyUri: string; bindingUri: string; contextType?: string; revokedAt: string; status: 'revoked' }> {
    const ctx = createOperationContext('system');
    await this.assertParanetOwner(opts.paranetId);

    const target = await this.getActiveCclPolicyBinding({
      paranetId: opts.paranetId,
      policyUri: opts.policyUri,
      contextType: opts.contextType,
    });
    if (!target) {
      throw new Error(`No active CCL policy binding found for ${opts.policyUri} in paranet "${opts.paranetId}"${opts.contextType ? ` and context "${opts.contextType}"` : ''}.`);
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const revokedAt = new Date().toISOString();
    const quads = buildPolicyRevocationQuads({
      bindingUri: target.bindingUri,
      revoker: `did:dkg:agent:${this.peerId}`,
      graph: ontologyGraph,
      revokedAt,
      paranetUri: `did:dkg:context-graph:${opts.paranetId}`,
    });

    await this.store.insert(quads);
    await this.publishOntologyQuads(target.bindingUri, quads);
    this.log.info(ctx, `Revoked CCL policy binding ${target.bindingUri} for paranet "${opts.paranetId}"${target.contextType ? ` (context ${target.contextType})` : ''}`);
    return { policyUri: opts.policyUri, bindingUri: target.bindingUri, contextType: target.contextType, revokedAt, status: 'revoked' };
  }

  async listCclPolicies(opts: {
    paranetId?: string;
    name?: string;
    contextType?: string;
    status?: string;
    includeBody?: boolean;
  } = {}): Promise<CclPolicyRecord[]> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.paranetId) filters.push(`?paranet = <did:dkg:context-graph:${opts.paranetId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const bodyClause = opts.includeBody ? `OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_BODY}> ?body }` : '';

    const result = await this.store.query(`
      SELECT ?policy ?paranet ?name ?version ?hash ?language ?format ?status ?creator ?created ?approvedBy ?approvedAt ?desc ?contextType ${opts.includeBody ? '?body' : ''} WHERE {
        GRAPH <${ontologyGraph}> {
          ?policy <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_POLICY}> ;
                  <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_PARANET}> ?paranet ;
                  <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                  <${DKG_ONTOLOGY.DKG_POLICY_VERSION}> ?version ;
                  <${DKG_ONTOLOGY.DKG_POLICY_HASH}> ?hash ;
                  <${DKG_ONTOLOGY.DKG_POLICY_LANGUAGE}> ?language ;
                  <${DKG_ONTOLOGY.DKG_POLICY_FORMAT}> ?format ;
                  <${DKG_ONTOLOGY.DKG_POLICY_STATUS}> ?status .
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
          OPTIONAL { ?policy <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${bodyClause}
          ${filterBlock}
        }
      }
      ORDER BY ?name ?version
    `);

    const bindings = await this.listCclPolicyBindings({ paranetId: opts.paranetId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);

    const records = new Map<string, CclPolicyRecord>();
    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const paranetUri = row['paranet'];
        const paranetId = paranetUri.startsWith('did:dkg:context-graph:') ? paranetUri.slice('did:dkg:context-graph:'.length) : paranetUri;
        const name = stripLiteral(row['name']);
        const defaultActive = latestByScope.get(`${paranetId}|${name}|`);
        const activeContexts = Array.from(latestByScope.values())
          .filter(binding => binding.paranetId === paranetId && binding.name === name && binding.contextType && binding.policyUri === row['policy'])
          .map(binding => binding.contextType as string)
          .sort();
        const nextRecord: CclPolicyRecord = {
          policyUri: row['policy'],
          paranetId,
          name,
          version: stripLiteral(row['version']),
          hash: stripLiteral(row['hash']),
          language: stripLiteral(row['language']),
          format: stripLiteral(row['format']),
          status: this.deriveCclPolicyStatus(row['policy'], stripLiteral(row['status']), bindings, latestByScope),
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          approvedBy: row['approvedBy'],
          approvedAt: row['approvedAt'] ? stripLiteral(row['approvedAt']) : undefined,
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          body: row['body'] ? stripLiteral(row['body']) : undefined,
          isActiveDefault: defaultActive?.policyUri === row['policy'],
          activeContexts,
        };

        const current = records.get(row['policy']);
        if (!current || (current.status !== 'approved' && nextRecord.status === 'approved')) {
          records.set(row['policy'], nextRecord);
        }
      }
    }

    return Array.from(records.values())
      .filter(record => !opts.status || record.status === opts.status)
      .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  }

  async resolveCclPolicy(opts: {
    paranetId: string;
    name: string;
    contextType?: string;
    includeBody?: boolean;
  }): Promise<CclPolicyRecord | null> {
    const bindings = await this.listCclPolicyBindings({ paranetId: opts.paranetId, name: opts.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const selected = this.resolveCclPolicyBinding(latestByScope, opts.paranetId, opts.name, opts.contextType);
    if (!selected) return null;
    const record = await this.getCclPolicyByUri(selected.policyUri, { includeBody: opts.includeBody });
    if (!record) return null;
    record.isActiveDefault = !selected.contextType;
    record.activeContexts = selected.contextType ? [selected.contextType] : record.activeContexts;
    return record;
  }

  async resolveFactsFromSnapshot(opts: {
    paranetId: string;
    snapshotId?: string;
    view?: string;
    scopeUal?: string;
    policyName?: string;
    contextType?: string;
  }): Promise<{
    facts: CclFactTuple[];
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: 'snapshot-resolved';
    context: {
      paranetId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
  }> {
    return resolveFactsFromSnapshot(this.store, opts);
  }

  async evaluateCclPolicy(opts: {
    paranetId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    policy: Pick<CclPolicyRecord, 'policyUri' | 'paranetId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
    context: {
      paranetId: string;
      contextType?: string;
      view?: string;
      snapshotId?: string;
      scopeUal?: string;
    };
    factSetHash: string;
    factQueryHash: string;
    factResolverVersion: string;
    factResolutionMode: CclFactResolutionMode;
    result: CclEvaluationResult;
  }> {
    const policy = await this.resolveCclPolicy({
      paranetId: opts.paranetId,
      name: opts.name,
      contextType: opts.contextType,
      includeBody: true,
    });
    if (!policy?.body) {
      throw new Error(`No approved policy found for ${opts.paranetId}/${opts.name}${opts.contextType ? `/${opts.contextType}` : ''}`);
    }

    const parsed = parseCclPolicy(policy.body);
    const factInput = opts.facts
      ? buildManualCclFacts(opts.facts)
      : await this.resolveFactsFromSnapshot({
          paranetId: opts.paranetId,
          snapshotId: opts.snapshotId,
          view: opts.view,
          scopeUal: opts.scopeUal,
          policyName: policy.name,
          contextType: opts.contextType ?? policy.contextType,
        });
    const evaluator = new CclEvaluator(parsed, factInput.facts);
    const result = evaluator.run();

    return {
      policy: {
        policyUri: policy.policyUri,
        paranetId: policy.paranetId,
        name: policy.name,
        version: policy.version,
        hash: policy.hash,
        language: policy.language,
        format: policy.format,
        contextType: opts.contextType ?? policy.contextType,
      },
      context: {
        paranetId: opts.paranetId,
        contextType: opts.contextType,
        view: opts.view,
        snapshotId: opts.snapshotId,
        scopeUal: opts.scopeUal,
      },
      factSetHash: factInput.factSetHash,
      factQueryHash: factInput.factQueryHash,
      factResolverVersion: factInput.factResolverVersion,
      factResolutionMode: factInput.factResolutionMode,
      result,
    };
  }

  async evaluateAndPublishCclPolicy(opts: {
    paranetId: string;
    name: string;
    facts?: CclFactTuple[];
    contextType?: string;
    view?: string;
    snapshotId?: string;
    scopeUal?: string;
  }): Promise<{
    evaluationUri: string;
    publish: PublishResult;
    evaluation: {
      policy: Pick<CclPolicyRecord, 'policyUri' | 'paranetId' | 'name' | 'version' | 'hash' | 'language' | 'format' | 'contextType'>;
      context: {
        paranetId: string;
        contextType?: string;
        view?: string;
        snapshotId?: string;
        scopeUal?: string;
      };
      factSetHash: string;
      factQueryHash: string;
      factResolverVersion: string;
      factResolutionMode: CclFactResolutionMode;
      result: CclEvaluationResult;
    };
  }> {
    const evaluation = await this.evaluateCclPolicy(opts);
    const graph = paranetDataGraphUri(opts.paranetId);
    const { evaluationUri, quads } = buildCclEvaluationQuads({
      paranetId: opts.paranetId,
      policyUri: evaluation.policy.policyUri,
      factSetHash: evaluation.factSetHash,
      factQueryHash: evaluation.factQueryHash,
      factResolverVersion: evaluation.factResolverVersion,
      factResolutionMode: evaluation.factResolutionMode,
      result: evaluation.result,
      evaluatedAt: new Date().toISOString(),
      view: evaluation.context.view,
      snapshotId: evaluation.context.snapshotId,
      scopeUal: evaluation.context.scopeUal,
      contextType: evaluation.context.contextType,
    }, graph);
    const publish = await this.publish(opts.paranetId, quads);
    return { evaluationUri, publish, evaluation };
  }

  async listCclEvaluations(opts: {
    paranetId: string;
    policyUri?: string;
    snapshotId?: string;
    view?: string;
    contextType?: string;
    resultKind?: 'derived' | 'decision';
    resultName?: string;
  }): Promise<CclPublishedEvaluationRecord[]> {
    const graph = paranetDataGraphUri(opts.paranetId);
    const filters: string[] = [];
    if (opts.policyUri) filters.push(`?policy = <${opts.policyUri}>`);
    if (opts.snapshotId) filters.push(`?snapshotId = ${sparqlString(opts.snapshotId)}`);
    if (opts.view) filters.push(`?view = ${sparqlString(opts.view)}`);
    if (opts.contextType) filters.push(`?contextType = ${sparqlString(opts.contextType)}`);
    if (opts.resultKind) filters.push(`?kind = ${sparqlString(opts.resultKind)}`);
    if (opts.resultName) filters.push(`?resultName = ${sparqlString(opts.resultName)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';

    const result = await this.store.query(`
      SELECT ?evaluation ?policy ?factSetHash ?factQueryHash ?factResolverVersion ?factResolutionMode ?createdAt ?view ?snapshotId ?scopeUal ?contextType ?entry ?kind ?resultName ?arg ?argIndex ?argValue WHERE {
        GRAPH <${graph}> {
          ?evaluation <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CCL_EVALUATION}> ;
                      <${DKG_ONTOLOGY.DKG_EVALUATED_POLICY}> ?policy ;
                      <${DKG_ONTOLOGY.DKG_FACT_SET_HASH}> ?factSetHash .
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_QUERY_HASH}> ?factQueryHash }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLVER_VERSION}> ?factResolverVersion }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_FACT_RESOLUTION_MODE}> ?factResolutionMode }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?createdAt }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_VIEW}> ?view }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SNAPSHOT_ID}> ?snapshotId }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_SCOPE_UAL}> ?scopeUal }
          OPTIONAL { ?evaluation <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          OPTIONAL {
            ?evaluation <${DKG_ONTOLOGY.DKG_HAS_RESULT}> ?entry .
            ?entry <${DKG_ONTOLOGY.DKG_RESULT_KIND}> ?kind ;
                   <${DKG_ONTOLOGY.DKG_RESULT_NAME}> ?resultName .
            OPTIONAL {
              ?entry <${DKG_ONTOLOGY.DKG_HAS_RESULT_ARG}> ?arg .
              ?arg <${DKG_ONTOLOGY.DKG_RESULT_ARG_INDEX}> ?argIndex ;
                   <${DKG_ONTOLOGY.DKG_RESULT_ARG_VALUE}> ?argValue .
            }
          }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?createdAt) ?evaluation ?kind ?resultName ?argIndex
    `);

    if (result.type !== 'bindings') return [];
    const records = new Map<string, CclPublishedEvaluationRecord>();
    const entryArgs = new Map<string, Map<number, unknown>>();
    for (const row of result.bindings as Record<string, string>[]) {
      const evaluationUri = row['evaluation'];
      let record = records.get(evaluationUri);
      if (!record) {
        record = {
          evaluationUri,
          policyUri: row['policy'],
          factSetHash: stripLiteral(row['factSetHash']),
          factQueryHash: row['factQueryHash'] ? stripLiteral(row['factQueryHash']) : undefined,
          factResolverVersion: row['factResolverVersion'] ? stripLiteral(row['factResolverVersion']) : undefined,
          factResolutionMode: row['factResolutionMode'] ? stripLiteral(row['factResolutionMode']) as CclFactResolutionMode : undefined,
          createdAt: row['createdAt'] ? stripLiteral(row['createdAt']) : undefined,
          view: row['view'] ? stripLiteral(row['view']) : undefined,
          snapshotId: row['snapshotId'] ? stripLiteral(row['snapshotId']) : undefined,
          scopeUal: row['scopeUal'] ? stripLiteral(row['scopeUal']) : undefined,
          contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
          results: [],
        };
        records.set(evaluationUri, record);
      }

      if (row['entry']) {
        const entryUri = row['entry'];
        let existing = record.results.find(resultEntry => resultEntry.entryUri === entryUri);
        if (!existing) {
          existing = {
            entryUri,
            kind: stripLiteral(row['kind']) as 'derived' | 'decision',
            name: stripLiteral(row['resultName']),
            tuple: [],
          };
          record.results.push(existing);
        }

        if (row['arg'] && row['argIndex'] && row['argValue']) {
          let args = entryArgs.get(entryUri);
          if (!args) {
            args = new Map<number, unknown>();
            entryArgs.set(entryUri, args);
          }
          args.set(Number(stripLiteral(row['argIndex'])), JSON.parse(stripLiteral(row['argValue'])));
        }
      }
    }

    for (const record of records.values()) {
      for (const resultEntry of record.results) {
        const args = entryArgs.get(resultEntry.entryUri);
        if (args && args.size > 0) {
          resultEntry.tuple = [...args.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, value]) => value);
        }
      }
    }

    return Array.from(records.values());
  }

  /**
   * Check whether a context graph exists in local storage. Definition triples in
   * ONTOLOGY/_meta count, and storage-backed graph presence also counts so local
   * shared-memory-only survivors are not treated as nonexistent.
   */
  async contextGraphExists(contextGraphId: string): Promise<boolean> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?g WHERE {
        GRAPH ?g { <${contextGraphUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> }
      } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) {
      return true;
    }

    const graphManager = new GraphManager(this.store);
    const storedContextGraphs = await graphManager.listContextGraphs();
    return storedContextGraphs.includes(contextGraphId);
  }

  /**
   * Check whether the context graph has any actual content locally — i.e.,
   * at least one triple in the paranet's own data graph. A paranet declaration
   * triple in the ontology graph (from auto-discovery via chain registry or
   * ontology sync) does NOT count as content; it only indicates the paranet
   * was announced, not that we have access to its data. This predicate is
   * used to distinguish "genuinely synced / has access" from "declaration
   * only / probably denied".
   */
  async contextGraphHasLocalContent(contextGraphId: string): Promise<boolean> {
    const dataGraph = paranetDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `ASK WHERE { GRAPH <${dataGraph}> { ?s ?p ?o } }`,
    );
    if (result.type === 'boolean') return result.value;
    return result.type === 'bindings' && result.bindings.length > 0;
  }

  /**
   * Check whether a context graph is declared as curated (private/allowlist)
   * locally. Reads the DKG accessPolicy predicate from either the ontology
   * graph (public CGs) or the CG's _meta graph (curated CGs). Returns false
   * when no declaration is present locally (caller should treat that as
   * "unknown, assume public" — this predicate is only used to gate
   * optimistic denial inference, not access control decisions).
   */
  async contextGraphIsCurated(contextGraphId: string): Promise<boolean> {
    const paranetUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    try {
      const res = await this.store.query(
        `SELECT ?ap WHERE {
          { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
          UNION
          { GRAPH <${cgMetaGraph}> { <${paranetUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ap } }
        } LIMIT 1`,
      );
      if (res.type !== 'bindings' || res.bindings.length === 0) return false;
      const ap = res.bindings[0]?.['ap']?.replace(/^"|"$/g, '');
      return ap === 'private';
    } catch {
      return false;
    }
  }

  private parseSyncRequest(data: Uint8Array): SyncRequestEnvelope {
    const text = new TextDecoder().decode(data).trim();
    if (text.startsWith('{')) {
      let parsed: SyncRequestEnvelope;
      try {
        parsed = JSON.parse(text) as SyncRequestEnvelope;
      } catch {
        // Malformed JSON — fall through to pipe-delimited parsing
        return this.parsePipeDelimitedSyncRequest(text);
      }
      return {
        contextGraphId: parsed.contextGraphId,
        offset: parsed.offset ?? 0,
        limit: Math.min(parsed.limit ?? SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
        includeSharedMemory: parsed.includeSharedMemory ?? false,
        phase: parsed.phase === 'meta' ? 'meta' : 'data',
        targetPeerId: parsed.targetPeerId,
        requesterPeerId: parsed.requesterPeerId,
        requestId: parsed.requestId,
        issuedAtMs: parsed.issuedAtMs,
        requesterIdentityId: parsed.requesterIdentityId,
        requesterAgentAddress: parsed.requesterAgentAddress,
        requesterSignatureR: parsed.requesterSignatureR,
        requesterSignatureVS: parsed.requesterSignatureVS,
      };
    }

    return this.parsePipeDelimitedSyncRequest(text);
  }

  private parsePipeDelimitedSyncRequest(text: string): SyncRequestEnvelope {
    const parts = text.split('|');
    const ctxGraphPart = parts[0] || '';
    const includeSharedMemory = ctxGraphPart.startsWith('workspace:');
    const contextGraphId = includeSharedMemory ? ctxGraphPart.slice('workspace:'.length) : (ctxGraphPart || SYSTEM_PARANETS.AGENTS);
    return {
      contextGraphId,
      offset: parseInt(parts[1], 10) || 0,
      limit: Math.min(parseInt(parts[2], 10) || SYNC_PAGE_SIZE, SYNC_PAGE_SIZE),
      includeSharedMemory,
      phase: parts[3] === 'meta' ? 'meta' : 'data',
    };
  }

  private async buildSyncRequest(
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    responderPeerId: string,
    phase: 'data' | 'meta' = 'data',
  ): Promise<Uint8Array> {
    const isPrivate = await this.isPrivateContextGraph(contextGraphId);

    // If we don't have any local data for this CG yet (e.g. just subscribed
    // via invite), we can't determine the access policy. Send an
    // authenticated request so the remote peer can verify our identity
    // against its allowlist.
    const hasLocalData = this.subscribedContextGraphs.get(contextGraphId)?.synced === true;
    const needsAuth = isPrivate || !hasLocalData;

    if (!needsAuth) {
      const prefix = includeSharedMemory ? `workspace:${contextGraphId}` : contextGraphId;
      const phaseSuffix = phase === 'meta' ? '|meta' : '';
      return new TextEncoder().encode(`${prefix}|${offset}|${limit}${phaseSuffix}`);
    }

    const request: SyncRequestEnvelope = {
      contextGraphId,
      offset,
      limit,
      includeSharedMemory,
      phase,
    };

    request.targetPeerId = responderPeerId;
    request.requesterPeerId = this.peerId;
    request.requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    request.issuedAtMs = Date.now();

    const digest = this.computeSyncDigest(
      contextGraphId,
      offset,
      limit,
      includeSharedMemory,
      responderPeerId,
      request.requesterPeerId,
      request.requestId,
      request.issuedAtMs,
    );

    const identityId = await this.chain.getIdentityId();
    if (identityId > 0n && typeof this.chain.signMessage === 'function') {
      const signature = await this.chain.signMessage(digest);
      request.requesterIdentityId = identityId.toString();
      request.requesterSignatureR = ethers.hexlify(signature.r);
      request.requesterSignatureVS = ethers.hexlify(signature.vs);
    } else if (this.defaultAgentAddress) {
      const agent = this.localAgents.get(this.defaultAgentAddress);
      if (agent?.privateKey) {
        const wallet = new ethers.Wallet(agent.privateKey);
        const sig = ethers.Signature.from(await wallet.signMessage(digest));
        request.requesterIdentityId = '0';
        request.requesterAgentAddress = this.defaultAgentAddress;
        request.requesterSignatureR = ethers.hexlify(sig.r);
        request.requesterSignatureVS = ethers.hexlify(sig.yParityAndS);
      }
    }

    if (needsAuth && (!request.requesterSignatureR || !request.requesterSignatureVS)) {
      const signingTarget = this.defaultAgentAddress
        ? `default agent ${this.defaultAgentAddress}`
        : 'node identity';
      throw new Error(
        `Cannot build authenticated sync request for "${contextGraphId}": missing signing key for ${signingTarget}`,
      );
    }

    return new TextEncoder().encode(JSON.stringify(request));
  }

  private computeSyncDigest(
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    targetPeerId: string,
    requesterPeerId: string | undefined,
    requestId: string | undefined,
    issuedAtMs: number | undefined,
  ): Uint8Array {
    return ethers.getBytes(
      ethers.solidityPackedKeccak256(
        ['string', 'uint256', 'uint256', 'bool', 'string', 'string', 'string', 'uint256'],
        [
          contextGraphId,
          BigInt(offset),
          BigInt(limit),
          includeSharedMemory,
          targetPeerId,
          requesterPeerId ?? '',
          requestId ?? '',
          BigInt(issuedAtMs ?? 0),
        ],
      ),
    );
  }

  private async authorizeSyncRequest(request: SyncRequestEnvelope, remotePeerId: string): Promise<boolean> {
    const isPrivate = await this.isPrivateContextGraph(request.contextGraphId);
    if (!isPrivate) {
      return true;
    }

    const now = Date.now();
    for (const [requestId, seenAt] of this.seenPrivateSyncRequestIds) {
      if (now - seenAt > SYNC_AUTH_MAX_AGE_MS) {
        this.seenPrivateSyncRequestIds.delete(requestId);
      }
    }

    let requesterIdentityId = 0n;
    try { requesterIdentityId = request.requesterIdentityId ? BigInt(request.requesterIdentityId) : 0n; } catch { /* malformed — treated as unauthenticated */ }

    if (
      request.targetPeerId !== this.peerId ||
      request.requesterPeerId !== remotePeerId ||
      !request.requestId ||
      request.issuedAtMs == null ||
      now - request.issuedAtMs > SYNC_AUTH_MAX_AGE_MS ||
      now < request.issuedAtMs - 5000 ||
      !request.requesterSignatureR ||
      !request.requesterSignatureVS
    ) {
      return false;
    }

    if (this.seenPrivateSyncRequestIds.has(request.requestId)) {
      return false;
    }

    const digest = this.computeSyncDigest(
      request.contextGraphId,
      request.offset,
      request.limit,
      request.includeSharedMemory,
      request.targetPeerId,
      request.requesterPeerId,
      request.requestId,
      request.issuedAtMs,
    );

    let recoveredAddress: string;
    try {
      recoveredAddress = ethers.recoverAddress(ethers.hashMessage(digest), {
        r: request.requesterSignatureR,
        yParityAndS: request.requesterSignatureVS,
      });
    } catch {
      return false;
    }

    // Two auth paths:
    // 1. Core nodes (identityId > 0): verify on-chain identity owns the key
    // 2. Edge nodes (identityId = 0): wallet signature is sufficient —
    //    recovered address checked directly against allowlist
    if (requesterIdentityId > 0n) {
      const verifyIdentity = this.chain.verifySyncIdentity ?? this.chain.verifyACKIdentity;
      if (typeof verifyIdentity !== 'function') {
        return false;
      }
      const validIdentity = await verifyIdentity.call(this.chain, recoveredAddress, requesterIdentityId);
      if (!validIdentity) {
        return false;
      }
    } else if (!request.requesterAgentAddress ||
      recoveredAddress.toLowerCase() !== request.requesterAgentAddress.toLowerCase()) {
      return false;
    }

    const participants = await this.getPrivateContextGraphParticipants(request.contextGraphId);
    let allowed = participants?.some((p) =>
      p.toLowerCase() === recoveredAddress.toLowerCase() ||
      (requesterIdentityId > 0n && p === String(requesterIdentityId)),
    ) ?? false;

    // Legacy peer-ID allowlist: `inviteToContextGraph` (the path behind
    // `POST /api/context-graph/invite`) writes `DKG_ALLOWED_PEER` quads.
    // Honor them here so peer-ID invites actually unblock sync. The
    // libp2p transport has already authenticated `remotePeerId`, and we
    // validated `request.requesterPeerId === remotePeerId` above, so
    // matching the peer ID against the allowlist is a trusted comparison.
    if (!allowed) {
      const allowedPeers = await this.getContextGraphAllowedPeers(request.contextGraphId);
      if (allowedPeers?.includes(remotePeerId)) {
        allowed = true;
      }
    }

    // Requester has valid on-chain identity but is not in our local participant
    // list. The curator may have invited them after our last meta sync — try
    // refreshing the meta graph from the curator before denying.
    if (!allowed) {
      const refreshed = await this.refreshMetaFromCurator(request.contextGraphId);
      if (refreshed) {
        const freshParticipants = await this.getPrivateContextGraphParticipants(request.contextGraphId);
        allowed = freshParticipants?.some((p) =>
          p.toLowerCase() === recoveredAddress.toLowerCase() ||
          p === String(requesterIdentityId),
        ) ?? false;

        if (!allowed) {
          const freshPeers = await this.getContextGraphAllowedPeers(request.contextGraphId);
          if (freshPeers?.includes(remotePeerId)) {
            allowed = true;
          }
        }
      }
    }

    if (allowed) {
      this.seenPrivateSyncRequestIds.set(request.requestId, now);
    }
    return allowed;
  }

  private async isPrivateContextGraph(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_PARANETS) as string[]).includes(contextGraphId)) {
      return false;
    }

    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const result = await this.store.query(
      `SELECT ?policy WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        }
      } LIMIT 1`,
    );

    if (result.type === 'bindings' && result.bindings[0]?.['policy'] === '"private"') {
      return true;
    }

    // Also treat CGs with an allowlist as private, even if no explicit
    // access_policy triple exists (e.g. allowedAgents were set without
    // accessPolicy=1).
    const allowlistResult = await this.store.query(
      `ASK WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent
        }
      }`,
    );
    if (allowlistResult.type === 'boolean' && allowlistResult.value === true) {
      return true;
    }

    return false;
  }

  private async getPrivateContextGraphParticipants(contextGraphId: string): Promise<string[] | null> {
    const merged: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(value);
    };

    const localAgentParticipants = this.subscribedContextGraphs.get(contextGraphId)?.participantAgents;
    if (localAgentParticipants) {
      for (const p of localAgentParticipants) add(p);
    }

    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);

    // V10 agent model: allowedAgent triples (wallet addresses)
    const agentResult = await this.store.query(
      `SELECT ?agent WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent
        }
      }`,
    );
    if (agentResult.type === 'bindings') {
      for (const row of agentResult.bindings) {
        const raw = row['agent'];
        if (typeof raw === 'string') add(raw.replace(/^"|"$/g, ''));
      }
    }

    // Legacy identity model: participantIdentityIds (numeric IDs as strings)
    const metaResult = await this.store.query(
      `SELECT ?identityId WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}> ?identityId
        }
      }`,
    );
    if (metaResult.type === 'bindings') {
      for (const row of metaResult.bindings) {
        const raw = row['identityId'];
        if (typeof raw === 'string') add(raw.replace(/^"|"$/g, ''));
      }
    }

    if (merged.length > 0) return merged;

    // Fall back to on-chain participants (identity IDs as strings)
    const onChainId = this.subscribedContextGraphs.get(contextGraphId)?.onChainId;
    if (!onChainId || typeof this.chain.getContextGraphParticipants !== 'function') {
      return null;
    }
    const onChainParticipants = await this.chain.getContextGraphParticipants(BigInt(onChainId));
    if (!onChainParticipants) return null;
    return onChainParticipants.map((id) => String(id));
  }

  /**
   * Re-sync the meta graph for a private CG from the curator to pick up
   * newly added participants. Rate-limited to avoid abuse.
   * Returns true if meta was refreshed, false if skipped or failed.
   */
  private async resolveCuratorPeerId(contextGraphId: string): Promise<string | undefined> {
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const contextGraphUri = paranetDataGraphUri(contextGraphId);

    const curatorResult = await this.store.query(
      `SELECT ?curator WHERE {
        GRAPH <${cgMetaGraph}> {
          <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CURATOR}> ?curator
        }
      } LIMIT 1`,
    );
    if (curatorResult.type !== 'bindings' || curatorResult.bindings.length === 0) {
      return undefined;
    }
    const curatorDid = (curatorResult.bindings[0] as Record<string, string>)['curator'] ?? '';
    const didPrefix = 'did:dkg:agent:';
    if (!curatorDid.startsWith(didPrefix)) {
      return undefined;
    }
    const curatorIdentifier = curatorDid.slice(didPrefix.length);

    // Resolve curator identifier to a peer ID. The DID value is either a
    // libp2p peer ID (legacy) or an Ethereum wallet address (V10). For
    // wallet addresses, prefer the deterministic DKG_CREATOR triple (which
    // stores the libp2p peer ID) over the agent registry (which may return
    // an arbitrary match when multiple agents register the same wallet).
    let curatorPeerId = curatorIdentifier;
    if (curatorIdentifier.startsWith('0x')) {
      let resolved = false;

      // Preferred: look up the creator peer ID from the ontology definition
      // graph or the _meta graph. The dkg:creator triple uses the libp2p
      // peer ID while dkg:curator uses the wallet address.
      const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
      const creatorResult = await this.store.query(
        `SELECT ?creator WHERE {
          {
            GRAPH <${ontologyGraph}> {
              <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator
            }
          } UNION {
            GRAPH <${cgMetaGraph}> {
              <${contextGraphUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator
            }
          }
        } LIMIT 1`,
      );
      if (creatorResult.type === 'bindings' && creatorResult.bindings.length > 0) {
        const creatorDid = (creatorResult.bindings[0] as Record<string, string>)['creator'] ?? '';
        if (creatorDid.startsWith(didPrefix)) {
          const creatorId = creatorDid.slice(didPrefix.length);
          if (!creatorId.startsWith('0x')) {
            curatorPeerId = creatorId;
            resolved = true;
          }
        }
      }

      // Fallback: agent registry lookup (non-deterministic if multiple agents
      // share the same wallet address, but better than failing outright)
      if (!resolved) {
        try {
          const agents = await this.discovery.findAgents();
          const match = agents.find(
            (a) => a.agentAddress?.toLowerCase() === curatorIdentifier.toLowerCase(),
          );
          if (match) {
            curatorPeerId = match.peerId;
            resolved = true;
          }
        } catch { /* registry unavailable */ }
      }

      if (!resolved) return undefined;
    }

    return curatorPeerId;
  }

  private async refreshMetaFromCurator(contextGraphId: string): Promise<boolean> {
    const now = Date.now();
    const lastRefresh = this.metaRefreshTimestamps.get(contextGraphId) ?? 0;
    if (now - lastRefresh < META_REFRESH_COOLDOWN_MS) {
      return false;
    }

    const ctx = createOperationContext('sync');
    const cgMetaGraph = paranetMetaGraphUri(contextGraphId);
    const curatorPeerId = await this.resolveCuratorPeerId(contextGraphId);
    if (!curatorPeerId) {
      return false;
    }

    if (curatorPeerId === this.peerId) {
      return false;
    }

    let connections = this.node.libp2p.getConnections();
    let isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);

    // If not directly connected, try dialing — first a regular dial (the peer
    // store may already have direct multiaddrs), then via relay as fallback.
    if (!isConnected) {
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const pid = peerIdFromString(curatorPeerId);

        try {
          await this.node.libp2p.dial(pid);
          connections = this.node.libp2p.getConnections();
          isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);
        } catch { /* direct dial failed, try relay */ }

        if (!isConnected) {
          const agent = await this.discovery.findAgentByPeerId(curatorPeerId);
          if (agent?.relayAddress) {
            const { multiaddr } = await import('@multiformats/multiaddr');
            const circuitAddr = multiaddr(`${agent.relayAddress}/p2p-circuit/p2p/${curatorPeerId}`);
            await this.node.libp2p.peerStore.merge(pid, { multiaddrs: [circuitAddr] });
            await this.node.libp2p.dial(pid);
            connections = this.node.libp2p.getConnections();
            isConnected = connections.some((c) => c.remotePeer.toString() === curatorPeerId);
          }
        }
      } catch (err) {
        this.log.warn(ctx, `Failed to dial curator ${curatorPeerId.slice(-8)} for meta refresh: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!isConnected) {
      return false;
    }

    try {
      const deadline = Date.now() + 10_000;
      const metaQuads = await this.fetchSyncPages(ctx, curatorPeerId, contextGraphId, false, 'meta', cgMetaGraph, deadline);
      if (metaQuads.length > 0) {
        await this.store.insert(metaQuads);
        this.log.info(ctx, `Meta refresh for "${contextGraphId}": ${metaQuads.length} triples from curator ${curatorPeerId.slice(-8)}`);
        return true;
      }
      return false;
    } catch (err) {
      this.log.warn(ctx, `Meta refresh for "${contextGraphId}" failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.metaRefreshTimestamps.set(contextGraphId, now);
    }
  }

  /**
   * List all known context graphs by merging the subscription registry with
   * SPARQL-discovered definition triples. Returns enriched entries with
   * `subscribed` and `synced` flags.
   */
  async listContextGraphs(): Promise<Array<{
    id: string;
    uri: string;
    name: string;
    description?: string;
    creator?: string;
    createdAt?: string;
    isSystem: boolean;
    subscribed: boolean;
    synced: boolean;
  }>> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const agentsGraph = paranetDataGraphUri(SYSTEM_PARANETS.AGENTS);
    const result = await this.store.query(`
      SELECT ?ctxGraph ?name ?desc ?creator ?created ?isSystem WHERE {
        {
          GRAPH <${ontologyGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_PARANET}> . BIND(true AS ?isSystem) }
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_PARANET}> . BIND(true AS ?isSystem) }
          }
        }
      }
    `);

    const prefix = 'did:dkg:context-graph:';
    const seen = new Map<string, {
      id: string; uri: string; name: string; description?: string;
      creator?: string; createdAt?: string; isSystem: boolean;
      subscribed: boolean; synced: boolean;
    }>();

    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const uri = row['ctxGraph'] ?? '';
        if (seen.has(uri)) continue;
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
        const sub = this.subscribedContextGraphs.get(id);
        seen.set(uri, {
          id,
          uri,
          name: stripLiteral(row['name'] ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: !!row['isSystem'],
          subscribed: sub?.subscribed ?? false,
          synced: true,
        });
      }
    }

    // Curated CGs store their definition in their own _meta graph, not in
    // ONTOLOGY. Check _meta for any subscribed CGs not yet found above.
    for (const [id, sub] of this.subscribedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_PARANETS.AGENTS || id === SYSTEM_PARANETS.ONTOLOGY) continue;

      const metaGraph = paranetMetaGraphUri(id);
      const pUri = paranetDataGraphUri(id);
      const metaResult = await this.store.query(`
        SELECT ?name ?desc ?creator ?created WHERE {
          GRAPH <${metaGraph}> {
            <${pUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { <${pUri}> <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
          }
        } LIMIT 1
      `);

      if (metaResult.type === 'bindings' && metaResult.bindings.length > 0) {
        const row = metaResult.bindings[0] as Record<string, string>;
        seen.set(uri, {
          id,
          uri,
          name: stripLiteral(row['name'] ?? sub.name ?? id),
          description: row['desc'] ? stripLiteral(row['desc']) : undefined,
          creator: row['creator'],
          createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
          isSystem: false,
          subscribed: sub.subscribed,
          synced: sub.synced,
        });
        continue;
      }

      // No declaration in ontology, agents, or _meta graphs. Two cases:
      //
      //  1. Chain-attested but not-yet-synced (sub.onChainId set):
      //     auto-discovery from the on-chain registry found this CG and
      //     subscribed us. Surface it as subscribed+synced=false so the
      //     UI can show a legitimate "waiting for sync" state. Any
      //     genuinely inaccessible curated CG will be removed from
      //     `subscribedContextGraphs` by the daemon's authoritative
      //     denial path (accessDeniedPeers > 0) before we get here.
      //
      //  2. Not chain-attested AND no local content: a truly phantom
      //     entry (pre-discovery subscribe that never resolved). Hide
      //     it to avoid polluting the UI. If the user legitimately
      //     subscribes later, the next catch-up writes _meta or data
      //     and the entry will appear on the next refresh.
      if (!sub.onChainId) {
        const dataGraph = paranetDataGraphUri(id);
        const hasAnyContent = await this.store.query(
          `ASK WHERE { GRAPH <${dataGraph}> { ?s ?p ?o } }`,
        );
        const hasContent = hasAnyContent.type === 'boolean' && hasAnyContent.value;
        if (!hasContent) continue;
      }

      seen.set(uri, {
        id,
        uri,
        name: sub.name ?? id,
        isSystem: false,
        subscribed: sub.subscribed,
        synced: sub.synced,
      });
    }

    const graphManager = new GraphManager(this.store);
    const storedContextGraphs = await graphManager.listParanets();
    for (const id of storedContextGraphs) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_PARANETS.AGENTS || id === SYSTEM_PARANETS.ONTOLOGY) continue;

      const sub = this.subscribedContextGraphs.get(id);
      seen.set(uri, {
        id,
        uri,
        name: sub?.name ?? id,
        isSystem: false,
        subscribed: sub?.subscribed ?? false,
        synced: sub?.synced ?? false,
      });
    }

    return Array.from(seen.values());
  }

  async networkId(): Promise<string> {
    return computeNetworkId();
  }

  get peerId(): string {
    return this.node.peerId;
  }

  get nodeName(): string {
    return this.config.name;
  }

  get nodeFramework(): string | undefined {
    return this.config.framework;
  }

  private async getCclPolicyByUri(policyUri: string, opts: { includeBody?: boolean } = {}): Promise<CclPolicyRecord | null> {
    const records = await this.listCclPolicies({ includeBody: opts.includeBody });
    return records.find(record => record.policyUri === policyUri) ?? null;
  }

  /**
   * Verify that the caller is the owner of a context graph. When an explicit
   * callerAgentAddress is provided (agent-level token), only that identity is
   * checked — no fallback to node-level identities. This prevents non-owner
   * agents on the same node from piggybacking on the node's default agent.
   *
   * Legacy fallback (peerId / defaultAgentAddress) only applies when no
   * explicit caller is known (node-level token / backward compat).
   */
  private assertCallerIsOwner(owner: string, callerAgentAddress: string | undefined, action: string): void {
    const callerDid = callerAgentAddress ? `did:dkg:agent:${callerAgentAddress}` : null;
    const selfDid = `did:dkg:agent:${this.peerId}`;

    let authorized: boolean;
    if (callerDid) {
      // Explicit caller: check only their DID.
      // Also allow through if the caller is the default agent and the owner
      // is stored under the legacy peerId-based DID (pre-agent-model CGs).
      authorized = owner === callerDid ||
        (callerAgentAddress === this.defaultAgentAddress && owner === selfDid);
    } else {
      // No explicit caller (node-level token): allow any local identity
      authorized = owner === selfDid ||
        [...this.localAgents.keys()].some(addr => owner === `did:dkg:agent:${addr}`);
    }

    if (!authorized) {
      throw new Error(
        `Only the context graph creator can ${action}. ` +
        `Creator=${owner}, caller=${callerDid ?? selfDid}`,
      );
    }
  }

  private async assertParanetOwner(paranetId: string): Promise<void> {
    const owner = await this.getContextGraphOwner(paranetId);
    const current = `did:dkg:agent:${this.peerId}`;
    if (!owner) {
      throw new Error(`Paranet "${paranetId}" has no registered owner; cannot manage policies.`);
    }
    if (owner !== current) {
      throw new Error(`Only the paranet owner can manage policies for "${paranetId}". Owner=${owner}, current=${current}`);
    }
  }

  private async getContextGraphOwner(paranetId: string): Promise<string | null> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const cgMetaGraph = paranetMetaGraphUri(paranetId);
    const paranetUri = `did:dkg:context-graph:${paranetId}`;
    const result = await this.store.query(`
      SELECT ?owner WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${paranetUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?owner .
          }
        } UNION {
          GRAPH <${cgMetaGraph}> {
            <${paranetUri}> <${DKG_ONTOLOGY.DKG_CREATOR}> ?owner .
          }
        }
      }
      LIMIT 1
    `);
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    return (result.bindings[0] as Record<string, string>)['owner'] ?? null;
  }

  private async listCclPolicyBindings(opts: {
    paranetId?: string;
    name?: string;
  } = {}): Promise<PolicyApprovalBinding[]> {
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const filters: string[] = [];
    if (opts.paranetId) filters.push(`?paranet = <did:dkg:context-graph:${opts.paranetId}>`);
    if (opts.name) filters.push(`?name = ${sparqlString(opts.name)}`);
    const filterBlock = filters.length > 0 ? `FILTER(${filters.join(' && ')})` : '';
    const result = await this.store.query(`
      SELECT ?binding ?policy ?paranet ?name ?contextType ?bindingStatus ?approvedAt ?approvedBy ?revokedAt ?revokedBy WHERE {
        GRAPH <${ontologyGraph}> {
          ?binding <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_POLICY_BINDING}> ;
                   <${DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_PARANET}> ?paranet ;
                   <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name ;
                   <${DKG_ONTOLOGY.DKG_ACTIVE_POLICY}> ?policy ;
                   <${DKG_ONTOLOGY.DKG_APPROVED_AT}> ?approvedAt .
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_POLICY_BINDING_STATUS}> ?bindingStatus }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_APPROVED_BY}> ?approvedBy }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_REVOKED_AT}> ?revokedAt }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_REVOKED_BY}> ?revokedBy }
          OPTIONAL { ?binding <${DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE}> ?contextType }
          ${filterBlock}
        }
      }
      ORDER BY DESC(?approvedAt)
    `);

    if (result.type !== 'bindings') return [];
    const byBinding = new Map<string, PolicyApprovalBinding>();
    for (const row of result.bindings as Record<string, string>[]) {
      const bindingUri = row['binding'];
      const revokedAt = row['revokedAt'] ? stripLiteral(row['revokedAt']) : undefined;
      const next: PolicyApprovalBinding = {
        bindingUri,
        policyUri: row['policy'],
        paranetId: row['paranet'].startsWith('did:dkg:context-graph:') ? row['paranet'].slice('did:dkg:context-graph:'.length) : row['paranet'],
        name: stripLiteral(row['name']),
        contextType: row['contextType'] ? stripLiteral(row['contextType']) : undefined,
        status: revokedAt || (row['bindingStatus'] && stripLiteral(row['bindingStatus']) === 'revoked') ? 'revoked' : 'approved',
        approvedAt: stripLiteral(row['approvedAt']),
        approvedBy: row['approvedBy'],
        revokedAt,
        revokedBy: row['revokedBy'],
      };
      const current = byBinding.get(bindingUri);
      if (!current) {
        byBinding.set(bindingUri, next);
        continue;
      }
      byBinding.set(bindingUri, {
        ...current,
        status: (current.revokedAt || next.revokedAt) ? 'revoked'
          : (current.status === 'superseded' || next.status === 'superseded') ? 'superseded'
          : 'approved',
        revokedAt: current.revokedAt ?? next.revokedAt,
        revokedBy: current.revokedBy ?? next.revokedBy,
        approvedBy: current.approvedBy ?? next.approvedBy,
      });
    }
    const allBindings = Array.from(byBinding.values()).sort((a, b) => b.approvedAt.localeCompare(a.approvedAt));

    // Mark non-revoked, non-latest bindings as "superseded" per scope
    const latestByScope = new Map<string, string>();
    for (const b of allBindings) {
      if (b.status === 'revoked') continue;
      const key = `${b.paranetId}|${b.name}|${b.contextType ?? ''}`;
      if (!latestByScope.has(key)) {
        latestByScope.set(key, b.bindingUri);
      } else if (b.bindingUri !== latestByScope.get(key)) {
        b.status = 'superseded';
      }
    }
    return allBindings;
  }

  private selectLatestNonRevokedBindings(bindings: PolicyApprovalBinding[]): Map<string, PolicyApprovalBinding> {
    const latestByScope = new Map<string, PolicyApprovalBinding>();
    for (const binding of bindings) {
      if (binding.status === 'revoked' || binding.status === 'superseded') continue;
      const key = `${binding.paranetId}|${binding.name}|${binding.contextType ?? ''}`;
      const current = latestByScope.get(key);
      if (!current || binding.approvedAt > current.approvedAt) {
        latestByScope.set(key, binding);
      }
    }
    return latestByScope;
  }

  private resolveCclPolicyBinding(
    latestByScope: Map<string, PolicyApprovalBinding>,
    paranetId: string,
    name: string,
    contextType?: string,
  ): PolicyApprovalBinding | null {
    return latestByScope.get(`${paranetId}|${name}|${contextType ?? ''}`)
      ?? latestByScope.get(`${paranetId}|${name}|`)
      ?? null;
  }

  private async getActiveCclPolicyBinding(opts: {
    paranetId: string;
    policyUri: string;
    contextType?: string;
  }): Promise<PolicyApprovalBinding | null> {
    const record = await this.getCclPolicyByUri(opts.policyUri);
    if (!record) return null;
    const bindings = await this.listCclPolicyBindings({ paranetId: opts.paranetId, name: record.name });
    const latestByScope = this.selectLatestNonRevokedBindings(bindings);
    const active = this.resolveCclPolicyBinding(latestByScope, opts.paranetId, record.name, opts.contextType);
    if (!active || active.policyUri !== opts.policyUri) return null;
    return active;
  }

  private deriveCclPolicyStatus(
    policyUri: string,
    storedStatus: string,
    bindings: PolicyApprovalBinding[],
    latestByScope: Map<string, PolicyApprovalBinding>,
  ): string {
    if (Array.from(latestByScope.values()).some(binding => binding.policyUri === policyUri)) {
      return 'approved';
    }
    if (bindings.some(binding => binding.policyUri === policyUri)) {
      return 'revoked';
    }
    return storedStatus;
  }

  private async publishOntologyQuads(ual: string, quads: Quad[]): Promise<void> {
    const ontologyTopic = paranetPublishTopic(SYSTEM_PARANETS.ONTOLOGY);
    const nquads = quads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
    }).join('\n');

    const msg = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(nquads),
      paranetId: SYSTEM_PARANETS.ONTOLOGY,
      kas: [],
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: '',
      startKAId: 0,
      endKAId: 0,
      chainId: '',
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    try {
      await this.gossip.publish(ontologyTopic, msg);
    } catch {
      // No peers subscribed — ok for local-only operation
    }
  }

  get identityId(): bigint {
    return this.publisher.getIdentityId();
  }

  /**
   * Sign the context graph participant digest: keccak256(contextGraphId, merkleRoot).
   * Returns the caller's identity ID and compact ECDSA (r, vs) values that the
   * ContextGraphs contract can verify via ecrecover.
   */
  async signContextGraphDigest(
    contextGraphId: bigint,
    merkleRoot: Uint8Array,
  ): Promise<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> {
    if (typeof this.chain.signMessage !== 'function') {
      throw new Error('Chain adapter does not support signMessage');
    }
    const digest = ethers.solidityPackedKeccak256(
      ['uint256', 'bytes32'],
      [contextGraphId, ethers.hexlify(merkleRoot)],
    );
    const sig = await this.chain.signMessage(ethers.getBytes(digest));
    return { identityId: this.identityId, ...sig };
  }

  get multiaddrs(): string[] {
    return this.node.multiaddrs;
  }

  /** Returns a snapshot of the context graph subscription registry. */
  getSubscribedContextGraphs(): ReadonlyMap<string, ContextGraphSub> {
    return this.subscribedContextGraphs;
  }

  /** Returns the latest health snapshot for all known peers. */
  getPeerHealth(): ReadonlyMap<string, PeerHealth> {
    return this.peerHealth;
  }

  /**
   * Ping all known peers to check liveness. Updates the peerHealth map with
   * latency and last-seen timestamps. Returns the number of peers that responded.
   */
  async pingPeers(): Promise<number> {
    const ctx = createOperationContext('system');
    const peers = this.node.libp2p.getPeers();
    if (peers.length === 0) return 0;

    const PING_TIMEOUT_MS = 10_000;
    let alive = 0;
    const now = Date.now();

    const results = await Promise.allSettled(
      peers.map(async (peerId) => {
        const id = peerId.toString();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), PING_TIMEOUT_MS);
        try {
          const latency = await this.node.libp2p.services.ping.ping(peerId, { signal: ac.signal });
          clearTimeout(timer);
          this.peerHealth.set(id, {
            peerId: id,
            alive: true,
            latencyMs: latency,
            lastSeen: now,
            lastChecked: now,
          });
          return true;
        } catch {
          clearTimeout(timer);
          const prev = this.peerHealth.get(id);
          this.peerHealth.set(id, {
            peerId: id,
            alive: false,
            latencyMs: null,
            lastSeen: prev?.lastSeen ?? null,
            lastChecked: now,
          });
          return false;
        }
      }),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) alive++;
    }

    this.log.info(ctx, `Peer health ping: ${alive}/${peers.length} peers alive`);
    return alive;
  }

  /**
   * Scan the local ONTOLOGY graph and curated/private _meta graphs for context
   * graph definitions and auto-subscribe to any that aren't yet in the
   * subscription registry. Called after syncFromPeer to catch context graphs
   * discovered via ONTOLOGY sync or authenticated _meta sync.
   */
  async discoverContextGraphsFromStore(): Promise<number> {
    const ctx = createOperationContext('system');
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const prefix = 'did:dkg:context-graph:';
    let discovered = 0;

    const discoveredEntries = new Map<string, { id: string; name: string; source: 'ontology' | 'meta' }>();

    const collectEntries = (
      rows: Record<string, string>[],
      source: 'ontology' | 'meta',
    ) => {
      for (const row of rows) {
        const uri = row['ctxGraph'] ?? '';
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
        if (!id) continue;
        if (id === SYSTEM_PARANETS.AGENTS || id === SYSTEM_PARANETS.ONTOLOGY) continue;

        const existing = discoveredEntries.get(id);
        const name = row['name'] ? stripLiteral(row['name']) : existing?.name ?? id;

        if (!existing || (existing.source === 'meta' && source === 'ontology')) {
          discoveredEntries.set(id, { id, name, source });
        }
      }
    };

    const ontologyResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH <${ontologyGraph}> {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
        }
      }
    `);
    if (ontologyResult.type === 'bindings') {
      collectEntries(ontologyResult.bindings as Record<string, string>[], 'ontology');
    }

    const metaResult = await this.store.query(`
      SELECT ?ctxGraph ?name WHERE {
        GRAPH ?metaGraph {
          ?ctxGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
          OPTIONAL { ?ctxGraph <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
          FILTER(STRENDS(STR(?metaGraph), "/_meta"))
        }
      }
    `);
    if (metaResult.type === 'bindings') {
      collectEntries(metaResult.bindings as Record<string, string>[], 'meta');
    }

    for (const { id, name, source } of discoveredEntries.values()) {
      const existing = this.subscribedContextGraphs.get(id);
      if (existing) continue;

      this.subscribedContextGraphs.set(id, {
        name,
        subscribed: false,
        synced: true,
        metaSynced: source === 'meta',
        onChainId: undefined,
      });

      this.log.info(ctx, `Discovered context graph "${name}" (${id}) from ${source} store — added as discoverable only`);
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Added ${discovered} new context graph(s) from store without subscribing`);
    }
    return discovered;
  }

  /**
   * Query the on-chain registry for all registered context graphs and
   * auto-subscribe to any not yet in the subscription registry.
   * Returns the number of newly discovered context graphs.
   */
  async discoverContextGraphsFromChain(): Promise<number> {
    const ctx = createOperationContext('system');
    if (!this.chain.listContextGraphsFromChain) {
      this.log.info(ctx, 'Chain adapter does not support listContextGraphsFromChain — skipping');
      return 0;
    }

    let onChainContextGraphs;
    try {
      onChainContextGraphs = await this.chain.listContextGraphsFromChain();
    } catch (err) {
      this.log.warn(ctx, `Chain context graph scan failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    // Build a set of all known on-chain IDs (stored and computed) for fast dedup
    const knownOnChainIds = new Set<string>();
    for (const [localId, sub] of this.subscribedContextGraphs) {
      if (sub.onChainId) knownOnChainIds.add(sub.onChainId);
      // Also compute expected hash for locally-known context graph IDs
      knownOnChainIds.add(ethers.keccak256(ethers.toUtf8Bytes(localId)));
    }

    let discovered = 0;
    for (const p of onChainContextGraphs) {
      if (knownOnChainIds.has(p.contextGraphId)) continue;

      if (!p.name) {
        // Hash-only entry (metadata not revealed) — record for dedup but don't
        // subscribe to gossip topics since hash-keyed topics are unusable.
        this.log.info(ctx, `Noted unresolved on-chain context graph ${p.contextGraphId.slice(0, 16)}… (no metadata)`);
        knownOnChainIds.add(p.contextGraphId);
        continue;
      }

      this.subscribedContextGraphs.set(p.name, {
        name: p.name,
        subscribed: true,
        synced: false,
        metaSynced: false,
        onChainId: p.contextGraphId,
      });
      this.subscribeToContextGraph(p.name, { trackSyncScope: false });

      // Persist the on-chain ID to the ontology graph so the publisher's
      // VM registration guard can find it via RDF (it has no access to
      // the in-memory subscribedContextGraphs map).
      const cgUri = paranetDataGraphUri(p.name);
      const ontoGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
      await this.store.insert([{
        subject: cgUri,
        predicate: `${DKG_ONTOLOGY.DKG_PARANET}OnChainId`,
        object: `"${p.contextGraphId}"`,
        graph: ontoGraph,
      }]);

      this.log.info(ctx, `Discovered on-chain context graph "${p.name}" (${p.contextGraphId.slice(0, 16)}…) — auto-subscribed (synced=false)`);
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Discovered ${discovered} new context graph(s) from chain`);
    }
    return discovered;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.chainPoller) {
      this.chainPoller.stop();
      this.chainPoller = null;
    }
    if (this.swmCleanupTimer) {
      clearInterval(this.swmCleanupTimer);
      this.swmCleanupTimer = null;
    }
    await this.node.stop();
    this.started = false;
  }

  /**
   * Loads genesis knowledge into the triple store if not already present.
   * Creates the system context graph graphs and inserts the genesis quads.
   */
  private static async loadGenesis(store: TripleStore): Promise<void> {
    const gm = new GraphManager(store);

    // Ensure system context graphs exist
    await gm.ensureParanet(SYSTEM_PARANETS.AGENTS);
    await gm.ensureParanet(SYSTEM_PARANETS.ONTOLOGY);

    // Check if genesis is already loaded by looking for the network definition
    const result = await store.query(
      `SELECT ?v WHERE { <did:dkg:network:v9-testnet> <https://dkg.network/ontology#genesisVersion> ?v } LIMIT 1`,
    );
    if (result.type === 'bindings' && result.bindings.length > 0) return;

    // Insert genesis quads
    const genesisQuads = getGenesisQuads();
    const quads: Quad[] = genesisQuads.map(gq => ({
      subject: gq.subject,
      predicate: gq.predicate,
      object: gq.object.startsWith('"') ? gq.object : gq.object,
      graph: gq.graph,
    }));
    await store.insert(quads);
  }

  /**
   * Create a V10 ACK provider callback for the publisher.
   * Uses ACKCollector to broadcast PublishIntent and collect StorageACKs
   * via direct P2P from connected core nodes. The required number of ACKs
   * is read from chain ParametersStorage.minimumRequiredSignatures().
   */
  private createV10ACKProvider(contextGraphId: string) {
    if (!this.router || !this.gossip) return undefined;
    // `isV10Ready()` is the authoritative V10 capability gate. Using it
    // (instead of probing for `createKnowledgeAssetsV10`) keeps
    // `NoChainAdapter` — whose stub methods throw — out of the V10 path.
    if (typeof this.chain.isV10Ready !== 'function' || !this.chain.isV10Ready()) return undefined;
    // Require on-chain identity verification to prevent accepting unverified ACKs
    // that would fail on-chain and waste gas. Fall back to legacy path if unavailable.
    if (typeof this.chain.verifyACKIdentity !== 'function') return undefined;
    // The H5 prefix requires a numeric chain id AND the deployed KAV10
    // address. Without BOTH, the collector cannot build a digest that
    // matches what core-node ACK handlers sign, so refuse to hand back a
    // provider at all rather than crash on the first publish with
    // `chain.getEvmChainId is not a function`. Mirrors the guard at
    // `packages/cli/src/publisher-runner.ts:createV10ACKProviderForPublisher`.
    if (typeof this.chain.getEvmChainId !== 'function') return undefined;
    if (typeof this.chain.getKnowledgeAssetsV10Address !== 'function') return undefined;

    const collector = new ACKCollector({
      gossipPublish: async (topic: string, data: Uint8Array) => {
        await this.gossip.publish(topic, data);
      },
      sendP2P: async (peerId: string, protocol: string, data: Uint8Array) => {
        return this.router.send(peerId, protocol, data);
      },
      getConnectedCorePeers: () => {
        const peers = this.node.libp2p.getPeers();
        const connected = peers.map(p => p.toString()).filter(id => id !== this.peerId);
        // Prefer peers confirmed as core nodes (advertise StorageACK protocol).
        if (this.knownCorePeerIds.size > 0) {
          const filtered = connected.filter(id => this.knownCorePeerIds.has(id));
          if (filtered.length > 0) return filtered;
        }
        // Fallback: return all connected peers during early startup before
        // protocol discovery completes. Since only core nodes register the
        // StorageACK handler, requests to edge nodes fail at protocol
        // negotiation (fast, no error logs on the remote side).
        return connected;
      },
      verifyIdentity: typeof this.chain.verifyACKIdentity === 'function'
        ? async (recoveredAddress: string, claimedIdentityId: bigint) => {
            try {
              return await this.chain.verifyACKIdentity!(recoveredAddress, claimedIdentityId);
            } catch {
              return false;
            }
          }
        : undefined,
      log: (msg: string) => {
        const ctx = createOperationContext('publish');
        this.log.info(ctx, msg);
      },
    });

    const chain = this.chain;

    return async (
      merkleRoot: Uint8Array,
      contextGraphId: string,
      kaCount: number,
      rootEntities: string[],
      publicByteSize: bigint,
      stagingQuads?: Uint8Array,
      epochs?: number,
      tokenAmount?: bigint,
      swmGraphId?: string,
      subGraphName?: string,
    ) => {
      // Fail loud on non-numeric or non-positive CG ids: V10 publish requires
      // a real on-chain context graph and the contract rejects `cgId == 0`
      // with `ZeroContextGraphId`. Reject `<= 0n` (not `=== 0n`) because
      // `BigInt("-1")` returns `-1n` without throwing — a naive zero check
      // would let negative ids through to the evm-adapter pre-tx guard,
      // where ethers' uint256 encoder would throw a cryptic low-level
      // error. Matches the same guard in dkg-publisher, storage-ack-handler,
      // and async publisher-runner so ACK signers, ACK verifiers, and the
      // chain submitter all agree on the legal domain. `contextGraphId`
      // here is the TARGET on-chain id — `swmGraphId` (optional) is the
      // source SWM graph name and is NOT required to be numeric.
      let cgIdBigInt: bigint;
      try {
        cgIdBigInt = BigInt(contextGraphId);
      } catch {
        throw new Error(
          `V10 ACK collection requires a numeric on-chain context graph id; ` +
          `got '${contextGraphId}'. Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }
      if (cgIdBigInt <= 0n) {
        throw new Error(
          `V10 ACK collection requires a positive on-chain context graph id; got ${cgIdBigInt}. ` +
          `Register the CG on-chain via ContextGraphs.createContextGraph first.`,
        );
      }

      const requiredACKs = typeof chain.getMinimumRequiredSignatures === 'function'
        ? await chain.getMinimumRequiredSignatures()
        : undefined;

      // H5 prefix inputs — both come from the chain adapter so that
      // publisher-side digest construction matches what core-node handlers
      // produced on their side. These are required for any V10 path; the
      // adapter must implement them.
      const chainIdBig = await chain.getEvmChainId();
      const kav10Address = await chain.getKnowledgeAssetsV10Address();

      const result = await collector.collect({
        merkleRoot,
        contextGraphId: cgIdBigInt,
        contextGraphIdStr: contextGraphId,
        publisherPeerId: this.peerId,
        publicByteSize,
        isPrivate: false,
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
      });
      return result.acks;
    };
  }

  private async broadcastPublish(contextGraphId: string, result: PublishResult, ctx: OperationContext): Promise<void> {
    // Use the public quads from the publish result to avoid leaking private
    // triples that are stored in the same data graph.
    const publicQuads = result.publicQuads ?? [];
    const ntriples = publicQuads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} .`;
    }).join('\n');

    const onChain = result.onChainResult;
    const msg = encodePublishRequest({
      ual: result.ual,
      nquads: new TextEncoder().encode(ntriples),
      paranetId: contextGraphId,
      kas: result.kaManifest.map(ka => ({
        tokenId: Number(ka.tokenId),
        rootEntity: ka.rootEntity,
        privateMerkleRoot: ka.privateMerkleRoot ?? new Uint8Array(0),
        privateTripleCount: ka.privateTripleCount ?? 0,
      })),
      publisherIdentity: this.wallet.keypair.publicKey,
      publisherAddress: onChain?.publisherAddress ?? '',
      startKAId: Number(onChain?.startKAId ?? 0),
      endKAId: Number(onChain?.endKAId ?? 0),
      chainId: this.chain.chainId,
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
      txHash: onChain?.txHash ?? '',
      blockNumber: onChain?.blockNumber ?? 0,
      operationId: ctx.operationId,
      subGraphName: result.subGraphName,
    });

    const topic = paranetPublishTopic(contextGraphId);
    this.log.info(ctx, `Broadcasting to topic ${topic}`);
    try {
      await this.gossip.publish(topic, msg);
    } catch {
      this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
    }
  }

  // ── Working Memory Assertion Operations (spec §6) ───────────────────

  get assertion() {
    const agent = this;
    const agentAddress = this.defaultAgentAddress ?? this.peerId;
    return {
      async create(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<string> {
        return agent.publisher.assertionCreate(contextGraphId, name, agentAddress, opts?.subGraphName);
      },

      /**
       * Write triples to a WM assertion. Accepts:
       * - `Quad[]` — standard quad array (same as publish/share)
       * - `JsonLdContent` — JSON-LD document, auto-converted to quads
       * - `Array<{ subject, predicate, object }>` — simple triple array
       */
      async write(
        contextGraphId: string,
        name: string,
        input: import('@origintrail-official/dkg-storage').Quad[] | JsonLdContent | Array<{ subject: string; predicate: string; object: string }>,
        opts?: { subGraphName?: string },
      ): Promise<void> {
        let quads: import('@origintrail-official/dkg-storage').Quad[];
        if (Array.isArray(input) && input.length > 0 && 'graph' in input[0]) {
          quads = input as import('@origintrail-official/dkg-storage').Quad[];
        } else if (!Array.isArray(input) || (input.length > 0 && !('subject' in input[0]))) {
          const { publicQuads, privateQuads } = await jsonLdToQuads(input as JsonLdContent);
          quads = [...publicQuads, ...privateQuads];
        } else {
          quads = (input as Array<{ subject: string; predicate: string; object: string }>)
            .map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object, graph: '' }));
        }
        return agent.publisher.assertionWrite(contextGraphId, name, agentAddress, quads, opts?.subGraphName);
      },

      async query(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<import('@origintrail-official/dkg-storage').Quad[]> {
        return agent.publisher.assertionQuery(contextGraphId, name, agentAddress, opts?.subGraphName);
      },
      async promote(contextGraphId: string, name: string, opts?: { entities?: string[] | 'all'; subGraphName?: string }): Promise<{ promotedCount: number }> {
        const { promotedCount, gossipMessage } = await agent.publisher.assertionPromote(
          contextGraphId, name, agentAddress,
          { ...opts, publisherPeerId: agent.node.peerId.toString() },
        );
        if (gossipMessage) {
          const topic = paranetWorkspaceTopic(contextGraphId);
          try {
            await agent.gossip.publish(topic, gossipMessage);
          } catch (err: any) {
            agent.log.warn(createOperationContext('share'), `Promote gossip failed (local SWM committed): ${err?.message ?? err}`);
          }
        }
        return { promotedCount };
      },
      async discard(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<void> {
        return agent.publisher.assertionDiscard(contextGraphId, name, agentAddress, opts?.subGraphName);
      },

      async history(contextGraphId: string, name: string, opts?: { agentAddress?: string; subGraphName?: string }): Promise<AssertionDescriptor | null> {
        const addr = opts?.agentAddress ?? agentAddress;
        const lifecycleUri = assertionLifecycleUri(contextGraphId, addr, name, opts?.subGraphName);
        const metaGraph = contextGraphMetaUri(contextGraphId);
        const DKG_NS = 'http://dkg.io/ontology/';
        const PROV_NS = 'http://www.w3.org/ns/prov#';

        const strip = (v?: string) => v?.replace(/^"|"$/g, '').replace(/"\^\^<.*>$/, '') ?? undefined;

        // Query assertion entity (current state + layer)
        const entityResult = await agent.store.query(
          `SELECT ?state ?memoryLayer ?assertionGraph WHERE {
            GRAPH <${metaGraph}> {
              <${lifecycleUri}> <${DKG_NS}state> ?state .
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}memoryLayer> ?memoryLayer }
              OPTIONAL { <${lifecycleUri}> <${DKG_NS}assertionGraph> ?assertionGraph }
            }
          } LIMIT 1`,
        );
        if (entityResult.type !== 'bindings' || entityResult.bindings.length === 0) return null;

        const row = entityResult.bindings[0];
        const stateStr = strip(row['state']) as AssertionState;
        const layerStr = strip(row['memoryLayer']);
        const graphUri = row['assertionGraph'] ?? contextGraphAssertionUri(contextGraphId, addr, name);

        // Query all prov:Activity events that acted on this assertion
        // (linked via prov:used or prov:generated)
        const eventsResult = await agent.store.query(
          `SELECT ?event ?type ?timestamp ?fromLayer ?toLayer ?shareOpId ?kcUal ?rootEntity WHERE {
            GRAPH <${metaGraph}> {
              { ?event <${PROV_NS}generated> <${lifecycleUri}> }
              UNION
              { ?event <${PROV_NS}used> <${lifecycleUri}> }
              ?event a <${PROV_NS}Activity> .
              ?event a ?type .
              FILTER(STRSTARTS(STR(?type), "${DKG_NS}"))
              ?event <${PROV_NS}startedAtTime> ?timestamp .
              ?event <${DKG_NS}fromLayer> ?fromLayer .
              ?event <${DKG_NS}toLayer> ?toLayer .
              OPTIONAL { ?event <${DKG_NS}shareOperationId> ?shareOpId }
              OPTIONAL { ?event <${DKG_NS}kcUal> ?kcUal }
              OPTIONAL { ?event <${DKG_NS}rootEntity> ?rootEntity }
            }
          } ORDER BY ?timestamp`,
        );

        // Group event rows by event URI (rootEntity may produce multiple rows)
        const eventMap = new Map<string, AssertionEvent>();
        if (eventsResult.type === 'bindings') {
          for (const b of eventsResult.bindings) {
            const eventUri = b['event'];
            if (!eventUri) continue;
            if (!eventMap.has(eventUri)) {
              const typeSuffix = (b['type'] ?? '').replace(DKG_NS, '').replace('Assertion', '').toLowerCase();
              eventMap.set(eventUri, {
                type: (typeSuffix || stateStr) as AssertionState,
                timestamp: strip(b['timestamp']) ?? '',
                fromLayer: strip(b['fromLayer']) ?? '',
                toLayer: strip(b['toLayer']) ?? '',
                shareOperationId: strip(b['shareOpId']),
                kcUal: strip(b['kcUal']),
                rootEntities: b['rootEntity'] ? [b['rootEntity']] : undefined,
              });
            } else if (b['rootEntity']) {
              const existing = eventMap.get(eventUri)!;
              if (!existing.rootEntities) existing.rootEntities = [];
              if (!existing.rootEntities.includes(b['rootEntity'])) {
                existing.rootEntities.push(b['rootEntity']);
              }
            }
          }
        }

        return {
          contextGraphId,
          agentAddress: addr,
          name,
          state: stateStr,
          memoryLayer: (layerStr as MemoryLayer) ?? null,
          assertionGraph: graphUri,
          events: [...eventMap.values()],
        };
      },
    };
  }

}

function splitNQuadLine(line: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) break;
    if (line[i] === '<') {
      const end = line.indexOf('>', i);
      if (end === -1) break;
      parts.push(line.slice(i, end + 1));
      i = end + 1;
    } else if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"') {
          j++;
          if (line[j] === '@') { while (j < line.length && line[j] !== ' ') j++; }
          else if (line[j] === '^' && line[j + 1] === '^') {
            j += 2;
            if (line[j] === '<') { const end = line.indexOf('>', j); if (end === -1) break; j = end + 1; }
          }
          break;
        }
        j++;
      }
      parts.push(line.slice(i, j));
      i = j;
    } else if (line[i] === '_') {
      let j = i;
      while (j < line.length && line[j] !== ' ') j++;
      parts.push(line.slice(i, j));
      i = j;
    } else break;
  }
  return parts;
}

function strip(s: string): string {
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  return s;
}

function stripLiteral(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return unescapeLiteralContent(s.slice(1, -1));
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return unescapeLiteralContent(match[1]);
  return s;
}

function unescapeLiteralContent(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Minimal N-Quads parser for sync responses.
 * Reuses the existing `splitNQuadLine` helper above.
 */
function parseNQuads(text: string): Quad[] {
  const quads: Quad[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.endsWith(' .') ? trimmed.slice(0, -2).trim() : trimmed;
    const parts = splitNQuadLine(body);
    if (parts.length >= 3) {
      quads.push({
        subject: strip(parts[0]),
        predicate: strip(parts[1]),
        object: parts[2].startsWith('"') ? parts[2] : strip(parts[2]),
        graph: parts[3] ? strip(parts[3]) : '',
      });
    }
  }
  return quads;
}

let _jsonld: typeof import('jsonld') | undefined;
async function getJsonld() {
  if (!_jsonld) _jsonld = await import('jsonld');
  return _jsonld;
}

/**
 * Replace blank node identifiers with deterministic uuid: URIs.
 *
 * JSON-LD documents without explicit @id produce blank nodes (_:b0, _:b1, etc.)
 * which autoPartition cannot use as root entities. This function assigns a stable
 * uuid: URI to each unique blank node, matching dkg.js v8's generateMissingIdsForBlankNodes.
 *
 * Mutates the array in place.
 */
function assignUrisToBlankNodes(quads: Quad[]): void {
  const idMap = new Map<string, string>();

  function resolve(value: string): string {
    if (!value.startsWith('_:')) return value;
    let uri = idMap.get(value);
    if (!uri) {
      uri = `uuid:${crypto.randomUUID()}`;
      idMap.set(value, uri);
    }
    return uri;
  }

  for (let i = 0; i < quads.length; i++) {
    const q = quads[i];
    const subject = resolve(q.subject);
    const object = q.object.startsWith('_:') ? resolve(q.object) : q.object;
    if (subject !== q.subject || object !== q.object) {
      quads[i] = { ...q, subject, object };
    }
  }
}

/**
 * Convert a JSON-LD content object into public and private Quad arrays.
 *
 * Accepts either:
 * - A bare JSON-LD document (defaults to private)
 * - An envelope: { public?: JsonLdDoc, private?: JsonLdDoc }
 */
async function jsonLdToQuads(
  content: JsonLdContent,
): Promise<{ publicQuads: Quad[]; privateQuads: Quad[] }> {
  const jsonld = await getJsonld();

  const obj = content as Record<string, unknown>;
  const isEnvelope = !Array.isArray(content) && ('public' in obj || 'private' in obj);
  const publicDoc = isEnvelope ? (obj.public as object | undefined) : undefined;
  const privateDoc = isEnvelope ? (obj.private as object | undefined) : content;

  let publicQuads: Quad[] = [];
  let privateQuads: Quad[] = [];

  if (publicDoc) {
    const nquads = await jsonld.default.toRDF(publicDoc, { format: 'application/n-quads' }) as string;
    publicQuads = parseNQuads(nquads);
  }

  if (privateDoc) {
    const nquads = await jsonld.default.toRDF(privateDoc, { format: 'application/n-quads' }) as string;
    privateQuads = parseNQuads(nquads);
  }

  assignUrisToBlankNodes(publicQuads);
  assignUrisToBlankNodes(privateQuads);

  if (publicQuads.length === 0 && privateQuads.length === 0) {
    throw new Error('JSON-LD document produced no RDF quads');
  }

  // When there are private quads but no public quads, generate a synthetic
  // anchor so the publisher has something to merkle-root and partition.
  if (publicQuads.length === 0 && privateQuads.length > 0) {
    const anchorId = `urn:dkg:private:${crypto.randomUUID()}`;
    publicQuads = [{
      subject: anchorId,
      predicate: `${DKG_NS}privateDataAnchor`,
      object: '"true"',
      graph: '',
    }];
  }

  return { publicQuads, privateQuads };
}

const DKG_NS = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * Verify synced data by recomputing merkle roots from the received
 * triples and comparing them to the claimed roots in the meta graph.
 *
 * Returns only the verified data and meta triples; unverifiable KCs
 * (those without a merkle root in the meta) are passed through
 * since they may be system/genesis data.
 */
function verifySyncedData(
  dataQuads: Quad[],
  metaQuads: Quad[],
  ctx: OperationContext,
  log: Logger,
  acceptUnverified = false,
): { data: Quad[]; meta: Quad[]; rejected: number } {
  if (metaQuads.length === 0) {
    // No meta graph → no verification possible. Accept data as-is
    // (covers system paranets that don't have KC metadata).
    return { data: dataQuads, meta: metaQuads, rejected: 0 };
  }

  // Extract KC UALs and their claimed merkle roots from meta triples
  const kcMerkleRoots = new Map<string, string>();
  const kcRootEntities = new Map<string, string[]>();

  for (const q of metaQuads) {
    if (q.predicate === `${DKG_NS}merkleRoot`) {
      kcMerkleRoots.set(q.subject, stripLiteral(q.object));
    }
  }

  // Find KA → KC relationships and root entities
  const kaToKc = new Map<string, string>();
  const kaRootEntity = new Map<string, string>();

  for (const q of metaQuads) {
    if (q.predicate === `${DKG_NS}partOf`) {
      kaToKc.set(q.subject, stripLiteral(q.object));
    }
    if (q.predicate === `${DKG_NS}rootEntity`) {
      kaRootEntity.set(q.subject, stripLiteral(q.object));
    }
  }

  // Build KC → rootEntities[] map
  for (const [kaUri, kcUri] of kaToKc) {
    const rootEntity = kaRootEntity.get(kaUri);
    if (rootEntity && kcMerkleRoots.has(kcUri)) {
      if (!kcRootEntities.has(kcUri)) kcRootEntities.set(kcUri, []);
      kcRootEntities.get(kcUri)!.push(rootEntity);
    }
  }

  if (kcMerkleRoots.size === 0) {
    return { data: dataQuads, meta: metaQuads, rejected: 0 };
  }

  // Detect root entities shared across multiple KCs. When an entity has been
  // published more than once (e.g. profile updates), the data graph contains
  // the union of all versions' triples under the same root entity, making
  // per-KC Merkle verification impossible without KC-level graph isolation.
  const rootEntityToKCs = new Map<string, string[]>();
  for (const [kcUal, entities] of kcRootEntities) {
    for (const re of entities) {
      if (!rootEntityToKCs.has(re)) rootEntityToKCs.set(re, []);
      rootEntityToKCs.get(re)!.push(kcUal);
    }
  }
  const overlappingKCs = new Set<string>();
  for (const [, kcUals] of rootEntityToKCs) {
    if (kcUals.length > 1) {
      for (const u of kcUals) overlappingKCs.add(u);
    }
  }

  // Partition data triples by root entity
  const partitioned = autoPartition(dataQuads);

  // Verify each KC
  const verifiedKcUals = new Set<string>();
  let rejected = 0;

  for (const [kcUal, claimedHex] of kcMerkleRoots) {
    const rootEntities = kcRootEntities.get(kcUal) ?? [];
    if (rootEntities.length === 0) {
      // No KA info — can't verify, accept on trust
      verifiedKcUals.add(kcUal);
      continue;
    }

    if (overlappingKCs.has(kcUal)) {
      // Root entity is shared with other KCs (multi-version entity). Local
      // partition contains mixed triples so Merkle re-computation would fail.
      // Accept and defer to chain-level verification (Tier 2).
      log.debug(ctx, `Skipping Merkle check for ${kcUal}: root entity shared across ${rootEntityToKCs.get(rootEntities[0])!.length} KCs`);
      verifiedKcUals.add(kcUal);
      continue;
    }

    try {
      const allQuadsForKC: Quad[] = [];
      for (const re of rootEntities) {
        const quads = partitioned.get(re) ?? [];
        allQuadsForKC.push(...quads);
      }

      // Collect private merkle roots from KA metadata for this KC
      const kcPrivateRoots: Uint8Array[] = [];
      for (const [kaUri, kcUri] of kaToKc) {
        if (kcUri !== kcUal) continue;
        for (const mq of metaQuads) {
          if (mq.subject === kaUri && mq.predicate === `${DKG_NS}privateMerkleRoot`) {
            const hex = stripLiteral(mq.object).replace(/^0x/, '');
            if (hex.length === 64) {
              const bytes = new Uint8Array(32);
              for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
              kcPrivateRoots.push(bytes);
            }
          }
        }
      }

      const flatRoot = computeFlatKCRoot(allQuadsForKC, kcPrivateRoots);
      const flatHex = Array.from(flatRoot).map(b => b.toString(16).padStart(2, '0')).join('');

      if (flatHex === claimedHex) {
        verifiedKcUals.add(kcUal);
      } else if (kcPrivateRoots.length > 0) {
        const legacyRoot = computeFlatKCRoot(allQuadsForKC, []);
        const legacyHex = Array.from(legacyRoot).map(b => b.toString(16).padStart(2, '0')).join('');
        if (legacyHex === claimedHex) {
          log.debug(ctx, `KC ${kcUal} verified via legacy flat root (without private root anchoring)`);
          verifiedKcUals.add(kcUal);
        } else if (acceptUnverified) {
          log.debug(ctx, `Merkle mismatch for ${kcUal} (system context graph, accepted): claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
          rejected++;
        } else {
          log.warn(ctx, `Merkle mismatch for ${kcUal}: claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
          rejected++;
        }
      } else if (acceptUnverified) {
        log.debug(ctx, `Merkle mismatch for ${kcUal} (system context graph, accepted): claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
        rejected++;
      } else {
        log.warn(ctx, `Merkle mismatch for ${kcUal}: claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
        rejected++;
      }
    } catch {
      log.warn(ctx, `Merkle verification error for ${kcUal}, rejecting`);
      rejected++;
    }
  }

  // Collect triples belonging to verified KCs only
  const verifiedRootEntities = new Set<string>();
  for (const kcUal of verifiedKcUals) {
    for (const re of (kcRootEntities.get(kcUal) ?? [])) {
      verifiedRootEntities.add(re);
    }
  }

  // When acceptUnverified is set (system context graphs), accept all data
  // rather than dropping profiles that fail merkle verification.
  if (acceptUnverified && rejected > 0 && verifiedKcUals.size < kcMerkleRoots.size) {
    log.debug(ctx, `Accepting ${rejected} unverified KC(s) (system context graph)`);
    return { data: dataQuads, meta: metaQuads, rejected: 0 };
  }

  // Keep data triples whose root entity belongs to a verified KC,
  // plus any triples not associated with any KC (genesis/system data)
  const allKnownRootEntities = new Set<string>();
  for (const entities of kcRootEntities.values()) {
    for (const re of entities) allKnownRootEntities.add(re);
  }

  const verifiedData = dataQuads.filter(q => {
    if (allKnownRootEntities.has(q.subject)) {
      return verifiedRootEntities.has(q.subject);
    }
    for (const re of verifiedRootEntities) {
      if (q.subject.startsWith(re)) return true;
    }
    return true;
  });

  // Keep meta triples for verified KCs + unrelated meta triples
  const verifiedMeta = metaQuads.filter(q => {
    if (kcMerkleRoots.has(q.subject)) return verifiedKcUals.has(q.subject);
    const kcUri = kaToKc.get(q.subject);
    if (kcUri) return verifiedKcUals.has(kcUri);
    return true;
  });

  return { data: verifiedData, meta: verifiedMeta, rejected };
}
