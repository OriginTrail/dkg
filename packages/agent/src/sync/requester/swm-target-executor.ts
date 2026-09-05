// SPDX-License-Identifier: Apache-2.0

/** Stable public/private target executor for graph-complete SWM recovery. */

import {
  DKG_ENTITY,
  DKG_ONTOLOGY,
  DKG_ROOT_ENTITY_LEGACY,
  ENTITY_PRED_ALT,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  createOperationContext,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import {
  GraphManager,
  deleteByPatternWithoutCount,
  tryReplaceGraphAtomically,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  reconcileFinalizedSwmTwinFromDescriptor,
  type FinalizedSwmTwinRetirement,
} from './finalized-swm-twin-reconciliation.js';
import type { RecoveryExecutionGuard } from './recovery-execution-guard.js';
import {
  runSharedMemorySync,
  type SharedMemoryMetadataFetcher,
  type SharedMemorySyncContext,
  type SharedMemorySyncSummary,
} from './shared-memory-sync.js';
import {
  createSharedMemorySnapshotMaterializer,
  type SharedMemorySnapshotMaterializer,
} from './swm-snapshot-materializer.js';
import {
  recoverContextGraphSwm,
  type RecoverContextGraphSwmResult,
} from './swm-recovery.js';
import { insertWithOversizeGuard, type OversizeGuardHooks } from '../oversize-filter.js';

type RecoverContextGraphSwmOptions = Parameters<typeof recoverContextGraphSwm>[0];

export interface SwmTargetExecutorPortsV1 {
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly listSubGraphs: (
    contextGraphId: string,
  ) => Promise<Array<{ name: string; uri?: string }>>;
  readonly createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  readonly fetchSyncPages: SharedMemorySyncContext['fetchSyncPages'];
  readonly processSharedMemoryBatch: SharedMemorySyncContext['processSharedMemoryBatch'];
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  readonly recordDrops: OversizeGuardHooks['recordDrops'];
  readonly invalidateListContextGraphsCache: () => void;
  readonly markMetaProjectionDirty: (quads: Quad[]) => void;
  readonly setCheckpoint: RecoverContextGraphSwmOptions['setCheckpoint'];
  readonly deleteCheckpoint: RecoverContextGraphSwmOptions['deleteCheckpoint'];
  readonly deletePublicCheckpoint: RecoverContextGraphSwmOptions['deleteCheckpoint'];
  readonly ensureOwnedMap: NonNullable<RecoverContextGraphSwmOptions['ensureOwnedMap']>;
  readonly retireFinalizedSwmTwin: (
    retirement: FinalizedSwmTwinRetirement,
    ctx: OperationContext,
  ) => Promise<void>;
  readonly logInfo: (ctx: OperationContext, message: string) => void;
  readonly logWarn: (ctx: OperationContext, message: string) => void;
  readonly logDebug: (ctx: OperationContext, message: string) => void;
}

interface PublicSwmTargetBaseV1 {
  readonly ctx: OperationContext;
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly remainingContextGraphs: number;
  readonly stopOnBackoffWorthyFailure?: boolean;
  /** Include the catalog-owned root SWM scope as well as named subgraphs. */
  readonly includeRootScope?: boolean;
}

/** The only two valid public synchronization contracts. */
export type PublicSwmTargetV1 = Readonly<PublicSwmTargetBaseV1 & {
  readonly mode:
    | Readonly<{ kind: 'ordinary' }>
    | Readonly<{
      kind: 'selected-recovery';
      recoveryGuard: RecoveryExecutionGuard;
      metadataFetcher: SharedMemoryMetadataFetcher;
    }>;
}>;

export interface PrivateSwmRecoveryTargetV1 {
  readonly remotePeerId: string;
  readonly contextGraphId: string;
  readonly recoveryGuard?: RecoveryExecutionGuard;
  /** Include the catalog-owned root SWM scope as well as named subgraphs. */
  readonly includeRootScope?: boolean;
}

/**
 * Owns the stable adapters and write policies for ordinary public sync and
 * public/private recovery. Callers supply only per-target state; requester
 * algorithms never reach back into the lifecycle class for stores,
 * checkpoints, verification, or materialization.
 */
export class SwmTargetExecutorV1 {
  readonly #ports: SwmTargetExecutorPortsV1;
  readonly #snapshotMaterializer: SharedMemorySnapshotMaterializer;
  readonly #subGraphAdmission = new Map<
    string,
    Promise<{ registered: string[]; excluded: string[] }>
  >();

  constructor(ports: SwmTargetExecutorPortsV1) {
    this.#ports = ports;
    this.#snapshotMaterializer = createSharedMemorySnapshotMaterializer({
      store: ports.store,
      writeLocks: ports.writeLocks,
      invalidateListContextGraphsCache: ports.invalidateListContextGraphsCache,
    });
  }

  async recoverPrivateTarget(
    target: PrivateSwmRecoveryTargetV1,
  ): Promise<RecoverContextGraphSwmResult> {
    const ctx = createOperationContext('sync');
    const admission = () => this.#getSubGraphAdmission(target.contextGraphId);
    const options: RecoverContextGraphSwmOptions = {
      ctx,
      remotePeerId: target.remotePeerId,
      contextGraphId: target.contextGraphId,
      deadline: this.#ports.createContextGraphSyncDeadline(1),
      fetchSyncPages: (
        requestCtx,
        peerId,
        contextGraphId,
        includeSharedMemory,
        phase,
        graphUri,
        deadline,
        fetchOptions,
      ) => this.#ports.fetchSyncPages(
        requestCtx,
        peerId,
        contextGraphId,
        includeSharedMemory,
        phase,
        graphUri,
        deadline,
        { ...fetchOptions, recovery: true },
      ),
      processSharedMemoryBatch: this.#ports.processSharedMemoryBatch,
      writeLocks: this.#ports.writeLocks,
      publicSnapshotStore: this.#ports.publicSnapshotStore,
      snapshotMaterializer: this.#snapshotMaterializer,
      store: this.#privateRecoveryStore(),
      replaceMetaForRoots: (roots, metaGraphs) => this.#replaceMetaForRoots(
        target.contextGraphId,
        roots,
        metaGraphs,
      ),
      replaceMetaForGraphAssets: (assets) => (
        this.#snapshotMaterializer.replaceMetaForGraphAssets(assets)
      ),
      ensureContextGraph: (contextGraphId) => this.#ensureContextGraph(contextGraphId),
      setCheckpoint: this.#ports.setCheckpoint,
      deleteCheckpoint: this.#ports.deleteCheckpoint,
      getRegisteredSubGraphNames: async () => (await admission()).registered,
      getExcludedSubGraphNames: async () => (await admission()).excluded,
      includeRootScope: target.includeRootScope,
      ensureOwnedMap: this.#ports.ensureOwnedMap,
      logInfo: this.#ports.logInfo,
      logWarn: this.#ports.logWarn,
      recoveryGuard: target.recoveryGuard,
    };
    return recoverContextGraphSwm(options);
  }

  async syncPublicTarget(
    target: PublicSwmTargetV1,
  ): Promise<SharedMemorySyncSummary> {
    const recoveryGuard = target.mode.kind === 'selected-recovery'
      ? target.mode.recoveryGuard
      : undefined;
    const storeInsert = async (quads: Quad[]) => {
      const inserted = await insertWithOversizeGuard(
        (kept) => this.#ports.store.insert(kept, {
          priority: 'background',
          source: 'agent.sharedMemorySync.storeInsert',
        }),
        quads,
        { recordDrops: this.#ports.recordDrops },
        'swm-sync',
      );
      this.#ports.markMetaProjectionDirty(inserted);
    };
    return runSharedMemorySync({
      ctx: target.ctx,
      remotePeerId: target.remotePeerId,
      contextGraphIds: [target.contextGraphId],
      createContextGraphSyncDeadline: () => (
        this.#ports.createContextGraphSyncDeadline(target.remainingContextGraphs)
      ),
      // Raw port: runSharedMemorySync owns all recovery-boundary checks and
      // attaches the selected lease signal at the deepest fetch call.
      fetchSyncPages: this.#ports.fetchSyncPages,
      processSharedMemoryBatch: this.#ports.processSharedMemoryBatch,
      getRegisteredSubGraphNames: async (contextGraphId) => (
        await this.#getSubGraphAdmission(contextGraphId)
      ).registered,
      getExcludedSubGraphNames: async (contextGraphId) => (
        await this.#getSubGraphAdmission(contextGraphId)
      ).excluded,
      includeRootScope: target.includeRootScope,
      stopOnBackoffWorthyFailure: target.stopOnBackoffWorthyFailure,
      snapshotEvidencePolicy: target.mode.kind === 'selected-recovery'
        ? {
          accepts: ({
            verifiedMetadataTriples,
            snapshotReferences,
            graphBackedOperations,
          }) => (
            verifiedMetadataTriples === 0
            || (snapshotReferences > 0 && graphBackedOperations === 0)
          ),
        }
        : undefined,
      metadataFetcher: target.mode.kind === 'selected-recovery'
        ? target.mode.metadataFetcher
        : undefined,
      snapshotRecoveryOrder: target.mode.kind === 'selected-recovery'
        ? 'recent-balanced'
        : 'manifest',
      ensureContextGraph: (contextGraphId) => this.#ensureContextGraph(contextGraphId),
      snapshotMaterializer: this.#snapshotMaterializer,
      reconcileFinalizedTwin: async (contextGraphId, descriptor) => {
        const retirement = await reconcileFinalizedSwmTwinFromDescriptor({
          store: this.#ports.store,
          writeLocks: this.#ports.writeLocks,
          contextGraphId,
          descriptor,
          retire: (candidate) => this.#ports.retireFinalizedSwmTwin(candidate, target.ctx),
        });
        if (retirement === 'retired') {
          this.#ports.invalidateListContextGraphsCache();
          this.#ports.logInfo(
            target.ctx,
            `Retired byte-identical SWM twin after SWM recovery found finalized VM for ${descriptor.kaUal}`,
          );
        }
        return retirement === 'retired' || retirement === 'already-retired-finalized'
          ? 'suppress-metadata'
          : 'preserve';
      },
      storeInsert,
      publicSnapshotStore: this.#ports.publicSnapshotStore,
      deleteCheckpoint: this.#ports.deletePublicCheckpoint,
      setCheckpoint: this.#ports.setCheckpoint,
      ensureOwnedMap: this.#ports.ensureOwnedMap,
      recoveryGuard,
      logInfo: this.#ports.logInfo,
      logWarn: this.#ports.logWarn,
      logDebug: this.#ports.logDebug,
    });
  }

  async #getSubGraphAdmission(
    contextGraphId: string,
  ): Promise<{ registered: string[]; excluded: string[] }> {
    let current = this.#subGraphAdmission.get(contextGraphId);
    if (current === undefined) {
      current = getSharedMemorySubGraphAdmission(
        this.#ports.store,
        contextGraphId,
        this.#ports.listSubGraphs(contextGraphId),
      );
      this.#subGraphAdmission.set(contextGraphId, current);
    }
    return current;
  }

  async #ensureContextGraph(contextGraphId: string): Promise<void> {
    const graphManager = new GraphManager(this.#ports.store);
    await graphManager.ensureContextGraph(contextGraphId);
  }

  #privateRecoveryStore(): RecoverContextGraphSwmOptions['store'] {
    return {
      insert: async (quads) => {
        const inserted = await insertWithOversizeGuard(
          (kept) => this.#ports.store.insert(kept, {
            priority: 'background',
            source: 'agent.swmRecovery.insert',
          }),
          quads,
          { recordDrops: this.#ports.recordDrops },
          'swm-recovery',
        );
        if (inserted.length > 0) {
          this.#ports.invalidateListContextGraphsCache();
          this.#ports.markMetaProjectionDirty(inserted);
        }
      },
      replaceGraph: async (graph, quads) => {
        const replaced = await tryReplaceGraphAtomically(
          this.#ports.store,
          graph,
          quads,
          {
            priority: 'background',
            source: 'agent.swmRecovery.graphScopedReplace',
          },
        );
        if (!replaced) {
          throw Object.assign(
            new Error('Graph-scoped SWM recovery requires atomic TripleStore.replaceGraph() support'),
            { code: 'SWM_ATOMIC_REPLACE_UNSUPPORTED' },
          );
        }
        this.#ports.invalidateListContextGraphsCache();
      },
      deleteByPattern: (pattern) => this.#ports.store.deleteByPattern(pattern, {
        priority: 'background',
        source: 'agent.swmRecovery.deleteByPattern',
      }),
      deleteBySubjectPrefix: (graph, prefix) => this.#ports.store.deleteBySubjectPrefix(
        graph,
        prefix,
        {
          priority: 'background',
          source: 'agent.swmRecovery.deleteBySubjectPrefix',
        },
      ),
    };
  }

  async #replaceMetaForRoots(
    contextGraphId: string,
    roots: readonly { readonly entity: string }[],
    metaGraphs: readonly string[],
  ): Promise<void> {
    const graphs = metaGraphs.length > 0
      ? metaGraphs
      : [contextGraphWorkspaceMetaGraphUri(contextGraphId)];
    const entities = [...new Set(roots.map(({ entity }) => entity))];
    for (const metaGraph of graphs) {
      for (const entity of entities) {
        const operations = await this.#ports.store.query(
          `SELECT DISTINCT ?op WHERE { GRAPH <${metaGraph}> { ?op ${ENTITY_PRED_ALT} <${entity}> } }`,
          {
            priority: 'background',
            source: 'agent.swmRecovery.replaceMetaForRoots.findOps',
          },
        );
        if (operations.type !== 'bindings') continue;
        for (const row of operations.bindings) {
          const operation = row['op'];
          if (!operation) continue;
          await this.#ports.store.delete(
            [
              {
                subject: operation,
                predicate: DKG_ROOT_ENTITY_LEGACY,
                object: entity,
                graph: metaGraph,
              },
              {
                subject: operation,
                predicate: DKG_ENTITY,
                object: entity,
                graph: metaGraph,
              },
            ],
            {
              priority: 'background',
              source: 'agent.swmRecovery.replaceMetaForRoots.deleteLinks',
            },
          );
          const remaining = await this.#ports.store.query(
            `SELECT (COUNT(DISTINCT ?r) AS ?c) WHERE { GRAPH <${metaGraph}> { <${operation}> ${ENTITY_PRED_ALT} ?r } }`,
            {
              priority: 'background',
              source: 'agent.swmRecovery.replaceMetaForRoots.countRoots',
            },
          );
          const raw = remaining.type === 'bindings'
            ? remaining.bindings[0]?.['c']
            : undefined;
          const count = raw
            ? Number.parseInt(String(raw).match(/\d+/u)?.[0] ?? '0', 10)
            : 0;
          if (count === 0) {
            await deleteByPatternWithoutCount(
              this.#ports.store,
              { graph: metaGraph, subject: operation },
              {
                priority: 'background',
                source: 'agent.swmRecovery.replaceMetaForRoots.deleteOp',
              },
            );
          }
        }
      }
    }
  }
}

async function getSharedMemorySubGraphAdmission(
  store: TripleStore,
  contextGraphId: string,
  subGraphsPromise: Promise<Array<{ name: string; uri?: string }>>,
): Promise<{ registered: string[]; excluded: string[] }> {
  const registered: string[] = [];
  const excluded: string[] = [];
  for (const subGraph of await subGraphsPromise) {
    const childContextGraphUri = `${contextGraphDataGraphUri(contextGraphId)}/${subGraph.name}`;
    if (subGraph.uri && subGraph.uri !== childContextGraphUri) continue;
    if (await isKnownContextGraphUri(store, childContextGraphUri)) {
      excluded.push(subGraph.name);
    } else {
      registered.push(subGraph.name);
    }
  }
  return { registered, excluded };
}

async function isKnownContextGraphUri(
  store: TripleStore,
  contextGraphUri: string,
): Promise<boolean> {
  const metaGraph = `${contextGraphUri}/_meta`;
  const result = await store.query(
    `
      ASK {
        GRAPH <${assertSafeIri(metaGraph)}> {
          {
            <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          } UNION {
            <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status .
          }
        }
      }
    `,
    { source: 'agent.subGraphClassification.knownContextGraph' },
  );
  return result.type === 'boolean' && result.value;
}
