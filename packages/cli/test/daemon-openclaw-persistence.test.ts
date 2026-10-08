/**
 * OpenClaw's adapter contract for `POST /api/openclaw-channel/persist-turn`.
 *
 * The route hands every turn to the daemon-wide `persistDurableChatTurn` owner,
 * the same one Hermes and Prime Agent use. That owner's state machine (the
 * created / duplicate / transition ranking, the per-`(sessionId, turnId)` lock
 * and its failure paths) is specified once, in `chat-turn-persistence.test.ts`.
 * This file covers only what belongs to OpenClaw:
 *
 * - parsing and validation of the body, and its 400s;
 * - the normalized payload (`normalizeOpenClawPersistTurnPayload`), including
 *   the generated and trimmed turn ids;
 * - attachment provenance and the refs that reach persistence;
 * - the payload the route forwards to `persistDurableChatTurn`;
 * - how an owner outcome, or a failure, becomes the HTTP response.
 *
 * The real owner still runs behind the route in a few tests, over the
 * state-aware fake store (`_helpers/durable-chat-turn-store.ts`), so a route
 * that stopped delegating to it would fail here. The real-store and devnet
 * tiers (`openclaw-persist-turn.e2e.test.ts`, `devnet/openclaw-persist-turn`)
 * prove the whole path end to end. `daemon-openclaw.part-*.test.ts` mocks do
 * not answer `getChatTurnPersistenceState`, so they cannot detect the dedupe.
 */
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DkgConfig } from '../src/config.js';
import { persistDurableChatTurn } from '../src/daemon/chat-turn-persistence.js';
import {
  normalizeOpenClawPersistTurnPayload,
  persistOpenClawTurn,
} from '../src/daemon/routes/openclaw-persist-turn.js';
import { handleOpenclawRoutes } from '../src/daemon/routes/openclaw.js';
import { makeDurableChatTurnStore, turnStateKey, type DurableChatTurnStoreDouble } from './_helpers/durable-chat-turn-store.js';

// Wrap the real owner: it runs unless a test overrides one call, and every call is recorded.
vi.mock('../src/daemon/chat-turn-persistence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon/chat-turn-persistence.js')>();
  return { ...actual, persistDurableChatTurn: vi.fn(actual.persistDurableChatTurn) };
});
const owner = vi.mocked(persistDurableChatTurn);

const PERSIST_TURN_PATH = '/api/openclaw-channel/persist-turn';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSING_FIELDS = 'Missing required fields: sessionId, userMessage, assistantReply';

function makeRawRequest(rawBody: string) {
  const req = new EventEmitter() as any;
  req.method = 'POST';
  req.url = PERSIST_TURN_PATH;
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(rawBody));
    req.emit('end');
  }, 0);
  return req;
}

function makeJsonResponse() {
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

function config(): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
  } as DkgConfig;
}

/** POST a raw request body through the real route and return the raw and parsed response. */
async function postRaw(
  memoryManager: DurableChatTurnStoreDouble,
  rawBody: string,
  overrides: Record<string, unknown> = {},
) {
  const res = makeJsonResponse();
  await handleOpenclawRoutes({
    req: makeRawRequest(rawBody),
    res,
    agent: { store: { query: vi.fn(async () => ({ bindings: [] })) } },
    config: config(),
    memoryManager,
    bridgeAuthToken: 'bridge-token',
    extractionStatus: new Map(),
    path: PERSIST_TURN_PATH,
    ...overrides,
  } as any);
  return { statusCode: res.statusCode as number, raw: res.body as string, body: JSON.parse(res.body) as any };
}

const persistTurn = (
  memoryManager: DurableChatTurnStoreDouble,
  payload: unknown,
  overrides: Record<string, unknown> = {},
) => postRaw(memoryManager, JSON.stringify(payload), overrides);

const turn = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'openclaw:dkg-ui',
  userMessage: 'hello',
  assistantReply: 'hi there',
  turnId: 'turn-1',
  ...overrides,
});

const attachment = {
  assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
  fileHash: 'sha256:abc123',
  contextGraphId: 'cg1',
  fileName: 'chat-doc.pdf',
  detectedContentType: 'application/pdf',
  extractionStatus: 'completed' as const,
  tripleCount: 42,
  rootEntity: 'did:dkg:context-graph:cg1/assertion/chat-doc',
};
const extractionRecord = () => {
  const now = new Date();
  return {
    status: 'completed',
    fileHash: attachment.fileHash,
    fileName: attachment.fileName,
    detectedContentType: attachment.detectedContentType,
    pipelineUsed: 'application/pdf',
    tripleCount: attachment.tripleCount,
    rootEntity: attachment.rootEntity,
    startedAt: new Date(now.getTime() - 1000).toISOString(),
    completedAt: now.toISOString(),
  };
};

beforeEach(() => {
  owner.mockReset();
});

// -- The normalized payload -------------------------------------------------------------

describe('normalizeOpenClawPersistTurnPayload', () => {
  it('normalizes a minimal turn to exactly the durable-turn payload fields', () => {
    expect(normalizeOpenClawPersistTurnPayload(turn())).toStrictEqual({
      sessionId: 'openclaw:dkg-ui',
      turnId: 'turn-1',
      userMessage: 'hello',
      assistantReply: 'hi there',
      persistenceState: 'stored',
      failureReason: undefined,
      toolCalls: undefined,
      attachmentRefs: undefined,
    });
  });

  it('forwards the session id as sent, untrimmed, and accepts empty message strings', () => {
    expect(normalizeOpenClawPersistTurnPayload(turn({ sessionId: '  sess  ', userMessage: '', assistantReply: '' })))
      .toMatchObject({ sessionId: '  sess  ', userMessage: '', assistantReply: '' });
  });

  it('ignores fields that are not part of the durable turn', () => {
    const normalized = normalizeOpenClawPersistTurnPayload(turn({ metadata: { a: 1 }, correlationId: 'c', extra: true }));

    expect(Object.keys(normalized).sort()).toEqual([
      'assistantReply', 'attachmentRefs', 'failureReason', 'persistenceState',
      'sessionId', 'toolCalls', 'turnId', 'userMessage',
    ]);
  });

  describe('turn id', () => {
    it.each([
      { sent: 'turn-1', turnId: 'turn-1' },
      { sent: '  turn-padded ', turnId: 'turn-padded' },
      { sent: '\tturn-tabbed\n', turnId: 'turn-tabbed' },
    ])('takes $sent as the trimmed id $turnId', ({ sent, turnId }) => {
      expect(normalizeOpenClawPersistTurnPayload(turn({ turnId: sent }))).toMatchObject({ turnId });
    });

    // Each row is wrapped: `it.each` would spread a bare array row into arguments.
    it.each([[''], ['   '], [null], [42], [true], [{}], [[]]])('generates an id for a blank or non-string turn id (%j)', (sent) => {
      expect(normalizeOpenClawPersistTurnPayload(turn({ turnId: sent }))).toMatchObject({
        turnId: expect.stringMatching(UUID_RE),
      });
    });

    it('generates a fresh id for every payload without one', () => {
      const { turnId: _omitted, ...withoutTurnId } = turn();

      const first = normalizeOpenClawPersistTurnPayload(withoutTurnId) as { turnId: string };
      const second = normalizeOpenClawPersistTurnPayload(withoutTurnId) as { turnId: string };

      expect(first.turnId).toMatch(UUID_RE);
      expect(second.turnId).toMatch(UUID_RE);
      expect(second.turnId).not.toBe(first.turnId);
    });
  });

  it.each([
    { sent: 'pending', persistenceState: 'pending' },
    { sent: 'failed', persistenceState: 'failed' },
    { sent: 'stored', persistenceState: 'stored' },
    { sent: undefined, persistenceState: 'stored' },
  ])('takes persistenceState $sent as $persistenceState', ({ sent, persistenceState }) => {
    expect(normalizeOpenClawPersistTurnPayload(turn({ persistenceState: sent }))).toMatchObject({ persistenceState });
  });

  it.each([
    { sent: '  provider timed out ', failureReason: 'provider timed out' },
    { sent: 'x', failureReason: 'x' },
    { sent: '   ', failureReason: undefined },
    { sent: '', failureReason: undefined },
    { sent: null, failureReason: undefined },
    { sent: undefined, failureReason: undefined },
  ])('takes failureReason $sent as $failureReason', ({ sent, failureReason }) => {
    expect(normalizeOpenClawPersistTurnPayload(turn({ failureReason: sent }))).toMatchObject({ failureReason });
  });

  describe('tool calls', () => {
    it('passes an array through as sent, without checking its entries', () => {
      const toolCalls = [{ name: 'search', args: { query: 'dkg' }, result: { hits: 1 } }, null, 'junk'];

      const normalized = normalizeOpenClawPersistTurnPayload(turn({ toolCalls })) as { toolCalls: unknown };

      expect(normalized.toolCalls).toEqual(toolCalls);
    });

    it('keeps an empty array empty', () => {
      expect(normalizeOpenClawPersistTurnPayload(turn({ toolCalls: [] }))).toMatchObject({ toolCalls: [] });
    });

    it.each(['x', {}, null, 0])('drops a non-array (%j)', (toolCalls) => {
      expect(normalizeOpenClawPersistTurnPayload(turn({ toolCalls }))).toMatchObject({ toolCalls: undefined });
    });
  });

  describe('attachment refs', () => {
    it('normalizes the refs (trimmed, unknown fields dropped) without verifying them', () => {
      const normalized = normalizeOpenClawPersistTurnPayload(turn({
        attachmentRefs: [{ ...attachment, fileName: ' chat-doc.pdf ', junk: 1 }],
      }));

      expect(normalized).toMatchObject({ attachmentRefs: [attachment] });
    });

    it('keeps an empty list empty and leaves absent refs undefined', () => {
      expect(normalizeOpenClawPersistTurnPayload(turn({ attachmentRefs: [] }))).toMatchObject({ attachmentRefs: [] });
      expect(normalizeOpenClawPersistTurnPayload(turn())).toMatchObject({ attachmentRefs: undefined });
    });
  });

  it.each([
    { label: 'a missing sessionId', body: { userMessage: 'hi', assistantReply: 'yo', turnId: 't' } },
    { label: 'a blank sessionId', body: { sessionId: '  ', userMessage: 'hi', assistantReply: 'yo', turnId: 't' } },
    { label: 'a non-string sessionId', body: turn({ sessionId: 5 }) },
    { label: 'a missing userMessage', body: { sessionId: 's', assistantReply: 'yo', turnId: 't' } },
    { label: 'a missing assistantReply', body: { sessionId: 's', userMessage: 'hi', turnId: 't' } },
    { label: 'an unknown persistenceState', body: turn({ persistenceState: 'complete' }) },
    { label: 'a null persistenceState', body: turn({ persistenceState: null }) },
    { label: 'a non-string failureReason', body: turn({ failureReason: 7 }) },
    { label: 'null attachmentRefs', body: turn({ attachmentRefs: null }) },
    { label: 'non-array attachmentRefs', body: turn({ attachmentRefs: 'nope' }) },
    { label: 'a malformed attachment ref', body: turn({ attachmentRefs: [{ assertionUri: attachment.assertionUri }] }) },
    { label: 'an empty object', body: {} },
    { label: 'an array', body: [] },
    { label: 'a number', body: 42 },
    { label: 'a string', body: 'text' },
  ])('answers the missing-fields error for $label', ({ body }) => {
    expect(normalizeOpenClawPersistTurnPayload(body)).toEqual({ error: MISSING_FIELDS });
  });
});

// -- The HTTP route ---------------------------------------------------------------------

describe('POST /api/openclaw-channel/persist-turn', () => {
  describe('parsing and validation', () => {
    it.each([
      { label: 'a missing sessionId', payload: { userMessage: 'hi', assistantReply: 'yo', turnId: 't' } },
      { label: 'a blank sessionId', payload: { sessionId: '  ', userMessage: 'hi', assistantReply: 'yo', turnId: 't' } },
      { label: 'a missing userMessage', payload: { sessionId: 's', assistantReply: 'yo', turnId: 't' } },
      { label: 'a missing assistantReply', payload: { sessionId: 's', userMessage: 'hi', turnId: 't' } },
      { label: 'an unknown persistenceState', payload: turn({ persistenceState: 'complete' }) },
      { label: 'a non-string failureReason', payload: turn({ failureReason: 7 }) },
      { label: 'null attachmentRefs', payload: turn({ attachmentRefs: null }) },
      { label: 'a body that is an array', payload: [] },
      { label: 'a body that is a number', payload: 42 },
    ])('answers 400 without reaching persistence for $label', async ({ payload }) => {
      const memoryManager = makeDurableChatTurnStore();

      const { statusCode, raw } = await persistTurn(memoryManager, payload);

      expect(statusCode).toBe(400);
      expect(raw).toBe(JSON.stringify({ error: MISSING_FIELDS }));
      expect(owner).not.toHaveBeenCalled();
      expect(memoryManager.getChatTurnPersistenceState).not.toHaveBeenCalled();
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    });

    it.each(['{not json', ''])('answers 400 for a body that is not JSON (%j)', async (rawBody) => {
      const memoryManager = makeDurableChatTurnStore();

      const { statusCode, raw } = await postRaw(memoryManager, rawBody);

      expect(statusCode).toBe(400);
      expect(raw).toBe('{"error":"Invalid JSON"}');
      expect(owner).not.toHaveBeenCalled();
    });
  });

  describe('the payload forwarded to persistDurableChatTurn', () => {
    it('hands over the ChatMemoryManager and the normalized payload, with no afterStored hook', async () => {
      const memoryManager = makeDurableChatTurnStore();
      const toolCalls = [{ name: 'search', args: { query: 'dkg' }, result: { hits: 1 } }];

      const { statusCode } = await persistTurn(memoryManager, turn({
        sessionId: '  openclaw:dkg-ui ',
        turnId: '  turn-1 ',
        persistenceState: 'failed',
        failureReason: '  provider timed out ',
        toolCalls,
      }));

      expect(statusCode).toBe(200);
      expect(owner).toHaveBeenCalledTimes(1);
      const [args] = owner.mock.calls[0];
      expect(args.memoryManager).toBe(memoryManager);
      expect(args.payload).toStrictEqual({
        sessionId: '  openclaw:dkg-ui ',
        turnId: 'turn-1',
        userMessage: 'hello',
        assistantReply: 'hi there',
        persistenceState: 'failed',
        failureReason: 'provider timed out',
        toolCalls,
        attachmentRefs: undefined,
      });
      expect(args.afterStored).toBeUndefined();
    });

    it('forwards provenance-verified attachment refs, not the ones that were sent', async () => {
      const memoryManager = makeDurableChatTurnStore();
      const extractionStatus = new Map([[attachment.assertionUri, extractionRecord()]]);
      // Verification fills in `extractionStatus: 'completed'` from the extraction record.
      const { extractionStatus: _omitted, ...sentRef } = attachment;

      const { statusCode } = await persistTurn(memoryManager, turn({ attachmentRefs: [sentRef] }), { extractionStatus });

      expect(statusCode).toBe(200);
      expect(owner.mock.calls[0][0].payload.attachmentRefs).toEqual([attachment]);
      expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
        'openclaw:dkg-ui',
        'hello',
        'hi there',
        undefined,
        expect.objectContaining({ attachmentRefs: [attachment] }),
      );
    });

    it('forwards a generated turn id, and answers with it so the caller can retry idempotently', async () => {
      const memoryManager = makeDurableChatTurnStore();
      const { turnId: _omitted, ...withoutTurnId } = turn();

      const first = await persistTurn(memoryManager, withoutTurnId);
      const second = await persistTurn(memoryManager, withoutTurnId);
      const resend = await persistTurn(memoryManager, turn({ turnId: first.body.turnId }));

      expect(first.body).toEqual({ ok: true, turnId: expect.stringMatching(UUID_RE) });
      expect(second.body).toEqual({ ok: true, turnId: expect.stringMatching(UUID_RE) });
      expect(second.body.turnId).not.toBe(first.body.turnId);
      expect(owner.mock.calls.slice(0, 2).map(([args]) => args.payload.turnId))
        .toEqual([first.body.turnId, second.body.turnId]);
      expect(resend.body).toEqual({ ok: true, duplicate: true, turnId: first.body.turnId });
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(2);
    });

    it('takes a padded turn id as the trimmed id the store and the state read use', async () => {
      const memoryManager = makeDurableChatTurnStore();

      const first = await persistTurn(memoryManager, turn({ turnId: '  turn-padded ' }));
      const resend = await persistTurn(memoryManager, turn({ turnId: 'turn-padded' }));

      expect(first.body).toEqual({ ok: true, turnId: 'turn-padded' });
      expect(resend.body).toEqual({ ok: true, duplicate: true, turnId: 'turn-padded' });
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
      expect(memoryManager.storeChatExchange.mock.calls[0][4]?.turnId).toBe('turn-padded');
      expect(memoryManager.states.get(turnStateKey('openclaw:dkg-ui', 'turn-padded'))).toBe('stored');
    });
  });

  describe('attachment provenance', () => {
    it('answers 400 and never reaches persistence when provenance verification fails', async () => {
      const memoryManager = makeDurableChatTurnStore();

      // No extraction record and no `_meta` row for the ref.
      const { statusCode, raw } = await persistTurn(memoryManager, turn({ attachmentRefs: [attachment] }));

      expect(statusCode).toBe(400);
      expect(raw).toBe('{"error":"Invalid \\"attachmentRefs\\""}');
      expect(owner).not.toHaveBeenCalled();
      expect(memoryManager.getChatTurnPersistenceState).not.toHaveBeenCalled();
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    });

    it('answers the missing-fields 400 and never reaches persistence for a malformed ref', async () => {
      const memoryManager = makeDurableChatTurnStore();

      const { statusCode, body } = await persistTurn(
        memoryManager,
        turn({ attachmentRefs: [{ assertionUri: attachment.assertionUri }] }),
      );

      expect(statusCode).toBe(400);
      expect(body).toEqual({ error: MISSING_FIELDS });
      expect(owner).not.toHaveBeenCalled();
      expect(memoryManager.getChatTurnPersistenceState).not.toHaveBeenCalled();
    });

    it('leaves a failing provenance lookup to the daemon-wide error handler instead of the persist 500', async () => {
      const memoryManager = makeDurableChatTurnStore();
      const agent = { store: { query: vi.fn(async () => { throw new Error('query down'); }) } };

      await expect(persistTurn(memoryManager, turn({ attachmentRefs: [attachment] }), { agent }))
        .rejects.toThrow('query down');
      expect(owner).not.toHaveBeenCalled();
    });
  });

  describe('outcome to response', () => {
    it.each([
      { kind: 'created', raw: '{"ok":true,"turnId":"turn-1"}' },
      { kind: 'duplicate', raw: '{"ok":true,"duplicate":true,"turnId":"turn-1"}' },
      { kind: 'transitioned', raw: '{"ok":true,"transitioned":true,"turnId":"turn-1"}' },
    ] as const)('answers 200 $raw for a $kind outcome', async ({ kind, raw }) => {
      owner.mockResolvedValueOnce({ kind, sessionId: 'openclaw:dkg-ui', turnId: 'turn-1' });

      const response = await persistTurn(makeDurableChatTurnStore(), turn());

      expect(response.statusCode).toBe(200);
      expect(response.raw).toBe(raw);
    });

    it('answers 500 with the error message when persistence fails', async () => {
      owner.mockRejectedValueOnce(new Error('write failed'));

      const response = await persistTurn(makeDurableChatTurnStore(), turn());

      expect(response.statusCode).toBe(500);
      expect(response.raw).toBe('{"error":"write failed"}');
    });
  });

  describe('delegation to the shared owner', () => {
    it('answers a resend as a duplicate and writes the exchange once', async () => {
      const memoryManager = makeDurableChatTurnStore();

      const first = await persistTurn(memoryManager, turn());
      const resend = await persistTurn(memoryManager, turn());

      expect(first.body).toEqual({ ok: true, turnId: 'turn-1' });
      expect(resend).toMatchObject({ statusCode: 200, body: { ok: true, duplicate: true, turnId: 'turn-1' } });
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    });
  });
});

// -- The persistence helper -------------------------------------------------------------

describe('persistOpenClawTurn', () => {
  const payload = {
    sessionId: 'openclaw:dkg-ui',
    turnId: 'turn-1',
    userMessage: 'hello',
    assistantReply: 'hi there',
    persistenceState: 'stored' as const,
  };

  it('persists the verified refs in place of the ones the payload carries', async () => {
    const memoryManager = makeDurableChatTurnStore();

    const result = await persistOpenClawTurn(memoryManager, { ...payload, attachmentRefs: [{ ...attachment, fileName: 'unverified.pdf' }] }, [attachment]);

    expect(result).toEqual({ statusCode: 200, body: { ok: true, turnId: 'turn-1' } });
    expect(memoryManager.storeChatExchange.mock.calls[0][4]?.attachmentRefs).toEqual([attachment]);
  });

  it('persists no refs when verification produced none', async () => {
    const memoryManager = makeDurableChatTurnStore();

    await persistOpenClawTurn(memoryManager, { ...payload, attachmentRefs: [attachment] }, undefined);

    expect(memoryManager.storeChatExchange.mock.calls[0][4]?.attachmentRefs).toBeUndefined();
  });
});
