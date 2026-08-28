/**
 * The held-job chain-proof retry schedule: due checks, cadence selection, backoff arithmetic,
 * ownership, and cleanup in one INTERNAL module (not exported from the package barrel).
 *
 * MODEL — one entry per jobId, in one of two states:
 *   - `ready`    — an incarnation owns the slot and is due immediately (observed, not yet
 *                  deferred).
 *   - `deferred` — the owning incarnation earned a backoff; only this state carries
 *                  `attempts`/`dueAt`.
 *
 * ORDERING — ownership changes are ordered by a monotonic pass token issued by `beginPass`,
 * which the caller MUST invoke synchronously at its inventory snapshot (token order must equal
 * snapshot order; issuing it later — e.g. at dispatch — would let an older snapshot arriving
 * late outrank a newer one). Millisecond clocks can tie between overlapping passes; tokens
 * cannot.
 *
 * PROTOCOL — a pass observes a (jobId, incarnation) through its pass scope. Every ADMITTED
 * observation installs or refreshes ownership (first contact included; a same-owner
 * observation refreshes recency without touching backoff state). A due observation returns a
 * TURN handle — the only way to defer or settle — so a stale pass cannot mutate what it was
 * never admitted to: a foreign identity with an older token is refused outright, and a turn's
 * later deferral/settlement is identity-checked against the entry again at write time, making
 * a superseded echo a whole-value no-op (neither resets the successor's ladder nor is it
 * retained), and a deferral into a slot the owner already SETTLED cannot resurrect it. A stale
 * pass's FIRST-CONTACT observation after a settlement is admitted (the schedule keeps no
 * settlement history), but its residue is bounded: the dispatcher releases the slot at the
 * locked re-read, and each pass's `prune` sweeps entries no newer snapshot can observe — the
 * map stays bounded at one entry per LIVE job, observable via `retainedEntryCount`.
 *
 * BACKOFF — base 30s doubling per attempt, +0..25% jitter (anti-herd), capped at 10 minutes;
 * the `awaiting-confirmations` cadence caps the BASE at ceiling/(1+jitter) so two minutes is a
 * true post-jitter ceiling. Growth and attempts are cadence-independent.
 */

const CHAIN_PROOF_BACKOFF_BASE_MS = 30_000;
const CHAIN_PROOF_BACKOFF_MAX_MS = 10 * 60_000;
const CHAIN_PROOF_BACKOFF_JITTER = 0.25;
const CHAIN_PROOF_AWAITING_CONFIRMATIONS_BACKOFF_MAX_MS = 2 * 60_000;
const CHAIN_PROOF_AWAITING_CONFIRMATIONS_BASE_CAP_MS = Math.floor(
  CHAIN_PROOF_AWAITING_CONFIRMATIONS_BACKOFF_MAX_MS / (1 + CHAIN_PROOF_BACKOFF_JITTER),
);

export type ChainProofRetryCadence = 'awaiting-confirmations' | 'default';

/** The admitted turn for one due (jobId, incarnation) — the only mutation surface. */
export interface ChainProofScheduleTurn {
  defer(cadence: ChainProofRetryCadence): void;
  settled(): void;
}

/** One dispatch pass's scope; created at the caller's inventory snapshot. */
export interface ChainProofSchedulePass {
  /** Observe one inventoried (jobId, incarnation): a turn when due, `null` otherwise. */
  observe(jobId: string, identity: string): ChainProofScheduleTurn | null;
  /**
   * Sweep entries installed by OLDER passes for jobs this pass's snapshot cannot observe: a
   * job absent from the newest snapshot's held population left the held state, so its entry is
   * dead (a re-failed job is a NEW incarnation and reinstalls fresh). The token guard spares
   * entries installed by this pass or a newer overlapping one, whose snapshots this pass's
   * cannot outrank.
   */
  prune(observableJobIds: ReadonlySet<string>): void;
}

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
  private readonly entries = new Map<string, ScheduleEntry>();
  private passTokenCounter = 0;

  constructor(
    private readonly deps: { now(): number; rand(): number },
  ) {}

  /**
   * Open a pass scope. MUST be called synchronously at the inventory snapshot (see ORDERING);
   * `atMs` is that snapshot instant, used for dueness so one pass judges the whole population
   * at one moment.
   */
  beginPass(atMs: number): ChainProofSchedulePass {
    this.passTokenCounter += 1;
    const token = this.passTokenCounter;
    return {
      observe: (jobId: string, identity: string): ChainProofScheduleTurn | null => {
        if (!this.admitObservation(jobId, identity, atMs, token)) return null;
        return {
          defer: (cadence: ChainProofRetryCadence) => this.deferTurn(jobId, identity, cadence, token),
          settled: () => this.settleTurn(jobId, identity),
        };
      },
      prune: (observableJobIds: ReadonlySet<string>) => {
        for (const [jobId, entry] of this.entries) {
          if (entry.observedToken < token && !observableJobIds.has(jobId)) this.entries.delete(jobId);
        }
      },
    };
  }

  /**
   * The retention observable: boundedness (one entry per live jobId) as a testable number.
   */
  retainedEntryCount(): number {
    return this.entries.size;
  }

  private admitObservation(jobId: string, identity: string, atMs: number, token: number): boolean {
    const entry = this.entries.get(jobId);
    if (!entry) {
      this.entries.set(jobId, { kind: 'ready', identity, observedToken: token });
      return true;
    }
    if (entry.identity !== identity) {
      if (token < entry.observedToken) return false;
      this.entries.set(jobId, { kind: 'ready', identity, observedToken: token });
      return true;
    }
    if (token > entry.observedToken) {
      this.entries.set(jobId, { ...entry, observedToken: token });
    }
    if (entry.kind === 'ready') return true;
    return entry.dueAt <= atMs;
  }

  private deferTurn(jobId: string, identity: string, cadence: ChainProofRetryCadence, token: number): void {
    const entry = this.entries.get(jobId);
    // A missing entry here means the slot was SETTLED after this turn was admitted (admission
    // always installs an entry; only settlement deletes one). Deferring must not resurrect it.
    if (!entry || entry.identity !== identity) return;
    const attempts = (entry.kind === 'deferred' ? entry.attempts : 0) + 1;
    const capMs = cadence === 'awaiting-confirmations'
      ? CHAIN_PROOF_AWAITING_CONFIRMATIONS_BASE_CAP_MS
      : CHAIN_PROOF_BACKOFF_MAX_MS;
    const backoffMs = Math.min(CHAIN_PROOF_BACKOFF_BASE_MS * 2 ** (attempts - 1), capMs);
    this.entries.set(jobId, {
      kind: 'deferred',
      identity,
      observedToken: Math.max(token, entry.observedToken),
      dueAt: this.deps.now() + backoffMs + Math.floor(this.deps.rand() * backoffMs * CHAIN_PROOF_BACKOFF_JITTER),
      attempts,
    });
  }

  private settleTurn(jobId: string, identity: string): void {
    const entry = this.entries.get(jobId);
    if (entry && entry.identity !== identity) return;
    this.entries.delete(jobId);
  }
}
