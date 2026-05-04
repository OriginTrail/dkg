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
} from './kc-extractor.js';
import type { ProofBuilder } from './proof-builder.js';
import { InProcessProofBuilder } from './proof-builder.js';
import {
  makeWalEntry,
  type PeriodKey,
  type ProverWal,
} from './wal.js';
import { InMemoryProverWal } from './wal.js';

/**
 * Outcome reported by `tick()`. The orchestrator's caller (the
 * agent's epoch loop) uses these to drive observability + retry
 * cadence — never to decide "should I tick again", because the next
 * tick is governed by chain state, not the previous outcome.
 */
export type TickOutcome =
  /** Reserved. Currently unreachable — see `tickImpl` for why we no
   *  longer trust view-side `isValid: false`. Kept in the union so
   *  downstream consumers (`prover-loop`, `random-sampling-bind`)
   *  can pattern-match on it without breakage if a stricter
   *  period-closed gate is reintroduced (e.g. duration == 0). */
  | { kind: 'period-closed' }
  | { kind: 'no-challenge'; reason: 'no-eligible-cg' | 'no-eligible-kc' }
  | { kind: 'already-solved' }
  | { kind: 'cg-not-found'; kcId: bigint }
  | { kind: 'kc-not-synced'; kcId: bigint; cgId: bigint }
  | {
      kind: 'data-corrupted';
      kcId: bigint;
      cgId: bigint;
      reason: 'root-mismatch' | 'leaf-count-mismatch' | 'meta-graph-bug';
    }
  | { kind: 'submit-stale' }
  | { kind: 'submitted'; txHash: string; kcId: bigint; cgId: bigint; chunkId: bigint }
  | { kind: 'error'; error: Error };

export interface RandomSamplingProverDeps {
  chain: ChainAdapter;
  store: TripleStore;
  /** Identity of THIS node — used to read challenges + skip already-solved periods. */
  identityId: bigint;
  builder?: ProofBuilder;
  wal?: ProverWal;
  /** Hook for observability / structured logs. Default = no-op. */
  log?: ProverLogger;
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
  private inflight: Promise<TickOutcome> | null = null;

  constructor(deps: RandomSamplingProverDeps) {
    this.chain = deps.chain;
    this.store = deps.store;
    this.identityId = deps.identityId;
    this.builder = deps.builder ?? new InProcessProofBuilder();
    this.wal = deps.wal ?? new InMemoryProverWal();
    this.log = deps.log ?? noopLog;
  }

  /** Single-flight tick. Concurrent callers await the same result. */
  async tick(): Promise<TickOutcome> {
    if (this.inflight) return this.inflight;
    this.inflight = this.tickImpl().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Release builder + WAL handles. Idempotent. */
  async close(): Promise<void> {
    await this.builder.close();
    await this.wal.close();
  }

  /**
   * Detect "the cached challenge's proof period has already elapsed in
   * wall-clock terms, even though no on-chain tx has advanced the
   * `activeProofPeriodStartBlock` storage cursor yet". Returns true
   * when we should force a `createChallenge` to make the chain rotate.
   *
   * Applies to BOTH solved-and-stale (poll-after-success while period
   * actually rotated) AND unsolved-and-stale (testnet 2026-05-01: an
   * RS-contract Hub rotation left every node holding an unsolvable
   * challenge from a long-expired period; with no tx ever calling
   * submitProof / createChallenge the cursor froze, so
   * `existingIsCurrent` stayed truthy forever and the prover never
   * tried to rotate. Wall-clock comparison breaks the deadlock.)
   *
   * Codex round 2 on PR #369 — the on-chain
   * `updateAndGetActiveProofPeriodStartBlock()` rolls forward using
   * the CURRENT epoch's
   * `RandomSampling.getActiveProofingPeriodDurationInBlocks()`, NOT
   * whatever duration was baked into a cached `NodeChallenge` at
   * creation time. If governance shortens the proofing duration
   * mid-flight, the cached duration overstates expiry and the same
   * `kc-not-synced` deadlock reappears at the rollover. So when the
   * adapter exposes the live duration on `ProofPeriodStatus`
   * (modern EVM/mock adapters), prefer it; fall back to
   * `existing.proofingPeriodDurationInBlocks` only for legacy adapters
   * that don't yet populate the field.
   *
   * Robust to chain adapters that don't expose `getBlockNumber` (mock
   * / test): falls back to "not stale" so the existing short-circuit
   * behaviour is preserved.
   */
  private async isCachedChallengeStale(
    existing: NodeChallenge,
    liveDurationInBlocks?: bigint,
  ): Promise<boolean> {
    if (!this.chain.getBlockNumber) return false;
    const duration = liveDurationInBlocks ?? existing.proofingPeriodDurationInBlocks;
    if (duration <= 0n) return false;
    let currentBlock: number;
    try {
      currentBlock = await this.chain.getBlockNumber();
    } catch {
      return false;
    }
    const periodEndBlock = existing.activeProofPeriodStartBlock + duration;
    return BigInt(currentBlock) >= periodEndBlock;
  }

  private async tickImpl(): Promise<TickOutcome> {
    if (
      !this.chain.getActiveProofPeriodStatus ||
      !this.chain.createChallenge ||
      !this.chain.submitProof ||
      !this.chain.getNodeChallenge ||
      !this.chain.getLatestMerkleRoot ||
      !this.chain.getMerkleLeafCount ||
      !this.chain.getKCContextGraphId
    ) {
      throw new Error(
        'RandomSamplingProver: chain adapter missing required RandomSampling / KC view methods',
      );
    }

    // Read the period status + existing challenge in parallel. We
    // *don't* short-circuit on `!status.isValid`: that view-side
    // check stalls single-tenant deployments indefinitely because no
    // external tx ever triggers `updateAndGetActiveProofPeriodStartBlock`.
    // The on-chain `createChallenge` auto-rotates the period inside
    // `_generateChallenge`, so we always proceed and let the chain
    // (a) decide what the current period actually is and (b) reject
    // submissions for stale periods via `ChallengeNoLongerActive`.
    const [status, existing] = await Promise.all([
      this.chain.getActiveProofPeriodStatus(),
      this.chain.getNodeChallenge(this.identityId),
    ]);

    // Existing is "current" iff its period-start block matches the
    // status read. If status was stale, existing's period block
    // matches the same stale snapshot and we still try to use it —
    // the chain rejects on submit if the boundary actually crossed.
    // If status is fresh but existing is from a previous period
    // (rotation happened), we discard existing and force a rotation
    // by calling `createChallenge` below.
    const existingIsCurrent =
      existing !== null
      && existing.activeProofPeriodStartBlock === status.activeProofPeriodStartBlock;

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
    if (existingIsCurrent && existing.solved) {
      const isStale = await this.isCachedChallengeStale(
        existing,
        status.proofingPeriodDurationInBlocks,
      );
      if (!isStale) {
        this.log.info('rs.tick.already-solved', {
          epoch: existing.epoch.toString(),
          periodStart: existing.activeProofPeriodStartBlock.toString(),
        });
        return { kind: 'already-solved' };
      }
      // Fall through to createChallenge — period actually rotated on-chain
      // even though the status view hasn't caught up. The chain's
      // updateAndGetActiveProofPeriodStartBlock advances the storage slot
      // inside createChallenge and we get a fresh challenge.
      this.log.info('rs.tick.forcing-rotation', {
        cachedPeriodStart: existing.activeProofPeriodStartBlock.toString(),
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
    // Same wall-clock stale check as the solved branch above. Without
    // it, an unsolved challenge whose period has expired (but whose
    // on-chain cursor never advanced because no submit/create tx
    // landed) would be reused forever and starve every subsequent
    // rotation. This is exactly what bricked Base Sepolia testnet
    // after the 2026-05-01 RS-contract Hub rotation.
    const unsolvedStale = existingIsCurrent
      && !existing.solved
      && (await this.isCachedChallengeStale(
        existing,
        status.proofingPeriodDurationInBlocks,
      ));
    if (unsolvedStale) {
      this.log.info('rs.tick.forcing-rotation', {
        cachedPeriodStart: existing.activeProofPeriodStartBlock.toString(),
        statusPeriodStart: status.activeProofPeriodStartBlock.toString(),
        reason: 'unsolved-stale',
      });
    }
    if (existingIsCurrent && !existing.solved && !unsolvedStale) {
      challenge = existing;
      cgId = await this.chain.getKCContextGraphId(challenge.knowledgeCollectionId);
    } else {
      try {
        const created = await this.chain.createChallenge();
        challenge = created.challenge;
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
    const kcId = challenge.knowledgeCollectionId;
    const chunkId = challenge.chunkId;

    await this.wal.append(
      makeWalEntry(periodKey, 'challenge', {
        kcId: kcId.toString(),
        cgId: cgId.toString(),
        chunkId: chunkId.toString(),
      }),
    );

    if (cgId === 0n) {
      this.log.warn('rs.tick.cg-not-found', { kcId: kcId.toString() });
      await this.wal.append(
        makeWalEntry(periodKey, 'failed', {
          kcId: kcId.toString(),
          error: { code: 'cg-not-found', message: 'getKCContextGraphId returned 0' },
        }),
      );
      return { kind: 'cg-not-found', kcId };
    }

    const expectedRoot = await this.chain.getLatestMerkleRoot(kcId);
    const expectedLeafCount = await this.chain.getMerkleLeafCount(kcId);

    let leaves: Uint8Array[];
    try {
      const extracted = await extractV10KCFromStore(this.store, cgId, kcId);
      leaves = extracted.leaves;
    } catch (err) {
      if (err instanceof KCNotFoundError || err instanceof KCDataMissingError) {
        this.log.warn('rs.tick.kc-not-synced', {
          kcId: kcId.toString(),
          cgId: cgId.toString(),
          err: (err as Error).name,
        });
        await this.wal.append(
          makeWalEntry(periodKey, 'failed', {
            kcId: kcId.toString(),
            cgId: cgId.toString(),
            chunkId: chunkId.toString(),
            error: {
              code: (err as Error).name,
              message: (err as Error).message.slice(0, 200),
            },
          }),
        );
        return { kind: 'kc-not-synced', kcId, cgId };
      }
      if (err instanceof KCRootEntitiesNotFoundError) {
        this.log.error('rs.tick.meta-graph-bug', {
          kcId: kcId.toString(),
          cgId: cgId.toString(),
          ual: err.ual,
        });
        await this.wal.append(
          makeWalEntry(periodKey, 'failed', {
            kcId: kcId.toString(),
            cgId: cgId.toString(),
            chunkId: chunkId.toString(),
            error: { code: 'KCRootEntitiesNotFoundError', message: err.message.slice(0, 200) },
          }),
        );
        return { kind: 'data-corrupted', kcId, cgId, reason: 'meta-graph-bug' };
      }
      throw err;
    }

    await this.wal.append(
      makeWalEntry(periodKey, 'extracted', {
        kcId: kcId.toString(),
        cgId: cgId.toString(),
        chunkId: chunkId.toString(),
      }),
    );

    let material;
    try {
      material = await this.builder.build({
        leaves,
        chunkId: Number(chunkId),
        expected: { merkleRoot: expectedRoot, merkleLeafCount: expectedLeafCount },
      });
    } catch (err) {
      const reason = mapBuilderError(err);
      if (reason) {
        this.log.error('rs.tick.data-corrupted', {
          kcId: kcId.toString(),
          cgId: cgId.toString(),
          reason,
          err: (err as Error).name,
        });
        await this.wal.append(
          makeWalEntry(periodKey, 'failed', {
            kcId: kcId.toString(),
            cgId: cgId.toString(),
            chunkId: chunkId.toString(),
            error: { code: (err as Error).name, message: (err as Error).message.slice(0, 200) },
          }),
        );
        return { kind: 'data-corrupted', kcId, cgId, reason };
      }
      throw err;
    }

    await this.wal.append(
      makeWalEntry(periodKey, 'built', {
        kcId: kcId.toString(),
        cgId: cgId.toString(),
        chunkId: chunkId.toString(),
      }),
    );

    let txResult;
    try {
      txResult = await this.chain.submitProof(material.leaf, material.proof);
    } catch (err) {
      if (err instanceof ChallengeNoLongerActiveError) {
        this.log.warn('rs.tick.submit-stale', {
          kcId: kcId.toString(),
          cgId: cgId.toString(),
        });
        await this.wal.append(
          makeWalEntry(periodKey, 'failed', {
            kcId: kcId.toString(),
            cgId: cgId.toString(),
            chunkId: chunkId.toString(),
            error: { code: 'ChallengeNoLongerActive', message: err.message.slice(0, 200) },
          }),
        );
        return { kind: 'submit-stale' };
      }
      if (err instanceof MerkleRootMismatchError) {
        // The chain says the root we built does not match the on-chain
        // commitment. We already verified it locally, so this is
        // either (a) a race against an UPDATE that flipped the root,
        // or (b) a bug. Drop the period; rebuild on the next.
        this.log.error('rs.tick.chain-root-mismatch', {
          kcId: kcId.toString(),
          cgId: cgId.toString(),
        });
        await this.wal.append(
          makeWalEntry(periodKey, 'failed', {
            kcId: kcId.toString(),
            cgId: cgId.toString(),
            chunkId: chunkId.toString(),
            error: { code: 'MerkleRootMismatch', message: err.message.slice(0, 200) },
          }),
        );
        return { kind: 'data-corrupted', kcId, cgId, reason: 'root-mismatch' };
      }
      throw err;
    }

    await this.wal.append(
      makeWalEntry(periodKey, 'submitted', {
        kcId: kcId.toString(),
        cgId: cgId.toString(),
        chunkId: chunkId.toString(),
        txHash: txResult.hash,
      }),
    );
    this.log.info('rs.tick.submitted', {
      kcId: kcId.toString(),
      cgId: cgId.toString(),
      chunkId: chunkId.toString(),
      txHash: txResult.hash,
    });
    return { kind: 'submitted', txHash: txResult.hash, kcId, cgId, chunkId };
  }
}

function mapBuilderError(err: unknown): 'root-mismatch' | 'leaf-count-mismatch' | null {
  if (err instanceof V10ProofRootMismatchError) return 'root-mismatch';
  if (err instanceof V10ProofLeafCountMismatchError) return 'leaf-count-mismatch';
  if (err instanceof V10ProofChunkOutOfRangeError) return 'leaf-count-mismatch';
  return null;
}
