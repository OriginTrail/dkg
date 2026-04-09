import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter, OnChainPublishResult, AddBatchToContextGraphParams } from '@origintrail-official/dkg-chain';
import type { EventBus, OperationContext } from '@origintrail-official/dkg-core';
import { DKGEvent, Logger, createOperationContext, sha256, encodeWorkspacePublishRequest, contextGraphDataUri, contextGraphMetaUri, contextGraphDraftUri, contextGraphSubGraphUri, contextGraphSubGraphMetaUri, validateSubGraphName, isSafeIri, assertSafeIri, assertSafeRdfTerm, type Ed25519Keypair, computeACKDigest } from '@origintrail-official/dkg-core';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import type { Publisher, PublishOptions, PublishResult, KAManifestEntry, PhaseCallback } from './publisher.js';
import { autoPartition } from './auto-partition.js';
import { skolemize } from './skolemize.js';
import { computeTripleHashV10 as computeTripleHash, computePrivateRootV10 as computePrivateRoot, computeFlatKCRootV10 as computeFlatKCRoot } from './merkle.js';
import { validatePublishRequest } from './validation.js';
import {
  generateTentativeMetadata,
  generateConfirmedFullMetadata,
  generateShareMetadata,
  generateOwnershipQuads,
  generateAuthorshipProof,
  generateShareTransitionMetadata,
  toHex,
  updateMetaMerkleRoot,
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
  /** Shared map of SWM-owned rootEntities per context graph: entity → creatorPeerId. Pass from agent so handler and publisher stay in sync. */
  sharedMemoryOwnedEntities?: Map<string, Map<string, string>>;
  /** Shared batch→context graph binding map. Pass to UpdateHandler so it uses trusted local bindings. */
  knownBatchContextGraphs?: Map<string, string>;
  /** Shared write lock map. Pass to SharedMemoryHandler so gossip writes serialize against CAS writes. */
  writeLocks?: Map<string, Promise<void>>;
}

export interface ShareOptions {
  publisherPeerId: string;
  operationCtx?: OperationContext;
  subGraphName?: string;
}

/** @deprecated Use ShareOptions */
export type WriteToWorkspaceOptions = ShareOptions;

export interface ShareResult {
  shareOperationId: string;
  message: Uint8Array;
}

/** @deprecated Use ShareResult */
export type WriteToWorkspaceResult = ShareResult;

export interface CASCondition {
  subject: string;
  predicate: string;
  /**
   * Expected current object value as a SPARQL term (e.g. `"recruiting"`,
   * `"42"^^<http://www.w3.org/2001/XMLSchema#integer>`, `<http://example.org/>`).
   * `null` means the triple must not exist.
   */
  expectedValue: string | null;
}

export class StaleWriteError extends Error {
  readonly condition: CASCondition;
  readonly actualValue: string | null;
  constructor(condition: CASCondition, actualValue: string | null) {
    const exp = condition.expectedValue === null ? '<absent>' : `"${condition.expectedValue}"`;
    const act = actualValue === null ? '<absent>' : `"${actualValue}"`;
    super(`CAS failed: <${condition.subject}> <${condition.predicate}> expected ${exp}, found ${act}`);
    this.name = 'StaleWriteError';
    this.condition = condition;
    this.actualValue = actualValue;
  }
}

export interface ConditionalShareOptions extends ShareOptions {
  conditions: CASCondition[];
}

/** @deprecated Use ConditionalShareOptions */
export type WriteConditionalToWorkspaceOptions = ConditionalShareOptions;


export class DKGPublisher implements Publisher {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter;
  private readonly eventBus: EventBus;
  private readonly keypair: Ed25519Keypair;
  private readonly graphManager: GraphManager;
  private readonly privateStore: PrivateContentStore;
  private readonly ownedEntities = new Map<string, Set<string>>();
  private readonly sharedMemoryOwnedEntities: Map<string, Map<string, string>>;
  readonly knownBatchContextGraphs: Map<string, string>;
  private publisherNodeIdentityId: bigint;
  private readonly publisherAddress: string;
  private readonly publisherWallet?: ethers.Wallet;
  /** Additional wallets that can provide receiver signatures. */
  private readonly additionalSignerWallets: ethers.Wallet[] = [];
  private readonly log = new Logger('DKGPublisher');
  private readonly sessionId = Date.now().toString(36);
  private tentativeCounter = 0;
  readonly writeLocks: Map<string, Promise<void>>;

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
    this.sharedMemoryOwnedEntities = config.sharedMemoryOwnedEntities ?? new Map();
    this.knownBatchContextGraphs = config.knownBatchContextGraphs ?? new Map();
    this.writeLocks = config.writeLocks ?? new Map();
  }

  private async withWriteLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const uniqueKeys = [...new Set(keys)].sort();
    const predecessor = Promise.all(uniqueKeys.map(k => this.writeLocks.get(k) ?? Promise.resolve()));
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    for (const k of uniqueKeys) {
      this.writeLocks.set(k, gate);
    }
    await predecessor;
    try {
      return await fn();
    } finally {
      resolve();
      for (const k of uniqueKeys) {
        if (this.writeLocks.get(k) === gate) this.writeLocks.delete(k);
      }
    }
  }

  /**
   * Write quads to the context graph's shared memory (no chain, no TRAC).
   * Validates, stores locally in SWM + SWM meta, returns encoded message for the agent to broadcast on the SWM topic.
   * Acquires per-entity write locks to serialize against concurrent CAS writes.
   */
  async share(
    contextGraphId: string,
    quads: Quad[],
    options: ShareOptions,
  ): Promise<ShareResult> {
    const subjects = [...new Set(quads.map(q => q.subject))];
    const lockKeys = subjects.map(s => `${contextGraphId}\0${s}`);
    return this.withWriteLocks(lockKeys, () => this._shareImpl(contextGraphId, quads, options));
  }

  /** @deprecated Use share() */
  async writeToWorkspace(
    contextGraphId: string,
    quads: Quad[],
    options: ShareOptions,
  ): Promise<ShareResult> {
    return this.share(contextGraphId, quads, options);
  }

  private async _shareImpl(
    contextGraphId: string,
    quads: Quad[],
    options: ShareOptions & { conditions?: CASCondition[] },
  ): Promise<ShareResult> {
    if (options.subGraphName !== undefined) {
      const v = validateSubGraphName(options.subGraphName);
      if (!v.valid) throw new Error(`Invalid sub-graph name for share: ${v.reason}`);
    }
    const ctx = options.operationCtx ?? createOperationContext('share');
    this.log.info(ctx, `Writing ${quads.length} quads to shared memory for context graph ${contextGraphId}`);

    await this.graphManager.ensureContextGraph(contextGraphId);

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

    const ownershipKey = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
    const dataOwned = this.ownedEntities.get(ownershipKey) ?? new Set();
    const swmOwned = this.sharedMemoryOwnedEntities.get(ownershipKey) ?? new Map<string, string>();
    const existing = new Set<string>([...dataOwned, ...swmOwned.keys()]);

    const upsertable = new Set<string>();
    for (const [entity, creator] of swmOwned) {
      if (creator === options.publisherPeerId) {
        upsertable.add(entity);
      }
    }

    const validation = validatePublishRequest(
      [...kaMap.values()].flat(),
      manifestForValidation,
      contextGraphId,
      existing,
      { allowUpsert: true, upsertableEntities: upsertable },
    );
    if (!validation.valid) {
      throw new Error(`SWM validation failed: ${validation.errors.join('; ')}`);
    }

    const shareOperationId = `swm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, options.subGraphName);
    const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, options.subGraphName);

    // Pre-encode gossip message and enforce size limit BEFORE any
    // destructive SWM mutations to avoid leaving orphaned state.
    const dataGraphUri = this.graphManager.dataGraphUri(contextGraphId);
    const gossipQuads = [...kaMap.values()].flat().map((q) => ({ ...q, graph: dataGraphUri }));
    const nquadsStr = gossipQuads
      .map(
        (q) =>
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
      )
      .join('\n');

    const casConditions = options.conditions?.map(c => ({
      subject: c.subject,
      predicate: c.predicate,
      expectedValue: c.expectedValue ?? '',
      expectAbsent: c.expectedValue === null,
    }));

    const message = encodeWorkspacePublishRequest({
      paranetId: contextGraphId,
      nquads: new TextEncoder().encode(nquadsStr),
      manifest: manifestEntries.map((m) => ({
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot,
        privateTripleCount: m.privateTripleCount,
      })),
      publisherPeerId: options.publisherPeerId,
      workspaceOperationId: shareOperationId,
      timestampMs: Date.now(),
      operationId: ctx.operationId,
      casConditions,
      subGraphName: options.subGraphName,
    });

    const MAX_GOSSIP_MESSAGE_SIZE = 512 * 1024; // 512 KB
    if (message.length > MAX_GOSSIP_MESSAGE_SIZE) {
      throw new Error(
        `SWM message too large (${(message.length / 1024).toFixed(0)} KB, limit ${MAX_GOSSIP_MESSAGE_SIZE / 1024} KB). ` +
        `Split large writes into multiple share() calls partitioned by root entity.`,
      );
    }

    // Delete-then-insert for upserted entities (replace old triples).
    for (const m of manifestEntries) {
      if (swmOwned.has(m.rootEntity)) {
        await this.store.deleteByPattern({ graph: swmGraph, subject: m.rootEntity });
        await this.store.deleteBySubjectPrefix(swmGraph, m.rootEntity + '/.well-known/genid/');
        await this.deleteMetaForRoot(swmMetaGraph, m.rootEntity);
      }
    }

    const normalized = [...kaMap.values()].flat().map((q) => ({ ...q, graph: swmGraph }));
    await this.store.insert(normalized);

    const rootEntities = manifestEntries.map((m) => m.rootEntity);
    const metaQuads = generateShareMetadata(
      {
        shareOperationId,
        contextGraphId,
        rootEntities,
        publisherPeerId: options.publisherPeerId,
        timestamp: new Date(),
      },
      swmMetaGraph,
    );
    await this.store.insert(metaQuads);

    if (!this.sharedMemoryOwnedEntities.has(ownershipKey)) {
      this.sharedMemoryOwnedEntities.set(ownershipKey, new Map());
    }
    const newOwnershipEntries: { rootEntity: string; creatorPeerId: string }[] = [];
    const liveOwned = this.sharedMemoryOwnedEntities.get(ownershipKey)!;
    for (const r of rootEntities) {
      if (!liveOwned.has(r)) {
        newOwnershipEntries.push({ rootEntity: r, creatorPeerId: options.publisherPeerId });
      }
    }
    if (newOwnershipEntries.length > 0) {
      for (const entry of newOwnershipEntries) {
        await this.store.deleteByPattern({
          graph: swmMetaGraph,
          subject: entry.rootEntity,
          predicate: 'http://dkg.io/ontology/workspaceOwner',
        });
      }
      await this.store.insert(generateOwnershipQuads(newOwnershipEntries, swmMetaGraph));
      for (const entry of newOwnershipEntries) {
        liveOwned.set(entry.rootEntity, entry.creatorPeerId);
      }
    }

    this.log.info(ctx, `Shared memory write complete: ${shareOperationId}`);
    return { shareOperationId, message };
  }

  /**
   * Compare-and-swap shared memory write. Checks each condition against the
   * current SWM graph state before applying the write atomically.
   * Serializes against both CAS and plain writes via per-entity write
   * locks so check-then-write cannot interleave with any concurrent
   * store mutations on the same subjects.
   * Throws StaleWriteError if any condition fails.
   */
  async conditionalShare(
    contextGraphId: string,
    quads: Quad[],
    options: ConditionalShareOptions,
  ): Promise<ShareResult> {
    for (const cond of options.conditions) {
      assertSafeIri(cond.subject);
      assertSafeIri(cond.predicate);
      if (cond.expectedValue !== null) {
        assertSafeRdfTerm(cond.expectedValue);
      }
    }

    const conditionSubjects = options.conditions.map(c => c.subject);
    const quadSubjects = [...new Set(quads.map(q => q.subject))];
    const lockKeys = [...new Set([...conditionSubjects, ...quadSubjects])].map(s => `${contextGraphId}\0${s}`);

    return this.withWriteLocks(lockKeys, () => this._executeConditionalWrite(contextGraphId, quads, options));
  }

  /** @deprecated Use conditionalShare() */
  async writeConditionalToWorkspace(
    contextGraphId: string,
    quads: Quad[],
    options: ConditionalShareOptions,
  ): Promise<ShareResult> {
    return this.conditionalShare(contextGraphId, quads, options);
  }

  private async _executeConditionalWrite(
    contextGraphId: string,
    quads: Quad[],
    options: ConditionalShareOptions,
  ): Promise<ShareResult> {
    const ctx = options.operationCtx ?? createOperationContext('share');

    await this.graphManager.ensureContextGraph(contextGraphId);
    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId);

    for (const cond of options.conditions) {
      const ask = cond.expectedValue === null
        ? `ASK { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ?o } }`
        : `ASK { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ${cond.expectedValue} } }`;
      const result = await this.store.query(ask);

      if (result.type !== 'boolean') {
        throw new Error(`CAS condition query returned unexpected type "${result.type}" for <${cond.subject}> <${cond.predicate}>`);
      }

      const shouldExist = cond.expectedValue !== null;
      if (result.value !== shouldExist) {
        const sel = `SELECT ?o WHERE { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ?o } } LIMIT 1`;
        const cur = await this.store.query(sel);
        const actual = cur.type === 'bindings' && cur.bindings.length > 0 ? cur.bindings[0].o ?? null : null;
        throw new StaleWriteError(cond, actual);
      }
    }

    this.log.info(ctx, `CAS conditions passed (${options.conditions.length}), proceeding with write`);
    return this._shareImpl(contextGraphId, quads, {
      ...options,
      conditions: options.conditions,
    });
  }

  /**
   * Read quads from the context graph's shared memory and publish them with full finality (data graph + chain).
   * Selection: 'all' or { rootEntities: string[] } to publish only those root entities from shared memory.
   */
  async publishFromSharedMemory(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    options?: {
      operationCtx?: OperationContext;
      clearSharedMemoryAfter?: boolean;
      onPhase?: PhaseCallback;
      publishContextGraphId?: string;
      contextGraphSignatures?: Array<{ identityId: bigint; r: Uint8Array; vs: Uint8Array }>;
      v10ACKProvider?: PublishOptions['v10ACKProvider'];
      subGraphName?: string;
    },
  ): Promise<PublishResult> {
    const ctx = options?.operationCtx ?? createOperationContext('publishFromSWM');
    const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, options?.subGraphName);

    let sparql: string;
    if (selection === 'all') {
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`;
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
            : `No rootEntities provided for context graph ${contextGraphId}`,
        );
      }
      const values = roots.map((r) => `<${r}>`).join(' ');
      sparql = `CONSTRUCT { ?s ?p ?o } WHERE {
        GRAPH <${swmGraph}> {
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
      throw new Error(`No quads in shared memory for context graph ${contextGraphId} matching selection`);
    }

    const ctxGraphId = options?.publishContextGraphId;
    if (ctxGraphId !== undefined && ctxGraphId !== null) {
      try { BigInt(ctxGraphId); } catch {
        throw new Error(`Invalid publishContextGraphId: ${String(ctxGraphId)} (must be a numeric value)`);
      }
    }

    if (options?.subGraphName && ctxGraphId) {
      throw new Error(
        'subGraphName and publishContextGraphId cannot be used together — ' +
        'the remap flow targets /context/{id} which is incompatible with sub-graph URIs',
      );
    }

    this.log.info(ctx, `Publishing ${quads.length} quads from shared memory to ${ctxGraphId ? `context graph ${ctxGraphId}` : 'data graph'}${options?.subGraphName ? ` (sub-graph: ${options.subGraphName})` : ''}`);
    const publishResult = await this.publish({
      contextGraphId,
      quads: quads.map((q) => ({ ...q, graph: '' })),
      operationCtx: ctx,
      onPhase: options?.onPhase,
      v10ACKProvider: options?.v10ACKProvider,
      publishContextGraphId: ctxGraphId ?? undefined,
      fromSharedMemory: true,
      subGraphName: options?.subGraphName,
    });

    if (ctxGraphId && publishResult.status === 'confirmed' && publishResult.onChainResult) {
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
          if (typeof this.chain.verify !== 'function') {
            throw new Error('verify (addBatchToContextGraph) not available on chain adapter');
          }
          const txResult = await this.chain.verify({
            contextGraphId: BigInt(ctxGraphId),
            batchId: publishResult.onChainResult.batchId,
            merkleRoot: publishResult.merkleRoot,
            signerSignatures: sortedSigs,
          });
          if (txResult && typeof txResult === 'object' && 'success' in txResult && !txResult.success) {
            throw new Error(`verify returned success=false`);
          }
          registered = true;
          this.log.info(ctx, `Batch ${publishResult.onChainResult.batchId} verified on context graph ${ctxGraphId}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < maxRetries) {
            this.log.info(ctx, `verify attempt ${attempt} failed, retrying: ${msg}`);
            await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
          } else {
            this.log.warn(ctx, `verify failed after ${maxRetries} attempts: ${msg}`);

            this.eventBus.emit(DKGEvent.PUBLISH_FAILED, {
              reason: 'context_graph_registration_failed',
              batchId: String(publishResult.onChainResult.batchId),
              contextGraphId: ctxGraphId,
              error: msg,
            });
            return {
              ...publishResult,
              contextGraphError: `verify failed after ${maxRetries} attempts: ${msg}`,
            };
          }
        }
      }

      if (registered) {
        const ctxDataGraph = contextGraphDataUri(contextGraphId, ctxGraphId);
        const ctxMetaGraph = contextGraphMetaUri(contextGraphId, ctxGraphId);
        const defaultDataGraph = this.graphManager.dataGraphUri(contextGraphId);
        const defaultMetaGraph = `${defaultDataGraph.replace(/\/data$/, '')}/_meta`;

        if (publishResult.publicQuads && publishResult.publicQuads.length > 0) {
          const storedQuads = publishResult.publicQuads.map(q => ({ ...q, graph: defaultDataGraph }));
          await this.store.insert(storedQuads.map(q => ({ ...q, graph: ctxDataGraph })));
          await this.store.delete(storedQuads);
        }

        const ual = publishResult.ual;
        const kaUals = publishResult.kaManifest.map(ka => `${ual}/${ka.tokenId}`);
        const metaSubjects = new Set([ual, ...kaUals]);
        const metaQuery = `CONSTRUCT { ?s ?p ?o } WHERE {
          GRAPH <${defaultMetaGraph}> {
            VALUES ?s { ${[...metaSubjects].map(s => `<${s}>`).join(' ')} }
            ?s ?p ?o .
          }
        }`;
        const metaResult = await this.store.query(metaQuery);
        if (metaResult.type === 'quads' && metaResult.quads.length > 0) {
          await this.store.insert(metaResult.quads.map(q => ({ ...q, graph: ctxMetaGraph })));
          await this.store.delete(metaResult.quads.map(q => ({ ...q, graph: defaultMetaGraph })));
        }

        this.log.info(ctx, `Promoted ${publishResult.kaManifest.length} KAs from default graph to context graph ${ctxGraphId}`);
      }
    }

    // SWM cleanup: ALWAYS remove published triples from SWM after chain confirmation.
    // Published triples must not linger in SWM — they live in LTM now.
    // clearSharedMemoryAfter controls only whether the REMAINING unpublished triples are also cleared.
    if (publishResult.status === 'confirmed') {
      const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, options?.subGraphName);
      const swmOwnershipKey = options?.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
      const kaMap = autoPartition(quads);
      let ownerDeletedTotal = 0;
      for (const rootEntity of kaMap.keys()) {
        await this.store.deleteByPattern({ graph: swmGraph, subject: rootEntity });
        await this.store.deleteBySubjectPrefix(swmGraph, rootEntity + '/.well-known/genid/');
        const ownerDeleted = await this.store.deleteByPattern({
          graph: swmMetaGraph, subject: rootEntity, predicate: 'http://dkg.io/ontology/workspaceOwner',
        });
        ownerDeletedTotal += ownerDeleted;
        await this.deleteMetaForRoot(swmMetaGraph, rootEntity);
        this.sharedMemoryOwnedEntities.get(swmOwnershipKey)?.delete(rootEntity);
      }
      if (ownerDeletedTotal > 0) {
        this.log.info(ctx, `Cleared ${ownerDeletedTotal} published SWM triple(s) after confirmed publish`);
      }
      // If clearSharedMemoryAfter is explicitly true, also clear any remaining unpublished content.
      // Default is false: unpublished entities stay in SWM for future publishes.
      if (options?.clearSharedMemoryAfter === true) {
        const remainingCount = await this.store.deleteByPattern({ graph: swmGraph });
        const remainingMetaCount = await this.store.deleteByPattern({ graph: swmMetaGraph });
        if (remainingCount > 0 || remainingMetaCount > 0) {
          this.log.info(ctx, `Cleared remaining SWM content: ${remainingCount} triples, ${remainingMetaCount} meta`);
        }
        this.sharedMemoryOwnedEntities.delete(swmOwnershipKey);
      }
    }

    return publishResult;
  }

  /** @deprecated Use publishFromSharedMemory. Will be removed in V10.1. */
  async enshrineFromWorkspace(...args: Parameters<DKGPublisher['publishFromSharedMemory']>): ReturnType<DKGPublisher['publishFromSharedMemory']> {
    return this.publishFromSharedMemory(...args);
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
    // Sub-graph routing: data triples go to `did:dkg:context-graph:{id}/{subGraph}`.
    // KC metadata (status, authorship proofs) stays in the root `_meta` graph so that
    // AccessHandler.lookupKAMeta() and DKGQueryEngine.resolveKA() can still discover
    // the KC without knowing which sub-graph holds the data triples.
    if (options.subGraphName && !options.targetGraphUri) {
      const sgValidation = validateSubGraphName(options.subGraphName);
      if (!sgValidation.valid) throw new Error(`Invalid sub-graph name: ${sgValidation.reason}`);

      const sgUri = contextGraphSubGraphUri(options.contextGraphId, options.subGraphName);
      const registered = await this.store.query(
        `ASK { GRAPH <did:dkg:context-graph:${assertSafeIri(options.contextGraphId)}/_meta> { <${assertSafeIri(sgUri)}> ?p ?o } }`,
      );
      if (registered.type === 'boolean' && !registered.value) {
        throw new Error(
          `Sub-graph "${options.subGraphName}" has not been registered in context graph "${options.contextGraphId}". ` +
          `Call createSubGraph() first.`,
        );
      }

      options = {
        ...options,
        targetGraphUri: sgUri,
      };
    }

    const {
      contextGraphId,
      quads,
      privateQuads = [],
      publisherPeerId = '',
      accessPolicy,
      allowedPeers,
      operationCtx,
      entityProofs = false,
      onPhase,
    } = options;
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');
    const effectiveAccessPolicy = accessPolicy ?? (privateQuads.length > 0 ? 'ownerOnly' : 'public');
    const normalizedAllowedPeers = [...new Set((allowedPeers ?? []).map((p) => p.trim()).filter(Boolean))];
    const normalizedPublisherPeerId = publisherPeerId.trim();

    if (effectiveAccessPolicy !== 'public' && normalizedPublisherPeerId.length === 0) {
      throw new Error(
        `Publish rejected: accessPolicy "${effectiveAccessPolicy}" requires a non-empty "publisherPeerId"`,
      );
    }

    if (effectiveAccessPolicy === 'allowList' && normalizedAllowedPeers.length === 0) {
      throw new Error('Publish rejected: accessPolicy "allowList" requires non-empty "allowedPeers"');
    }
    if (effectiveAccessPolicy !== 'allowList' && normalizedAllowedPeers.length > 0) {
      throw new Error('Publish rejected: "allowedPeers" is only valid when accessPolicy is "allowList"');
    }

    onPhase?.('prepare', 'start');
    onPhase?.('prepare:ensureContextGraph', 'start');
    this.log.info(ctx, `Preparing publish: ${quads.length} public triples, ${privateQuads.length} private`);
    await this.graphManager.ensureContextGraph(contextGraphId);
    onPhase?.('prepare:ensureContextGraph', 'end');

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
    const publishOwnershipKey = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
    const existing = this.ownedEntities.get(publishOwnershipKey) ?? new Set();
    const validation = validatePublishRequest(allSkolemizedQuads, manifestEntries, contextGraphId, existing);
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
    }
    onPhase?.('prepare:validate', 'end');

    onPhase?.('prepare:merkle', 'start');
    const privateRoots = manifestEntries
      .map(m => m.privateMerkleRoot)
      .filter((r): r is Uint8Array => r != null);
    const kcMerkleRoot = computeFlatKCRoot(allSkolemizedQuads, privateRoots);
    this.log.info(ctx, `Computed kcMerkleRoot (flat) over ${allSkolemizedQuads.length} triple hashes + ${privateRoots.length} private root(s)`);
    const kaCount = manifestEntries.length;
    onPhase?.('prepare:merkle', 'end');

    onPhase?.('prepare', 'end');
    onPhase?.('store', 'start');

    const dataGraph = options.targetGraphUri ?? this.graphManager.dataGraphUri(contextGraphId);
    const normalizedQuads = allSkolemizedQuads.map((q) => ({ ...q, graph: dataGraph }));

    this.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store`);
    await this.store.insert(normalizedQuads);

    // Store private quads
    for (const [rootEntity] of kaMap) {
      const entityPrivateQuads = privateQuads.filter(
        (q) => q.subject === rootEntity || q.subject.startsWith(rootEntity + '/.well-known/genid/'),
      );
      if (entityPrivateQuads.length > 0) {
        await this.privateStore.storePrivateTriples(contextGraphId, rootEntity, entityPrivateQuads);
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

    // V10: Collect core node StorageACKs (spec §9.0, Phase 3).
    // For direct publish: send staging quads inline via P2P so core nodes
    // can verify the merkle root without needing SWM pre-positioning.
    // For publishFromSharedMemory (publishContextGraphId set): data is already in
    // peers' SWM via shared memory gossip — do NOT send inline quads; core nodes
    // verify against their local SWM copy (preserving storage-attestation).
    // Skipped for private publishes because StorageACKHandler cannot
    // recompute private merkle roots from SWM data alone.
    const hasPrivateData = privateRoots.length > 0;
    const isPublishFromSharedMemory = !!options.fromSharedMemory;
    const stagingQuads = isPublishFromSharedMemory
      ? undefined
      : new TextEncoder().encode(nquadsStr);

    // Pre-compute tokenAmount and epochs so they can be included in the 6-field ACK digest.
    const publishEpochs = 1;
    let precomputedTokenAmount = 0n;
    if (this.publisherWallet && typeof this.chain.getRequiredPublishTokenAmount === 'function') {
      precomputedTokenAmount = await this.chain.getRequiredPublishTokenAmount(publicByteSize, publishEpochs);
      if (precomputedTokenAmount <= 0n) {
        this.log.warn(ctx, `getRequiredPublishTokenAmount returned ${precomputedTokenAmount} for byteSize=${publicByteSize} — using 1n as minimum`);
        precomputedTokenAmount = 1n;
      }
    }

    let v10ACKs: Array<{ peerId: string; signatureR: Uint8Array; signatureVS: Uint8Array; nodeIdentityId: bigint }> | undefined;
    if (options.v10ACKProvider && !hasPrivateData) {
      onPhase?.('collect_v10_acks', 'start');
      try {
        const rootEntities = manifestEntries.map(m => m.rootEntity);
        const ackDomain = isPublishFromSharedMemory
          ? contextGraphId
          : (options.publishContextGraphId ?? contextGraphId);
        v10ACKs = await options.v10ACKProvider(
          kcMerkleRoot, ackDomain, kaCount, rootEntities, publicByteSize, stagingQuads,
          publishEpochs, precomputedTokenAmount,
        );
        this.log.info(ctx, `V10: Collected ${v10ACKs.length} core node ACKs`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(ctx, `V10 ACK collection failed — will attempt self-signed ACK fallback: ${msg}`);
      } finally {
        onPhase?.('collect_v10_acks', 'end');
      }
    } else if (options.v10ACKProvider && hasPrivateData) {
      this.log.info(ctx, `V10 ACK collection skipped: publish contains private quads (${privateRoots.length} private roots)`);
    }

    // Self-sign ACK as last resort: single-node mode (no provider), or when
    // ACK collection was skipped for private data, or when collection failed.
    // On networks requiring > 1 signature, a single self-signed ACK will be
    // rejected on-chain by minimumRequiredSignatures — this is intentional:
    // the contract is the ultimate gatekeeper.
    if (!v10ACKs && this.publisherWallet && this.publisherNodeIdentityId > 0n) {
      const reason = !options.v10ACKProvider ? 'no v10ACKProvider (single-node mode)' : 'ACK collection failed/skipped';
      this.log.info(ctx, `Self-signing ACK — ${reason}`);
      const cgIdForACK = (() => {
        // Must match the ackDomain used by the provider path and publisher signature
        const raw = isPublishFromSharedMemory
          ? contextGraphId
          : (options.publishContextGraphId ?? contextGraphId);
        try { return BigInt(raw); } catch { return 0n; }
      })();
      const ackDigest = computeACKDigest(
        cgIdForACK, kcMerkleRoot, kaCount, publicByteSize, publishEpochs, precomputedTokenAmount,
      );
      const ackSig = ethers.Signature.from(
        await this.publisherWallet.signMessage(ackDigest),
      );
      v10ACKs = [{
        peerId: 'self',
        signatureR: ethers.getBytes(ackSig.r),
        signatureVS: ethers.getBytes(ackSig.yParityAndS),
        nodeIdentityId: this.publisherNodeIdentityId,
      }];
    }

    onPhase?.('chain', 'start');

    let onChainResult: OnChainPublishResult | undefined;
    let status: 'tentative' | 'confirmed' = 'tentative';
    const tentativeSeq = ++this.tentativeCounter;
    let ual = `did:dkg:${this.chain.chainId}/${this.publisherAddress}/t${this.sessionId}-${tentativeSeq}`;

    const identityId = this.publisherNodeIdentityId;
    let usedV10Path = false;

    if (!this.publisherWallet) {
      this.log.warn(ctx, `No EVM wallet configured — skipping on-chain publish`);
    } else if (identityId === 0n) {
      this.log.warn(ctx, `Identity not set (0) — skipping on-chain publish`);
    } else {
      onPhase?.('chain:sign', 'start');
      this.log.info(ctx, `Signing on-chain publish (identityId=${identityId}, signer=${this.publisherWallet.address})`);

      const tokenAmount = precomputedTokenAmount;
      usedV10Path = true;

      // Resolve contextGraphId for V10 on-chain publish.
      // Must match the mapping used by ACKCollector and StorageACKHandler so
      // the ACK digest is consistent across all parties.
      const ackDomainForSig = isPublishFromSharedMemory
        ? contextGraphId
        : (options.publishContextGraphId ?? contextGraphId);
      let cgIdForSig: bigint;
      try {
        cgIdForSig = BigInt(ackDomainForSig);
      } catch {
        // Non-numeric CG names are virtual/off-chain — pass 0 so the contract
        // skips on-chain CG authorization (only on-chain CGs have governance).
        cgIdForSig = 0n;
      }

      onPhase?.('chain:sign', 'end');
      onPhase?.('chain:submit', 'start');
      this.log.info(ctx, `Submitting V10 on-chain publish tx (${kaCount} KAs, publicByteSize=${publicByteSize}, tokenAmount=${tokenAmount})`);
      try {
        if (!v10ACKs || v10ACKs.length === 0) {
          throw new Error('V10 ACKs required for on-chain publish — no ACKs collected');
        }
        if (typeof this.chain.createKnowledgeAssetsV10 !== 'function') {
          throw new Error('Chain adapter does not support V10 publish (createKnowledgeAssetsV10 not available)');
        }
        // V10 publisher signature: keccak256(abi.encodePacked(uint256 contextGraphId, uint72 identityId, bytes32 merkleRoot))
        const pubMsgHash = ethers.solidityPackedKeccak256(
          ['uint256', 'uint72', 'bytes32'],
          [cgIdForSig, identityId, merkleRootHex],
        );
        const pubSig = ethers.Signature.from(
          await this.publisherWallet.signMessage(ethers.getBytes(pubMsgHash)),
        );
        onChainResult = await this.chain.createKnowledgeAssetsV10!({
          publishOperationId: `${this.sessionId}-${tentativeSeq}`,
          contextGraphId: cgIdForSig,
          merkleRoot: kcMerkleRoot,
          knowledgeAssetsAmount: kaCount,
          byteSize: publicByteSize,
          epochs: 1,
          tokenAmount,
          isImmutable: false,
          paymaster: ethers.ZeroAddress,
          convictionAccountId: 0n,
          publisherNodeIdentityId: identityId,
          publisherSignature: {
            r: ethers.getBytes(pubSig.r),
            vs: ethers.getBytes(pubSig.yParityAndS),
          },
          ackSignatures: v10ACKs.map(ack => ({
            identityId: ack.nodeIdentityId,
            r: ack.signatureR,
            vs: ack.signatureVS,
          })),
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
            contextGraphId,
            merkleRoot: kcMerkleRoot,
            kaCount,
            publisherPeerId: normalizedPublisherPeerId || 'unknown',
            accessPolicy: effectiveAccessPolicy,
            allowedPeers: normalizedAllowedPeers,
            timestamp: new Date(),
            subGraphName: options.subGraphName,
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
          const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
          confirmedQuads = confirmedQuads.map((q) =>
            q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
          );
        }
        await this.store.insert(confirmedQuads);

        // Agent authorship proof (spec §9.0.6): sign keccak256(merkleRoot) and store in _meta
        if (this.publisherWallet) {
          try {
            const merkleHashBytes = ethers.keccak256(kcMerkleRoot);
            const sig = await this.publisherWallet.signMessage(ethers.getBytes(merkleHashBytes));
            const proofQuads = generateAuthorshipProof({
              kcUal: ual,
              contextGraphId,
              agentAddress: this.publisherWallet.address,
              signature: sig,
              signedHash: merkleHashBytes,
            });
            if (options.targetMetaGraphUri) {
              const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
              const remapped = proofQuads.map((q) =>
                q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
              );
              await this.store.insert(remapped);
            } else {
              await this.store.insert(proofQuads);
            }
            this.log.info(ctx, `Authorship proof stored for agent ${this.publisherWallet.address}`);
          } catch (proofErr) {
            this.log.warn(ctx, `Failed to generate authorship proof: ${proofErr instanceof Error ? proofErr.message : String(proofErr)}`);
          }
        }

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
          contextGraphId,
          merkleRoot: kcMerkleRoot,
          kaCount,
          publisherPeerId: normalizedPublisherPeerId || 'unknown',
          accessPolicy: effectiveAccessPolicy,
          allowedPeers: normalizedAllowedPeers,
          timestamp: new Date(),
          subGraphName: options.subGraphName,
        },
        kaMetadata,
      );
      if (options.targetMetaGraphUri) {
        const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
        tentativeQuads = tentativeQuads.map((q) =>
          q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
        );
      }
      await this.store.insert(tentativeQuads);
      this.log.info(ctx, `Stored as tentative: UAL=${ual}`);
    }

    // Track owned entities and batch→context graph binding on confirmed publishes
    if (status === 'confirmed' && onChainResult) {
      const confirmOwnershipKey = options.subGraphName ? `${contextGraphId}\0${options.subGraphName}` : contextGraphId;
      if (!this.ownedEntities.has(confirmOwnershipKey)) {
        this.ownedEntities.set(confirmOwnershipKey, new Set());
      }
      for (const e of manifestEntries) {
        this.ownedEntities.get(confirmOwnershipKey)!.add(e.rootEntity);
      }
      this.knownBatchContextGraphs.set(String(onChainResult.batchId), contextGraphId);
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
      v10ACKs,
      v10Origin: usedV10Path,
      subGraphName: options.subGraphName,
    };

    this.eventBus.emit(DKGEvent.KC_PUBLISHED, result);
    return result;
  }

  async update(kcId: bigint, options: PublishOptions): Promise<PublishResult> {
    const { contextGraphId, quads, privateQuads = [], operationCtx, onPhase } = options;
    const ctx: OperationContext = operationCtx ?? createOperationContext('publish');
    this.log.info(ctx, `Updating kcId=${kcId} with ${quads.length} triples`);
    const dataGraph = this.graphManager.dataGraphUri(contextGraphId);

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
    const updatePrivateRoots = manifestEntries
      .map(m => m.privateMerkleRoot)
      .filter((r): r is Uint8Array => r != null);
    const kcMerkleRoot = computeFlatKCRoot(allSkolemizedQuads, updatePrivateRoots);
    onPhase?.('prepare:merkle', 'end');
    onPhase?.('prepare', 'end');

    onPhase?.('chain', 'start');
    onPhase?.('chain:submit', 'start');

    // Compute real serialized byte size — must match the publish path serializer
    const updateNquadsStr = allSkolemizedQuads
      .map(
        (q: { subject: string; predicate: string; object: string; graph?: string }) =>
          `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph || ''}> .`,
      )
      .join('\n');
    const updateByteSize = BigInt(new TextEncoder().encode(updateNquadsStr).length);

    let txResult: { success: boolean; hash: string; blockNumber?: number };
    if (typeof this.chain.updateKnowledgeCollectionV10 === 'function') {
      try {
        txResult = await this.chain.updateKnowledgeCollectionV10({
          kcId,
          newMerkleRoot: kcMerkleRoot,
          newByteSize: updateByteSize,
          publisherAddress: this.publisherAddress,
          v10Origin: true,
        });
      } catch (v10Err) {
        // V10 update failed — KC may live in V9 storage. Try legacy path.
        if (typeof this.chain.updateKnowledgeAssets === 'function') {
          this.log.info(ctx, `V10 update failed, trying V9 path: ${v10Err instanceof Error ? v10Err.message : String(v10Err)}`);
          txResult = await this.chain.updateKnowledgeAssets({
            batchId: kcId,
            newMerkleRoot: kcMerkleRoot,
            newPublicByteSize: updateByteSize,
            publisherAddress: this.publisherAddress,
          });
        } else {
          throw v10Err;
        }
      }
    } else if (typeof this.chain.updateKnowledgeAssets === 'function') {
      txResult = await this.chain.updateKnowledgeAssets({
        batchId: kcId,
        newMerkleRoot: kcMerkleRoot,
        newPublicByteSize: updateByteSize,
        publisherAddress: this.publisherAddress,
      });
    } else {
      throw new Error('Chain adapter does not support updates (no V10 or V9 update method available)');
    }

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
      await this.privateStore.deletePrivateTriples(contextGraphId, rootEntity);

      const normalized = publicQuads.map((q) => ({ ...q, graph: dataGraph }));
      await this.store.insert(normalized);

      const entityPrivateQuads = entityPrivateMap.get(rootEntity) ?? [];
      if (entityPrivateQuads.length > 0) {
        await this.privateStore.storePrivateTriples(contextGraphId, rootEntity, entityPrivateQuads);
      }
    }

    try {
      await updateMetaMerkleRoot(this.store, this.graphManager, contextGraphId, kcId, kcMerkleRoot);
    } catch (err) {
      this.log.warn(
        ctx,
        `Failed to sync _meta merkleRoot for kcId=${kcId}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
        blockNumber: txResult.blockNumber ?? 0,
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
   * Reconstruct the in-memory sharedMemoryOwnedEntities map from persisted
   * ownership triples in SWM meta graphs. Call on startup.
   *
   * Validates each ownership triple against share-operation metadata
   * (wasAttributedTo) to guard against tampered triples. Conflicts are
   * resolved deterministically by keeping the alphabetically first creator.
   */
  async reconstructSharedMemoryOwnership(): Promise<number> {
    const DKG = 'http://dkg.io/ontology/';
    const PROV = 'http://www.w3.org/ns/prov#';
    try {
      const contextGraphs = await this.graphManager.listContextGraphs();
      let total = 0;
      for (const cgId of contextGraphs) {
        const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(cgId);
        const result = await this.store.query(
          `SELECT ?entity ?creator WHERE { GRAPH <${swmMetaGraph}> { ?entity <${DKG}workspaceOwner> ?creator } }`,
        );
        if (result.type !== 'bindings' || result.bindings.length === 0) continue;

        const opsResult = await this.store.query(
          `SELECT ?op ?peer ?root WHERE { GRAPH <${swmMetaGraph}> { ?op <${PROV}wasAttributedTo> ?peer . ?op <${DKG}rootEntity> ?root } }`,
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

        if (!this.sharedMemoryOwnedEntities.has(cgId)) {
          this.sharedMemoryOwnedEntities.set(cgId, new Map());
        }
        const ownedMap = this.sharedMemoryOwnedEntities.get(cgId)!;
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
        `reconstructSharedMemoryOwnership failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /** @deprecated Use reconstructSharedMemoryOwnership */
  async reconstructWorkspaceOwnership(): Promise<number> {
    return this.reconstructSharedMemoryOwnership();
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

  // ── Working Memory Draft Operations (spec §6) ────────────────────────

  private static validateOptionalSubGraph(subGraphName: string | undefined): void {
    if (subGraphName !== undefined) {
      const v = validateSubGraphName(subGraphName);
      if (!v.valid) throw new Error(`Invalid sub-graph name: ${v.reason}`);
    }
  }

  clearSubGraphOwnership(ownershipKey: string): void {
    this.sharedMemoryOwnedEntities.delete(ownershipKey);
  }

  async draftCreate(contextGraphId: string, draftName: string, agentAddress: string, subGraphName?: string): Promise<string> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    const graphUri = contextGraphDraftUri(contextGraphId, agentAddress, draftName, subGraphName);
    await this.store.createGraph(graphUri);
    return graphUri;
  }

  async draftWrite(
    contextGraphId: string,
    draftName: string,
    agentAddress: string,
    input: Quad[] | Array<{ subject: string; predicate: string; object: string }>,
    subGraphName?: string,
  ): Promise<void> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    const graphUri = contextGraphDraftUri(contextGraphId, agentAddress, draftName, subGraphName);
    const quads = input.map((t) => ({
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      graph: graphUri,
    }));
    await this.store.insert(quads);
  }

  async draftQuery(
    contextGraphId: string,
    draftName: string,
    agentAddress: string,
    subGraphName?: string,
  ): Promise<Quad[]> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    const graphUri = contextGraphDraftUri(contextGraphId, agentAddress, draftName, subGraphName);
    const result = await this.store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`,
    );
    return result.type === 'quads' ? result.quads : [];
  }

  async draftPromote(
    contextGraphId: string,
    draftName: string,
    agentAddress: string,
    opts?: { entities?: string[] | 'all'; subGraphName?: string },
  ): Promise<{ promotedCount: number }> {
    DKGPublisher.validateOptionalSubGraph(opts?.subGraphName);
    const graphUri = contextGraphDraftUri(contextGraphId, agentAddress, draftName, opts?.subGraphName);
    const swmGraphUri = this.graphManager.sharedMemoryUri(contextGraphId, opts?.subGraphName);

    const result = await this.store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`,
    );
    if (result.type !== 'quads' || result.quads.length === 0) return { promotedCount: 0 };

    let quadsToPromote = result.quads;

    if (opts?.entities && opts.entities !== 'all') {
      const entitySet = new Set(opts.entities);
      const genidPrefixes = opts.entities.map((e) => `${e}/.well-known/genid/`);
      quadsToPromote = quadsToPromote.filter(
        (q) =>
          entitySet.has(q.subject) ||
          genidPrefixes.some((prefix) => q.subject.startsWith(prefix)),
      );
    }

    const swmQuads = quadsToPromote.map((q) => ({ ...q, graph: swmGraphUri }));
    await this.store.insert(swmQuads);

    // Delete promoted triples from draft
    await this.store.delete(quadsToPromote.map((q) => ({ ...q, graph: graphUri })));

    // Record ShareTransition metadata in _shared_memory_meta (spec §8)
    const entities = [...new Set(quadsToPromote.map((q) => q.subject))];
    const operationId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const shareMetadata = generateShareTransitionMetadata({
      contextGraphId,
      operationId,
      agentAddress,
      draftName,
      entities,
      timestamp: new Date(),
    });
    await this.store.insert(shareMetadata);

    return { promotedCount: swmQuads.length };
  }

  async draftDiscard(contextGraphId: string, draftName: string, agentAddress: string, subGraphName?: string): Promise<void> {
    DKGPublisher.validateOptionalSubGraph(subGraphName);
    const graphUri = contextGraphDraftUri(contextGraphId, agentAddress, draftName, subGraphName);
    await this.store.dropGraph(graphUri);
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
