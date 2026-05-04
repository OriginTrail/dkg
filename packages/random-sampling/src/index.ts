/**
 * Off-chain Random Sampling prover for V10 KCs.
 *
 * Hosts the prover orchestrator (period polling, challenge resolution,
 * V10 Merkle proof construction in a worker thread, `submitProof`
 * broadcast) and the optional core-to-core mutual-aid protocol used
 * when a challenged KC isn't fully present in the local triple store.
 *
 * Phase 1 (chain reads) lives in `@origintrail-official/dkg-chain`.
 * Phase 2 (pure proof builder) lives in
 * `@origintrail-official/dkg-core` as `proof-material`. Phase 3 onward
 * (KC extractor, prover loop, mutual aid, role gating) lands here.
 *
 * The agent never reaches into this package directly — it goes through
 * `packages/agent/src/random-sampling-bind.ts`, which constructs the
 * prover from `{ chain, store, walletProvider, p2p }` and enforces
 * edge/core role gating before any prover or mutual-aid handler is
 * registered.
 */

export const RANDOM_SAMPLING_PACKAGE_VERSION = '10.0.0-rc.2';

export {
  extractV10KCFromStore,
  extractV10KCQuads,
  KCNotFoundError,
  KCRootEntitiesNotFoundError,
  KCDataMissingError,
  type KCTriple,
  type KCExtractionResult,
} from './kc-extractor.js';

export {
  type ProofBuilder,
  type ProofBuilderRequest,
  InProcessProofBuilder,
} from './proof-builder.js';

export {
  WorkerThreadProofBuilder,
  WorkerCrashedError,
  type WorkerThreadProofBuilderOptions,
} from './proof-worker.js';

export {
  RandomSamplingProver,
  type RandomSamplingProverDeps,
  type ProverLogger,
  type TickOutcome,
} from './prover.js';

export {
  startProverLoop,
  type ProverLoopOptions,
  type ProverLoopHandle,
  type ProverLoopStatus,
  type TickableProver,
} from './prover-loop.js';

export {
  type ProverPeriodStatus,
  type ProverWalEntry,
  type ProverWal,
  type PeriodKey,
  InMemoryProverWal,
  FileProverWal,
  makeWalEntry,
  periodKeyEquals,
} from './wal.js';
