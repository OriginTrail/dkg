import {
  decodePublishRequest, SYSTEM_CONTEXT_GRAPHS, isAgentRegistryContextGraph, DKG_ONTOLOGY,
  Logger, createOperationContext,
  isSafeIri, assertSafeIri, validateSubGraphName, validateContextGraphId,
  contextGraphSubGraphUri,
  contextGraphMetaGraphUri, contextGraphDataGraphUri,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  tryReplaceGraphAtomically,
  type TripleStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { type ChainAdapter, type EventFilter } from '@origintrail-official/dkg-chain';
import {
  computeTripleHashV10 as computeTripleHash, computeFlatKCRootV10 as computeFlatKCRoot, skolemizeByEntity,
  generateTentativeMetadata, getTentativeStatusQuad, getConfirmedStatusQuad,
  generateGraphKnowledgeAssetMetadata,
  resolveKnowledgeAssetWorkspaceHead,
  workspacePublicQuadsDigest,
  shouldApplyMaterialization,
  withMaterializationLock,
  writeMaterializedVersion,
  validatePublishRequest, parseSimpleNQuads, generateSubGraphRegistration,
  type KAMetadata,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import type { ContextGraphMetaRecord } from './context-graph-meta-projection.js';
import type { ContextGraphDiscoveryMetadata, ContextGraphSub } from './dkg-agent-types.js';

export type GossipPhaseCallback = (phase: string, status: 'start' | 'end') => void;

interface GraphScopedPublishRequest {
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  publicTripleCount: number;
  privateTripleCount: number;
  privateMerkleRoot?: Uint8Array;
  accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers: string[];
}

function resolveGraphScopedPublishRequest(
  request: ReturnType<typeof decodePublishRequest>,
): GraphScopedPublishRequest | undefined {
  const privateMerkleRoot = request.privateMerkleRoot?.length
    ? new Uint8Array(request.privateMerkleRoot)
    : undefined;
  const hasGraphField =
    (request.contentScopeVersion ?? 0) !== 0
    || Boolean(request.assertionVersion)
    || (request.publicTripleCount ?? 0) > 0
    || privateMerkleRoot !== undefined
    || (request.privateTripleCount ?? 0) > 0
    || Boolean(request.accessPolicy)
    || (request.allowedPeers?.length ?? 0) > 0;
  if (!hasGraphField) return undefined;
  if (request.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(
      `Graph-scoped gossip requires contentScopeVersion=${GRAPH_KA_CONTENT_SCOPE_VERSION}`,
    );
  }
  if (!request.ual) {
    throw new Error('Graph-scoped gossip requires a UAL');
  }
  if (!request.assertionVersion || request.kas.length !== 0) {
    throw new Error('Graph-scoped gossip requires assertionVersion and no legacy KA manifest');
  }
  const scope = createGraphKnowledgeAssetScope(request.ual, request.assertionVersion);
  if (
    scope.ual !== request.ual
    || scope.assertionVersion !== '1'
    || !request.chainId
    || scope.chainId !== request.chainId
  ) {
    throw new Error('Graph-scoped gossip has a non-canonical initial KA scope');
  }
  const kaNumber = BigInt(scope.kaNumber);
  if (kaNumber >= (1n << 96n)) {
    throw new Error('Graph-scoped gossip KA number exceeds the 96-bit author namespace');
  }
  const packedKaId = (BigInt(scope.agentAddress) << 96n) | kaNumber;
  const startKAId = protoToBigInt(request.startKAId ?? 0);
  const endKAId = protoToBigInt(request.endKAId ?? 0);
  if (startKAId !== packedKaId || endKAId !== packedKaId) {
    throw new Error(
      `Graph-scoped gossip UAL-derived kaId ${packedKaId} does not match ` +
        `published range ${startKAId}..${endKAId}`,
    );
  }
  const publicTripleCount = request.publicTripleCount ?? 0;
  const privateTripleCount = request.privateTripleCount ?? 0;
  if (
    !Number.isSafeInteger(publicTripleCount)
    || publicTripleCount < 0
    || !Number.isSafeInteger(privateTripleCount)
    || privateTripleCount < 0
    || (publicTripleCount === 0 && privateTripleCount === 0)
    || (privateTripleCount > 0 && privateMerkleRoot?.length !== 32)
    || (privateTripleCount === 0 && privateMerkleRoot !== undefined)
  ) {
    throw new Error('Graph-scoped gossip has an invalid content envelope');
  }
  const accessPolicy = request.accessPolicy;
  if (accessPolicy !== 'public' && accessPolicy !== 'ownerOnly' && accessPolicy !== 'allowList') {
    throw new Error(`Graph-scoped gossip has invalid accessPolicy: ${accessPolicy || '(empty)'}`);
  }
  const rawAllowedPeers = request.allowedPeers ?? [];
  const allowedPeers = [...new Set(rawAllowedPeers.map((peer) => peer.trim()).filter(Boolean))];
  if (
    allowedPeers.length !== rawAllowedPeers.length
    || (accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) {
    throw new Error('Graph-scoped gossip has an invalid access-policy peer envelope');
  }
  return {
    scope,
    publicTripleCount,
    privateTripleCount,
    ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
    accessPolicy,
    allowedPeers,
  };
}

export interface GossipPublishHandlerCallbacks {
  contextGraphExists: (id: string) => Promise<boolean>;
  getContextGraphOwner: (id: string) => Promise<string | null>;
  setContextGraphSubscription?: (id: string, next: ContextGraphSub, options?: { persist?: boolean }) => void;
  /**
   * Record a Context Graph learned from ontology gossip. Agent-backed callers
   * apply the node-role policy centrally (edge=catalogue-only, core=activate);
   * standalone handlers fall back to an in-memory passive catalogue record.
   */
  recordDiscoveredContextGraph?: (id: string, metadata: ContextGraphDiscoveryMetadata) => void;
  /**
   * Same semantics as `DKGAgent#hasConfirmedMetaState`: returns true when the
   * local store already has a trustworthy public announcement for this CG
   * (system contextGraph, populated `_meta` graph, or `<cg> rdf:type dkg:ContextGraph`
   * asserted in ontology). Used to open the metaSynced gate lazily when
   * gossip arrives before `refreshMetaSyncedFlags` has had a chance to run.
   *
   * Optional — callers (notably the standalone gossip-handler tests) may
   * omit this without breaking the callback contract. When absent, the
   * strict deny behavior for unsynced curated CGs is preserved (as if the
   * callback returned `false`).
   */
  hasConfirmedMetaState?: (id: string) => Promise<boolean>;
  getCgMeta?: (id: string) => Promise<ContextGraphMetaRecord>;
  /** Resolve the topic Context Graph to its authoritative on-chain id. */
  getContextGraphOnChainId?: (id: string) => Promise<string | null>;
  markCgMetaDirtyFromQuads?: (quads: readonly Quad[]) => void;
  persistContextGraphSubscription?: (id: string) => void;
  onPhase?: GossipPhaseCallback;
}

export interface GossipPublishHandlerOptions {
  /**
   * Agent-backed handlers require the invalidating subscription setter so
   * gossip state changes keep listContextGraphs cache and durable subscription
   * bookkeeping coherent. Standalone/legacy handlers can omit the callback and
   * keep the historical in-memory map fallback.
   */
  requireContextGraphSubscriptionSetter?: boolean;
}

export class GossipPublishHandler {
  private readonly store: TripleStore;
  private readonly chain: ChainAdapter | undefined;
  private readonly subscribedContextGraphs: Map<string, ContextGraphSub>;
  private readonly callbacks: GossipPublishHandlerCallbacks;
  private readonly log = new Logger('GossipPublishHandler');

  constructor(
    store: TripleStore,
    chain: ChainAdapter | undefined,
    subscribedContextGraphs: Map<string, ContextGraphSub>,
    callbacks: GossipPublishHandlerCallbacks,
    options: GossipPublishHandlerOptions = {},
  ) {
    if (options.requireContextGraphSubscriptionSetter && !callbacks.setContextGraphSubscription) {
      throw new Error('GossipPublishHandler requires setContextGraphSubscription for agent-backed subscription state');
    }
    this.store = store;
    this.chain = chain;
    this.subscribedContextGraphs = subscribedContextGraphs;
    this.callbacks = callbacks;
  }

  private setContextGraphSubscription(
    id: string,
    next: ContextGraphSub,
    options?: { persist?: boolean },
  ): void {
    const setter = this.callbacks.setContextGraphSubscription;
    if (setter) {
      setter(id, next, options);
      return;
    }
    this.subscribedContextGraphs.set(id, next);
  }

  private recordDiscoveredContextGraph(id: string, metadata: ContextGraphDiscoveryMetadata): void {
    const recorder = this.callbacks.recordDiscoveredContextGraph;
    if (recorder) {
      recorder(id, metadata);
      return;
    }
    const existing = this.subscribedContextGraphs.get(id);
    this.setContextGraphSubscription(id, {
      ...existing,
      // Construct allowed discovery metadata explicitly. Besides keeping the
      // TypeScript contract narrow, this prevents an older/untyped callback
      // from smuggling membership, host, or reconciliation fields at runtime.
      name: metadata.name ?? existing?.name,
      onChainId: metadata.onChainId ?? existing?.onChainId,
      onChainHash: metadata.onChainHash ?? existing?.onChainHash,
      participantAgents: metadata.participantAgents ?? existing?.participantAgents,
      subscribed: existing?.subscribed === true,
      synced: existing?.synced === true,
      sharedMemorySynced: existing?.sharedMemorySynced === true,
      metaSynced: existing?.metaSynced === true,
    }, { persist: false });
  }

  async handlePublishMessage(data: Uint8Array, contextGraphId: string, onPhase?: GossipPhaseCallback, fromPeerId?: string): Promise<void> {
    let ctx = createOperationContext('gossip');
    const phase = onPhase ?? this.callbacks.onPhase;
    try {
      phase?.('decode', 'start');
      let request;
      try {
        request = decodePublishRequest(data);
        if (request.operationId) {
          ctx = createOperationContext('gossip', request.operationId);
        }

        if (!request.contextGraphId) {
          request.contextGraphId = contextGraphId;
        } else if (request.contextGraphId !== contextGraphId) {
          // #1100: protobuf decoding is structurally permissive — agent-profile
          // and other non-publish gossip frames "successfully" decode as publish
          // requests with multi-KB RDF garbage in the contextGraphId field. The
          // old guard only skipped on non-printable characters, so any payload
          // that happened to be printable ASCII was dumped wholesale into the
          // log as a WARN, every few seconds, forever. A real cross-topic
          // mismatch always carries a *well-formed* CG id, so validate the
          // decoded value first and silently skip mis-decoded frames.
          if (!validateContextGraphId(request.contextGraphId).valid) return;
          this.log.warn(ctx, `Gossip: request contextGraphId "${request.contextGraphId.slice(0, 120)}" does not match topic "${contextGraphId}", ignoring`);
          return;
        }
      } finally {
        phase?.('decode', 'end');
      }

      const nquadsStr = new TextDecoder().decode(request.nquads);
      const quads = parseSimpleNQuads(nquadsStr);
      const graphPublish = resolveGraphScopedPublishRequest(request);

      if (quads.length === 0 && !request.ual) {
        this.log.warn(ctx, 'Gossip: empty broadcast with no UAL, ignoring');
        return;
      }

      const graphManager = new GraphManager(this.store);
      await graphManager.ensureContextGraph(request.contextGraphId);

      // Sub-graph routing: if the publish specifies a sub-graph, store data there.
      // Reject (don't reroute) invalid names to prevent polluting the root graph.
      let subGraphName: string | undefined;
      if (request.subGraphName) {
        const sgVal = validateSubGraphName(request.subGraphName);
        if (!sgVal.valid) {
          this.log.warn(ctx, `Gossip: rejected publish with invalid subGraphName "${request.subGraphName}": ${sgVal.reason}`);
          return;
        }
        subGraphName = request.subGraphName;
        await graphManager.ensureSubGraph(request.contextGraphId, subGraphName);
      }

      const dataGraph = graphPublish
        ? knowledgeAssetLayerGraphUri(
            request.contextGraphId,
            MemoryLayer.VerifiableMemory,
            graphPublish.scope,
            subGraphName,
          )
        : subGraphName
          ? contextGraphSubGraphUri(request.contextGraphId, subGraphName)
          : graphManager.dataGraphUri(request.contextGraphId);
      // Drop any _meta quads from gossip — _meta state (allowlists, registration
      // status, curator) is security-critical and must only propagate via the
      // authenticated sync protocol, not unauthenticated gossip.
      // Match both raw `/_meta` suffix and common percent-encoded variants.
      // Avoid decodeURIComponent which throws on malformed encoding.
      let normalized: Quad[];
      if (graphPublish) {
        if (quads.some((quad) => quad.graph !== dataGraph)) {
          throw new Error(
            `Graph-scoped gossip payload must target only its UAL-derived VM graph ${dataGraph}`,
          );
        }
        if (quads.length !== graphPublish.publicTripleCount) {
          throw new Error(
            `Graph-scoped gossip public triple count mismatch ` +
              `(wire=${graphPublish.publicTripleCount}, parsed=${quads.length})`,
          );
        }
        normalized = quads.map((quad) => ({ ...quad, graph: dataGraph }));
      } else {
        const filteredQuads = quads.filter(q => {
          const g = q.graph;
          return !g.endsWith('/_meta') && !g.endsWith('%2F_meta') && !g.endsWith('%2f_meta');
        });
        normalized = filteredQuads.map(q => ({ ...q, graph: dataGraph }));
      }

      // When receiving ontology-topic broadcasts, skip context graph definition
      // triples for context graphs we already have locally. This prevents duplicate
      // creator/timestamp triples when multiple nodes create the same context graph
      // during simultaneous startup.
      // Catalogue newly discovered context graphs without joining them. The
      // ontology topic is a universal control-plane subscription, so treating a
      // definition announcement as member intent would make every edge ingest
      // every public CG it happens to hear about.
      if (request.contextGraphId === SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) {
        const contextGraphPrefix = 'did:dkg:context-graph:';
        const incomingContextGraphUris = new Set(
          normalized
            .filter(q => q.predicate === DKG_ONTOLOGY.RDF_TYPE && q.object === DKG_ONTOLOGY.DKG_CONTEXT_GRAPH)
            .map(q => q.subject),
        );
        if (incomingContextGraphUris.size > 0) {
          const duplicateUris = new Set<string>();
          const newContextGraphIds: string[] = [];
          for (const uri of incomingContextGraphUris) {
            const id = uri.startsWith(contextGraphPrefix) ? uri.slice(contextGraphPrefix.length) : null;
            if (!id) continue;
            if (await this.callbacks.contextGraphExists(id)) {
              duplicateUris.add(uri);
            } else if (id !== SYSTEM_CONTEXT_GRAPHS.AGENTS && id !== SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) {
              newContextGraphIds.push(id);
            }
          }
          if (duplicateUris.size > 0) {
            const activityUris = new Set(
              normalized
                .filter(q => duplicateUris.has(q.subject) && q.predicate === DKG_ONTOLOGY.PROV_GENERATED_BY)
                .map(q => q.object),
            );
            // Drop ALL definition triples for already-known CGs, including
            // dkg:creator. Gossip is unauthenticated so we cannot trust
            // creator claims — the authoritative creator triple arrives via
            // the authenticated sync protocol.
            normalized = normalized.filter(q =>
              !duplicateUris.has(q.subject) && !activityUris.has(q.subject),
            );
          }

          for (const newId of newContextGraphIds) {
            const nameQuad = normalized.find(q =>
              q.subject === `${contextGraphPrefix}${newId}` && q.predicate === DKG_ONTOLOGY.SCHEMA_NAME,
            );
            const name = nameQuad ? stripLiteral(nameQuad.object) : newId;
            const metadata = {
              name,
              onChainId: this.subscribedContextGraphs.get(newId)?.onChainId,
            };
            this.recordDiscoveredContextGraph(newId, metadata);
            this.log.info(ctx, `Discovered context graph "${name}" (${newId}) via ontology gossip — recorded for role-aware activation`);
          }
        }

        normalized = await this.filterInvalidOntologyPolicyBindings(normalized, ctx);
      } else {
        const allowedPeers = await this.getContextGraphAllowedPeers(request.contextGraphId);

        // Curated CGs: require sender identity and allowlist membership
        if (allowedPeers !== null) {
          if (!fromPeerId) {
            this.log.warn(ctx, `Gossip publish rejected: no sender identity for curated context graph "${request.contextGraphId}"`);
            return;
          }
          if (!allowedPeers.includes(fromPeerId)) {
            this.log.warn(ctx, `Gossip publish rejected: peer "${fromPeerId}" not in allowlist for context graph "${request.contextGraphId}"`);
            return;
          }
        }

        // CGs whose _meta hasn't been fetched yet: deny until _meta sync
        // completes. A null allowlist with metaSynced=false could mean the CG
        // is curated but the allowlist hasn't arrived via authenticated sync.
        // System contextGraphs (agents/ontology) are exempt — always open.
        // Gossip race: `DKGAgent#refreshMetaSyncedFlags` flips `metaSynced`
        // eagerly at the end of every sync cycle, but a gossip publish can
        // arrive on a freshly subscribed node *before* the first sync has
        // run. Ask the agent's own helper whether the CG is already
        // confirmable from the local store (system contextGraph, populated
        // `_meta`, or `<cg> rdf:type dkg:ContextGraph` in ontology — the same
        // check Viktor introduced in `hasConfirmedMetaState`). If yes,
        // update the flag through the agent subscription setter and proceed; if no, keep the strict
        // deny behavior so curated CGs without a synced allowlist can't
        // leak through.
        if (allowedPeers === null
          && request.contextGraphId !== SYSTEM_CONTEXT_GRAPHS.AGENTS
          && request.contextGraphId !== SYSTEM_CONTEXT_GRAPHS.ONTOLOGY) {
          const sub = this.subscribedContextGraphs.get(request.contextGraphId);
          if (sub && sub.metaSynced === false) {
            const confirmed = this.callbacks.hasConfirmedMetaState
              ? await this.callbacks.hasConfirmedMetaState(request.contextGraphId)
              : false;
            if (confirmed) {
              this.setContextGraphSubscription(request.contextGraphId, { ...sub, metaSynced: true });
            } else {
              this.log.warn(ctx, `Gossip publish deferred: context graph "${request.contextGraphId}" _meta not yet synced — defaulting to deny`);
              return;
            }
          }
        }
      }

      // Structural validation (I-002): reject malformed gossip before inserting.
      // Only applies to real publishes with a manifest — ontology/context graph
      // broadcasts (no UAL or no KAs) bypass validation.
      phase?.('validate', 'start');
      let isReplay = false;
      if (!graphPublish && request.ual && request.kas?.length > 0) {
        const manifest = request.kas.map(ka => ({
          tokenId: 0n,
          rootEntity: ka.rootEntity,
          privateTripleCount: ka.privateTripleCount ?? 0,
        }));

        const rootEntities = manifest.map(m => m.rootEntity).filter(isSafeIri);
        if (rootEntities.length === 0) {
          this.log.warn(ctx, `Gossip structural validation rejected publish ${request.ual}: no valid root entities`);
          return;
        }
        const sparql = `SELECT DISTINCT ?s WHERE { GRAPH ?g { ?s ?p ?o } VALUES ?s { ${rootEntities.map(e => `<${e}>`).join(' ')} } FILTER(STRSTARTS(STR(?g), "${dataGraph}/_verifiable_memory/") || STR(?g) = "${dataGraph}") }`;
        const result = await this.store.query(sparql, { source: 'agent.gossipPublishValidation' });
        const existingEntities = new Set<string>(
          result.type === 'bindings' ? result.bindings.map(b => b['s']).filter(Boolean) : [],
        );

        const validation = validatePublishRequest(normalized, manifest, request.contextGraphId, existingEntities, {
          expectedGraph: subGraphName ? dataGraph : undefined,
        });
        if (!validation.valid) {
          const allRule4 = validation.errors.every(e => e.startsWith('Rule 4'));
          if (!allRule4) {
            this.log.warn(ctx, `Gossip structural validation rejected publish ${request.ual}: ${validation.errors.join('; ')}`);
            return;
          }
          this.log.info(ctx, `Gossip replay detected for ${request.ual}, skipping data insert but running verification`);
          isReplay = true;
        }
      }

      phase?.('validate', 'end');

      // Auto-register sub-graph in _meta AFTER validation passes.
      // This prevents polluting metadata when invalid messages are rejected.
      if (subGraphName) {
        const sgUri = contextGraphSubGraphUri(request.contextGraphId, subGraphName);
        const metaGraph = `did:dkg:context-graph:${assertSafeIri(request.contextGraphId)}/_meta`;
        const alreadyRegistered = await this.store.query(
          `ASK { GRAPH <${metaGraph}> {
            <${assertSafeIri(sgUri)}> a <http://dkg.io/ontology/SubGraph> ;
              <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
              <http://dkg.io/ontology/createdBy> ?createdBy .
          } }`,
        );
        if (alreadyRegistered.type !== 'boolean' || !alreadyRegistered.value) {
          const regQuads = generateSubGraphRegistration({
            contextGraphId: request.contextGraphId,
            subGraphName,
            createdBy: request.publisherAddress || 'gossip-discovery',
            timestamp: new Date(),
          });
          await this.store.insert(regQuads);
          this.callbacks.markCgMetaDirtyFromQuads?.(regQuads);
          this.log.info(ctx, `Auto-registered sub-graph "${subGraphName}" in context graph "${request.contextGraphId}" from gossip`);
        }
      }

      if (graphPublish) {
        phase?.('store', 'start');
        const privateRoots = graphPublish.privateMerkleRoot
          ? [graphPublish.privateMerkleRoot]
          : [];
        const merkleRoot = computeFlatKCRoot(normalized, privateRoots);
        const txHash = request.txHash ?? '';
        const blockNumber = protoToNumber(request.blockNumber ?? 0);
        const startKAId = protoToBigInt(request.startKAId ?? 0);
        const endKAId = protoToBigInt(request.endKAId ?? 0);
        const graphManager = new GraphManager(this.store);
        let workspaceHead;
        try {
          workspaceHead = await resolveKnowledgeAssetWorkspaceHead({
            store: this.store,
            graphManager,
            contextGraphId: request.contextGraphId,
            kaUal: graphPublish.scope.ual,
            subGraphName,
          });
        } catch (err) {
          this.log.warn(
            ctx,
            `Gossip rejected corrupt graph-scoped SWM head for ${graphPublish.scope.ual}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        const privateMerkleRoot = graphPublish.privateMerkleRoot
          ? ethers.hexlify(graphPublish.privateMerkleRoot).toLowerCase()
          : undefined;
        const publicDigest = workspacePublicQuadsDigest(
          normalized.map((quad) => ({ ...quad, graph: '' })),
        );
        if (
          !workspaceHead
          || workspaceHead.assertionVersion !== graphPublish.scope.assertionVersion
          || workspaceHead.publicTripleCount !== graphPublish.publicTripleCount
          || workspaceHead.publicQuadsDigest !== publicDigest
          || workspaceHead.privateTripleCount !== graphPublish.privateTripleCount
          || workspaceHead.privateMerkleRoot?.toLowerCase() !== privateMerkleRoot
          || workspaceHead.accessPolicy === undefined
        ) {
          this.log.warn(
            ctx,
            `Gossip deferred graph-scoped publish ${graphPublish.scope.ual}: ` +
              'no matching durable StorageACK workspace head',
          );
          return;
        }
        if (
          graphPublish.accessPolicy !== workspaceHead.accessPolicy
          || graphPublish.allowedPeers.join('\0') !== workspaceHead.allowedPeers.join('\0')
          || (fromPeerId !== undefined && fromPeerId !== workspaceHead.publisherPeerId)
        ) {
          this.log.warn(
            ctx,
            `Gossip ignored untrusted graph-scoped access provenance for ${graphPublish.scope.ual}`,
          );
        }
        let verified = false;
        if (txHash && blockNumber > 0 && request.publisherAddress) {
          phase?.('chain-verify', 'start');
          verified = await this.verifyGossipOnChain(
            txHash,
            blockNumber,
            merkleRoot,
            request.publisherAddress,
            startKAId,
            endKAId,
            ctx,
            request.contextGraphId,
          );
          phase?.('chain-verify', 'end');
        }

        const metadata = generateGraphKnowledgeAssetMetadata(
          {
            ual: graphPublish.scope.ual,
            contextGraphId: request.contextGraphId,
            merkleRoot,
            publisherPeerId: workspaceHead.publisherPeerId,
            accessPolicy: workspaceHead.accessPolicy,
            ...(workspaceHead.accessPolicy === 'allowList'
              ? { allowedPeers: workspaceHead.allowedPeers }
              : {}),
            timestamp: new Date(),
            subGraphName,
            authorAddress: graphPublish.scope.agentAddress,
            assertionVersion: graphPublish.scope.assertionVersion,
            publicTripleCount: graphPublish.publicTripleCount,
            privateTripleCount: graphPublish.privateTripleCount,
            ...(graphPublish.privateMerkleRoot
              ? { privateMerkleRoot: graphPublish.privateMerkleRoot }
              : {}),
            assertionGraph: dataGraph,
          },
          verified ? 'confirmed' : 'tentative',
          verified
            ? {
                kind: 'transaction',
                provenance: {
                  txHash,
                  blockNumber,
                  blockTimestamp: Math.floor(Date.now() / 1000),
                  publisherAddress: request.publisherAddress,
                  batchId: startKAId,
                  chainId: request.chainId,
                },
              }
            : undefined,
        );
        const metaGraph = contextGraphMetaGraphUri(request.contextGraphId);
        const incomingVersion = {
          blockNumber: verified ? blockNumber : 0,
          txIndex: 0,
        };
        const outcome = await withMaterializationLock(
          metaGraph,
          graphPublish.scope.ual,
          async () => {
            if (!verified) {
              const confirmed = await this.store.query(
                `ASK { GRAPH <${assertSafeIri(metaGraph)}> { ` +
                  `<${assertSafeIri(graphPublish.scope.ual)}> ` +
                  `<http://dkg.io/ontology/status> "confirmed" } }`,
              );
              if (confirmed.type === 'boolean' && confirmed.value) {
                return 'stale' as const;
              }
            }
            if (!(await shouldApplyMaterialization(
              this.store,
              metaGraph,
              graphPublish.scope.ual,
              incomingVersion,
              BigInt(graphPublish.scope.assertionVersion),
            ))) {
              return 'stale' as const;
            }
            const replaced = await tryReplaceGraphAtomically(
              this.store,
              dataGraph,
              normalized,
              { source: 'agent.gossipPublish.graphScopedReplace' },
            );
            if (!replaced) {
              throw Object.assign(
                new Error('Graph-scoped gossip requires atomic TripleStore.replaceGraph support'),
                { code: 'VM_ATOMIC_REPLACE_UNSUPPORTED' },
              );
            }
            await this.store.deleteByPattern({
              graph: metaGraph,
              subject: graphPublish.scope.ual,
            });
            await this.store.insert(metadata);
            await writeMaterializedVersion(
              this.store,
              metaGraph,
              graphPublish.scope.ual,
              incomingVersion,
            );
            if (verified) {
              const swmGraph = knowledgeAssetLayerGraphUri(
                request.contextGraphId,
                MemoryLayer.SharedWorkingMemory,
                graphPublish.scope,
                subGraphName,
              );
              await this.store.dropGraph(swmGraph);
            }
            return 'applied' as const;
          },
        );
        phase?.('store', 'end');
        if (outcome === 'stale') {
          this.log.info(
            ctx,
            `Skipped stale graph-scoped publish gossip for ${graphPublish.scope.ual}`,
          );
          return;
        }
        this.callbacks.markCgMetaDirtyFromQuads?.(metadata);
        this.log.info(
          ctx,
          `Graph-scoped publish ${graphPublish.scope.ual} stored as ` +
            `${verified ? 'confirmed' : 'tentative'} (${normalized.length} public triples)`,
        );
        return;
      }

      phase?.('store', 'start');
      if (normalized.length > 0 && !isReplay) {
        await this.store.insert(normalized);
        this.callbacks.markCgMetaDirtyFromQuads?.(normalized);
      }

      if (request.ual) {
        const privateRoots = (request.kas ?? [])
          .filter(ka => ka.privateMerkleRoot?.length)
          .map(ka => new Uint8Array(ka.privateMerkleRoot));
        const merkleRoot = computeFlatKCRoot(normalized, privateRoots);

        const partitioned = skolemizeByEntity(normalized);
        const kaMetadata: KAMetadata[] = [];

        let metadataTokenId = 1n;
        const metadataRootOrder = request.kas?.length
          ? request.kas.map((ka) => ka.rootEntity)
          : [...partitioned.keys()];
        for (const rootEntity of metadataRootOrder) {
          const entityQuads = partitioned.get(rootEntity);
          if (!entityQuads) continue;
          const kaEntry = request.kas?.find((ka) => ka.rootEntity === rootEntity);
          // Integration (file=KA × Option-1): the per-entity tokenId is a local
          // 1-based ordinal within the KC — the KC's packed Option-1 kaId lives
          // in request.ual, not here, and this ordinal does not feed the
          // consensus merkle root. Deterministically reconstruct the publisher
          // manifest's ordinal rather than reading the (now string) wire tokenId.
          kaMetadata.push({
            rootEntity,
            kcUal: request.ual,
            tokenId: metadataTokenId++,
            publicTripleCount: entityQuads.length,
            privateTripleCount: kaEntry?.privateTripleCount ?? 0,
            privateMerkleRoot: kaEntry?.privateMerkleRoot?.length
              ? new Uint8Array(kaEntry.privateMerkleRoot) : undefined,
          });
        }

        const kcMeta = {
          ual: request.ual,
          contextGraphId: request.contextGraphId,
          merkleRoot,
          publisherPeerId: request.publisherAddress || 'unknown',
          timestamp: new Date(),
          subGraphName,
        };

        // Always store gossip-received data as tentative first —
        // never trust self-reported on-chain status from gossip messages.
        //
        // #1233: the agents registry CG is the exception — it never confirms
        // on-chain and its per-publish `_meta` record has no consumer (the
        // registry is served from the data graph). Persisting one per peer
        // heartbeat grows `agents/_meta` without bound and stalls offset-0
        // sync (the agents slice of #1221), so skip the tracking write here.
        if (!isAgentRegistryContextGraph(request.contextGraphId)) {
          const metaQuads = generateTentativeMetadata(kcMeta, kaMetadata);
          await this.store.insert(metaQuads);
          this.callbacks.markCgMetaDirtyFromQuads?.(metaQuads);
        }
        phase?.('store', 'end');

        // If the gossip message includes on-chain proof (txHash + blockNumber),
        // attempt targeted verification and promote to confirmed if valid.
        const txHash = request.txHash ?? '';
        const blockNumber = protoToNumber(request.blockNumber ?? 0);
        const startKAId = protoToBigInt(request.startKAId ?? 0);
        const endKAId = protoToBigInt(request.endKAId ?? 0);

        if (txHash && blockNumber > 0 && startKAId > 0n && request.publisherAddress) {
          phase?.('chain-verify', 'start');
          const verified = await this.verifyGossipOnChain(
            txHash, blockNumber, merkleRoot, request.publisherAddress,
            startKAId, endKAId,
            ctx,
          );
          if (verified) {
            await this.promoteGossipToConfirmed(request.ual, request.contextGraphId, kcMeta, kaMetadata);
            this.log.info(ctx, `Gossip publish ${request.ual} verified on-chain (tx=${txHash.slice(0, 10)}…, block=${blockNumber})`);
          } else {
            this.log.info(ctx, `Gossip publish ${request.ual} stored as tentative (on-chain verification failed or pending)`);
          }
          phase?.('chain-verify', 'end');
        } else {
          this.log.info(ctx, `Gossip publish ${request.ual} stored as tentative (no on-chain proof in message)`);
        }
      } else {
        phase?.('store', 'end');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (/wire type|index out of range|offset|unexpected tag/i.test(errMsg)) return;
      this.log.warn(ctx, `Gossip: failed to process publish broadcast: ${errMsg}`);
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
    expectedContextGraphId?: string,
  ): Promise<boolean> {
    if (!this.chain || this.chain.chainId === 'none') return false;

    if (blockNumber <= 0) {
      this.log.warn(ctx, `Gossip verification skipped: invalid blockNumber=${blockNumber}`);
      return false;
    }

    try {
      if (expectedContextGraphId !== undefined) {
        if (
          typeof this.chain.getKAContextGraphId !== 'function'
          || !this.callbacks.getContextGraphOnChainId
        ) {
          this.log.warn(ctx, 'Gossip verification rejected: Context Graph binding oracle unavailable');
          return false;
        }
        const expectedOnChainId = await this.callbacks.getContextGraphOnChainId(
          expectedContextGraphId,
        );
        if (expectedOnChainId === null) {
          this.log.warn(ctx, `Gossip verification rejected: Context Graph ${expectedContextGraphId} is not registered`);
          return false;
        }
        const actualOnChainId = await this.chain.getKAContextGraphId(expectedStartKAId);
        if (actualOnChainId !== BigInt(expectedOnChainId)) {
          this.log.warn(
            ctx,
            `Gossip verification rejected: KA ${expectedStartKAId} belongs to Context Graph ` +
              `${actualOnChainId}, not ${expectedOnChainId}`,
          );
          return false;
        }
      }
      const filter: EventFilter = {
        eventTypes: ['KnowledgeBatchCreated', 'KCCreated'],
        fromBlock: blockNumber,
        toBlock: blockNumber,
      };
      for await (const event of this.chain.listenForEvents(filter)) {
        if (event.blockNumber !== blockNumber) continue;

        if (txHash) {
          if (!event.data['txHash'] || (event.data['txHash'] as string).toLowerCase() !== txHash.toLowerCase()) {
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
   * Promote gossip-received tentative data to confirmed via a status-only
   * swap: insert the confirmed quad first, then delete the tentative one,
   * so metadata is never lost even if the second operation fails.
   */
  private async promoteGossipToConfirmed(
    ual: string,
    contextGraphId: string,
    _kcMeta: { ual: string; contextGraphId: string; merkleRoot: Uint8Array; publisherPeerId: string; timestamp: Date },
    _kaMetadata: KAMetadata[],
  ): Promise<void> {
    const tentativeStatus = getTentativeStatusQuad(ual, contextGraphId);
    const confirmedStatus = getConfirmedStatusQuad(ual, contextGraphId);
    try {
      await this.store.insert([confirmedStatus]);
      await this.store.delete([tentativeStatus]);
    } catch (err) {
      this.log.warn(
        createOperationContext('gossip'),
        `Failed to promote gossip tentative→confirmed for ${ual}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async filterInvalidOntologyPolicyBindings(quads: Quad[], ctx: OperationContext): Promise<Quad[]> {
    // Detect binding subjects from rdf:type AND from revocation/approval predicates.
    // Revocation quads may not include the type triple, so we must also check
    // for policy-binding-specific predicates to prevent forged revocations.
    const BINDING_PREDICATES = new Set<string>([
      DKG_ONTOLOGY.DKG_POLICY_BINDING_STATUS,
      DKG_ONTOLOGY.DKG_ACTIVE_POLICY,
      DKG_ONTOLOGY.DKG_APPROVED_BY,
      DKG_ONTOLOGY.DKG_APPROVED_AT,
      DKG_ONTOLOGY.DKG_REVOKED_BY,
      DKG_ONTOLOGY.DKG_REVOKED_AT,
      DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH,
    ]);
    const bindingSubjects = new Set(
      quads
        .filter(q =>
          (q.predicate === DKG_ONTOLOGY.RDF_TYPE && q.object === DKG_ONTOLOGY.DKG_POLICY_BINDING) ||
          BINDING_PREDICATES.has(q.predicate),
        )
        .map(q => q.subject),
    );
    if (bindingSubjects.size === 0) return quads;

    const invalidBindings = new Set<string>();
    for (const bindingUri of bindingSubjects) {
      const bindingQuads = quads.filter(q => q.subject === bindingUri);
      const contextGraphUri = bindingQuads.find(q => q.predicate === DKG_ONTOLOGY.DKG_POLICY_APPLIES_TO_CONTEXT_GRAPH)?.object;
      const approvedAt = bindingQuads.find(q => q.predicate === DKG_ONTOLOGY.DKG_APPROVED_AT)?.object;
      const approvedBy = bindingQuads.find(q => q.predicate === DKG_ONTOLOGY.DKG_APPROVED_BY)?.object;
      const revokedAt = bindingQuads.find(q => q.predicate === DKG_ONTOLOGY.DKG_REVOKED_AT)?.object;
      const revokedBy = bindingQuads.find(q => q.predicate === DKG_ONTOLOGY.DKG_REVOKED_BY)?.object;
      const contextGraphPrefix = 'did:dkg:context-graph:';
      const contextGraphId = contextGraphUri?.startsWith(contextGraphPrefix)
        ? contextGraphUri.slice(contextGraphPrefix.length)
        : null;

      if (!contextGraphId) {
        invalidBindings.add(bindingUri);
        this.log.warn(ctx, `Rejected gossip policy binding ${bindingUri}: missing or invalid contextGraph reference`);
        continue;
      }

      const owner = await this.callbacks.getContextGraphOwner(contextGraphId);
      if (!owner) {
        invalidBindings.add(bindingUri);
        this.log.warn(ctx, `Rejected gossip policy binding ${bindingUri}: contextGraph "${contextGraphId}" owner is unknown locally`);
        continue;
      }

      if (approvedAt && !approvedBy) {
        invalidBindings.add(bindingUri);
        this.log.warn(ctx, `Rejected gossip policy binding ${bindingUri}: approvedBy is required when approvedAt is present`);
        continue;
      }

      if (approvedBy && approvedBy !== owner) {
        invalidBindings.add(bindingUri);
        this.log.warn(ctx, `Rejected gossip policy binding ${bindingUri}: approvedBy ${approvedBy} does not match owner ${owner}`);
        continue;
      }

      if (revokedAt && !revokedBy) {
        invalidBindings.add(bindingUri);
        this.log.warn(ctx, `Rejected gossip policy binding ${bindingUri}: revokedBy is required when revokedAt is present`);
        continue;
      }

      if (revokedBy && revokedBy !== owner) {
        invalidBindings.add(bindingUri);
        this.log.warn(ctx, `Rejected gossip policy binding ${bindingUri}: revokedBy ${revokedBy} does not match owner ${owner}`);
      }
    }

    if (invalidBindings.size === 0) return quads;
    // Also collect policy URIs referenced by rejected bindings so we drop
    // any policy-level quads (policyStatus, approvedBy, etc.) that rode
    // the same gossip message.
    const relatedPolicyUris = new Set<string>();
    for (const bindingUri of invalidBindings) {
      const policyRef = quads.find(
        q => q.subject === bindingUri && q.predicate === DKG_ONTOLOGY.DKG_ACTIVE_POLICY,
      )?.object;
      if (policyRef) relatedPolicyUris.add(policyRef);
    }
    return quads.filter(q => !invalidBindings.has(q.subject) && !relatedPolicyUris.has(q.subject));
  }

  private async getContextGraphAllowedPeers(contextGraphId: string): Promise<string[] | null> {
    if (this.callbacks.getCgMeta) {
      const peers = (await this.callbacks.getCgMeta(contextGraphId)).allowedPeers;
      return peers.length > 0 ? peers : null;
    }

    const cgMeta = contextGraphMetaGraphUri(contextGraphId);
    const cgData = contextGraphDataGraphUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?peer WHERE { GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return null;
    return result.bindings
      .map(row => row['peer'])
      .filter((v): v is string => typeof v === 'string')
      .map(v => v.replace(/^"|"$/g, ''));
  }
}

function protoToNumber(val: number | { low: number; high: number; unsigned: boolean }): number {
  if (typeof val === 'number') return val;
  return ((val.high >>> 0) * 0x100000000) + (val.low >>> 0);
}

function protoToBigInt(val: string | number | bigint | { low: number; high: number; unsigned: boolean }): bigint {
  if (typeof val === 'string') return BigInt(val);
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  return (BigInt(val.high >>> 0) << 32n) | BigInt(val.low >>> 0);
}


function stripLiteral(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return match[1];
  return s;
}
