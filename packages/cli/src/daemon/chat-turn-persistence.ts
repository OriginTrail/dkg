import type { OpenClawAttachmentRef } from './openclaw.js';
import type { RequestContext } from './routes/context.js';

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
  kind: 'created' | 'duplicate' | 'transitioned' | 'transition-unavailable';
  sessionId: string;
  turnId: string;
};

type ChatMemoryManager = RequestContext['memoryManager'];

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
  memoryManager: ChatMemoryManager,
  sessionId: string,
  turnId: string,
): Promise<ChatTurnPersistenceState | null> {
  const manager = memoryManager as unknown as {
    getChatTurnPersistenceState?: (
      sessionId: string,
      turnId: string,
    ) => Promise<ChatTurnPersistenceState | null>;
    hasChatTurn?: (sessionId: string, turnId: string) => Promise<boolean>;
  };
  if (typeof manager.getChatTurnPersistenceState === 'function') {
    return manager.getChatTurnPersistenceState.call(memoryManager, sessionId, turnId);
  }
  if (typeof manager.hasChatTurn === 'function') {
    return await manager.hasChatTurn.call(memoryManager, sessionId, turnId) ? 'stored' : null;
  }
  return null;
}

async function persistDurableChatTurnUnlocked(args: {
  memoryManager: ChatMemoryManager;
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
    const recorder = (memoryManager as unknown as {
      recordChatTurnPersistenceTransition?: (
        sessionId: string,
        turnId: string,
        persistenceState: ChatTurnPersistenceState,
        opts?: {
          failureReason?: string | null;
          assistantReply?: string;
          toolCalls?: ChatTurnToolCall[];
          attachmentRefs?: OpenClawAttachmentRef[];
        },
      ) => Promise<void>;
    }).recordChatTurnPersistenceTransition;
    if (typeof recorder !== 'function') {
      return {
        kind: 'transition-unavailable',
        sessionId: payload.sessionId,
        turnId: payload.turnId,
      };
    }
    await recorder.call(
      memoryManager,
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
  memoryManager: ChatMemoryManager;
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
