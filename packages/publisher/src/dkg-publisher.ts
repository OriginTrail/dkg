import type { Quad, TripleStore } from '@dkg/storage';
import type { ChainAdapter, OnChainPublishResult, AddBatchToContextGraphParams } from '@dkg/chain';
import type { EventBus, OperationContext } from '@dkg/core';
import { DKGEvent, Logger, createOperationContext, sha256, MerkleTree, encodeWorkspacePublishRequest, contextGraphDataUri, contextGraphMetaUri, type Ed25519Keypair } from '@dkg/core';
import { GraphManager, PrivateContentStore } from '@dkg/storage';
import type { Publisher, PublishOptions, PublishResult, KAManifestEntry, PhaseCallback } from './publisher.js';
import { autoPartition } from './auto-partition.js';
import { skolemize } from './skolemize.js';
import { computeTripleHash, computePrivateRoot } from './merkle.js';
import { validatePublishRequest } from './validation.js';
import {
  generateTentativeMetadata,
  generateConfirmedFullMetadata,
  generateWorkspaceMetadata,
  generateOwnershipQuads,
  type KAMetadata,
} from './metadata.js';
import { ethers } from 'ethers';

export interface DKGPublisherConfig {
  store: TripleStore;
  chain: ChainAdapter;
  eventBus: EventBus;
  keypair: Ed25519Keypair;
  publisherNodeIdentityId?: bigint;
  publisherAddress?: string;
  /** EVM private key for signing publish requests (hex string with 0x prefix) */
  publisherPrivateKey?: string;
  /**
   * Additional EVM private keys whose identities can act as receiver signers.
   * If empty, only the primary publisherPrivateKey is used for self-signing.
   */
  additionalSignerKeys?: string[];
  /** Shared map of workspace-owned rootEntities per paranet: entity → creatorPeerId. Pass from agent so handler and publisher stay in sync. */
  workspaceOwnedEntities?: Map<string, Map<string, string>>;
  /** Shared batch→paranet binding map. Pass to UpdateHandler so it uses trusted local bindings. */
  knownBatchParanets?: Map<string, string>;
}

export interface WriteToWorkspaceOptions {
  publisherPeerId: string;
  operationCtx?: OperationContext;
}

export interface WriteToWorkspaceResult {
  workspaceOperationId: string;
  message: Uint8Array;
}

function isSafeIri(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`]+$/.test(value);
}

export class DKGPublisher implements Publisher {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter;
  private readonly eventBus: EventBus;
  private readonly keypair: Ed25519Keypair;
  private readonly graphManager: GraphManager;
  private readonly privateStore: PrivateContentStore;
  private readonly ownedEntities = new Map<string, Set<string>>();
  private readonly workspaceOwnedEntities: Map<string, Map<string, string>>;
  readonly knownBatchParanets: Map<string, string>;
  private publisherNodeIdentityId: bigint;
  private readonly publisherAddress: string;
  private readonly publisherWallet?: ethers.Wallet;
  /** Additional wallets that can provide receiver signatures. */
  private readonly additionalSignerWallets: ethers.Wallet[] = [];
  private readonly log = new Logger('DKGPublisher');
  private readonly sessionId = Date.now().toString(36);
  private tentativeCounter = 0;

  constructor(config: DKGPublisherConfig) {
    this.store = config.store;
    this.chain = config.chain;
    this.eventBus = config.eventBus;
    this.keypair = config.keypair;
    this.publisherNodeIdentityId = config.publisherNodeIdentityId ?? 0n;

    if (config.publisherPrivateKey) {
      this.publisherWallet = new ethers.Wallet(config.publisherPrivateKey);
      this.publisherAddress = this.publisherWallet.address;
    } else {
      this.publisherAddress = config.publisherAddress ?? '0x' + '0'.repeat(40);
      if (config.chain.chainId !== 'none') {
        const random = ethers.Wallet.createRandom();
        this.publisherWallet = new ethers.Wallet(random.privateKey);
      }
    }

    for (const key of config.additionalSignerKeys ?? []) {
      this.additionalSignerWallets.push(new ethers.Wallet(key));
    }

    this.graphManager = new GraphManager(config.store);
    this.privateStore = new PrivateContentStore(config.store, this.graphManager);
    this.workspaceOwnedEntities = config.workspaceOwnedEntities ?? new Map();
    this.knownBatchParanets = config.knownBatchParanets ?? new Map();
  }

  /**
   * Write quads to the paranet's workspace graph (no chain, no TRAC).
   * Validates, stores locally in workspace + workspace_meta, returns encoded message for the agent to broadcast on the workspace topic.
   */
  async writeToWorkspace(
    paranetId: string,
    quads: Quad[],
    options: WriteToWorkspaceOptions,
  ): Promise<WriteToWorkspaceResult> {
    const ctx = options.operationCtx ?? createOperationContext('workspace');
    this.log.info(ctx, `Writing ${quads.length} quads to workspace for paranet ${paranetId}`);

    await this.graphManager.ensureParanet(paranetId);

    const kaMap = autoPartition(quads);
    const manifestEntries: { rootEntity: string; privateMerkleRoot?: Uint8Array; privateTripleCount: number }[] = [];
    for (const [rootEntity, publicQuads] of kaMap) {
      const privRoot = undefined;
      manifestEntries.push({
        rootEntity,
        privateMerkleRoot: privRoot,
        privateTripleCount: 0,
      });
    }

    const manifestForValidation: KAManifestEntry[] = manifestEntries.map((m) => ({
      tokenId: 0n,
      rootEntity: m.rootEntity,
      privateMerkleRoot: m.privateMerkleRoot,
      privateTripleCount: m.privateTripleCount,
    }));

    const dataOwned = this.ownedEntities.get(paranetId) ?? new Set();
    const wsOwned = this.workspaceOwnedEntities.get(paranetId) ?? new Map<string, string>();
    const existing = new Set<string>([...dataOwned, ...wsOwned.keys()]);

    // Creator-only upsert: allow overwriting entities this writer created
    const upsertable = new Set<string>();
    for (const [entity, creator] of wsOwned) {
      if (creator === options.publisherPeerId) {
        upsertable.add(entity);
      }
    }

    const validation = validatePublishRequest(
      [...kaMap.values()].flat(),
      manifestForValidation,
      paranetId,
      existing,
      { allowUpsert: true, upsertableEntities: upsertable },
    );
    if (!validation.valid) {
      throw new Error(`Workspace validation failed: ${validation.errors.join('; ')}`);
    }

    const workspaceOperationId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const workspaceGraph = this.graphManager.workspaceGraphUri(paranetId);
    const workspaceMetaGraph = this.graphManager.workspaceMetaGraphUri(paranetId);

    // Delete-then-insert for upserted entities (replace old triples).
    // Delete exact root + skolemized children only to avoid prefix collisions.
    // Also remove prior workspace_meta ops referencing these roots.
    for (const m of manifestEntries) {
      if (wsOwned.has(m.rootEntity)) {
        await this.store.deleteByPattern({ graph: workspaceGraph, subject: m.rootEntity });
        await this.store.deleteBySubjectPrefix(workspaceGraph, m.rootEntity + '/.well-known/genid/');
        await this.deleteMetaForRoot(workspaceMetaGraph, m.rootEntity);
      }
    }

    const paranetGraph = this.graphManager.dataGraphUri(paranetId);
    const gossipQuads = [...kaMap.values()].flat().map((q) => ({ ...q, graph: paranetGraph }));
    const nquadsStr = gossipQuads
      .map(
        (q) =>
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
      )
      .join('\n');

    const message = encodeWorkspacePublishRequest({
      paranetId,
      nquads: new TextEncoder().encode(nquadsStr),
      manifest: manifestEntries.map((m) => ({
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot,
        privateTripleCount: m.privateTripleCount,
      })),
      publisherPeerId: options.publisherPeerId,
      workspaceOperationId,
      timestampMs: Date.now(),
      operationId: ctx.operationId,
    });

    const MAX_GOSSIP_MESSAGE_SIZE = 512 * 1024; // 512 KB
    if (message.length > MAX_GOSSIP_MESSAGE_SIZE) {
      throw new Error(
        `Workspace message too large (${(message.length / 1024).toFixed(0)} KB, limit ${MAX_GOSSIP_MESSAGE_SIZE / 1024} KB). ` +
        `Split large writes into multiple writeToWorkspace calls partitioned by root entity.`,
      );
    }

    const normalized = [...kaMap.values()].flat().map((q) => ({ ...q, graph: workspaceGraph }));
    await this.store.insert(normalized);

    const rootEntities = manifestEntries.map((m) => m.rootEntity);
    const metaQuads = generateWorkspaceMetadata(
      {
        workspaceOperationId,
        paranetId,
        rootEntities,
        publisherPeerId: options.publisherPeerId,
        timestamp: new Date(),
      },
      workspaceMetaGraph,
    );
    await this.store.insert(metaQuads);

    if (!this.workspaceOwnedEntities.has(paranetId)) {
      this.workspaceOwnedEntities.set(paranetId, new Map());
    }
    const newOwnershipEntries: { rootEntity: string; creatorPeerId: string }[] = [];
    const liveOwned = this.workspaceOwnedEntities.get(paranetId)!;
    for (const r of rootEntities) {
      if (!liveOwned.has(r)) {
        newOwnershipEntries.push({ rootEntity: r, creatorPeerId: options.publisherPeerId });
      }
    }
    if (newOwnershipEntries.length > 0) {
      for (const entry of newOwnershipEntries) {
        await this.store.deleteByPattern({
          graph: workspaceMetaGraph,
          subject: entry.rootEntity,
          predicate: 'http://dkg.io/ontology/workspaceOwner',
        });
      }
      await this.store.insert(generateOwnershipQuads(newOwnershipEntries, workspaceMetaGraph));
      for (const entry of newOwnershipEntries) {
        liveOwned.set(entry.rootEntity, entry.creatorPeerId);
      }
    }

    this.log.info(ctx, `Workspace write complete: ${workspaceOperationId}`);
    return { workspaceOperationId, message };
  }

  /**
   * Read quads from the paranet's workspace graph and publish them with full finality (data graph + chain).
   * Selection: 'all' or { rootEntities: string[] } to enshrine only those root entities.
   */
  async enshrineFromWorkspace(
    paranetId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: {
      operationCtx?: OperationContext;
      clearWorkspaceAfter?: boolean;
      onPhase?: PhaseCallback;
      contextGraphId?: string;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('enshrine');
    const workspaceGraph = this.graphManager.workspaceGraphUri(paranetId);

    let sparql: string;
    if (selection === 'all') {
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${workspaceGraph}> { ?s ?p ?o } }`;
    } else {
      const roots = [...new Set(
        selection.rootEntities
          .map((r) => String(r).trim())
          .filter((r) => isSafeIri(r)),
      )];
      if (roots.length === 0) {
        const hadInput = selection.rootEntities.length > 0;
        throw new Error(
          hadInput
            ? `No valid rootEntities provided (all ${selection.rootEntities.length} entries failed IRI validation)`
            : `No rootEntities provided for paranet ${paranetId}`,
        );
      }
      const values = roots.map((r) => `<${r}>`).join(' ');
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
        GRAPH <${workspaceGraph}> {
          VALUES ?root { ${values} }
          ?s ?p ?o .
          FILTER(
            ?s = ?root
            || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
          )
        }
      }`;
    }

    const result = await this.store.query(sparql);
    const quads: Quad[] =
      result.type === 'quads' ? result.quads : [];

    if (quads.length === 0) {
      throw new Error(`No quads in workspace for paranet ${paranetId} matching selection`);
    }

    const ctxGraphId = options?.contextGraphId;
    if (ctxGraphId !== undefined && ctxGraphId !== null) {
      try { BigInt(ctxGraphId); } catch {
        throw new Error(`Invalid contextGraphId: ${String(ctxGraphId)} (must be a numeric value)`);
      }
    }
    const targetGraphUri = ctxGraphId ? contextGraphDataUri(paranetId, ctxGraphId) : undefined;
    const targetMetaGraphUri = ctxGraphId ? contextGraphMetaUri(paranetId, ctxGraphId) : undefined;

    this.log.info(ctx, `Enshrining ${quads.length} quads from workspace to ${ctxGraphId ? `context graph ${ctxGraphId}` : 'data graph'}`);
    const publishResult = await this.publish({
      paranetId,
      quads: quads.map((q) => ({ ...q, graph: '' })),
      operationCtx: ctx,
      onPhase: options?.onPhase,
      targetGraphUri,
      targetMetaGraphUri,
    });

    if (ctxGraphId && publishResult.status === 'confirmed' && publishResult.onChainResult) {
      // Build participant signatures: use provided ones, or self-sign if chain adapter supports it
      let participantSigs = options?.contextGraphSignatures ?? [];
      if (participantSigs.length === 0 && typeof this.chain.signMessage === 'function') {
        const identityId = this.publisherNodeIdentityId;
        if (identityId > 0n) {
          const digest = ethers.solidityPackedKeccak256(
            ['uint256', 'bytes32'],
            [BigInt(ctxGraphId), ethers.hexlify(publishResult.merkleRoot)],
          );
          const sig = await this.chain.signMessage(ethers.getBytes(digest));
          participantSigs = [{ identityId, ...sig }];
          this.log.info(ctx, `Self-signed as participant for context graph ${ctxGraphId} (identityId=${identityId})`);
        }
      }

      const sortedSigs = [...participantSigs]
        .sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))
        .filter((s, i, arr) => i === 0 || s.identityId !== arr[i - 1].identityId);

      const maxRetries = 3;
      let attempt = 0;
      let registered = false;
      while (attempt < maxRetries && !registered) {
        attempt++;
        try {
          if (typeof this.chain.addBatchToContextGraph !== 'function') {
            throw new Error('addBatchToContextGraph not available on chain adapter');
          }
          const txResult = await this.chain.addBatchToContextGraph({
            contextGraphId: BigInt(ctxGraphId),
            batchId: publishResult.onChainResult.batchId,
            merkleRoot: publishResult.merkleRoot,
            signerSignatures: sortedSigs,
          });
          if (txResult && typeof txResult === 'object' && 'success' in txResult && !txResult.success) {
            throw new Error(`addBatchToContextGraph returned success=false`);
          }
          registered = true;
          this.log.info(ctx, `Batch ${publishResult.onChainResult.batchId} registered to context graph ${ctxGraphId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < maxRetries) {
            this.log.info(ctx, `addBatchToContextGraph attempt ${attempt} failed, retrying: ${msg}`);
            await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
          } else {
            this.log.warn(ctx, `addBatchToContextGraph failed after ${maxRetries} attempts: ${msg}`);
            // KC is already confirmed on-chain — do NOT rollback local data
            // or return 'failed', as that creates chain/local divergence.
            // Keep the data and report the context-graph failure separately.
            this.eventBus.emit(DKGEvent.PUBLISH_FAILED, {
              reason: 'context_graph_registration_failed',
              batchId: String(publishResult.onChainResult.batchId),
              contextGraphId: ctxGraphId,
              error: msg,
            });
            return {
              ...publishResult,
              contextGraphError: `addBatchToContextGraph failed after ${maxRetries} attempts: ${msg}`,
            };
          }
        }
      }
    }

    if (options?.clearWorkspaceAfter) {
      const wsMetaGraph = this.graphManager.workspaceMetaGraphUri(paranetId);
      const kaMap = autoPartition(quads);
      let ownerDeletedTotal = 0;
      for (const rootEntity of kaMap.keys()) {
        await this.store.deleteByPattern({ graph: workspaceGraph, subject: rootEntity });
        await this.store.deleteBySubjectPrefix(workspaceGraph, rootEntity + '/.well-known/genid/');
        const ownerDeleted = await this.store.deleteByPattern({
          graph: wsMetaGraph, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
        });
        ownerDeletedTotal += ownerDeleted;
        await this.deleteMetaForRoot(wsMetaGraph, rootEntity);
        this.workspaceOwnedEntities.get(paranetId)?.delete(rootEntity);
      }
      if (ownerDeletedTotal > 0) {
        this.log.info(ctx, `Cleared ${ownerDeletedTotal} ownership triple(s) during enshrine cleanup`);
      }
    }

    return publishResult;
  }

  /**
   * Collect receiver signatures from peers via a provided responder function.
   * Deduplicates by identityId.
   */
  async collectReceiverSignatures(params: {
    merkleRoot: string;
    publicByteSize: bigint;
    peerResponder: (peerId: string, merkleRoot: string, publicByteSize: bigint) => Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>>;
    minimumRequired: number;
    timeoutMs: number;
  }): Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>> {
    const sigs = await Promise.race([
      params.peerResponder('*', params.merkleRoot, params.publicByteSize),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Receiver signature collection timed out after ${params.timeoutMs}ms`)), params.timeoutMs),
      ),
    ]);

    // Deduplicate by identityId
    const seen = new Set<bigint>();
    const unique = sigs.filter((s) => {
      if (seen.has(s.identityId)) return false;
      seen.add(s.identityId);
      return true;
    });

    if (unique.length < params.minimumRequired) {
      throw new Error(
        `Insufficient receiver signatures: got ${unique.length}, need ${params.minimumRequired}`,
      );
    }

    return unique;
  }

  /**
   * Collect context graph participant signatures via a provided responder function.
   * Deduplicates by identityId.
   */
  async collectParticipantSignatures(params: {
    contextGraphId: bigint;
    merkleRoot: string;
    participantResponder: () => Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>>;
    minimumRequired: number;
    timeoutMs: number;
  }): Promise<Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>> {
    const sigs = await Promise.race([
      params.participantResponder(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Participant signature collection timed out after ${params.timeoutMs}ms`)), params.timeoutMs),
      ),
    ]);

    const seen = new Set<bigint>();
    const unique = sigs.filter((s) => {
      if (seen.has(s.identityId)) return false;
      seen.add(s.identityId);
      return true;
    });

    if (unique.length < params.minimumRequired) {
      throw new Error(
        `Insufficient participant signatures: got ${unique.length}, need ${params.minimumRequired}`,
      );
    }

    return unique;
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const { paranetId, quads, privateQuads = [], operationCtx, onPhase } = options;
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');

    onPhase?.('prepare', 'start');
    onPhase?.('prepare:ensureParanet', 'start');
    this.log.info(ctx, `Preparing publish: ${quads.length} public triples, ${privateQuads.length} private`);
    await this.graphManager.ensureParanet(paranetId);
    onPhase?.('prepare:ensureParanet', 'end');

    onPhase?.('prepare:partition', 'start');
    const kaMap = autoPartition(quads);
    onPhase?.('prepare:partition', 'end');

    const manifestEntries: KAManifestEntry[] = [];
    const kaMetadata: KAMetadata[] = [];

    onPhase?.('prepare:manifest', 'start');
    let tokenCounter = 1n;
    for (const [rootEntity, publicQuads] of kaMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );

      manifestEntries.push({
        tokenId: tokenCounter,
        rootEntity,
        privateMerkleRoot: entityPrivateQuads.length > 0
          ? computePrivateRoot(entityPrivateQuads)
          : undefined,
        privateTripleCount: entityPrivateQuads.length,
      });

      kaMetadata.push({
        rootEntity,
        kcUal: '',
        tokenId: tokenCounter,
        publicTripleCount: publicQuads.length,
        privateTripleCount: entityPrivateQuads.length,
        privateMerkleRoot: entityPrivateQuads.length > 0
          ? computePrivateRoot(entityPrivateQuads)
          : undefined,
      });

      tokenCounter++;
    }

    const allSkolemizedQuads = [...kaMap.values()].flat();
    onPhase?.('prepare:manifest', 'end');

    onPhase?.('prepare:validate', 'start');
    const existing = this.ownedEntities.get(paranetId) ?? new Set();
    const validation = validatePublishRequest(allSkolemizedQuads, manifestEntries, paranetId, existing);
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
    }
    onPhase?.('prepare:validate', 'end');

    onPhase?.('prepare:merkle', 'start');
    const allPublicHashes = allSkolemizedQuads.map(computeTripleHash);
    const kcMerkleRoot = new MerkleTree(allPublicHashes).root;
    this.log.info(ctx, `Computed kcMerkleRoot (flat) over ${allPublicHashes.length} triple hashes`);
    const kaCount = manifestEntries.length;
    onPhase?.('prepare:merkle', 'end');

    onPhase?.('prepare', 'end');
    onPhase?.('store', 'start');

    const dataGraph = options.targetGraphUri ?? this.graphManager.dataGraphUri(paranetId);
    const normalizedQuads = allSkolemizedQuads.map((q) => ({ ...q, graph: dataGraph }));

    this.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store`);
    await this.store.insert(normalizedQuads);

    // Store private quads
    for (const [rootEntity] of kaMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      if (entityPrivateQuads.length > 0) {
        await this.privateStore.storePrivateTriples(paranetId, rootEntity, entityPrivateQuads);
      }
    }

    onPhase?.('store', 'end');

    // Compute publicByteSize early — needed for signature collection
    const nquadsStr = allSkolemizedQuads
      .map(
        (q) =>
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
      )
      .join('\n');
    const publicByteSize = BigInt(new TextEncoder().encode(nquadsStr).length);
    const merkleRootHex = ethers.hexlify(kcMerkleRoot);

    // Collect receiver signatures from peers (replicate-then-publish)
    let collectedReceiverSigs: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }> | undefined;
    if (options.receiverSignatureProvider) {
      onPhase?.('collect_signatures', 'start');
      try {
        collectedReceiverSigs = await options.receiverSignatureProvider(merkleRootHex, publicByteSize);
        this.log.info(ctx, `Collected ${collectedReceiverSigs.length} receiver signature(s) from peers`);
      } catch (err) {
        onPhase?.('collect_signatures', 'end');
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `Receiver signature collection failed, rolling back stored data: ${msg}`);
        try {
          await this.store.delete(normalizedQuads);
        } catch (rollbackErr) {
          this.log.warn(ctx, `Rollback after signature failure failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
        }
        throw new Error(`Publish aborted: receiverSignatureProvider failed and no fallback is configured. ${msg}`);
      }
      onPhase?.('collect_signatures', 'end');
    }

    onPhase?.('chain', 'start');

    let onChainResult: OnChainPublishResult | undefined;
    let status: 'tentative' | 'confirmed' = 'tentative';
    const tentativeSeq = ++this.tentativeCounter;
    let ual = `did:dkg:${this.chain.chainId}/${this.publisherAddress}/t${this.sessionId}-${tentativeSeq}`;

    const identityId = this.publisherNodeIdentityId;

    if (!this.publisherWallet) {
      this.log.warn(ctx, `No EVM wallet configured — skipping on-chain publish`);
    } else if (identityId === 0n) {
      this.log.warn(ctx, `Identity not set (0) — skipping on-chain publish`);
    } else {
      onPhase?.('chain:sign', 'start');
      this.log.info(ctx, `Signing on-chain publish (identityId=${identityId}, signer=${this.publisherWallet.address})`);

      let tokenAmount =
        typeof this.chain.getRequiredPublishTokenAmount === 'function'
          ? await this.chain.getRequiredPublishTokenAmount(publicByteSize, 1)
          : 1n;
      if (tokenAmount <= 0n) tokenAmount = 1n;

      // Publisher signature: sign keccak256(abi.encodePacked(uint72 identityId, bytes32 merkleRoot))
      const pubMsgHash = ethers.solidityPackedKeccak256(
        ['uint72', 'bytes32'],
        [identityId, merkleRootHex],
      );
      const pubSig = ethers.Signature.from(
        await this.publisherWallet.signMessage(ethers.getBytes(pubMsgHash)),
      );

      let receiverSignatures: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
      if (collectedReceiverSigs && collectedReceiverSigs.length > 0) {
        receiverSignatures = [...collectedReceiverSigs]
          .sort((a, b) => (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0))
          .filter((s, i, arr) => i === 0 || s.identityId !== arr[i - 1].identityId);
      } else {
        const rcvMsgHash = ethers.solidityPackedKeccak256(
          ['bytes32', 'uint64'],
          [merkleRootHex, publicByteSize],
        );
        const rcvSig = ethers.Signature.from(
          await this.publisherWallet.signMessage(ethers.getBytes(rcvMsgHash)),
        );
        receiverSignatures = [{
          identityId,
          r: ethers.getBytes(rcvSig.r),
          vs: ethers.getBytes(rcvSig.yParityAndS),
        }];
      }

      onPhase?.('chain:sign', 'end');
      onPhase?.('chain:submit', 'start');
      this.log.info(ctx, `Submitting on-chain publish tx (${kaCount} KAs, publicByteSize=${publicByteSize}, tokenAmount=${tokenAmount})`);
      try {
        onChainResult = await this.chain.publishKnowledgeAssets({
          kaCount,
          publisherNodeIdentityId: identityId,
          merkleRoot: kcMerkleRoot,
          publicByteSize,
          epochs: 1,
          tokenAmount,
          publisherSignature: {
            r: ethers.getBytes(pubSig.r),
            vs: ethers.getBytes(pubSig.yParityAndS),
          },
          receiverSignatures,
        });

        onChainResult.tokenAmount = tokenAmount;

        // V9 UAL: did:dkg:{chainId}/{publisherAddress}/{firstKAId}
        ual = `did:dkg:${this.chain.chainId}/${onChainResult.publisherAddress}/${onChainResult.startKAId}`;

        for (const km of kaMetadata) {
          km.kcUal = ual;
        }
        let confirmedQuads = generateConfirmedFullMetadata(
          {
            ual,
            paranetId,
            merkleRoot: kcMerkleRoot,
            kaCount,
            publisherPeerId: options.publisherPeerId ?? 'unknown',
            timestamp: new Date(),
          },
          kaMetadata,
          {
            txHash: onChainResult.txHash,
            blockNumber: onChainResult.blockNumber,
            blockTimestamp: onChainResult.blockTimestamp,
            publisherAddress: onChainResult.publisherAddress,
            batchId: onChainResult.batchId,
            chainId: this.chain.chainId,
          },
        );
        if (options.targetMetaGraphUri) {
          const defaultMeta = `did:dkg:paranet:${paranetId}/_meta`;
          confirmedQuads = confirmedQuads.map((q) =>
            q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
          );
        }
        await this.store.insert(confirmedQuads);
        status = 'confirmed';
        onPhase?.('chain:submit', 'end');
        onPhase?.('chain:metadata', 'start');
        this.log.info(ctx, `On-chain confirmed: UAL=${ual} batchId=${onChainResult.batchId} tx=${onChainResult.txHash}`);
      } catch (err) {
        onPhase?.('chain:submit', 'end');
        this.log.warn(ctx, `On-chain tx failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (status === 'tentative') {
      // ual already set to the tentative form above; no reassignment needed
      for (const km of kaMetadata) {
        km.kcUal = ual;
      }
      let tentativeQuads = generateTentativeMetadata(
        {
          ual,
          paranetId,
          merkleRoot: kcMerkleRoot,
          kaCount,
          publisherPeerId: options.publisherPeerId ?? 'unknown',
          timestamp: new Date(),
        },
        kaMetadata,
      );
      if (options.targetMetaGraphUri) {
        const defaultMeta = `did:dkg:paranet:${paranetId}/_meta`;
        tentativeQuads = tentativeQuads.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
        );
      }
      await this.store.insert(tentativeQuads);
      this.log.info(ctx, `Stored as tentative: UAL=${ual}`);
    }

    // Track owned entities and batch→paranet binding on confirmed publishes
    if (status === 'confirmed' && onChainResult) {
      if (!this.ownedEntities.has(paranetId)) {
        this.ownedEntities.set(paranetId, new Set());
      }
      for (const e of manifestEntries) {
        this.ownedEntities.get(paranetId)!.add(e.rootEntity);
      }
      this.knownBatchParanets.set(String(onChainResult.batchId), paranetId);
      onPhase?.('chain:metadata', 'end');
    }

    onPhase?.('chain', 'end');

    const result: PublishResult = {
      kcId: onChainResult?.batchId ?? 0n,
      ual,
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status,
      onChainResult,
      publicQuads: allSkolemizedQuads,
    };

    this.eventBus.emit(DKGEvent.KC_PUBLISHED, result);
    return result;
  }

  async update(kcId: bigint, options: PublishOptions): Promise<PublishResult> {
    const { paranetId, quads, privateQuads = [], operationCtx, onPhase } = options;
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');
    this.log.info(ctx, `Updating kcId=${kcId} with ${quads.length} triples`);
    const dataGraph = this.graphManager.dataGraphUri(paranetId);

    onPhase?.('prepare', 'start');
    onPhase?.('prepare:partition', 'start');
    const kaMap = autoPartition(quads);
    onPhase?.('prepare:partition', 'end');

    onPhase?.('prepare:manifest', 'start');
    const manifestEntries: KAManifestEntry[] = [];
    const entityPrivateMap = new Map<string, Quad[]>();

    let tokenCounter = 1n;
    for (const [rootEntity, publicQuads] of kaMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      entityPrivateMap.set(rootEntity, entityPrivateQuads);

      manifestEntries.push({
        tokenId: tokenCounter++,
        rootEntity,
        privateMerkleRoot: entityPrivateQuads.length > 0
          ? computePrivateRoot(entityPrivateQuads) : undefined,
        privateTripleCount: entityPrivateQuads.length,
      });
    }
    onPhase?.('prepare:manifest', 'end');

    onPhase?.('prepare:merkle', 'start');
    const allSkolemizedQuads = [...kaMap.values()].flat();
    const allHashes = allSkolemizedQuads.map(computeTripleHash);
    const kcMerkleRoot = new MerkleTree(allHashes).root;
    onPhase?.('prepare:merkle', 'end');
    onPhase?.('prepare', 'end');

    onPhase?.('chain', 'start');
    onPhase?.('chain:submit', 'start');
    const txResult = await this.chain.updateKnowledgeAssets({
      batchId: kcId,
      newMerkleRoot: kcMerkleRoot,
      newPublicByteSize: BigInt(allSkolemizedQuads.length * 100),
    });

    if (!txResult.success) {
      onPhase?.('chain:submit', 'end');
      onPhase?.('chain', 'end');
      return {
        kcId,
        ual: `did:dkg:${this.chain.chainId}/${this.publisherAddress}/${kcId}`,
        merkleRoot: kcMerkleRoot,
        kaManifest: manifestEntries,
        status: 'failed',
        publicQuads: allSkolemizedQuads,
      };
    }
    onPhase?.('chain:submit', 'end');
    onPhase?.('chain', 'end');

    onPhase?.('store', 'start');
    for (const [rootEntity, publicQuads] of kaMap) {
      await this.store.deleteByPattern({ graph: dataGraph, subject: rootEntity });
      await this.store.deleteBySubjectPrefix(dataGraph, rootEntity + '/.well-known/genid/');
      await this.privateStore.deletePrivateTriples(paranetId, rootEntity);

      const normalized = publicQuads.map((q) => ({ ...q, graph: dataGraph }));
      await this.store.insert(normalized);

      const entityPrivateQuads = entityPrivateMap.get(rootEntity) ?? [];
      if (entityPrivateQuads.length > 0) {
        await this.privateStore.storePrivateTriples(paranetId, rootEntity, entityPrivateQuads);
      }
    }
    onPhase?.('store', 'end');

    const result: PublishResult = {
      kcId,
      ual: `did:dkg:${this.chain.chainId}/${this.publisherAddress}/${kcId}`,
      merkleRoot: kcMerkleRoot,
      kaManifest: manifestEntries,
      status: 'confirmed',
      publicQuads: allSkolemizedQuads,
      onChainResult: {
        batchId: kcId,
        txHash: txResult.hash,
        blockNumber: txResult.blockNumber,
        blockTimestamp: Math.floor(Date.now() / 1000),
        publisherAddress: this.publisherAddress,
      },
    };

    this.eventBus.emit(DKGEvent.KA_UPDATED, result);
    return result;
  }

  setIdentityId(id: bigint): void {
    this.publisherNodeIdentityId = id;
  }

  getIdentityId(): bigint {
    return this.publisherNodeIdentityId;
  }

  autoPartition(quads: Quad[]): KAManifestEntry[] {
    const kaMap = autoPartition(quads);
    let tokenId = 1n;
    return [...kaMap.keys()].map((rootEntity) => ({
      tokenId: tokenId++,
      rootEntity,
    }));
  }

  skolemize(rootEntity: string, quads: Quad[]): Quad[] {
    return skolemize(rootEntity, quads);
  }

  /**
   * Remove the workspace_meta link for a specific rootEntity.
   * Only deletes the entire operation subject when no rootEntity links remain,
   * preserving metadata for other roots written in the same operation.
   */
  /**
   * Reconstruct the in-memory workspaceOwnedEntities map from persisted
   * ownership triples in workspace_meta graphs. Call on startup.
   *
   * Validates each ownership triple against workspace-operation metadata
   * (wasAttributedTo) to guard against tampered triples. Conflicts are
   * resolved deterministically by keeping the alphabetically first creator.
   */
  async reconstructWorkspaceOwnership(): Promise<number> {
    const DKG = 'http://dkg.io/ontology/';
    const PROV = 'http://www.w3.org/ns/prov#';
    try {
      const paranets = await this.graphManager.listParanets();
      let total = 0;
      for (const pid of paranets) {
        const wsMetaGraph = this.graphManager.workspaceMetaGraphUri(pid);
        const result = await this.store.query(
          `SELECT ?entity ?creator WHERE { GRAPH <${wsMetaGraph}> { ?entity <${DKG}workspaceOwner> ?creator } }`,
        );
        if (result.type !== 'bindings' || result.bindings.length === 0) continue;

        const opsResult = await this.store.query(
          `SELECT ?op ?peer ?root WHERE { GRAPH <${wsMetaGraph}> { ?op <${PROV}wasAttributedTo> ?peer . ?op <${DKG}rootEntity> ?root } }`,
        );
        const validatedOwners = new Map<string, Set<string>>();
        if (opsResult.type === 'bindings') {
          for (const row of opsResult.bindings) {
            const root = row['root'];
            const peer = row['peer'];
            if (!root || !peer) continue;
            const peerStr = peer.startsWith('"')
              ? peer.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '')
              : peer;
            if (!validatedOwners.has(root)) validatedOwners.set(root, new Set());
            validatedOwners.get(root)!.add(peerStr);
          }
        }

        if (!this.workspaceOwnedEntities.has(pid)) {
          this.workspaceOwnedEntities.set(pid, new Map());
        }
        const ownedMap = this.workspaceOwnedEntities.get(pid)!;
        for (const row of result.bindings) {
          const entity = row['entity'];
          const creator = row['creator'];
          if (!entity || !creator) continue;
          const creatorStr = creator.startsWith('"')
            ? creator.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '')
            : creator;

          const validPeers = validatedOwners.get(entity);
          if (!validPeers || !validPeers.has(creatorStr)) {
            this.log.warn(
              createOperationContext('reconstruct'),
              `Skipping unvalidated ownership: entity=${entity} creator=${creatorStr}`,
            );
            continue;
          }

          if (ownedMap.has(entity)) {
            const existing = ownedMap.get(entity)!;
            if (existing !== creatorStr) {
              this.log.warn(
                createOperationContext('reconstruct'),
                `Conflicting ownership for ${entity}: "${existing}" vs "${creatorStr}"; keeping alphabetically first`,
              );
              if (creatorStr < existing) ownedMap.set(entity, creatorStr);
            }
            continue;
          }

          ownedMap.set(entity, creatorStr);
          total++;
        }
      }
      return total;
    } catch (err) {
      this.log.warn(
        createOperationContext('reconstruct'),
        `reconstructWorkspaceOwnership failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  private async deleteMetaForRoot(metaGraph: string, rootEntity: string): Promise<void> {
    const DKG = 'http://dkg.io/ontology/';
    const result = await this.store.query(
      `SELECT ?op WHERE { GRAPH <${metaGraph}> { ?op <${DKG}rootEntity> <${rootEntity}> } }`,
    );
    if (result.type !== 'bindings') return;
    for (const row of result.bindings) {
      const op = row['op'];
      if (!op) continue;

      await this.store.delete([{
        subject: op, predicate: `${DKG}rootEntity`, object: rootEntity, graph: metaGraph,
      }]);

      const remaining = await this.store.query(
        `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${metaGraph}> { <${op}> <${DKG}rootEntity> ?r } }`,
      );
      const rawCount = remaining.type === 'bindings' && remaining.bindings[0]?.['c'];
      const countVal = parseCountLiteral(rawCount);
      if (countVal === 0) {
        await this.store.deleteByPattern({ graph: metaGraph, subject: op });
      }
    }
  }
}

/**
 * Parse a SPARQL COUNT result that may be a bare number string, a quoted
 * string, or a typed literal (e.g. `"0"^^<xsd:integer>`, `"0"^^<xsd:long>`).
 * Returns the numeric value, or NaN if unparseable.
 */
function parseCountLiteral(val: string | false | undefined): number {
  if (!val) return NaN;
  const stripped = val.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
  const n = Number(stripped);
  return Number.isFinite(n) ? n : NaN;
}
