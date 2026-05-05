// Lazy-creation orchestrator for the node-local kafka-local free CG.
//
// "Free CG" = local-only context graph, never registered on-chain. Created
// via `agent.createContextGraph({ private: true })` so the V10 agent skips
// gossip subscription/broadcast (`dkg-agent.ts:3837` flips `subscribed` off
// when `private: true`). Hardcoding `private: true` at the route adapter is
// what makes the CG truly node-local — without it, the agent would still
// auto-subscribe to its own gossip topics and leak the CG definition.
//
// Per-node uniqueness: the CG id is `kafka-local-{peerId}` rather than a bare
// `kafka-local`. This makes a cross-node id collision impossible by
// construction — two nodes literally cannot pick the same id — and removes
// the need for a post-create privacy probe. We pick the libp2p peer-id (not
// a wallet address) because peer-id is the canonical, stable node identity:
// `DKG_CREATOR` already records `did:dkg:agent:{peerId}` and a node may run
// multiple operational wallets that rotate independently.
//
// Promotion path (informational): a node-local kafka-local CG can be promoted
// in place via the existing V10 primitives — `dkg assertion promote` moves
// quads from the assertion graph (LWM) into the shared-memory graph (SWM)
// inside the SAME CG, and `dkg context-graph register` anchors the CG
// on-chain and flips `subscribed: false → true` (`dkg-agent.ts:4227-4236`),
// at which point SWM data starts flowing to peers. Slice 02 ships no
// promotion code of its own — the platform already covers it.

export const KAFKA_LOCAL_CG_ID_PREFIX = 'kafka-local-';
export const KAFKA_LOCAL_CG_BARE_ID = 'kafka-local';

/**
 * Builds the per-node kafka-local CG id from a libp2p peer-id. Two nodes
 * cannot collide on this id by construction.
 */
export function kafkaLocalCgIdFor(peerId: string): string {
  return `${KAFKA_LOCAL_CG_ID_PREFIX}${peerId}`;
}

/**
 * Minimal V10 free-CG creation surface this module needs. Injected so unit
 * tests run without a real DKG agent and the same code path serves both. The
 * `createPrivateContextGraph` name is deliberate — the privacy guarantee is
 * encoded in the method name rather than a boolean flag, so a future caller
 * cannot accidentally drop `private: true` at the boundary.
 */
export interface LocalCgPrimitive {
  contextGraphExists(id: string): Promise<boolean>;
  createPrivateContextGraph(opts: { id: string; name: string }): Promise<void>;
}

/**
 * Returns a thunk that ensures the per-node kafka-local CG exists and resolves
 * to its id. Concurrent callers in a burst share one in-flight create; the
 * gate clears in `finally` so a later call after deletion re-runs the
 * exists-check. The gate lives in this closure so two ensurers built from
 * different primitives don't accidentally share state keyed only on the id.
 */
export function createKafkaLocalCgEnsurer(
  cg: LocalCgPrimitive,
  peerId: string,
): () => Promise<string> {
  const id = kafkaLocalCgIdFor(peerId);
  // Truncate the peer-id in the human-facing CG name so operator UIs don't
  // get a 50-char id glued onto every label. The id itself stays full-length.
  const displayName = `Kafka Local (${peerId.slice(0, 12)}…)`;
  let inFlight: Promise<string> | null = null;

  return async function ensureKafkaLocalCg(): Promise<string> {
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      const exists = await cg.contextGraphExists(id);
      if (exists) {
        return id;
      }
      try {
        await cg.createPrivateContextGraph({ id, name: displayName });
      } catch (err: unknown) {
        // Race tolerance: another path (parallel CLI, restart-replay) may
        // have created the CG between our exists-check and our create.
        // The agent surfaces this with an "already exists" message.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(msg)) {
          throw err;
        }
      }
      return id;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
