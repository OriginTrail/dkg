// Lazy-creation orchestrator for the node-local "kafka-local" free CG.
//
// "Free CG" = local-only context graph, never registered on-chain. Created
// via `agent.createContextGraph()` with no `registerContextGraph()` follow-up.
// The id `kafka-local` is reserved at the package level: callers must not
// pick it as a shared CG id.

export const KAFKA_LOCAL_CG_ID = 'kafka-local';

const KAFKA_LOCAL_DEFAULT_NAME = 'Kafka Local';

/**
 * Minimal V10 free-CG creation surface this module needs. Injected so unit
 * tests run without a real DKG agent and the same code path serves both.
 */
export interface LocalCgPrimitive {
  contextGraphExists(id: string): Promise<boolean>;
  createContextGraph(opts: { id: string; name: string }): Promise<void>;
}

/**
 * Returns a thunk that ensures `kafka-local` exists and resolves to its id.
 * Concurrent callers in a burst share one in-flight create; the gate clears
 * in `finally` so a later call after deletion re-runs the exists-check. The
 * gate lives in this closure so two ensurers built from different primitives
 * don't accidentally share state keyed only on the literal `kafka-local`.
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
        // Race tolerance: another path (peer sync, parallel CLI) may have
        // created `kafka-local` between our exists-check and our create.
        // The agent surfaces this with an "already exists" message.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(msg)) {
          throw err;
        }
      }
      return KAFKA_LOCAL_CG_ID;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
