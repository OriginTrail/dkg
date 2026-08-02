// SPDX-License-Identifier: Apache-2.0

import {
  DKGEvent,
  Logger,
  MemoryLayer,
  assertSafeIri,
  contextGraphDataUri,
  createGraphKnowledgeAssetScope,
  createOperationContext,
  type EventBus,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  StoreSchedulerBusyError,
  asGraphWriteGenSource,
  tryReplaceGraphAndSubjectAtomically,
  type GraphWriteGenSource,
  type QueryOptions,
  type StorePressureSnapshot,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  KnowledgeAssetWorkspaceHeadCorruptError,
  resolveKnowledgeAssetWorkspaceHead,
  sameKnowledgeAssetWorkspaceHead,
  swmKaWriteLockKey,
  withKeyedLocks,
  workspaceKnowledgeAssetHeadSubject,
  type KnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import {
  FINALIZED_SWM_CLEANUP_HEAD_FINGERPRINT_PREDICATE,
  FINALIZED_SWM_CLEANUP_MARKED_AT_PREDICATE,
  FINALIZED_SWM_CLEANUP_ROOT_PREDICATE,
  FINALIZED_SWM_CLEANUP_TASK_TYPE,
} from './dkg-agent-constants.js';
import { finalizedSwmCleanupHeadFingerprint } from './finalized-swm-cleanup-marker.js';
import type { FinalizedSwmCleanupSweepResult } from './finalized-swm-cleanup-worker.js';
import { verifyExactGraphScopedLayer } from './graph-scoped-layer-verification.js';

function stripOptionalLiteral(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const typedLiteral = value.match(/^"([\s\S]*)"\^\^<[^>]+>$/);
  if (typedLiteral) return typedLiteral[1];
  const plainLiteral = value.match(/^"([\s\S]*)"$/);
  return plainLiteral?.[1] ?? value;
}

function hasActiveStorePressure(snapshot: StorePressureSnapshot | undefined): boolean {
  if (!snapshot) return false;
  return [
    snapshot.ackInflight,
    snapshot.healthInflight ?? 0,
    snapshot.normalInflight,
    snapshot.backgroundInflight,
    snapshot.ackQueued,
    snapshot.healthQueued ?? 0,
    snapshot.normalQueued,
    snapshot.backgroundQueued,
  ].some((count) => count > 0);
}

export interface FinalizedSwmCleanupServiceOptions {
  store: TripleStore;
  writeLocks?: Map<string, Promise<void>>;
  eventBus?: EventBus;
  /**
   * Both enumerations are handed the sweep's background query options, so an
   * implementation that reaches the store keeps discovery off the foreground
   * lane: a cold or past-revalidation graph-set index resolves its refresh
   * priority from the caller (see GraphSetIndexStore.refreshPriority), where an
   * absent priority defaults to `normal`. An implementation backed by a shared
   * cache may ignore them — see the production wiring for why.
   */
  listContextGraphIds: (options: QueryOptions) => Promise<string[]>;
  listSharedMemoryMetaGraphs: (contextGraphId: string, options: QueryOptions) => Promise<string[]>;
  now?: () => number;
  maxCandidatesPerSweep?: number;
  wallClockBudgetMs?: number;
}

/**
 * The sole owner of finalized-SWM discovery, payload verification and deletion.
 * Finalization and synchronization may create/re-arm durable tasks, but neither
 * path calls this service or waits for its store work.
 */
export class FinalizedSwmCleanupService {
  private readonly store: TripleStore;
  private readonly writeLocks: Map<string, Promise<void>> | undefined;
  private readonly eventBus: EventBus | undefined;
  private readonly listContextGraphIds: (options: QueryOptions) => Promise<string[]>;
  private readonly listSharedMemoryMetaGraphs: (
    contextGraphId: string,
    options: QueryOptions,
  ) => Promise<string[]>;
  private readonly now: () => number;
  private readonly maxCandidatesPerSweep: number;
  private readonly wallClockBudgetMs: number;
  private readonly graphWriteGen: GraphWriteGenSource | null;
  private readonly log = new Logger('FinalizedSwmCleanupService');
  /** Whole-node totals from the last rotation that closed; never a partial sum. */
  private lastKnownBacklogDepth = 0;
  private lastKnownOldestMarkerAt: number | null = null;
  /**
   * Context graphs still owed a visit in the rotation currently in progress, or
   * `null` when none is. Entry 0 doubles as the resumption cursor: a sweep that
   * yields on pressure or wall clock persists its remaining tail here, so the
   * next sweep continues instead of re-walking the same prefix forever and
   * never reaching markers in later context graphs.
   */
  private rotationPending: string[] | null = null;
  private rotationBacklogDepth = 0;
  private rotationOldestMarkerAt: number | null = null;
  /**
   * Head of the rotation the previous sweep started from, and how many
   * consecutive sweeps have started from it without completing it. A context
   * graph whose enumeration cannot finish inside one slice would otherwise hold
   * the cursor forever and starve every context graph behind it — the same
   * "later context graphs are never reached" failure the cursor exists to fix.
   */
  private rotationHeadContextGraphId: string | null = null;
  private rotationHeadStalledSweeps = 0;

  constructor(options: FinalizedSwmCleanupServiceOptions) {
    this.store = options.store;
    this.writeLocks = options.writeLocks;
    this.eventBus = options.eventBus;
    this.listContextGraphIds = options.listContextGraphIds;
    this.listSharedMemoryMetaGraphs = options.listSharedMemoryMetaGraphs;
    this.now = options.now ?? Date.now;
    this.maxCandidatesPerSweep = Math.min(
      16,
      Math.max(1, Math.floor(options.maxCandidatesPerSweep ?? 4)),
    );
    this.wallClockBudgetMs = Math.max(1, Math.floor(options.wallClockBudgetMs ?? 10_000));
    this.graphWriteGen = asGraphWriteGenSource(options.store);
  }

  /** Run one bounded, idle-only maintenance slice. */
  async runSweep(): Promise<FinalizedSwmCleanupSweepResult> {
    // A deferred sweep republishes the last rotation's whole-node totals rather
    // than a partial sum, and marks them stale so the SLO surface can tell
    // "deferred under load" apart from "nothing to do" — the distinction an
    // operator needs while only `pressureSkips` is moving.
    const deferredResult = (
      deletedItems: number,
      reason: 'pressure' | 'budget',
    ): FinalizedSwmCleanupSweepResult => ({
      backlogDepth: this.lastKnownBacklogDepth,
      oldestMarkerAt: this.lastKnownOldestMarkerAt,
      deletedItems,
      pressureSkipped: reason === 'pressure',
      ...(reason === 'budget' ? { budgetExhausted: true } : {}),
      stale: true,
    });
    const underPressure = () => hasActiveStorePressure(this.store.getPressureSnapshot?.());
    if (underPressure()) return deferredResult(0, 'pressure');

    const deadline = this.now() + this.wallClockBudgetMs;
    const deadlineSignal = AbortSignal.timeout(this.wallClockBudgetMs);
    const discoveryOptions: QueryOptions = {
      priority: 'background',
      source: 'agent.finalizedSwmCleanup.discover',
      signal: deadlineSignal,
    };
    let remaining = this.maxCandidatesPerSweep;
    let deletedItems = 0;

    // Pressure is checked before every discovery boundary, including the first
    // potentially expensive context-graph enumeration.
    if (underPressure()) return deferredResult(0, 'pressure');
    let contextGraphIds: string[];
    try {
      contextGraphIds = await this.listContextGraphIds(discoveryOptions);
    } catch (error) {
      if (deadlineSignal.aborted) return deferredResult(0, 'budget');
      throw error;
    }
    const pending = this.resumeRotation(contextGraphIds);

    for (let index = 0; index < pending.length; index += 1) {
      const contextGraphId = pending[index]!;
      // Yielding keeps the unvisited tail, so the cursor never advances past a
      // context graph this sweep did not finish measuring.
      const yieldRotation = (reason: 'pressure' | 'budget'): FinalizedSwmCleanupSweepResult => {
        this.rotationPending = pending.slice(index);
        return deferredResult(deletedItems, reason);
      };
      if (underPressure()) return yieldRotation('pressure');
      if (this.now() >= deadline) return yieldRotation('budget');
      let metaGraphs: string[];
      try {
        metaGraphs = await this.listSharedMemoryMetaGraphs(contextGraphId, discoveryOptions);
      } catch (error) {
        if (deadlineSignal.aborted) return yieldRotation('budget');
        throw error;
      }
      // A context graph contributes to the rotation total only once every one of
      // its meta graphs has been measured. Yielding part-way discards the partial
      // sum, so the re-measure on resume cannot double-count it.
      let contextGraphBacklogDepth = 0;
      let contextGraphOldestMarkerAt: number | null = null;
      for (const swmMetaGraph of metaGraphs) {
        if (underPressure()) return yieldRotation('pressure');
        if (this.now() >= deadline) return yieldRotation('budget');
        if (remaining > 0) {
          let cleanup: { deletedItems: number; examinedCandidates: number };
          try {
            cleanup = await this.cleanupMetaGraph({
              contextGraphId,
              swmMetaGraph,
              maxCandidates: remaining,
              signal: deadlineSignal,
            });
          } catch (error) {
            if (deadlineSignal.aborted) return yieldRotation('budget');
            throw error;
          }
          deletedItems += cleanup.deletedItems;
          remaining -= cleanup.examinedCandidates;
        }
        if (underPressure()) return yieldRotation('pressure');
        if (this.now() >= deadline) return yieldRotation('budget');
        // Deliberately not gated on `remaining`: that budget bounds deletion
        // work (head resolution, VM/SWM verification, lock, atomic replace),
        // while this is one cheap background aggregate and the sole source of
        // the backlog metric. Capping the metric with the deletion budget would
        // make it under-report exactly when the backlog is deepest.
        let backlog: { depth: number; oldestMarkerAt: number | null };
        try {
          backlog = await this.inspectBacklog(swmMetaGraph, deadlineSignal);
        } catch (error) {
          if (deadlineSignal.aborted) return yieldRotation('budget');
          throw error;
        }
        contextGraphBacklogDepth += backlog.depth;
        if (
          backlog.oldestMarkerAt !== null
          && (
            contextGraphOldestMarkerAt === null
            || backlog.oldestMarkerAt < contextGraphOldestMarkerAt
          )
        ) {
          contextGraphOldestMarkerAt = backlog.oldestMarkerAt;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.rotationBacklogDepth += contextGraphBacklogDepth;
      if (
        contextGraphOldestMarkerAt !== null
        && (
          this.rotationOldestMarkerAt === null
          || contextGraphOldestMarkerAt < this.rotationOldestMarkerAt
        )
      ) {
        this.rotationOldestMarkerAt = contextGraphOldestMarkerAt;
      }
    }

    // The rotation closed: every context graph was measured exactly once, so the
    // accumulated sums are a whole-node total again.
    this.lastKnownBacklogDepth = this.rotationBacklogDepth;
    this.lastKnownOldestMarkerAt = this.rotationOldestMarkerAt;
    this.rotationPending = null;
    this.rotationBacklogDepth = 0;
    this.rotationOldestMarkerAt = null;
    this.rotationHeadContextGraphId = null;
    this.rotationHeadStalledSweeps = 0;
    return {
      backlogDepth: this.lastKnownBacklogDepth,
      oldestMarkerAt: this.lastKnownOldestMarkerAt,
      deletedItems,
      pressureSkipped: false,
      stale: false,
    };
  }

  /**
   * Continue the rotation in progress, dropping context graphs that disappeared
   * since it started, or open a fresh one. Context graphs created mid-rotation
   * join the next rotation rather than this one; `stale` reports the lag.
   *
   * Guarantees forward progress: a head that three consecutive sweeps could not
   * finish moves to the back of the rotation so the context graphs behind it are
   * still served. It keeps its place in the rotation and is retried there.
   */
  private resumeRotation(contextGraphIds: string[]): string[] {
    let pending: string[];
    if (this.rotationPending === null) {
      this.rotationBacklogDepth = 0;
      this.rotationOldestMarkerAt = null;
      pending = [...contextGraphIds];
    } else {
      const known = new Set(contextGraphIds);
      pending = this.rotationPending.filter((contextGraphId) => known.has(contextGraphId));
    }

    const head = pending[0] ?? null;
    if (head !== null && head === this.rotationHeadContextGraphId) {
      this.rotationHeadStalledSweeps += 1;
    } else {
      this.rotationHeadContextGraphId = head;
      this.rotationHeadStalledSweeps = 0;
    }
    if (this.rotationHeadStalledSweeps >= 2 && pending.length > 1) {
      this.log.warn(
        createOperationContext('system'),
        `Deferring context graph ${head} in finalized-SWM cleanup rotation; `
          + `${this.rotationHeadStalledSweeps + 1} consecutive slices could not finish it`,
      );
      pending = [...pending.slice(1), pending[0]!];
      this.rotationHeadContextGraphId = pending[0] ?? null;
      this.rotationHeadStalledSweeps = 0;
    }
    return pending;
  }

  /** Narrow test seam for one already-known SWM metadata graph. */
  async cleanupKnownMetaGraph(input: {
    contextGraphId: string;
    swmMetaGraph: string;
    maxCandidates?: number;
    signal?: AbortSignal;
  }): Promise<number> {
    return (await this.cleanupMetaGraph(input)).deletedItems;
  }

  private async inspectBacklog(
    swmMetaGraph: string,
    signal?: AbortSignal,
  ): Promise<{ depth: number; oldestMarkerAt: number | null }> {
    if (hasActiveStorePressure(this.store.getPressureSnapshot?.())) {
      throw new StoreSchedulerBusyError(
        'queue_full',
        'background',
        'agent.finalizedSwmCleanup.backlog',
      );
    }
    const result = await this.store.query(
      `SELECT (COUNT(DISTINCT ?task) AS ?count) (MIN(?markedAt) AS ?oldest) WHERE {
        GRAPH <${assertSafeIri(swmMetaGraph)}> {
          ?task <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${FINALIZED_SWM_CLEANUP_TASK_TYPE}> ;
            <${FINALIZED_SWM_CLEANUP_ROOT_PREDICATE}> ?root .
          OPTIONAL { ?task <${FINALIZED_SWM_CLEANUP_MARKED_AT_PREDICATE}> ?markedAt }
        }
      }`,
      {
        priority: 'background',
        source: 'agent.finalizedSwmCleanup.backlog',
        signal,
      },
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) {
      return { depth: 0, oldestMarkerAt: null };
    }
    const depth = Number.parseInt(stripOptionalLiteral(result.bindings[0]?.['count']) ?? '0', 10);
    const oldestValue = stripOptionalLiteral(result.bindings[0]?.['oldest']);
    const oldestMarkerAt = oldestValue ? Date.parse(oldestValue) : Number.NaN;
    return {
      depth: Number.isSafeInteger(depth) && depth > 0 ? depth : 0,
      oldestMarkerAt: Number.isFinite(oldestMarkerAt) ? oldestMarkerAt : null,
    };
  }

  private async cleanupMetaGraph(input: {
    contextGraphId: string;
    swmMetaGraph: string;
    maxCandidates?: number;
    signal?: AbortSignal;
  }): Promise<{ deletedItems: number; examinedCandidates: number }> {
    if (!this.writeLocks || hasActiveStorePressure(this.store.getPressureSnapshot?.())) {
      return { deletedItems: 0, examinedCandidates: 0 };
    }
    const limit = Math.min(16, Math.max(1, Math.floor(input.maxCandidates ?? 4)));
    const queryOptions: QueryOptions = {
      priority: 'background',
      source: 'agent.finalizedSwmCleanup.discover',
      signal: input.signal,
    };
    const result = await this.store.query(
      `SELECT DISTINCT ?task ?ual ?version ?root ?shareId ?assertionGraph ?headFingerprint ?subGraphName WHERE {
        GRAPH <${assertSafeIri(input.swmMetaGraph)}> {
          ?task <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${FINALIZED_SWM_CLEANUP_TASK_TYPE}> ;
            <${FINALIZED_SWM_CLEANUP_ROOT_PREDICATE}> ?root ;
            <${FINALIZED_SWM_CLEANUP_HEAD_FINGERPRINT_PREDICATE}> ?headFingerprint ;
            <http://dkg.io/ontology/kaUal> ?ual ;
            <http://dkg.io/ontology/assertionVersion> ?version ;
            <http://dkg.io/ontology/shareOperationId> ?shareId ;
            <http://dkg.io/ontology/assertionGraph> ?assertionGraph .
          OPTIONAL { ?task <http://dkg.io/ontology/subGraphName> ?subGraphName }
        }
      } ORDER BY ?task LIMIT ${limit}`,
      queryOptions,
    );
    if (result.type !== 'bindings') return { deletedItems: 0, examinedCandidates: 0 };

    let cleared = 0;
    for (const row of result.bindings) {
      if (hasActiveStorePressure(this.store.getPressureSnapshot?.())) break;
      const taskSubject = row['task'];
      const ual = row['ual'];
      const rawVersion = stripOptionalLiteral(row['version']);
      const rawRoot = stripOptionalLiteral(row['root']);
      const assertionGraph = row['assertionGraph'];
      const expectedHeadFingerprint = stripOptionalLiteral(row['headFingerprint']);
      const shareOperationId = stripOptionalLiteral(row['shareId']);
      const subGraphName = stripOptionalLiteral(row['subGraphName']);
      if (
        !taskSubject
        || !taskSubject.startsWith('urn:dkg:finalized-swm-cleanup:')
        || !ual
        || !rawVersion
        || !/^\d+$/.test(rawVersion)
        || !rawRoot
        || !assertionGraph
        || !expectedHeadFingerprint
        || !shareOperationId
      ) continue;

      let scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
      let expectedMerkleRoot: Uint8Array;
      try {
        scope = createGraphKnowledgeAssetScope(ual, BigInt(rawVersion));
        expectedMerkleRoot = ethers.getBytes(rawRoot);
      } catch {
        continue;
      }
      if (scope.ual !== ual || expectedMerkleRoot.length !== 32) continue;

      let expectedHead: KnowledgeAssetWorkspaceHead | undefined;
      try {
        expectedHead = await resolveKnowledgeAssetWorkspaceHead({
          store: this.store,
          graphManager: new GraphManager(this.store),
          contextGraphId: input.contextGraphId,
          kaUal: scope.ual,
          subGraphName,
          queryOptions,
        });
      } catch (error) {
        if (error instanceof StoreSchedulerBusyError) break;
        continue;
      }
      if (
        !expectedHead
        || expectedHead.assertionVersion !== scope.assertionVersion
        || expectedHead.shareOperationId !== shareOperationId
        || expectedHead.assertionGraph !== assertionGraph
      ) {
        await this.retireStaleTask({
          contextGraphId: input.contextGraphId,
          swmMetaGraph: input.swmMetaGraph,
          taskSubject,
          scope,
          assertionGraph,
          shareOperationId,
          subGraphName,
          queryOptions,
          expectedHeadWasAbsent: !expectedHead,
        });
        continue;
      }
      let privateMerkleRoot: Uint8Array | undefined;
      try {
        privateMerkleRoot = expectedHead.privateMerkleRoot
          ? ethers.getBytes(expectedHead.privateMerkleRoot)
          : undefined;
      } catch {
        continue;
      }
      const outcome = await this.clearIfStillExact({
        contextGraphId: input.contextGraphId,
        scope,
        taskSubject,
        expectedHeadFingerprint,
        expectedHead,
        expectedMerkleRoot,
        privateMerkleRoot,
        subGraphName,
        signal: input.signal,
      });
      if (outcome === 'cleared') cleared += 1;
    }
    return { deletedItems: cleared, examinedCandidates: result.bindings.length };
  }

  private async retireStaleTask(input: {
    contextGraphId: string;
    swmMetaGraph: string;
    taskSubject: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    assertionGraph: string;
    shareOperationId: string;
    subGraphName?: string;
    queryOptions: QueryOptions;
    expectedHeadWasAbsent: boolean;
  }): Promise<void> {
    if (!this.writeLocks) return;
    const writePrefix = `${contextGraphDataUri(input.contextGraphId)}/`;
    const preflightWriteGen = this.graphWriteGen?.getWriteGen(writePrefix);
    let headlessPayloadAbsent = false;
    if (input.expectedHeadWasAbsent) {
      if (preflightWriteGen === undefined) return;
      const payloadPresent = await this.store.query(
        `ASK { GRAPH <${assertSafeIri(input.assertionGraph)}> { ?s ?p ?o } }`,
        {
          ...input.queryOptions,
          source: 'agent.finalizedSwmCleanup.checkHeadlessPayload',
        },
      );
      if (payloadPresent.type !== 'boolean' || payloadPresent.value) return;
      headlessPayloadAbsent = true;
    }
    const lockKey = swmKaWriteLockKey(
      input.contextGraphId,
      input.subGraphName,
      input.scope.ual,
    );
    await withKeyedLocks(this.writeLocks, [lockKey], async () => {
      if (
        preflightWriteGen !== undefined
        && this.graphWriteGen?.getWriteGen(writePrefix) !== preflightWriteGen
      ) return;
      let currentHead: KnowledgeAssetWorkspaceHead | undefined;
      try {
        currentHead = await resolveKnowledgeAssetWorkspaceHead({
          store: this.store,
          graphManager: new GraphManager(this.store),
          contextGraphId: input.contextGraphId,
          kaUal: input.scope.ual,
          subGraphName: input.subGraphName,
          queryOptions: input.queryOptions,
        });
      } catch (error) {
        if (error instanceof KnowledgeAssetWorkspaceHeadCorruptError) return;
        throw error;
      }
      if (
        currentHead
        && currentHead.assertionVersion === input.scope.assertionVersion
        && currentHead.shareOperationId === input.shareOperationId
        && currentHead.assertionGraph === input.assertionGraph
      ) return;
      if (!currentHead && !headlessPayloadAbsent) return;

      await this.store.deleteByPattern(
        { graph: input.swmMetaGraph, subject: input.taskSubject },
        {
          ...input.queryOptions,
          source: currentHead
            ? 'agent.finalizedSwmCleanup.retireSupersededTask'
            : 'agent.finalizedSwmCleanup.retireAbsentTask',
        },
      );
    });
  }

  private async clearIfStillExact(input: {
    contextGraphId: string;
    scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
    taskSubject: string;
    expectedHeadFingerprint: string;
    expectedHead: KnowledgeAssetWorkspaceHead;
    expectedMerkleRoot: Uint8Array;
    privateMerkleRoot?: Uint8Array;
    subGraphName?: string;
    signal?: AbortSignal;
  }): Promise<'cleared' | 'absent' | 'preserved'> {
    if (!this.writeLocks) return 'preserved';
    const graphManager = new GraphManager(this.store);
    const metaGraph = graphManager.sharedMemoryMetaUri(input.contextGraphId, input.subGraphName);
    const headSubject = workspaceKnowledgeAssetHeadSubject(input.scope.ual);
    const cleanupRootObject = JSON.stringify(
      ethers.hexlify(input.expectedMerkleRoot).toLowerCase(),
    );
    const verificationQueryOptions: QueryOptions = {
      priority: 'background',
      source: 'agent.finalizedSwmCleanup',
      signal: input.signal,
    };
    const commitQueryOptions: QueryOptions = {
      priority: 'background',
      source: 'agent.finalizedSwmCleanup',
    };
    if (
      finalizedSwmCleanupHeadFingerprint(input.expectedHead)
      !== input.expectedHeadFingerprint
    ) return 'preserved';

    const writePrefix = `${contextGraphDataUri(input.contextGraphId)}/`;
    const preflightWriteGen = this.graphWriteGen?.getWriteGen(writePrefix);
    if (hasActiveStorePressure(this.store.getPressureSnapshot?.())) return 'preserved';
    const vmVerification = await verifyExactGraphScopedLayer({
      store: this.store,
      contextGraphId: input.contextGraphId,
      scope: input.scope,
      layer: MemoryLayer.VerifiableMemory,
      publicTripleCount: input.expectedHead.publicTripleCount,
      privateMerkleRoot: input.privateMerkleRoot,
      expectedMerkleRoot: input.expectedMerkleRoot,
      expectedPublicQuadsDigest: input.expectedHead.publicQuadsDigest,
      subGraphName: input.subGraphName,
      queryOptions: verificationQueryOptions,
    });
    if (vmVerification.status !== 'verified') {
      this.log.warn(
        createOperationContext('system'),
        `Preserving ${input.scope.ual}; VM no longer matches cleanup task (${vmVerification.status})`,
      );
      return 'preserved';
    }
    if (hasActiveStorePressure(this.store.getPressureSnapshot?.())) return 'preserved';
    const swmVerification = await verifyExactGraphScopedLayer({
      store: this.store,
      contextGraphId: input.contextGraphId,
      scope: input.scope,
      layer: MemoryLayer.SharedWorkingMemory,
      publicTripleCount: input.expectedHead.publicTripleCount,
      privateMerkleRoot: input.privateMerkleRoot,
      expectedMerkleRoot: input.expectedMerkleRoot,
      expectedPublicQuadsDigest: input.expectedHead.publicQuadsDigest,
      subGraphName: input.subGraphName,
      queryOptions: verificationQueryOptions,
    });
    if (
      swmVerification.status !== 'verified'
      && !(swmVerification.status === 'count-mismatch' && swmVerification.actualCount === 0)
    ) {
      this.log.warn(
        createOperationContext('system'),
        `Preserving ${input.scope.ual}; SWM no longer matches cleanup task (${swmVerification.status})`,
      );
      return 'preserved';
    }
    const verifiedWriteGen = this.graphWriteGen?.getWriteGen(writePrefix);
    if (preflightWriteGen !== undefined && verifiedWriteGen !== preflightWriteGen) {
      return 'preserved';
    }

    const lockKey = swmKaWriteLockKey(
      input.contextGraphId,
      input.subGraphName,
      input.scope.ual,
    );
    const outcome = await withKeyedLocks(this.writeLocks, [lockKey], async () => {
      if (
        verifiedWriteGen !== undefined
        && this.graphWriteGen?.getWriteGen(writePrefix) !== verifiedWriteGen
      ) return 'preserved' as const;

      let currentHead: KnowledgeAssetWorkspaceHead | undefined;
      try {
        currentHead = await resolveKnowledgeAssetWorkspaceHead({
          store: this.store,
          graphManager,
          contextGraphId: input.contextGraphId,
          kaUal: input.scope.ual,
          subGraphName: input.subGraphName,
          queryOptions: commitQueryOptions,
        });
      } catch (error) {
        if (!(error instanceof KnowledgeAssetWorkspaceHeadCorruptError)) throw error;
        return 'preserved' as const;
      }
      if (!currentHead) {
        if (swmVerification.status === 'count-mismatch' && swmVerification.actualCount === 0) {
          await this.store.deleteByPattern(
            { graph: metaGraph, subject: input.taskSubject },
            { ...commitQueryOptions, source: 'agent.finalizedSwmCleanup.retireAbsentTask' },
          );
          return 'absent' as const;
        }
        return 'preserved' as const;
      }
      if (
        !sameKnowledgeAssetWorkspaceHead(currentHead, input.expectedHead)
        || finalizedSwmCleanupHeadFingerprint(currentHead) !== input.expectedHeadFingerprint
      ) return 'preserved' as const;

      const marker = await this.store.query(
        `ASK { GRAPH <${assertSafeIri(metaGraph)}> { `
          + `<${assertSafeIri(input.taskSubject)}> <${FINALIZED_SWM_CLEANUP_ROOT_PREDICATE}> `
          + `${cleanupRootObject} ; <${FINALIZED_SWM_CLEANUP_HEAD_FINGERPRINT_PREDICATE}> `
          + `${JSON.stringify(input.expectedHeadFingerprint)} } }`,
        commitQueryOptions,
      );
      if (marker.type !== 'boolean' || !marker.value) return 'preserved' as const;

      const replaced = await tryReplaceGraphAndSubjectAtomically(
        this.store,
        swmVerification.graphUri,
        [],
        metaGraph,
        headSubject,
        [],
        commitQueryOptions,
      );
      if (!replaced) {
        throw Object.assign(
          new Error('Finalized SWM cleanup requires atomic graph-and-head replacement support'),
          { code: 'SWM_ATOMIC_CLEANUP_UNSUPPORTED' },
        );
      }
      await this.store.deleteByPattern(
        { graph: metaGraph, subject: input.taskSubject },
        { ...commitQueryOptions, source: 'agent.finalizedSwmCleanup.retireTask' },
      );
      return swmVerification.status === 'verified' ? 'cleared' as const : 'absent' as const;
    });

    if (outcome === 'cleared') {
      this.eventBus?.emit(DKGEvent.MEMORY_GRAPH_CHANGED, {
        contextGraphId: input.contextGraphId,
        layers: ['swm'],
        subGraphName: input.subGraphName,
        operation: 'shared_working_memory_finalized',
        source: 'background-cleanup',
        counts: { triples: input.expectedHead.publicTripleCount },
      });
      this.log.info(
        createOperationContext('system'),
        `Cleared finalized graph-scoped SWM assertion ${input.scope.ual}`,
      );
    }
    return outcome;
  }
}
