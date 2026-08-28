/**
 * The held-job chain-proof retry schedule, extracted whole (PR #2373 r2 3879930153): the
 * attempt map, due checks, cadence selection, delay arithmetic, and cleanup live HERE, so the
 * publisher loop consumes dispatch outcomes and delegates scheduling without carrying backoff
 * arithmetic or phase branches. INTERNAL — deliberately not exported from the package barrel.
 *
 * Scheduling state is IDENTITY-AWARE (r2 3879930149): entries are keyed by jobId — the queue's
 * stable handle — but each entry remembers which held-job INCARNATION earned it
 * (`failedFromState|code|failedAt`; a re-failed successor always carries a fresh `failedAt`
 * from the injected clock). A successor sharing the predecessor's jobId neither waits out the
 * predecessor's due time nor inherits its attempt count: it is due immediately and its first
 * deferral starts the ladder at the base. The identity comparison happens at BOTH read points
 * (dueness and deferral), so a stale verdict's no-op cannot strand the predecessor's ladder on
 * the successor, and a concurrent successor's own earned entry is never clobbered — a deferral
 * only continues a ladder its own incarnation built.
 *
 * The ladder (r18 🔴 3816322914 anti-herd design, unchanged): base 30s doubling per attempt,
 * jittered by +0..25% of the computed delay so a population held by ONE incident does not come
 * due in lockstep. Capped so a long-held job is still asked periodically, never deferred to
 * effectively never. The `awaiting-confirmations` cadence (a pending verdict whose receipt is
 * observed but not yet at the operator-selected confirmation depth — an answer changing block
 * by block) tightens ONLY the ceiling, and that ceiling is TRUE post-jitter: the ladder base is
 * capped at `ceiling / (1 + jitter)` so the jittered delay can never exceed two minutes, while
 * jitter keeps its spread below it. Growth and the shared attempt count are cadence-independent.
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
  private readonly entries = new Map<string, { dueAt: number; attempts: number; identity: string }>();

  constructor(
    private readonly deps: { now(): number; rand(): number },
  ) {}

  /**
   * Due when never deferred, when the deferral's time has passed, or when the entry belongs to
   * a DIFFERENT incarnation — the successor never waits out the predecessor's due time.
   * `atMs` is the caller's pass snapshot so one pass judges the whole population at one instant.
   */
  isDue(jobId: string, identity: string, atMs: number): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return true;
    if (entry.identity !== identity) return true;
    return entry.dueAt <= atMs;
  }

  /**
   * A VERIFIED turn that established nothing defers the next one — verified meaning the caller
   * re-read the record under the claim lock and confirmed it is still this incarnation, so a
   * predecessor's leftover entry may be superseded: a different prior identity starts the
   * ladder at the base (the predecessor's exponent is its own history, not the successor's).
   */
  defer(jobId: string, identity: string, cadence: ChainProofRetryCadence): void {
    const prior = this.entries.get(jobId);
    this.write(jobId, identity, cadence,
      (prior && prior.identity === identity ? prior.attempts : 0) + 1);
  }

  /**
   * An UNVERIFIED deferral (r4 3881841010) — the caller could not re-establish which
   * incarnation the jobId currently names (the exception path has no re-read). It lands only on
   * an absent entry or this incarnation's own; a FOREIGN entry is schedule the successor
   * earned, and a late echo from a superseded pass may not touch it — not the due time, not the
   * attempt count.
   */
  deferUnverified(jobId: string, identity: string, cadence: ChainProofRetryCadence): void {
    const prior = this.entries.get(jobId);
    if (prior && prior.identity !== identity) return;
    this.write(jobId, identity, cadence, (prior ? prior.attempts : 0) + 1);
  }

  private write(jobId: string, identity: string, cadence: ChainProofRetryCadence, attempts: number): void {
    const capMs = cadence === 'awaiting-confirmations'
      ? CHAIN_PROOF_AWAITING_CONFIRMATIONS_BASE_CAP_MS
      : CHAIN_PROOF_BACKOFF_MAX_MS;
    const backoffMs = Math.min(CHAIN_PROOF_BACKOFF_BASE_MS * 2 ** (attempts - 1), capMs);
    this.entries.set(jobId, {
      dueAt: this.deps.now() + backoffMs + Math.floor(this.deps.rand() * backoffMs * CHAIN_PROOF_BACKOFF_JITTER),
      attempts,
      identity,
    });
  }

  /**
   * A settled job's schedule is history. Identity-guarded as a belt (r4 3881841010): settlement
   * follows a verified disposition so a foreign entry should be unreachable here, but a late
   * echo must still not delete what a successor earned.
   */
  settled(jobId: string, identity: string): void {
    const entry = this.entries.get(jobId);
    if (entry && entry.identity !== identity) return;
    this.entries.delete(jobId);
  }
}
