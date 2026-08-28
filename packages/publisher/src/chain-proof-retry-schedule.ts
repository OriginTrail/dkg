/**
 * The held-job chain-proof retry schedule, extracted whole (PR #2373 r2 3879930153): the
 * attempt map, due checks, cadence selection, delay arithmetic, and cleanup live HERE, so the
 * publisher loop consumes dispatch outcomes and delegates scheduling without carrying backoff
 * arithmetic or phase branches. INTERNAL — deliberately not exported from the package barrel.
 *
 * ONE map, keyed by jobId, ONE entry per job in one of two EXPLICIT states:
 *
 *   - `ready`    — an incarnation OWNS the slot and is due immediately (observed by an
 *                  inventory pass, before its first deferral).
 *   - `deferred` — the owning incarnation earned a backoff; only this state carries
 *                  `attempts`/`dueAt`.
 *
 * Ownership ordering is a schedule-issued MONOTONIC PASS TOKEN (PR #2380 r3 3882984503 /
 * 3882984347 / 3882984696): a dispatch pass calls `beginPass()` when it takes its inventory
 * snapshot, and every observation and deferral carries that token. Millisecond timestamps can
 * tie between overlapping passes; tokens cannot. The rules, each closing a reviewed hole:
 *
 *   - EVERY admitted observation establishes ownership — including first contact on an empty
 *     slot (r3 red: the empty branch used to leave an unowned window a stale completion could
 *     claim, and a leaked stale entry could outlive the job's inventory presence).
 *   - an observation of the CURRENT owner refreshes its ownership token without touching
 *     ready/deferred state, attempts, or dueAt (r3 red: an unrefreshed marker made a stale
 *     pass look newer than the genuinely newer same-owner observation).
 *   - a DIFFERENT identity takes the slot only with a token not older than the entry's; a
 *     stale pass is answered "not due" for its superseded identity and cannot reclaim.
 *   - a deferral or settlement whose identity disagrees with the entry is a superseded echo,
 *     dropped whole (r8 🔴 3882533655: neither reset nor retained).
 *
 * The map stays bounded at one entry per job BY CONSTRUCTION; `retainedEntryCount()` keeps
 * boundedness a testable number.
 *
 * The ladder (r18 🔴 3816322914 anti-herd design, unchanged): base 30s doubling per attempt,
 * jittered by +0..25% of the computed delay so a population held by ONE incident does not come
 * due in lockstep. Capped so a long-held job is still asked periodically, never deferred to
 * effectively never. The `awaiting-confirmations` cadence tightens ONLY the ceiling, and that
 * ceiling is TRUE post-jitter: the ladder base is capped at `ceiling / (1 + jitter)` so the
 * jittered delay can never exceed two minutes. Growth and attempts are cadence-independent.
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
  | { readonly kind: 'ready'; readonly identity: string; readonly observedToken: number }
  | {
      readonly kind: 'deferred';
      readonly identity: string;
      readonly observedToken: number;
      readonly dueAt: number;
      readonly attempts: number;
    };

export class ChainProofRetrySchedule {
  /** ONE entry per jobId; identity + pass-token recency are the ownership checks. */
  private readonly entries = new Map<string, ScheduleEntry>();
  private passTokenCounter = 0;

  constructor(
    private readonly deps: { now(): number; rand(): number },
  ) {}

  /** Issue the pass ordering token — called once per dispatch pass, at its inventory snapshot. */
  beginPass(): number {
    this.passTokenCounter += 1;
    return this.passTokenCounter;
  }

  /**
   * Due when this identity owns a `ready` slot or its deferral elapsed. EVERY admitted
   * observation establishes or refreshes ownership; a different identity is admitted only with
   * a token not older than the entry's — a stale pass cannot reclaim and is answered "not due".
   */
  isDue(jobId: string, identity: string, atMs: number, passToken: number): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) {
      this.entries.set(jobId, { kind: 'ready', identity, observedToken: passToken });
      return true;
    }
    if (entry.identity !== identity) {
      if (passToken < entry.observedToken) return false;
      this.entries.set(jobId, { kind: 'ready', identity, observedToken: passToken });
      return true;
    }
    if (passToken > entry.observedToken) {
      this.entries.set(jobId, { ...entry, observedToken: passToken });
    }
    if (entry.kind === 'ready') return true;
    return entry.dueAt <= atMs;
  }

  /**
   * A turn that established nothing defers the next one. A foreign entry means this deferral
   * is a superseded echo — dropped whole. An own `ready` slot starts the ladder; an own
   * `deferred` entry continues it. (An absent entry cannot occur for an admitted turn — its
   * own observation installed ownership — but a deferral arriving after settlement starts
   * fresh, which is the correct answer for a record that re-entered.)
   */
  defer(jobId: string, identity: string, cadence: ChainProofRetryCadence, passToken: number): void {
    const entry = this.entries.get(jobId);
    if (entry && entry.identity !== identity) return;
    const attempts = (entry?.kind === 'deferred' ? entry.attempts : 0) + 1;
    const capMs = cadence === 'awaiting-confirmations'
      ? CHAIN_PROOF_AWAITING_CONFIRMATIONS_BASE_CAP_MS
      : CHAIN_PROOF_BACKOFF_MAX_MS;
    const backoffMs = Math.min(CHAIN_PROOF_BACKOFF_BASE_MS * 2 ** (attempts - 1), capMs);
    const observedToken = Math.max(passToken, entry?.observedToken ?? 0);
    this.entries.set(jobId, {
      kind: 'deferred',
      identity,
      observedToken,
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
