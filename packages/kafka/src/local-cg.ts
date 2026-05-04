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

// In-flight promise gate. Concurrent callers that arrive while a create is
// running await the same promise instead of racing to issue parallel creates
// against the underlying store.
let inFlight: Promise<string> | null = null;

export async function ensureKafkaLocalCg(cg: LocalCgPrimitive): Promise<string> {
  if (inFlight) {
    return inFlight;
  }
  inFlight = (async () => {
    try {
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
    } finally {
      // Clear the gate so future startups (e.g. after the local CG was
      // deleted out from under us) re-run the exists check rather than
      // returning a cached id from a stale process state. Effectively a
      // single-shot gate per concurrent burst.
      inFlight = null;
    }
  })();
  return inFlight;
}
