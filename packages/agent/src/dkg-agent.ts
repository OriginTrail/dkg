import {
  DKGNode, ProtocolRouter, GossipSubManager, TypedEventBus,
  PROTOCOL_ACCESS, PROTOCOL_PUBLISH, PROTOCOL_SYNC, PROTOCOL_QUERY_REMOTE,
  paranetPublishTopic, paranetWorkspaceTopic, paranetDataGraphUri, paranetMetaGraphUri,
  encodePublishRequest, decodePublishRequest,
  getGenesisQuads, computeNetworkId, SYSTEM_PARANETS, DKG_ONTOLOGY,
  Logger, createOperationContext, MerkleTree, withRetry,
  type DKGNodeConfig, type OperationContext,
} from '@dkg/core';
import { GraphManager, createTripleStore, type TripleStore, type TripleStoreConfig, type Quad } from '@dkg/storage';
import { EVMChainAdapter, NoChainAdapter, type EVMAdapterConfig, type ChainAdapter, type EventFilter } from '@dkg/chain';
import {
  DKGPublisher, PublishHandler, WorkspaceHandler, ChainEventPoller, AccessHandler, AccessClient,
  computeTripleHash, computePublicRoot, computeKARoot, computeKCRoot, autoPartition,
  generateTentativeMetadata, generateKCMetadata, getConfirmedStatusQuad,
  type PublishResult, type PhaseCallback, type KAMetadata,
} from '@dkg/publisher';
import { ethers } from 'ethers';
import {
  DKGQueryEngine, QueryHandler,
  type QueryRequest, type QueryResponse, type QueryAccessConfig, type LookupType,
} from '@dkg/query';
import { DKGAgentWallet, type AgentWallet } from './agent-wallet.js';
import { ProfileManager } from './profile-manager.js';
import { DiscoveryClient, type SkillSearchOptions, type DiscoveredAgent, type DiscoveredOffering } from './discovery.js';
import { MessageHandler, type SkillHandler, type SkillRequest, type SkillResponse, type ChatHandler } from './messaging.js';
import { ed25519ToX25519Private, ed25519ToX25519Public } from './encryption.js';
import { AGENT_REGISTRY_PARANET, type AgentProfileConfig } from './profile.js';
import { multiaddr } from '@multiformats/multiaddr';

const SYNC_PAGE_SIZE = 500;
const SYNC_PAGE_RETRY_ATTEMPTS = 3;
const SYNC_TOTAL_TIMEOUT_MS = 120_000;

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
  /** Shared workspace-owned root entities per paranet (Rule 4). Used by publisher and workspace handler. */
  private readonly workspaceOwnedEntities: Map<string, Set<string>>;
  private workspaceHandler?: WorkspaceHandler;
  private readonly log = new Logger('DKGAgent');

  private messageHandler: MessageHandler | null = null;
  private chainPoller: ChainEventPoller | null = null;
  private readonly config: DKGAgentConfig;
  private started = false;

  private constructor(
    config: DKGAgentConfig,
    wallet: DKGAgentWallet,
    node: DKGNode,
    store: TripleStore,
    publisher: DKGPublisher,
    queryEngine: DKGQueryEngine,
    eventBus: TypedEventBus,
    chain: ChainAdapter,
    workspaceOwnedEntities: Map<string, Set<string>>,
  ) {
    this.config = config;
    this.wallet = wallet;
    this.node = node;
    this.store = store;
    this.publisher = publisher;
    this.queryEngine = queryEngine;
    this.workspaceOwnedEntities = workspaceOwnedEntities;
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
    const workspaceOwnedEntities = new Map<string, Set<string>>();
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: opKeys?.[0],
      workspaceOwnedEntities,
    });
    const queryEngine = new DKGQueryEngine(store);

    return new DKGAgent(
      config, wallet, node, store, publisher, queryEngine, eventBus, chain,
      workspaceOwnedEntities,
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

    const publishHandler = new PublishHandler(this.store, this.eventBus);
    this.router.register(PROTOCOL_PUBLISH, publishHandler.handler);

    // Register cross-agent query handler
    const queryAccessConfig: QueryAccessConfig = this.config.queryAccess ?? {
      defaultPolicy: 'public',
    };
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
    // Response includes both the data graph and the meta graph so the
    // receiver can verify merkle roots before inserting.
    this.router.register(PROTOCOL_SYNC, async (data) => {
      const text = new TextDecoder().decode(data).trim();
      const [paranetPart, offsetStr, limitStr] = text.split('|');
      const paranetId = paranetPart || SYSTEM_PARANETS.AGENTS;
      const offset = parseInt(offsetStr, 10) || 0;
      const limit = Math.min(parseInt(limitStr, 10) || SYNC_PAGE_SIZE, SYNC_PAGE_SIZE);

      const dataGraph = paranetDataGraphUri(paranetId);
      const metaGraph = paranetMetaGraphUri(paranetId);
      const nquads: string[] = [];

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

      // Include the full meta graph on the first page so the receiver
      // can verify merkle roots. On subsequent pages it's redundant but
      // small enough to re-send.
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
    const trySyncFromPeer = async (remotePeer: string) => {
      const shortPeer = remotePeer.slice(-8);
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const pid = peerIdFromString(remotePeer);
        const peer = await this.node.libp2p.peerStore.get(pid);
        const hasSync = peer.protocols.includes(PROTOCOL_SYNC);
        if (!hasSync) {
          this.log.info(ctx, `Peer ${shortPeer} does not support sync protocol (protocols: ${peer.protocols.join(', ')})`);
          return;
        }
        this.log.info(ctx, `Syncing agents paranet from peer ${shortPeer}...`);
        const synced = await this.syncFromPeer(remotePeer);
        this.log.info(ctx, `Synced ${synced} triples from peer ${shortPeer}`);
      } catch (err: any) {
        this.log.warn(ctx, `Sync-on-connect failed for ${shortPeer}: ${err.message}`);
      }
    };

    this.node.libp2p.addEventListener('peer:connect', (evt) => {
      const remotePeer = evt.detail.toString();
      setTimeout(() => trySyncFromPeer(remotePeer), 3000);
    });

    // Sync from peers already connected (e.g. relay dialed during node.start())
    const alreadyConnected = this.node.libp2p.getPeers();
    for (const pid of alreadyConnected) {
      setTimeout(() => trySyncFromPeer(pid.toString()), 3000);
    }
  }

  /**
   * Pull all triples for the given paranets from a remote peer and merge
   * them into our local store. Used on peer:connect for initial catch-up.
   */
  /**
   * Pull triples for the given paranets from a remote peer in pages,
   * verify merkle roots against the KC metadata, and only insert
   * triples that pass verification.
   */
  async syncFromPeer(
    remotePeerId: string,
    paranetIds: string[] = [SYSTEM_PARANETS.AGENTS],
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

        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (Date.now() > deadline) {
            this.log.warn(ctx, `Sync timeout after ${SYNC_TOTAL_TIMEOUT_MS}ms (${allQuads.length} triples received so far)`);
            break;
          }

          const payload = new TextEncoder().encode(`${pid}|${offset}|${SYNC_PAGE_SIZE}`);

          const responseBytes = await withRetry(
            () => this.router.send(remotePeerId, PROTOCOL_SYNC, payload),
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

        if (allQuads.length === 0) continue;

        const dataQuads = allQuads.filter(q => q.graph === dataGraph);
        const metaQuads = allQuads.filter(q => q.graph === metaGraph);

        const isSystemParanet = (Object.values(SYSTEM_PARANETS) as string[]).includes(pid);
        const verified = verifySyncedData(dataQuads, metaQuads, ctx, this.log, isSystemParanet);

        if (verified.data.length > 0) {
          await this.store.insert(verified.data);
          totalSynced += verified.data.length;
        }
        if (verified.meta.length > 0) {
          await this.store.insert(verified.meta);
          totalSynced += verified.meta.length;
        }

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
    opts?: { onPhase?: PhaseCallback },
  ): Promise<PublishResult> {
    const ctx = createOperationContext('publish');
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
    const result = await this.publisher.publish({ paranetId, quads, privateQuads, operationCtx: ctx, onPhase });
    onPhase?.('broadcast', 'start');
    this.log.info(ctx, `Local publish complete, broadcasting to peers`);
    await this.broadcastPublish(paranetId, result, ctx);
    onPhase?.('broadcast', 'end');
    this.log.info(ctx, `Publish complete — status=${result.status} kcId=${result.kcId}`);
    return result;
  }

  async update(kcId: bigint, paranetId: string, quads: Quad[], privateQuads?: Quad[]): Promise<PublishResult> {
    const ctx = createOperationContext('publish');
    this.log.info(ctx, `Starting update of kcId=${kcId} in paranet "${paranetId}" with ${quads.length} triples`);
    const result = await this.publisher.update(kcId, { paranetId, quads, privateQuads, operationCtx: ctx });
    this.log.info(ctx, `Update complete — status=${result.status}`);
    return result;
  }

  /**
   * Write quads to the paranet's workspace graph (no chain, no TRAC). Replicates via GossipSub workspace topic.
   */
  async writeToWorkspace(paranetId: string, quads: Quad[]): Promise<{ workspaceOperationId: string }> {
    const ctx = createOperationContext('workspace');
    this.log.info(ctx, `Writing ${quads.length} quads to workspace for paranet ${paranetId}`);
    const { workspaceOperationId, message } = await this.publisher.writeToWorkspace(paranetId, quads, {
      publisherPeerId: this.node.peerId.toString(),
      operationCtx: ctx,
    });
    const topic = paranetWorkspaceTopic(paranetId);
    try {
      await this.gossip.publish(topic, message);
    } catch {
      this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
    }
    return { workspaceOperationId };
  }

  /**
   * Enshrine workspace content: read from workspace graph and publish with full finality (data graph + chain).
   */
  async enshrineFromWorkspace(
    paranetId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: { clearWorkspaceAfter?: boolean },
  ): Promise<PublishResult> {
    return this.publisher.enshrineFromWorkspace(paranetId, selection, {
      operationCtx: createOperationContext('enshrine'),
      clearWorkspaceAfter: options?.clearWorkspaceAfter,
    });
  }

  async query(
    sparql: string,
    options?: string | { paranetId?: string; graphSuffix?: '_workspace'; includeWorkspace?: boolean },
  ) {
    const opts = typeof options === 'string' ? { paranetId: options } : options ?? {};
    const ctx = createOperationContext('query');
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

  subscribeToParanet(paranetId: string): void {
    const publishTopic = paranetPublishTopic(paranetId);
    const workspaceTopic = paranetWorkspaceTopic(paranetId);

    this.gossip.subscribe(publishTopic);
    this.gossip.subscribe(workspaceTopic);

    this.gossip.onMessage(publishTopic, async (_topic, data) => {
      const ctx = createOperationContext('gossip');
      try {
        const request = decodePublishRequest(data);
        const nquadsStr = new TextDecoder().decode(request.nquads);
        const quads = parseSimpleNQuads(nquadsStr);

        if (quads.length === 0 && !request.ual) {
          this.log.warn(ctx, 'Gossip: empty broadcast with no UAL, ignoring');
          return;
        }

        const graphManager = new GraphManager(this.store);
        await graphManager.ensureParanet(request.paranetId);
        const dataGraph = graphManager.dataGraphUri(request.paranetId);
        let normalized = quads.map(q => ({ ...q, graph: dataGraph }));

        // When receiving ontology-topic broadcasts, skip paranet definition
        // triples for paranets we already have locally. This prevents duplicate
        // creator/timestamp triples when multiple nodes create the same paranet
        // during simultaneous startup.
        if (request.paranetId === SYSTEM_PARANETS.ONTOLOGY) {
          const paranetPrefix = 'did:dkg:paranet:';
          const incomingParanetUris = new Set(
            normalized
              .filter(q => q.predicate === DKG_ONTOLOGY.RDF_TYPE && q.object === DKG_ONTOLOGY.DKG_PARANET)
              .map(q => q.subject),
          );
          if (incomingParanetUris.size > 0) {
            const duplicateUris = new Set<string>();
            for (const uri of incomingParanetUris) {
              const id = uri.startsWith(paranetPrefix) ? uri.slice(paranetPrefix.length) : null;
              if (id && await this.paranetExists(id)) {
                duplicateUris.add(uri);
              }
            }
            if (duplicateUris.size > 0) {
              const activityUris = new Set(
                normalized
                  .filter(q => duplicateUris.has(q.subject) && q.predicate === DKG_ONTOLOGY.PROV_GENERATED_BY)
                  .map(q => q.object),
              );
              normalized = normalized.filter(q => !duplicateUris.has(q.subject) && !activityUris.has(q.subject));
            }
          }
        }

        if (normalized.length > 0) {
          await this.store.insert(normalized);
        }

        if (request.ual) {
          const partitioned = autoPartition(normalized);
          const kaRoots: Uint8Array[] = [];
          const kaMetadata: KAMetadata[] = [];

          for (const [rootEntity, entityQuads] of partitioned) {
            const publicRoot = computePublicRoot(entityQuads);
            const kaEntry = request.kas?.find((ka) => ka.rootEntity === rootEntity);
            const privateRoot = kaEntry?.privateMerkleRoot?.length
              ? new Uint8Array(kaEntry.privateMerkleRoot) : undefined;
            kaRoots.push(computeKARoot(publicRoot, privateRoot));

            const tokenId = kaEntry ? protoToNumber(kaEntry.tokenId) : 0;
            kaMetadata.push({
              rootEntity,
              kcUal: request.ual,
              tokenId: BigInt(tokenId),
              publicTripleCount: entityQuads.length,
              privateTripleCount: kaEntry?.privateTripleCount ?? 0,
              privateMerkleRoot: privateRoot,
            });
          }

          const merkleRoot = computeKCRoot(kaRoots);

          const kcMeta = {
            ual: request.ual,
            paranetId: request.paranetId,
            merkleRoot,
            kaCount: kaMetadata.length,
            publisherPeerId: request.publisherAddress || 'unknown',
            timestamp: new Date(),
          };

          // Always store gossip-received data as tentative first —
          // never trust self-reported on-chain status from gossip messages.
          const metaQuads = generateTentativeMetadata(kcMeta, kaMetadata);
          await this.store.insert(metaQuads);

          // If the gossip message includes on-chain proof (txHash + blockNumber),
          // attempt targeted verification and promote to confirmed if valid.
          const txHash = request.txHash ?? '';
          const blockNumber = protoToNumber(request.blockNumber ?? 0);
          const startKAId = protoToNumber(request.startKAId);

          if (txHash && blockNumber > 0 && startKAId > 0 && request.publisherAddress) {
            const verified = await this.verifyGossipOnChain(
              txHash, blockNumber, merkleRoot, request.publisherAddress,
              BigInt(startKAId), BigInt(protoToNumber(request.endKAId)),
              ctx,
            );
            if (verified) {
              await this.promoteGossipToConfirmed(request.ual, request.paranetId, kcMeta, kaMetadata);
              this.log.info(ctx, `Gossip publish ${request.ual} verified on-chain (tx=${txHash.slice(0, 10)}…, block=${blockNumber})`);
            } else {
              this.log.info(ctx, `Gossip publish ${request.ual} stored as tentative (on-chain verification failed or pending)`);
            }
          } else {
            this.log.info(ctx, `Gossip publish ${request.ual} stored as tentative (no on-chain proof in message)`);
          }
        }
      } catch (err) {
        this.log.warn(ctx, `Gossip: failed to process publish broadcast: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.gossip.onMessage(workspaceTopic, async (_topic, data, from) => {
      const wh = this.getOrCreateWorkspaceHandler();
      await wh.handle(data, from);
    });
  }

  private getOrCreateWorkspaceHandler(): WorkspaceHandler {
    if (!this.workspaceHandler) {
      this.workspaceHandler = new WorkspaceHandler(this.store, this.eventBus, {
        workspaceOwnedEntities: this.workspaceOwnedEntities,
      });
    }
    return this.workspaceHandler;
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
    // The on-chain ID is keccak256(bytes(name)) — deterministic, so any node
    // with the same name derives the same ID. First to register wins.
    let onChainId: string | undefined;
    if (this.chain.chainId !== 'none') {
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
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ParanetAlreadyExists') || msg.includes('already exists')) {
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

  /**
   * Check whether a paranet is registered (definition triples exist
   * in the ontology paranet).
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
   * List all registered paranets with their metadata.
   */
  async listParanets(): Promise<Array<{
    id: string;
    uri: string;
    name: string;
    description?: string;
    creator?: string;
    createdAt?: string;
    isSystem: boolean;
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

    if (result.type !== 'bindings') return [];

    const prefix = 'did:dkg:paranet:';
    const seen = new Map<string, {
      id: string; uri: string; name: string; description?: string;
      creator?: string; createdAt?: string; isSystem: boolean;
    }>();
    for (const row of result.bindings as Record<string, string>[]) {
      const uri = row['paranet'] ?? '';
      if (seen.has(uri)) continue;
      const id = uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
      seen.set(uri, {
        id,
        uri,
        name: stripLiteral(row['name'] ?? id),
        description: row['desc'] ? stripLiteral(row['desc']) : undefined,
        creator: row['creator'],
        createdAt: row['created'] ? stripLiteral(row['created']) : undefined,
        isSystem: !!row['isSystem'],
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

  get multiaddrs(): string[] {
    return this.node.multiaddrs;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.chainPoller) {
      this.chainPoller.stop();
      this.chainPoller = null;
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
    });

    const topic = paranetPublishTopic(paranetId);
    this.log.info(ctx, `Broadcasting to topic ${topic}`);
    try {
      await this.gossip.publish(topic, msg);
    } catch {
      this.log.warn(ctx, `No peers subscribed to ${topic} yet`);
    }
  }

  /**
   * Verify a gossip-received publish by doing a targeted on-chain lookup
   * at the exact block specified in the gossip message. Uses both fromBlock
   * and toBlock to constrain the scan to a single block, and validates
   * txHash against event data when available.
   */
  private async verifyGossipOnChain(
    txHash: string,
    blockNumber: number,
    expectedMerkleRoot: Uint8Array,
    expectedPublisher: string,
    expectedStartKAId: bigint,
    expectedEndKAId: bigint,
    ctx: OperationContext,
  ): Promise<boolean> {
    if (this.chain.chainId === 'none') return false;

    if (blockNumber <= 0) {
      this.log.warn(ctx, `Gossip verification skipped: invalid blockNumber=${blockNumber}`);
      return false;
    }

    try {
      const filter: EventFilter = {
        eventTypes: ['KnowledgeBatchCreated'],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      };
      for await (const event of this.chain.listenForEvents(filter)) {
        if (event.blockNumber !== blockNumber) continue;

        if (txHash && event.data['txHash']) {
          if ((event.data['txHash'] as string).toLowerCase() !== txHash.toLowerCase()) {
            continue;
          }
        }

        const eventMerkle = typeof event.data['merkleRoot'] === 'string'
          ? ethers.getBytes(event.data['merkleRoot'] as string)
          : event.data['merkleRoot'] as Uint8Array;
        const eventPublisher = (event.data['publisherAddress'] as string) ?? '';
        const eventStartKAId = BigInt(event.data['startKAId'] as string ?? '0');
        const eventEndKAId = BigInt(event.data['endKAId'] as string ?? '0');

        const merkleMatch = ethers.hexlify(eventMerkle) === ethers.hexlify(expectedMerkleRoot);
        const publisherMatch = eventPublisher.toLowerCase() === expectedPublisher.toLowerCase();
        const rangeMatch = eventStartKAId === expectedStartKAId && eventEndKAId === expectedEndKAId;

        if (merkleMatch && publisherMatch && rangeMatch) {
          return true;
        }
      }
    } catch (err) {
      this.log.warn(ctx, `Gossip on-chain verification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return false;
  }

  /**
   * Promote gossip-received tentative data to confirmed by replacing the
   * tentative metadata quads with confirmed ones.
   */
  private async promoteGossipToConfirmed(
    ual: string,
    paranetId: string,
    kcMeta: { ual: string; paranetId: string; merkleRoot: Uint8Array; kaCount: number; publisherPeerId: string; timestamp: Date },
    kaMetadata: KAMetadata[],
  ): Promise<void> {
    const tentativeQuads = generateTentativeMetadata(kcMeta, kaMetadata);
    const confirmedQuads = [
      ...generateKCMetadata(kcMeta, kaMetadata),
      getConfirmedStatusQuad(ual, paranetId),
    ];
    try {
      await this.store.delete(tentativeQuads);
      await this.store.insert(confirmedQuads);
    } catch (err) {
      this.log.warn(
        createOperationContext('gossip'),
        `Failed to promote gossip tentative→confirmed for ${ual}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function parseSimpleNQuads(text: string): Quad[] {
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
            if (line[j] === '<') { const end = line.indexOf('>', j); j = end + 1; }
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

function protoToNumber(val: number | { low: number; high: number; unsigned: boolean }): number {
  if (typeof val === 'number') return val;
  return ((val.high >>> 0) * 0x100000000) + (val.low >>> 0);
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

      // Try flat mode first (publisher default: single merkle over all triple hashes)
      const flatHashes = allQuadsForKC.map(computeTripleHash);
      const flatRoot = new MerkleTree(flatHashes).root;
      const flatHex = Array.from(flatRoot).map(b => b.toString(16).padStart(2, '0')).join('');

      if (flatHex === claimedHex) {
        verifiedKcUals.add(kcUal);
        continue;
      }

      // Try entity-proofs mode (two-level: per-entity KA roots → KC root)
      const kaRoots: Uint8Array[] = [];
      for (const re of rootEntities) {
        const quads = partitioned.get(re) ?? [];
        const publicRoot = computePublicRoot(quads);
        kaRoots.push(computeKARoot(publicRoot, undefined));
      }
      const epRoot = computeKCRoot(kaRoots);
      const epHex = Array.from(epRoot).map(b => b.toString(16).padStart(2, '0')).join('');

      if (epHex === claimedHex) {
        verifiedKcUals.add(kcUal);
      } else if (acceptUnverified) {
        log.debug(ctx, `Merkle mismatch for ${kcUal} (system paranet, accepted): claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…, ep ${epHex.slice(0, 16)}…`);
        rejected++;
      } else {
        log.warn(ctx, `Merkle mismatch for ${kcUal}: claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…, ep ${epHex.slice(0, 16)}…`);
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
