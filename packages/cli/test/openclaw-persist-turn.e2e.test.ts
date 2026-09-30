/**
 * E2E: `POST /api/openclaw-channel/persist-turn` over real HTTP, into a real
 * store.
 *
 * Nothing under test is mocked. A real `DKGAgent` (real libp2p, real Oxigraph
 * store, `MockChainAdapter` for the chain) backs the daemon's real chat-memory
 * stack (`buildChatMemoryStack`, the same wiring `runDaemonInner` uses), and
 * the real `handleOpenclawRoutes` sits behind a real `http.Server`. Each test
 * POSTs like the OpenClaw adapter does, then reads the `'chat-turns'` Working
 * Memory assertion back with SPARQL.
 *
 * The assertions read a footprint (Message and state counts, not ChatTurn
 * subjects) through the helper this tier shares with the devnet suite; see
 * `_helpers/chat-turn-footprint.ts` for why a resend shows up there.
 *
 * A turn id is only unique inside its session, so the durable state of a turn
 * (its duplicate check, its transitions) is keyed by `(sessionId, turnId)`:
 * `describe.each(CHANNELS)` below reuses one turn id in two sessions behind each
 * of the three local-agent routes, and the last `describe` reads turns that were
 * stored under the subject scheme that shared one subject per turn id. Every
 * other test uses its own random turn id as well as its own session, so a
 * failure in one cannot be caused by another's turns.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { AGENT_CONTEXT_GRAPH, CHAT_TURNS_ASSERTION, type ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import { buildChatMemoryStack, resolveMemoryAgentAddress } from '../src/daemon.js';
import { handleHermesRoutes } from '../src/daemon/routes/hermes.js';
import { handleOpenclawRoutes } from '../src/daemon/routes/openclaw.js';
import { primeAgentDkgSessionId } from '../src/daemon/prime-agent.js';
import { handlePrimeAgentRoutes } from '../src/daemon/routes/prime-agent.js';
import { ONE_STORED_TURN, lexicalTerm, readChatTurnFootprint } from './_helpers/chat-turn-footprint.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const PERSIST_TURN = '/api/openclaw-channel/persist-turn';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let agent: DKGAgent;
let memoryManager: ChatMemoryManager;
let agentAddress: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  agent = await DKGAgent.create({
    name: 'OpenClawPersistTurnE2E',
    listenHost: '127.0.0.1',
    nodeRole: 'edge',
    chainAdapter: new MockChainAdapter(),
    rfc64CatalogActivation: { enabled: false },
  });
  await agent.start();

  agentAddress = resolveMemoryAgentAddress(agent);
  ({ manager: memoryManager } = buildChatMemoryStack({
    agent,
    emitMemoryGraphChanged: () => {},
    llmConfig: { apiKey: '' },
    agentAddress,
  }));

  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ctx = {
      req,
      res,
      agent,
      config: { name: 'openclaw-persist-turn-e2e', apiPort: 0, listenPort: 0, nodeRole: 'edge' },
      memoryManager,
      bridgeAuthToken: 'bridge-token',
      extractionStatus: new Map(),
      url,
      path: url.pathname,
      requestAgentAddress: agentAddress,
      authentication: requestAuthentication({ kind: 'nodeOperator' }),
    } as any;
    // The three local-agent channels, each with its own persist-turn route, all
    // in front of the one real chat-memory stack.
    for (const handle of [handleOpenclawRoutes, handleHermesRoutes, handlePrimeAgentRoutes]) {
      await handle(ctx);
      if (res.writableEnded) break;
    }
    if (!res.writableEnded) {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('route server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await agent?.stop().catch(() => {});
});

interface PersistResponse {
  status: number;
  body: { ok?: boolean; duplicate?: boolean; transitioned?: boolean; turnId?: string; sessionId?: string; error?: string };
}

/** POST one turn the way the OpenClaw adapter's `DkgClient.storeChatTurn` does. */
async function persistTurn(payload: Record<string, unknown>, path = PERSIST_TURN): Promise<PersistResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as PersistResponse['body'] };
}

const newSessionId = () => `openclaw:e2e:${randomUUID()}`;
const newTurnId = () => `turn-${randomUUID()}`;

async function select(sparql: string): Promise<Array<Record<string, string>>> {
  const result = await agent.query(sparql, {
    contextGraphId: AGENT_CONTEXT_GRAPH,
    view: 'working-memory',
    agentAddress,
    assertionName: CHAT_TURNS_ASSERTION,
  });
  return (result.bindings ?? []) as Array<Record<string, string>>;
}

/** Everything one `(sessionId, turnId)` left in the chat-turns assertion. */
const footprint = (sessionId: string, turnId: string) =>
  readChatTurnFootprint(select, lexicalTerm, sessionId, turnId);

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
    expect(turnSubject).toMatch(/^urn:dkg:chat:session-turn:[0-9a-f]{64}$/);
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
    expect(await footprint(sessionId, turnId)).toEqual({
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: ['pending'],
      transitions: [{ state: 'stored', assistantReply: 'the final answer' }],
    });
    expect(await memoryManager.getChatTurnPersistenceState(sessionId, turnId)).toBe('stored');
    const session = await memoryManager.getSession(sessionId);
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages.find((message) => message.author === 'agent')).toMatchObject({
      text: 'the final answer',
      persistStatus: 'stored',
    });
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
    expect(await footprint(sessionId, turnId)).toEqual({
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: ['failed'],
      transitions: [{ state: 'stored', assistantReply: 'recovered answer' }],
    });
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
    expect(await footprint(channel.storeSessionId(sessionB), turnId)).toEqual({
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: ['pending'],
      transitions: [{ state: 'stored', assistantReply: 'final answer of b' }],
    });
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
    expect(await footprint(channel.storeSessionId(sessionA), turnId)).toEqual({
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: ['pending'],
      transitions: [{ state: 'stored', assistantReply: 'final answer of a' }],
    });
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
    expect(await footprint(channel.storeSessionId(sessionB), turnId)).toEqual({
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: ['failed'],
      transitions: [{ state: 'stored', assistantReply: 'recovered answer of b' }],
    });
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
  const CHAT = 'urn:dkg:chat:';
  const SCHEMA_ORG = 'http://schema.org/';
  const DKG = 'http://dkg.io/ontology/';
  const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const XSD_DATETIME_IRI = 'http://www.w3.org/2001/XMLSchema#dateTime';
  const legacySubject = (turnId: string) => `${CHAT}turn:${turnId}`;

  /** What `storeChatExchange` wrote for a turn with a turn id before session-scoped subjects. */
  async function writeLegacyTurn(
    sessionId: string,
    turnId: string,
    turnState: { persistenceState: 'stored' | 'failed' | 'pending'; userText: string; assistantText: string; failureReason?: string },
  ): Promise<void> {
    await memoryManager.ensureInitialized();
    const suffix = randomUUID().slice(0, 8);
    const session = `${CHAT}session:${sessionId}`;
    const turnUri = legacySubject(turnId);
    const user = `${CHAT}msg:legacy-user-${suffix}`;
    const assistant = `${CHAT}msg:legacy-assistant-${suffix}`;
    const at = new Date();
    const stamp = (offsetMs: number) => `"${new Date(at.getTime() + offsetMs).toISOString()}"^^<${XSD_DATETIME_IRI}>`;
    const quad = (subject: string, predicate: string, object: string) => ({ subject, predicate, object, graph: '' });
    await agent.assertion.write(AGENT_CONTEXT_GRAPH, CHAT_TURNS_ASSERTION, [
      quad(session, RDF_TYPE_IRI, `${SCHEMA_ORG}Conversation`),
      quad(session, `${DKG}sessionId`, `"${sessionId}"`),
      quad(user, RDF_TYPE_IRI, `${SCHEMA_ORG}Message`),
      quad(user, `${SCHEMA_ORG}isPartOf`, session),
      quad(user, `${SCHEMA_ORG}author`, `${CHAT}actor:user`),
      quad(user, `${SCHEMA_ORG}dateCreated`, stamp(0)),
      quad(user, `${SCHEMA_ORG}text`, JSON.stringify(turnState.userText)),
      quad(assistant, RDF_TYPE_IRI, `${SCHEMA_ORG}Message`),
      quad(assistant, `${SCHEMA_ORG}isPartOf`, session),
      quad(assistant, `${SCHEMA_ORG}author`, `${CHAT}actor:agent`),
      quad(assistant, `${SCHEMA_ORG}dateCreated`, stamp(1)),
      quad(assistant, `${SCHEMA_ORG}text`, JSON.stringify(turnState.assistantText)),
      quad(assistant, `${DKG}replyTo`, user),
      quad(turnUri, RDF_TYPE_IRI, `${DKG}ChatTurn`),
      quad(turnUri, `${SCHEMA_ORG}isPartOf`, session),
      quad(turnUri, `${DKG}turnId`, JSON.stringify(turnId)),
      quad(turnUri, `${SCHEMA_ORG}dateCreated`, stamp(0)),
      quad(turnUri, `${DKG}hasUserMessage`, user),
      quad(turnUri, `${DKG}hasAssistantMessage`, assistant),
      quad(turnUri, `${DKG}persistenceState`, JSON.stringify(turnState.persistenceState)),
      ...(turnState.persistenceState === 'failed' && turnState.failureReason
        ? [quad(turnUri, `${DKG}failureReason`, JSON.stringify(turnState.failureReason))]
        : []),
      quad(user, `${DKG}turnId`, JSON.stringify(turnId)),
      quad(assistant, `${DKG}turnId`, JSON.stringify(turnId)),
    ], { agentAddress });
  }

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
    expect(await footprint(sessionId, turnId)).toEqual({
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: [legacy.persistenceState],
      transitions: [{ state: 'stored', assistantReply: 'legacy final answer' }],
    });
    expect(await conversation(sessionId)).toEqual([
      ['user', 'legacy question', 'stored'],
      ['agent', 'legacy final answer', 'stored'],
    ]);
    expect(await memoryManager.getChatTurnPersistenceState(sessionId, turnId)).toBe('stored');
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
    expect(newSubject).toMatch(/^urn:dkg:chat:session-turn:[0-9a-f]{64}$/);
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
});
