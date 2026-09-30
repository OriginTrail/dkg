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
 * Every test uses its own random turn id as well as its own session: the turn
 * subject is `urn:dkg:chat:turn:<turnId>` whatever the session, so two tests
 * sharing a turn id would read each other's states.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { AGENT_CONTEXT_GRAPH, CHAT_TURNS_ASSERTION, type ChatMemoryManager } from '@origintrail-official/dkg-node-ui';
import { buildChatMemoryStack, resolveMemoryAgentAddress } from '../src/daemon.js';
import { handleOpenclawRoutes } from '../src/daemon/routes/openclaw.js';
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
    await handleOpenclawRoutes({
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
    } as any);
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
  body: { ok?: boolean; duplicate?: boolean; transitioned?: boolean; turnId?: string; error?: string };
}

/** POST one turn the way the OpenClaw adapter's `DkgClient.storeChatTurn` does. */
async function persistTurn(payload: Record<string, unknown>): Promise<PersistResponse> {
  const response = await fetch(`${baseUrl}${PERSIST_TURN}`, {
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
