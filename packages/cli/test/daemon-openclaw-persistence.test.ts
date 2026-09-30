/**
 * `POST /api/openclaw-channel/persist-turn` durable-turn idempotency.
 *
 * The route hands every turn to the daemon-wide `persistDurableChatTurn`
 * owner, the same one Hermes and Prime Agent use, so a resent
 * `(sessionId, turnId)` is suppressed, an upward `persistenceState` change is
 * recorded as a transition, and only a genuinely new turn reaches
 * `storeChatExchange`.
 *
 * Every memory manager here answers `getChatTurnPersistenceState` for real.
 * The mocks in `daemon-openclaw.part-*.test.ts` do not: `persistDurableChatTurn`
 * treats a failing state read as "unknown" and stores anyway, so those mocks
 * would pass with or without the dedupe and cannot detect its absence.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type { DkgConfig } from '../src/config.js';
import { handleOpenclawRoutes } from '../src/daemon/routes/openclaw.js';

const PERSIST_TURN_PATH = '/api/openclaw-channel/persist-turn';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PersistenceState = 'stored' | 'failed' | 'pending';

function makeJsonRequest(method: string, path: string, payload: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)));
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

/**
 * A memory manager that remembers what it was asked to store, keyed by
 * `(sessionId, turnId)` the way `ChatMemoryManager` does, so a resend really
 * finds the earlier turn.
 */
function makeMemoryManager() {
  const states = new Map<string, PersistenceState>();
  const key = (sessionId: string, turnId: string) => `${sessionId}\n${turnId}`;
  const manager = {
    states,
    getChatTurnPersistenceState: vi.fn(async (sessionId: string, turnId: string) =>
      states.get(key(sessionId, turnId.trim())) ?? null),
    storeChatExchange: vi.fn(async (
      sessionId: string,
      _userMessage: string,
      _assistantReply: string,
      _toolCalls: unknown,
      opts?: { turnId?: string; persistenceState?: PersistenceState },
    ) => {
      const turnId = opts?.turnId?.trim();
      if (turnId) states.set(key(sessionId, turnId), opts?.persistenceState ?? 'stored');
    }),
    recordChatTurnPersistenceTransition: vi.fn(async (
      sessionId: string,
      turnId: string,
      state: PersistenceState,
    ) => {
      states.set(key(sessionId, turnId.trim()), state);
    }),
  };
  return manager;
}

type TestMemoryManager = ReturnType<typeof makeMemoryManager>;

async function persistTurn(
  memoryManager: TestMemoryManager,
  payload: unknown,
  overrides: Record<string, unknown> = {},
) {
  const res = makeJsonResponse();
  await handleOpenclawRoutes({
    req: makeJsonRequest('POST', PERSIST_TURN_PATH, payload),
    res,
    agent: { store: { query: vi.fn(async () => ({ bindings: [] })) } },
    config: config(),
    memoryManager,
    bridgeAuthToken: 'bridge-token',
    extractionStatus: new Map(),
    path: PERSIST_TURN_PATH,
    ...overrides,
  } as any);
  return { statusCode: res.statusCode as number, body: JSON.parse(res.body) as any };
}

const turn = (overrides: Record<string, unknown> = {}) => ({
  sessionId: 'openclaw:dkg-ui',
  userMessage: 'hello',
  assistantReply: 'hi there',
  turnId: 'turn-1',
  ...overrides,
});

describe('POST /api/openclaw-channel/persist-turn idempotency', () => {
  it('stores a new turn once and reports its turn id', async () => {
    const memoryManager = makeMemoryManager();
    const toolCalls = [{ name: 'search', args: { query: 'dkg' }, result: { hits: 1 } }];

    const { statusCode, body } = await persistTurn(memoryManager, turn({ toolCalls }));

    expect(statusCode).toBe(200);
    expect(body).toEqual({ ok: true, turnId: 'turn-1' });
    expect(memoryManager.getChatTurnPersistenceState).toHaveBeenCalledWith('openclaw:dkg-ui', 'turn-1');
    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'hello',
      'hi there',
      toolCalls,
      {
        turnId: 'turn-1',
        attachmentRefs: undefined,
        persistenceState: 'stored',
        failureReason: undefined,
      },
    );
    expect(memoryManager.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
  });

  it('suppresses a sequential resend of the same (sessionId, turnId)', async () => {
    const memoryManager = makeMemoryManager();

    const first = await persistTurn(memoryManager, turn());
    const second = await persistTurn(memoryManager, turn());
    const third = await persistTurn(memoryManager, turn());

    expect(first.body).toEqual({ ok: true, turnId: 'turn-1' });
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual({ ok: true, duplicate: true, turnId: 'turn-1' });
    expect(third.body).toEqual({ ok: true, duplicate: true, turnId: 'turn-1' });
    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(memoryManager.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
  });

  it('treats a resend with different content as the same turn', async () => {
    const memoryManager = makeMemoryManager();

    await persistTurn(memoryManager, turn());
    const resend = await persistTurn(memoryManager, turn({ assistantReply: 'a different reply' }));

    expect(resend.body).toMatchObject({ ok: true, duplicate: true });
    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
  });

  it('keeps turns apart by session and by turn id', async () => {
    const memoryManager = makeMemoryManager();

    await persistTurn(memoryManager, turn());
    const otherTurn = await persistTurn(memoryManager, turn({ turnId: 'turn-2' }));
    const otherSession = await persistTurn(memoryManager, turn({ sessionId: 'openclaw:dkg-ui:worker' }));

    expect(otherTurn.body).toEqual({ ok: true, turnId: 'turn-2' });
    expect(otherSession.body).toEqual({ ok: true, turnId: 'turn-1' });
    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(3);
  });

  it.each(['pending', 'failed'] as const)(
    'transitions an existing %s turn to stored without appending another exchange',
    async (existingState) => {
      const memoryManager = makeMemoryManager();
      memoryManager.states.set('openclaw:dkg-ui\nturn-1', existingState);
      const toolCalls = [{ name: 'search', args: { query: 'dkg' }, result: { hits: 1 } }];

      const { statusCode, body } = await persistTurn(memoryManager, turn({
        assistantReply: 'completed reply',
        persistenceState: 'stored',
        failureReason: '  recovered  ',
        toolCalls,
      }));

      expect(statusCode).toBe(200);
      expect(body).toEqual({ ok: true, transitioned: true, turnId: 'turn-1' });
      expect(memoryManager.recordChatTurnPersistenceTransition).toHaveBeenCalledTimes(1);
      expect(memoryManager.recordChatTurnPersistenceTransition).toHaveBeenCalledWith(
        'openclaw:dkg-ui',
        'turn-1',
        'stored',
        {
          failureReason: 'recovered',
          assistantReply: 'completed reply',
          toolCalls,
          attachmentRefs: undefined,
        },
      );
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
      expect(memoryManager.states.get('openclaw:dkg-ui\nturn-1')).toBe('stored');
    },
  );

  it('upgrades a pending turn to stored once and then treats the resend as a duplicate', async () => {
    const memoryManager = makeMemoryManager();

    const pending = await persistTurn(memoryManager, turn({ persistenceState: 'pending' }));
    const stored = await persistTurn(memoryManager, turn({ persistenceState: 'stored' }));
    const resend = await persistTurn(memoryManager, turn({ persistenceState: 'stored' }));

    expect(pending.body).toEqual({ ok: true, turnId: 'turn-1' });
    expect(stored.body).toEqual({ ok: true, transitioned: true, turnId: 'turn-1' });
    expect(resend.body).toEqual({ ok: true, duplicate: true, turnId: 'turn-1' });
    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(memoryManager.recordChatTurnPersistenceTransition).toHaveBeenCalledTimes(1);
  });

  it.each([
    { existing: 'failed', incoming: 'failed' },
    { existing: 'failed', incoming: 'pending' },
    { existing: 'pending', incoming: 'pending' },
    { existing: 'stored', incoming: 'stored' },
    { existing: 'stored', incoming: 'failed' },
    { existing: 'stored', incoming: 'pending' },
  ] as const)(
    'keeps a $incoming report a duplicate when the durable state is $existing',
    async ({ existing, incoming }) => {
      const memoryManager = makeMemoryManager();
      memoryManager.states.set('openclaw:dkg-ui\nturn-1', existing);

      const { body } = await persistTurn(memoryManager, turn({
        persistenceState: incoming,
        failureReason: incoming === 'failed' ? 'late failure' : undefined,
      }));

      expect(body).toEqual({ ok: true, duplicate: true, turnId: 'turn-1' });
      expect(memoryManager.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
      expect(memoryManager.states.get('openclaw:dkg-ui\nturn-1')).toBe(existing);
    },
  );

  it('forwards the failed state and its reason on a new failed turn', async () => {
    const memoryManager = makeMemoryManager();

    const { body } = await persistTurn(memoryManager, turn({
      persistenceState: 'failed',
      failureReason: '  provider timed out ',
    }));

    expect(body).toEqual({ ok: true, turnId: 'turn-1' });
    expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
      'openclaw:dkg-ui',
      'hello',
      'hi there',
      undefined,
      expect.objectContaining({
        turnId: 'turn-1',
        persistenceState: 'failed',
        failureReason: 'provider timed out',
      }),
    );
  });

  it('serializes concurrent reports for the same turn', async () => {
    const memoryManager = makeMemoryManager();
    let releaseStore!: () => void;
    let markStoreStarted!: () => void;
    const storeGate = new Promise<void>((resolve) => { releaseStore = resolve; });
    const storeStarted = new Promise<void>((resolve) => { markStoreStarted = resolve; });
    const record = memoryManager.storeChatExchange.getMockImplementation()!;
    memoryManager.storeChatExchange.mockImplementation(async (...args: Parameters<typeof record>) => {
      markStoreStarted();
      await storeGate;
      await record(...args);
    });

    const first = persistTurn(memoryManager, turn({ turnId: 'turn-race' }));
    await storeStarted;
    const second = persistTurn(memoryManager, turn({ turnId: 'turn-race' }));
    const third = persistTurn(memoryManager, turn({ turnId: 'turn-race' }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The queued reports have not read the state yet: the first still holds the key.
    expect(memoryManager.getChatTurnPersistenceState).toHaveBeenCalledTimes(1);
    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    releaseStore();
    const results = await Promise.all([first, second, third]);

    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(memoryManager.getChatTurnPersistenceState).toHaveBeenCalledTimes(3);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200, 200]);
    expect(results.filter((result) => result.body.duplicate === true)).toHaveLength(2);
    expect(results.filter((result) => result.body.duplicate === undefined)).toHaveLength(1);
  });

  it('does not serialize unrelated turns behind one another', async () => {
    const memoryManager = makeMemoryManager();
    let releaseStore!: () => void;
    let markStoreStarted!: () => void;
    const storeGate = new Promise<void>((resolve) => { releaseStore = resolve; });
    const storeStarted = new Promise<void>((resolve) => { markStoreStarted = resolve; });
    memoryManager.storeChatExchange.mockImplementationOnce(async () => {
      markStoreStarted();
      await storeGate;
    });

    const slow = persistTurn(memoryManager, turn({ turnId: 'turn-slow' }));
    await storeStarted;
    const fast = await persistTurn(memoryManager, turn({ turnId: 'turn-fast' }));

    expect(fast.body).toEqual({ ok: true, turnId: 'turn-fast' });
    releaseStore();
    await slow;
    expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(2);
  });

  describe('turn id fallback', () => {
    it('mints a fresh turn id for every POST without one, so each still writes', async () => {
      const memoryManager = makeMemoryManager();
      const { turnId: _omitted, ...withoutTurnId } = turn();

      const first = await persistTurn(memoryManager, withoutTurnId);
      const second = await persistTurn(memoryManager, withoutTurnId);

      expect(first.statusCode).toBe(200);
      expect(first.body).toMatchObject({ ok: true, turnId: expect.stringMatching(UUID_RE) });
      expect(second.body).toMatchObject({ ok: true, turnId: expect.stringMatching(UUID_RE) });
      expect(second.body.turnId).not.toBe(first.body.turnId);
      expect(second.body.duplicate).toBeUndefined();
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(2);
      expect(memoryManager.storeChatExchange.mock.calls.map((call) => call[4]?.turnId))
        .toEqual([first.body.turnId, second.body.turnId]);
    });

    it('lets a caller dedupe a fallback-id turn by resending with the id it was given', async () => {
      const memoryManager = makeMemoryManager();
      const { turnId: _omitted, ...withoutTurnId } = turn();

      const first = await persistTurn(memoryManager, withoutTurnId);
      const resend = await persistTurn(memoryManager, turn({ turnId: first.body.turnId }));

      expect(resend.body).toEqual({ ok: true, duplicate: true, turnId: first.body.turnId });
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    });

    it.each(['', '   ', null, 42])('treats a blank or non-string turn id (%j) as omitted', async (rawTurnId) => {
      const memoryManager = makeMemoryManager();

      const { statusCode, body } = await persistTurn(memoryManager, turn({ turnId: rawTurnId }));

      expect(statusCode).toBe(200);
      expect(body.turnId).toMatch(UUID_RE);
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
      expect(memoryManager.storeChatExchange.mock.calls[0][4]?.turnId).toBe(body.turnId);
    });

    it('takes a padded turn id as the trimmed id the store and the state read use', async () => {
      const memoryManager = makeMemoryManager();

      const first = await persistTurn(memoryManager, turn({ turnId: '  turn-padded ' }));
      const resend = await persistTurn(memoryManager, turn({ turnId: 'turn-padded' }));

      expect(first.body).toEqual({ ok: true, turnId: 'turn-padded' });
      expect(resend.body).toEqual({ ok: true, duplicate: true, turnId: 'turn-padded' });
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
      expect(memoryManager.storeChatExchange.mock.calls[0][4]?.turnId).toBe('turn-padded');
    });
  });

  describe('attachment refs', () => {
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

    it('persists provenance-verified refs with the new turn', async () => {
      const memoryManager = makeMemoryManager();
      const extractionStatus = new Map([[attachment.assertionUri, extractionRecord()]]);

      const { statusCode, body } = await persistTurn(
        memoryManager,
        turn({ attachmentRefs: [attachment] }),
        { extractionStatus },
      );

      expect(statusCode).toBe(200);
      expect(body).toEqual({ ok: true, turnId: 'turn-1' });
      expect(memoryManager.storeChatExchange).toHaveBeenCalledWith(
        'openclaw:dkg-ui',
        'hello',
        'hi there',
        undefined,
        expect.objectContaining({ attachmentRefs: [attachment] }),
      );
    });

    it('carries verified refs into an upward transition', async () => {
      const memoryManager = makeMemoryManager();
      memoryManager.states.set('openclaw:dkg-ui\nturn-1', 'pending');
      const extractionStatus = new Map([[attachment.assertionUri, extractionRecord()]]);

      const { body } = await persistTurn(
        memoryManager,
        turn({ attachmentRefs: [attachment] }),
        { extractionStatus },
      );

      expect(body).toEqual({ ok: true, transitioned: true, turnId: 'turn-1' });
      expect(memoryManager.recordChatTurnPersistenceTransition).toHaveBeenCalledWith(
        'openclaw:dkg-ui',
        'turn-1',
        'stored',
        expect.objectContaining({ attachmentRefs: [attachment] }),
      );
    });

    it('answers 400 and never reaches persistence when provenance verification fails', async () => {
      const memoryManager = makeMemoryManager();

      // No extraction record and no `_meta` row for the ref.
      const { statusCode, body } = await persistTurn(memoryManager, turn({ attachmentRefs: [attachment] }));

      expect(statusCode).toBe(400);
      expect(body).toEqual({ error: 'Invalid "attachmentRefs"' });
      expect(memoryManager.getChatTurnPersistenceState).not.toHaveBeenCalled();
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
      expect(memoryManager.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
    });

    it('answers 400 and never reaches persistence for a malformed ref', async () => {
      const memoryManager = makeMemoryManager();

      const { statusCode } = await persistTurn(
        memoryManager,
        turn({ attachmentRefs: [{ assertionUri: attachment.assertionUri }] }),
      );

      expect(statusCode).toBe(400);
      expect(memoryManager.getChatTurnPersistenceState).not.toHaveBeenCalled();
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    });
  });

  describe('validation and failures', () => {
    it.each([
      { label: 'a missing sessionId', payload: { userMessage: 'hi', assistantReply: 'yo', turnId: 't' } },
      { label: 'a blank sessionId', payload: { sessionId: '  ', userMessage: 'hi', assistantReply: 'yo', turnId: 't' } },
      { label: 'a missing userMessage', payload: { sessionId: 's', assistantReply: 'yo', turnId: 't' } },
      { label: 'a missing assistantReply', payload: { sessionId: 's', userMessage: 'hi', turnId: 't' } },
      { label: 'an unknown persistenceState', payload: turn({ persistenceState: 'complete' }) },
      { label: 'a non-string failureReason', payload: turn({ failureReason: 7 }) },
    ])('answers 400 without touching persistence for $label', async ({ payload }) => {
      const memoryManager = makeMemoryManager();

      const { statusCode, body } = await persistTurn(memoryManager, payload);

      expect(statusCode).toBe(400);
      expect(body.error).toEqual(expect.any(String));
      expect(memoryManager.getChatTurnPersistenceState).not.toHaveBeenCalled();
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    });

    it('answers 400 for a body that is not JSON', async () => {
      const memoryManager = makeMemoryManager();
      const res = makeJsonResponse();
      const req = new EventEmitter() as any;
      req.method = 'POST';
      req.url = PERSIST_TURN_PATH;
      req.headers = {};
      setTimeout(() => {
        req.emit('data', Buffer.from('{not json'));
        req.emit('end');
      }, 0);

      await handleOpenclawRoutes({
        req,
        res,
        agent: {},
        config: config(),
        memoryManager,
        extractionStatus: new Map(),
        path: PERSIST_TURN_PATH,
      } as any);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' });
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    });

    it('answers 500 with the store error when the write fails, and lets a retry write again', async () => {
      const memoryManager = makeMemoryManager();
      memoryManager.storeChatExchange.mockRejectedValueOnce(new Error('write failed'));

      const failed = await persistTurn(memoryManager, turn());
      const retried = await persistTurn(memoryManager, turn());

      expect(failed.statusCode).toBe(500);
      expect(failed.body).toEqual({ error: 'write failed' });
      // The failed write left no durable state, so the retry is a genuinely new turn.
      expect(retried.statusCode).toBe(200);
      expect(retried.body).toEqual({ ok: true, turnId: 'turn-1' });
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(2);
    });

    it('answers 500 with the store error when an upward transition fails', async () => {
      const memoryManager = makeMemoryManager();
      memoryManager.states.set('openclaw:dkg-ui\nturn-1', 'pending');
      memoryManager.recordChatTurnPersistenceTransition.mockRejectedValueOnce(new Error('transition failed'));

      const { statusCode, body } = await persistTurn(memoryManager, turn());

      expect(statusCode).toBe(500);
      expect(body).toEqual({ error: 'transition failed' });
      expect(memoryManager.storeChatExchange).not.toHaveBeenCalled();
    });

    it('still stores the turn when the state lookup itself fails', async () => {
      const memoryManager = makeMemoryManager();
      memoryManager.getChatTurnPersistenceState.mockRejectedValueOnce(new Error('store busy'));

      const { statusCode, body } = await persistTurn(memoryManager, turn());

      expect(statusCode).toBe(200);
      expect(body).toEqual({ ok: true, turnId: 'turn-1' });
      expect(memoryManager.storeChatExchange).toHaveBeenCalledTimes(1);
    });
  });
});
