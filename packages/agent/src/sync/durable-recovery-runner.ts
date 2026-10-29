import type { GraphOwnedRecoveryInput } from './requester/graph-owned-recovery.js';
import { recoveryActionDiagnostics, exactRecoveryActionOutcome, type DurableRecoveryDiagnostics, type ExactRecoveryActionOutcome } from './durable-recovery-action.js';
import { accountDurableRecoveryAction, type DurableRecoveryAccounting, type MutableDurableRecoveryPeerHealth } from './durable-recovery-peer-health.js';
import type { DurableRecoveryRoundOutcome } from './durable-recovery-round.js';
import { HeldAssetsConfirmationRun } from './requester/durable-data-holdings.js';
import type { DurableSyncResult } from '../dkg-agent-types.js';
import {
  createDurableSyncAccumulator,
  createFailedPeerDurableSyncResult,
  createIncompleteDurableSyncResult,
  recordDurableSyncDiagnostics,
} from './durable-progress.js';
import {
  getSyncCheckpointKey,
  type DurableManifestDigest,
  type SyncCheckpointStore,
} from './checkpoint/state.js';
import {
  DurableRecoveryCoordinator,
  classifyDurableRecoverySlice,
  rankDurableRecoveryPeers,
  selectCanonicalDurableRecoveryManifest,
  type DurableRecoveryContinuationOutcome,
  type DurableRecoveryOwnerControl,
  type DurableRecoveryPeerCandidate,
  type DurableRecoveryPeerHealth,
} from './durable-recovery-coordinator.js';
import { deleteSyncPageCheckpoint } from './requester/page-fetch.js';
import type { DurableMetaContinuation } from './requester/durable-sync.js';
import { DurableGraphResumePolicy } from './durable-recovery-boundary-seed.js';
import { DurableRecoveryFetchPolicy, type DurableRecoveryAction } from './durable-recovery-fetch-policy.js';
import { DurableRecoveryTurns, type DurableRecoveryRetry } from './durable-recovery-turns.js';

/**
 * `deferred`: a slice found no free local sync slot. The round ended there, tried
 * no other peer and charged no peer; the runner retries the graph in its turn.
 */
export type DurableRecoveryExecutionOutcome = DurableRecoveryContinuationOutcome | 'deferred';

export interface DurableRecoveryExecution {
  readonly outcome: DurableRecoveryExecutionOutcome;
  readonly result: DurableSyncResult;
  readonly peerResults: readonly DurableRecoveryPeerExecution[];
  readonly slices: number;
  readonly peerId?: string;
  readonly manifestDigest?: DurableManifestDigest;
  readonly safeOffset: number;
}

export interface DurableRecoveryPeerExecution {
  readonly peerId: string;
  readonly result: DurableSyncResult;
}

export interface DurableRecoveryRunOptions {
  readonly candidatePeerIds?: readonly string[];
  readonly restrictToCandidatePeerIds?: boolean;
  readonly candidatesAreSyncCapable?: boolean;
}

export interface DurableRecoveryRunnerDependencies {
  readonly checkpointStore: SyncCheckpointStore;
  isRunning(): boolean;
  resolvePreferredPeerId(): Promise<string | undefined>;
  connectRequestedPeer(peerId: string): Promise<void>;
  primeConnections(): Promise<void>;
  liveConnectionPeerIds(): string[];
  admitPeer(peerId: string): Promise<boolean>;
  isPrivateContextGraph(): Promise<boolean>;
  orderPeerIds(
    peerIds: readonly string[],
    preferredPeerId: string | undefined,
    privateOnly: boolean,
  ): string[];
  isSyncCapable(peerId: string): Promise<boolean>;
  executeSlice(
    peerId: string,
    recovery: GraphOwnedRecoveryInput,
  ): Promise<DurableRecoveryRoundOutcome>;
  /**
   * Fetch a selection with one exact request and report its disposition separately
   * from diagnostics. Without it, rounds pull the full graph.
   */
  executeExactSlice?(
    peerId: string,
    assetUals: readonly string[],
  ): Promise<ExactRecoveryActionOutcome>;
  logDebug(message: string): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
  /** The node's current stop signal: an owner waiting for its next turn stops waiting when it fires. */
  stopSignal?(): AbortSignal | undefined;
  /** Whether the node's sync admission would take a slice of this graph now. A read: nothing is claimed. */
  admissionAvailable?(): boolean;
  /** Whether the node still recovers this graph (its sync scope). The runner retries no graph that left it. */
  inRecoveryScope?(): boolean;
}

const PROGRESS_COUNTERS = [
  'insertedTriples',
  'fetchedMetaTriples',
  'fetchedDataTriples',
  'insertedMetaTriples',
  'insertedDataTriples',
  'bytesReceived',
  'resumedPhases',
  'completedPhases',
  'checkpointAdvances',
  'emptyResponses',
  'metaOnlyResponses',
  'verifiedPrivateOnlyResponses',
  'verifiedHeldAssets',
] as const satisfies readonly (keyof DurableSyncResult)[];

type ProgressTotals = Record<typeof PROGRESS_COUNTERS[number], number>;

function createProgressTotals(): ProgressTotals {
  return Object.fromEntries(PROGRESS_COUNTERS.map((key) => [key, 0])) as ProgressTotals;
}

function accumulateProgress(totals: ProgressTotals, result: DurableRecoveryDiagnostics): void {
  for (const key of PROGRESS_COUNTERS) totals[key] += result[key] ?? 0;
}

function withProgressTotals(
  result: DurableRecoveryDiagnostics,
  totals: ProgressTotals,
): DurableRecoveryDiagnostics {
  return { ...result, ...totals };
}

type MutablePeerExecution = {
  diagnostics: DurableRecoveryDiagnostics;
  progressTotals: ProgressTotals;
};

/**
 * The answer for a graph that waits for a sync slot: no slice ran. A caller that
 * reads results per peer finds the deferral on the first peer it offered.
 */
function deferredExecution(options: DurableRecoveryRunOptions | undefined): DurableRecoveryExecution {
  const result = { ...createIncompleteDurableSyncResult(), deferredBackpressure: 1 };
  const peerId = options?.candidatePeerIds?.[0];
  return { outcome: 'deferred', result, peerResults: peerId === undefined ? [] : [{ peerId, result }], slices: 0, safeOffset: 0 };
}

/** Owns graph-level recovery single-flight, peer health, ranking, continuation and turns at the sync slots. */
export class DurableRecoveryRunner {
  private readonly coordinator = new DurableRecoveryCoordinator<DurableRecoveryExecution>();

  private readonly healthByGraphPeer = new Map<string, MutableDurableRecoveryPeerHealth>();

  private readonly resumePolicies = new Map<string, DurableGraphResumePolicy>();

  private metaScopeSequence = 0;

  private readonly turns: DurableRecoveryTurns;

  constructor(options: { readonly turns?: DurableRecoveryTurns } = {}) {
    this.turns = options.turns ?? new DurableRecoveryTurns();
  }

  run(input: {
    readonly contextGraphId: string;
    readonly options?: DurableRecoveryRunOptions;
    readonly dependencies: DurableRecoveryRunnerDependencies;
  }): Promise<DurableRecoveryExecution> {
    const { contextGraphId, dependencies } = input;
    const retry: DurableRecoveryRetry = {
      // One macrotask later, so that the coordinator no longer lists the refused owner this retry follows.
      run: () => setImmediate(() => {
        // An unsubscribed graph is not retried: its turn ends here and it leaves the line.
        if (dependencies.inRecoveryScope?.() === false) {
          this.turns.roundEnded(contextGraphId);
          return;
        }
        this.run(input).catch((error: unknown) => dependencies.logWarn(
          `Durable recovery retry for "${contextGraphId}" failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }),
      admissible: () => dependencies.admissionAvailable?.() ?? true,
    };
    if (this.turns.isDeferred(contextGraphId)) {
      // The graph waits for a sync slot and the runner retries it: answer at once, without a round.
      this.turns.setRetry(contextGraphId, retry);
      return Promise.resolve(deferredExecution(input.options));
    }
    return this.coordinator.join({
      contextGraphId,
      runOwner: (owner) => {
        // A round hands its turn on when it settles its result, so nothing can be woken in between.
        let ended = false;
        const endRound = () => {
          if (ended) return;
          ended = true;
          this.turns.roundEnded(contextGraphId);
        };
        return this.runOwner(contextGraphId, input.options ?? {}, owner, dependencies, retry, endRound).finally(endRound);
      },
    });
  }

  private healthFor(
    contextGraphId: string,
    peerId: string,
  ): MutableDurableRecoveryPeerHealth {
    const key = `${contextGraphId}\0${peerId}`;
    let health = this.healthByGraphPeer.get(key);
    if (!health) {
      health = {
        attempts: 0,
        successfulSlices: 0,
        recentTimeouts: 0,
        recentTransportResets: 0,
      };
      this.healthByGraphPeer.set(key, health);
    }
    return health;
  }

  private createMetaContinuation(): DurableMetaContinuation {
    this.metaScopeSequence += 1;
    return {
      requesterScope: `durable-recovery-meta:${this.metaScopeSequence}`,
    };
  }

  private async runOwner(
    contextGraphId: string,
    options: DurableRecoveryRunOptions,
    owner: DurableRecoveryOwnerControl,
    deps: DurableRecoveryRunnerDependencies,
    retry: DurableRecoveryRetry,
    endRound: () => void,
  ): Promise<DurableRecoveryExecution> {
    const progressTotals = createProgressTotals();
    const attemptedWithoutProgress = new Set<string>();
    const incompatiblePeers = new Set<string>();
    let policy = this.resumePolicies.get(contextGraphId);
    if (!policy) {
      policy = new DurableGraphResumePolicy();
      this.resumePolicies.set(contextGraphId, policy);
    }
    const resume = policy.startRun(deps.checkpointStore);
    const fetchPolicy = new DurableRecoveryFetchPolicy();
    const confirmation = new HeldAssetsConfirmationRun();
    let slices = 0;
    let lastPeerId: string | undefined;
    let lastDiagnostics = recoveryActionDiagnostics(createIncompleteDurableSyncResult());
    let safeOffset = 0;
    const peerExecutions = new Map<string, MutablePeerExecution>();
    const metaContinuations = new Map<string, DurableMetaContinuation>();

    const recordPeerSlice = (peerId: string, diagnostics: DurableRecoveryDiagnostics): void => {
      let execution = peerExecutions.get(peerId);
      if (!execution) {
        execution = { diagnostics, progressTotals: createProgressTotals() };
        peerExecutions.set(peerId, execution);
      }
      execution.diagnostics = diagnostics;
      accumulateProgress(execution.progressTotals, diagnostics);
    };

    const finish = (
      outcome: DurableRecoveryExecutionOutcome,
    ): DurableRecoveryExecution => {
      endRound();
      for (const continuation of metaContinuations.values()) {
        if (continuation.state) {
          deleteSyncPageCheckpoint(deps.checkpointStore, continuation.state.checkpointKey);
          continuation.state = undefined;
        }
      }
      const peers = [...peerExecutions].map(([peerId, execution]) => ({
        peerId, diagnostics: withProgressTotals(execution.diagnostics, execution.progressTotals),
      }));
      let diagnostics = withProgressTotals(lastDiagnostics, progressTotals);
      if (outcome !== 'terminal' && peers.length > 1) {
        const accumulator = createDurableSyncAccumulator();
        for (const peer of peers) {
          recordDurableSyncDiagnostics(accumulator, peer.diagnostics);
        }
        diagnostics = accumulator.diagnosticsSnapshot();
      }
      // An owner that stopped waiting for its next turn is deferred by local backpressure too, on its last peer as well.
      const deferred = <T extends DurableRecoveryDiagnostics>(value: T): T => (
        { ...value, deferredBackpressure: Math.max(1, value.deferredBackpressure ?? 0) }
      );
      if (outcome === 'deferred') diagnostics = deferred(diagnostics);
      return {
        outcome,
        result: { ...diagnostics, complete: outcome === 'terminal' },
        peerResults: peers.map(({ peerId, diagnostics }) => ({ peerId,
          result: { ...(outcome === 'deferred' && peerId === lastPeerId ? deferred(diagnostics) : diagnostics),
            complete: outcome === 'terminal' && peerId === lastPeerId } })),
        slices,
        ...(lastPeerId ? { peerId: lastPeerId } : {}),
        ...(owner.manifestDigest ? { manifestDigest: owner.manifestDigest } : {}),
        safeOffset,
      };
    };

    const discoverRankedCandidates = async (): Promise<Array<
    DurableRecoveryPeerCandidate<string>
    >> => {
      const preferredPeerId = await deps.resolvePreferredPeerId().catch(() => undefined);
      const requestedPeerIds = [...new Set(options.restrictToCandidatePeerIds
        ? (options.candidatePeerIds ?? [])
        : [
            ...(preferredPeerId ? [preferredPeerId] : []),
            ...(options.candidatePeerIds ?? []),
          ])];
      for (const peerId of requestedPeerIds) {
        try {
          await deps.connectRequestedPeer(peerId);
        } catch (error) {
          deps.logDebug(
            `Durable recovery peer ${peerId.slice(-8)} is not currently connectable for "${contextGraphId}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!options.restrictToCandidatePeerIds) {
        await deps.primeConnections().catch(() => undefined);
      }

      let liveConnectionPeerIds: string[] = [];
      if (!options.restrictToCandidatePeerIds) {
        try {
          liveConnectionPeerIds = deps.liveConnectionPeerIds();
        } catch {
          // The caller-supplied triggering peer remains a valid candidate even
          // when an embedder's live-connection facade is unavailable.
        }
      }
      const connectedPeerIds = options.restrictToCandidatePeerIds
        ? requestedPeerIds
        : [...new Set([...requestedPeerIds, ...liveConnectionPeerIds])];
      const admittedPeerIds: string[] = [];
      for (const peerId of connectedPeerIds) {
        if (await deps.admitPeer(peerId)) admittedPeerIds.push(peerId);
      }
      const privateOnly = await deps.isPrivateContextGraph().catch(() => false);
      const discoveryOrdered = options.restrictToCandidatePeerIds
        ? admittedPeerIds
        : deps.orderPeerIds(admittedPeerIds, preferredPeerId, privateOnly);

      const capable: string[] = [];
      const preProvenPeerIds = new Set(options.candidatePeerIds ?? []);
      for (const peerId of discoveryOrdered) {
        if (
          (options.candidatesAreSyncCapable && preProvenPeerIds.has(peerId))
          || await deps.isSyncCapable(peerId)
        ) capable.push(peerId);
      }
      const candidates = capable.map((peerId, discoveryRank) => ({
        peer: peerId,
        peerId,
        checkpoint: deps.checkpointStore.get(getSyncCheckpointKey(
          peerId,
          contextGraphId,
          false,
          'data',
        )),
        health: this.healthFor(contextGraphId, peerId) as DurableRecoveryPeerHealth,
        discoveryRank,
      }));
      const canonicalManifestDigest = owner.manifestDigest
        ?? selectCanonicalDurableRecoveryManifest(candidates);
      if (canonicalManifestDigest) owner.bindManifest(canonicalManifestDigest);
      resume.discover(candidates.map(candidate => ({ checkpoint: candidate.checkpoint,
        checkpointKey: getSyncCheckpointKey(candidate.peerId, contextGraphId, false, 'data') })));
      return rankDurableRecoveryPeers(candidates, canonicalManifestDigest);
    };

    type ActionOutcome = { readonly diagnostics: DurableRecoveryDiagnostics; readonly next: 'terminal' | 'continue' | 'next-peer' | 'deferred'; readonly accounting: DurableRecoveryAccounting };
    // No free local sync slot: the slice never started, so it says nothing about the peer.
    const deferredAction = (diagnostics: DurableRecoveryDiagnostics): ActionOutcome => (
      { diagnostics, next: 'deferred', accounting: 'unchanged' }
    );
    const failedSlice = (peerId: string, error: unknown): DurableSyncResult => {
      deps.logWarn(`Durable recovery slice ${slices} for "${contextGraphId}" from ${peerId.slice(-8)} failed: ${error instanceof Error ? error.message : String(error)}`);
      return createFailedPeerDurableSyncResult();
    };

    const executeExactAction = async (action: Extract<DurableRecoveryAction, { kind: 'exact-batch' }>): Promise<ActionOutcome> => {
      let exact: ExactRecoveryActionOutcome;
      try { exact = await deps.executeExactSlice!(action.peerId, action.assets.map(asset => asset.ual)); }
      catch (error) { exact = exactRecoveryActionOutcome(failedSlice(action.peerId, error)); }
      const selectionComplete = exact.selection === 'complete';
      if (!selectionComplete && (exact.diagnostics.deferredBackpressure ?? 0) > 0) return deferredAction(exact.diagnostics);
      fetchPolicy.recordExact(selectionComplete);
      if (selectionComplete) {
        attemptedWithoutProgress.clear();
      } else {
        deps.logWarn(`Durable recovery for "${contextGraphId}" did not store ${action.assets.length} missing asset(s) from ${action.peerId.slice(-8)} with an exact request; continuing with full-graph rounds`);
      }
      return { diagnostics: exact.diagnostics, next: 'continue', accounting: selectionComplete ? 'success' : 'failure' };
    };

    const executeGraphAction = async (action: Extract<DurableRecoveryAction, { kind: 'graph-round' }>): Promise<ActionOutcome> => {
      const checkpointKey = getSyncCheckpointKey(
        action.peerId,
        contextGraphId,
        false,
        'data',
      );
      const seed = resume.seed(action.peerId, checkpointKey);
      if (seed?.kind === 'candidate') {
        deps.logInfo(`Durable recovery for "${contextGraphId}" offers ${action.peerId.slice(-8)} verified offset ${seed.boundary.offset}`);
      }
      const before = deps.checkpointStore.get(checkpointKey);
      let round: DurableRecoveryRoundOutcome;
      try {
        let metaContinuation = metaContinuations.get(action.peerId);
        if (!metaContinuation) {
          metaContinuation = this.createMetaContinuation();
          metaContinuations.set(action.peerId, metaContinuation);
        }
        const recovery: GraphOwnedRecoveryInput = {
          meta: metaContinuation,
          holdings: fetchPolicy.holdings(deps.executeExactSlice !== undefined),
          boundary: seed?.kind === 'candidate' ? seed.boundary : undefined,
          confirmation,
        };
        round = await deps.executeSlice(action.peerId, recovery);
      } catch (error) { round = { result: failedSlice(action.peerId, error), decision: { strategy: 'not-started' } }; }
      const result = round.result;
      if (round.decision.strategy === 'not-started' && (result.deferredBackpressure ?? 0) > 0) {
        return deferredAction(recoveryActionDiagnostics(result));
      }
      const after = deps.checkpointStore.get(checkpointKey);
      resume.recordSlice({ peerId: action.peerId, checkpointKey, before, after,
        rejectedOffset: round.decision.rejectedResumeOffset, candidate: seed?.kind === 'candidate' ? seed.boundary : undefined });
      const manifestDigest = after?.manifestDigest ?? before?.manifestDigest;
      const checkpointOffset = after?.offset ?? before?.offset ?? 0;
      if (manifestDigest && manifestDigest !== owner.manifestDigest) {
        owner.bindManifest(manifestDigest);
        safeOffset = checkpointOffset;
      } else {
        safeOffset = Math.max(safeOffset, checkpointOffset);
      }

      // The round found this node holding the rest of the generation and left these assets to us.
      const missingAssetBatches = round.decision.strategy === 'exact-missing' ? round.decision.batches : undefined;
      if (missingAssetBatches && deps.executeExactSlice) {
        const stillMissing = fetchPolicy.queueMissing(action.peerId, missingAssetBatches);
        if (stillMissing > 0) {
          deps.logWarn(`Durable recovery for "${contextGraphId}" still lacks ${stillMissing} asset version(s) it fetched with exact requests; continuing with full-graph rounds`);
        } else {
          deps.logInfo(`Durable recovery for "${contextGraphId}" fetches ${missingAssetBatches.flat().length} missing asset(s) from ${action.peerId.slice(-8)} in ${missingAssetBatches.length} exact request(s)`);
        }
        // The next round confirms the generation is held, or pulls what is still missing.
        return { diagnostics: recoveryActionDiagnostics(result), next: 'continue', accounting: 'success' };
      }

      const checkpointAdvanced = (after?.offset ?? 0) > (before?.offset ?? 0);
      const manifestRebound = after?.manifestDigest !== undefined
        && after.manifestDigest !== before?.manifestDigest
        && (after.offset ?? 0) > 0
        && after.manifestPrefixDigest !== undefined;
      const metadataContinuationAdvanced = (
        metaContinuations.get(action.peerId)?.state !== undefined
        && (result.checkpointAdvances ?? 0) > 0
      );
      const outcome = classifyDurableRecoverySlice({
        terminalPersisted: result.complete === true
          && (round.decision.strategy === 'legacy' || (after?.terminal === true
            && after.manifestDigest !== undefined && after.manifestPrefixDigest !== undefined)),
        checkpointAdvanced,
        manifestRebound,
        metadataContinuationAdvanced,
        deniedPhases: result.deniedPhases ?? 0,
        rejectedKcs: result.rejectedKcs ?? 0,
        dataRejectedMissingMeta: result.dataRejectedMissingMeta ?? 0,
      });

      if (outcome === 'terminal') {
        deps.logInfo(
          `Durable recovery for "${contextGraphId}" reached its terminal verified boundary after ${slices} slice(s) via ${action.peerId.slice(-8)}`,
        );
        return { diagnostics: recoveryActionDiagnostics(result), next: 'terminal', accounting: 'terminal' };
      }

      if (result.complete === true) {
        deps.logWarn(
          `Durable recovery for "${contextGraphId}" refused an unpersisted terminal result from ${action.peerId.slice(-8)}`,
        );
      }
      if (outcome === 'partial-progress') {
        fetchPolicy.recordRound(round.decision, checkpointAdvanced || manifestRebound);
        attemptedWithoutProgress.clear();
        incompatiblePeers.delete(action.peerId);
        deps.logInfo(
          `Durable recovery partial-progress for "${contextGraphId}" via ${action.peerId.slice(-8)}: safeOffset=${safeOffset}; scheduling one continuation after releasing admission`,
        );
        return { diagnostics: recoveryActionDiagnostics(result), next: 'continue', accounting: 'partial-progress' };
      }

      if (resume.retryRejectedSlice(action.peerId)) {
        // Its round discarded the checkpoint: retry the peer once, from its own state, without the boundary.
        return { diagnostics: recoveryActionDiagnostics(result), next: 'continue', accounting: 'unchanged' };
      }
      attemptedWithoutProgress.add(action.peerId);
      if (outcome === 'incompatible') incompatiblePeers.add(action.peerId);
      return { diagnostics: recoveryActionDiagnostics(result), next: 'next-peer', accounting: 'failure' };
    };

    for (;;) {
      if (!deps.isRunning()) return finish('no-progress');

      // Exact batches are actions of this same owner loop; their order is retained
      // across admission releases without a nested execution/bookkeeping loop.
      let action: DurableRecoveryAction | undefined = fetchPolicy.nextExact();
      if (!action) {
        const rankedCandidates = await discoverRankedCandidates();
        const candidate = rankedCandidates.find(({ peerId }) => !attemptedWithoutProgress.has(peerId));
        if (!candidate) {
          return finish(rankedCandidates.length > 0
            && rankedCandidates.every(({ peerId }) => incompatiblePeers.has(peerId)) ? 'incompatible' : 'no-progress');
        }
        action = { kind: 'graph-round', peerId: candidate.peerId };
      }

      slices += 1;
      lastPeerId = action.peerId;
      this.turns.sliceStarting(contextGraphId);
      const outcome = await (action.kind === 'exact-batch' ? executeExactAction(action) : executeGraphAction(action));
      if (outcome.next === 'deferred') {
        // The round ends here: the next peer would meet the same busy slot. The graph waits its turn.
        this.turns.refused(contextGraphId, retry);
        lastDiagnostics = outcome.diagnostics;
        recordPeerSlice(action.peerId, lastDiagnostics);
        return finish('deferred');
      }
      this.turns.sliceRan(contextGraphId);
      const health = this.healthFor(contextGraphId, action.peerId);
      health.attempts += 1;
      accountDurableRecoveryAction(health, outcome.accounting, outcome.diagnostics);
      lastDiagnostics = outcome.diagnostics;
      accumulateProgress(progressTotals, lastDiagnostics);
      recordPeerSlice(action.peerId, lastDiagnostics);
      if (outcome.next === 'terminal') return finish('terminal');
      if (outcome.next === 'continue') {
        await owner.scheduleContinuation();
        // While graphs wait for a slot, take the next slice after them. A retained META prefix
        // is not held through the wait: its owner keeps the turn until META is complete.
        const metaRetained = [...metaContinuations.values()].some((continuation) => continuation.state !== undefined);
        if (!metaRetained && !await this.turns.handOver(contextGraphId, retry, deps.stopSignal?.())) return finish('deferred');
      }
    }
  }
}
