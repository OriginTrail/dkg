// Lazy-creation orchestrator for the node-local "kafka-local" free CG.
//
// "Free CG" = local-only context graph, never registered on-chain. Created via
// the V10 `agent.createContextGraph()` primitive without any
// `agent.registerContextGraph()` follow-up. The id `kafka-local` is reserved
// at the package level: callers must not pick `kafka-local` as a shared CG id.
//
// Idempotency contract:
//   - First call when the CG is missing → creates it once.
//   - Subsequent calls → return the id without touching the store.
//   - Concurrent calls during a single daemon startup → exactly one create
//     wins; the others observe the in-flight create and resolve to the same
//     id without re-issuing the create. This is enforced by an in-process
//     promise gate, not by relying on the underlying store's "already exists"
//     guard alone (the guard is the second-line defence).
//
// The gate must be bound to a specific `cg` primitive so two different
// agents (e.g. multiple sub-processes sharing this module) don't accidentally
// serialize against each other. `createKafkaLocalCgEnsurer(cg)` returns a
// thunk whose closure owns its own gate — see the factory below.

const KAFKA_LOCAL_DEFAULT_NAME = 'Kafka Local';

export const KAFKA_LOCAL_CG_ID = 'kafka-local';

/**
 * Minimal V10 free-CG creation surface this module needs. Injected as a
 * dependency so unit tests can run without spinning up a real DKG agent and
 * so the same code path serves both production (real agent) and tests.
 */
export interface LocalCgPrimitive {
  contextGraphExists(id: string): Promise<boolean>;
  createContextGraph(opts: { id: string; name: string }): Promise<void>;
}

/**
 * Create an ensurer thunk bound to a specific V10 free-CG primitive. The
 * returned function is a single-shot gate per concurrent burst: parallel
 * callers within the same burst share one in-flight create; once that create
 * resolves the gate clears in `finally`, so a future call (e.g. after the
 * local CG was deleted out from under the process) re-runs the exists-check
 * and short-circuits when the CG is present.
 *
 * The gate lives in this closure rather than at module scope so each
 * primitive instance gets its own gate — this prevents hidden coupling where
 * two callers with different `cg` primitives would otherwise silently share
 * one gate keyed only on the literal `kafka-local`.
 */
export function createKafkaLocalCgEnsurer(
  cg: LocalCgPrimitive,
): () => Promise<string> {
  let inFlight: Promise<string> | null = null;

  return async function ensureKafkaLocalCg(): Promise<string> {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      const exists = await cg.contextGraphExists(KAFKA_LOCAL_CG_ID);
      if (exists) {
        return KAFKA_LOCAL_CG_ID;
      }
      try {
        await cg.createContextGraph({
          id: KAFKA_LOCAL_CG_ID,
          name: KAFKA_LOCAL_DEFAULT_NAME,
        });
      } catch (err: unknown) {
        // Race tolerance: another path (e.g. a different in-flight register
        // call from a previous run already past its gate, or external
        // creation by /api/context-graph/create) may have created
        // kafka-local between our exists-check and our create. The agent's
        // own "already exists" guard surfaces with this message.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(msg)) {
          throw err;
        }
      }
      return KAFKA_LOCAL_CG_ID;
    })().finally(() => {
      // Clear the gate so future startups (e.g. after the local CG was
      // deleted out from under us) re-run the exists check rather than
      // returning a cached id from a stale process state. Effectively a
      // single-shot gate per concurrent burst.
      inFlight = null;
    });
    return inFlight;
  };
}
