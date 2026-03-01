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
  /** Per-paranet set of rootEntities already in workspace (Rule 4). Shared with publisher when used by agent. */
  private readonly workspaceOwnedEntities: Map<string, Set<string>> = new Map();
  private readonly log = new Logger('WorkspaceHandler');

  constructor(
    store: TripleStore,
    eventBus: EventBus,
    options?: { workspaceOwnedEntities?: Map<string, Set<string>> },
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

      await this.graphManager.ensureParanet(paranetId);

      const nquadsStr = new TextDecoder().decode(nquads);
      const quads = parseSimpleNQuads(nquadsStr);

      const manifestForValidation: KAManifestEntry[] = (manifest ?? []).map((m) => ({
        tokenId: 0n,
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot,
        privateTripleCount: m.privateTripleCount ?? 0,
      }));

      const existing = this.workspaceOwnedEntities.get(paranetId) ?? new Set();
      const validation = validatePublishRequest(quads, manifestForValidation, paranetId, existing);
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
        this.workspaceOwnedEntities.set(paranetId, new Set());
      }
      for (const r of rootEntities) {
        this.workspaceOwnedEntities.get(paranetId)!.add(r);
      }

      this.log.info(ctx, `Stored workspace write ${workspaceOperationId} (${quads.length} quads)`);
    } catch (err) {
      this.log.error(ctx, `Workspace handle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
