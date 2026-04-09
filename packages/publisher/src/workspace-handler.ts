import type { TripleStore, Quad } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { EventBus } from '@origintrail-official/dkg-core';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import type { PhaseCallback } from './publisher.js';
import { decodeWorkspacePublishRequest, assertSafeIri, assertSafeRdfTerm, validateSubGraphName } from '@origintrail-official/dkg-core';
import type { WorkspaceCASConditionMsg } from '@origintrail-official/dkg-core';
import { validatePublishRequest } from './validation.js';
import { generateShareMetadata, generateOwnershipQuads } from './metadata.js';
import { parseSimpleNQuads } from './publish-handler.js';
import type { KAManifestEntry } from './publisher.js';

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
  private readonly log = new Logger('SharedMemoryHandler');

  constructor(
    store: TripleStore,
    eventBus: EventBus,
    options?: {
      sharedMemoryOwnedEntities?: Map<string, Map<string, string>>;
      writeLocks?: Map<string, Promise<void>>;
    },
  ) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.eventBus = eventBus;
    if (options?.sharedMemoryOwnedEntities) {
      this.sharedMemoryOwnedEntities = options.sharedMemoryOwnedEntities;
    }
    this.writeLocks = options?.writeLocks ?? new Map();
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
      const request = decodeWorkspacePublishRequest(data);
      if (request.operationId) {
        ctx = createOperationContext('share', request.operationId);
      }
      const contextGraphId = request.paranetId;
      const { nquads, manifest, publisherPeerId, workspaceOperationId: shareOperationId, timestampMs, casConditions, subGraphName } = request;
      const sgLabel = subGraphName ? `/${subGraphName}` : '';
      this.log.info(ctx, `SWM write from ${fromPeerId} for context graph ${contextGraphId}${sgLabel} op=${shareOperationId}`);

      if (publisherPeerId !== fromPeerId) {
        this.log.warn(ctx, `SWM write rejected: payload publisherPeerId "${publisherPeerId}" does not match sender "${fromPeerId}"`);
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
      }
    } catch (err) {
      this.log.error(ctx, `SWM handle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
