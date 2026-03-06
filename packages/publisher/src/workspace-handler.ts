import type { TripleStore, Quad } from '@dkg/storage';
import { GraphManager } from '@dkg/storage';
import type { EventBus } from '@dkg/core';
import { Logger, createOperationContext } from '@dkg/core';
import { decodeWorkspacePublishRequest } from '@dkg/core';
import { validatePublishRequest } from './validation.js';
import { computePublicRoot, computeKARoot } from './merkle.js';
import { generateWorkspaceMetadata } from './metadata.js';
import { autoPartition } from './auto-partition.js';
import { parseSimpleNQuads } from './publish-handler.js';
import type { KAManifestEntry } from './publisher.js';

/**
 * Handles incoming workspace topic messages (GossipSub).
 * Validates the request, stores public triples into workspace graph
 * and metadata into workspace_meta graph. No chain, no UAL.
 */
export class WorkspaceHandler {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  private readonly eventBus: EventBus;
  /** Per-paranet map of rootEntity → creatorPeerId. Shared with publisher when used by agent. */
  private readonly workspaceOwnedEntities: Map<string, Map<string, string>> = new Map();
  private readonly log = new Logger('WorkspaceHandler');

  constructor(
    store: TripleStore,
    eventBus: EventBus,
    options?: { workspaceOwnedEntities?: Map<string, Map<string, string>> },
  ) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.eventBus = eventBus;
    if (options?.workspaceOwnedEntities) {
      this.workspaceOwnedEntities = options.workspaceOwnedEntities;
    }
  }

  /**
   * Handler for GossipSub workspace topic: (data, fromPeerId) => void.
   * Validates, stores to workspace + workspace_meta, updates workspaceOwnedEntities.
   */
  async handle(data: Uint8Array, fromPeerId: string): Promise<void> {
    const ctx = createOperationContext('workspace');
    try {
      const request = decodeWorkspacePublishRequest(data);
      const { paranetId, nquads, manifest, publisherPeerId, workspaceOperationId, timestampMs } = request;
      this.log.info(ctx, `Workspace write from ${fromPeerId} for paranet ${paranetId} op=${workspaceOperationId}`);

      if (publisherPeerId !== fromPeerId) {
        this.log.warn(ctx, `Workspace write rejected: payload publisherPeerId "${publisherPeerId}" does not match sender "${fromPeerId}"`);
        return;
      }

      await this.graphManager.ensureParanet(paranetId);

      const nquadsStr = new TextDecoder().decode(nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      const manifestForValidation: KAManifestEntry[] = (manifest ?? []).map((m) => ({
        tokenId: 0n,
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot,
        privateTripleCount: m.privateTripleCount ?? 0,
      }));

      const wsOwned = this.workspaceOwnedEntities.get(paranetId) ?? new Map<string, string>();
      const existing = new Set<string>([...wsOwned.keys()]);

      // Creator-only upsert: allow overwriting entities this writer created
      const upsertable = new Set<string>();
      for (const [entity, creator] of wsOwned) {
        if (creator === publisherPeerId) {
          upsertable.add(entity);
        }
      }

      const validation = validatePublishRequest(
        quads, manifestForValidation, paranetId, existing,
        { allowUpsert: true, upsertableEntities: upsertable },
      );
      if (!validation.valid) {
        this.log.warn(ctx, `Workspace validation rejected: ${validation.errors.join('; ')}`);
        return;
      }

      const partitioned = autoPartition(quads);
      for (const m of manifestForValidation) {
        const publicQuads = partitioned.get(m.rootEntity) ?? [];
        const publicRoot = computePublicRoot(publicQuads);
        const kaEntry = manifest?.find((e) => e.rootEntity === m.rootEntity);
        const privateRoot = kaEntry?.privateMerkleRoot?.length ? new Uint8Array(kaEntry.privateMerkleRoot) : undefined;
        computeKARoot(publicRoot, privateRoot);
      }

      const workspaceGraph = this.graphManager.workspaceGraphUri(paranetId);
      const workspaceMetaGraph = this.graphManager.workspaceMetaGraphUri(paranetId);

      // Delete-then-insert for upserted entities.
      // Delete exact root + skolemized children only to avoid prefix collisions.
      // Also remove prior workspace_meta ops referencing these roots to prevent stale cleanup.
      for (const m of manifestForValidation) {
        if (wsOwned.has(m.rootEntity)) {
          await this.store.deleteByPattern({ graph: workspaceGraph, subject: m.rootEntity });
          await this.store.deleteBySubjectPrefix(workspaceGraph, m.rootEntity + '/.well-known/genid/');
          await this.deleteMetaForRoot(workspaceMetaGraph, m.rootEntity);
        }
      }

      const normalized = quads.map((q) => ({ ...q, graph: workspaceGraph }));
      await this.store.insert(normalized);

      const rootEntities = manifestForValidation.map((m) => m.rootEntity);
      const metaQuads = generateWorkspaceMetadata(
        {
          workspaceOperationId,
          paranetId,
          rootEntities,
          publisherPeerId,
          timestamp: new Date(Number(timestampMs)),
        },
        workspaceMetaGraph,
      );
      await this.store.insert(metaQuads);

      if (!this.workspaceOwnedEntities.has(paranetId)) {
        this.workspaceOwnedEntities.set(paranetId, new Map());
      }
      for (const r of rootEntities) {
        if (!wsOwned.has(r)) {
          this.workspaceOwnedEntities.get(paranetId)!.set(r, publisherPeerId);
        }
      }

      this.log.info(ctx, `Stored workspace write ${workspaceOperationId} (${quads.length} quads)`);
    } catch (err) {
      this.log.error(ctx, `Workspace handle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Remove the workspace_meta link for a specific rootEntity.
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

function parseCountLiteral(val: string | false | undefined): number {
  if (!val) return NaN;
  const stripped = val.replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '');
  const n = Number(stripped);
  return Number.isFinite(n) ? n : NaN;
}
