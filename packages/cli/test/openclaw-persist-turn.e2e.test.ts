/**
 * E2E: the `persist-turn` routes of the local-agent channels over real HTTP, into
 * a real store, and the dashboard's chat-history routes over what they wrote.
 *
 * Nothing under test is mocked. The stack (a real `DKGAgent` with a real Oxigraph
 * store, the daemon's real chat-memory wiring, the real OpenClaw, Hermes and Prime
 * Agent route handlers and the dashboard's chat-history handler behind a real
 * `http.Server`) lives in `_helpers/persist-turn-fixture.ts`. Each test POSTs
 * like the adapters do, then reads the `'chat-turns'` Working Memory assertion
 * back with SPARQL, through the chat memory manager and through the history
 * routes (`GET /api/memory/sessions[/:id[/graph-delta]]`).
 *
 * The OpenClaw tests read a footprint (Message and state counts, not ChatTurn
 * subjects) through the helper this tier shares with the devnet suite; see
 * `_helpers/chat-turn-footprint.ts` for why a resend shows up there.
 *
 * A turn id is only unique inside its session, so the durable state of a turn
 * (its duplicate check, its transitions) is keyed by `(sessionId, turnId)`.
 * `describe.each(CHANNELS)` reuses one turn id in two sessions behind each of the
 * three routes. The legacy-subject `describe` reads turns that were stored under
 * the subject scheme that shared one subject per turn id (written by
 * `_helpers/legacy-chat-turn.ts`). The next `describe` reads the session list, the
 * single-session route and the graph delta over turns that completed by
 * transition, and the last repeats those reads on a working-memory view that
 * spans more than one graph: its `beforeAll` changes the graph layout of the
 * suite's one shared agent, so it stays last. Every other test uses its own
 * random turn id as well as its own session, so a failure in one cannot be
 * caused by another's turns.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { AGENT_CONTEXT_GRAPH, CHAT_TURNS_ASSERTION, type ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import { primeAgentDkgSessionId } from '../src/daemon/prime-agent.js';
import { ONE_STORED_TURN, completedByTransition } from './_helpers/chat-turn-footprint.js';
import {
  CHAT,
  DKG,
  RDF_TYPE_IRI,
  SCHEMA_ORG,
  createLegacyChatTurnWriter,
  legacySubject,
  scopedSubject,
} from './_helpers/legacy-chat-turn.js';
import {
  PERSIST_TURN,
  createPersistTurnFixture,
  type HistoryMessage,
  type PersistResponse,
} from './_helpers/persist-turn-fixture.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fixture = createPersistTurnFixture();
let agent: DKGAgent;
let memoryManager: ChatMemoryManager;
let agentAddress: string;
const { persistTurn, listed, single, select, footprint } = fixture;
const { writeLegacyTurn, writeStoredTransition } = createLegacyChatTurnWriter(() => fixture);

beforeAll(async () => {
  await fixture.start();
  ({ agent, memoryManager, agentAddress } = fixture);
}, 60_000);

afterAll(() => fixture.stop());

const newSessionId = () => `openclaw:e2e:${randomUUID()}`;
const newTurnId = () => `turn-${randomUUID()}`;

const USER_TEXT = 'what is a knowledge asset?';
const ASSISTANT_TEXT = 'A knowledge asset is a verifiable unit of knowledge.';

const turn = (sessionId: string, turnId: string | undefined, overrides: Record<string, unknown> = {}) => ({
  sessionId,
  userMessage: USER_TEXT,
  assistantReply: ASSISTANT_TEXT,
  ...(turnId === undefined ? {} : { turnId }),
  ...overrides,
});

describe('OpenClaw persist-turn over real HTTP into a real store', () => {
  it('writes a new turn once and reads it back through the chat memory manager', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    const first = await persistTurn(turn(sessionId, turnId));

    expect(first).toEqual({ status: 200, body: { ok: true, turnId } });
    expect(await footprint(sessionId, turnId)).toEqual(ONE_STORED_TURN);
    const session = await memoryManager.getSession(sessionId);
    expect(session?.messages.map((message) => [message.author, message.text])).toEqual([
      ['user', USER_TEXT],
      ['agent', ASSISTANT_TEXT],
    ]);
    expect(await memoryManager.getChatTurnPersistenceState(sessionId, turnId)).toBe('stored');
  });

  it('suppresses sequential resends of the same (sessionId, turnId)', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    const responses = [
      await persistTurn(turn(sessionId, turnId)),
      await persistTurn(turn(sessionId, turnId)),
      await persistTurn(turn(sessionId, turnId)),
    ];

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(responses[0].body).toEqual({ ok: true, turnId });
    expect(responses[1].body).toEqual({ ok: true, duplicate: true, turnId });
    expect(responses[2].body).toEqual({ ok: true, duplicate: true, turnId });
    expect(await footprint(sessionId, turnId)).toEqual(ONE_STORED_TURN);
    expect((await memoryManager.getSession(sessionId))?.messages).toHaveLength(2);
  });

  it('suppresses concurrent resends of the same (sessionId, turnId)', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => persistTurn(turn(sessionId, turnId))),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.body.duplicate === true)).toHaveLength(7);
    expect(responses.filter((response) => response.body.duplicate === undefined)).toHaveLength(1);
    expect(await footprint(sessionId, turnId)).toEqual(ONE_STORED_TURN);
    expect((await memoryManager.getSession(sessionId))?.messages).toHaveLength(2);
  });

  it('keeps different turns of one session, and turns of different sessions, apart', async () => {
    const sessionA = newSessionId();
    const sessionB = newSessionId();
    const turnA = newTurnId();
    const turnB = newTurnId();

    await persistTurn(turn(sessionA, turnA));
    const secondTurn = await persistTurn(turn(sessionA, turnB, { userMessage: 'and a context graph?' }));
    const otherSession = await persistTurn(turn(sessionB, newTurnId()));

    expect(secondTurn.body).toEqual({ ok: true, turnId: turnB });
    expect(otherSession.status).toBe(200);
    expect(otherSession.body.duplicate).toBeUndefined();
    expect(await footprint(sessionA, turnB)).toEqual(ONE_STORED_TURN);
    expect((await memoryManager.getSession(sessionA))?.messages).toHaveLength(4);
    expect((await memoryManager.getSession(sessionB))?.messages).toHaveLength(2);
  });

  it('finds a new turn for the graph delta through its session link, under its session-scoped subject', async () => {
    const sessionId = newSessionId();
    const prefix = randomUUID();
    const [first, second] = [`turn-${prefix}-1`, `turn-${prefix}-2`];

    await persistTurn(turn(sessionId, first));
    await persistTurn(turn(sessionId, second, { userMessage: 'and a context graph?' }));
    const delta = await memoryManager.getSessionGraphDelta(sessionId, second, { baseTurnId: first });

    expect(delta).toMatchObject({
      mode: 'delta',
      watermark: { baseTurnId: first, previousTurnId: first, appliedTurnId: second, turnCount: 2 },
    });
    const turnIdTriples = delta.triples.filter((triple) => triple.predicate === 'http://dkg.io/ontology/turnId');
    const turnSubject = turnIdTriples.find((triple) => triple.object === second)?.subject;
    expect(turnSubject).toBe(scopedSubject(sessionId, second));
    // The delta is the second turn's: its turn subject, and not the first turn's.
    expect(delta.triples.some((triple) => triple.subject === turnSubject && triple.predicate === 'http://dkg.io/ontology/hasUserMessage')).toBe(true);
    expect(turnIdTriples.some((triple) => triple.object === first && triple.subject === turnSubject)).toBe(false);
  });

  it('records a pending turn completing as a transition, not a second exchange', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    const pending = await persistTurn(turn(sessionId, turnId, { assistantReply: 'working on it', persistenceState: 'pending' }));
    const stored = await persistTurn(turn(sessionId, turnId, { assistantReply: 'the final answer', persistenceState: 'stored' }));
    const resend = await persistTurn(turn(sessionId, turnId, { assistantReply: 'the final answer', persistenceState: 'stored' }));

    expect(pending.body).toEqual({ ok: true, turnId });
    expect(stored.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(resend.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(await footprint(sessionId, turnId)).toEqual(completedByTransition('pending', 'the final answer'));
    expect(await memoryManager.getChatTurnPersistenceState(sessionId, turnId)).toBe('stored');
    const session = await memoryManager.getSession(sessionId);
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages.find((message) => message.author === 'agent')).toMatchObject({
      text: 'the final answer',
      persistStatus: 'stored',
    });
  });

  it('carries a completing transition in the graph delta of its turn', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    await persistTurn(turn(sessionId, turnId, { assistantReply: 'working on it', persistenceState: 'pending' }));
    const before = await memoryManager.getSessionGraphDelta(sessionId, turnId);
    await persistTurn(turn(sessionId, turnId, { assistantReply: 'the final answer', persistenceState: 'stored' }));
    const delta = await memoryManager.getSessionGraphDelta(sessionId, turnId);

    expect(delta.mode).toBe('delta');
    const turnSubject = delta.triples.find((triple) =>
      triple.predicate === 'http://dkg.io/ontology/hasAssistantMessage')?.subject;
    expect(turnSubject).toBe(scopedSubject(sessionId, turnId));
    const transitions = delta.triples
      .filter((triple) => triple.predicate === 'http://dkg.io/ontology/updatesTurn' && triple.object === turnSubject)
      .map((triple) => triple.subject);
    expect(transitions).toHaveLength(1);
    const ofTransition = (predicate: string) => delta.triples
      .filter((triple) => triple.subject === transitions[0] && triple.predicate === predicate)
      .map((triple) => triple.object);
    expect(ofTransition('http://dkg.io/ontology/persistenceState')).toEqual(['stored']);
    expect(ofTransition('http://dkg.io/ontology/assistantReply')).toEqual(['the final answer']);
    // The completion is the only addition: the turn is still one exchange.
    expect(before.triples.some((triple) => triple.predicate === 'http://dkg.io/ontology/updatesTurn')).toBe(false);
    const withoutTransition = delta.triples.filter((triple) => triple.subject !== transitions[0]);
    expect(withoutTransition).toHaveLength(before.triples.length);
    expect(delta.triples.filter((triple) => triple.predicate === 'http://dkg.io/ontology/hasAssistantMessage')).toHaveLength(1);
  });

  it('records a failed turn recovering as a transition and never downgrades a stored turn', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();
    const failure = { persistenceState: 'failed', failureReason: 'provider timed out' };

    const failed = await persistTurn(turn(sessionId, turnId, { assistantReply: 'the run failed', ...failure }));
    const failedResend = await persistTurn(turn(sessionId, turnId, failure));
    const recovered = await persistTurn(turn(sessionId, turnId, { assistantReply: 'recovered answer', persistenceState: 'stored' }));
    const lateFailure = await persistTurn(turn(sessionId, turnId, { persistenceState: 'failed', failureReason: 'late failure' }));

    expect(failed.body).toEqual({ ok: true, turnId });
    expect(failedResend.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(recovered.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(lateFailure.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(await footprint(sessionId, turnId)).toEqual(completedByTransition('failed', 'recovered answer'));
    expect(await memoryManager.getChatTurnPersistenceState(sessionId, turnId)).toBe('stored');
  });

  it('treats a padded turn id as the trimmed id', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    const first = await persistTurn(turn(sessionId, `  ${turnId} `));
    const resend = await persistTurn(turn(sessionId, turnId));

    expect(first.body).toEqual({ ok: true, turnId });
    expect(resend.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(await footprint(sessionId, turnId)).toEqual(ONE_STORED_TURN);
  });

  it('still writes every POST that carries no turn id, each under a fresh generated one', async () => {
    const sessionId = newSessionId();

    const first = await persistTurn(turn(sessionId, undefined));
    const second = await persistTurn(turn(sessionId, undefined));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();
    expect(second.body.duplicate).toBeUndefined();
    expect(first.body.turnId).toMatch(UUID_RE);
    expect(second.body.turnId).toMatch(UUID_RE);
    expect(second.body.turnId).not.toBe(first.body.turnId);
    expect(await footprint(sessionId, first.body.turnId!)).toEqual(ONE_STORED_TURN);
    expect(await footprint(sessionId, second.body.turnId!)).toEqual(ONE_STORED_TURN);
    expect((await memoryManager.getSession(sessionId))?.messages).toHaveLength(4);

    // The response names the generated id, so a caller can make its retry idempotent.
    const resend = await persistTurn(turn(sessionId, first.body.turnId));
    expect(resend.body).toEqual({ ok: true, duplicate: true, turnId: first.body.turnId });
    expect((await memoryManager.getSession(sessionId))?.messages).toHaveLength(4);
  });

  it('keeps the 400 paths off the chat-turns store', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();
    const querySpy = vi.spyOn(agent, 'query');

    const missingReply = await persistTurn({ sessionId, userMessage: 'hi', turnId });
    const unknownState = await persistTurn(turn(sessionId, turnId, { persistenceState: 'complete' }));
    const unverifiedAttachment = await persistTurn(turn(sessionId, turnId, {
      attachmentRefs: [{
        assertionUri: 'did:dkg:context-graph:cg1/assertion/never-imported',
        fileHash: 'sha256:abc123',
        contextGraphId: 'cg1',
        fileName: 'never-imported.pdf',
      }],
    }));
    const chatTurnReads = querySpy.mock.calls.filter(
      ([, options]) => typeof options === 'object' && options?.assertionName === CHAT_TURNS_ASSERTION,
    );
    querySpy.mockRestore();

    expect(missingReply.status).toBe(400);
    expect(unknownState.status).toBe(400);
    expect(unverifiedAttachment).toEqual({ status: 400, body: { error: 'Invalid "attachmentRefs"' } });
    // Only the attachment provenance lookup may read: no chat-turns query, no write.
    expect(chatTurnReads).toEqual([]);
    expect(await memoryManager.getSession(sessionId)).toBeNull();
  });
});

/**
 * The three local-agent channels persist through one owner, so the same
 * `(sessionId, turnId)` contract has to hold behind each of their routes.
 * `storeSessionId` is the session id the chat store sees for a caller's id, and
 * `echoesSession` says whether the route names it in its response (Prime Agent
 * does, and prefixes it).
 */
const CHANNELS = [
  {
    name: 'OpenClaw',
    path: PERSIST_TURN,
    newSession: () => `openclaw:e2e:${randomUUID()}`,
    storeSessionId: (sessionId: string) => sessionId,
    echoesSession: false,
  },
  {
    name: 'Hermes',
    path: '/api/hermes-channel/persist-turn',
    newSession: () => `hermes:e2e:${randomUUID()}`,
    storeSessionId: (sessionId: string) => sessionId,
    echoesSession: false,
  },
  {
    name: 'Prime Agent',
    path: '/api/prime-agent-channel/persist-turn',
    newSession: () => `e2e-${randomUUID()}`,
    storeSessionId: primeAgentDkgSessionId,
    echoesSession: true,
  },
] as const;

/**
 * One turn id reused by two sessions. A turn id is only meaningful inside its
 * session (an adapter numbers its turns per conversation, Prime Agent uses the
 * request's correlation id), so the durable state, the duplicate check and a
 * completion must all be scoped by `(sessionId, turnId)`. The fake store the
 * unit tests use keys its state that way by construction; here the real
 * ChatMemoryManager and its RDF store have to.
 */
describe.each(CHANNELS)('$name: one turn id reused by two sessions, against the real store', (channel) => {
  const post = (sessionId: string, turnId: string, overrides: Record<string, unknown> = {}) =>
    persistTurn(turn(sessionId, turnId, overrides), channel.path);

  /** The response a POST is expected to get for one outcome. */
  const respondsWith = (sessionId: string, turnId: string, kind: 'created' | 'duplicate' | 'transitioned'): PersistResponse => ({
    status: 200,
    body: {
      ok: true,
      ...(kind === 'duplicate' ? { duplicate: true } : {}),
      ...(kind === 'transitioned' ? { transitioned: true } : {}),
      turnId,
      ...(channel.echoesSession ? { sessionId: channel.storeSessionId(sessionId) } : {}),
    },
  });

  /** Author, text and state of every message the store returns for a session. */
  const conversation = async (sessionId: string) =>
    (await memoryManager.getSession(channel.storeSessionId(sessionId)))?.messages
      .map((message) => [message.author, message.text, message.persistStatus]);

  const stateOf = (sessionId: string, turnId: string) =>
    memoryManager.getChatTurnPersistenceState(channel.storeSessionId(sessionId), turnId);

  it('stored in session-a, then pending in session-b: b is created, its completion transitions, a is untouched', async () => {
    const [sessionA, sessionB] = [channel.newSession(), channel.newSession()];
    const turnId = newTurnId();
    const a = { userMessage: 'question of a', assistantReply: 'answer of a' };
    const b = { userMessage: 'question of b' };
    const bFinal = { ...b, assistantReply: 'final answer of b', persistenceState: 'stored' };

    const aStored = await post(sessionA, turnId, a);
    const bPending = await post(sessionB, turnId, { ...b, assistantReply: 'b is working on it', persistenceState: 'pending' });
    const bStateWhilePending = await stateOf(sessionB, turnId);
    const bStored = await post(sessionB, turnId, bFinal);
    const aResend = await post(sessionA, turnId, a);
    const bResend = await post(sessionB, turnId, bFinal);

    expect(aStored).toEqual(respondsWith(sessionA, turnId, 'created'));
    expect(bPending).toEqual(respondsWith(sessionB, turnId, 'created'));
    expect(bStored).toEqual(respondsWith(sessionB, turnId, 'transitioned'));
    expect(aResend).toEqual(respondsWith(sessionA, turnId, 'duplicate'));
    expect(bResend).toEqual(respondsWith(sessionB, turnId, 'duplicate'));
    expect(bStateWhilePending).toBe('pending');
    expect(await stateOf(sessionA, turnId)).toBe('stored');
    expect(await stateOf(sessionB, turnId)).toBe('stored');
    expect(await conversation(sessionA)).toEqual([
      ['user', 'question of a', 'stored'],
      ['agent', 'answer of a', 'stored'],
    ]);
    expect(await conversation(sessionB)).toEqual([
      ['user', 'question of b', 'stored'],
      ['agent', 'final answer of b', 'stored'],
    ]);
    expect(await footprint(channel.storeSessionId(sessionA), turnId)).toEqual(ONE_STORED_TURN);
    expect(await footprint(channel.storeSessionId(sessionB), turnId)).toEqual(completedByTransition('pending', 'final answer of b'));
  });

  it('pending in session-a, then stored in session-b: a can still complete afterwards', async () => {
    const [sessionA, sessionB] = [channel.newSession(), channel.newSession()];
    const turnId = newTurnId();
    const a = { userMessage: 'question of a' };
    const aFinal = { ...a, assistantReply: 'final answer of a', persistenceState: 'stored' };
    const b = { userMessage: 'question of b', assistantReply: 'answer of b' };

    const aPending = await post(sessionA, turnId, { ...a, assistantReply: 'a is working on it', persistenceState: 'pending' });
    const bStored = await post(sessionB, turnId, b);
    const aStateWhilePending = await stateOf(sessionA, turnId);
    const aStored = await post(sessionA, turnId, aFinal);
    const bResend = await post(sessionB, turnId, b);
    const aResend = await post(sessionA, turnId, aFinal);

    expect(aPending).toEqual(respondsWith(sessionA, turnId, 'created'));
    expect(bStored).toEqual(respondsWith(sessionB, turnId, 'created'));
    expect(aStored).toEqual(respondsWith(sessionA, turnId, 'transitioned'));
    expect(bResend).toEqual(respondsWith(sessionB, turnId, 'duplicate'));
    expect(aResend).toEqual(respondsWith(sessionA, turnId, 'duplicate'));
    expect(aStateWhilePending).toBe('pending');
    expect(await stateOf(sessionB, turnId)).toBe('stored');
    expect(await conversation(sessionA)).toEqual([
      ['user', 'question of a', 'stored'],
      ['agent', 'final answer of a', 'stored'],
    ]);
    expect(await conversation(sessionB)).toEqual([
      ['user', 'question of b', 'stored'],
      ['agent', 'answer of b', 'stored'],
    ]);
    expect(await footprint(channel.storeSessionId(sessionB), turnId)).toEqual(ONE_STORED_TURN);
    expect(await footprint(channel.storeSessionId(sessionA), turnId)).toEqual(completedByTransition('pending', 'final answer of a'));
  });

  it('stored in session-a, then failed in session-b: b recovers on its own and a late failure of b stays a duplicate', async () => {
    const [sessionA, sessionB] = [channel.newSession(), channel.newSession()];
    const turnId = newTurnId();
    const failure = { userMessage: 'question of b', persistenceState: 'failed', failureReason: 'provider timed out' };

    const aStored = await post(sessionA, turnId, { userMessage: 'question of a', assistantReply: 'answer of a' });
    const bFailed = await post(sessionB, turnId, { ...failure, assistantReply: 'the run failed' });
    const bStateWhileFailed = await stateOf(sessionB, turnId);
    const bFailedResend = await post(sessionB, turnId, { ...failure, assistantReply: 'the run failed' });
    const bRecovered = await post(sessionB, turnId, { userMessage: 'question of b', assistantReply: 'recovered answer of b', persistenceState: 'stored' });
    const bLateFailure = await post(sessionB, turnId, { ...failure, assistantReply: 'the run failed again' });

    expect(aStored).toEqual(respondsWith(sessionA, turnId, 'created'));
    expect(bFailed).toEqual(respondsWith(sessionB, turnId, 'created'));
    expect(bFailedResend).toEqual(respondsWith(sessionB, turnId, 'duplicate'));
    expect(bRecovered).toEqual(respondsWith(sessionB, turnId, 'transitioned'));
    expect(bLateFailure).toEqual(respondsWith(sessionB, turnId, 'duplicate'));
    expect(bStateWhileFailed).toBe('failed');
    expect(await conversation(sessionA)).toEqual([
      ['user', 'question of a', 'stored'],
      ['agent', 'answer of a', 'stored'],
    ]);
    expect(await conversation(sessionB)).toEqual([
      ['user', 'question of b', 'stored'],
      ['agent', 'recovered answer of b', 'stored'],
    ]);
    expect(await footprint(channel.storeSessionId(sessionA), turnId)).toEqual(ONE_STORED_TURN);
    expect(await footprint(channel.storeSessionId(sessionB), turnId)).toEqual(completedByTransition('failed', 'recovered answer of b'));
  });

  it('pending in both sessions: each completes with its own reply, and a completed session never masks or rewrites the other', async () => {
    const [sessionA, sessionB] = [channel.newSession(), channel.newSession()];
    const turnId = newTurnId();
    const pending = (sessionId: string, who: string) =>
      post(sessionId, turnId, { userMessage: `question of ${who}`, assistantReply: `${who} is working on it`, persistenceState: 'pending' });
    const complete = (sessionId: string, who: string) =>
      post(sessionId, turnId, { userMessage: `question of ${who}`, assistantReply: `final answer of ${who}`, persistenceState: 'stored' });

    const created = [await pending(sessionA, 'a'), await pending(sessionB, 'b')];
    const aCompleted = await complete(sessionA, 'a');
    const bStateAfterACompleted = await stateOf(sessionB, turnId);
    const bConversationAfterACompleted = await conversation(sessionB);
    const bPendingResend = await pending(sessionB, 'b');
    const bCompleted = await complete(sessionB, 'b');

    expect(created).toEqual([respondsWith(sessionA, turnId, 'created'), respondsWith(sessionB, turnId, 'created')]);
    expect(aCompleted).toEqual(respondsWith(sessionA, turnId, 'transitioned'));
    expect(bPendingResend).toEqual(respondsWith(sessionB, turnId, 'duplicate'));
    expect(bCompleted).toEqual(respondsWith(sessionB, turnId, 'transitioned'));
    // While a is complete, b is still the pending turn it was: its state, and
    // the reply it shows, are its own.
    expect(bStateAfterACompleted).toBe('pending');
    expect(bConversationAfterACompleted).toEqual([
      ['user', 'question of b', 'pending'],
      ['agent', 'b is working on it', 'pending'],
    ]);
    expect(await conversation(sessionA)).toEqual([
      ['user', 'question of a', 'stored'],
      ['agent', 'final answer of a', 'stored'],
    ]);
    expect(await conversation(sessionB)).toEqual([
      ['user', 'question of b', 'stored'],
      ['agent', 'final answer of b', 'stored'],
    ]);
  });
});

/**
 * Turns stored before session-scoped turn subjects sit under
 * `urn:dkg:chat:turn:<turnId>` (the subject the previous code wrote). Nothing
 * rewrites them, so they have to keep working under the current code: found by
 * the duplicate check, completed by a transition on the subject they already
 * have, and unaffected by a new session that reuses their turn id.
 *
 * The turns are written straight to the assertion in exactly the shape the
 * previous `storeChatExchange` produced, not through the current manager.
 */
describe('turns stored under the legacy turn subject, against the real store', () => {
  /** Every ChatTurn subject of the session that carries the turn id. */
  const turnSubjects = async (sessionId: string, turnId: string): Promise<string[]> =>
    (await select(`SELECT ?t WHERE { ?t <${RDF_TYPE_IRI}> <${DKG}ChatTurn> . ?t <${SCHEMA_ORG}isPartOf> <${CHAT}session:${sessionId}> . ?t <${DKG}turnId> ${JSON.stringify(turnId)} }`))
      .map((row) => row.t.replace(/[<>]/g, ''))
      .sort();

  /** What the transitions of `(sessionId, turnId)` point at. */
  const transitionTargets = async (turnId: string): Promise<string[]> =>
    (await select(`SELECT ?target WHERE { ?x <${RDF_TYPE_IRI}> <${DKG}ChatTurnPersistenceTransition> . ?x <${DKG}turnId> ${JSON.stringify(turnId)} . ?x <${DKG}updatesTurn> ?target }`))
      .map((row) => row.target.replace(/[<>]/g, ''))
      .sort();

  const conversation = async (sessionId: string) =>
    (await memoryManager.getSession(sessionId))?.messages.map((message) => [message.author, message.text, message.persistStatus]);

  const done = { userMessage: 'legacy question', assistantReply: 'legacy final answer', persistenceState: 'stored' };

  it('a legacy stored turn is found and its resend is a duplicate that writes nothing', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();
    await writeLegacyTurn(sessionId, turnId, { persistenceState: 'stored', userText: 'legacy question', assistantText: 'legacy answer' });
    const before = await select(`SELECT ?p ?o WHERE { <${legacySubject(turnId)}> ?p ?o }`);

    const resend = await persistTurn(turn(sessionId, turnId, { userMessage: 'legacy question', assistantReply: 'a different answer' }));

    expect(resend).toEqual({ status: 200, body: { ok: true, duplicate: true, turnId } });
    expect(await select(`SELECT ?p ?o WHERE { <${legacySubject(turnId)}> ?p ?o }`)).toHaveLength(before.length);
    expect(await turnSubjects(sessionId, turnId)).toEqual([legacySubject(turnId)]);
    expect(await footprint(sessionId, turnId)).toEqual(ONE_STORED_TURN);
    expect(await conversation(sessionId)).toEqual([
      ['user', 'legacy question', 'stored'],
      ['agent', 'legacy answer', 'stored'],
    ]);
    expect(await memoryManager.hasChatTurn(sessionId, turnId)).toBe(true);
    expect(await memoryManager.getChatTurnPersistenceState(sessionId, turnId)).toBe('stored');
    expect(await listed(sessionId)).toEqual(await single(sessionId));
    expect(await single(sessionId)).toEqual([
      { author: 'user', text: 'legacy question' },
      { author: 'agent', text: 'legacy answer' },
    ]);
  });

  it.each([
    ['pending', { persistenceState: 'pending', assistantText: 'legacy working on it' }],
    ['failed', { persistenceState: 'failed', assistantText: 'legacy run failed', failureReason: 'provider timed out' }],
  ] as const)('a legacy %s turn completes with a transition on the subject it already has', async (_label, legacy) => {
    const sessionId = newSessionId();
    const turnId = newTurnId();
    await writeLegacyTurn(sessionId, turnId, { userText: 'legacy question', ...legacy });

    const sameState = await persistTurn(turn(sessionId, turnId, {
      userMessage: 'legacy question',
      assistantReply: legacy.assistantText,
      persistenceState: legacy.persistenceState,
      ...('failureReason' in legacy ? { failureReason: legacy.failureReason } : {}),
    }));
    const completed = await persistTurn(turn(sessionId, turnId, done));
    const resend = await persistTurn(turn(sessionId, turnId, done));

    expect(sameState.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(completed.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(resend.body).toEqual({ ok: true, duplicate: true, turnId });
    // The turn keeps its one legacy subject and the transition points at it.
    expect(await turnSubjects(sessionId, turnId)).toEqual([legacySubject(turnId)]);
    expect(await transitionTargets(turnId)).toEqual([legacySubject(turnId)]);
    expect(await footprint(sessionId, turnId)).toEqual(completedByTransition(legacy.persistenceState, 'legacy final answer'));
    expect(await conversation(sessionId)).toEqual([
      ['user', 'legacy question', 'stored'],
      ['agent', 'legacy final answer', 'stored'],
    ]);
    expect(await memoryManager.getChatTurnPersistenceState(sessionId, turnId)).toBe('stored');
    // Both history routes resolve the reply from the transition on the legacy subject.
    expect(await single(sessionId)).toEqual([
      { author: 'user', text: 'legacy question' },
      { author: 'agent', text: 'legacy final answer' },
    ]);
    expect(await listed(sessionId)).toEqual(await single(sessionId));
    // graph-delta finds the legacy subject through the session link.
    expect(await memoryManager.getSessionGraphDelta(sessionId, turnId)).toMatchObject({
      mode: 'delta',
      watermark: { appliedTurnId: turnId, turnCount: 1 },
    });
  });

  it('a new session that reuses the id of a legacy pending turn is isolated from it, in both directions', async () => {
    const [legacySession, newSession] = [newSessionId(), newSessionId()];
    const turnId = newTurnId();
    await writeLegacyTurn(legacySession, turnId, { persistenceState: 'pending', userText: 'legacy question', assistantText: 'legacy working on it' });

    const created = await persistTurn(turn(newSession, turnId, { userMessage: 'new question', assistantReply: 'new answer' }));
    const legacyStateAfterNew = await memoryManager.getChatTurnPersistenceState(legacySession, turnId);
    const legacyCompleted = await persistTurn(turn(legacySession, turnId, done));
    const newResend = await persistTurn(turn(newSession, turnId, { userMessage: 'new question', assistantReply: 'new answer' }));

    expect(created.body).toEqual({ ok: true, turnId });
    expect(legacyStateAfterNew).toBe('pending');
    expect(legacyCompleted.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(newResend.body).toEqual({ ok: true, duplicate: true, turnId });
    // Each session has its own subject: the legacy one and a session-scoped one.
    expect(await turnSubjects(legacySession, turnId)).toEqual([legacySubject(turnId)]);
    const [newSubject] = await turnSubjects(newSession, turnId);
    expect(newSubject).toBe(scopedSubject(newSession, turnId));
    expect(await transitionTargets(turnId)).toEqual([legacySubject(turnId)]);
    expect(await conversation(legacySession)).toEqual([
      ['user', 'legacy question', 'stored'],
      ['agent', 'legacy final answer', 'stored'],
    ]);
    expect(await conversation(newSession)).toEqual([
      ['user', 'new question', 'stored'],
      ['agent', 'new answer', 'stored'],
    ]);
    expect(await footprint(newSession, turnId)).toEqual(ONE_STORED_TURN);
  });

  it('a legacy subject that two sessions share is not trusted for the duplicate check: a completion is written, not dropped', async () => {
    const [sessionA, sessionB] = [newSessionId(), newSessionId()];
    const turnId = newTurnId();
    // The previous code wrote both sessions' turn under the one subject named
    // after the id, so that subject carries A's stored state and B's pending one.
    await writeLegacyTurn(sessionA, turnId, { persistenceState: 'stored', userText: 'question a', assistantText: 'answer a' });
    await writeLegacyTurn(sessionB, turnId, { persistenceState: 'pending', userText: 'question b', assistantText: 'working on b' });
    expect(await turnSubjects(sessionA, turnId)).toEqual([legacySubject(turnId)]);
    expect(await turnSubjects(sessionB, turnId)).toEqual([legacySubject(turnId)]);
    const sharedBefore = await select(`SELECT ?p ?o WHERE { <${legacySubject(turnId)}> ?p ?o }`);

    const finalB = { userMessage: 'question b', assistantReply: 'final answer b', persistenceState: 'stored' };
    const completedB = await persistTurn(turn(sessionB, turnId, finalB));
    const resendB = await persistTurn(turn(sessionB, turnId, finalB));

    // A's stored state did not make B's completion a duplicate: it was written, once.
    expect(completedB.body).toEqual({ ok: true, turnId });
    expect(resendB.body).toEqual({ ok: true, duplicate: true, turnId });
    // A still has only the shared subject, and its state cannot be read off it.
    expect(await memoryManager.getChatTurnPersistenceState(sessionA, turnId)).toBeNull();
    // B now has a subject of its own next to the shared one, which nothing touched.
    const subjectsB = await turnSubjects(sessionB, turnId);
    expect(subjectsB).toHaveLength(2);
    expect(subjectsB).toContain(legacySubject(turnId));
    expect(subjectsB.find((subject) => subject !== legacySubject(turnId))).toBe(scopedSubject(sessionB, turnId));
    expect(await select(`SELECT ?p ?o WHERE { <${legacySubject(turnId)}> ?p ?o }`)).toHaveLength(sharedBefore.length);
    expect(await transitionTargets(turnId)).toEqual([]);
    expect(await turnSubjects(sessionA, turnId)).toEqual([legacySubject(turnId)]);
    // From here on B's state is read from its own subject, and its history has the final reply.
    expect(await memoryManager.getChatTurnPersistenceState(sessionB, turnId)).toBe('stored');
    expect((await single(sessionB)).map((message) => message.text)).toContain('final answer b');
    expect((await single(sessionA)).map((message) => message.text)).not.toContain('final answer b');
  });

  it('a completion on a legacy subject that two sessions share is not listed as either session\'s reply', async () => {
    const [sessionA, sessionB] = [newSessionId(), newSessionId()];
    const turnId = newTurnId();
    await writeLegacyTurn(sessionA, turnId, { persistenceState: 'pending', userText: 'question a', assistantText: 'working on a' });
    await writeLegacyTurn(sessionB, turnId, { persistenceState: 'pending', userText: 'question b', assistantText: 'working on b' });
    // Session A completed, and the transition went onto the subject both sessions share.
    await writeStoredTransition(legacySubject(turnId), turnId, 'final answer a');

    // The shared subject links both assistant messages, and nothing on the
    // transition says whose completion it is: the list shows neither session
    // the other's answer and keeps each reply as it was written.
    expect(await listed(sessionB)).toEqual([
      { author: 'user', text: 'question b' },
      { author: 'agent', text: 'working on b' },
    ]);
    expect(await listed(sessionA)).toEqual([
      { author: 'user', text: 'question a' },
      { author: 'agent', text: 'working on a' },
    ]);
  });
});

/**
 * The dashboard reads chat history through two routes: `GET /api/memory/sessions`
 * (the session list, `getRecentChats`) and `GET /api/memory/sessions/:id` (one
 * session, `getSession`). A turn that completes after it was first reported
 * (`pending` or `failed`, then `stored`) is recorded as a transition that carries
 * the final reply and does not rewrite the assistant Message, so both routes have
 * to resolve the reply from the transition, and to agree.
 */
describe('chat history routes over a turn that completes by transition, against the real store', () => {
  /**
   * A message is stamped with the millisecond it was written, and the agent
   * message one millisecond after the user's. Turns written within a millisecond
   * of each other would tie on that stamp and come back in either order, so the
   * tests that compare the order of several turns leave a few milliseconds
   * between their POSTs.
   */
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 4));

  const exchange = (userText: string, agentText: string): HistoryMessage[] => [
    { author: 'user', text: userText },
    { author: 'agent', text: agentText },
  ];

  it('lists and returns the final reply after pending -> stored, one exchange for the turn', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    await persistTurn(turn(sessionId, turnId, { assistantReply: 'working on it', persistenceState: 'pending' }));
    const beforeCompletion = { listed: await listed(sessionId), single: await single(sessionId) };
    const completed = await persistTurn(turn(sessionId, turnId, { assistantReply: 'the final answer', persistenceState: 'stored' }));

    expect(completed.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(beforeCompletion.listed).toEqual(exchange(USER_TEXT, 'working on it'));
    expect(beforeCompletion.single).toEqual(exchange(USER_TEXT, 'working on it'));
    expect(await single(sessionId)).toEqual(exchange(USER_TEXT, 'the final answer'));
    expect(await listed(sessionId)).toEqual(exchange(USER_TEXT, 'the final answer'));
  });

  it('lists and returns the recovered reply after failed -> stored', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    await persistTurn(turn(sessionId, turnId, { assistantReply: 'the run failed', persistenceState: 'failed', failureReason: 'provider timed out' }));
    await persistTurn(turn(sessionId, turnId, { assistantReply: 'recovered answer', persistenceState: 'stored' }));

    expect(await single(sessionId)).toEqual(exchange(USER_TEXT, 'recovered answer'));
    expect(await listed(sessionId)).toEqual(exchange(USER_TEXT, 'recovered answer'));
  });

  it('lists one exchange with the final reply for a turn that went pending -> failed -> stored', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    const pending = await persistTurn(turn(sessionId, turnId, { assistantReply: 'working on it', persistenceState: 'pending' }));
    const failed = await persistTurn(turn(sessionId, turnId, { assistantReply: 'the run failed', persistenceState: 'failed', failureReason: 'provider timed out' }));
    const stored = await persistTurn(turn(sessionId, turnId, { assistantReply: 'the final answer', persistenceState: 'stored' }));

    expect(pending.body).toEqual({ ok: true, turnId });
    expect(failed.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(stored.body).toEqual({ ok: true, transitioned: true, turnId });
    // Two transitions point at the turn, and neither makes a second exchange.
    expect(await footprint(sessionId, turnId)).toMatchObject({ messages: 2, states: ['pending'] });
    expect(await footprint(sessionId, turnId)).toMatchObject({
      transitions: [{ state: 'failed', assistantReply: 'the run failed' }, { state: 'stored', assistantReply: 'the final answer' }],
    });
    expect(await single(sessionId)).toEqual(exchange(USER_TEXT, 'the final answer'));
    expect(await listed(sessionId)).toEqual(exchange(USER_TEXT, 'the final answer'));
  });

  it('keeps a reply that is only reported as failed or pending, and a turn with no transition, as first written', async () => {
    const sessionId = newSessionId();
    const failedTurn = newTurnId();
    const pendingTurn = newTurnId();
    const storedTurn = newTurnId();

    await persistTurn(turn(sessionId, failedTurn, { userMessage: 'q1', assistantReply: 'failed reply', persistenceState: 'failed', failureReason: 'boom' }));
    await tick();
    await persistTurn(turn(sessionId, pendingTurn, { userMessage: 'q2', assistantReply: 'pending reply', persistenceState: 'pending' }));
    await tick();
    await persistTurn(turn(sessionId, storedTurn, { userMessage: 'q3', assistantReply: 'stored reply' }));
    await tick();
    // A pending report after a failed one is a downgrade, so it is a duplicate and adds no reply anywhere.
    await persistTurn(turn(sessionId, failedTurn, { userMessage: 'q1', assistantReply: 'pending again', persistenceState: 'pending' }));
    // A pending turn that then fails is a transition too, but only a stored one completes a turn.
    const failedAfterPending = newTurnId();
    await tick();
    await persistTurn(turn(sessionId, failedAfterPending, { userMessage: 'q4', assistantReply: 'first report', persistenceState: 'pending' }));
    const failure = await persistTurn(turn(sessionId, failedAfterPending, { userMessage: 'q4', assistantReply: 'the failure text', persistenceState: 'failed', failureReason: 'boom' }));

    expect(failure.body).toEqual({ ok: true, transitioned: true, turnId: failedAfterPending });
    const expected = [
      ...exchange('q1', 'failed reply'),
      ...exchange('q2', 'pending reply'),
      ...exchange('q3', 'stored reply'),
      ...exchange('q4', 'first report'),
    ];
    expect(await single(sessionId)).toEqual(expected);
    expect(await listed(sessionId)).toEqual(expected);
  });

  it('resolves each turn of a session from its own transition, in order, and leaves other sessions alone', async () => {
    const sessionId = newSessionId();
    const otherSession = newSessionId();
    const [first, second, third] = [newTurnId(), newTurnId(), newTurnId()];

    await persistTurn(turn(sessionId, first, { userMessage: 'q1', assistantReply: 'first working', persistenceState: 'pending' }));
    await tick();
    await persistTurn(turn(sessionId, second, { userMessage: 'q2', assistantReply: 'second, stored at once' }));
    await tick();
    await persistTurn(turn(sessionId, third, { userMessage: 'q3', assistantReply: 'third working', persistenceState: 'pending' }));
    await persistTurn(turn(otherSession, first, { userMessage: 'other q', assistantReply: 'other working', persistenceState: 'pending' }));
    await persistTurn(turn(sessionId, first, { userMessage: 'q1', assistantReply: 'first, final', persistenceState: 'stored' }));

    expect(await single(sessionId)).toEqual([
      ...exchange('q1', 'first, final'),
      ...exchange('q2', 'second, stored at once'),
      ...exchange('q3', 'third working'),
    ]);
    expect(await listed(sessionId)).toEqual(await single(sessionId));
    // The other session reuses `first` as its turn id and has not completed.
    expect(await listed(otherSession)).toEqual(exchange('other q', 'other working'));
    expect(await single(otherSession)).toEqual(exchange('other q', 'other working'));
  });

  it('decodes a multi-line final reply the way the single-session route does', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();
    const finalReply = '# Answer\n\n- one\n- two "quoted"\n\n```ts\nconst a = 1;\n```';

    await persistTurn(turn(sessionId, turnId, { assistantReply: 'working', persistenceState: 'pending' }));
    await persistTurn(turn(sessionId, turnId, { assistantReply: finalReply, persistenceState: 'stored' }));

    expect(await single(sessionId)).toEqual(exchange(USER_TEXT, finalReply));
    expect(await listed(sessionId)).toEqual(exchange(USER_TEXT, finalReply));
  });

  it.each(CHANNELS)('$name: the list and the session route agree once a turn completed by transition', async (channel) => {
    const sessionId = channel.newSession();
    const storeSessionId = channel.storeSessionId(sessionId);
    const turnId = newTurnId();
    const post = (overrides: Record<string, unknown>) => persistTurn(turn(sessionId, turnId, overrides), channel.path);

    await post({ assistantReply: 'working on it', persistenceState: 'pending' });
    await post({ assistantReply: 'the final answer', persistenceState: 'stored' });

    expect(await single(storeSessionId)).toEqual(exchange(USER_TEXT, 'the final answer'));
    expect(await listed(storeSessionId)).toEqual(exchange(USER_TEXT, 'the final answer'));
  });

  it('lists the reply of the latest stored transition, whatever order the transitions were written in', async () => {
    // The durable-turn owner never writes a second `stored` transition, so
    // the two per turn are written directly: one stamped a minute after the
    // other. Half the turns get the newer one written first, half the older.
    const sessionId = newSessionId();
    const base = Date.now();
    const turns = [0, 1, 2, 3].map((index) => ({ index, turnId: newTurnId() }));
    for (const { index, turnId } of turns) {
      const pending = await persistTurn(turn(sessionId, turnId, {
        userMessage: `question ${index}`,
        assistantReply: `working on ${index}`,
        persistenceState: 'pending',
      }));
      expect(pending.body).toEqual({ ok: true, turnId });
      await tick();
      const [subject] = (await select(
        `SELECT ?t WHERE { ?t <${RDF_TYPE_IRI}> <${DKG}ChatTurn> . ?t <${SCHEMA_ORG}isPartOf> <${CHAT}session:${sessionId}> . ?t <${DKG}turnId> ${JSON.stringify(turnId)} }`,
      )).map((row) => row.t.replace(/[<>]/g, ''));
      const older = () => writeStoredTransition(subject, turnId, `older completion ${index}`, new Date(base + 60_000));
      const newer = () => writeStoredTransition(subject, turnId, `newer completion ${index}`, new Date(base + 120_000));
      for (const write of index % 2 === 0 ? [newer, older] : [older, newer]) await write();
    }

    // The list query orders a message's transitions by their own timestamp,
    // so the newer completion wins for every turn.
    expect(await listed(sessionId)).toEqual(
      turns.flatMap(({ index }) => exchange(`question ${index}`, `newer completion ${index}`)),
    );
  });
});

/**
 * A by-name read of the working-memory view also spans the assertion's scoped
 * child graphs (`<assertion>/_named_graph/...`), and a node whose agent address
 * has more than one candidate layer graph reads several graphs as well. The
 * query engine cannot evaluate a query that combines a UNION with a solution-set
 * modifier (ORDER BY, LIMIT, ...) across graphs and refuses it, so the session
 * list, whose query was such a UNION, failed on a real node and came back empty
 * (the failure was caught), while a single graph, which every test above runs
 * on, reads fine. This describe gives the chat-turns assertion a scoped child
 * graph, so every by-name read spans two, and repeats the history reads there.
 */
describe('the chat-history reads when the working-memory view spans more than one graph, against the real store', () => {
  beforeAll(async () => {
    // The assertion has to exist before a child graph can hang off it.
    await persistTurn(turn(newSessionId(), newTurnId()));
    const graphs = await agent.store.query(`SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s <http://dkg.io/ontology/turnId> ?o } }`);
    const root = graphs.type === 'bindings' ? String(graphs.bindings[0]?.g ?? '').replace(/[<>]/g, '') : '';
    expect(root).toContain('/assertion/');
    await agent.store.insert([{
      subject: 'urn:e2e:scoped-child',
      predicate: 'urn:e2e:note',
      object: '"a draft of a named graph"',
      graph: `${root}/_named_graph/e2e-child`,
    }]);
  });

  it('reads more than one graph now: a UNION with a modifier is refused', async () => {
    await expect(agent.query('SELECT ?s WHERE { { ?s ?p ?o } UNION { ?o ?p ?s } } LIMIT 1', {
      contextGraphId: AGENT_CONTEXT_GRAPH,
      view: 'working-memory',
      agentAddress,
      assertionName: CHAT_TURNS_ASSERTION,
    })).rejects.toThrow(/Multi-graph query combines an inner UNION/);
  });

  it('lists and returns the final reply after pending -> stored, and reads the turn state', async () => {
    const sessionId = newSessionId();
    const turnId = newTurnId();

    await persistTurn(turn(sessionId, turnId, { assistantReply: 'working on it', persistenceState: 'pending' }));
    const completed = await persistTurn(turn(sessionId, turnId, { assistantReply: 'the final answer', persistenceState: 'stored' }));
    const resend = await persistTurn(turn(sessionId, turnId, { assistantReply: 'the final answer', persistenceState: 'stored' }));

    expect(completed.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(resend.body).toEqual({ ok: true, duplicate: true, turnId });
    const expected = [
      { author: 'user', text: USER_TEXT },
      { author: 'agent', text: 'the final answer' },
    ];
    expect(await single(sessionId)).toEqual(expected);
    expect(await listed(sessionId)).toEqual(expected);
    expect(await memoryManager.getChatTurnPersistenceState(sessionId, turnId)).toBe('stored');
  });
});
