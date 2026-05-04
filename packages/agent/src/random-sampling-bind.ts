/**
 * Thin glue between the agent's lifecycle and the V10 Random Sampling
 * prover (`@origintrail-official/dkg-random-sampling`).
 *
 * Why this lives in `dkg-agent` and not in `dkg-random-sampling`:
 *  - The prover package is generic — chain + store + identity. It
 *    knows nothing about the agent's setInterval / start / stop
 *    discipline.
 *  - This file is the seam where role gating and tick scheduling
 *    happen. Edge nodes never reach the constructor; core nodes get
 *    a 30s timer that calls `prover.tick()`.
 *  - Test surface stays small: the prover has its own unit tests; the
 *    agent's tests only need to verify "core spawns, edge does not".
 */

import {
  RandomSamplingProver,
  WorkerThreadProofBuilder,
  InProcessProofBuilder,
  FileProverWal,
  InMemoryProverWal,
  startProverLoop,
  type ProofBuilder,
  type ProverLogger,
  type ProverLoopStatus,
  type ProverWal,
  type TickOutcome,
} from '@origintrail-official/dkg-random-sampling';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export type AgentRole = 'core' | 'edge';

export interface RandomSamplingBindOptions {
  role: AgentRole;
  chain: ChainAdapter;
  store: TripleStore;
  /** Identity of THIS node. Must be > 0n; bind aborts (no-op) on 0. */
  identityId: bigint;
  /**
   * Time-driven tick cadence. Default 30s. The orchestrator is
   * idempotent under double-ticks (already-solved short-circuit), so
   * a fast cadence is safe; a slow one risks missing a period if the
   * proof window is shorter than the cadence. Default chosen so the
   * agent's event loop is barely tickled.
   */
  tickIntervalMs?: number;
  /**
   * File path for the prover WAL. When omitted, an in-memory WAL is
   * used (suitable for tests + dev; production SHOULD set this so
   * prover transitions survive restarts for diagnostics and future
   * recovery tooling).
   */
  walPath?: string;
  /**
   * When true, run the V10MerkleTree build on a `worker_threads`
   * worker instead of the agent's main thread. Default true on core;
   * set false in tests where spawning a worker is undesirable.
   */
  useWorkerThread?: boolean;
  /** Optional structured logger; default no-op. */
  log?: ProverLogger;
  /**
   * Hook fired after every tick — observability only. Errors thrown
   * by the hook are caught and logged so the prover stays running.
   */
  onTick?: (outcome: TickOutcome) => void;
}

/**
 * Status snapshot returned by {@link RandomSamplingHandle.getStatus}.
 * Same shape regardless of whether the handle is active (`enabled` =
 * true) or a no-op stub — disabled handles report empty stats so
 * callers don't have to branch.
 */
export interface RandomSamplingStatus {
  enabled: boolean;
  role: AgentRole;
  identityId: string;
  loop: ProverLoopStatus | null;
}

/**
 * Handle returned by {@link bindRandomSampling}. The agent owns its
 * lifetime: `start()` is called once after the agent's chain +
 * identity are ready; `stop()` is called from the agent's shutdown
 * path. Both are idempotent.
 */
export interface RandomSamplingHandle {
  readonly enabled: boolean;
  start(): void;
  stop(): Promise<void>;
  getStatus(): RandomSamplingStatus;
}

const DEFAULT_TICK_INTERVAL_MS = 30_000;

/**
 * Build a Random Sampling handle for the agent. Returns a no-op
 * handle when `role !== 'core'` or `identityId === 0n`, so callers
 * can wire this in unconditionally and the gating is internal.
 */
export async function bindRandomSampling(
  opts: RandomSamplingBindOptions,
): Promise<RandomSamplingHandle> {
  if (opts.role !== 'core' || opts.identityId === 0n) {
    return makeNoopHandle(opts.role, opts.identityId);
  }

  // Validate the chain adapter has the methods the prover needs.
  // Surface the missing-method error here (with a clear message) instead
  // of letting the first tick fail mid-flight.
  const required = [
    'getActiveProofPeriodStatus', 'createChallenge', 'submitProof',
    'getNodeChallenge', 'getLatestMerkleRoot', 'getMerkleLeafCount',
    'getKCContextGraphId',
  ] as const;
  const missing = required.filter(
    (m) => typeof (opts.chain as unknown as Record<string, unknown>)[m] !== 'function',
  );
  if (missing.length > 0) {
    opts.log?.warn('rs.bind.missing-methods', { missing });
    return makeNoopHandle(opts.role, opts.identityId);
  }
  const readiness = (opts.chain as { isRandomSamplingReady?: () => boolean }).isRandomSamplingReady;
  if (typeof readiness === 'function' && !readiness.call(opts.chain)) {
    opts.log?.warn('rs.bind.not-deployed', {
      reason: 'RandomSampling/RandomSamplingStorage not resolved on chain adapter',
    });
    return makeNoopHandle(opts.role, opts.identityId);
  }

  const wal: ProverWal = opts.walPath
    ? await FileProverWal.open(opts.walPath)
    : new InMemoryProverWal();

  const builder: ProofBuilder = (opts.useWorkerThread ?? true)
    ? new WorkerThreadProofBuilder()
    : new InProcessProofBuilder();

  const prover = new RandomSamplingProver({
    chain: opts.chain,
    store: opts.store,
    identityId: opts.identityId,
    builder,
    wal,
    log: opts.log,
  });

  const loop = startProverLoop({
    prover,
    intervalMs: opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS,
    onTick: opts.onTick,
    log: opts.log,
  });

  return {
    enabled: true,
    start: () => loop.start(),
    stop: () => loop.stop(),
    getStatus: (): RandomSamplingStatus => ({
      enabled: true,
      role: opts.role,
      identityId: opts.identityId.toString(),
      loop: loop.getStatus(),
    }),
  };
}

function makeNoopHandle(role: AgentRole, identityId: bigint): RandomSamplingHandle {
  return {
    enabled: false,
    start: () => undefined,
    stop: async () => undefined,
    getStatus: (): RandomSamplingStatus => ({
      enabled: false,
      role,
      identityId: identityId.toString(),
      loop: null,
    }),
  };
}
