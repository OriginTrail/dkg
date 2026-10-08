// daemon/routes/durable-chat-turn-response.ts
//
// How a durable-turn outcome is answered over HTTP, for every local-agent
// channel that persists through `persistDurableChatTurn` (OpenClaw, Hermes,
// Prime Agent). The owner decides what happened to a turn (created, duplicate,
// transitioned) and knows nothing of HTTP; this is the one place that turns that
// decision into the JSON body of a 200 answer. A channel's route helper adds
// only the fields that are its own, after these: Prime Agent names the session
// it stored under.

import type { DurableChatTurnOutcome } from '../chat-turn-persistence.js';

/**
 * The body of a 200 persist-turn answer: `{ ok, duplicate? | transitioned?,
 * turnId }`, in that key order.
 *
 * - created: neither flag, the turn was written;
 * - duplicate: `duplicate: true`, nothing was written;
 * - transitioned: `transitioned: true`, an upward state change was recorded and
 *   no second exchange was written.
 *
 * `turnId` names the turn the owner acted on, so a caller that sent none (and
 * was given a generated id) can retry idempotently.
 */
export type DurableChatTurnResponseBody = {
  ok: true;
  duplicate?: true;
  transitioned?: true;
  turnId: string;
};

export function durableChatTurnResponseBody(outcome: DurableChatTurnOutcome): DurableChatTurnResponseBody {
  return {
    ok: true,
    ...(outcome.kind === 'duplicate' ? { duplicate: true as const } : {}),
    ...(outcome.kind === 'transitioned' ? { transitioned: true as const } : {}),
    turnId: outcome.turnId,
  };
}
