// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { persistDurableChatTurn } from '../src/daemon/chat-turn-persistence.js';

import { GRAPH, CHAT, DKG, SCHEMA, createChatTurnStoreFixture } from '../../../test-systems/fixtures/chat-turn-store.js';

async function fixture() {
  const store = new OxigraphStore();
  const { tools, insert, seed } = createChatTurnStoreFixture(store);
  const manager = new ChatMemoryManager(tools, { apiKey: '' });
  return { store, manager, insert, seed };
}

describe('daemon durable chat-turn session recovery', () => {
  it('recovers both sessions sharing a legacy turn ID through independent durable subjects', async () => {
    const { manager, seed, store } = await fixture();
    try {
      await seed('a', `${CHAT}turn:1`, 'A original');
      await seed('b', `${CHAT}turn:1`, 'B original');
      let callbacks = 0;
      const args = (sessionId: string, assistantReply: string) => ({
        memoryManager: manager,
        payload: { sessionId, turnId: '1', userMessage: `retry ${sessionId}`, assistantReply, persistenceState: 'stored' as const },
        afterStored: async () => { callbacks += 1; },
      });
      for (const [sessionId, reply] of [['a', 'A completed'], ['b', 'B completed']]) {
        expect((await persistDurableChatTurn(args(sessionId, reply))).kind).toBe('created');
        expect((await persistDurableChatTurn(args(sessionId, reply))).kind).toBe('duplicate');
      }
      expect(callbacks).toBe(2);
      const subjects = await store.query(`SELECT ?turn ?session WHERE { GRAPH <${GRAPH}> {
        ?turn a <${DKG}ChatTurn> ; <${DKG}turnId> "1" ; <${SCHEMA}isPartOf> ?session .
        FILTER(STRSTARTS(STR(?turn), "${CHAT}session-turn:"))
      } }`);
      if (subjects.type !== 'bindings') throw new Error('Expected turn subjects');
      expect(subjects.bindings).toHaveLength(2);
      expect(new Set(subjects.bindings.map(row => row.turn)).size).toBe(2);
      expect(subjects.bindings.map(row => row.session).sort()).toEqual([`${CHAT}session:a`, `${CHAT}session:b`]);
      for (const [sessionId, ownReply, foreignReply] of [['a', 'A completed', 'B completed'], ['b', 'B completed', 'A completed']]) {
        expect(await manager.getChatTurnPersistenceState(sessionId, '1')).toBe('stored');
        const history = await manager.getSession(sessionId);
        expect(history?.messages.some(message => message.text === ownReply && message.persistStatus === 'stored')).toBe(true);
        expect(history?.messages.some(message => message.text === foreignReply)).toBe(false);
      }
      await manager.recordChatTurnPersistenceTransition('a', '1', 'stored', { assistantReply: 'A updated' });
      expect((await manager.getSession('a'))?.messages.some(message => message.text === 'A updated' && message.persistStatus === 'stored')).toBe(true);
      expect((await manager.getSession('b'))?.messages.some(message => message.text === 'B completed' && message.persistStatus === 'stored')).toBe(true);
      expect((await persistDurableChatTurn(args('b', 'should not overwrite B'))).kind).toBe('duplicate');
      expect(callbacks).toBe(2);
    } finally { await store.close(); }
  });

});
