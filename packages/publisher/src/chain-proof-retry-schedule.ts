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
 * which the caller MUST invoke at the START of its serialized inventory acquisition, before
 * the read (token order must equal snapshot order; issuing it later — after the read, or at
 * dispatch — would let an older snapshot COMPLETING late outrank a newer one, and the sweep
 * would then collect the newer state). In the serialized case start order equals capture
 * order; when a hung read is bypassed at the caller's wait cap, its pre-drawn token fences it
 * as older — conservative, since a stale-ranked pass can only be refused, never destructive.
 * Millisecond clocks can tie between overlapping passes; tokens cannot.
 *
 * PROTOCOL — a pass admits its whole snapshot through ONE `observeSnapshot` call, which
 * sweeps first (entries no newer snapshot can observe are dead) and then observes each
 * candidate. Every ADMITTED observation installs or refreshes ownership (first contact
 * included; a same-owner observation refreshes recency without touching backoff state). A due
 * observation yields a TURN handle — the only way to defer or settle — so a stale pass cannot
 * mutate what it was never admitted to: a foreign identity with an older token is refused
 * outright, and a turn's later deferral/settlement is identity-checked against the entry
 * again at write time, making a superseded echo a whole-value no-op (neither resets the
 * successor's ladder nor is it retained), and a deferral into a slot the owner already
 * SETTLED cannot resurrect it. A stale pass's FIRST-CONTACT observation after a settlement is
 * admitted (the schedule keeps no settlement history), but its residue is bounded: the
 * dispatcher releases the slot at the locked re-read, and the next snapshot admission sweeps
 * it — the map stays bounded at one entry per LIVE job, observable via `retainedEntryCount`.
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
  /**
   * The ONE snapshot-admission operation (r10 3883959998 — atomic in the API, so a caller
   * cannot omit the sweep or reorder it relative to admission): first sweeps entries installed
   * by OLDER passes for jobs this snapshot cannot observe — such a job left the held state, so
   * its entry is dead (a re-failed job is a NEW incarnation and reinstalls fresh); the token
   * guard spares entries from this pass or a newer overlapping one, whose snapshots this one
   * cannot outrank — then observes every candidate, returning the admitted (due) turns keyed
   * by jobId. Callable EXACTLY ONCE, with the pass's whole snapshot (r11 3884194251): a split
   * admission would sweep an omitted job and then reinstall it immediately-ready, so a second
   * call throws instead.
   */
  observeSnapshot(
    candidates: ReadonlyArray<{ readonly jobId: string; readonly identity: string }>,
  ): Map<string, ChainProofScheduleTurn>;
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
   * Open a pass scope. MUST be called at the start of the caller's serialized inventory
   * acquisition (see ORDERING); `atMs` is that acquisition instant, used for dueness so one
   * pass judges the whole population at one moment.
   */
  beginPass(atMs: number): ChainProofSchedulePass {
    this.passTokenCounter += 1;
    const token = this.passTokenCounter;
    let consumed = false;
    return {
      observeSnapshot: (candidates) => {
        // r11 (🟡 3884194251) — single-use, enforced: a split admission would first sweep an
        // omitted job's entry and then reinstall it immediately-ready on the second call —
        // silently resetting its earned backoff. The whole-snapshot-exactly-once contract
        // fails loudly here instead of corrupting ownership semantics at a distance.
        if (consumed) {
          throw new Error('ChainProofSchedulePass: a pass admits its snapshot exactly once');
        }
        consumed = true;
        const observable = new Set(candidates.map((candidate) => candidate.jobId));
        for (const [jobId, entry] of this.entries) {
          if (entry.observedToken < token && !observable.has(jobId)) this.entries.delete(jobId);
        }
        const turns = new Map<string, ChainProofScheduleTurn>();
        for (const { jobId, identity } of candidates) {
          if (!this.admitObservation(jobId, identity, atMs, token)) continue;
          turns.set(jobId, {
            defer: (cadence: ChainProofRetryCadence) => this.deferTurn(jobId, identity, cadence, token),
            settled: () => this.settleTurn(jobId, identity),
          });
        }
        return turns;
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
