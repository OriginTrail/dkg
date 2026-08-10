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
 * The pure decision and its state ledger live here beside the small executor
 * that owns their deadline/decision/pass-count lifecycle. The executor runs no
 * transport or store I/O itself; callers inject the actual round runner. The
 * CLI worker, in-agent foreground catch-up and selected RFC-64 provider path
 * therefore share the same continuation mechanics without sharing their
 * different transport shapes.
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
   * The current progress domain's reading BEFORE the pass that just ran.
   *
   * Initialised to 0, not −1. The difference is load-bearing: with −1 a first
   * pass that resolved nothing at all would still count as "advanced" and earn a
   * repeat, which is precisely the barren-retry the wall-clock budget then has to
   * absorb. In the ordinary snapshot ledger, a pass that resolved zero
   * snapshots has produced no evidence that another one would do better.
   */
  progressHighWaterMark: number;
  /** The current ledger-domain progress after the pass that just ran. */
  lastPassProgress: number;
  /**
   * Whether the current progress ledger has already started a continuation
   * pass in this progress domain. Omitted callers retain the historical
   * `passesRun > 1` interpretation. A staged ledger can reset this when it
   * moves to a different domain without resetting the global pass cap.
   */
  progressBaselineEstablished?: boolean;
  /** A clean peer round already proved the shared-memory plane. */
  planeProven: boolean;
  /**
   * Peers that demonstrably can advance the current progress domain. Ordinary
   * snapshot callers derive this from each peer's own coverage; staged callers
   * may use another explicit capability proof. Absence of failure is never
   * sufficient by itself.
   */
  capablePeers: readonly string[];
}

export interface CatchupPassDecision {
  continue: boolean;
  /** The peers the next pass may contact — the capable set, or empty on a stop. */
  peers: string[];
  reason: CatchupPassDecisionReason;
}

export interface CatchupPassConfig {
  /** Wall-clock budget for continuation passes only. */
  budgetMs: number;
  /** Total passes permitted, including the initial walk. */
  maxPasses: number;
}

/** The coverage fields needed by the shared continuation ledger. */
export interface CatchupPassCoverage {
  snapshotsResolved: number;
  snapshotsTotal: number;
  manifestComplete: boolean;
}

/**
 * Progress/capability contract consumed by the shared bounded-pass executor.
 *
 * Ordinary SWM uses the snapshot-only `SwmCatchupPassTracker`. A staged caller
 * may provide its own ledger, keeping domain-specific progress units out of
 * the canonical snapshot tracker while still sharing admission, pass caps and
 * the absolute deadline.
 */
export interface SwmCatchupProgressLedger {
  decide(input: {
    nowMs: number;
    deadlineMs: number;
    maxPasses: number;
    planeProven: boolean;
  }): CatchupPassDecision;
  startContinuationPass(): number;
  progress(): number;
  continuationPasses(): number;
}

/**
 * Snapshot-only progress ledger for ordinary public-SWM catch-up drivers.
 *
 * Last-round coverage decides which peers are still capable, while a separate
 * monotone per-peer high-water ledger decides whether the most recent pass made
 * progress. Keeping both maps here prevents the worker and inline agent from
 * silently acquiring different retry semantics.
 */
export class SwmCatchupPassTracker<TCoverage extends CatchupPassCoverage>
implements SwmCatchupProgressLedger {
  private readonly lastCoverageByPeer = new Map<string, TCoverage>();

  private readonly peerProgressHighWater = new Map<string, number>();

  private progressHighWaterMark = 0;

  private completedContinuationPasses = 0;

  recordPeerRound(
    peerId: string,
    coverage: TCoverage | undefined,
    completedWithoutFailure: boolean,
  ): void {
    if (coverage) {
      this.lastCoverageByPeer.set(peerId, coverage);
      const seen = this.peerProgressHighWater.get(peerId) ?? 0;
      if (coverage.snapshotsResolved > seen) {
        this.peerProgressHighWater.set(peerId, coverage.snapshotsResolved);
      }
      return;
    }

    // A clean coverage-free response is evidence that this peer has no manifest.
    // A failed response proves no such thing, so retain the last positive record.
    if (completedWithoutFailure) this.lastCoverageByPeer.delete(peerId);
  }

  capablePeers(): string[] {
    const capable = new Set<string>();
    for (const [peerId, coverage] of this.lastCoverageByPeer) {
      if (
        coverage.manifestComplete
        && coverage.snapshotsTotal > 0
        && coverage.snapshotsResolved < coverage.snapshotsTotal
      ) {
        capable.add(peerId);
      }
    }
    return [...capable];
  }

  progress(): number {
    let total = 0;
    for (const resolved of this.peerProgressHighWater.values()) total += resolved;
    return total;
  }

  continuationPasses(): number {
    return this.completedContinuationPasses;
  }

  decide(input: {
    nowMs: number;
    deadlineMs: number;
    maxPasses: number;
    planeProven: boolean;
  }): CatchupPassDecision {
    return shouldRunAnotherCatchupPass({
      ...input,
      passesRun: 1 + this.completedContinuationPasses,
      progressHighWaterMark: this.progressHighWaterMark,
      lastPassProgress: this.progress(),
      capablePeers: this.capablePeers(),
    });
  }

  /** Mark a continuation as started and return the progress reading before it. */
  startContinuationPass(): number {
    const before = this.progress();
    this.progressHighWaterMark = before;
    this.completedContinuationPasses += 1;
    return before;
  }
}

export interface SwmCatchupContinuationUnit<
  Key,
> {
  readonly key: Key;
  readonly ledger: SwmCatchupProgressLedger;
  readonly planeProven: () => boolean;
}

/** The pass state exposed only inside an executor-owned started-work callback. */
export interface SwmCatchupStartedContinuation<Key> {
  readonly key: Key;
  readonly peers: readonly string[];
  readonly progressBefore: number;
  readonly progress: () => number;
  readonly continuationPass: number;
}

export type SwmCatchupStartedResult<Result> =
  | { readonly started: true; readonly result: Result }
  | { readonly started: false; readonly reason: 'budget-exhausted' };

/**
 * One continuation candidate selected by the shared pass executor.
 *
 * `runStarted` is deliberately invoked only when an adapter is actually about
 * to do I/O. It owns the deadline recheck and pass transition atomically, so a
 * caller cannot perform transport work while forgetting the diagnostic count.
 * Selected-provider work may wait in the global scheduler after the policy
 * decision; if its budget expires there, the callback is never invoked and the
 * result explicitly says that no pass started.
 */
export interface SwmCatchupContinuationCandidate<Key> {
  readonly key: Key;
  readonly peers: readonly string[];
  readonly runStarted: <Result>(
    run: (started: SwmCatchupStartedContinuation<Key>) => Promise<Result>,
  ) => Promise<SwmCatchupStartedResult<Result>>;
}

export interface SwmCatchupContinuationStop<Key> {
  readonly key: Key;
  readonly continuationPasses: number;
  readonly reason: CatchupPassDecisionReason;
}

export interface RunSwmCatchupContinuationsOptions<
  Key,
  PassResult,
> {
  readonly units: readonly SwmCatchupContinuationUnit<Key>[];
  readonly config: CatchupPassConfig;
  readonly nowMs: () => number;
  readonly runPass: (
    candidates: readonly SwmCatchupContinuationCandidate<Key>[],
    deadlineMs: number,
  ) => Promise<PassResult>;
  /** Stop after the admitted pass, for example when global backpressure fired. */
  readonly shouldStopAfterPass?: (result: PassResult) => boolean;
  readonly onStop?: (stop: SwmCatchupContinuationStop<Key>) => void | Promise<void>;
}

export interface SwmCatchupContinuationSummary {
  readonly continuationPasses: number;
  readonly deadlineMs: number;
  readonly stoppedAfterPass: boolean;
}

/**
 * Canonical bounded SWM continuation executor.
 *
 * Policy selection, the one absolute continuation deadline and pass-count
 * ownership live here. Callers provide only the unit-specific round runner:
 * the CLI and foreground agent walk capable peers, while RFC-64 selected sync
 * schedules incomplete Context Graphs through the existing global admission
 * queue. This keeps those transport shapes distinct without letting their
 * retry semantics drift.
 */
export async function runSwmCatchupContinuations<
  Key,
  PassResult,
>(
  options: RunSwmCatchupContinuationsOptions<Key, PassResult>,
): Promise<SwmCatchupContinuationSummary> {
  const deadlineMs = options.nowMs() + options.config.budgetMs;
  const stopped = new Set<Key>();
  let stoppedAfterPass = false;

  for (;;) {
    let startsThisPass = 0;
    const candidates: SwmCatchupContinuationCandidate<Key>[] = [];
    for (const unit of options.units) {
      if (stopped.has(unit.key)) continue;
      const decision = unit.ledger.decide({
        nowMs: options.nowMs(),
        deadlineMs,
        maxPasses: options.config.maxPasses,
        planeProven: unit.planeProven(),
      });
      if (!decision.continue) {
        stopped.add(unit.key);
        await options.onStop?.({
          key: unit.key,
          continuationPasses: unit.ledger.continuationPasses(),
          reason: decision.reason,
        });
        continue;
      }

      let started = false;
      candidates.push({
        key: unit.key,
        peers: decision.peers,
        runStarted: async (run) => {
          if (started) {
            throw new Error('SWM continuation candidate was started more than once');
          }
          // The decision above can precede a global scheduler wait. Keep the
          // deadline check beside the state transition so an adapter cannot
          // accidentally count or execute work that expired in that queue.
          if (options.nowMs() >= deadlineMs) {
            return { started: false, reason: 'budget-exhausted' } as const;
          }
          started = true;
          startsThisPass += 1;
          const progressBefore = unit.ledger.startContinuationPass();
          const result = await run({
            key: unit.key,
            peers: decision.peers,
            progressBefore,
            progress: () => unit.ledger.progress(),
            continuationPass: unit.ledger.continuationPasses(),
          });
          return { started: true, result } as const;
        },
      });
    }
    if (candidates.length === 0) break;

    const passResult = await options.runPass(candidates, deadlineMs);
    if (options.shouldStopAfterPass?.(passResult)) {
      stoppedAfterPass = true;
      break;
    }
    // A queued selected-provider batch can cross the absolute deadline before
    // any candidate starts. Re-enter the decision cycle exactly once so every
    // active unit publishes `budget-exhausted` through the normal onStop path;
    // a genuine runner decline while budget remains still terminates directly.
    if (startsThisPass === 0) {
      if (options.nowMs() >= deadlineMs) continue;
      break;
    }
  }

  return {
    continuationPasses: options.units.reduce(
      (total, unit) => total + unit.ledger.continuationPasses(),
      0,
    ),
    deadlineMs,
    stoppedAfterPass,
  };
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
  //
  // Suppressed before the current progress domain has established a baseline
  // while a capable peer exists. In the ordinary snapshot ledger this is the
  // pass-1 boundary: `progressHighWaterMark` is 0 by initialization, so the test collapses to
  // "the whole walk materialized zero" — and that is a state a CAPABLE peer
  // routinely reports: a store fault that failed every write, or a round whose
  // deadline was spent by the metadata and aggregate phases so the snapshot walk
  // yielded at index 0. Such a peer emits `{resolved: 0, total: 250,
  // manifestComplete: true}`, which says "I hold 250 refs you do not have", and
  // it earned ZERO repeats while the message told the operator more passes would
  // not help. That is the same abandonment the plane-proven gate above was
  // narrowed to prevent, one clause further down.
  //
  // This does NOT re-admit the barren-retry the high-water 0-init guards
  // against. A barren peer emits no coverage record at all
  // (`recordSnapshotCoverage` returns early when the manifest is empty), and a
  // truncated-manifest peer is excluded by `capablePeersForNextPass`. So a
  // non-empty capable set at the pass-1 boundary IS the positive evidence that a
  // repeat could pay — it is a peer's own statement that it holds what we lack,
  // not an absence of failure. Later passes still stall normally, and the pass
  // cap and wall-clock budget still bound the loop.
  const progressBaselineEstablished = input.progressBaselineEstablished
    ?? input.passesRun > 1;
  const firstPassWithCapablePeers = !progressBaselineEstablished
    && input.capablePeers.length > 0;
  if (input.lastPassProgress <= input.progressHighWaterMark && !firstPassWithCapablePeers) {
    return stop('coverage-stalled');
  }
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
 * is: configuration is resolved into an explicit per-job value, and the parser
 * has the same sharp edge. A BLANK
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

/**
 * Resolve continuation limits at job start rather than module load.
 *
 * Long-lived agents and worker test processes may run many jobs. Capturing the
 * environment on first import made later jobs depend on import order and forced
 * every configuration test into a separate module registry. Returning one
 * explicit value keeps parsing pure and lets each driver inject the same shape
 * into its continuation loop.
 */
export function resolveSwmCatchupPassConfig(environment: {
  DKG_SWM_CATCHUP_PASS_BUDGET_MS?: string;
  DKG_SWM_CATCHUP_MAX_PASSES?: string;
} = {
  DKG_SWM_CATCHUP_PASS_BUDGET_MS: process.env.DKG_SWM_CATCHUP_PASS_BUDGET_MS,
  DKG_SWM_CATCHUP_MAX_PASSES: process.env.DKG_SWM_CATCHUP_MAX_PASSES,
}): CatchupPassConfig {
  return {
    budgetMs: resolveSwmCatchupPassBudgetMs(environment.DKG_SWM_CATCHUP_PASS_BUDGET_MS),
    maxPasses: resolveSwmCatchupMaxPasses(environment.DKG_SWM_CATCHUP_MAX_PASSES),
  };
}
