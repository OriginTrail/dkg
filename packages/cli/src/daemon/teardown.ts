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

export interface ProducerQuiescentTeardownSteps {
  /** Stop accepting new connections. Initiated, not awaited — in-flight
   *  requests keep their sockets and everything below is still alive. */
  closeServer: () => void;
  /** Grace period for retained catch-up jobs, WHILE THE WORKER IS ALIVE,
   *  followed by a terminal record for every job still owed one. */
  drainCatchupJobs: () => Promise<void>;
  /** Flush only. Hard-capped; the providers stay live afterwards. */
  flushTelemetry: () => Promise<void>;
  /** Publisher runtime, async-promote worker, catch-up runner. */
  stopBackgroundWorkers: () => Promise<void>;
  /** The only thing that ends parent-side sync work. */
  stopAgent: () => Promise<void>;
  /** Final flush + provider shutdown. Nothing after this can be measured. */
  stopTelemetry: () => Promise<void>;
}

/**
 * Runs the steps in order. **Every step in this sequence is required not to
 * throw**, and that requirement is deliberately not enforced here.
 *
 * `flushTelemetry` guarantees it internally — both of its legs are individually
 * caught — and the drain, the worker stops and `agent.stop()` are likewise
 * expected to absorb their own failures. Nothing today can reject.
 *
 * A step that DID reject would strand everything after it: the chain is bare
 * `await`s, so the daemon would skip `stopBackgroundWorkers`, `stopAgent`,
 * `stopTelemetry`, `managedOxigraph.stop()` and `dashDb.close()`, and the
 * caller's outer `.catch` in `lifecycle.ts` would report it only as a generic
 * `Shutdown cleanup error:` line. Not a hang and not an unhandled rejection —
 * a silent downgrade from graceful to abrupt shutdown, losing exactly the
 * guarantee A13/A23/A24 exist to provide.
 *
 * The chain is left unguarded on purpose. A blanket try/catch per step would
 * change shutdown semantics for every step and would mask the very mutant that
 * pins `flushTelemetry`'s "never throws into the shutdown path" contract —
 * the same way an outer aggregate timeout would have masked that function's
 * per-leg bounds. Teardown resilience, if we want it, needs its own design and
 * its own mutants rather than a bolt-on here.
 *
 * **Before adding a seventh step, make sure it cannot reject.** Tracked as a
 * follow-up issue; see the PR description.
 */
export async function runProducerQuiescentTeardown(
  steps: ProducerQuiescentTeardownSteps,
): Promise<void> {
  steps.closeServer();
  await steps.drainCatchupJobs();
  await steps.flushTelemetry();
  await steps.stopBackgroundWorkers();
  await steps.stopAgent();
  await steps.stopTelemetry();
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
 * It also moves three decisions out of an inline object literal in a
 * 3800-line function and into tested surface: the sub-order inside
 * {@link ProducerQuiescentTeardownSteps.stopBackgroundWorkers}, the drain
 * budget, and the log threading.
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
    stopBackgroundWorkers: async () => {
      await deps.stopPublisherRuntime();
      await deps.stopPromoteWorker();
      await deps.closeCatchupRunner();
    },
    stopAgent: () => deps.stopAgent(),
    stopTelemetry: () => deps.stopTelemetry(),
  };
}
