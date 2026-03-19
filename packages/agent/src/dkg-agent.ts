import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE,
  paranetPublishTopic, paranetWorkspaceTopic, paranetAppTopic, paranetUpdateTopic, paranetFinalizationTopic,
  paranetDataGraphUri, paranetMetaGraphUri, paranetWorkspaceGraphUri, paranetWorkspaceMetaGraphUri,
  encodePublishRequest,
  encodeKAUpdateRequest,
  encodeFinalizationMessage, type FinalizationMessageMsg,
  getGenesisQuads, computeNetworkId, SYSTEM_PARANETS, DKG_ONTOLOGY,
  Logger, createOperationContext, withRetry,
  type DKGNodeConfig, type OperationContext,
} from '@origintrail-official/dkg-core';
import { GraphManager, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, NoChainAdapter, enrichEvmError, type EVMAdapterConfig, type ChainAdapter, type CreateContextGraphParams, type CreateContextGraphResult } from '@origintrail-official/dkg-chain';
import {
  DKGPublisher, PublishHandler, WorkspaceHandler, UpdateHandler, ChainEventPoller, AccessHandler, AccessClient,
  PublishJournal, StaleWriteError,
  computeTripleHash, computeFlatKCRoot, autoPartition,
  type PublishResult, type PhaseCallback, type KAMetadata, type CASCondition,
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
import { AGENT_REGISTRY_PARANET, type AgentProfileConfig } from './profile.js';
import { GossipPublishHandler } from './gossip-publish-handler.js';
import { FinalizationHandler } from './finalization-handler.js';
import { multiaddr } from '@multiformats/multiaddr';

const SYNC_PAGE_SIZE = 500;
const SYNC_PAGE_RETRY_ATTEMPTS = 3;
const SYNC_TOTAL_TIMEOUT_MS = 120_000;
/** Per-page timeout for sync when we have budget (relay links can be slow). */
const SYNC_PAGE_TIMEOUT_MS = 30_000;
/** ProtocolRouter.send retries internally 3 times with the same timeout; cap so 3× fits in remaining budget. */
const SYNC_ROUTER_ATTEMPTS = 3;
const DEFAULT_WORKSPACE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const WORKSPACE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // run cleanup every 15 minutes

/** Health status of a peer from the last ping round. */
export interface PeerHealth {
  peerId: string;
  alive: boolean;
  latencyMs: number | null;
  lastSeen: number | null;
  lastChecked: number;
}

/** Tracks the subscription and sync state of a paranet. */
export interface ParanetSub {
  name?: string;
  /** GossipSub topics are active for this paranet. */
  subscribed: boolean;
  /** Definition triples exist in the local triple store. */
  synced: boolean;
  /** On-chain paranet ID (keccak256 hash), if known. */
  onChainId?: string;
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
  /** Additional paranet IDs to sync on peer connect (beyond system paranets). */
  syncParanets?: string[];
  /** TTL for workspace data in milliseconds. Expired operations are periodically cleaned up. Default: 48 hours. Set to 0 to disable. */
  workspaceTtlMs?: number;
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
  /** Shared workspace-owned root entities per paranet: entity → creatorPeerId. Used by publisher and workspace handler. */
  private readonly workspaceOwnedEntities: Map<string, Map<string, string>>;
  /** Shared write locks so gossip writes serialize against local CAS writes. */
  private readonly writeLocks: Map<string, Promise<void>>;
  private workspaceHandler?: WorkspaceHandler;
  private gossipPublishHandler?: GossipPublishHandler;
  private finalizationHandler?: FinalizationHandler;
  private readonly log = new Logger('DKGAgent');

  private messageHandler: MessageHandler | null = null;
  private chainPoller: ChainEventPoller | null = null;
  private workspaceCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: DKGAgentConfig;
  private started = false;
  private readonly subscribedParanets = new Map<string, ParanetSub>();
  private readonly gossipRegistered = new Set<string>();
  private readonly seenOnChainIds = new Set<string>();
  private readonly peerHealth = new Map<string, PeerHealth>();
  private readonly syncingPeers = new Set<string>();

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
    const opKeys = config.chainConfig?.operationalKeys;
    if (config.chainAdapter) {
      chain = config.chainAdapter;
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
      workspaceOwnedEntities,
      writeLocks,
    });

    try {
      const restored = await publisher.reconstructWorkspaceOwnership();
      if (restored > 0) {
        const log = new Logger('DKGAgent');
        log.info(createOperationContext('init'), `Restored ${restored} workspace ownership entries from store`);
      }
    } catch (err) {
      const log = new Logger('DKGAgent');
      log.warn(createOperationContext('init'), `Failed to reconstruct workspace ownership, continuing without: ${err instanceof Error ? err.message : String(err)}`);
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

    // Auto-detect or register on-chain identity
    if (this.chain.chainId !== 'none') {
      let identityId = 0n;
      try {
        identityId = await this.chain.getIdentityId();
        if (identityId === 0n) {
          this.log.info(ctx, `No on-chain identity found, creating profile and staking...`);
          identityId = await this.chain.ensureProfile({
            nodeName: this.config.name,
          });
          this.log.info(ctx, `On-chain profile created, identityId=${identityId}`);
        } else {
          this.log.info(ctx, `On-chain identity found: identityId=${identityId}`);
        }
      } catch (err) {
        this.log.warn(ctx, `ensureProfile error: ${err instanceof Error ? err.message : String(err)}`);
        // Profile may have been created before the error — re-check
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
      } else {
        this.log.warn(ctx, `No valid on-chain identity — on-chain publishes will be skipped`);
      }
    }

    // Start chain event poller for trustless confirmation of tentative publishes
    // and discovery of on-chain paranets. Only with a real chain adapter.
    if (this.chain.chainId !== 'none') {
      this.chainPoller = new ChainEventPoller({
        chain: this.chain,
        publishHandler,
        onParanetCreated: async ({ paranetId, creator, accessPolicy, blockNumber }) => {
          this.log.info(ctx, `Discovered on-chain paranet ${paranetId.slice(0, 16)}… (block ${blockNumber}, creator ${creator.slice(0, 10)}…, policy ${accessPolicy})`);

          // Track the hash for dedup but don't pollute subscribedParanets.
          // Gossip topics are keyed by cleartext name, not the on-chain hash.
          // The paranet will be fully subscribed once ontology sync or
          // discoverParanetsFromChain resolves the cleartext name.
          const alreadyKnown = this.seenOnChainIds.has(paranetId)
            || [...this.subscribedParanets.values()].some(s => s.onChainId === paranetId);
          if (!alreadyKnown) {
            this.seenOnChainIds.add(paranetId);
            this.log.info(ctx, `Noted on-chain paranet ${paranetId.slice(0, 16)}… — will subscribe once cleartext name is resolved`);
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

    // Register sync handler: responds with a page of data + meta triples.
    // Request format: "paranetId|offset|limit"  (offset/limit default to 0/500)
    //   or: "workspace:paranetId|offset|limit" for workspace graph sync
    // Response includes both the data graph and the meta graph so the
    // receiver can verify merkle roots before inserting.
    this.router.register(PROTOCOL_SYNC, async (data) => {
      const text = new TextDecoder().decode(data).trim();
      const [paranetPart, offsetStr, limitStr] = text.split('|');
      const offset = parseInt(offsetStr, 10) || 0;
      const limit = Math.min(parseInt(limitStr, 10) || SYNC_PAGE_SIZE, SYNC_PAGE_SIZE);

      const isWorkspace = paranetPart.startsWith('workspace:');
      const paranetId = isWorkspace ? paranetPart.slice('workspace:'.length) : (paranetPart || SYSTEM_PARANETS.AGENTS);
      const nquads: string[] = [];

      if (isWorkspace) {
        const wsGraph = paranetWorkspaceGraphUri(paranetId);
        const wsMetaGraph = paranetWorkspaceMetaGraphUri(paranetId);
        const wsTtl = this.config.workspaceTtlMs ?? DEFAULT_WORKSPACE_TTL_MS;

        // Apply TTL/root-entity filter inside SPARQL before pagination so that
        // we return the first N non-expired triples. Only include exact root subject
        // or skolemized children (/.well-known/genid/...) to avoid pulling unrelated
        // entities that share a URI prefix (e.g. urn:x vs urn:x/other).
        const cutoff = wsTtl > 0 ? new Date(Date.now() - wsTtl).toISOString() : null;
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

        if (offset === 0) {
          // Only send meta for non-expired operations; reuse same cutoff as data query to avoid boundary skew
          const metaQuery = cutoff != null
            ? `SELECT ?s ?p ?o WHERE {
                GRAPH <${wsMetaGraph}> { ?s ?p ?o }
                FILTER EXISTS {
                  GRAPH <${wsMetaGraph}> {
                    ?s <http://dkg.io/ontology/publishedAt> ?ts .
                    FILTER(?ts >= "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
                  }
                }
              } ORDER BY ?s ?p ?o`
            : `SELECT ?s ?p ?o WHERE { GRAPH <${wsMetaGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`;

          const metaResult = await this.store.query(metaQuery);
          if (metaResult.type === 'bindings') {
            for (const b of metaResult.bindings) {
              const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
              nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${wsMetaGraph}> .`);
            }
          }
        }

        if (nquads.length === 0) return new TextEncoder().encode('');
      } else {
        const dataGraph = paranetDataGraphUri(paranetId);
        const metaGraph = paranetMetaGraphUri(paranetId);

        const dataResult = await this.store.query(
          `SELECT ?s ?p ?o WHERE { GRAPH <${dataGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`,
        );
        if (dataResult.type !== 'bindings' || dataResult.bindings.length === 0) {
          return new TextEncoder().encode('');
        }
        for (const b of dataResult.bindings) {
          const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
          nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${dataGraph}> .`);
        }

        if (offset === 0) {
          const metaResult = await this.store.query(
            `SELECT ?s ?p ?o WHERE { GRAPH <${metaGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
          );
          if (metaResult.type === 'bindings') {
            for (const b of metaResult.bindings) {
              const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
              nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${metaGraph}> .`);
            }
          }
        }
      }

      return new TextEncoder().encode(nquads.join('\n'));
    });

    // Subscribe to both system paranet GossipSub topics
    for (const systemParanet of [SYSTEM_PARANETS.AGENTS, SYSTEM_PARANETS.ONTOLOGY]) {
      this.subscribeToParanet(systemParanet);
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

    // On new peer connection, request sync of system paranets so we discover
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

    // Start periodic workspace cleanup
    const ttl = this.config.workspaceTtlMs ?? DEFAULT_WORKSPACE_TTL_MS;
    if (ttl > 0) {
      this.cleanupExpiredWorkspace().catch(() => {});
      this.workspaceCleanupTimer = setInterval(() => {
        this.cleanupExpiredWorkspace().catch(() => {});
      }, WORKSPACE_CLEANUP_INTERVAL_MS);
      if (this.workspaceCleanupTimer.unref) this.workspaceCleanupTimer.unref();
    }
  }

  /**
   * Pull all triples for the given paranets from a remote peer and merge
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
      const hasSync = protocols.includes(PROTOCOL_SYNC);
      if (!hasSync) {
        this.log.info(ctx, `Peer ${shortPeer} does not support sync protocol (protocols: ${protocols.join(', ')})`);
        return;
      }

      this.log.info(ctx, `Syncing from peer ${shortPeer}...`);
      const synced = await this.syncFromPeer(remotePeer);
      this.log.info(ctx, `Synced ${synced} data triples from peer ${shortPeer}`);

      // After syncing ONTOLOGY, discover and auto-subscribe to any new paranets
      await this.discoverParanetsFromStore();

      const wsParanets = this.config.syncParanets ?? [];
      if (wsParanets.length > 0) {
        const wsSynced = await this.syncWorkspaceFromPeer(remotePeer, wsParanets);
        this.log.info(ctx, `Synced ${wsSynced} workspace triples from peer ${shortPeer}`);
      }
    } finally {
      this.syncingPeers.delete(remotePeer);
    }
  }

  /**
   * Pull triples for the given paranets from a remote peer in pages,
   * verify merkle roots against the KC metadata, and only insert
   * triples that pass verification.
   */
  async syncFromPeer(
    remotePeerId: string,
    paranetIds: string[] = [SYSTEM_PARANETS.AGENTS, SYSTEM_PARANETS.ONTOLOGY, ...(this.config.syncParanets ?? [])],
    onPhase?: PhaseCallback,
  ): Promise<number> {
    const ctx = createOperationContext('sync');
    const deadline = Date.now() + SYNC_TOTAL_TIMEOUT_MS;
    let totalSynced = 0;

    try {
      for (const pid of paranetIds) {
        const dataGraph = paranetDataGraphUri(pid);
        const metaGraph = paranetMetaGraphUri(pid);

        const allQuads: Quad[] = [];
        let offset = 0;
        this.log.info(ctx, `Syncing paranet "${pid}" from ${remotePeerId}`);

        onPhase?.('fetch', 'start');
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (Date.now() > deadline) {
            this.log.warn(ctx, `Sync timeout after ${SYNC_TOTAL_TIMEOUT_MS}ms (${allQuads.length} triples received so far)`);
            break;
          }

          const payload = new TextEncoder().encode(`${pid}|${offset}|${SYNC_PAGE_SIZE}`);

          // Cap per-call timeout so ProtocolRouter.send (3 internal retries) stays within deadline
          const remainingMs = Math.max(0, deadline - Date.now());
          const timeoutMs = Math.min(
            SYNC_PAGE_TIMEOUT_MS,
            Math.max(2000, Math.floor(remainingMs / SYNC_ROUTER_ATTEMPTS)),
          );

          const responseBytes = await withRetry(
            () => this.router.send(remotePeerId, PROTOCOL_SYNC, payload, timeoutMs),
            {
              maxAttempts: SYNC_PAGE_RETRY_ATTEMPTS,
              baseDelayMs: 1000,
              onRetry: (attempt, delay, err) => {
                this.log.warn(ctx, `Sync page retry ${attempt}/${SYNC_PAGE_RETRY_ATTEMPTS} for offset ${offset} (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`);
              },
            },
          );

          const nquadsText = new TextDecoder().decode(responseBytes).trim();
          if (!nquadsText) break;

          const quads = parseNQuads(nquadsText);
          if (quads.length === 0) break;
          allQuads.push(...quads);

          const dataCount = quads.filter(q => q.graph === dataGraph).length;
          offset += dataCount;
          this.log.info(ctx, `  page: ${quads.length} triples received (${allQuads.length} total)`);
          if (dataCount < SYNC_PAGE_SIZE) break;
        }
        onPhase?.('fetch', 'end');

        if (allQuads.length === 0) continue;

        onPhase?.('verify', 'start');
        const dataQuads = allQuads.filter(q => q.graph === dataGraph);
        const metaQuads = allQuads.filter(q => q.graph === metaGraph);

        const isSystemParanet = (Object.values(SYSTEM_PARANETS) as string[]).includes(pid);
        const verified = verifySyncedData(dataQuads, metaQuads, ctx, this.log, isSystemParanet);
        onPhase?.('verify', 'end');

        onPhase?.('store', 'start');
        if (verified.data.length > 0) {
          await this.store.insert(verified.data);
          totalSynced += verified.data.length;
        }
        if (verified.meta.length > 0) {
          await this.store.insert(verified.meta);
          totalSynced += verified.meta.length;
        }
        onPhase?.('store', 'end');

        if (verified.rejected > 0) {
          this.log.warn(ctx, `Rejected ${verified.rejected} KCs with invalid merkle roots from ${remotePeerId}`);
        }
      }
      if (totalSynced > 0) {
        this.log.info(ctx, `Sync complete: ${totalSynced} verified triples from ${remotePeerId}`);
      }
    } catch (err) {
      this.log.warn(ctx, `Sync from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return totalSynced;
  }

  /**
   * Pull workspace graph triples for the given paranets from a remote peer.
   * Workspace data is not merkle-verified (no chain finality) — it is
   * accepted as-is and merged into the local workspace + workspace_meta graphs.
   * The workspaceOwnedEntities set is updated so Rule 4 stays consistent.
   */
  async syncWorkspaceFromPeer(
    remotePeerId: string,
    paranetIds: string[] = [...(this.config.syncParanets ?? [])],
  ): Promise<number> {
    const ctx = createOperationContext('sync');
    const deadline = Date.now() + SYNC_TOTAL_TIMEOUT_MS;
    let totalSynced = 0;

    try {
      for (const pid of paranetIds) {
        const wsGraph = paranetWorkspaceGraphUri(pid);
        const wsMetaGraph = paranetWorkspaceMetaGraphUri(pid);

        const allQuads: Quad[] = [];
        let offset = 0;
        this.log.info(ctx, `Syncing workspace for paranet "${pid}" from ${remotePeerId}`);

        while (true) {
          if (Date.now() > deadline) {
            this.log.warn(ctx, `Workspace sync timeout (${allQuads.length} triples received so far)`);
            break;
          }

          const payload = new TextEncoder().encode(`workspace:${pid}|${offset}|${SYNC_PAGE_SIZE}`);

          const remainingMs = Math.max(0, deadline - Date.now());
          const timeoutMs = Math.min(
            SYNC_PAGE_TIMEOUT_MS,
            Math.max(2000, Math.floor(remainingMs / SYNC_ROUTER_ATTEMPTS)),
          );

          const responseBytes = await withRetry(
            () => this.router.send(remotePeerId, PROTOCOL_SYNC, payload, timeoutMs),
            {
              maxAttempts: SYNC_PAGE_RETRY_ATTEMPTS,
              baseDelayMs: 1000,
              onRetry: (attempt, delay, err) => {
                this.log.warn(ctx, `Workspace sync page retry ${attempt}/${SYNC_PAGE_RETRY_ATTEMPTS} offset=${offset} (delay ${Math.round(delay)}ms): ${err instanceof Error ? err.message : String(err)}`);
              },
            },
          );

          const nquadsText = new TextDecoder().decode(responseBytes).trim();
          if (!nquadsText) break;

          const quads = parseNQuads(nquadsText);
          if (quads.length === 0) break;
          allQuads.push(...quads);

          const wsCount = quads.filter(q => q.graph === wsGraph).length;
          offset += wsCount;
          this.log.info(ctx, `  workspace page: ${quads.length} triples (${allQuads.length} total)`);
          if (wsCount < SYNC_PAGE_SIZE) break;
        }

        if (allQuads.length === 0) continue;

        const wsQuads = allQuads.filter(q => q.graph === wsGraph);
        const wsMetaQuads = allQuads.filter(q => q.graph === wsMetaGraph);

        // Only accept roots from meta subjects that are valid workspace operations (type + publishedAt).
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

        // Validate workspace quads: subject must be an allowed root or skolemized child (root + /.well-known/genid/).
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
          this.log.warn(ctx, `Workspace sync dropped ${dropped} triples with invalid subjects (not in meta rootEntity or skolemized child)`);
        }

        const graphManager = new GraphManager(this.store);
        await graphManager.ensureParanet(pid);

        if (validWsQuads.length > 0) {
          await this.store.insert(validWsQuads);
          totalSynced += validWsQuads.length;
        }
        if (wsMetaQuads.length > 0) {
          await this.store.insert(wsMetaQuads);
          totalSynced += wsMetaQuads.length;
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

        this.log.info(ctx, `Workspace sync for "${pid}": ${validWsQuads.length} data + ${wsMetaQuads.length} meta triples`);
      }
      if (totalSynced > 0) {
        this.log.info(ctx, `Workspace sync complete: ${totalSynced} triples from ${remotePeerId}`);
      }
    } catch (err) {
      this.log.warn(ctx, `Workspace sync from ${remotePeerId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return totalSynced;
  }

  /**
   * Catch up a single paranet from currently connected peers that advertise
   * the sync protocol. Useful after runtime subscribe so historical data is
   * backfilled immediately (not only future gossip messages).
   */
  async syncParanetFromConnectedPeers(
    paranetId: string,
    options?: { includeWorkspace?: boolean },
  ): Promise<{
    connectedPeers: number;
    syncCapablePeers: number;
    peersTried: number;
    dataSynced: number;
    workspaceSynced: number;
  }> {
    const ctx = createOperationContext('sync');
    const includeWorkspace = options?.includeWorkspace ?? false;

    this.trackSyncParanet(paranetId);

    const peers = [...new Map(
      this.node.libp2p.getConnections().map((conn) => [conn.remotePeer.toString(), conn.remotePeer]),
    ).values()];
    let syncCapablePeers = 0;
    let peersTried = 0;
    let dataSynced = 0;
    let workspaceSynced = 0;

    for (const pid of peers) {
      let hasSync = false;
      try {
        const peer = await this.node.libp2p.peerStore.get(pid);
        hasSync = peer.protocols.includes(PROTOCOL_SYNC);
      } catch {
        // Peer metadata might not be available yet; skip silently.
      }
      if (!hasSync) continue;

      syncCapablePeers++;
      peersTried++;
      const remotePeerId = pid.toString();
      dataSynced += await this.syncFromPeer(remotePeerId, [paranetId]);
      if (includeWorkspace) {
        workspaceSynced += await this.syncWorkspaceFromPeer(remotePeerId, [paranetId]);
      }
    }

    this.log.info(
      ctx,
      `Catch-up sync for "${paranetId}": peers=${peersTried}/${syncCapablePeers} data=${dataSynced} workspace=${workspaceSynced}`,
    );

    return {
      connectedPeers: peers.length,
      syncCapablePeers,
      peersTried,
      dataSynced,
      workspaceSynced,
    };
  }

  /**
   * Update the workspace TTL at runtime. Takes effect immediately for queries
   * and the next cleanup cycle without requiring a restart.
   */
  setWorkspaceTtlMs(ttlMs: number): void {
    const oldTtl = this.config.workspaceTtlMs ?? DEFAULT_WORKSPACE_TTL_MS;
    (this.config as any).workspaceTtlMs = ttlMs;

    if (oldTtl <= 0 && ttlMs > 0 && !this.workspaceCleanupTimer) {
      this.cleanupExpiredWorkspace().catch(() => {});
      this.workspaceCleanupTimer = setInterval(() => {
        this.cleanupExpiredWorkspace().catch(() => {});
      }, WORKSPACE_CLEANUP_INTERVAL_MS);
      if (this.workspaceCleanupTimer.unref) this.workspaceCleanupTimer.unref();
    } else if (ttlMs <= 0 && this.workspaceCleanupTimer) {
      clearInterval(this.workspaceCleanupTimer);
      this.workspaceCleanupTimer = null;
    }
  }

  /**
   * Remove expired workspace operations and their data.
   * Queries workspace_meta for operations with publishedAt older than the TTL,
   * deletes the corresponding triples from workspace and workspace_meta,
   * and removes the root entities from workspaceOwnedEntities.
   */
  async cleanupExpiredWorkspace(): Promise<number> {
    const ttl = this.config.workspaceTtlMs ?? DEFAULT_WORKSPACE_TTL_MS;
    if (ttl <= 0) return 0;

    const ctx = createOperationContext('workspace');
    const cutoff = new Date(Date.now() - ttl).toISOString();
    let totalDeleted = 0;

    try {
      const graphManager = new GraphManager(this.store);
      const paranets = await graphManager.listParanets();

      for (const pid of paranets) {
        const wsGraph = paranetWorkspaceGraphUri(pid);
        const wsMetaGraph = paranetWorkspaceMetaGraphUri(pid);
        let paranetDeleted = 0;

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
            paranetDeleted += exactDeleted;
            const childPrefix = `${re}/.well-known/genid/`;
            const childDeleted = await this.store.deleteBySubjectPrefix(wsGraph, childPrefix);
            paranetDeleted += childDeleted;
          }

          // Exact subject delete for this operation's metadata (prefix would match opUri that are prefixes of others, e.g. ...:ws-123 vs ...:ws-1234)
          const metaDeleted = await this.store.deleteByPattern({ graph: wsMetaGraph, subject: opUri });
          paranetDeleted += metaDeleted;

          for (const re of rootEntities) {
            const ownerDeleted = await this.store.deleteByPattern({
              graph: wsMetaGraph, subject: re, predicate: 'http://dkg.io/ontology/workspaceOwner',
            });
            paranetDeleted += ownerDeleted;
          }

          const ownedSet = this.workspaceOwnedEntities.get(pid);
          if (ownedSet) {
            for (const re of rootEntities) {
              ownedSet.delete(re);
            }
          }
        }

        totalDeleted += paranetDeleted;
        if (expiredOps.bindings.length > 0) {
          this.log.info(ctx, `Workspace cleanup for "${pid}": evicted ${expiredOps.bindings.length} expired operation(s), ${paranetDeleted} triples`);
        }
      }
    } catch (err) {
      this.log.warn(ctx, `Workspace cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
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
    await this.broadcastPublish(AGENT_REGISTRY_PARANET, result, profileCtx);

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

  async publish(
    paranetId: string,
    quads: Quad[],
    privateQuads?: Quad[],
    opts?: {
      onPhase?: PhaseCallback;
      operationCtx?: OperationContext;
      accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
      allowedPeers?: string[];
    },
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('publish');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting publish to paranet "${paranetId}" with ${quads.length} triples`);

    const isSystem = paranetId === SYSTEM_PARANETS.AGENTS || paranetId === SYSTEM_PARANETS.ONTOLOGY;
    if (!isSystem) {
      const exists = await this.paranetExists(paranetId);
      if (!exists) {
        throw new Error(
          `Paranet "${paranetId}" does not exist. Create it first with createParanet().`,
        );
      }
    }
    const result = await this.publisher.publish({
      paranetId,
      quads,
      privateQuads,
      publisherPeerId: this.peerId,
      accessPolicy: opts?.accessPolicy,
      allowedPeers: opts?.allowedPeers,
      operationCtx: ctx,
      onPhase,
    });
    onPhase?.('broadcast', 'start');
    this.log.info(ctx, `Local publish complete, broadcasting to peers`);
    await this.broadcastPublish(paranetId, result, ctx);
    onPhase?.('broadcast', 'end');
    this.log.info(ctx, `Publish complete — status=${result.status} kcId=${result.kcId}`);
    return result;
  }

  async update(
    kcId: bigint, paranetId: string, quads: Quad[], privateQuads?: Quad[],
    opts?: { onPhase?: PhaseCallback; operationCtx?: OperationContext },
  ): Promise<PublishResult> {
    const ctx = opts?.operationCtx ?? createOperationContext('update');
    const onPhase = opts?.onPhase;
    this.log.info(ctx, `Starting update of kcId=${kcId} in paranet "${paranetId}" with ${quads.length} triples`);
    const result = await this.publisher.update(kcId, {
      paranetId,
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
        const dataGraph = `did:dkg:paranet:${paranetId}`;
        const nquadsStr = result.publicQuads
          .map((q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${dataGraph}> .`)
          .join('\n');
        const nquadsBytes = new TextEncoder().encode(nquadsStr);
        const message = encodeKAUpdateRequest({
          paranetId,
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
        const topic = paranetUpdateTopic(paranetId);
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
   * Write quads to the paranet's workspace graph (no chain, no TRAC).
   * When localOnly is false (default), replicates via GossipSub workspace topic.
   * When localOnly is true, stores locally without broadcasting — use for private data.
   */
  async writeToWorkspace(paranetId: string, quads: Quad[], opts?: { localOnly?: boolean; operationCtx?: OperationContext }): Promise<{ workspaceOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('workspace');
    this.log.info(ctx, `Writing ${quads.length} quads to workspace for paranet ${paranetId}${opts?.localOnly ? ' (local-only)' : ''}`);
    const { workspaceOperationId, message } = await this.publisher.writeToWorkspace(paranetId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
    });
    if (!opts?.localOnly) {
      const topic = paranetWorkspaceTopic(paranetId);
      try {
        await this.gossip.publish(topic, message);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }
    }
    return { workspaceOperationId };
  }

  /**
   * Compare-and-swap workspace write. Verifies each condition against the
   * current workspace graph before applying the write atomically.
   * Throws StaleWriteError if any condition fails.
   */
  async writeConditionalToWorkspace(
    paranetId: string,
    quads: Quad[],
    conditions: CASCondition[],
    opts?: { localOnly?: boolean; operationCtx?: OperationContext },
  ): Promise<{ workspaceOperationId: string }> {
    const ctx = opts?.operationCtx ?? createOperationContext('workspace');
    this.log.info(ctx, `CAS write: ${quads.length} quads, ${conditions.length} conditions for ${paranetId}`);
    const { workspaceOperationId, message } = await this.publisher.writeConditionalToWorkspace(paranetId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
      conditions,
    });
    if (!opts?.localOnly) {
      const topic = paranetWorkspaceTopic(paranetId);
      try {
        await this.gossip.publish(topic, message);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }
    }
    return { workspaceOperationId };
  }

  /**
   * Enshrine workspace content: read from workspace graph and publish with full finality (data graph + chain).
   * After on-chain confirmation, broadcasts a lightweight FinalizationMessage so peers with matching
   * workspace state can promote it to canonical without re-downloading the full payload.
   */
  async enshrineFromWorkspace(
    paranetId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: {
      clearWorkspaceAfter?: boolean;
      operationCtx?: OperationContext;
      onPhase?: PhaseCallback;
      contextGraphId?: string | bigint;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('enshrine');
    const ctxGraphIdStr = options?.contextGraphId != null ? String(options.contextGraphId) : undefined;

    const result = await this.publisher.enshrineFromWorkspace(paranetId, selection, {
      operationCtx: ctx,
      clearWorkspaceAfter: options?.clearWorkspaceAfter,
      onPhase: options?.onPhase,
      contextGraphId: ctxGraphIdStr,
      contextGraphSignatures: options?.contextGraphSignatures,
    });

    if (result.status === 'confirmed' && result.onChainResult) {
      const rootEntities = result.kaManifest.map(ka => ka.rootEntity);

      const msg: FinalizationMessageMsg = {
        ual: result.ual,
        paranetId,
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
      };

      const topic = paranetFinalizationTopic(paranetId);
      try {
        await this.gossip.publish(topic, encodeFinalizationMessage(msg));
        this.log.info(ctx, `Broadcast finalization for ${result.ual} to ${topic}${ctxGraphIdStr ? ` (contextGraph=${ctxGraphIdStr})` : ''}${result.contextGraphError ? ' (ctx-graph registration failed, omitting contextGraphId)' : ''}`);
      } catch {
        this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
      }
    }

    return result;
  }

  /**
   * Create a new context graph on-chain.
   * A context graph is a bounded, M/N signature-gated subgraph within a paranet.
   */
  async createContextGraph(params: CreateContextGraphParams): Promise<CreateContextGraphResult> {
    const ctx = createOperationContext('system');
    if (typeof this.chain.createContextGraph !== 'function') {
      throw new Error('createContextGraph not available on chain adapter');
    }
    const result = await this.chain.createContextGraph(params);
    this.log.info(ctx, `Created context graph ${result.contextGraphId} (M=${params.requiredSignatures}, N=${params.participantIdentityIds.length})`);
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
    if (typeof this.chain.addBatchToContextGraph !== 'function') {
      throw new Error('addBatchToContextGraph not available on chain adapter');
    }

    let merkleRoot = params.merkleRoot;
    if (!merkleRoot) {
      const batch = (this.chain as any).getBatch?.(params.batchId);
      if (!batch?.merkleRoot) {
        throw new Error(
          `Cannot resolve merkle root for batch ${params.batchId}. ` +
          `Provide merkleRoot explicitly or use a chain adapter that supports getBatch.`,
        );
      }
      merkleRoot = batch.merkleRoot;
    }

    const result = await this.chain.addBatchToContextGraph({
      contextGraphId: BigInt(params.contextGraphId),
      batchId: params.batchId,
      merkleRoot: merkleRoot!,
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
    const ctx = createOperationContext('system');
    let identityId = 0n;
    try {
      identityId = await this.chain.getIdentityId();
      if (identityId === 0n) {
        this.log.info(ctx, 'ensureIdentity: no on-chain identity, creating profile...');
        identityId = await this.chain.ensureProfile({ nodeName: this.config.name });
        this.log.info(ctx, `ensureIdentity: profile created, identityId=${identityId}`);
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
    options?: string | { paranetId?: string; graphSuffix?: '_workspace'; includeWorkspace?: boolean; operationCtx?: OperationContext },
  ) {
    const opts = typeof options === 'string' ? { paranetId: options } : options ?? {};
    const ctx = opts.operationCtx ?? createOperationContext('query');
    this.log.info(ctx, `Query on paranet="${opts.paranetId ?? 'all'}" sparql="${sparql.slice(0, 80)}"`);
    const result = await this.queryEngine.query(sparql, {
      paranetId: opts.paranetId,
      graphSuffix: opts.graphSuffix,
      includeWorkspace: opts.includeWorkspace,
    });
    this.log.info(ctx, `Query returned ${result.bindings?.length ?? 0} bindings`);
    return result;
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
   * Find entities of a given RDF type on a remote peer's paranet.
   */
  async findEntitiesByType(
    peerId: string,
    paranetId: string,
    rdfType: string,
    limit?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITIES_BY_TYPE',
      paranetId,
      rdfType,
      limit,
    });
  }

  /**
   * Get all triples for a specific entity from a remote peer's paranet.
   */
  async getEntityTriples(
    peerId: string,
    paranetId: string,
    entityUri: string,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'ENTITY_TRIPLES',
      paranetId,
      entityUri,
    });
  }

  /**
   * Run a SPARQL query on a remote peer (if they allow it).
   */
  async queryRemoteSparql(
    peerId: string,
    paranetId: string,
    sparql: string,
    limit?: number,
    timeout?: number,
  ): Promise<QueryResponse> {
    return this.queryRemote(peerId, {
      lookupType: 'SPARQL_QUERY',
      paranetId,
      sparql,
      limit,
      timeout,
    });
  }

  subscribeToParanet(paranetId: string, options?: { trackSyncScope?: boolean }): void {
    if (options?.trackSyncScope !== false) {
      this.trackSyncParanet(paranetId);
    }

    // Idempotent: skip if gossip handlers already installed for this paranet
    if (this.gossipRegistered.has(paranetId)) {
      const existing = this.subscribedParanets.get(paranetId);
      if (!existing?.subscribed) {
        this.subscribedParanets.set(paranetId, { ...existing, subscribed: true, synced: existing?.synced ?? false });
      }
      return;
    }
    this.gossipRegistered.add(paranetId);

    const publishTopic = paranetPublishTopic(paranetId);
    const workspaceTopic = paranetWorkspaceTopic(paranetId);
    const appTopic = paranetAppTopic(paranetId);

    this.gossip.subscribe(publishTopic);
    this.gossip.subscribe(workspaceTopic);
    this.gossip.subscribe(appTopic);

    const existing = this.subscribedParanets.get(paranetId);
    this.subscribedParanets.set(paranetId, { ...existing, subscribed: true, synced: existing?.synced ?? false });

    this.gossip.onMessage(publishTopic, async (_topic, data) => {
      const gph = this.getOrCreateGossipPublishHandler();
      await gph.handlePublishMessage(data, paranetId);
    });

    this.gossip.onMessage(workspaceTopic, async (_topic, data, from) => {
      const wh = this.getOrCreateWorkspaceHandler();
      await wh.handle(data, from);
    });

    const updateTopic = paranetUpdateTopic(paranetId);
    this.gossip.subscribe(updateTopic);
    this.gossip.onMessage(updateTopic, async (_topic, data, from) => {
      const uh = this.getOrCreateUpdateHandler();
      await uh.handle(data, from);
    });

    const finalizationTopic = paranetFinalizationTopic(paranetId);
    this.gossip.subscribe(finalizationTopic);
    this.gossip.onMessage(finalizationTopic, async (_topic, data) => {
      const fh = this.getOrCreateFinalizationHandler();
      await fh.handleFinalizationMessage(data, paranetId);
    });
  }

  /**
   * Add a paranet to runtime sync scope so sync-on-connect includes it.
   * System paranets are already included by default and are skipped here.
   */
  private trackSyncParanet(paranetId: string): void {
    const systemParanets = new Set<string>(Object.values(SYSTEM_PARANETS) as string[]);
    if (systemParanets.has(paranetId)) return;

    const syncSet = new Set<string>(this.config.syncParanets ?? []);
    if (syncSet.has(paranetId)) return;
    syncSet.add(paranetId);
    this.config.syncParanets = [...syncSet];
  }

  private getOrCreateGossipPublishHandler(): GossipPublishHandler {
    if (!this.gossipPublishHandler) {
      this.gossipPublishHandler = new GossipPublishHandler(
        this.store,
        this.chain.chainId === 'none' ? undefined : this.chain,
        this.subscribedParanets,
        {
          paranetExists: (id) => this.paranetExists(id),
          subscribeToParanet: (id, options) => this.subscribeToParanet(id, options),
        },
      );
    }
    return this.gossipPublishHandler;
  }

  private getOrCreateWorkspaceHandler(): WorkspaceHandler {
    if (!this.workspaceHandler) {
      this.workspaceHandler = new WorkspaceHandler(this.store, this.eventBus, {
        workspaceOwnedEntities: this.workspaceOwnedEntities,
        writeLocks: this.writeLocks,
      });
    }
    return this.workspaceHandler;
  }

  private updateHandler?: UpdateHandler;

  private getOrCreateUpdateHandler(): UpdateHandler {
    if (!this.updateHandler) {
      this.updateHandler = new UpdateHandler(this.store, this.chain, this.eventBus, {
        knownBatchParanets: this.publisher.knownBatchParanets,
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
   * Create a paranet by registering it on-chain (if a chain adapter is
   * available) and publishing its definition triples into the system
   * ontology paranet.
   *
   * On-chain registration is privacy-preserving by default: only
   * keccak256(bytes(name)) is stored. Set revealOnChain to also publish
   * cleartext name and description to the contract.
   *
   * If the paranet already exists on-chain (another node registered it
   * first), the local definition is created without a chain call.
   */
  async createParanet(opts: {
    id: string;
    name: string;
    description?: string;
    replicationPolicy?: string;
    accessPolicy?: number;
    revealOnChain?: boolean;
    /** When true, skips on-chain registration, gossip subscription, and broadcast. Data stays local-only. */
    private?: boolean;
  }): Promise<void> {
    const ctx = createOperationContext('system');
    const gm = new GraphManager(this.store);
    const paranetUri = paranetDataGraphUri(opts.id);
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const now = new Date().toISOString();

    const exists = await this.paranetExists(opts.id);
    if (exists) {
      throw new Error(`Paranet "${opts.id}" already exists`);
    }

    // Register on chain if a real chain adapter is configured.
    // Private paranets skip on-chain registration and gossip entirely.
    let onChainId: string | undefined;
    if (opts.private) {
      this.log.info(ctx, `Creating private paranet "${opts.id}" (local-only, no chain, no gossip)`);
    } else if (this.chain.chainId !== 'none') {
      try {
        const result = await this.chain.createParanet({
          name: opts.id,
          description: opts.description,
          accessPolicy: opts.accessPolicy ?? 0,
          revealOnChain: opts.revealOnChain,
        });
        onChainId = result.paranetId;
        this.log.info(ctx, `Paranet "${opts.id}" registered on-chain: ${onChainId}`);
      } catch (err) {
        const errorName = enrichEvmError(err);
        const msg = err instanceof Error ? err.message : String(err);
        if (errorName === 'ParanetAlreadyExists' || msg.includes('ParanetAlreadyExists') || msg.includes('already exists')) {
          this.log.info(ctx, `Paranet "${opts.id}" already registered on-chain — creating local definition`);
        } else {
          this.log.warn(ctx, `On-chain paranet registration failed: ${msg} — creating locally without chain finality`);
        }
      }
    }

    const quads: Quad[] = [
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${this.peerId}`, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${paranetPublishTopic(opts.id)}"`, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"${opts.replicationPolicy ?? 'full'}"`, graph: ontologyGraph },
    ];

    if (onChainId) {
      quads.push({
        subject: paranetUri,
        predicate: `${DKG_ONTOLOGY.DKG_PARANET}OnChainId`,
        object: `"${onChainId}"`,
        graph: ontologyGraph,
      });
    }

    if (opts.description) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: ontologyGraph,
      });
    }

    // Provenance activity
    const activityUri = `did:dkg:activity:create-paranet:${opts.id}:${Date.now()}`;
    quads.push(
      { subject: paranetUri, predicate: DKG_ONTOLOGY.PROV_GENERATED_BY, object: activityUri, graph: ontologyGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.PROV_ACTIVITY, graph: ontologyGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ASSOCIATED_WITH, object: `did:dkg:agent:${this.peerId}`, graph: ontologyGraph },
      { subject: activityUri, predicate: DKG_ONTOLOGY.PROV_ENDED_AT_TIME, object: `"${now}"`, graph: ontologyGraph },
    );

    // Insert the definition triples
    await this.store.insert(quads);

    // Create the actual named graphs for the paranet
    await gm.ensureParanet(opts.id);

    this.subscribedParanets.set(opts.id, {
      name: opts.name,
      subscribed: !opts.private,
      synced: true,
      onChainId: onChainId,
    });

    if (!opts.private) {
      // Auto-subscribe to the new paranet's GossipSub topic
      this.subscribeToParanet(opts.id);

      // Broadcast via the ontology paranet so other nodes learn about it
      const ontologyTopic = paranetPublishTopic(SYSTEM_PARANETS.ONTOLOGY);
      const nquads = quads.map(q => {
        const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
        return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
      }).join('\n');

      const msg = encodePublishRequest({
        ual: `did:dkg:paranet:${opts.id}`,
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

  /**
   * Idempotent "ensure" variant of createParanet for boot-time defaults.
   * If the paranet already exists locally, just ensures GossipSub subscription
   * and registry entry. If not, inserts definition triples and optionally
   * registers on-chain (or gracefully handles "already exists" on-chain).
   * Unlike createParanet(), this never throws for duplicates and avoids
   * re-claiming creator if the paranet is already on-chain.
   */
  async ensureParanetLocal(opts: {
    id: string;
    name: string;
    description?: string;
    revealOnChain?: boolean;
  }): Promise<void> {
    const ctx = createOperationContext('system');

    const exists = await this.paranetExists(opts.id);
    if (exists) {
      // Already synced locally — just make sure we're subscribed
      this.subscribeToParanet(opts.id);
      this.subscribedParanets.set(opts.id, {
        name: opts.name,
        subscribed: true,
        synced: true,
        onChainId: this.subscribedParanets.get(opts.id)?.onChainId,
      });
      return;
    }

    // Not yet in local store — try chain registration (idempotent)
    let onChainId: string | undefined;
    let alreadyOnChain = false;
    if (this.chain.chainId !== 'none') {
      try {
        const result = await this.chain.createParanet({
          name: opts.id,
          description: opts.description,
          accessPolicy: 0,
          revealOnChain: opts.revealOnChain,
        });
        onChainId = result.paranetId;
        this.log.info(ctx, `Paranet "${opts.id}" registered on-chain: ${onChainId}`);
      } catch (err) {
        const errorName = enrichEvmError(err);
        const msg = err instanceof Error ? err.message : String(err);
        if (errorName === 'ParanetAlreadyExists' || msg.includes('ParanetAlreadyExists') || msg.includes('already exists')) {
          alreadyOnChain = true;
          onChainId = ethers.keccak256(ethers.toUtf8Bytes(opts.id));
          this.log.info(ctx, `Paranet "${opts.id}" already on-chain (${onChainId.slice(0, 16)}…) — creating local definition`);
        } else {
          this.log.warn(ctx, `On-chain registration for "${opts.id}" failed: ${msg}`);
        }
      }
    }

    // Insert local definition triples. Use "network" as creator when the
    // paranet already existed on-chain (avoid every node claiming creator).
    const gm = new GraphManager(this.store);
    const paranetUri = paranetDataGraphUri(opts.id);
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const now = new Date().toISOString();
    const creator = alreadyOnChain ? 'did:dkg:network' : `did:dkg:agent:${this.peerId}`;

    const quads: Quad[] = [
      { subject: paranetUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_PARANET, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.SCHEMA_NAME, object: `"${opts.name}"`, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: creator, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: `"${now}"`, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_GOSSIP_TOPIC, object: `"${paranetPublishTopic(opts.id)}"`, graph: ontologyGraph },
      { subject: paranetUri, predicate: DKG_ONTOLOGY.DKG_REPLICATION_POLICY, object: `"full"`, graph: ontologyGraph },
    ];

    if (onChainId) {
      quads.push({
        subject: paranetUri,
        predicate: `${DKG_ONTOLOGY.DKG_PARANET}OnChainId`,
        object: `"${onChainId}"`,
        graph: ontologyGraph,
      });
    }

    if (opts.description) {
      quads.push({
        subject: paranetUri,
        predicate: DKG_ONTOLOGY.SCHEMA_DESCRIPTION,
        object: `"${opts.description}"`,
        graph: ontologyGraph,
      });
    }

    await this.store.insert(quads);
    await gm.ensureParanet(opts.id);

    this.subscribeToParanet(opts.id);
    this.subscribedParanets.set(opts.id, {
      name: opts.name,
      subscribed: true,
      synced: true,
      onChainId,
    });

    this.log.info(ctx, `Ensured paranet "${opts.id}" locally (creator=${alreadyOnChain ? 'network' : 'self'})`);

    // Broadcast so peers learn about it
    const ontologyTopic = paranetPublishTopic(SYSTEM_PARANETS.ONTOLOGY);
    const nquads = quads.map(q => {
      const obj = q.object.startsWith('"') ? q.object : `<${q.object}>`;
      return `<${q.subject}> <${q.predicate}> ${obj} <${q.graph}> .`;
    }).join('\n');

    const msg = encodePublishRequest({
      ual: `did:dkg:paranet:${opts.id}`,
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
      // No peers subscribed — ok during boot
    }
  }

  /**
   * Check whether a paranet is registered (definition triples exist in the
   * ontology graph). Always store-backed to avoid false positives from
   * in-memory state that may not have been persisted yet.
   */
  async paranetExists(paranetId: string): Promise<boolean> {
    const paranetUri = paranetDataGraphUri(paranetId);
    const result = await this.store.query(
      `SELECT ?p WHERE {
        GRAPH ?g { <${paranetUri}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> }
      } LIMIT 1`,
    );
    return result.type === 'bindings' && result.bindings.length > 0;
  }

  /**
   * List all known paranets by merging the subscription registry with
   * SPARQL-discovered definition triples. Returns enriched entries with
   * `subscribed` and `synced` flags.
   */
  async listParanets(): Promise<Array<{
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
      SELECT ?paranet ?name ?desc ?creator ?created ?isSystem WHERE {
        {
          GRAPH <${ontologyGraph}> {
            ?paranet <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_PARANET}> . BIND(true AS ?isSystem) }
          }
        } UNION {
          GRAPH <${agentsGraph}> {
            ?paranet <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.SCHEMA_DESCRIPTION}> ?desc }
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.DKG_CREATOR}> ?creator }
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.DKG_CREATED_AT}> ?created }
            OPTIONAL { ?paranet <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_SYSTEM_PARANET}> . BIND(true AS ?isSystem) }
          }
        }
      }
    `);

    const prefix = 'did:dkg:paranet:';
    const seen = new Map<string, {
      id: string; uri: string; name: string; description?: string;
      creator?: string; createdAt?: string; isSystem: boolean;
      subscribed: boolean; synced: boolean;
    }>();

    if (result.type === 'bindings') {
      for (const row of result.bindings as Record<string, string>[]) {
        const uri = row['paranet'] ?? '';
        if (seen.has(uri)) continue;
        const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
        const sub = this.subscribedParanets.get(id);
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

    // Add registry entries that don't have triples yet (subscribed but not synced)
    for (const [id, sub] of this.subscribedParanets) {
      const uri = `${prefix}${id}`;
      if (seen.has(uri)) continue;
      if (id === SYSTEM_PARANETS.AGENTS || id === SYSTEM_PARANETS.ONTOLOGY) continue;
      seen.set(uri, {
        id,
        uri,
        name: sub.name ?? id,
        isSystem: false,
        subscribed: sub.subscribed,
        synced: sub.synced,
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

  /** Returns a snapshot of the paranet subscription registry. */
  getSubscribedParanets(): ReadonlyMap<string, ParanetSub> {
    return this.subscribedParanets;
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
   * Scan the local ONTOLOGY graph for paranet definitions and auto-subscribe
   * to any that aren't yet in the subscription registry. Called after
   * syncFromPeer to catch paranets discovered via ONTOLOGY sync.
   */
  async discoverParanetsFromStore(): Promise<number> {
    const ctx = createOperationContext('system');
    const ontologyGraph = paranetDataGraphUri(SYSTEM_PARANETS.ONTOLOGY);
    const prefix = 'did:dkg:paranet:';
    let discovered = 0;

    const result = await this.store.query(`
      SELECT ?paranet ?name WHERE {
        GRAPH <${ontologyGraph}> {
          ?paranet <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_PARANET}> .
          OPTIONAL { ?paranet <${DKG_ONTOLOGY.SCHEMA_NAME}> ?name }
        }
      }
    `);

    if (result.type !== 'bindings') return 0;

    for (const row of result.bindings as Record<string, string>[]) {
      const uri = row['paranet'] ?? '';
      const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
      if (!id) continue;

      if (id === SYSTEM_PARANETS.AGENTS || id === SYSTEM_PARANETS.ONTOLOGY) continue;

      const existing = this.subscribedParanets.get(id);
      if (existing?.subscribed && existing?.synced) continue;

      const name = row['name'] ? stripLiteral(row['name']) : id;
      this.subscribedParanets.set(id, {
        name,
        subscribed: true,
        synced: true,
        onChainId: existing?.onChainId,
      });

      if (!existing?.subscribed) {
        this.subscribeToParanet(id, { trackSyncScope: false });
      }

      this.log.info(ctx, `Discovered paranet "${name}" (${id}) from store — auto-subscribed`);
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Auto-subscribed to ${discovered} new paranet(s) from store`);
    }
    return discovered;
  }

  /**
   * Query the on-chain ParanetV9Registry for all registered paranets and
   * auto-subscribe to any not yet in the subscription registry.
   * Returns the number of newly discovered paranets.
   */
  async discoverParanetsFromChain(): Promise<number> {
    const ctx = createOperationContext('system');
    if (!this.chain.listParanetsFromChain) {
      this.log.info(ctx, 'Chain adapter does not support listParanetsFromChain — skipping');
      return 0;
    }

    let onChainParanets;
    try {
      onChainParanets = await this.chain.listParanetsFromChain();
    } catch (err) {
      this.log.warn(ctx, `Chain paranet scan failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }

    // Build a set of all known on-chain IDs (stored and computed) for fast dedup
    const knownOnChainIds = new Set<string>();
    for (const [localId, sub] of this.subscribedParanets) {
      if (sub.onChainId) knownOnChainIds.add(sub.onChainId);
      // Also compute expected hash for locally-known paranet IDs
      knownOnChainIds.add(ethers.keccak256(ethers.toUtf8Bytes(localId)));
    }

    let discovered = 0;
    for (const p of onChainParanets) {
      if (knownOnChainIds.has(p.paranetId)) continue;

      if (!p.name) {
        // Hash-only entry (metadata not revealed) — record for dedup but don't
        // subscribe to gossip topics since hash-keyed topics are unusable.
        this.log.info(ctx, `Noted unresolved on-chain paranet ${p.paranetId.slice(0, 16)}… (no metadata)`);
        knownOnChainIds.add(p.paranetId);
        continue;
      }

      this.subscribedParanets.set(p.name, {
        name: p.name,
        subscribed: true,
        synced: false,
        onChainId: p.paranetId,
      });
      this.subscribeToParanet(p.name, { trackSyncScope: false });
      this.log.info(ctx, `Discovered on-chain paranet "${p.name}" (${p.paranetId.slice(0, 16)}…) — auto-subscribed (synced=false)`);
      discovered++;
    }

    if (discovered > 0) {
      this.log.info(ctx, `Discovered ${discovered} new paranet(s) from chain`);
    }
    return discovered;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.chainPoller) {
      this.chainPoller.stop();
      this.chainPoller = null;
    }
    if (this.workspaceCleanupTimer) {
      clearInterval(this.workspaceCleanupTimer);
      this.workspaceCleanupTimer = null;
    }
    await this.node.stop();
    this.started = false;
  }

  /**
   * Loads genesis knowledge into the triple store if not already present.
   * Creates the system paranet graphs and inserts the genesis quads.
   */
  private static async loadGenesis(store: TripleStore): Promise<void> {
    const gm = new GraphManager(store);

    // Ensure system paranets exist
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

  private async broadcastPublish(paranetId: string, result: PublishResult, ctx: OperationContext): Promise<void> {
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
      paranetId,
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
    });

    const topic = paranetPublishTopic(paranetId);
    this.log.info(ctx, `Broadcasting to topic ${topic}`);
    try {
      await this.gossip.publish(topic, msg);
    } catch {
      this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
    }
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
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
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
          log.debug(ctx, `Merkle mismatch for ${kcUal} (system paranet, accepted): claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
          rejected++;
        } else {
          log.warn(ctx, `Merkle mismatch for ${kcUal}: claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
          rejected++;
        }
      } else if (acceptUnverified) {
        log.debug(ctx, `Merkle mismatch for ${kcUal} (system paranet, accepted): claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
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

  // When acceptUnverified is set (system paranets), accept all data
  // rather than dropping profiles that fail merkle verification.
  if (acceptUnverified && rejected > 0 && verifiedKcUals.size < kcMerkleRoots.size) {
    log.debug(ctx, `Accepting ${rejected} unverified KC(s) (system paranet)`);
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
