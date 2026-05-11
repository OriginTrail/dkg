import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { EventBus } from '@origintrail-official/dkg-core';
import { DKGEvent, Logger, createOperationContext, contextGraphDataUri, contextGraphMetaUri, DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import type { PhaseCallback } from './publisher.js';
import {
  decodeGossipEnvelope,
  decodeWorkspacePublishRequest,
  computeGossipSigningPayload,
  assertSafeIri,
  assertSafeRdfTerm,
  validateSubGraphName,
  contextGraphSubGraphUri,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
} from '@origintrail-official/dkg-core';
import type { GossipEnvelopeMsg, WorkspaceCASConditionMsg, WorkspacePublishRequestMsg } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { validatePublishRequest } from './validation.js';
import { generateShareMetadata, generateOwnershipQuads, generateSubGraphRegistration } from './metadata.js';
import { parseSimpleNQuads } from './publish-handler.js';
import { storeWorkspaceOperationPublicQuads } from './workspace-resolution.js';
import type { KAManifestEntry } from './publisher.js';

interface WorkspaceGossipDecodeResult {
  request: WorkspacePublishRequestMsg;
  envelope?: GossipEnvelopeMsg;
  payload: Uint8Array;
}

/**
 * Handles incoming shared memory topic messages (GossipSub).
 * Validates the request, stores public triples into SWM graph
 * and metadata into SWM meta graph. No chain, no UAL.
 */
export class SharedMemoryHandler {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  private readonly eventBus: EventBus;
  /** Per-context-graph map of rootEntity → creatorPeerId. Shared with publisher when used by agent. */
  private readonly sharedMemoryOwnedEntities: Map<string, Map<string, string>> = new Map();
  private readonly writeLocks: Map<string, Promise<void>>;
  private readonly localAgentAddresses?: () => readonly string[] | Promise<readonly string[]>;
  private readonly now: () => number;
  private readonly log = new Logger('SharedMemoryHandler');

  constructor(
    store: TripleStore,
    eventBus: EventBus,
    options?: {
      sharedMemoryOwnedEntities?: Map<string, Map<string, string>>;
      writeLocks?: Map<string, Promise<void>>;
      localAgentAddresses?: () => readonly string[] | Promise<readonly string[]>;
      now?: () => number;
    },
  ) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.eventBus = eventBus;
    if (options?.sharedMemoryOwnedEntities) {
      this.sharedMemoryOwnedEntities = options.sharedMemoryOwnedEntities;
    }
    this.writeLocks = options?.writeLocks ?? new Map();
    this.localAgentAddresses = options?.localAgentAddresses;
    this.now = options?.now ?? (() => Date.now());
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
   * Enforce CAS conditions carried in a gossip message.
   * Must be called inside a write lock so no concurrent mutation can
   * interleave between the check and the subsequent write.
   * Returns false if any condition fails (write should be skipped).
   */
  private async enforceCASConditions(
    conditions: WorkspaceCASConditionMsg[],
    swmGraph: string,
    ctx: import('@origintrail-official/dkg-core').OperationContext,
  ): Promise<boolean> {
    for (const cond of conditions) {
      try {
        assertSafeIri(cond.subject);
        assertSafeIri(cond.predicate);
        if (!cond.expectAbsent) {
          if (!cond.expectedValue) {
            this.log.warn(ctx, `CAS rejected: empty expectedValue for non-absent condition`);
            return false;
          }
          assertSafeRdfTerm(cond.expectedValue);
        }
      } catch {
        this.log.warn(ctx, `CAS rejected: invalid IRI/term in condition — possible injection attempt`);
        return false;
      }

      try {
        if (cond.expectAbsent) {
          const ask = `ASK { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ?o } }`;
          const result = await this.store.query(ask);
          if (result.type !== 'boolean' || result.value) {
            this.log.warn(ctx, `CAS rejected: <${cond.subject}> <${cond.predicate}> expected absent`);
            return false;
          }
        } else {
          const ask = `ASK { GRAPH <${swmGraph}> { <${cond.subject}> <${cond.predicate}> ${cond.expectedValue} } }`;
          const result = await this.store.query(ask);
          if (result.type !== 'boolean' || !result.value) {
            this.log.warn(ctx, `CAS rejected: <${cond.subject}> <${cond.predicate}> expected ${cond.expectedValue}`);
            return false;
          }
        }
      } catch (err) {
        this.log.warn(ctx, `CAS rejected: query failed — ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
    }
    this.log.info(ctx, `Remote CAS conditions passed (${conditions.length})`);
    return true;
  }

  /**
   * Handler for GossipSub shared memory topic: (data, fromPeerId) => void.
   * Validates, stores to SWM + SWM meta, updates sharedMemoryOwnedEntities.
   */
  async handle(data: Uint8Array, fromPeerId: string, onPhase?: PhaseCallback): Promise<void> {
    let ctx = createOperationContext('share');
    try {
      onPhase?.('decode', 'start');
      const decoded = this.decodeWorkspaceGossipMessage(data);
      const { request, envelope, payload } = decoded;
      if (request.operationId) {
        ctx = createOperationContext('share', request.operationId);
      }
      const contextGraphId = request.contextGraphId;
      const { nquads, manifest, publisherPeerId, workspaceOperationId: shareOperationId, timestampMs, casConditions, subGraphName } = request;
      const sgLabel = subGraphName ? `/${subGraphName}` : '';
      this.log.info(ctx, `SWM write from ${fromPeerId} for context graph ${contextGraphId}${sgLabel} op=${shareOperationId}`);

      if (publisherPeerId !== fromPeerId) {
        this.log.warn(ctx, `SWM write rejected: payload publisherPeerId "${publisherPeerId}" does not match sender "${fromPeerId}"`);
        return;
      }

      const agentGateAddresses = await this.getContextGraphAgentGateAddresses(contextGraphId);
      const allowedPeers = await this.getContextGraphAllowedPeers(contextGraphId);
      const hasPrivateAccessPolicy = await this.contextGraphHasPrivateAccessPolicy(contextGraphId);

      if (hasPrivateAccessPolicy && agentGateAddresses === null && allowedPeers === null) {
        this.log.warn(ctx, `SWM write rejected: private context graph "${contextGraphId}" has no gossip allowlist`);
        return;
      }

      if (agentGateAddresses !== null) {
        const verified = await this.verifyAgentEnvelope(envelope, payload, contextGraphId, agentGateAddresses, ctx);
        if (!verified) return;
      }

      // Enforce peer allowlist for curated CGs
      if (allowedPeers !== null && !allowedPeers.includes(fromPeerId)) {
        this.log.warn(ctx, `SWM write rejected: peer "${fromPeerId}" not in allowlist for context graph "${contextGraphId}"`);
        return;
      }

      if (subGraphName) {
        const v = validateSubGraphName(subGraphName);
        if (!v.valid) {
          this.log.warn(ctx, `SWM write rejected: invalid subGraphName "${subGraphName}": ${v.reason}`);
          return;
        }
      }

      await this.graphManager.ensureContextGraph(contextGraphId);

      if (subGraphName) {
        await this.graphManager.ensureSubGraph(contextGraphId, subGraphName);

        const sgUri = contextGraphSubGraphUri(contextGraphId, subGraphName);
        const metaGraph = `did:dkg:context-graph:${assertSafeIri(contextGraphId)}/_meta`;
        const alreadyRegistered = await this.store.query(
          `ASK { GRAPH <${metaGraph}> {
            <${assertSafeIri(sgUri)}> a <http://dkg.io/ontology/SubGraph> ;
              <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
              <http://dkg.io/ontology/createdBy> ?createdBy .
          } }`,
        );
        if (alreadyRegistered.type !== 'boolean' || !alreadyRegistered.value) {
          const regQuads = generateSubGraphRegistration({
            contextGraphId,
            subGraphName,
            createdBy: publisherPeerId || 'swm-discovery',
            timestamp: new Date(),
          });
          await this.store.insert(regQuads);
          this.log.info(ctx, `Auto-registered sub-graph "${subGraphName}" in context graph "${contextGraphId}" from SWM`);
        }
      }

      const nquadsStr = new TextDecoder().decode(nquads);
      const quads = parseSimpleNQuads(nquadsStr);
      onPhase?.('decode', 'end');

      const manifestForValidation: KAManifestEntry[] = (manifest ?? []).map((m) => ({
        tokenId: 0n,
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot,
        privateTripleCount: m.privateTripleCount ?? 0,
      }));

      const swmGraph = this.graphManager.sharedMemoryUri(contextGraphId, subGraphName);
      const swmMetaGraph = this.graphManager.sharedMemoryMetaUri(contextGraphId, subGraphName);

      const swmOwnershipKey = subGraphName ? `${contextGraphId}\0${subGraphName}` : contextGraphId;
      const condSubjects = (casConditions ?? []).map(c => c.subject);
      const subjects = [...new Set([...quads.map(q => q.subject), ...condSubjects])];
      const lockKeys = subjects.map(s => `${swmOwnershipKey}\0${s}`);

      onPhase?.('store', 'start');
      const applied = await this.withWriteLocks(lockKeys, async (): Promise<boolean> => {
        const swmOwned = this.sharedMemoryOwnedEntities.get(swmOwnershipKey) ?? new Map<string, string>();
        const existing = new Set<string>([...swmOwned.keys()]);

        const upsertable = new Set<string>();
        for (const [entity, creator] of swmOwned) {
          if (creator === publisherPeerId) {
            upsertable.add(entity);
          }
        }

        onPhase?.('validate', 'start');
        const validation = validatePublishRequest(
          quads, manifestForValidation, contextGraphId, existing,
          { allowUpsert: true, upsertableEntities: upsertable },
        );
        if (!validation.valid) {
          this.log.warn(ctx, `SWM validation rejected: ${validation.errors.join('; ')}`);
          return false;
        }
        onPhase?.('validate', 'end');

        if (casConditions && casConditions.length > 0) {
          const passed = await this.enforceCASConditions(casConditions, swmGraph, ctx);
          if (!passed) {
            // Intentional: we reject writes whose CAS pre-conditions don't hold
            // locally. This can cause temporary divergence if gossip delivers
            // writes out-of-order, but the originator's SWM-sync protocol
            // replays missed writes on reconnect, converging replicas eventually.
            // Accepting stale-CAS writes would silently corrupt local state.
            this.log.info(ctx, `Skipping SWM write ${shareOperationId} — remote CAS conditions not met`);
            return false;
          }
        }

        for (const m of manifestForValidation) {
          if (swmOwned.has(m.rootEntity)) {
            await this.store.deleteByPattern({ graph: swmGraph, subject: m.rootEntity });
            await this.store.deleteBySubjectPrefix(swmGraph, m.rootEntity + '/.well-known/genid/');
            await this.deleteMetaForRoot(swmMetaGraph, m.rootEntity);
          }
        }

        const normalized = quads.map((q) => ({ ...q, graph: swmGraph }));
        await this.store.insert(normalized);

        const rootEntities = manifestForValidation.map((m) => m.rootEntity);
        const metaQuads = generateShareMetadata(
          {
            shareOperationId,
            contextGraphId,
            rootEntities,
            publisherPeerId,
            timestamp: new Date(Number(timestampMs)),
          },
          swmMetaGraph,
        );

        for (const m of manifestForValidation) {
          if (m.privateMerkleRoot && m.privateMerkleRoot.length > 0) {
            const hex = '0x' + Array.from(m.privateMerkleRoot).map(b => b.toString(16).padStart(2, '0')).join('');
            metaQuads.push({
              subject: m.rootEntity,
              predicate: 'http://dkg.io/ontology/privateMerkleRoot',
              object: `"${hex}"`,
              graph: swmMetaGraph,
            });
          }
        }

        await this.store.insert(metaQuads);
        await storeWorkspaceOperationPublicQuads({
          store: this.store,
          graphManager: this.graphManager,
          contextGraphId,
          shareOperationId,
          rootEntities,
          quads: normalized,
          publisherPeerId,
          subGraphName,
        });

        if (!this.sharedMemoryOwnedEntities.has(swmOwnershipKey)) {
          this.sharedMemoryOwnedEntities.set(swmOwnershipKey, new Map());
        }
        const liveOwned = this.sharedMemoryOwnedEntities.get(swmOwnershipKey)!;
        const newOwnershipEntries: Array<{ rootEntity: string; creatorPeerId: string }> = [];
        for (const r of rootEntities) {
          if (!liveOwned.has(r)) {
            newOwnershipEntries.push({ rootEntity: r, creatorPeerId: publisherPeerId });
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

        return true;
      });

      onPhase?.('store', 'end');
      if (applied) {
        this.log.info(ctx, `Stored SWM write ${shareOperationId} (${quads.length} quads)`);
        this.eventBus.emit(DKGEvent.MEMORY_GRAPH_CHANGED, {
          contextGraphId,
          layers: ['swm'],
          subGraphName,
          operation: 'shared_memory_gossiped',
          source: 'gossip',
          counts: { triples: quads.length },
        });
      }
    } catch (err) {
      this.log.error(ctx, `SWM handle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private decodeWorkspaceGossipMessage(data: Uint8Array): WorkspaceGossipDecodeResult {
    try {
      const envelope = decodeGossipEnvelope(data);
      if (
        envelope.version === GOSSIP_ENVELOPE_VERSION &&
        envelope.type === GOSSIP_TYPE_WORKSPACE_PUBLISH &&
        envelope.payload &&
        envelope.payload.length > 0
      ) {
        return {
          request: decodeWorkspacePublishRequest(envelope.payload),
          envelope,
          payload: new Uint8Array(envelope.payload),
        };
      }
    } catch {
      // Legacy raw workspace messages are still valid for non-agent-gated CGs.
    }
    return {
      request: decodeWorkspacePublishRequest(data),
      payload: data,
    };
  }

  private async verifyAgentEnvelope(
    envelope: GossipEnvelopeMsg | undefined,
    payload: Uint8Array,
    contextGraphId: string,
    agentGateAddresses: string[],
    ctx: import('@origintrail-official/dkg-core').OperationContext,
  ): Promise<boolean> {
    if (!envelope) {
      this.log.warn(ctx, `SWM write rejected: unsigned workspace gossip for agent-gated context graph "${contextGraphId}"`);
      return false;
    }

    if (envelope.version !== GOSSIP_ENVELOPE_VERSION || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH) {
      this.log.warn(ctx, `SWM write rejected: invalid gossip envelope type/version for context graph "${contextGraphId}"`);
      return false;
    }
    if (envelope.contextGraphId !== contextGraphId) {
      this.log.warn(ctx, `SWM write rejected: envelope contextGraphId "${envelope.contextGraphId}" does not match payload "${contextGraphId}"`);
      return false;
    }
    if (!envelope.signature || envelope.signature.length === 0) {
      this.log.warn(ctx, `SWM write rejected: missing agent signature for context graph "${contextGraphId}"`);
      return false;
    }

    const timestampMs = Date.parse(envelope.timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(this.now() - timestampMs) > GOSSIP_ENVELOPE_FRESHNESS_MS) {
      this.log.warn(ctx, `SWM write rejected: stale or invalid gossip timestamp "${envelope.timestamp}"`);
      return false;
    }

    let claimedAgent: string;
    let recovered: string;
    try {
      claimedAgent = ethers.getAddress(envelope.agentAddress);
      const signingPayload = computeGossipSigningPayload(
        envelope.type,
        envelope.contextGraphId,
        envelope.timestamp,
        payload,
      );
      recovered = ethers.verifyMessage(signingPayload, ethers.hexlify(envelope.signature));
    } catch (err) {
      this.log.warn(ctx, `SWM write rejected: invalid agent signature (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }

    if (recovered.toLowerCase() !== claimedAgent.toLowerCase()) {
      this.log.warn(ctx, `SWM write rejected: recovered signer ${recovered} does not match envelope agent ${claimedAgent}`);
      return false;
    }

    const agentGateSet = new Set(agentGateAddresses.map((agent) => agent.toLowerCase()));
    if (!agentGateSet.has(recovered.toLowerCase())) {
      this.log.warn(ctx, `SWM write rejected: agent ${recovered} is not allowed for context graph "${contextGraphId}"`);
      return false;
    }

    if (this.localAgentAddresses) {
      const localAgents = await this.localAgentAddresses();
      const localAllowed = localAgents.some((agent) => agentGateSet.has(agent.toLowerCase()));
      if (!localAllowed) {
        this.log.warn(ctx, `SWM write rejected: local node has no allowed agent for context graph "${contextGraphId}"`);
        return false;
      }
    }

    return true;
  }

  /**
   * Returns the peer allowlist for a context graph, or null if no allowlist
   * is set (open CG — all peers allowed).
   */
  private async getContextGraphAllowedPeers(contextGraphId: string): Promise<string[] | null> {
    const cgMeta = contextGraphMetaUri(contextGraphId);
    const cgData = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?peer WHERE { GRAPH <${cgMeta}> { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}> ?peer } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }
    return result.bindings
      .map(row => row['peer'])
      .filter((v): v is string => typeof v === 'string')
      .map(stripRdfLiteral);
  }

  /**
   * Returns the accepted SWM writer agent addresses for a context graph, or
   * null if the graph is not agent-gated. Includes DKG_ALLOWED_AGENT and
   * DKG_PARTICIPANT_AGENT metadata.
   */
  private async getContextGraphAgentGateAddresses(contextGraphId: string): Promise<string[] | null> {
    const cgMeta = contextGraphMetaUri(contextGraphId);
    const cgData = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?agent WHERE { GRAPH <${cgMeta}> {
        { <${cgData}> <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}> ?agent }
        UNION
        { <${cgData}> <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}> ?agent }
      } }`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return null;
    }
    const agents = result.bindings
      .map(row => row['agent'])
      .filter((v): v is string => typeof v === 'string')
      .map(stripRdfLiteral)
      .filter((v) => ethers.isAddress(v))
      .map((v) => ethers.getAddress(v));
    return [...new Set(agents)];
  }

  private async contextGraphHasPrivateAccessPolicy(contextGraphId: string): Promise<boolean> {
    if ((Object.values(SYSTEM_CONTEXT_GRAPHS) as string[]).includes(contextGraphId)) {
      return false;
    }

    const ontologyGraph = contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const cgMeta = contextGraphMetaUri(contextGraphId);
    const cgData = contextGraphDataUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?policy WHERE {
        {
          GRAPH <${ontologyGraph}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        } UNION {
          GRAPH <${cgMeta}> {
            <${cgData}> <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?policy
          }
        }
      }`,
    );
    if (result.type !== 'bindings') {
      return false;
    }
    return result.bindings.some((row) => {
      const policy = row['policy'];
      return typeof policy === 'string' && stripRdfLiteral(policy) === 'private';
    });
  }

  /**
   * Remove the SWM meta link for a specific rootEntity.
   * Only deletes the entire operation subject when no rootEntity links remain,
   * preserving metadata for other roots written in the same operation.
   */
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

/** @deprecated Use SharedMemoryHandler */
export const WorkspaceHandler = SharedMemoryHandler;

function parseCountLiteral(val: string | false | undefined): number {
  if (!val) return NaN;
  const stripped = val.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
  const n = Number(stripped);
  return Number.isFinite(n) ? n : NaN;
}

function stripRdfLiteral(value: string): string {
  return value
    .replace(/^"/, '')
    .replace(/"(@[a-zA-Z-]+|\^\^<[^>]+>)?$/, '');
}
