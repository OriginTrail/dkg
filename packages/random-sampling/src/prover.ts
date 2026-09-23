/**
 * Random Sampling prover orchestrator.
 *
 * One `tick()` per active proof period, sequenced strictly (no
 * overlap). Internal flow:
 *
 *   read period status → read/create challenge → resolve cgId →
 *   read on-chain merkle commitment → extract KC leaves locally →
 *   build proof material → submitProof → record outcome
 *
 * The orchestrator is intentionally small: every step is a single
 * adapter call, and the WAL records each transition for operator
 * diagnostics plus future crash-recovery replay.
 */

import {
  ChallengeNoLongerActiveError,
  MerkleRootMismatchError,
  NoEligibleContextGraphError,
  NoEligibleKnowledgeCollectionError,
  type ChainAdapter,
  type NodeChallenge,
} from '@origintrail-official/dkg-chain';
import {
  keccak256,
  structuredKARootV10,
  tripleContentV10,
  V10ProofChunkOutOfRangeError,
  V10ProofLeafCountMismatchError,
  V10ProofRootMismatchError,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  extractV10KCFromStore,
  KCDataMissingError,
  KCNotFoundError,
  KCRootEntitiesNotFoundError,
} from './ka-extractor.js';
import {
  extractCatalogLeavesFromStore,
  CatalogLeavesMissingError,
} from './catalog-extractor.js';
import type { ProofBuilder, ProofBuilderRequest } from './proof-builder.js';
import { InProcessProofBuilder } from './proof-builder.js';
import {
  makeWalEntry,
  type PeriodKey,
  type ProverWal,
} from './wal.js';
import { InMemoryProverWal } from './wal.js';
import { SolvedPeriodSkip } from './solved-period-skip.js';

/**
 * On-chain identity of the proof period a challenge-scoped outcome belongs to.
 * A node holds at most one challenge per proof period, so this pair is also the
 * node's challenge identity: the WAL's `PeriodKey` without the constant node id.
 */
export interface ChallengePeriod {
  readonly epoch: bigint;
  readonly periodStartBlock: bigint;
}

/**
 * Outcome reported by `tick()`. The orchestrator's caller (the
 * agent's epoch loop) uses these to drive observability + retry
 * cadence — never to decide "should I tick again", because the next
 * tick is governed by chain state, not the previous outcome.
 *
 * Every outcome reached while holding a challenge carries its `period`, so
 * observers can tell repeated ticks on one challenge from distinct challenges.
 */
export type TickOutcome =
  /** Reserved. Currently unreachable — see `tickImpl` for why we no
   *  longer trust view-side `isValid: false`. Kept in the union so
   *  downstream consumers (`prover-loop`, `random-sampling-bind`)
   *  can pattern-match on it without breakage if a stricter
   *  period-closed gate is reintroduced (e.g. duration == 0). */
  | { kind: 'period-closed' }
  | { kind: 'no-challenge'; reason: 'no-eligible-cg' | 'no-eligible-kc' }
  | { kind: 'already-solved'; period: ChallengePeriod }
  | { kind: 'cg-not-found'; kaId: bigint; period: ChallengePeriod }
  | { kind: 'kc-not-synced'; kaId: bigint; cgId: bigint; period: ChallengePeriod }
  | {
      kind: 'data-corrupted';
      kaId: bigint;
      cgId: bigint;
      reason: 'root-mismatch' | 'leaf-count-mismatch' | 'meta-graph-bug';
      period: ChallengePeriod;
    }
  | { kind: 'submit-stale'; period: ChallengePeriod }
  | {
      kind: 'submitted';
      txHash: string;
      kaId: bigint;
      cgId: bigint;
      chunkId: bigint;
      period: ChallengePeriod;
    }
  | { kind: 'error'; error: Error };

/** Outcome kinds that mean a tick made no proof progress. */
export type TickFailureKind = Extract<
  TickOutcome['kind'],
  'cg-not-found' | 'kc-not-synced' | 'data-corrupted' | 'submit-stale' | 'error'
>;

/** What one tick outcome contributes to the prover's health counters. */
export interface TickOutcomeHealth {
  /** Challenge (proof period) the tick worked on, or null when it held none. */
  readonly challenge: ChallengePeriod | null;
  /** Whether the tick submitted a proof for `challenge`. */
  readonly proofSubmitted: boolean;
  /** Failure classification, or null for a healthy outcome. */
  readonly failure: TickFailureKind | null;
}

const NO_TICK_HEALTH_SIGNAL: TickOutcomeHealth = Object.freeze({
  challenge: null,
  proofSubmitted: false,
  failure: null,
});

/**
 * Classify one outcome for health reporting. The switch is exhaustive over
 * `TickOutcome`, so a new kind fails compilation here until its health
 * semantics are decided.
 */
export function classifyTickOutcome(outcome: TickOutcome): TickOutcomeHealth {
  switch (outcome.kind) {
    case 'period-closed':
    case 'no-challenge':
      return NO_TICK_HEALTH_SIGNAL;
    case 'already-solved':
      return { challenge: outcome.period, proofSubmitted: false, failure: null };
    case 'submitted':
      return { challenge: outcome.period, proofSubmitted: true, failure: null };
    case 'cg-not-found':
    case 'kc-not-synced':
    case 'data-corrupted':
    case 'submit-stale':
      return { challenge: outcome.period, proofSubmitted: false, failure: outcome.kind };
    case 'error':
      // A thrown tick carries no challenge identity. A later tick in the same
      // proof period still records that period.
      return { challenge: null, proofSubmitted: false, failure: 'error' };
    default: {
      // Compile-time guard only: bookkeeping inside the prover loop must never
      // throw, so an impossible runtime value contributes nothing.
      const exhaustive: never = outcome;
      void exhaustive;
      return NO_TICK_HEALTH_SIGNAL;
    }
  }
}

export interface RandomSamplingProverDeps {
  chain: ChainAdapter;
  store: TripleStore;
  /** Identity of THIS node — used to read challenges + skip already-solved periods. */
  identityId: bigint;
  builder?: ProofBuilder;
  wal?: ProverWal;
  /** Hook for observability / structured logs. Default = no-op. */
  log?: ProverLogger;
  /**
   * Optional foreground repair invoked when the sampled public KA is absent
   * or its live local version does not match the immutable challenge. The
   * result is explicit challenge-scoped proof input; durable storage mutation
   * is not a second implicit success channel.
   */
  repairMissingKnowledgeAsset?: (input: {
    kaId: bigint;
    cgId: bigint;
    /** Immutable content identity captured by the active challenge. */
    expectedRoot: Uint8Array;
    expectedLeafCount: bigint;
  }) => RandomSamplingRepairOperation;
}

/** Challenge-scoped proof input returned without mutating the live KA view. */
export interface RandomSamplingRepairMaterial {
  readonly contents: readonly Uint8Array[];
  readonly privateRoots: readonly Uint8Array[];
}

/**
 * One explicitly owned repair task. `result` is the prompt logical outcome
 * consumed by the tick, while `settled` is the physical completion boundary
 * that handle shutdown must drain even when a dependency ignores abort.
 */
export interface RandomSamplingRepairOperation {
  readonly result: Promise<RandomSamplingRepairMaterial>;
  readonly settled: Promise<void>;
  cancel(reason?: unknown): void;
}

export interface ProverLogger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
}

const noopLog: ProverLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

// A leaf-count/root mismatch is a deterministic local sync inconsistency, not
// a transient RPC failure. Give the sync/reconciliation path a few ticks to
// repair the KA before attempting another full extraction. The loop normally
// runs every five seconds, so this caps repeated mismatch work to one extract
// per roughly twenty seconds while keeping recovery bounded.
const DATA_CORRUPTION_COOLDOWN_TICKS = 3;

function lifecycleAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException(
    'Random Sampling prover handle stopped',
    'AbortError',
  );
}

function raceWithLifecycleAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(lifecycleAbortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(lifecycleAbortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

/**
 * Build a repair operation around one physical execution. Consumers cancel a
 * single task and drain a single completion boundary; dependency promises do
 * not leak through the public ownership protocol.
 */
export function createRandomSamplingRepairOperation(
  execute: (signal: AbortSignal) => Promise<RandomSamplingRepairMaterial>,
  externalSignals: readonly AbortSignal[] = [],
): RandomSamplingRepairOperation {
  const controller = new AbortController();
  const signals = [controller.signal, ...externalSignals];
  const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
  const physicalResult = Promise.resolve().then(() => {
    if (signal.aborted) throw lifecycleAbortReason(signal);
    return execute(signal);
  });
  return {
    result: raceWithLifecycleAbort(physicalResult, signal),
    settled: physicalResult.then(
      () => undefined,
      () => undefined,
    ),
    cancel: (reason = new DOMException(
      'Random Sampling repair cancelled',
      'AbortError',
    )) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
  };
}

/**
 * Single-period prover orchestrator. One instance per node — it owns
 * the WAL handle and (optionally) the worker_threads-backed builder.
 *
 * `tick()` is serialized: a second concurrent call awaits the first.
 * If a tick exceeds the proof period, the on-chain
 * `ChallengeNoLongerActiveError` will surface from `submitProof` and
 * the period is dropped (logged loudly, WAL records `failed`).
 */
export class RandomSamplingProver {
  private readonly chain: ChainAdapter;
  private readonly store: TripleStore;
  private readonly identityId: bigint;
  private readonly builder: ProofBuilder;
  private readonly wal: ProverWal;
  private readonly log: ProverLogger;
  private readonly repairMissingKnowledgeAsset?: RandomSamplingProverDeps['repairMissingKnowledgeAsset'];
  private readonly lifecycleController = new AbortController();
  private inflight: Promise<TickOutcome> | null = null;
  private readonly repairOperations = new Set<RandomSamplingRepairOperation>();
  private readonly dataCorruptionCooldown = new Map<bigint, number>();
  private readonly solvedPeriodSkip: SolvedPeriodSkip;

  /**
   * Proof material pinned for the active proof period. The prover already pins
   * the challenge root / leaf-count / curation branch at issuance (WS-B Trap 1),
   * but the CONTENT was re-read live on every retry — so a mid-period UPDATE to
   * the sampled KA (typically surfacing on a submit retry after a transient tx
   * failure) turned an already-valid proof into a `data-corrupted` miss. Once a
   * proof verifies against the pinned root we keep it and reuse it for the rest
   * of the period. Keyed by the full challenge identity so a new period never
   * reuses stale material. In-memory only — a restart mid-period re-extracts,
   * same as before (restart + mid-period-update + this exact sampled KA is
   * vanishingly rare).
   */
  private pinnedProofMaterial?: {
    epoch: bigint;
    periodStartBlock: bigint;
    kaId: bigint;
    chunkId: bigint;
    expectedRoot: Uint8Array;
    material: Awaited<ReturnType<ProofBuilder['build']>>;
  };

  constructor(deps: RandomSamplingProverDeps) {
    this.chain = deps.chain;
    this.store = deps.store;
    this.identityId = deps.identityId;
    this.builder = deps.builder ?? new InProcessProofBuilder();
    this.wal = deps.wal ?? new InMemoryProverWal();
    this.log = deps.log ?? noopLog;
    this.repairMissingKnowledgeAsset = deps.repairMissingKnowledgeAsset;
    this.solvedPeriodSkip = new SolvedPeriodSkip(deps.chain);
  }

  /** Single-flight tick. Concurrent callers await the same result. */
  async tick(): Promise<TickOutcome> {
    if (this.inflight) return this.inflight;
    this.inflight = this.tickImpl().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Abort handle-owned foreground work before the loop drains its active tick. */
  cancel(reason: unknown = new DOMException(
    'Random Sampling prover handle stopped',
    'AbortError',
  )): void {
    if (!this.lifecycleController.signal.aborted) {
      this.lifecycleController.abort(reason);
    }
    for (const operation of this.repairOperations) operation.cancel(reason);
  }

  private trackRepairOperation(operation: RandomSamplingRepairOperation): void {
    this.repairOperations.add(operation);
    void operation.settled.then(
      () => this.repairOperations.delete(operation),
      () => this.repairOperations.delete(operation),
    );
  }

  /** Release builder + WAL handles after all logical and physical work settles. */
  async close(): Promise<void> {
    this.cancel();
    const running = this.inflight;
    if (running) await running.catch(() => undefined);
    while (this.repairOperations.size > 0) {
      await Promise.allSettled(
        [...this.repairOperations].map((operation) => operation.settled),
      );
    }
    await this.builder.close();
    await this.wal.close();
  }

  /** Reuse the proof material already verified for this exact challenge, if any. */
  private pinnedMaterialFor(
    periodKey: PeriodKey,
    kaId: bigint,
    chunkId: bigint,
    expectedRoot: Uint8Array,
  ): Awaited<ReturnType<ProofBuilder['build']>> | undefined {
    const p = this.pinnedProofMaterial;
    if (
      p
      && p.epoch === periodKey.epoch
      && p.periodStartBlock === periodKey.periodStartBlock
      && p.kaId === kaId
      && p.chunkId === chunkId
      && uint8ArrayEquals(p.expectedRoot, expectedRoot)
    ) {
      return p.material;
    }
    return undefined;
  }

  private pinProofMaterial(
    periodKey: PeriodKey,
    kaId: bigint,
    chunkId: bigint,
    expectedRoot: Uint8Array,
    material: Awaited<ReturnType<ProofBuilder['build']>>,
  ): void {
    this.pinnedProofMaterial = {
      epoch: periodKey.epoch,
      periodStartBlock: periodKey.periodStartBlock,
      kaId,
      chunkId,
      expectedRoot,
      material,
    };
  }

  private markDataCorrupted(kaId: bigint): void {
    this.dataCorruptionCooldown.set(kaId, DATA_CORRUPTION_COOLDOWN_TICKS);
  }

  /** Consume one retry suppression tick for a KA, returning its prior count. */
  private consumeDataCorruptionCooldown(kaId: bigint): number {
    const remaining = this.dataCorruptionCooldown.get(kaId);
    if (remaining === undefined) return 0;
    if (remaining <= 1) this.dataCorruptionCooldown.delete(kaId);
    else this.dataCorruptionCooldown.set(kaId, remaining - 1);
    return remaining;
  }

  private async extractPublicKnowledgeAssetWithRepair(input: {
    kaId: bigint;
    cgId: bigint;
    expectedRoot: Uint8Array;
    expectedLeafCount: bigint;
    periodStartBlock: bigint;
  }): Promise<RandomSamplingRepairMaterial> {
    const extractLocal = async (): Promise<RandomSamplingRepairMaterial> => {
      const extracted = await extractV10KCFromStore(this.store, input.cgId, input.kaId);
      return {
        contents: extracted.triples.map((triple) => tripleContentV10(
          triple.subject,
          triple.predicate,
          triple.object,
        )),
        privateRoots: extracted.privateRoots,
      };
    };
    type LocalOutcome =
      | { kind: 'ready'; material: RandomSamplingRepairMaterial }
      | { kind: 'challenge-mismatch'; material: RandomSamplingRepairMaterial }
      | { kind: 'missing'; error: KCNotFoundError | KCDataMissingError };
    const readLocalOutcome = async (): Promise<LocalOutcome> => {
      try {
        const material = await extractLocal();
        return repairMaterialMatchesChallenge(
          material,
          input.expectedRoot,
          input.expectedLeafCount,
        )
          ? { kind: 'ready', material }
          : { kind: 'challenge-mismatch', material };
      } catch (error) {
        if (!(error instanceof KCNotFoundError) && !(error instanceof KCDataMissingError)) {
          throw error;
        }
        return { kind: 'missing', error };
      }
    };

    const local = await readLocalOutcome();
    if (local.kind === 'ready') return local.material;
    if (!this.repairMissingKnowledgeAsset) {
      if (local.kind === 'missing') throw local.error;
      return local.material;
    }

    this.log.info('rs.tick.kc-repair-started', {
      kaId: input.kaId.toString(),
      cgId: input.cgId.toString(),
      periodStart: input.periodStartBlock.toString(),
      err: local.kind === 'challenge-mismatch'
        ? 'ChallengeCommitmentMismatch'
        : local.error.name,
    });
    try {
      const signal = this.lifecycleController.signal;
      if (signal.aborted) throw lifecycleAbortReason(signal);
      const repairOperation = this.repairMissingKnowledgeAsset({
        kaId: input.kaId,
        cgId: input.cgId,
        expectedRoot: input.expectedRoot,
        expectedLeafCount: input.expectedLeafCount,
      });
      this.trackRepairOperation(repairOperation);
      const repaired = await repairOperation.result;
      if (signal.aborted) throw lifecycleAbortReason(signal);
      this.log.info('rs.tick.kc-repaired', {
        kaId: input.kaId.toString(),
        cgId: input.cgId.toString(),
        periodStart: input.periodStartBlock.toString(),
        challengeScoped: true,
      });
      return repaired;
    } catch (repairError) {
      if (this.lifecycleController.signal.aborted) throw repairError;
      this.log.warn('rs.tick.kc-repair-failed', {
        kaId: input.kaId.toString(),
        cgId: input.cgId.toString(),
        periodStart: input.periodStartBlock.toString(),
        err: repairError instanceof Error
          ? repairError.message.slice(0, 200)
          : String(repairError).slice(0, 200),
      });
      // Preserve the local semantic outcome: a missing asset remains a normal
      // kc-not-synced result, while a local mismatch continues to the existing
      // root/count classifier. A rejected hook is never treated as success via
      // an undocumented storage side effect.
      if (local.kind === 'missing') throw local.error;
      return local.material;
    }
  }

  private async tickImpl(): Promise<TickOutcome> {
    if (
      !this.chain.getActiveProofPeriodStatus ||
      !this.chain.createChallenge ||
      !this.chain.submitProof ||
      !this.chain.getNodeChallenge ||
      !this.chain.getKAContextGraphId
    ) {
      throw new Error(
        'RandomSamplingProver: chain adapter missing required RandomSampling / KC view methods',
      );
    }

    // The collaborator owns the complete guarded sequence: reuse check, pair
    // and epoch capture, these live reads, head staleness, and observation.
    const solvedPeriodRead = await this.solvedPeriodSkip.read(async () => {
      // Read the period status + existing challenge in parallel. We
      // *don't* short-circuit on `!status.isValid`: that view-side
      // check stalls single-tenant deployments indefinitely because no
      // external tx ever triggers `updateAndGetActiveProofPeriodStartBlock`.
      // The on-chain `createChallenge` auto-rotates the period inside
      // `_generateChallenge`, so we always proceed and let the chain
      // (a) decide what the current period actually is and (b) reject
      // submissions for stale periods via `ChallengeNoLongerActive`.
      const [status, existing] = await Promise.all([
        this.chain.getActiveProofPeriodStatus!(),
        this.chain.getNodeChallenge!(this.identityId),
      ]);

      // Existing is "current" iff its period-start block matches the status
      // read. A stale status and matching challenge are still checked against
      // the live head by the collaborator before either is reused.
      const existingIsCurrent = existing !== null
        && existing.activeProofPeriodStartBlock === status.activeProofPeriodStartBlock;
      return {
        value: { status },
        ...(existingIsCurrent
          ? {
              currentChallenge: {
                challenge: existing,
                durationInBlocks: status.proofingPeriodDurationInBlocks,
              },
            }
          : {}),
      };
    });
    if (solvedPeriodRead.kind === 'reused') {
      this.log.info('rs.tick.already-solved', {
        epoch: solvedPeriodRead.record.challengePeriodEpoch.toString(),
        periodStart: solvedPeriodRead.record.periodStartBlock.toString(),
      });
      return {
        kind: 'already-solved',
        period: {
          epoch: solvedPeriodRead.record.challengePeriodEpoch,
          periodStartBlock: solvedPeriodRead.record.periodStartBlock,
        },
      };
    }
    const { status } = solvedPeriodRead.value;
    const currentExisting = solvedPeriodRead.currentChallenge?.challenge ?? null;

    // Codex review on PR #357 flagged: short-circuiting on `existingIsCurrent && solved`
    // strands the node when the read-only `getActiveProofPeriodStatus` view is
    // stale (no tx has called `updateAndGetActiveProofPeriodStartBlock` since
    // the wall-clock boundary crossed). Detect this by comparing actual
    // chain block height against the cached period's expiry. If we're past
    // the on-chain boundary, force `createChallenge` so the contract rotates
    // the period and we get a fresh challenge. Otherwise, the cached solved
    // result is genuinely current and we can safely short-circuit.
    //
    // Why not always call createChallenge when solved? The on-chain
    // `createChallenge` REVERTS with "already been solved" when the period
    // hasn't rotated yet (RandomSampling.sol L191-200). So a naive
    // always-call would burn a tick + emit confusing reverts on every
    // post-solve poll inside the same period.
    if (currentExisting?.solved === true) {
      if (solvedPeriodRead.currentChallenge?.stale !== true) {
        this.log.info('rs.tick.already-solved', {
          epoch: currentExisting.epoch.toString(),
          periodStart: currentExisting.activeProofPeriodStartBlock.toString(),
        });
        return {
          kind: 'already-solved',
          period: {
            epoch: currentExisting.epoch,
            periodStartBlock: currentExisting.activeProofPeriodStartBlock,
          },
        };
      }
      // Fall through to createChallenge — period actually rotated on-chain
      // even though the status view hasn't caught up. The chain's
      // updateAndGetActiveProofPeriodStartBlock advances the storage slot
      // inside createChallenge and we get a fresh challenge.
      this.log.info('rs.tick.forcing-rotation', {
        cachedPeriodStart: currentExisting.activeProofPeriodStartBlock.toString(),
        statusPeriodStart: status.activeProofPeriodStartBlock.toString(),
        reason: 'solved-stale',
      });
    }

    const periodKey: PeriodKey = {
      epoch: 0n, // filled in once we have a challenge (epoch is on the challenge)
      periodStartBlock: status.activeProofPeriodStartBlock,
      identityId: this.identityId,
    };

    let challenge: NodeChallenge;
    let cgId: bigint;
    let observedDurationInBlocks: bigint | undefined;
    // Same wall-clock stale check as the solved branch above. Without
    // it, an unsolved challenge whose period has expired (but whose
    // on-chain cursor never advanced because no submit/create tx
    // landed) would be reused forever and starve every subsequent
    // rotation. This is exactly what bricked Base Sepolia testnet
    // after the 2026-05-01 RS-contract Hub rotation.
    const unsolvedStale = currentExisting !== null
      && !currentExisting.solved
      && solvedPeriodRead.currentChallenge?.stale === true;
    if (unsolvedStale) {
      this.log.info('rs.tick.forcing-rotation', {
        cachedPeriodStart: currentExisting!.activeProofPeriodStartBlock.toString(),
        statusPeriodStart: status.activeProofPeriodStartBlock.toString(),
        reason: 'unsolved-stale',
      });
    }
    if (currentExisting !== null && !currentExisting.solved && !unsolvedStale) {
      challenge = currentExisting;
      observedDurationInBlocks = status.proofingPeriodDurationInBlocks;
      cgId = await this.chain.getKAContextGraphId(challenge.knowledgeAssetId);
    } else {
      try {
        const created = await this.chain.createChallenge();
        challenge = created.challenge;
        // A challenge created by this transaction pins the then-effective
        // duration. Unlike an older challenge, it cannot carry a duration from
        // a previous epoch's schedule.
        observedDurationInBlocks = challenge.proofingPeriodDurationInBlocks;
        cgId = created.contextGraphId;
      } catch (err) {
        if (err instanceof NoEligibleContextGraphError) {
          this.log.info('rs.tick.no-eligible-cg', {});
          return { kind: 'no-challenge', reason: 'no-eligible-cg' };
        }
        if (err instanceof NoEligibleKnowledgeCollectionError) {
          this.log.info('rs.tick.no-eligible-kc', {});
          return { kind: 'no-challenge', reason: 'no-eligible-kc' };
        }
        throw err;
      }
    }

    periodKey.epoch = challenge.epoch;
    periodKey.periodStartBlock = challenge.activeProofPeriodStartBlock;
    // Every outcome from here on belongs to this challenge's proof period.
    const period: ChallengePeriod = {
      epoch: challenge.epoch,
      periodStartBlock: challenge.activeProofPeriodStartBlock,
    };
    const kaId = challenge.knowledgeAssetId;
    const chunkId = challenge.chunkId;

    await this.wal.append(
      makeWalEntry(periodKey, 'challenge', {
        kaId: kaId.toString(),
        cgId: cgId.toString(),
        chunkId: chunkId.toString(),
      }),
    );

    if (cgId === 0n) {
      this.log.warn('rs.tick.cg-not-found', { kaId: kaId.toString() });
      await this.wal.append(
        makeWalEntry(periodKey, 'failed', {
          kaId: kaId.toString(),
          error: { code: 'cg-not-found', message: 'getKAContextGraphId returned 0' },
        }),
      );
      return { kind: 'cg-not-found', kaId, period };
    }

    const cooldownTicksRemaining = this.consumeDataCorruptionCooldown(kaId);
    if (cooldownTicksRemaining > 0) {
      this.log.warn('rs.tick.kc-not-synced', {
        kaId: kaId.toString(),
        cgId: cgId.toString(),
        periodStart: periodKey.periodStartBlock.toString(),
        err: 'DataCorruptionCooldown',
        cooldownTicksRemaining,
      });
      await this.wal.append(
        makeWalEntry(periodKey, 'failed', {
          kaId: kaId.toString(),
          cgId: cgId.toString(),
          chunkId: chunkId.toString(),
          error: {
            code: 'DataCorruptionCooldown',
            message: `retry suppressed for ${cooldownTicksRemaining} tick(s) after data-corrupted outcome`,
          },
        }),
      );
      return { kind: 'kc-not-synced', kaId, cgId, period };
    }

    // OT-RFC-49 / WS-B Trap 1 — curation branch + commitment are PINNED on
    // the challenge at issuance. We MUST NOT re-read curation status via a
    // live `getContextGraphAccessPolicy` probe, nor the root/count via live
    // `getCatalogRoot`/`getLatestMerkleRoot`: a mid-period update would make
    // an honest proof fail. `submitProof` verifies against these same pinned
    // values, so the prover builds against them.
    const isCurated = challenge.isCurated;
    const expectedRoot = challenge.challengeRoot;
    const expectedLeafCount = Number(challenge.challengeLeafCount);

    // content-binding: the prover submits the N-Triple CONTENT bytes; the chain
    // derives `leaf = keccak256(content)`. Public path is structured (private as a
    // committed sibling); catalog path is a plain tree (no sibling).
    let contents: Uint8Array[];
    let privateRoots: Uint8Array[];
    let proofKind: 'public' | 'catalog';
    if (isCurated) {
      // OT-RFC-49 / WS-C — curated CGs prove the PUBLIC `_catalog` Merkle
      // root, NOT private ciphertext chunks. The catalog tree is a plain
      // V10MerkleTree (each leaf `hashTripleV10(s,p,o)`), so the proof shape
      // is identical to the public flat-KC path (`'flat-kc'`). On a sync
      // gap (catalog not yet replicated to this core) the extractor throws
      // `CatalogLeavesMissingError`, which we map to the same
      // `kc-not-synced` skip the public path uses for missing data.
      proofKind = 'catalog';
      try {
        const catalogTriples = await extractCatalogLeavesFromStore({
          store: this.store,
          contextGraphId: cgId,
        });
        // catalog is a plain public tree (no private sibling).
        contents = catalogTriples.map((t) => tripleContentV10(t.subject, t.predicate, t.object));
        privateRoots = [];
      } catch (err) {
        if (err instanceof CatalogLeavesMissingError) {
          this.log.warn('rs.tick.kc-not-synced', {
            kaId: kaId.toString(),
            cgId: cgId.toString(),
            periodStart: periodKey.periodStartBlock.toString(),
            err: err.name,
          });
          await this.wal.append(
            makeWalEntry(periodKey, 'failed', {
              kaId: kaId.toString(),
              cgId: cgId.toString(),
              chunkId: chunkId.toString(),
              error: { code: err.name, message: err.message.slice(0, 200) },
            }),
          );
          return { kind: 'kc-not-synced', kaId, cgId, period };
        }
        throw err;
      }
    } else {
      proofKind = 'public';
      try {
        const extracted = await this.extractPublicKnowledgeAssetWithRepair({
          kaId,
          cgId,
          expectedRoot,
          expectedLeafCount: challenge.challengeLeafCount,
          periodStartBlock: periodKey.periodStartBlock,
        });
        // public structured path: contents = N-Triple bytes; private sub-roots -> sibling.
        contents = [...extracted.contents];
        privateRoots = [...extracted.privateRoots];
      } catch (err) {
        if (err instanceof KCNotFoundError || err instanceof KCDataMissingError) {
          this.log.warn('rs.tick.kc-not-synced', {
            kaId: kaId.toString(),
            cgId: cgId.toString(),
            periodStart: periodKey.periodStartBlock.toString(),
            err: (err as Error).name,
          });
          await this.wal.append(
            makeWalEntry(periodKey, 'failed', {
              kaId: kaId.toString(),
              cgId: cgId.toString(),
              chunkId: chunkId.toString(),
              error: {
                code: (err as Error).name,
                message: (err as Error).message.slice(0, 200),
              },
            }),
          );
          return { kind: 'kc-not-synced', kaId, cgId, period };
        }
        if (err instanceof KCRootEntitiesNotFoundError) {
          this.log.error('rs.tick.meta-graph-bug', {
            kaId: kaId.toString(),
            cgId: cgId.toString(),
            ual: err.ual,
          });
          await this.wal.append(
            makeWalEntry(periodKey, 'failed', {
              kaId: kaId.toString(),
              cgId: cgId.toString(),
              chunkId: chunkId.toString(),
              error: { code: 'KCRootEntitiesNotFoundError', message: err.message.slice(0, 200) },
            }),
          );
          this.markDataCorrupted(kaId);
          return { kind: 'data-corrupted', kaId, cgId, reason: 'meta-graph-bug', period };
        }
        throw err;
      }
    }

    await this.wal.append(
      makeWalEntry(periodKey, 'extracted', {
        kaId: kaId.toString(),
        cgId: cgId.toString(),
        chunkId: chunkId.toString(),
      }),
    );

    const expected = { merkleRoot: expectedRoot, merkleLeafCount: expectedLeafCount };
    const req: ProofBuilderRequest =
      proofKind === 'public'
        ? { kind: 'public', contents, privateRoots, chunkId: Number(chunkId), expected }
        : { kind: 'catalog', contents, chunkId: Number(chunkId), expected };

    let material;
    try {
      material = await this.builder.build(req);
    } catch (err) {
      const reason = mapBuilderError(err);
      if (!reason) throw err;
      // Content changed under us mid-period: an UPDATE to the sampled KA flips
      // the live root, so a freshly-extracted proof no longer matches the
      // challenge root. That root is PINNED on the challenge, so if we already
      // built a proof that verified against it earlier this period, reuse it
      // instead of missing an honest proof — this rescues the common
      // submit-retry-after-update path. Otherwise the content genuinely does
      // not match the pinned commitment: skip as before.
      const pinned = this.pinnedMaterialFor(periodKey, kaId, chunkId, expectedRoot);
      if (pinned) {
        this.log.info('rs.tick.pinned-material-reused', {
          kaId: kaId.toString(),
          cgId: cgId.toString(),
          periodStart: periodKey.periodStartBlock.toString(),
          reason,
        });
        material = pinned;
      } else {
        const e = err as any;
        this.log.error('rs.tick.data-corrupted', {
          kaId: kaId.toString(),
          cgId: cgId.toString(),
          periodStart: periodKey.periodStartBlock.toString(),
          reason,
          err: (err as Error).name,
          ...(typeof e?.computedLeafCount === 'number' ? { computedLeafCount: e.computedLeafCount } : {}),
          ...(typeof e?.expectedLeafCount === 'number' ? { expectedLeafCount: e.expectedLeafCount } : {}),
          ...(typeof e?.chunkId === 'number' ? { chunkId: e.chunkId } : {}),
          ...(typeof e?.leafCount === 'number' ? { leafCount: e.leafCount } : {}),
          extractedLeafCount: contents.length,
          chainExpectedLeafCount: Number(expectedLeafCount),
        });
        await this.wal.append(
          makeWalEntry(periodKey, 'failed', {
            kaId: kaId.toString(),
            cgId: cgId.toString(),
            chunkId: chunkId.toString(),
            error: { code: (err as Error).name, message: (err as Error).message.slice(0, 200) },
          }),
        );
        this.markDataCorrupted(kaId);
        return { kind: 'data-corrupted', kaId, cgId, reason, period };
      }
    }
    // Pin the verified material so a mid-period update (surfacing here on a
    // submit retry) reuses it rather than re-extracting stale content.
    this.pinProofMaterial(periodKey, kaId, chunkId, expectedRoot, material);

    await this.wal.append(
      makeWalEntry(periodKey, 'built', {
        kaId: kaId.toString(),
        cgId: cgId.toString(),
        chunkId: chunkId.toString(),
      }),
    );

    let txResult;
    try {
      txResult = await this.chain.submitProof(material.content, material.proof);
    } catch (err) {
      if (err instanceof ChallengeNoLongerActiveError) {
        this.pinnedProofMaterial = undefined;
        this.log.warn('rs.tick.submit-stale', {
          kaId: kaId.toString(),
          cgId: cgId.toString(),
          periodStart: periodKey.periodStartBlock.toString(),
        });
        await this.wal.append(
          makeWalEntry(periodKey, 'failed', {
            kaId: kaId.toString(),
            cgId: cgId.toString(),
            chunkId: chunkId.toString(),
            error: { code: 'ChallengeNoLongerActive', message: err.message.slice(0, 200) },
          }),
        );
        return { kind: 'submit-stale', period };
      }
      if (err instanceof MerkleRootMismatchError) {
        // This material was deterministically rejected by the on-chain
        // verifier. Never retain it for the exception-path retry fallback: a
        // later live-content mismatch must not resubmit proof bytes the chain
        // already proved invalid.
        this.pinnedProofMaterial = undefined;
        // The chain says the root we built does not match the on-chain
        // commitment. We already verified it locally, so this is
        // either (a) a race against an UPDATE that flipped the root,
        // or (b) a bug. Drop the period; rebuild on the next.
        this.log.error('rs.tick.chain-root-mismatch', {
          kaId: kaId.toString(),
          cgId: cgId.toString(),
          periodStart: periodKey.periodStartBlock.toString(),
        });
        await this.wal.append(
          makeWalEntry(periodKey, 'failed', {
            kaId: kaId.toString(),
            cgId: cgId.toString(),
            chunkId: chunkId.toString(),
            error: { code: 'MerkleRootMismatch', message: err.message.slice(0, 200) },
          }),
        );
        this.markDataCorrupted(kaId);
        return { kind: 'data-corrupted', kaId, cgId, reason: 'root-mismatch', period };
      }
      throw err;
    }

    await this.wal.append(
      makeWalEntry(periodKey, 'submitted', {
        kaId: kaId.toString(),
        cgId: cgId.toString(),
        chunkId: chunkId.toString(),
        txHash: txResult.hash,
      }),
    );
    await this.solvedPeriodSkip.observeSubmittedProof({
      observationBindingId: solvedPeriodRead.observationBindingId,
      challenge,
      durationInBlocks: observedDurationInBlocks,
    });
    this.log.info('rs.tick.submitted', {
      kaId: kaId.toString(),
      cgId: cgId.toString(),
      chunkId: chunkId.toString(),
      periodStart: periodKey.periodStartBlock.toString(),
      txHash: txResult.hash,
    });
    return { kind: 'submitted', txHash: txResult.hash, kaId, cgId, chunkId, period };
  }
}

function mapBuilderError(err: unknown): 'root-mismatch' | 'leaf-count-mismatch' | null {
  if (err instanceof V10ProofRootMismatchError) return 'root-mismatch';
  if (err instanceof V10ProofLeafCountMismatchError) return 'leaf-count-mismatch';
  if (err instanceof V10ProofChunkOutOfRangeError) return 'leaf-count-mismatch';
  return null;
}

function uint8ArrayEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function repairMaterialMatchesChallenge(
  material: RandomSamplingRepairMaterial,
  expectedRoot: Uint8Array,
  expectedLeafCount: bigint,
): boolean {
  const computed = structuredKARootV10(
    material.contents.map((content) => keccak256(content)),
    material.privateRoots,
  );
  return BigInt(computed.leafCount) === expectedLeafCount
    && uint8ArrayEquals(computed.root, expectedRoot);
}
