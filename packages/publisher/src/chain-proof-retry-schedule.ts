/**
 * The held-job chain-proof retry schedule, extracted whole (PR #2373 r2 3879930153): the
 * attempt map, due checks, cadence selection, delay arithmetic, and cleanup live HERE, so the
 * publisher loop consumes dispatch outcomes and delegates scheduling without carrying backoff
 * arithmetic or phase branches. INTERNAL — deliberately not exported from the package barrel.
 *
 * ONE map, keyed by jobId, ONE entry per job in one of two EXPLICIT states (PR #2380 r2
 * 3882793685 — the states replace the earlier attempts-zero sentinel):
 *
 *   - `ready`    — an incarnation OWNS the slot and is due immediately (a successor observed
 *                  by an inventory pass, before its first deferral).
 *   - `deferred` — the owning incarnation earned a backoff; only this state carries
 *                  `attempts`/`dueAt`.
 *
 * Ownership changes are RECENCY-GUARDED: every entry records `observedAt` (the pass snapshot
 * that installed it, or the deferral instant), and a due check for a different identity may
 * replace the entry only when its own pass snapshot is not older — an overlapping STALE pass,
 * still filtering against a superseded inventory, cannot reclaim the slot from the newer
 * incarnation (the r2 red: the marker alone guarded stale defers, not stale due checks). The
 * refusal answers "not due" for the superseded identity; a rare inverse race (an own-identity
 * deferral stamping a newer observedAt between a fresh pass's snapshot and its filter) can
 * delay the successor's takeover by one pass, never lose state — strictly the safe direction.
 * Stale deferrals and settlements are identity-rejected as before; the map stays bounded at
 * one entry per job BY CONSTRUCTION.
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

type ScheduleEntry =
  | { readonly kind: 'ready'; readonly identity: string; readonly observedAt: number }
  | {
      readonly kind: 'deferred';
      readonly identity: string;
      readonly observedAt: number;
      readonly dueAt: number;
      readonly attempts: number;
    };

export class ChainProofRetrySchedule {
  /** ONE entry per jobId; identity + recency are the ownership checks every operation makes. */
  private readonly entries = new Map<string, ScheduleEntry>();

  constructor(
    private readonly deps: { now(): number; rand(): number },
  ) {}

  /**
   * Due when nothing is scheduled, when this identity owns a `ready` slot, or when its
   * deferral elapsed. A DIFFERENT identity takes ownership (installing `ready`) only when this
   * pass's snapshot is not older than the entry's observation — a stale pass cannot reclaim
   * the slot and is answered "not due" for its superseded identity.
   */
  isDue(jobId: string, identity: string, atMs: number): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) return true;
    if (entry.identity !== identity) {
      if (atMs < entry.observedAt) return false;
      this.entries.set(jobId, { kind: 'ready', identity, observedAt: atMs });
      return true;
    }
    if (entry.kind === 'ready') return true;
    return entry.dueAt <= atMs;
  }

  /**
   * A turn that established nothing defers the next one. A foreign entry means this deferral
   * is a superseded echo — dropped whole (r8 🔴 3882533655: neither reset nor retained). An
   * own `ready` slot or absent entry starts the ladder; an own `deferred` entry continues it.
   */
  defer(jobId: string, identity: string, cadence: ChainProofRetryCadence): void {
    const entry = this.entries.get(jobId);
    if (entry && entry.identity !== identity) return;
    const attempts = (entry?.kind === 'deferred' ? entry.attempts : 0) + 1;
    const capMs = cadence === 'awaiting-confirmations'
      ? CHAIN_PROOF_AWAITING_CONFIRMATIONS_BASE_CAP_MS
      : CHAIN_PROOF_BACKOFF_MAX_MS;
    const backoffMs = Math.min(CHAIN_PROOF_BACKOFF_BASE_MS * 2 ** (attempts - 1), capMs);
    const now = this.deps.now();
    this.entries.set(jobId, {
      kind: 'deferred',
      identity,
      observedAt: now,
      dueAt: now + backoffMs + Math.floor(this.deps.rand() * backoffMs * CHAIN_PROOF_BACKOFF_JITTER),
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
