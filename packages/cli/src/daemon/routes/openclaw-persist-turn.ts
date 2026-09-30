// daemon/routes/openclaw-persist-turn.ts
//
// Payload normalization and the durable-turn persistence step behind
// `POST /api/openclaw-channel/persist-turn`. They live beside the route, not in
// it, for the same reason Hermes and Prime Agent keep theirs out of their route
// bodies: `routes/openclaw.ts` stays a router that reads the body, calls the
// normalizer, verifies attachment provenance, calls the persistence helper and
// responds, and this module owns the typed contract between those steps.
//
// The write goes through `persistDurableChatTurn`, the daemon-wide owner of
// durable-turn idempotency shared with Hermes and Prime Agent: a resent
// `(sessionId, turnId)` is a duplicate, a higher `persistenceState` becomes a
// transition instead of a second exchange, and concurrent POSTs for one key are
// serialized.

import { randomUUID } from 'node:crypto';
import {
  persistDurableChatTurn,
  type ChatTurnToolCall,
  type DurableChatTurnPayload,
  type DurableChatTurnStore,
} from '../chat-turn-persistence.js';
import {
  isValidOpenClawPersistTurnPayload,
  normalizeOpenClawAttachmentRefs,
  type OpenClawAttachmentRef,
} from '../openclaw.js';

export type OpenClawPersistRouteResult = {
  statusCode: number;
  body: Record<string, unknown>;
};

/**
 * The durable-turn payload for one persist-turn POST, or the 400 message.
 *
 * `raw` is the parsed request body. The result's `attachmentRefs` are
 * normalized but NOT yet provenance-verified: the route verifies them (it owns
 * the agent and the extraction-status map) and hands the verified refs to
 * `persistOpenClawTurn`, which never forwards these unverified ones.
 *
 * - `sessionId` is forwarded as sent. The validator only requires it to be
 *   non-blank; it is not trimmed, so it keys both the lock and the store as-is.
 * - `turnId` is trimmed before it keys the lock: the store and the state read
 *   both trim, so `" t1 "` and `"t1"` are one turn. A missing, non-string or
 *   blank one takes a generated id. A resend can only be deduped when the
 *   caller repeats a stable `turnId`; a POST without one gets a fresh id and can
 *   never match an earlier turn, which is why the response names the id.
 * - `persistenceState` is `failed` or `pending` when sent, else `stored`.
 * - `failureReason` is trimmed, and blank means none.
 * - `toolCalls` pass through as sent when they are an array (`[]` stays `[]`)
 *   and are dropped otherwise. Their entries are not validated; tightening that
 *   would change what the route accepts.
 * - A JSON `null` body is not guarded: the validator's property reads throw a
 *   TypeError and the daemon's top-level handler answers 500, as this route has
 *   always done. Other non-object bodies get the 400 below.
 */
export function normalizeOpenClawPersistTurnPayload(
  raw: unknown,
): DurableChatTurnPayload | { error: string } {
  const body = raw as Record<string, unknown>;
  if (!isValidOpenClawPersistTurnPayload(body)) {
    return { error: 'Missing required fields: sessionId, userMessage, assistantReply' };
  }

  const turnId = (typeof body.turnId === 'string' ? body.turnId.trim() : '') || randomUUID();
  const persistenceState = body.persistenceState === 'failed' || body.persistenceState === 'pending'
    ? body.persistenceState
    : 'stored';
  const failureReason = typeof body.failureReason === 'string'
    ? body.failureReason.trim() || undefined
    : undefined;
  const toolCalls = Array.isArray(body.toolCalls)
    ? (body.toolCalls as ChatTurnToolCall[])
    : undefined;
  // The validator has already rejected a malformed `attachmentRefs`, so this is
  // undefined only when none were sent.
  const attachmentRefs = normalizeOpenClawAttachmentRefs(body.attachmentRefs);

  return {
    sessionId: body.sessionId,
    turnId,
    userMessage: body.userMessage,
    assistantReply: body.assistantReply,
    persistenceState,
    failureReason,
    toolCalls,
    attachmentRefs,
  };
}

/**
 * Persist one normalized turn through the shared durable-turn owner and map its
 * outcome to the route's response: 200 `{ ok, duplicate? | transitioned?,
 * turnId }`, or 500 `{ error }` when the store fails.
 *
 * `verifiedAttachmentRefs` replace whatever refs the payload carries, so a ref
 * that was not provenance-verified can never reach the store.
 */
export async function persistOpenClawTurn(
  memoryManager: DurableChatTurnStore,
  payload: DurableChatTurnPayload,
  verifiedAttachmentRefs: OpenClawAttachmentRef[] | undefined,
): Promise<OpenClawPersistRouteResult> {
  try {
    const outcome = await persistDurableChatTurn({
      memoryManager,
      payload: { ...payload, attachmentRefs: verifiedAttachmentRefs },
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        ...(outcome.kind === 'duplicate' ? { duplicate: true } : {}),
        ...(outcome.kind === 'transitioned' ? { transitioned: true } : {}),
        turnId: payload.turnId,
      },
    };
  } catch (err) {
    return { statusCode: 500, body: { error: (err as Error).message } };
  }
}
