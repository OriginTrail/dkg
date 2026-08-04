// daemon/teardown.ts
//
// The producer-quiescent section of graceful shutdown, as one ordered
// function.
//
// It is extracted from `runDaemonInner`'s cleanup block for one reason: this
// order is the contract, three earlier orderings were wrong, and each of those
// mistakes was invisible while the sequence sat inline among twenty unrelated
// teardown statements. As a named function the order is legible, and a test
// can execute it with recorders and fail on a reorder.
//
// Why each edge exists — none of these are stylistic:
//
//   drain BEFORE the workers stop
//     `CatchupRunner.close()` IS `worker.terminate()`, and the runner's
//     constructor-registered `exit` handler rejects every pending run. Draining
//     afterwards grants no grace at all: it forces every retained job onto its
//     `failed` path and then observes the result.
//
//   flush BEFORE the workers stop, provider still live
//     So the terminal job records survive even if something below deadlocks
//     and the hard shutdown timer fires.
//
//   `stopAgent` BEFORE `stopTelemetry`
//     Terminating the catch-up worker does NOT quiesce parent-side sync: the
//     runner's `handleInvoke` bridge awaits real agent methods with only
//     `{priority, source}` — no signal, no cancel hook — so an already-started
//     sync keeps running and keeps emitting attempt/byte/active-time points.
//     Only `agent.stop()` ends them.
//
//   `stopTelemetry` LAST
//     It is not a flush: it shuts the providers down, clears the OTel API
//     globals and calls `rebuildMetrics()`, so every later `getMetrics()` binds
//     to a no-op meter. Running it earlier would export the terminal catch-up
//     records while silently dropping the very attempts, bytes and active time
//     that belong to them — numerator and denominator from different
//     lifecycles.

import { CATCHUP_SHUTDOWN_DRAIN_BUDGET_MS } from './catchup-telemetry.js';

/**
 * The FIRST thing graceful shutdown does: close catch-up admission, announce,
 * and give the supervisor's liveness watcher its signal.
 *
 * ## Why the flag write and the first await live in the SAME function
 *
 * `daemonState.catchupAcceptingJobs` is the subscribe route's only view of
 * shutdown — `shuttingDown` is a closure-local `let` inside `runDaemonInner`,
 * invisible to any route. So the write has to land before the first suspension
 * point, and `removeApiPort()` is real filesystem I/O: a subscribe arriving in
 * that window would still mint a walk job, persisting a subscription and
 * performing four gossipsub subscribes against a runner whose worker is about
 * to be terminated — whose `exit` handler then rejects the pending run.
 *
 * Inline in the cleanup block, BOTH failure modes were silent. Deleting the
 * write, or sinking it below the await, left every subscribe-route test green,
 * because those tests set `catchupAcceptingJobs` by hand and so can only
 * observe what happens once it is already false.
 *
 * A seam that owned only the flag would not fix that: it would pin the write's
 * existence while leaving the call site free to invoke it after the await. The
 * contract here is an ORDERING, so the seam has to own both halves — then a
 * test can suspend inside `removeApiPort` and look at the flag from in there,
 * which is the only vantage point from which the two orderings differ.
 *
 * The `removeApiPort` failure stays swallowed: this runs before the cleanup
 * IIFE, and it is idempotent with the later `cleanupStateFiles()` call, so a
 * failure here lands us exactly where a failed late removal would.
 */
export async function beginGracefulShutdown(deps: {
  state: { catchupAcceptingJobs: boolean };
  removeApiPort: () => Promise<void>;
  log: (message: string) => void;
}): Promise<void> {
  deps.state.catchupAcceptingJobs = false;
  deps.log('Shutting down...');
  await deps.removeApiPort().catch((err: any) =>
    deps.log(`Early api.port cleanup error: ${err?.message ?? String(err)}`),
  );
}

export interface ProducerQuiescentTeardownSteps {
  /** Stop accepting new connections. Initiated, not awaited — in-flight
   *  requests keep their sockets and everything below is still alive. */
  closeServer: () => void;
  /** Grace period for retained catch-up jobs, WHILE THE WORKER IS ALIVE,
   *  followed by a terminal record for every job still owed one. */
  drainCatchupJobs: () => Promise<void>;
  /** Flush only. Hard-capped; the providers stay live afterwards. */
  flushTelemetry: () => Promise<void>;
  // The three background workers are SEPARATE entries, not one composed step.
  // Resilience below is per-entry, so composing several actions behind
  // sequential awaits inside a single entry would recreate — one level down —
  // the exact stranding this sequencer exists to prevent: a rejecting publisher
  // stop would skip the promote worker and leave the catch-up runner's worker
  // thread alive. One action per entry keeps the rule "every action is guarded"
  // free of exceptions, reports each failure under its own name rather than an
  // undifferentiated "background workers", and puts their relative order in the
  // same list that documents the outer order.
  /** Stops first: it feeds the promote queue. */
  stopPublisherRuntime: () => Promise<void>;
  /** Must drain BEFORE the agent closes — `agent.stop()` takes its triple store away. */
  stopPromoteWorker: () => Promise<void>;
  /** `close()` on the catch-up runner, i.e. `worker.terminate()`. */
  closeCatchupRunner: () => Promise<void>;
  /** The only thing that ends parent-side sync work. */
  stopAgent: () => Promise<void>;
  /** Final flush + provider shutdown. Nothing after this can be measured. */
  stopTelemetry: () => Promise<void>;
}

export type TeardownStepName = keyof ProducerQuiescentTeardownSteps;

/**
 * The order, and the ONLY place it is written down.
 *
 * Exhaustiveness is enforced at compile time by `_TEARDOWN_ORDER_IS_EXHAUSTIVE`
 * below, because the failure mode otherwise is silent in the worst way: adding
 * a step to {@link ProducerQuiescentTeardownSteps} and forgetting it here
 * type-checks, ships, and simply never runs that teardown. Nothing throws, no
 * test fails, and the resource just leaks on every shutdown. A sequencer whose
 * whole purpose is "no step is skipped" must not be able to skip a step by
 * omission.
 */
const TEARDOWN_ORDER = [
  'closeServer',
  'drainCatchupJobs',
  'flushTelemetry',
  'stopPublisherRuntime',
  'stopPromoteWorker',
  'closeCatchupRunner',
  'stopAgent',
  'stopTelemetry',
] as const satisfies readonly TeardownStepName[];

/**
 * Compile-time guard. If a step is missing from {@link TEARDOWN_ORDER} this
 * resolves to a tuple naming the omission instead of `true`, and the assignment
 * below fails to compile with the missing key in the error text.
 */
type _TeardownOrderExhaustive =
  Exclude<TeardownStepName, (typeof TEARDOWN_ORDER)[number]> extends never
    ? true
    : ['TEARDOWN_ORDER is missing steps:', Exclude<TeardownStepName, (typeof TEARDOWN_ORDER)[number]>];
const _TEARDOWN_ORDER_IS_EXHAUSTIVE: _TeardownOrderExhaustive = true;
void _TEARDOWN_ORDER_IS_EXHAUSTIVE;

export interface TeardownStepFailure {
  step: TeardownStepName;
  error: unknown;
}

export interface TeardownOutcome {
  /** Empty on a fully clean teardown. Order matches execution order. */
  failures: TeardownStepFailure[];
  /** Agent physical work is still alive; backing stores must remain open. */
  dependencyQuarantined: boolean;
}

const DEPENDENCY_QUARANTINE_ERROR_CODES = new Set([
  'VmReconcileShutdownTimeout',
  'CG_MEMBERSHIP_PERSIST_SHUTDOWN_TIMEOUT',
]);

function isDependencyQuarantineError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && DEPENDENCY_QUARANTINE_ERROR_CODES.has(String((error as { code?: unknown }).code));
}

/**
 * Runs every step, in order, **regardless of whether an earlier one failed**,
 * and reports what broke instead of throwing.
 *
 * ## Why no step may abort the sequence
 *
 * This used to be a bare chain of `await`s, on the stated assumption that no
 * step could reject. That assumption was checked only against the step this
 * PR added (`flushTelemetry`, whose legs are individually caught) and never
 * against the ones that were already here. `DKGAgent.stop()` in particular
 * **rejects by design**: it has no top-level try/catch, four unguarded awaits,
 * and three deliberate rethrows at its end — `dkg-agent.ts:1847-1854` —
 * documented there as "the original close failure is re-thrown after teardown
 * so the operator receives a failed shutdown rather than a false success".
 *
 * With a bare chain, that contract silently downgraded graceful shutdown to
 * abrupt: an `agent.stop()` rejection skipped `stopTelemetry`, and back in
 * `lifecycle.ts` it also skipped `managedOxigraph.stop()` and `dashDb.close()`,
 * surfacing only as one generic `Shutdown cleanup error:` line. Telemetry
 * shutdown was newly exposed to it, because this PR is what moved
 * `stopTelemetry` after `agent.stop()`.
 *
 * Every step here is cleanup, so continuing is always safe and always worth
 * more than stopping. There is deliberately **no per-step "fatal" flag**: no
 * step exists for which aborting would be correct, and an option whose every
 * use is "keep going" is dead policy that invites the next person to pick the
 * other value for a bad reason. `DKGAgent.stop()` already does exactly this —
 * run all cleanup, then report — and this sequencer now matches it.
 *
 * ## This is stricter than aborting, not laxer
 *
 * A step whose contract is "cannot reject" still has that violation
 * **reported**, by name, in {@link TeardownOutcome.failures} and in the log —
 * rather than swallowed. `flushTelemetry`'s "never throws into the shutdown
 * path" contract is pinned where it lives, by its own mutant in
 * `node-ui/test/telemetry.test.ts`, which calls it directly and does not go
 * through this sequencer at all.
 *
 * ## One action per entry
 *
 * The guard is per-entry, so an entry that composes several sequential awaits
 * would strand its own tail before this catch ever sees the failure. Keep new
 * steps atomic; do not fold two actions into one entry.
 *
 * Resolves #2029, which asked for a deliberate choice between guarding each
 * step and enforcing "no step may reject" at the builder boundary. This is the
 * first option. That issue predicted the guard would MASK M17 — the mutant
 * removing the `.catch` around the bounded meter flush — because M17 was
 * thought to be killed by the rejection propagating through this sequencer.
 * It is not: M17 stays killed by three direct-call assertions in
 * `node-ui/test/telemetry.test.ts` that never reach this function, verified by
 * re-running the mutation against this version. The invariant is still pinned.
 */
export async function runProducerQuiescentTeardown(
  steps: ProducerQuiescentTeardownSteps,
  log: (message: string) => void = () => {},
): Promise<TeardownOutcome> {
  const failures: TeardownStepFailure[] = [];
  let dependencyQuarantined = false;
  for (const step of TEARDOWN_ORDER) {
    try {
      await steps[step]();
    } catch (error) {
      failures.push({ step, error });
      if (step === 'stopAgent' && isDependencyQuarantineError(error)) {
        dependencyQuarantined = true;
      }
      log(
        `[shutdown] teardown step "${step}" failed: ` +
          `${error instanceof Error ? error.message : String(error)} — continuing with the rest.`,
      );
    }
  }
  return { failures, dependencyQuarantined };
}

export async function closeDaemonBackingStoresAfterTeardown(
  outcome: TeardownOutcome,
  deps: {
    retryAgentStop: () => Promise<void>;
    stopManagedOxigraph: () => Promise<void>;
    closeDashboardDb: () => void;
    log: (message: string) => void;
  },
): Promise<boolean> {
  if (outcome.dependencyQuarantined) {
    deps.log(
      '[shutdown] backing stores remain live because agent physical work did not retire; '
      + 'retrying retirement until it succeeds or the outer shutdown deadline forces exit',
    );
    while (true) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      try {
        await deps.retryAgentStop();
        break;
      } catch (error) {
        if (isDependencyQuarantineError(error)) continue;
        deps.log(
          `[shutdown] agent retirement retry completed with a non-quarantine error: `
          + `${error instanceof Error ? error.message : String(error)}; continuing backing-store teardown`,
        );
        break;
      }
    }
  }
  await deps.stopManagedOxigraph().catch((error: unknown) => {
    deps.log(`Managed Oxigraph stop error: ${error instanceof Error ? error.message : String(error)}`);
  });
  deps.closeDashboardDb();
  return true;
}

/**
 * The daemon-side resources this teardown drives, named individually.
 *
 * Exists so the WIRING is callable, not just the ordering. A test that injects
 * step doubles proves `runProducerQuiescentTeardown` sequences correctly and
 * nothing more — but the defect this whole section fixes was a wiring one:
 * shipped `lifecycle.ts` called `stopTelemetry()` before `agent.stop()`.
 * Assembling the steps here, from raw dependencies, means a mis-wiring is
 * expressible and therefore assertable.
 *
 * It also moves two decisions out of an inline object literal in a 3800-line
 * function and into tested surface: the drain budget and the log threading.
 */
export interface ProducerQuiescentTeardownDeps {
  server: { close: () => void };
  drainCatchupJobs: (budgetMs: number, log: (message: string) => void) => Promise<unknown>;
  flushTelemetry: (options: { log: (message: string) => void }) => Promise<void>;
  /** Publisher runtime; stops first because it feeds the promote queue. */
  stopPublisherRuntime: () => Promise<void>;
  /** Async-promote worker; must drain BEFORE the agent closes, because
   *  `agent.stop()` takes the queue's underlying triple store away. */
  stopPromoteWorker: () => Promise<void>;
  /** `close()` on the catch-up runner, i.e. `worker.terminate()`. */
  closeCatchupRunner: () => Promise<void>;
  stopAgent: () => Promise<void>;
  stopTelemetry: () => Promise<void>;
  log: (message: string) => void;
  /** Defaults to {@link CATCHUP_SHUTDOWN_DRAIN_BUDGET_MS}. */
  drainBudgetMs?: number;
}

export function buildProducerQuiescentTeardownSteps(
  deps: ProducerQuiescentTeardownDeps,
): ProducerQuiescentTeardownSteps {
  return {
    closeServer: () => deps.server.close(),
    drainCatchupJobs: async () => {
      await deps.drainCatchupJobs(
        deps.drainBudgetMs ?? CATCHUP_SHUTDOWN_DRAIN_BUDGET_MS,
        deps.log,
      );
    },
    flushTelemetry: () => deps.flushTelemetry({ log: deps.log }),
    stopPublisherRuntime: () => deps.stopPublisherRuntime(),
    stopPromoteWorker: () => deps.stopPromoteWorker(),
    closeCatchupRunner: () => deps.closeCatchupRunner(),
    stopAgent: () => deps.stopAgent(),
    stopTelemetry: () => deps.stopTelemetry(),
  };
}
