/**
 * The stop rule for the bounded, progress-aware repeat of the public SWM peer
 * walk (issue #2050).
 *
 * A receiver subscribing to a large public Context Graph gets exactly ONE round
 * per peer and exactly ONE walk over the peer set. When a round's 120 s deadline
 * expires mid-snapshot-list the tail is abandoned, and once the peer set is
 * exhausted the job terminates `unreachable` with a partial graph and no resume
 * path. The fix is to repeat the walk — bounded, and only while it is provably
 * getting somewhere.
 *
 * This module is ONLY the decision. It runs no I/O, reads no clock and holds no
 * state, so the rule that decides how much extra network and store work a node
 * may spend exists in one place and is tested in one place. Both drivers — the
 * CLI worker's `runCatchup` and the in-agent `runCatchupOverPeers` — call it, so
 * they cannot drift apart.
 *
 * It is deliberately NOT a new mechanism: the repo already runs a bounded round
 * loop with a clean-completion stop on this exact lane for post-approval curator
 * sync (`dkg-agent-lifecycle.ts`, `MAX_POST_APPROVAL_CURATOR_SYNC_ROUNDS`). #2050
 * is that loop missing from the general foreground catch-up.
 */
import { monotonicNow } from './catchup-policy.js';

/**
 * Elapsed-time source for the pass budget.
 *
 * Re-exported from `catchup-policy.ts` rather than redefined so the pass budget
 * and the sibling admission-retry budget read the SAME clock. It is monotonic
 * for the reason stated there: the budget is a duration, not a point in time, so
 * it must not follow a wall-clock correction. The walk never compares this
 * against the per-Context-Graph round deadline — that one is computed inside the
 * agent from its own clock and is never read here — so there is nothing to keep
 * the two comparable and no reason to inherit `Date.now`'s NTP hazard.
 */
export const catchupPassNowMs: () => number = monotonicNow;

/** Why the loop stopped, or that it did not. A closed vocabulary: the terminal
 * message and the per-pass log line both render it, and an open-ended string
 * would make those untestable. */
export type CatchupPassDecisionReason =
  | 'continue'
  | 'plane-proven'
  | 'coverage-stalled'
  | 'no-capable-peers'
  | 'max-passes-reached'
  | 'budget-exhausted';

export interface CatchupPassPolicyInput {
  /** Monotonic reading from `catchupPassNowMs`; injected so the rule is pure. */
  nowMs: number;
  /**
   * Monotonic instant after which no new pass may START. Computed once per job
   * as `catchupPassNowMs() + budgetMs`. A budget of `0` therefore makes this
   * equal to the job start, which expires immediately — that is exactly how the
   * `DKG_SWM_CATCHUP_PASS_BUDGET_MS=0` kill switch disables extra passes, with
   * no separate disabled branch to keep correct.
   */
  deadlineMs: number;
  /** Passes COMPLETED so far, including the initial walk — so never below 1. */
  passesRun: number;
  /** Total passes permitted, initial walk included. */
  maxPasses: number;
  /**
   * The highest `snapshotsResolved` observed BEFORE the pass that just ran.
   *
   * Initialised to 0, not −1. The difference is load-bearing: with −1 a first
   * pass that resolved nothing at all would still count as "advanced" and earn a
   * repeat, which is precisely the barren-retry the wall-clock budget then has to
   * absorb. A pass that resolved zero snapshots has produced no evidence that
   * another one would do better.
   */
  coverageHighWaterMark: number;
  /** The highest `snapshotsResolved` observed IN the pass that just ran. */
  lastPassCoverage: number;
  /** A clean peer round already proved the shared-memory plane. */
  planeProven: boolean;
  /**
   * Peers that demonstrably still hold descriptors we lack — the caller derives
   * this from each peer's own reported coverage, never from the absence of
   * failure counters. Barren, cleanly-empty, empty-and-timed-out and
   * meta-truncation peers are not capable and must get zero extra passes.
   */
  capablePeers: readonly string[];
}

export interface CatchupPassDecision {
  continue: boolean;
  /** The peers the next pass may contact — the capable set, or empty on a stop. */
  peers: string[];
  reason: CatchupPassDecisionReason;
}

/**
 * Decide whether the walk gets another pass, and over which peers.
 *
 * Every condition below is independently sufficient to stop, so several are
 * routinely true at once. `reason` reports the FIRST match in the order written,
 * which is chosen by how actionable it is rather than by severity:
 *
 *   1. `plane-proven` — a success, and it outranks everything else, but ONLY
 *      once no capable peer is left. The plane is proven by an aggregate over
 *      every peer, so a member serving its own shared-memory rows and no
 *      snapshot refs proves it — the ordinary shape in a multi-member public
 *      Context Graph. Stopping on that alone abandons a peer that reported a
 *      complete manifest with refs still unresolved, which is the abandonment
 *      #2050 exists to remove; the aggregate would make the fix inert exactly
 *      where it was aimed. Proof of the plane says the graph is reachable, not
 *      that this peer has nothing left to give.
 *   2. `coverage-stalled` — the walk is not converging. Reported ahead of the
 *      hard bounds because it changes what an operator should do: a stalled run
 *      that also hit the budget would otherwise read as "raise the budget", and
 *      raising it would buy nothing.
 *   3. `no-capable-peers` — nobody left who admits to holding what we lack.
 *   4. `max-passes-reached`, 5. `budget-exhausted` — the backstops. They bound
 *      the loop; they rarely explain it.
 */
export function shouldRunAnotherCatchupPass(input: CatchupPassPolicyInput): CatchupPassDecision {
  const stop = (reason: CatchupPassDecisionReason): CatchupPassDecision =>
    ({ continue: false, peers: [], reason });

  // Gated on the capable set: proof-by-data is an aggregate over every peer, so
  // an unrelated clean round must not end the walk while a peer that declared a
  // complete manifest still has refs outstanding.
  if (input.planeProven && input.capablePeers.length === 0) return stop('plane-proven');
  // Strictly greater: a pass that resolved exactly as much as every pass before
  // it moved nothing, however large the number is.
  if (input.lastPassCoverage <= input.coverageHighWaterMark) return stop('coverage-stalled');
  if (input.capablePeers.length === 0) return stop('no-capable-peers');
  if (input.passesRun >= input.maxPasses) return stop('max-passes-reached');
  // `>=`, so a budget of 0 stops before the first repeat rather than granting one.
  if (input.nowMs >= input.deadlineMs) return stop('budget-exhausted');

  return { continue: true, peers: [...input.capablePeers], reason: 'continue' };
}

/**
 * Wall-clock budget for the whole repeat loop, in ms.
 *
 * Sized so at least two extra passes fit even when a peer's plane is deferred and
 * burns its full admission-retry budget (`CATCHUP_BACKPRESSURE_MAX_WAIT_MS`,
 * 180 s). It is wall-clock rather than a pass count because the dominant per-pass
 * cost on a warm store is local: re-verifying an already-held KA is a full blob
 * read, parse, sort and SHA-256, plus a COUNT and a full CONSTRUCT against the
 * store — O(KA size) per cached snapshot, with no bytes on the wire.
 */
export const DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS = 600_000;

/** Backstop on the pass count: the initial walk plus three repeats. The budget
 * and the coverage gate are the real bounds; this exists so a pathological
 * always-advancing-by-one peer cannot spin. */
export const DEFAULT_SWM_CATCHUP_MAX_PASSES = 4;

/**
 * Parse the operator-facing pass budget.
 *
 * Exported as a pure function for the same reason `resolveCatchupBackpressureMaxWaitMs`
 * is: the constant below resolves once at module load, which makes the env
 * contract untestable in place — and it has the same sharp edge. A BLANK
 * assignment is the normal docker-compose / `.env` / systemd shape for "not set",
 * but `Number('')` is `0`, which here would silently disable every extra pass and
 * leave the node with exactly the #2050 behaviour the operator was trying to fix.
 * Blank is unset; an explicit `0` still means "no extra passes".
 */
export function resolveSwmCatchupPassBudgetMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS;
  const parsed = Number(trimmed);
  // `Number.isInteger` alone accepts `1e308`, an integer by IEEE-754 and a budget
  // no operator meant. Require a SAFE integer so an unusable value falls back to
  // the documented default instead of becoming an effectively unbounded loop.
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SWM_CATCHUP_PASS_BUDGET_MS;
}

/**
 * Parse the operator-facing pass cap.
 *
 * Same contract as the budget, with one difference: the floor is 1, not 0. Zero
 * passes would skip the initial walk itself — catch-up would fetch nothing at all
 * — so a `0` here is a misconfiguration rather than a kill switch, and falls back
 * to the default. Disabling repeats is the budget's job.
 */
export function resolveSwmCatchupMaxPasses(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_SWM_CATCHUP_MAX_PASSES;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_SWM_CATCHUP_MAX_PASSES;
}

export const SWM_CATCHUP_PASS_BUDGET_MS: number =
  resolveSwmCatchupPassBudgetMs(process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS);

export const SWM_CATCHUP_MAX_PASSES: number =
  resolveSwmCatchupMaxPasses(process.env.DKG_SWM_CATCHUP_MAX_PASSES);
