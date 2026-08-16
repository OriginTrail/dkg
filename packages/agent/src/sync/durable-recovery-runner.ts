import type { DurableSyncResult } from '../dkg-agent-types.js';
import {
  createDurableSyncAccumulator,
  createFailedPeerDurableSyncResult,
  createIncompleteDurableSyncResult,
  finalizeDurableSyncCompletion,
  mergeDurableSyncResultIntoAccumulator,
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
  ): Promise<DurableSyncResult>;
  logDebug(message: string): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

type MutableDurableRecoveryPeerHealth = {
  attempts: number;
  successfulSlices: number;
  recentTimeouts: number;
  recentTransportResets: number;
  lastSuccessfulTransportAtMs?: number;
};

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
  'selectedVmTerminalCompletions',
] as const satisfies readonly (keyof DurableSyncResult)[];

type ProgressTotals = Record<typeof PROGRESS_COUNTERS[number], number>;

function createProgressTotals(): ProgressTotals {
  return Object.fromEntries(PROGRESS_COUNTERS.map((key) => [key, 0])) as ProgressTotals;
}

function accumulateProgress(totals: ProgressTotals, result: DurableSyncResult): void {
  for (const key of PROGRESS_COUNTERS) totals[key] += result[key] ?? 0;
}

function withProgressTotals(
  result: DurableSyncResult,
  totals: ProgressTotals,
): DurableSyncResult {
  return { ...result, ...totals };
}

type MutablePeerExecution = {
  result: DurableSyncResult;
  progressTotals: ProgressTotals;
};

/** Owns graph-level recovery single-flight, peer health, ranking and continuation. */
export class DurableRecoveryRunner {
  private readonly coordinator = new DurableRecoveryCoordinator<DurableRecoveryExecution>();

  private readonly healthByGraphPeer = new Map<string, MutableDurableRecoveryPeerHealth>();

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
    let slices = 0;
    let lastPeerId: string | undefined;
    let lastResult: DurableSyncResult = createIncompleteDurableSyncResult();
    let safeOffset = 0;
    const peerExecutions = new Map<string, MutablePeerExecution>();
    const metaContinuations = new Map<string, DurableMetaContinuation>();

    const recordPeerSlice = (peerId: string, result: DurableSyncResult): void => {
      let execution = peerExecutions.get(peerId);
      if (!execution) {
        execution = { result, progressTotals: createProgressTotals() };
        peerExecutions.set(peerId, execution);
      }
      execution.result = result;
      accumulateProgress(execution.progressTotals, result);
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
      const peerResults = [...peerExecutions].map(([peerId, execution]) => ({
        peerId,
        result: withProgressTotals(execution.result, execution.progressTotals),
      }));
      let result = withProgressTotals(lastResult, progressTotals);
      if (outcome !== 'terminal' && peerResults.length > 1) {
        const accumulator = createDurableSyncAccumulator();
        for (const peerResult of peerResults) {
          mergeDurableSyncResultIntoAccumulator(accumulator, peerResult.result);
        }
        result = finalizeDurableSyncCompletion(accumulator);
      }
      return {
        outcome,
        result,
        peerResults,
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
      return rankDurableRecoveryPeers(candidates, canonicalManifestDigest);
    };

    for (;;) {
      if (!deps.isRunning()) return finish('no-progress');

      const rankedCandidates = await discoverRankedCandidates();
      const candidate = rankedCandidates.find(
        ({ peerId }) => !attemptedWithoutProgress.has(peerId),
      );
      if (!candidate) {
        const outcome: DurableRecoveryContinuationOutcome = rankedCandidates.length > 0
          && rankedCandidates.every(({ peerId }) => incompatiblePeers.has(peerId))
          ? 'incompatible'
          : 'no-progress';
        return finish(outcome);
      }

      const checkpointKey = getSyncCheckpointKey(
        candidate.peerId,
        contextGraphId,
        false,
        'data',
      );
      const before = deps.checkpointStore.get(checkpointKey);
      const health = this.healthFor(contextGraphId, candidate.peerId);
      health.attempts += 1;
      slices += 1;
      lastPeerId = candidate.peerId;

      try {
        let metaContinuation = metaContinuations.get(candidate.peerId);
        if (!metaContinuation) {
          metaContinuation = this.createMetaContinuation();
          metaContinuations.set(candidate.peerId, metaContinuation);
        }
        lastResult = await deps.executeSlice(candidate.peerId, metaContinuation);
      } catch (error) {
        lastResult = createFailedPeerDurableSyncResult();
        deps.logWarn(
          `Durable recovery slice ${slices} for "${contextGraphId}" from ${candidate.peerId.slice(-8)} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      accumulateProgress(progressTotals, lastResult);
      recordPeerSlice(candidate.peerId, lastResult);
      const after = deps.checkpointStore.get(checkpointKey);
      const manifestDigest = after?.manifestDigest ?? before?.manifestDigest;
      const checkpointOffset = after?.offset ?? before?.offset ?? 0;
      if (manifestDigest && manifestDigest !== owner.manifestDigest) {
        owner.bindManifest(manifestDigest);
        safeOffset = checkpointOffset;
      } else {
        safeOffset = Math.max(safeOffset, checkpointOffset);
      }

      const checkpointAdvanced = (after?.offset ?? 0) > (before?.offset ?? 0);
      const manifestRebound = after?.manifestDigest !== undefined
        && after.manifestDigest !== before?.manifestDigest
        && (after.offset ?? 0) > 0
        && after.manifestPrefixDigest !== undefined;
      const metadataContinuationAdvanced = (
        metaContinuations.get(candidate.peerId)?.state !== undefined
        && (lastResult.checkpointAdvances ?? 0) > 0
      );
      const outcome = classifyDurableRecoverySlice({
        terminalPersisted: lastResult.complete === true
          && after?.terminal === true
          && after.manifestDigest !== undefined
          && after.manifestPrefixDigest !== undefined,
        checkpointAdvanced,
        manifestRebound,
        metadataContinuationAdvanced,
        deniedPhases: lastResult.deniedPhases ?? 0,
        rejectedKcs: lastResult.rejectedKcs ?? 0,
        dataRejectedMissingMeta: lastResult.dataRejectedMissingMeta ?? 0,
      });

      if (outcome === 'terminal') {
        health.successfulSlices += 1;
        health.lastSuccessfulTransportAtMs = Date.now();
        health.recentTimeouts = Math.floor(health.recentTimeouts * 0.75);
        health.recentTransportResets = Math.floor(health.recentTransportResets * 0.75);
        deps.logInfo(
          `Durable recovery for "${contextGraphId}" reached its terminal verified boundary after ${slices} slice(s) via ${candidate.peerId.slice(-8)}`,
        );
        return finish('terminal');
      }

      if (lastResult.complete === true) {
        deps.logWarn(
          `Durable recovery for "${contextGraphId}" refused an unpersisted terminal result from ${candidate.peerId.slice(-8)}`,
        );
      }
      if (outcome === 'partial-progress') {
        health.successfulSlices += 1;
        health.lastSuccessfulTransportAtMs = Date.now();
        if ((lastResult.timedOutPhases ?? 0) > 0) health.recentTimeouts += 1;
        if ((lastResult.failedPeers ?? 0) > 0) health.recentTransportResets += 1;
        attemptedWithoutProgress.clear();
        incompatiblePeers.delete(candidate.peerId);
        deps.logInfo(
          `Durable recovery partial-progress for "${contextGraphId}" via ${candidate.peerId.slice(-8)}: safeOffset=${safeOffset}; scheduling one continuation after releasing admission`,
        );
        await owner.scheduleContinuation();
        continue;
      }

      attemptedWithoutProgress.add(candidate.peerId);
      if (outcome === 'incompatible') incompatiblePeers.add(candidate.peerId);
      if ((lastResult.timedOutPhases ?? 0) > 0) health.recentTimeouts += 1;
      if ((lastResult.failedPeers ?? 0) > 0) health.recentTransportResets += 1;
    }
  }
}
