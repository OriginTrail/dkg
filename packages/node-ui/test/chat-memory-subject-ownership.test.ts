import { describe, expect, it } from 'vitest';
import { ChatMemoryManager } from '../src/chat-memory.js';
import { OxigraphStore } from '../../storage/src/adapters/oxigraph.js';

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
  const seed = async (session: string, turn: string, reply: string, state = 'pending') => {
    const sessionUri = `${CHAT}session:${session}`;
    const messageUri = `${CHAT}message:${session}`;
    await insert(
      [sessionUri, RDF_TYPE, `${SCHEMA}Conversation`],
      [sessionUri, `${DKG}sessionId`, JSON.stringify(session)],
      [turn, RDF_TYPE, `${DKG}ChatTurn`],
      [turn, `${SCHEMA}isPartOf`, sessionUri],
      [turn, `${DKG}turnId`, '"1"'],
      [turn, `${DKG}persistenceState`, JSON.stringify(state)],
      [turn, `${SCHEMA}dateCreated`, '"2026-10-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'],
      [turn, `${DKG}hasUserMessage`, messageUri],
      [turn, `${DKG}hasAssistantMessage`, messageUri],
      [messageUri, `${SCHEMA}isPartOf`, sessionUri],
      [messageUri, `${SCHEMA}author`, `${CHAT}agent`],
      [messageUri, `${SCHEMA}text`, JSON.stringify(reply)],
      [messageUri, `${DKG}turnId`, '"1"'],
      [messageUri, `${SCHEMA}dateCreated`, '"2026-10-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>'],
    );
  };
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
});
