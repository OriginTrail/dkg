/**
 * The HTTP answer of the three `persist-turn` routes, for every durable-turn
 * outcome: what a caller of `POST /api/{openclaw,hermes,prime-agent}-channel/persist-turn`
 * reads back.
 *
 * All three routes hand the turn to the one owner (`persistDurableChatTurn`) and
 * answer from its outcome, so the answer has to be the same for the same outcome
 * whatever the channel, apart from the fields a channel adds itself (Prime Agent
 * names the session it stored under). The bodies are pinned as raw text, key
 * order included, because that is what adapters on the other side of the wire
 * receive. Each expected string was captured from the routes before the answer
 * was built in one place, so a refactor that changed one byte of any of them
 * fails here.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import type { DurableChatTurnOutcome } from '../src/daemon/chat-turn-persistence.js';
import { durableChatTurnResponseBody } from '../src/daemon/routes/durable-chat-turn-response.js';
import { handleHermesRoutes } from '../src/daemon/routes/hermes.js';
import { handleOpenclawRoutes } from '../src/daemon/routes/openclaw.js';
import { handlePrimeAgentRoutes } from '../src/daemon/routes/prime-agent.js';
import { makeDurableChatTurnStore } from './_helpers/durable-chat-turn-store.js';

function makeRequest(path: string, payload: unknown) {
  const req = new EventEmitter() as any;
  req.method = 'POST';
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }, 0);
  return req;
}

function makeResponse() {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.write = (chunk: string | Uint8Array) => {
    res.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  res.end = (chunk?: string | Buffer) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
  };
  return res;
}

const TURN_ID = 'turn-1';

/**
 * `sessionId` is what the caller sends; `storedSessionId` is what the store sees
 * (Prime Agent namespaces it); `answersSession` is whether the route names it.
 */
const CHANNELS = [
  {
    name: 'OpenClaw',
    path: '/api/openclaw-channel/persist-turn',
    handle: handleOpenclawRoutes,
    sessionId: 'openclaw:dkg-ui',
    storedSessionId: 'openclaw:dkg-ui',
    answersSession: false,
  },
  {
    name: 'Hermes',
    path: '/api/hermes-channel/persist-turn',
    handle: handleHermesRoutes,
    sessionId: 'hermes:dkg-ui',
    storedSessionId: 'hermes:dkg-ui',
    answersSession: false,
  },
  {
    name: 'Prime Agent',
    path: '/api/prime-agent-channel/persist-turn',
    handle: handlePrimeAgentRoutes,
    sessionId: 'session-1',
    storedSessionId: 'prime-agent:dkg-ui:session-1',
    answersSession: true,
  },
] as const;

type Channel = (typeof CHANNELS)[number];

/** POST one stored turn to the channel's route, over a store that already holds `existing`. */
async function persist(
  channel: Channel,
  store: ReturnType<typeof makeDurableChatTurnStore>,
) {
  const res = makeResponse();
  await channel.handle({
    req: makeRequest(channel.path, {
      sessionId: channel.sessionId,
      userMessage: 'hello',
      assistantReply: 'hi there',
      turnId: TURN_ID,
      persistenceState: 'stored',
    }),
    res,
    agent: { store: { query: async () => ({ bindings: [] }) } },
    config: { name: 'test-node', apiPort: 9200, listenPort: 0, nodeRole: 'edge' },
    memoryManager: store,
    bridgeAuthToken: 'bridge-token',
    extractionStatus: new Map(),
    path: channel.path,
  } as any);
  return { statusCode: res.statusCode as number, body: res.body as string };
}

/** The exact body text a channel answers with; Prime Agent appends the session it stored under. */
const bodyText = (channel: Channel, fields: string) =>
  `{"ok":true${fields},"turnId":"${TURN_ID}"${channel.answersSession ? `,"sessionId":"${channel.storedSessionId}"` : ''}}`;

describe.each(CHANNELS)('$name persist-turn answer, by durable-turn outcome', (channel) => {
  it('created: a turn the store has not seen', async () => {
    const store = makeDurableChatTurnStore();

    const answer = await persist(channel, store);

    expect(answer).toEqual({ statusCode: 200, body: bodyText(channel, '') });
    expect(store.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(store.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
  });

  it('duplicate: the turn is already stored', async () => {
    const store = makeDurableChatTurnStore();
    store.seed(channel.storedSessionId, TURN_ID, 'stored');

    const answer = await persist(channel, store);

    expect(answer).toEqual({ statusCode: 200, body: bodyText(channel, ',"duplicate":true') });
    expect(store.storeChatExchange).not.toHaveBeenCalled();
    expect(store.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
  });

  it('transitioned: a pending turn completes', async () => {
    const store = makeDurableChatTurnStore();
    store.seed(channel.storedSessionId, TURN_ID, 'pending');

    const answer = await persist(channel, store);

    expect(answer).toEqual({ statusCode: 200, body: bodyText(channel, ',"transitioned":true') });
    expect(store.storeChatExchange).not.toHaveBeenCalled();
    expect(store.recordChatTurnPersistenceTransition).toHaveBeenCalledTimes(1);
  });

  it('a store failure: 500 with the error message, and no other field', async () => {
    const store = makeDurableChatTurnStore();
    store.storeChatExchange.mockRejectedValueOnce(new Error('store is down'));

    const answer = await persist(channel, store);

    expect(answer).toEqual({ statusCode: 500, body: '{"error":"store is down"}' });
  });
});

describe('durableChatTurnResponseBody', () => {
  const outcome = (kind: DurableChatTurnOutcome['kind']): DurableChatTurnOutcome => ({
    kind,
    sessionId: 'session-1',
    turnId: 'turn-1',
  });

  it.each([
    ['created', '{"ok":true,"turnId":"turn-1"}'],
    ['duplicate', '{"ok":true,"duplicate":true,"turnId":"turn-1"}'],
    ['transitioned', '{"ok":true,"transitioned":true,"turnId":"turn-1"}'],
  ] as const)('%s: exactly ok, its flag if it has one, and the turn id, in that order', (kind, text) => {
    expect(JSON.stringify(durableChatTurnResponseBody(outcome(kind)))).toBe(text);
  });

  it('names the turn the owner acted on and leaves the session to the channel', () => {
    const body = durableChatTurnResponseBody({ kind: 'created', sessionId: 'internal-session', turnId: 'generated-id' });

    expect(body).toEqual({ ok: true, turnId: 'generated-id' });
    expect(body).not.toHaveProperty('sessionId');
  });
});
