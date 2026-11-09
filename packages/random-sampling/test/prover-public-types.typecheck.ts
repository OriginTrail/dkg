import type { TickOutcome, ProverLoopStatus, TickableProver } from '../src/index.js';

// Existing third-party producers and status mocks remain source-compatible.
const outcomes: TickOutcome[] = [
  { kind: 'already-solved' }, { kind: 'cg-not-found', kaId: 1n },
  { kind: 'kc-not-synced', kaId: 1n, cgId: 2n },
  { kind: 'data-corrupted', kaId: 1n, cgId: 2n, reason: 'root-mismatch' },
  { kind: 'submit-stale' },
  { kind: 'submitted', txHash: '0x', kaId: 1n, cgId: 2n, chunkId: 0n },
  { kind: 'error', error: new Error('legacy error') },
];
const prover: TickableProver = { tick: async () => outcomes[0], close: async () => {} };
const status: ProverLoopStatus = {
  totalTicks: 0, inflight: false, lastTickAt: null, lastOutcome: null,
  submittedCount: 0, lastSubmittedTxHash: null, lastSubmittedAt: null,
};
void prover;
void status;
