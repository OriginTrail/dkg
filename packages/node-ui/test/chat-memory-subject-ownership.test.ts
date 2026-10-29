import { describe, expect, it } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';
import { OxigraphStore } from '../../storage/src/adapters/oxigraph.js';

import { GRAPH, CHAT, DKG, RDF_TYPE, createChatTurnStoreFixture } from './helpers/chat-turn-store.js';

async function fixture() {
  const store = new OxigraphStore();
  const { tools, insert, seed } = createChatTurnStoreFixture(store);
  const manager = new ChatMemoryManager(tools, { apiKey: '' });
  return { store, manager, insert, seed };
}

describe('chat turn subject ownership and precedence', () => {
  it('never projects an unattributable shared legacy completion into either session', async () => {
    const { manager, insert, seed } = await fixture();
    const legacy = `${CHAT}turn:1`;
    await seed('a', legacy, 'A original');
    await seed('b', legacy, 'B original');
    await insert(
      [`${CHAT}transition:a`, RDF_TYPE, `${DKG}ChatTurnPersistenceTransition`],
      [`${CHAT}transition:a`, `${DKG}updatesTurn`, legacy],
      [`${CHAT}transition:a`, `${DKG}persistenceState`, '"stored"'],
      [`${CHAT}transition:a`, `${DKG}assistantReply`, '"A completed"'],
    );
    for (const [sessionId, original] of [['a', 'A original'], ['b', 'B original']]) {
      const history = await manager.getSession(sessionId);
      expect(history?.messages).toHaveLength(1);
      expect(history!.messages[0].text).toBe(original);
      expect(history!.messages[0].persistStatus).toBeUndefined();
      expect(await manager.getChatTurnPersistenceState(sessionId, '1')).toBeNull();
    }
    expect((await manager.getRecentChats()).flatMap((s) => s.messages.map((m) => m.text))).toEqual(expect.arrayContaining(['A original', 'B original']));
  });

  it('explicitly prefers a scoped subject for transitions, history, and graph delta', async () => {
    const { manager, seed, store } = await fixture();
    const legacy = `${CHAT}turn:1`;
    const scoped = `${CHAT}session-turn:owned`;
    await seed('a', legacy, 'base reply', 'stored');
    await seed('a', scoped, 'base reply', 'pending');
    const older = `${CHAT}aaa-legacy`;
    await seed('a', older, 'base reply', 'stored');
    await manager.recordChatTurnPersistenceTransition('a', '1', 'failed', { failureReason: 'scoped only' });
    const transition = await store.query(`SELECT ?turn WHERE { GRAPH <${GRAPH}> {
      ?transition <${DKG}updatesTurn> ?turn .
    } }`);
    expect(transition.type === 'bindings' && transition.bindings[0]?.turn).toBe(scoped);
    expect(await manager.getChatTurnPersistenceState('a', '1')).toBe('failed');
    const history = await manager.getSession('a');
    expect(history?.messages[0].persistStatus).toBe('failed');
    expect(history?.messages[0].failureReason).toBe('scoped only');
    const delta = await manager.getSessionGraphDelta('a', '1');
    expect(delta.mode).toBe('delta');
    expect(delta.triples.some((quad) => quad.subject === scoped)).toBe(true);
    expect(delta.triples.some((quad) => quad.subject === legacy || quad.subject === older)).toBe(false);
  });

  it('preserves completion from an exclusively owned legacy subject', async () => {
    const { manager, seed } = await fixture();
    await seed('a', `${CHAT}turn:1`, 'original');
    await manager.recordChatTurnPersistenceTransition('a', '1', 'stored', { assistantReply: 'complete' });
    expect((await manager.getSession('a'))?.messages[0]).toMatchObject({ text: 'complete', persistStatus: 'stored' });
  });

  it('uses the same selected turn coordinates for delta predecessor, latest, count and index', async () => {
    const { manager, seed } = await fixture();
    await seed('a', `${CHAT}turn:1`, 'one', 'stored', '1', '2026-10-01T09:00:00Z');
    await seed('a', `${CHAT}turn:2`, 'legacy two', 'stored', '2', '2026-10-01T10:00:00Z');
    await seed('a', `${CHAT}session-turn:two`, 'scoped two', 'stored', '2', '2026-10-01T11:00:00Z');
    await seed('a', `${CHAT}session-turn:two-z`, 'duplicate scoped two', 'stored', '2', '2026-10-01T23:00:00Z');
    await seed('a', `${CHAT}turn:3`, 'legacy three', 'stored', '3', '2026-10-01T20:00:00Z');
    await seed('a', `${CHAT}session-turn:three`, 'scoped three', 'stored', '3', '2026-10-01T12:00:00Z');
    const delta = await manager.getSessionGraphDelta('a', '2', { baseTurnId: '1' });
    expect(delta.mode).toBe('delta');
    expect(delta.watermark).toMatchObject({ previousTurnId: '1', latestTurnId: '3', turnCount: 3, turnIndex: 2 });
    expect(delta.triples.some((quad) => quad.subject === `${CHAT}session-turn:two`)).toBe(true);
    expect(delta.triples.some((quad) => quad.subject === `${CHAT}turn:2`)).toBe(false);
    const last = await manager.getSessionGraphDelta('a', '3', { baseTurnId: '2' });
    expect(last.mode).toBe('delta');
    expect(last.watermark).toMatchObject({ previousTurnId: '2', turnCount: 3, turnIndex: 3 });
  });

  it('keeps an owned legacy turn when a competing scoped candidate is shared', async () => {
    const { manager, seed, store } = await fixture();
    const legacy = `${CHAT}turn:1`;
    const scoped = `${CHAT}session-turn:unattributable`;
    await seed('a', legacy, 'owned legacy');
    await seed('a', scoped, 'ambiguous a', 'stored');
    await seed('b', scoped, 'ambiguous b', 'stored');
    expect(await manager.getChatTurnPersistenceState('a', '1')).toBe('pending');
    await manager.recordChatTurnPersistenceTransition('a', '1', 'stored', { assistantReply: 'legacy complete' });
    const transition = await store.query(`SELECT ?turn WHERE { GRAPH <${GRAPH}> { ?transition <${DKG}updatesTurn> ?turn } }`);
    expect(transition.type === 'bindings' && transition.bindings[0]?.turn).toBe(legacy);
    expect(await manager.getChatTurnPersistenceState('a', '1')).toBe('stored');
    expect((await manager.getSession('a'))?.messages.some((message) => message.text === 'legacy complete')).toBe(true);
    expect(await manager.getChatTurnPersistenceState('b', '1')).toBeNull();
  });

});
