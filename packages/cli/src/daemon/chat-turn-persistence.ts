import type { ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import type { OpenClawAttachmentRef } from './openclaw.js';

export type ChatTurnPersistenceState = 'stored' | 'failed' | 'pending';

export type ChatTurnToolCall = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
};

export type DurableChatTurnPayload = {
  sessionId: string;
  turnId: string;
  userMessage: string;
  assistantReply: string;
  persistenceState: ChatTurnPersistenceState;
  failureReason?: string;
  toolCalls?: ChatTurnToolCall[];
  attachmentRefs?: OpenClawAttachmentRef[];
};

export type DurableChatTurnOutcome = {
  kind: 'created' | 'duplicate' | 'transitioned';
  sessionId: string;
  turnId: string;
};

/** Required storage contract for the daemon's durable-turn state machine. */
export type DurableChatTurnStore = Pick<
  ChatMemoryManager,
  | 'getChatTurnPersistenceState'
  | 'recordChatTurnPersistenceTransition'
  | 'storeChatExchange'
>;

const chatTurnPersistenceInflight = new Map<string, Promise<DurableChatTurnOutcome>>();

function persistenceStateRank(state: ChatTurnPersistenceState): number {
  if (state === 'stored') return 3;
  if (state === 'failed') return 2;
  return 1;
}

function persistenceKey(sessionId: string, turnId: string): string {
  return `${sessionId}\n${turnId}`;
}

async function readPersistenceState(
  memoryManager: DurableChatTurnStore,
  sessionId: string,
  turnId: string,
): Promise<ChatTurnPersistenceState | null> {
  return memoryManager.getChatTurnPersistenceState(sessionId, turnId);
}

async function persistDurableChatTurnUnlocked(args: {
  memoryManager: DurableChatTurnStore;
  payload: DurableChatTurnPayload;
  afterStored?: () => Promise<void>;
}): Promise<DurableChatTurnOutcome> {
  const { memoryManager, payload } = args;
  let existingState: ChatTurnPersistenceState | null = null;
  try {
    existingState = await readPersistenceState(memoryManager, payload.sessionId, payload.turnId);
  } catch {
    // A state lookup is an optimization, not authority to drop a turn. Preserve
    // the existing fail-open-to-store behavior and let the write report any
    // durable storage failure to the caller.
    existingState = null;
  }

  if (
    existingState === 'stored'
    || existingState === payload.persistenceState
    || (
      existingState != null
      && persistenceStateRank(payload.persistenceState) < persistenceStateRank(existingState)
    )
  ) {
    return {
      kind: 'duplicate',
      sessionId: payload.sessionId,
      turnId: payload.turnId,
    };
  }

  if (existingState) {
    await memoryManager.recordChatTurnPersistenceTransition(
      payload.sessionId,
      payload.turnId,
      payload.persistenceState,
      {
        failureReason: payload.failureReason ?? null,
        assistantReply: payload.assistantReply,
        toolCalls: payload.toolCalls,
        attachmentRefs: payload.attachmentRefs,
      },
    );
    if (payload.persistenceState === 'stored') await args.afterStored?.();
    return {
      kind: 'transitioned',
      sessionId: payload.sessionId,
      turnId: payload.turnId,
    };
  }

  await memoryManager.storeChatExchange(
    payload.sessionId,
    payload.userMessage,
    payload.assistantReply,
    payload.toolCalls,
    {
      turnId: payload.turnId,
      attachmentRefs: payload.attachmentRefs,
      persistenceState: payload.persistenceState,
      failureReason: payload.failureReason,
    },
  );
  if (payload.persistenceState === 'stored') await args.afterStored?.();
  return {
    kind: 'created',
    sessionId: payload.sessionId,
    turnId: payload.turnId,
  };
}

/**
 * One daemon-wide owner for durable local-agent turn idempotency.
 *
 * The promise chain serializes the complete read/transition/write sequence for
 * one `(sessionId, turnId)` while allowing unrelated turns to persist in
 * parallel. Every queued reporter re-reads durable state after its predecessor
 * settles, so duplicate suppression and upward state transitions are atomic at
 * the route layer shared by Hermes, Prime Agent, and future local agents.
 */
export async function persistDurableChatTurn(args: {
  memoryManager: DurableChatTurnStore;
  payload: DurableChatTurnPayload;
  afterStored?: () => Promise<void>;
}): Promise<DurableChatTurnOutcome> {
  const key = persistenceKey(args.payload.sessionId, args.payload.turnId);
  const previous = chatTurnPersistenceInflight.get(key);
  const operation = (previous
    ? previous.then(() => undefined, () => undefined)
    : Promise.resolve()
  ).then(() => persistDurableChatTurnUnlocked(args));
  chatTurnPersistenceInflight.set(key, operation);
  try {
    return await operation;
  } finally {
    if (chatTurnPersistenceInflight.get(key) === operation) {
      chatTurnPersistenceInflight.delete(key);
    }
  }
}
