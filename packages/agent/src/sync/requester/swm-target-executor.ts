// SPDX-License-Identifier: Apache-2.0

/** Stable public/private target executor for graph-complete SWM recovery. */

import {
  DKG_ONTOLOGY,
  assertSafeIri,
  contextGraphDataGraphUri,
  createOperationContext,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import {
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  reconcileFinalizedSwmTwinFromDescriptor,
  type FinalizedSwmTwinReconciliationOutcome,
  type FinalizedSwmTwinRetirement,
} from './finalized-swm-twin-reconciliation.js';
import { FinalizedSwmTwinMemoV1 } from './finalized-swm-twin-memo.js';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import type { RecoveryExecutionGuard } from './recovery-execution-guard.js';
import {
  runSharedMemorySync,
  type SharedMemoryMetadataFetcher,
  type SharedMemorySyncContext,
} from './shared-memory-sync.js';
import type { SharedMemorySyncSummary } from '../shared-memory-diagnostics.js';
import {
  createSharedMemorySnapshotMaterializer,
  type SharedMemorySnapshotMaterializer,
} from './swm-snapshot-materializer.js';
import {
  createPrivateSwmRecoveryWindow,
  normalizePrivateSwmRecoveryBudgetMs,
} from './private-swm-recovery-budget.js';
import {
  recoverContextGraphSwm,
  recoverContextGraphSwmWithProgressRetries,
  type SwmRecoveryProgress,
  type RecoverContextGraphSwmResult,
} from './swm-recovery.js';
import {
  type SwmRecoveryMutationRuntimeV1,
} from './swm-recovery-apply.js';
import { insertWithOversizeGuard, type OversizeGuardHooks } from '../oversize-filter.js';
import {
  PrivateSwmSnapshotWalkRegistry,
  type PrivateSwmSnapshotWalkLease,
} from './private-swm-snapshot-walk-registry.js';
import { SyncedSubGraphRegistration } from './synced-sub-graph-registration.js';

type RecoverContextGraphSwmOptions = Parameters<typeof recoverContextGraphSwm>[0];

export interface SwmTargetExecutorPortsV1 {
  /** Defaults to ten minutes for callers composed before this port existed. */
  readonly privateRecoveryBudgetMs?: number;
  /** Mutations own their projection invalidation at the supplied store boundary. */
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly listSubGraphs: (
    contextGraphId: string,
  ) => Promise<Array<{ name: string; uri?: string }>>;
  readonly createContextGraphSyncDeadline: (remainingContextGraphs: number) => number;
  readonly fetchSyncPages: SharedMemorySyncContext['fetchSyncPages'];
  readonly processSharedMemoryBatch: SharedMemorySyncContext['processSharedMemoryBatch'];
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /** Process-local RFC-64 authority decision; this port must not perform I/O. */
  readonly ordinaryRootSnapshotApplyAllowed?: (contextGraphId: string) => boolean;
  readonly resolveRootSnapshotAtomicCompanion?:
    SharedMemorySyncContext['resolveRootSnapshotAtomicCompanion'];
  readonly recordDrops: OversizeGuardHooks['recordDrops'];
  readonly invalidateListContextGraphsCache: () => void;
  readonly recoveryMutation: SwmRecoveryMutationRuntimeV1;
  readonly setCheckpoint: RecoverContextGraphSwmOptions['setCheckpoint'];
  readonly deleteCheckpoint: RecoverContextGraphSwmOptions['deleteCheckpoint'];
  readonly deletePublicCheckpoint: RecoverContextGraphSwmOptions['deleteCheckpoint'];
  readonly ensureOwnedMap: NonNullable<RecoverContextGraphSwmOptions['ensureOwnedMap']>;
  readonly retireFinalizedSwmTwin: (
    retirement: FinalizedSwmTwinRetirement,
    ctx: OperationContext,
  ) => Promise<void>;
  /**
   * The rest of a finalized twin's cleanup, which its lifecycle owns: the
   * legacy marker while one is outstanding, and the author's inventory row
   * while one is left. Idempotent, so every round that proves the twin
   * retired asks again.
   */
  readonly retireLegacySwmAfterVerifiedVmTwin?: (input: Readonly<{
    contextGraphId: string;
    kaUal: string;
    assertionVersion: string;
    subGraphName?: string;
  }>) => Promise<void>;
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
  /** Read the peer's state at the call: join no page fetch of another round. */
  readonly freshSnapshot?: boolean;
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
  readonly onRetry?: (progress: SwmRecoveryProgress) => void;
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
  readonly #privateRecoveryBudgetMs: number;
  readonly #snapshotMaterializer: SharedMemorySnapshotMaterializer;
  readonly #recoveryMutation: SwmRecoveryMutationRuntimeV1;
  readonly #subGraphAdmission = new Map<
    string,
    Promise<{ registered: string[]; excluded: string[] }>
  >();
  readonly #syncedSubGraphs: SyncedSubGraphRegistration;

  constructor(
    ports: SwmTargetExecutorPortsV1,
    private readonly privateSnapshotWalks = new PrivateSwmSnapshotWalkRegistry(),
    private readonly finalizedTwins = new FinalizedSwmTwinMemoV1(),
  ) {
    this.#ports = ports;
    this.#privateRecoveryBudgetMs = normalizePrivateSwmRecoveryBudgetMs(
      ports.privateRecoveryBudgetMs,
    );
    this.#snapshotMaterializer = createSharedMemorySnapshotMaterializer({
      store: ports.store,
      writeLocks: ports.writeLocks,
      invalidateListContextGraphsCache: ports.invalidateListContextGraphsCache,
    });
    this.#recoveryMutation = ports.recoveryMutation;
    this.#syncedSubGraphs = new SyncedSubGraphRegistration({
      store: ports.store,
      writeLocks: ports.writeLocks,
      admittedNames: async (contextGraphId) => {
        const { registered, excluded } = await this.#getSubGraphAdmission(contextGraphId);
        return [...registered, ...excluded];
      },
      isKnownChildContextGraph: (contextGraphId, subGraphName) => isKnownContextGraphUri(
        ports.store,
        `${contextGraphDataGraphUri(contextGraphId)}/${subGraphName}`,
      ),
    });
  }

  async recoverPrivateTarget(
    target: PrivateSwmRecoveryTargetV1,
  ): Promise<RecoverContextGraphSwmResult> {
    const window = createPrivateSwmRecoveryWindow(this.#privateRecoveryBudgetMs);
    const ctx = createOperationContext('sync');
    const admission = () => this.#getSubGraphAdmission(target.contextGraphId);
    let snapshotLease: PrivateSwmSnapshotWalkLease | undefined;
    const options: Omit<RecoverContextGraphSwmOptions, 'deadline' | 'workAdmission'> = {
      ctx,
      remotePeerId: target.remotePeerId,
      contextGraphId: target.contextGraphId,
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
      resolveRootAtomicCompanion: this.#ports.resolveRootSnapshotAtomicCompanion,
      store: this.#recoveryMutation.store,
      replaceMetaForRoots: (roots, metaGraphs) => this.#recoveryMutation
        .replaceMetaForRoots(
          target.contextGraphId,
          roots,
          metaGraphs,
        ),
      replaceMetaForGraphAssets: (assets) => (
        this.#snapshotMaterializer.replaceMetaForGraphAssets(assets)
      ),
      ensureContextGraph: this.#recoveryMutation.ensureContextGraph,
      setCheckpoint: this.#ports.setCheckpoint,
      deleteCheckpoint: this.#ports.deleteCheckpoint,
      getRegisteredSubGraphNames: async () => (await admission()).registered,
      getExcludedSubGraphNames: async () => (await admission()).excluded,
      includeRootScope: target.includeRootScope,
      ensureOwnedMap: this.#ports.ensureOwnedMap,
      snapshotWalkProgress: (orderedManifest) => {
        if (snapshotLease?.progress.matches(orderedManifest)) return snapshotLease.progress;
        snapshotLease?.release();
        snapshotLease = this.privateSnapshotWalks.open(target, orderedManifest);
        snapshotLease.progress.beginRecoveryJob();
        return snapshotLease.progress;
      },
      logInfo: this.#ports.logInfo,
      logWarn: this.#ports.logWarn,
      recoveryGuard: target.recoveryGuard,
    };
    const result = await recoverContextGraphSwmWithProgressRetries({
      window,
      createRoundDeadline: () => this.#ports.createContextGraphSyncDeadline(1),
      onRetry: target.onRetry,
      snapshotProgressRetention: () => snapshotLease?.kind ?? 'detached',
      recover: (_round, workAdmission, deadline) =>
        recoverContextGraphSwm({ ...options, deadline, workAdmission }),
    });
    if (result.completed) snapshotLease?.release();
    return result;
  }

  async syncPublicTarget(
    target: PublicSwmTargetV1,
  ): Promise<SharedMemorySyncSummary> {
    const mode = target.mode.kind === 'selected-recovery'
      ? {
        kind: 'selected-recovery' as const,
        recoveryGuard: target.mode.recoveryGuard,
        metadataFetcher: target.mode.metadataFetcher,
        snapshotEvidencePolicy: {
          accepts: ({
            verifiedMetadataTriples,
            snapshotReferences,
            graphBackedOperations,
          }: {
            verifiedMetadataTriples: number;
            snapshotReferences: number;
            graphBackedOperations: number;
          }) => (
            verifiedMetadataTriples === 0
            || (snapshotReferences > 0 && graphBackedOperations === 0)
          ),
        },
        snapshotRecoveryOrder: 'recent-balanced' as const,
      }
      : { kind: 'ordinary' as const };
    const storeInsert = async (quads: Quad[]) => {
      await insertWithOversizeGuard(
        (kept) => this.#ports.store.insert(kept, {
          priority: 'background',
          source: 'agent.sharedMemorySync.storeInsert',
        }),
        quads,
        { recordDrops: this.#ports.recordDrops },
        'swm-sync',
      );
      await this.#registerSyncedSubGraphs(target, quads);
    };
    return runSharedMemorySync({
      mode,
      freshSnapshot: target.freshSnapshot,
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
      isOwnContextGraph: (contextGraphId, name) => isKnownContextGraphUri(
        this.#ports.store,
        `${contextGraphDataGraphUri(contextGraphId)}/${name}`,
      ),
      includeRootScope: target.includeRootScope,
      stopOnBackoffWorthyFailure: target.stopOnBackoffWorthyFailure,
      ensureContextGraph: this.#recoveryMutation.ensureContextGraph,
      snapshotMaterializer: this.#snapshotMaterializer,
      ordinaryRootSnapshotApplyAllowed: this.#ports.ordinaryRootSnapshotApplyAllowed,
      resolveRootSnapshotAtomicCompanion:
        this.#ports.resolveRootSnapshotAtomicCompanion,
      reconcileFinalizedTwin: (contextGraphId, descriptor) => (
        this.#retireFinalizedTwinAfterWrite(target, contextGraphId, descriptor)
      ),
      heldAsRetiredFinalizedTwin: (contextGraphId, descriptor) => (
        this.#heldAsRetiredFinalizedTwin(target, contextGraphId, descriptor)
      ),
      storeInsert,
      publicSnapshotStore: this.#ports.publicSnapshotStore,
      deleteCheckpoint: this.#ports.deletePublicCheckpoint,
      setCheckpoint: this.#ports.setCheckpoint,
      ensureOwnedMap: this.#ports.ensureOwnedMap,
      logInfo: this.#ports.logInfo,
      logWarn: this.#ports.logWarn,
      logDebug: this.#ports.logDebug,
    });
  }

  /**
   * Ask the twin's lifecycle for the rest of its cleanup: its legacy marker and
   * its author's inventory row. A failure stays a warning: a marker left behind
   * is the conservative state, retried by its own owner, by a later round that
   * proves the twin retired again, or by the asset's next publication.
   */
  async #retireLegacyMarker(
    target: PublicSwmTargetV1,
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<void> {
    try {
      await this.#ports.retireLegacySwmAfterVerifiedVmTwin?.({
        contextGraphId,
        kaUal: descriptor.kaUal,
        assertionVersion: descriptor.assertionVersion,
        subGraphName: descriptor.subGraphName,
      });
    } catch (cause) {
      this.#ports.logWarn(
        target.ctx,
        `Deferred legacy SWM boundary retirement after finalized VM twin cleanup for `
          + `${descriptor.kaUal}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /**
   * A snapshot this node proved finalized and retired in an earlier round
   * (`finalized-swm-twin-memo.ts`) is held only once the same proof passes
   * again: Verified Memory still holds that content, and the shared-memory copy
   * is gone, head and all. The proof writes nothing unless a share brought the
   * copy back, which it retires. When it fails, the entry is forgotten and the
   * round takes the snapshot the usual way, as it does when the proof cannot
   * run. Nothing of a held twin is written, and a named sub-graph is registered
   * from the rows a round writes: it is registered here from the snapshot's
   * verified rows instead, so a registration that failed in the round that
   * retired the twin gets its next try, and its finalized content its reads.
   */
  async #heldAsRetiredFinalizedTwin(
    target: PublicSwmTargetV1,
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<boolean> {
    if (!this.finalizedTwins.retired(contextGraphId, descriptor)) return false;
    const outcome = await this.#reconcileFinalizedTwin(target, contextGraphId, descriptor)
      .catch((cause: unknown) => {
        this.finalizedTwins.forget(contextGraphId, descriptor);
        this.#ports.logWarn(
          target.ctx,
          `Taking the snapshot of retired finalized SWM twin ${descriptor.kaUal} again: its proof `
            + `did not run: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        return undefined;
      });
    // A partial head needs materialization even if the graph was retired.
    if (outcome !== 'retired' && outcome !== 'already-retired-finalized') {
      this.finalizedTwins.forget(contextGraphId, descriptor);
      return false;
    }
    this.finalizedTwins.remember(contextGraphId, descriptor);
    await this.#finishFinalizedTwinCleanup(target, contextGraphId, descriptor, outcome);
    await this.#registerSyncedSubGraphs(target, descriptor.metadataQuads);
    return true;
  }

  /** After writing, even a partial retired head must stay out of bulk metadata. */
  async #retireFinalizedTwinAfterWrite(
    target: PublicSwmTargetV1,
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<'suppress-metadata' | 'preserve'> {
    const outcome = await this.#reconcileFinalizedTwin(target, contextGraphId, descriptor);
    if (outcome !== 'retired' && outcome !== 'already-retired-finalized' && outcome !== 'retired-head-residue') {
      this.finalizedTwins.forget(contextGraphId, descriptor);
      return 'preserve';
    }
    this.finalizedTwins.remember(contextGraphId, descriptor);
    await this.#finishFinalizedTwinCleanup(target, contextGraphId, descriptor, outcome);
    return 'suppress-metadata';
  }

  /** Return proof/retirement facts; callers own memo and metadata policy. */
  #reconcileFinalizedTwin(
    target: PublicSwmTargetV1,
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ): Promise<FinalizedSwmTwinReconciliationOutcome> {
    return reconcileFinalizedSwmTwinFromDescriptor({
      store: this.#ports.store,
      writeLocks: this.#ports.writeLocks,
      contextGraphId,
      descriptor,
      retire: (candidate) => this.#ports.retireFinalizedSwmTwin(candidate, target.ctx),
    });
  }

  async #finishFinalizedTwinCleanup(
    target: PublicSwmTargetV1,
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
    retirement: FinalizedSwmTwinReconciliationOutcome,
  ): Promise<void> {
    // The twin's graph and head are already gone at this point. The rest of
    // its cleanup is separate: if its failure escaped, the caller would treat
    // the whole reconciliation as deferred, skip the metadata suppression, and
    // its bulk append would write the retired head and operation rows back
    // without their graph. Its owner does only what is still owed, so every
    // proof asks again, and a marker left behind, the conservative state (the
    // graph stays reported as incomplete), has a way back in each such round.
    await this.#retireLegacyMarker(target, contextGraphId, descriptor);
    if (retirement === 'retired') {
      this.#ports.invalidateListContextGraphsCache();
      this.#ports.logInfo(
        target.ctx,
        `Retired byte-identical SWM twin after SWM recovery found finalized VM for ${descriptor.kaUal}`,
      );
    }
  }

  /**
   * Register the named sub-graphs whose shared memory this round just stored
   * (see `synced-sub-graph-registration.ts`). The rows stay stored when that
   * fails, and the next rows stored for the sub-graph try again: a round stores
   * the verified metadata of each asset it finds already present, too.
   */
  async #registerSyncedSubGraphs(target: PublicSwmTargetV1, stored: readonly Quad[]): Promise<void> {
    try {
      for (const subGraphName of await this.#syncedSubGraphs.registerFor(target.contextGraphId, stored)) {
        this.#ports.invalidateListContextGraphsCache();
        this.#ports.logInfo(
          target.ctx,
          `Auto-registered sub-graph "${subGraphName}" in context graph "${target.contextGraphId}" from SWM sync`,
        );
      }
    } catch (cause) {
      this.#ports.logWarn(
        target.ctx,
        `SWM sync stored shared memory of a sub-graph of "${target.contextGraphId}" it could not register: `
          + `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
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
}

/**
 * Stable typed composition with isolated session caches, shared manifest
 * progress and the node's shared memo of retired finalized twins.
 */
export class SwmTargetExecutorSessionFactoryV1 {
  readonly #ports: SwmTargetExecutorPortsV1;
  readonly #privateSnapshotWalks: PrivateSwmSnapshotWalkRegistry;
  readonly #finalizedTwins: FinalizedSwmTwinMemoV1;

  constructor(
    ports: SwmTargetExecutorPortsV1,
    privateSnapshotWalks = new PrivateSwmSnapshotWalkRegistry(),
    finalizedTwins = new FinalizedSwmTwinMemoV1(),
  ) {
    this.#ports = ports;
    this.#privateSnapshotWalks = privateSnapshotWalks;
    this.#finalizedTwins = finalizedTwins;
  }

  createSession(): SwmTargetExecutorV1 {
    return new SwmTargetExecutorV1(this.#ports, this.#privateSnapshotWalks, this.#finalizedTwins);
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

/** True when `contextGraphUri` is declared as a context graph of its own on this node. */
export async function isKnownContextGraphUri(
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
