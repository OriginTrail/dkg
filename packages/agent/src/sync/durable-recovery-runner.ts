import { recoveryActionDiagnostics, exactRecoveryActionOutcome, type DurableRecoveryDiagnostics, type ExactRecoveryActionOutcome } from './durable-recovery-action.js';
import { accountDurableRecoveryAction, type DurableRecoveryAccounting, type MutableDurableRecoveryPeerHealth } from './durable-recovery-peer-health.js';
import { durableRecoveryRoundOutcome, type DurableRecoveryRoundOutcome } from './durable-recovery-round.js';
import { HeldAssetsConfirmationRun, type DurableHoldingsOptions } from './requester/durable-data-holdings.js';
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
import { DurableGraphResumePolicy, type VerifiedDurableBoundary } from './durable-recovery-boundary-seed.js';
import { DurableRecoveryFetchPolicy, type DurableRecoveryAction } from './durable-recovery-fetch-policy.js';

export interface DurableRecoveryExecution {
  readonly outcome: DurableRecoveryContinuationOutcome;
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
    metaContinuation: DurableMetaContinuation,
    holdings: DurableHoldingsOptions,
    durableResumeBoundary?: VerifiedDurableBoundary,
    confirmation?: HeldAssetsConfirmationRun,
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

/** Owns graph-level recovery single-flight, peer health, ranking and continuation. */
export class DurableRecoveryRunner {
  private readonly coordinator = new DurableRecoveryCoordinator<DurableRecoveryExecution>();

  private readonly healthByGraphPeer = new Map<string, MutableDurableRecoveryPeerHealth>();

  private readonly resumePolicies = new Map<string, DurableGraphResumePolicy>();

  private metaScopeSequence = 0;

  run(input: {
    readonly contextGraphId: string;
    readonly options?: DurableRecoveryRunOptions;
    readonly dependencies: DurableRecoveryRunnerDependencies;
  }): Promise<DurableRecoveryExecution> {
    return this.coordinator.join({
      contextGraphId: input.contextGraphId,
      runOwner: (owner) => this.runOwner(
        input.contextGraphId,
        input.options ?? {},
        owner,
        input.dependencies,
      ),
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
      outcome: DurableRecoveryContinuationOutcome,
    ): DurableRecoveryExecution => {
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
      return {
        outcome,
        result: { ...diagnostics, complete: outcome === 'terminal' },
        peerResults: peers.map(({ peerId, diagnostics }) => ({ peerId,
          result: { ...diagnostics, complete: outcome === 'terminal' && peerId === lastPeerId } })),
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

    type ActionOutcome = { readonly diagnostics: DurableRecoveryDiagnostics; readonly next: 'terminal' | 'continue' | 'next-peer'; readonly accounting: DurableRecoveryAccounting };
    const failedSlice = (peerId: string, error: unknown): DurableSyncResult => {
      deps.logWarn(`Durable recovery slice ${slices} for "${contextGraphId}" from ${peerId.slice(-8)} failed: ${error instanceof Error ? error.message : String(error)}`);
      return createFailedPeerDurableSyncResult();
    };

    const executeExactAction = async (action: Extract<DurableRecoveryAction, { kind: 'exact-batch' }>): Promise<ActionOutcome> => {
      let exact: ExactRecoveryActionOutcome;
      try { exact = await deps.executeExactSlice!(action.peerId, action.assets.map(asset => asset.ual)); }
      catch (error) { exact = exactRecoveryActionOutcome(failedSlice(action.peerId, error)); }
      const selectionComplete = exact.selection === 'complete';
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
        round = await deps.executeSlice(action.peerId, metaContinuation,
          fetchPolicy.holdings(deps.executeExactSlice !== undefined),
          seed?.kind === 'candidate' ? seed.boundary : undefined, confirmation);
      } catch (error) { round = durableRecoveryRoundOutcome(failedSlice(action.peerId, error), { strategy: 'not-started' }); }
      const result = round.result;
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

      this.healthFor(contextGraphId, action.peerId).attempts += 1;
      slices += 1;
      lastPeerId = action.peerId;
      const outcome = await (action.kind === 'exact-batch' ? executeExactAction(action) : executeGraphAction(action));
      accountDurableRecoveryAction(this.healthFor(contextGraphId, action.peerId), outcome.accounting, outcome.diagnostics);
      lastDiagnostics = outcome.diagnostics;
      accumulateProgress(progressTotals, lastDiagnostics);
      recordPeerSlice(action.peerId, lastDiagnostics);
      if (outcome.next === 'terminal') return finish('terminal');
      if (outcome.next === 'continue') await owner.scheduleContinuation();
    }
  }
}
