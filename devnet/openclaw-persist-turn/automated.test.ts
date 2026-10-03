/**
 * OpenClaw persist-turn idempotency - devnet regression.
 *
 * Preconditions:
 *   pnpm run build
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *
 * `POST /api/openclaw-channel/persist-turn` hands each turn to the daemon-wide
 * durable-turn owner (`persistDurableChatTurn`, shared with Hermes and Prime
 * Agent), so a resent `(sessionId, turnId)` is suppressed instead of writing a
 * second user/assistant Message pair into the `'chat-turns'` Working Memory
 * assertion of the node's `agent-context` graph, and a higher `persistenceState`
 * is recorded as a transition.
 *
 * The suite drives that route on live devnet daemons over HTTP with the node's
 * bearer token and reads the assertion back through `POST /api/query` (the
 * harness's `queryNode`), and the dashboard's two history routes over `GET`. A
 * turn id is only unique inside its session, so one case reuses a turn id in two
 * sessions and requires each to be created, completed and retried on its own.
 * It runs against nodes 1, 3 and 5, which sit on different store backends
 * (oxigraph-server, blazegraph, and sparql-http to an external Oxigraph), and
 * repeats the resend check on the Hermes and Prime Agent routes as the parity
 * regression: all three channels must behave the same on retry.
 *
 * Read lag: a write that returned 200 is durable, but external SPARQL stores may
 * serve a read a beat behind it. Every footprint check therefore waits for the
 * expected footprint and then requires it to stay unchanged for a quiet window
 * (`settleOnExpected` in settle.ts, unit-tested without a devnet in
 * settle.test.ts), so a lagging read that shows the expected one-exchange
 * footprint before the duplicates of a broken resend path become visible is not
 * taken for the final state. The window is short; it cannot see a store that
 * lags for longer than that.
 *
 * Isolation: every test writes only turns of its own random sessions and turn
 * id into the node's own `agent-context` / `chat-turns` assertion. It never
 * touches the shared `devnet-test` context graph, a node wallet or the chain.
 * There is no API to delete a chat turn, so those turns stay in the devnet's
 * node data until `./scripts/devnet.sh clean`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchRetry,
  getJson,
  lexical,
  postJson,
  queryNode,
  readNodeConfig,
  type DevnetNode,
} from '../_bootstrap/harness.js';
import {
  NO_CHAT_TURN,
  ONE_STORED_TURN,
  readChatTurnFootprint,
  type ChatTurnFootprint,
} from '../../packages/cli/test/_helpers/chat-turn-footprint.js';
import { FOOTPRINT_SETTLE, settleOnExpected } from './settle.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One node per store backend the devnet provisions: 1 core, 3 core, 5 edge. */
const NODE_NUMS = [1, 3, 5] as const;

type Channel = 'openclaw' | 'hermes' | 'prime-agent';

interface PersistBody {
  ok?: boolean;
  duplicate?: boolean;
  transitioned?: boolean;
  turnId?: string;
  sessionId?: string;
  error?: string;
}

const USER_TEXT = 'devnet: what is a knowledge asset?';
const ASSISTANT_TEXT = 'devnet: a knowledge asset is a verifiable unit of knowledge.';

const nodes = new Map<number, DevnetNode>();

function storeBackend(node: DevnetNode): string {
  const config = JSON.parse(readFileSync(join(node.home, 'config.json'), 'utf8')) as {
    store?: { backend?: string };
  };
  return config.store?.backend ?? 'oxigraph (default)';
}

async function persist(
  node: DevnetNode,
  channel: Channel,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: PersistBody }> {
  const { status, json } = await postJson(node, `/api/${channel}-channel/persist-turn`, payload);
  return { status, body: (json ?? {}) as PersistBody };
}

const turnPayload = (
  sessionId: string,
  turnId: string | undefined,
  overrides: Record<string, unknown> = {},
) => ({
  sessionId,
  userMessage: USER_TEXT,
  assistantReply: ASSISTANT_TEXT,
  ...(turnId === undefined ? {} : { turnId }),
  ...overrides,
});

/**
 * Where the suite reads: the node's chat-turns Working Memory assertion, through
 * the harness's canonical query transport (`queryNode`: request shape, the three
 * response shapes it decodes, and the status-and-body error).
 */
const CHAT_TURNS_QUERY = {
  contextGraphId: 'agent-context',
  view: 'working-memory',
  assertionName: 'chat-turns',
} as const;

/** Everything one `(sessionId, turnId)` left in the chat-turns assertion. */
const footprint = (node: DevnetNode, sessionId: string, turnId: string): Promise<ChatTurnFootprint> =>
  readChatTurnFootprint((sparql) => queryNode(node, sparql, CHAT_TURNS_QUERY), lexical, sessionId, turnId);

/**
 * The footprint once the store reports the expected shape AND keeps reporting
 * it. A write that returned 200 is durable (the route awaits the store write),
 * but external SPARQL stores may serve a read a beat behind it. Polling only
 * until the first read that equals `expected` would pass on such a stale read
 * while a duplicate write is still on its way to becoming visible, so
 * `settleOnExpected` keeps reading for a quiet window after the first match and
 * returns the first read that differs (settle.ts). A footprint that never
 * converges returns the last one seen. Callers assert the result equals
 * `expected`, so both a late footprint and an unconverged one fail there.
 */
async function settledFootprint(
  node: DevnetNode,
  sessionId: string,
  turnId: string,
  expected: ChatTurnFootprint,
): Promise<ChatTurnFootprint> {
  const { value } = await settleOnExpected(() => footprint(node, sessionId, turnId), expected, FOOTPRINT_SETTLE);
  return value;
}

const newSessionId = (channel: Channel) => `devnet-${channel}-${randomUUID()}`;
const newTurnId = () => `turn-${randomUUID()}`;

beforeAll(async () => {
  for (const num of NODE_NUMS) {
    const node = readNodeConfig(num);
    const res = await fetchRetry(`http://127.0.0.1:${node.apiPort}/api/status`);
    if (!res.ok) {
      throw new Error(
        `devnet node${num} /api/status failed (${res.status}). Run ./scripts/devnet.sh start 6 first.`,
      );
    }
    nodes.set(num, node);
    // Recorded in the run output so a green run says which backends it covered.
    console.log(`[openclaw-persist-turn] node${num} store backend: ${storeBackend(node)}`);
  }
}, 60_000);

describe.each(NODE_NUMS)('OpenClaw persist-turn on devnet node%i', (num) => {
  const node = () => nodes.get(num)!;

  it('writes a new turn once', async () => {
    const sessionId = newSessionId('openclaw');
    const turnId = newTurnId();

    const first = await persist(node(), 'openclaw', turnPayload(sessionId, turnId));

    expect(first).toEqual({ status: 200, body: { ok: true, turnId } });
    expect(await settledFootprint(node(), sessionId, turnId, ONE_STORED_TURN)).toEqual(ONE_STORED_TURN);
  });

  it('suppresses sequential and concurrent resends of the same (sessionId, turnId)', async () => {
    const sessionId = newSessionId('openclaw');
    const turnId = newTurnId();

    const created = await persist(node(), 'openclaw', turnPayload(sessionId, turnId));
    const sequential = [
      await persist(node(), 'openclaw', turnPayload(sessionId, turnId)),
      await persist(node(), 'openclaw', turnPayload(sessionId, turnId)),
    ];
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => persist(node(), 'openclaw', turnPayload(sessionId, turnId))),
    );

    expect(created.body).toEqual({ ok: true, turnId });
    for (const resend of [...sequential, ...concurrent]) {
      expect(resend).toEqual({ status: 200, body: { ok: true, duplicate: true, turnId } });
    }
    expect(await settledFootprint(node(), sessionId, turnId, ONE_STORED_TURN)).toEqual(ONE_STORED_TURN);
  });

  it('suppresses concurrent first writes of one turn down to a single exchange', async () => {
    const sessionId = newSessionId('openclaw');
    const turnId = newTurnId();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => persist(node(), 'openclaw', turnPayload(sessionId, turnId))),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.body.duplicate === undefined)).toHaveLength(1);
    expect(responses.filter((response) => response.body.duplicate === true)).toHaveLength(7);
    expect(await settledFootprint(node(), sessionId, turnId, ONE_STORED_TURN)).toEqual(ONE_STORED_TURN);
  });

  it('records pending -> stored as a transition, not a second exchange', async () => {
    const sessionId = newSessionId('openclaw');
    const turnId = newTurnId();
    const expected: ChatTurnFootprint = {
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: ['pending'],
      transitions: [{ state: 'stored', assistantReply: 'devnet: the final answer' }],
    };

    const pending = await persist(node(), 'openclaw', turnPayload(sessionId, turnId, {
      assistantReply: 'devnet: working on it',
      persistenceState: 'pending',
    }));
    const stored = await persist(node(), 'openclaw', turnPayload(sessionId, turnId, {
      assistantReply: 'devnet: the final answer',
      persistenceState: 'stored',
    }));
    const resend = await persist(node(), 'openclaw', turnPayload(sessionId, turnId, {
      assistantReply: 'devnet: the final answer',
      persistenceState: 'stored',
    }));
    const late = await persist(node(), 'openclaw', turnPayload(sessionId, turnId, {
      persistenceState: 'failed',
      failureReason: 'late failure',
    }));

    expect(pending.body).toEqual({ ok: true, turnId });
    expect(stored.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(resend.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(late.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(await settledFootprint(node(), sessionId, turnId, expected)).toEqual(expected);
  });

  it('keeps two sessions that reuse one turnId apart: each is created, completed and retried on its own', async () => {
    const sessionA = newSessionId('openclaw');
    const sessionB = newSessionId('openclaw');
    const turnId = newTurnId();
    const expectedA = ONE_STORED_TURN;
    const expectedB: ChatTurnFootprint = {
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: ['pending'],
      transitions: [{ state: 'stored', assistantReply: 'devnet: the final answer of b' }],
    };

    const aStored = await persist(node(), 'openclaw', turnPayload(sessionA, turnId, { assistantReply: 'devnet: answer of a' }));
    const bPending = await persist(node(), 'openclaw', turnPayload(sessionB, turnId, {
      assistantReply: 'devnet: b is working on it',
      persistenceState: 'pending',
    }));
    const bStored = await persist(node(), 'openclaw', turnPayload(sessionB, turnId, {
      assistantReply: 'devnet: the final answer of b',
      persistenceState: 'stored',
    }));
    const aResend = await persist(node(), 'openclaw', turnPayload(sessionA, turnId, { assistantReply: 'devnet: answer of a' }));
    const bResend = await persist(node(), 'openclaw', turnPayload(sessionB, turnId, {
      assistantReply: 'devnet: the final answer of b',
      persistenceState: 'stored',
    }));

    expect(aStored.body).toEqual({ ok: true, turnId });
    expect(bPending.body).toEqual({ ok: true, turnId });
    expect(bStored.body).toEqual({ ok: true, transitioned: true, turnId });
    expect(aResend.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(bResend.body).toEqual({ ok: true, duplicate: true, turnId });
    expect(await settledFootprint(node(), sessionA, turnId, expectedA)).toEqual(expectedA);
    expect(await settledFootprint(node(), sessionB, turnId, expectedB)).toEqual(expectedB);
  });

  it('lists and returns the final reply on both history routes after pending -> stored', async () => {
    const sessionId = newSessionId('openclaw');
    const turnId = newTurnId();
    const expected = [
      { author: 'user', text: USER_TEXT },
      { author: 'agent', text: 'devnet: the final answer' },
    ];
    const history = async () => {
      const single = await getJson(node(), `/api/memory/sessions/${encodeURIComponent(sessionId)}`);
      const list = await getJson(node(), '/api/memory/sessions?limit=100');
      const listed = (list.json?.sessions ?? []).find((entry: { session?: string }) => entry.session === sessionId);
      const texts = (messages: Array<{ author: string; text: string }> | undefined) =>
        (messages ?? []).map(({ author, text }) => ({ author, text }));
      return { statuses: [single.status, list.status], single: texts(single.json?.messages), listed: texts(listed?.messages) };
    };

    await persist(node(), 'openclaw', turnPayload(sessionId, turnId, {
      assistantReply: 'devnet: working on it',
      persistenceState: 'pending',
    }));
    const stored = await persist(node(), 'openclaw', turnPayload(sessionId, turnId, {
      assistantReply: 'devnet: the final answer',
      persistenceState: 'stored',
    }));
    expect(stored.body).toEqual({ ok: true, transitioned: true, turnId });

    // The reads may lag the writes on an external store, so wait for the routes to agree and then keep reading.
    const expectedHistory = { statuses: [200, 200], single: expected, listed: expected };
    const { value } = await settleOnExpected(history, expectedHistory, FOOTPRINT_SETTLE);
    if (value.listed.length === 0) {
      // An empty list says nothing about why: report what the list route did hold.
      const list = await getJson(node(), '/api/memory/sessions?limit=100');
      const ids = ((list.json?.sessions ?? []) as Array<{ session?: string }>).map((entry) => entry.session);
      throw new Error(
        `node${num} /api/memory/sessions (status ${list.status}) lists ${ids.length} sessions`
        + ` and ${ids.includes(sessionId) ? 'holds' : 'does not hold'} ${sessionId}; the last read was ${JSON.stringify(value)}`,
      );
    }
    expect(value).toEqual(expectedHistory);
  });

  it('still writes every POST that carries no turnId, each under a generated one', async () => {
    const sessionId = newSessionId('openclaw');

    const first = await persist(node(), 'openclaw', turnPayload(sessionId, undefined));
    const second = await persist(node(), 'openclaw', turnPayload(sessionId, undefined));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();
    expect(second.body.duplicate).toBeUndefined();
    expect(first.body.turnId).toMatch(UUID_RE);
    expect(second.body.turnId).toMatch(UUID_RE);
    expect(second.body.turnId).not.toBe(first.body.turnId);
    expect(await settledFootprint(node(), sessionId, first.body.turnId!, ONE_STORED_TURN)).toEqual(ONE_STORED_TURN);
    expect(await settledFootprint(node(), sessionId, second.body.turnId!, ONE_STORED_TURN)).toEqual(ONE_STORED_TURN);

    // The generated id comes back in the response, so a caller can retry idempotently.
    const resend = await persist(node(), 'openclaw', turnPayload(sessionId, first.body.turnId));
    expect(resend.body).toEqual({ ok: true, duplicate: true, turnId: first.body.turnId });
  });

  it('rejects an invalid payload with 400 and writes nothing', async () => {
    const sessionId = newSessionId('openclaw');
    const turnId = newTurnId();

    const missingReply = await persist(node(), 'openclaw', { sessionId, userMessage: 'hi', turnId });
    const unknownState = await persist(node(), 'openclaw', turnPayload(sessionId, turnId, { persistenceState: 'complete' }));

    expect(missingReply.status).toBe(400);
    expect(unknownState.status).toBe(400);
    // A read that shows nothing once could be a lagging one, so the absence has to hold for the quiet window too.
    expect(await settledFootprint(node(), sessionId, turnId, NO_CHAT_TURN)).toEqual(NO_CHAT_TURN);
  });
});

/**
 * Parity regression: Hermes and Prime Agent already route persist-turn through
 * the same durable-turn owner. All three channels must give one exchange for a
 * resent turn and one transition for an upward state change.
 */
describe.each(['hermes', 'prime-agent'] as const)('%s persist-turn parity on devnet', (channel) => {
  it.each(NODE_NUMS)('suppresses resends and records an upward transition on node%i', async (num) => {
    const node = nodes.get(num)!;
    const requestedSession = newSessionId(channel);
    const turnId = newTurnId();

    const pending = await persist(node, channel, turnPayload(requestedSession, turnId, {
      assistantReply: 'devnet: working on it',
      persistenceState: 'pending',
    }));
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({ ok: true, turnId });
    // Prime Agent namespaces the session it stores; it reports the stored id back.
    const storedSession = pending.body.sessionId ?? requestedSession;

    const resend = await persist(node, channel, turnPayload(requestedSession, turnId, {
      assistantReply: 'devnet: working on it',
      persistenceState: 'pending',
    }));
    const stored = await persist(node, channel, turnPayload(requestedSession, turnId, {
      assistantReply: 'devnet: the final answer',
      persistenceState: 'stored',
    }));
    const storedResend = await persist(node, channel, turnPayload(requestedSession, turnId, {
      assistantReply: 'devnet: the final answer',
      persistenceState: 'stored',
    }));

    expect(resend.body).toMatchObject({ ok: true, duplicate: true, turnId });
    expect(stored.body).toMatchObject({ ok: true, transitioned: true, turnId });
    expect(storedResend.body).toMatchObject({ ok: true, duplicate: true, turnId });
    const expected: ChatTurnFootprint = {
      turns: 1,
      messages: 2,
      userMessages: 1,
      assistantMessages: 1,
      states: ['pending'],
      transitions: [{ state: 'stored', assistantReply: 'devnet: the final answer' }],
    };
    expect(await settledFootprint(node, storedSession, turnId, expected)).toEqual(expected);
  });
});
