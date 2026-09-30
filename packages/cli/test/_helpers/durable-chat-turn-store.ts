import { vi } from 'vitest';
import type { ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import type { ChatTurnPersistenceState } from '../../src/daemon/chat-turn-persistence.js';

type StoreExchangeArgs = Parameters<ChatMemoryManager['storeChatExchange']>;
type RecordTransitionArgs = Parameters<ChatMemoryManager['recordChatTurnPersistenceTransition']>;

/** The key a `(sessionId, turnId)` has in the fake store; the real store trims the turn id too. */
export const turnStateKey = (sessionId: string, turnId: string): string => `${sessionId}\n${turnId.trim()}`;

/**
 * A state-aware in-memory stand-in for the chat memory manager's durable-turn
 * surface (`DurableChatTurnStore`).
 *
 * It remembers what it was asked to store, keyed by `(sessionId, turnId)` the
 * way `ChatMemoryManager` does, so a resend really finds the earlier turn, and
 * every method is a `vi.fn` so a test can count calls, read their arguments or
 * override one call with `mockImplementationOnce` (a gate, a rejection).
 * `daemon-openclaw.part-*.test.ts` mocks do not answer
 * `getChatTurnPersistenceState`, and `persistDurableChatTurn` treats a failing
 * state read as "unknown" and stores anyway, so those mocks cannot detect the
 * durable-turn dedupe; this one can.
 *
 * `states` is the durable state by key; `seed` puts a turn there as if an
 * earlier report had already stored it.
 */
export function makeDurableChatTurnStore() {
  const states = new Map<string, ChatTurnPersistenceState>();
  return {
    states,
    seed(sessionId: string, turnId: string, state: ChatTurnPersistenceState): void {
      states.set(turnStateKey(sessionId, turnId), state);
    },
    getChatTurnPersistenceState: vi.fn(
      async (sessionId: string, turnId: string): Promise<ChatTurnPersistenceState | null> =>
        states.get(turnStateKey(sessionId, turnId)) ?? null,
    ),
    storeChatExchange: vi.fn(
      async (sessionId: string, _userMessage: string, _assistantReply: string, _toolCalls?: StoreExchangeArgs[3], opts?: StoreExchangeArgs[4]): Promise<void> => {
        const turnId = opts?.turnId?.trim();
        if (turnId) states.set(turnStateKey(sessionId, turnId), opts?.persistenceState ?? 'stored');
      },
    ),
    recordChatTurnPersistenceTransition: vi.fn(
      async (sessionId: string, turnId: string, state: ChatTurnPersistenceState, _opts?: RecordTransitionArgs[3]): Promise<void> => {
        states.set(turnStateKey(sessionId, turnId), state);
      },
    ),
  };
}

export type DurableChatTurnStoreDouble = ReturnType<typeof makeDurableChatTurnStore>;
