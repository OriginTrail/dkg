/**
 * The held-job chain-proof retry schedule, extracted whole (PR #2373 r2 3879930153): the
 * attempt map, due checks, cadence selection, delay arithmetic, and cleanup live HERE, so the
 * publisher loop consumes dispatch outcomes and delegates scheduling without carrying backoff
 * arithmetic or phase branches. INTERNAL — deliberately not exported from the package barrel.
 *
 * ONE map, keyed by jobId, each entry remembering the INCARNATION that earned it (PR #2373 r8
 * 3882533273 — the follow-up that replaced the dual-map protocol): ownership has a single
 * source of truth, so every operation answers locally. A due check for a different incarnation
 * than the entry's is a successor observation — the predecessor's entry is REPLACED by
 * immediate dueness, never waited out. A deferral whose incarnation disagrees with the stored
 * entry is a superseded echo and is dropped whole — it can neither reset the successor's ladder
 * nor leave an unreachable entry behind (the leak the split-map version retained: a late echo
 * re-creating its dead entry after pruning, PR #2373 r8 🔴 3882533655). A deferral with no
 * entry present starts its own ladder — first contact for that incarnation. `settled` clears
 * only its own incarnation's entry. The map is bounded by live job count BY CONSTRUCTION:
 * every write lands on the jobId slot.
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
  /** ONE entry per jobId; the incarnation field is the ownership check every mutation makes. */
  private readonly entries = new Map<string, { identity: string; dueAt: number; attempts: number }>();

  constructor(
    private readonly deps: { now(): number; rand(): number },
  ) {}

  /**
   * Due when nothing is scheduled for this jobId, when the entry belongs to a DIFFERENT
   * incarnation (the inventory's word that the record moved on — the successor never waits out
   * the predecessor's due time), or when the deferral has elapsed. `atMs` is the caller's pass
   * snapshot so one pass judges the whole population at one instant.
   */
  isDue(jobId: string, identity: string, atMs: number): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return true;
    if (entry.identity !== identity) {
      // Successor observation: the predecessor's schedule is REPLACED by immediate dueness —
      // and deleted here, so the successor's own first deferral finds the slot free rather
      // than being dropped against a leftover. (A rare echo racing into the freed slot before
      // that deferral is transient and self-correcting: the next due check replaces it; the
      // slot model keeps it bounded either way.)
      this.entries.delete(jobId);
      return true;
    }
    return entry.dueAt <= atMs;
  }

  /**
   * A turn that established nothing defers the next one. An existing entry owned by a DIFFERENT
   * incarnation means this deferral is a superseded echo — dropped whole (r8 🔴 3882533655: the
   * echo may neither reset the successor's ladder nor be retained as unreachable state). An
   * absent entry or this incarnation's own continues/starts the ladder.
   */
  defer(jobId: string, identity: string, cadence: ChainProofRetryCadence): void {
    const entry = this.entries.get(jobId);
    if (entry && entry.identity !== identity) return;
    const attempts = (entry ? entry.attempts : 0) + 1;
    const capMs = cadence === 'awaiting-confirmations'
      ? CHAIN_PROOF_AWAITING_CONFIRMATIONS_BASE_CAP_MS
      : CHAIN_PROOF_BACKOFF_MAX_MS;
    const backoffMs = Math.min(CHAIN_PROOF_BACKOFF_BASE_MS * 2 ** (attempts - 1), capMs);
    this.entries.set(jobId, {
      identity,
      dueAt: this.deps.now() + backoffMs + Math.floor(this.deps.rand() * backoffMs * CHAIN_PROOF_BACKOFF_JITTER),
      attempts,
    });
  }

  /** A settled job's schedule is history — when it is still this incarnation's to clear. */
  settled(jobId: string, identity: string): void {
    const entry = this.entries.get(jobId);
    if (entry && entry.identity !== identity) return;
    this.entries.delete(jobId);
  }

  /**
   * The retention observable (r8 🔴 3882533655): the boundedness claim is a testable number,
   * not prose. One entry per live jobId is the invariant.
   */
  retainedEntryCount(): number {
    return this.entries.size;
  }
}
