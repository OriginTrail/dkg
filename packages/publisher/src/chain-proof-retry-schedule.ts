/**
 * The held-job chain-proof retry schedule, extracted whole (PR #2373 r2 3879930153): the
 * attempt map, due checks, cadence selection, delay arithmetic, and cleanup live HERE, so the
 * publisher loop consumes dispatch outcomes and delegates scheduling without carrying backoff
 * arithmetic or phase branches. INTERNAL — deliberately not exported from the package barrel.
 *
 * Entries are keyed by the IMMUTABLE incarnation identity (r6 3882185608), not by jobId: a
 * writer can only address its own incarnation's entry, so a late echo from a superseded pass
 * cannot clobber a successor's schedule BY CONSTRUCTION — the verified/unverified mutation
 * split this replaces was guarding a hazard the key model now makes unrepresentable. The jobId
 * enters only through a pruning index with ONE authority rule: only `isDue` — driven by the
 * pass's inventory snapshot, the authoritative statement of which incarnation currently owns a
 * jobId — may re-point the index (pruning the superseded incarnation's entry); `defer` records
 * an outcome for a turn the inventory admitted, so a defer whose identity disagrees with the
 * index is a superseded echo and is dropped whole. This keeps the map bounded (one live entry
 * per jobId once its current incarnation is observed) without ever trusting a writer about
 * currency.
 *
 * The ladder (r18 🔴 3816322914 anti-herd design, unchanged): base 30s doubling per attempt,
 * jittered by +0..25% of the computed delay so a population held by ONE incident does not come
 * due in lockstep. Capped so a long-held job is still asked periodically, never deferred to
 * effectively never. The `awaiting-confirmations` cadence (a pending verdict whose receipt is
 * observed but not yet at the operator-selected confirmation depth — an answer changing block
 * by block) tightens ONLY the ceiling, and that ceiling is TRUE post-jitter: the ladder base is
 * capped at `ceiling / (1 + jitter)` so the jittered delay can never exceed two minutes, while
 * jitter keeps its spread below it. Growth and the attempt count are cadence-independent.
 */

const CHAIN_PROOF_BACKOFF_BASE_MS = 30_000;
const CHAIN_PROOF_BACKOFF_MAX_MS = 10 * 60_000;
/** Jitter as a FRACTION of the computed backoff, so spread scales with the wait it spreads. */
const CHAIN_PROOF_BACKOFF_JITTER = 0.25;
const CHAIN_PROOF_AWAITING_CONFIRMATIONS_BACKOFF_MAX_MS = 2 * 60_000;
const CHAIN_PROOF_AWAITING_CONFIRMATIONS_BASE_CAP_MS = Math.floor(
  CHAIN_PROOF_AWAITING_CONFIRMATIONS_BACKOFF_MAX_MS / (1 + CHAIN_PROOF_BACKOFF_JITTER),
);

export type ChainProofRetryCadence = 'awaiting-confirmations' | 'default';

export class ChainProofRetrySchedule {
  /** Backoff state per INCARNATION — the key a stale writer cannot forge. */
  private readonly entries = new Map<string, { dueAt: number; attempts: number }>();
  /** jobId → the incarnation the inventory last observed owning it; pruning only. */
  private readonly currentIncarnation = new Map<string, string>();

  constructor(
    private readonly deps: { now(): number; rand(): number },
  ) {}

  /**
   * Due when this incarnation was never deferred or its deferral has elapsed. The inventory
   * snapshot behind this call is the ONE authority on which incarnation owns `jobId` now, so
   * this is also where a superseded incarnation's entry is pruned and the index re-pointed —
   * a successor never waits out a predecessor's due time. `atMs` is the caller's pass snapshot
   * so one pass judges the whole population at one instant.
   */
  isDue(jobId: string, identity: string, atMs: number): boolean {
    const known = this.currentIncarnation.get(jobId);
    if (known !== undefined && known !== identity) this.entries.delete(known);
    this.currentIncarnation.set(jobId, identity);
    const entry = this.entries.get(identity);
    if (!entry) return true;
    return entry.dueAt <= atMs;
  }

  /**
   * A turn that established nothing defers the next one — writing ONLY this incarnation's own
   * entry. A superseded echo therefore cannot reach a successor's schedule by construction, and
   * it does not touch the index either (isDue is the index's only writer): the echo's dead
   * entry is pruned at the next authoritative due check. A guard comparing the caller against
   * the index was removed as REDUNDANT (r6/r7 mutant evidence: no observable its removal
   * changes — the key model plus the isDue self-heal already deliver the invariant).
   */
  defer(jobId: string, identity: string, cadence: ChainProofRetryCadence): void {
    void jobId;
    const prior = this.entries.get(identity);
    const attempts = (prior ? prior.attempts : 0) + 1;
    const capMs = cadence === 'awaiting-confirmations'
      ? CHAIN_PROOF_AWAITING_CONFIRMATIONS_BASE_CAP_MS
      : CHAIN_PROOF_BACKOFF_MAX_MS;
    const backoffMs = Math.min(CHAIN_PROOF_BACKOFF_BASE_MS * 2 ** (attempts - 1), capMs);
    this.entries.set(identity, {
      dueAt: this.deps.now() + backoffMs + Math.floor(this.deps.rand() * backoffMs * CHAIN_PROOF_BACKOFF_JITTER),
      attempts,
    });
  }

  /** A settled job's schedule is history — for the settling incarnation and its index slot. */
  settled(jobId: string, identity: string): void {
    this.entries.delete(identity);
    if (this.currentIncarnation.get(jobId) === identity) this.currentIncarnation.delete(jobId);
  }
}
