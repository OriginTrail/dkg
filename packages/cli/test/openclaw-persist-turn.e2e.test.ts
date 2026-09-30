/**
 * E2E: the `persist-turn` routes of the local-agent channels over real HTTP, into
 * a real store, and the dashboard's chat-history routes over what they wrote.
 *
 * Nothing under test is mocked. A real `DKGAgent` (real libp2p, real Oxigraph
 * store, `MockChainAdapter` for the chain) backs the daemon's real chat-memory
 * stack (`buildChatMemoryStack`, the same wiring `runDaemonInner` uses), and the
 * real OpenClaw, Hermes and Prime Agent route handlers and the dashboard's
 * chat-history handler (`handleNodeUIRequest`, which serves
 * `GET /api/memory/sessions[/:id]`) sit behind a real `http.Server`. Each test
 * POSTs like the adapters do, then reads the `'chat-turns'` Working Memory
 * assertion back with SPARQL and through the chat memory manager.
 *
 * The OpenClaw tests read a footprint (Message and state counts, not ChatTurn
 * subjects) through the helper this tier shares with the devnet suite; see
 * `_helpers/chat-turn-footprint.ts` for why a resend shows up there.
 *
 * A turn id is only unique inside its session, so the durable state of a turn
 * (its duplicate check, its transitions) is keyed by `(sessionId, turnId)`.
 * `describe.each(CHANNELS)` reuses one turn id in two sessions behind each of the
 * three routes. The legacy-subject `describe` reads turns that were stored under
 * the subject scheme that shared one subject per turn id. The next `describe`
 * reads the session list and the single-session route over turns that completed
 * by transition, and the last repeats those reads on a working-memory view that
 * spans more than one graph. Every other test uses its own random turn id as well
 * as its own session, so a failure in one cannot be caused by another's turns.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  AGENT_CONTEXT_GRAPH,
  CHAT_TURNS_ASSERTION,
  handleNodeUIRequest,
  type ChatMemoryManager,
} from '@origintrail-official/dkg-node-ui';
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
    // The dashboard's chat-history routes (`GET /api/memory/sessions[/:id]`), the
    // same handler the daemon runs, over the same real manager.
    if (!res.writableEnded) {
      await handleNodeUIRequest(req, res, url, {} as any, '.', undefined, undefined, undefined, memoryManager);
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

type HistoryMessage = { author: string; text: string };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status).toBe(200);
  return await response.json() as T;
}

/** The session as `GET /api/memory/sessions` lists it. */
async function listed(sessionId: string): Promise<HistoryMessage[] | undefined> {
  const { sessions } = await getJson<{ sessions: Array<{ session: string; messages: HistoryMessage[] }> }>('/api/memory/sessions?limit=100');
  return sessions.find((entry) => entry.session === sessionId)?.messages.map(({ author, text }) => ({ author, text }));
}

/** The session as `GET /api/memory/sessions/:id` returns it. */
async function single(sessionId: string): Promise<HistoryMessage[]> {
  const { messages } = await getJson<{ messages: HistoryMessage[] }>(`/api/memory/sessions/${encodeURIComponent(sessionId)}`);
  return messages.map(({ author, text }) => ({ author, text }));
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
