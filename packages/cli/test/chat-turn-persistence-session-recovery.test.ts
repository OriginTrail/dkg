// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { persistDurableChatTurn } from '../src/daemon/chat-turn-persistence.js';

const GRAPH = 'urn:test:chat-ownership';
const CHAT = 'urn:dkg:chat:';
const DKG = 'http://dkg.io/ontology/';
const SCHEMA = 'http://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

async function fixture() {
  const store = new OxigraphStore();
  const manager = new ChatMemoryManager({
    query: (sparql: string) => store.query(sparql.replace(/\bWHERE\b/, `FROM <${GRAPH}> WHERE`)),
    listContextGraphs: async () => [{ id: 'agent-context' }],
    createContextGraph: async () => {},
    createAssertion: async () => ({ assertionUri: GRAPH, alreadyExists: true }),
    writeAssertion: async (_cg, _name, quads) => {
      await store.insert(quads.map((quad) => ({ ...quad, graph: GRAPH })));
      return { written: quads.length };
    },
  }, { apiKey: '' });
  const insert = (...triples: Array<[string, string, string]>) => store.insert(triples.map(([subject, predicate, object]) => ({ subject, predicate, object, graph: GRAPH })));
  const seed = async (session: string, turn: string, reply: string, state = 'pending', turnId = '1', timestamp = '2026-10-01T00:00:00Z') => {
    const sessionUri = `${CHAT}session:${session}`;
    const messageUri = `${CHAT}message:${session}:${encodeURIComponent(turn)}`;
    await insert(
      [sessionUri, RDF_TYPE, `${SCHEMA}Conversation`],
      [sessionUri, `${DKG}sessionId`, JSON.stringify(session)],
      [turn, RDF_TYPE, `${DKG}ChatTurn`],
      [turn, `${SCHEMA}isPartOf`, sessionUri],
      [turn, `${DKG}turnId`, JSON.stringify(turnId)],
      [turn, `${DKG}persistenceState`, JSON.stringify(state)],
      [turn, `${SCHEMA}dateCreated`, `"${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`],
      [turn, `${DKG}hasUserMessage`, messageUri],
      [turn, `${DKG}hasAssistantMessage`, messageUri],
      [messageUri, `${SCHEMA}isPartOf`, sessionUri],
      [messageUri, `${SCHEMA}author`, `${CHAT}agent`],
      [messageUri, `${SCHEMA}text`, JSON.stringify(reply)],
      [messageUri, `${DKG}turnId`, JSON.stringify(turnId)],
      [messageUri, `${SCHEMA}dateCreated`, `"${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`],
    );
  };
  return { store, manager, seed };
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
