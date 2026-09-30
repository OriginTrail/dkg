/**
 * `persistDurableChatTurn`: the daemon-wide owner of durable local-agent turn
 * idempotency, tested once, directly.
 *
 * Hermes, Prime Agent and OpenClaw all hand their turns to this function, so
 * the created / duplicate / transition ranking, the per-`(sessionId, turnId)`
 * lock and the failure paths are specified here and nowhere else. The channel
 * suites (`daemon-hermes`, `daemon-prime-agent-persistence`,
 * `daemon-openclaw-persistence`) cover only what belongs to their adapter:
 * parsing and validation, attachment provenance, the payload they forward, and
 * how an outcome becomes their HTTP response. The real-store and devnet tiers
 * (`openclaw-persist-turn.e2e.test.ts`, `devnet/openclaw-persist-turn`) prove
 * the same behavior end to end.
 *
 * The in-flight map behind the lock is module-level, so every test uses its own
 * `(sessionId, turnId)`.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  persistDurableChatTurn,
  type ChatTurnPersistenceState,
  type DurableChatTurnOutcome,
  type DurableChatTurnPayload,
} from '../src/daemon/chat-turn-persistence.js';
import {
  makeDurableChatTurnStore,
  turnStateKey,
  type DurableChatTurnStoreDouble,
} from './_helpers/durable-chat-turn-store.js';

type State = ChatTurnPersistenceState;
type Kind = DurableChatTurnOutcome['kind'];
type TurnKey = { sessionId: string; turnId: string };

let sequence = 0;
function freshKey(): TurnKey {
  sequence += 1;
  return { sessionId: `session-${sequence}`, turnId: `turn-${sequence}` };
}

function turnPayload(key: TurnKey, overrides: Partial<DurableChatTurnPayload> = {}): DurableChatTurnPayload {
  return {
    ...key,
    userMessage: 'hello',
    assistantReply: 'hi there',
    persistenceState: 'stored',
    ...overrides,
  };
}

function persist(
  store: DurableChatTurnStoreDouble,
  payload: DurableChatTurnPayload,
  afterStored?: () => Promise<void>,
) {
  return persistDurableChatTurn({ memoryManager: store, payload, afterStored });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Let every promise that can make progress without a gate opening do so. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

/** Hold the next write of `method` on a gate; resolves `started` once the write is in progress. */
function holdNext(
  store: DurableChatTurnStoreDouble,
  method: 'storeChatExchange' | 'recordChatTurnPersistenceTransition' | 'getChatTurnPersistenceState',
) {
  const gate = deferred();
  const started = deferred();
  const original = store[method].getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
  (store[method] as ReturnType<typeof vi.fn>).mockImplementationOnce(async (...args: unknown[]) => {
    started.resolve();
    await gate.promise;
    return original(...args);
  });
  return { release: gate.resolve, started: started.promise };
}

// -- The state machine ------------------------------------------------------------------

/**
 * Every (durable state, incoming report) pair. Ranking is pending < failed <
 * stored: a report only moves a turn up, an equal or lower one is a duplicate,
 * and a stored turn never changes. `hook` is whether `afterStored` runs.
 */
const MATRIX: ReadonlyArray<{
  existing: State | null;
  incoming: State;
  outcome: Kind;
  finalState: State;
  hook: boolean;
}> = [
  { existing: null, incoming: 'pending', outcome: 'created', finalState: 'pending', hook: false },
  { existing: null, incoming: 'failed', outcome: 'created', finalState: 'failed', hook: false },
  { existing: null, incoming: 'stored', outcome: 'created', finalState: 'stored', hook: true },
  { existing: 'pending', incoming: 'pending', outcome: 'duplicate', finalState: 'pending', hook: false },
  { existing: 'pending', incoming: 'failed', outcome: 'transitioned', finalState: 'failed', hook: false },
  { existing: 'pending', incoming: 'stored', outcome: 'transitioned', finalState: 'stored', hook: true },
  { existing: 'failed', incoming: 'pending', outcome: 'duplicate', finalState: 'failed', hook: false },
  { existing: 'failed', incoming: 'failed', outcome: 'duplicate', finalState: 'failed', hook: false },
  { existing: 'failed', incoming: 'stored', outcome: 'transitioned', finalState: 'stored', hook: true },
  { existing: 'stored', incoming: 'pending', outcome: 'duplicate', finalState: 'stored', hook: false },
  { existing: 'stored', incoming: 'failed', outcome: 'duplicate', finalState: 'stored', hook: false },
  { existing: 'stored', incoming: 'stored', outcome: 'duplicate', finalState: 'stored', hook: false },
];

describe('persistDurableChatTurn outcome by durable state and incoming state', () => {
  it('has a row for every pair of durable state (none, pending, failed, stored) and report state', () => {
    const pairs = MATRIX.map((row) => `${row.existing}>${row.incoming}`);
    expect(new Set(pairs).size).toBe(4 * 3);
    expect(pairs).toHaveLength(4 * 3);
  });

  it.each(MATRIX)(
    '$existing durable state + $incoming report: $outcome (afterStored: $hook)',
    async ({ existing, incoming, outcome, finalState, hook }) => {
      const store = makeDurableChatTurnStore();
      const key = freshKey();
      if (existing) store.seed(key.sessionId, key.turnId, existing);
      const afterStored = vi.fn(async () => {});

      const result = await persist(store, turnPayload(key, { persistenceState: incoming }), afterStored);

      expect(result).toEqual({ kind: outcome, ...key });
      expect(store.getChatTurnPersistenceState).toHaveBeenCalledExactlyOnceWith(key.sessionId, key.turnId);
      expect(store.storeChatExchange).toHaveBeenCalledTimes(outcome === 'created' ? 1 : 0);
      expect(store.recordChatTurnPersistenceTransition).toHaveBeenCalledTimes(outcome === 'transitioned' ? 1 : 0);
      expect(store.states.get(turnStateKey(key.sessionId, key.turnId))).toBe(finalState);
      expect(afterStored).toHaveBeenCalledTimes(hook ? 1 : 0);
    },
  );

  // Every order in which the three states can be reported for one turn, one report at a time.
  it.each([
    { reports: ['pending', 'failed', 'stored'], outcomes: ['created', 'transitioned', 'transitioned'], final: 'stored' },
    { reports: ['pending', 'stored', 'failed'], outcomes: ['created', 'transitioned', 'duplicate'], final: 'stored' },
    { reports: ['failed', 'pending', 'stored'], outcomes: ['created', 'duplicate', 'transitioned'], final: 'stored' },
    { reports: ['failed', 'stored', 'pending'], outcomes: ['created', 'transitioned', 'duplicate'], final: 'stored' },
    { reports: ['stored', 'pending', 'failed'], outcomes: ['created', 'duplicate', 'duplicate'], final: 'stored' },
    { reports: ['stored', 'failed', 'pending'], outcomes: ['created', 'duplicate', 'duplicate'], final: 'stored' },
    { reports: ['pending', 'failed', 'pending'], outcomes: ['created', 'transitioned', 'duplicate'], final: 'failed' },
  ] as const)('reports $reports in order: $outcomes, ending $final', async ({ reports, outcomes, final }) => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();

    const kinds: Kind[] = [];
    for (const persistenceState of reports) {
      kinds.push((await persist(store, turnPayload(key, { persistenceState }))).kind);
    }

    expect(kinds).toEqual(outcomes);
    expect(store.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(store.recordChatTurnPersistenceTransition).toHaveBeenCalledTimes(
      outcomes.filter((kind) => kind === 'transitioned').length,
    );
    expect(store.states.get(turnStateKey(key.sessionId, key.turnId))).toBe(final);
  });

  it('treats a resend with different content as the same turn and writes nothing', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    await persist(store, turnPayload(key));

    const resend = await persist(store, turnPayload(key, { userMessage: 'another question', assistantReply: 'a different reply' }));

    expect(resend.kind).toBe('duplicate');
    expect(store.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(store.recordChatTurnPersistenceTransition).not.toHaveBeenCalled();
  });

  it('keys a turn by session and by turn id', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    await persist(store, turnPayload(key));

    const otherTurn = await persist(store, turnPayload({ ...key, turnId: `${key.turnId}-b` }));
    const otherSession = await persist(store, turnPayload({ ...key, sessionId: `${key.sessionId}-b` }));

    expect(otherTurn.kind).toBe('created');
    expect(otherSession.kind).toBe('created');
    expect(store.storeChatExchange).toHaveBeenCalledTimes(3);
  });
});

// -- What each outcome writes -----------------------------------------------------------

describe('persistDurableChatTurn writes', () => {
  const toolCalls = [{ name: 'search', args: { query: 'dkg' }, result: { hits: 1 } }];
  const attachmentRefs = [{
    assertionUri: 'did:dkg:context-graph:cg1/assertion/chat-doc',
    fileHash: 'sha256:abc123',
    contextGraphId: 'cg1',
    fileName: 'chat-doc.pdf',
  }];

  it('stores a new turn with the whole payload', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();

    await persist(store, turnPayload(key, {
      persistenceState: 'failed',
      failureReason: 'provider timed out',
      toolCalls,
      attachmentRefs,
    }));

    expect(store.storeChatExchange).toHaveBeenCalledExactlyOnceWith(
      key.sessionId,
      'hello',
      'hi there',
      toolCalls,
      {
        turnId: key.turnId,
        attachmentRefs,
        persistenceState: 'failed',
        failureReason: 'provider timed out',
      },
    );
  });

  it('stores a new turn without a failure reason as sent', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();

    await persist(store, turnPayload(key));

    expect(store.storeChatExchange).toHaveBeenCalledExactlyOnceWith(
      key.sessionId,
      'hello',
      'hi there',
      undefined,
      { turnId: key.turnId, attachmentRefs: undefined, persistenceState: 'stored', failureReason: undefined },
    );
  });

  it.each([
    { label: 'the reason', failureReason: 'recovered', recorded: 'recovered' },
    { label: 'null when there is none', failureReason: undefined, recorded: null },
  ])('records an upward transition with the new reply, tool calls, refs and $label', async ({ failureReason, recorded }) => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    store.seed(key.sessionId, key.turnId, 'pending');

    await persist(store, turnPayload(key, {
      assistantReply: 'completed reply',
      persistenceState: 'stored',
      failureReason,
      toolCalls,
      attachmentRefs,
    }));

    expect(store.recordChatTurnPersistenceTransition).toHaveBeenCalledExactlyOnceWith(
      key.sessionId,
      key.turnId,
      'stored',
      { failureReason: recorded, assistantReply: 'completed reply', toolCalls, attachmentRefs },
    );
    expect(store.storeChatExchange).not.toHaveBeenCalled();
  });
});

// -- afterStored ------------------------------------------------------------------------

describe('persistDurableChatTurn afterStored hook', () => {
  it('runs once after the write when a stored turn is created', async () => {
    const store = makeDurableChatTurnStore();
    const events: string[] = [];
    const original = store.storeChatExchange.getMockImplementation()!;
    store.storeChatExchange.mockImplementation(async (...args) => {
      await original(...args);
      events.push('write');
    });

    await persist(store, turnPayload(freshKey()), async () => { events.push('hook'); });

    expect(events).toEqual(['write', 'hook']);
  });

  it('runs once after the transition write when a turn becomes stored', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    store.seed(key.sessionId, key.turnId, 'failed');
    const events: string[] = [];
    const original = store.recordChatTurnPersistenceTransition.getMockImplementation()!;
    store.recordChatTurnPersistenceTransition.mockImplementation(async (...args) => {
      await original(...args);
      events.push('transition');
    });

    await persist(store, turnPayload(key), async () => { events.push('hook'); });

    expect(events).toEqual(['transition', 'hook']);
  });

  it('rejects with the hook error once the turn is already stored, and the retry is a duplicate', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    const failure = new Error('import failed');

    await expect(persist(store, turnPayload(key), async () => { throw failure; })).rejects.toBe(failure);
    const retry = await persist(store, turnPayload(key));

    expect(store.states.get(turnStateKey(key.sessionId, key.turnId))).toBe('stored');
    expect(retry.kind).toBe('duplicate');
    expect(store.storeChatExchange).toHaveBeenCalledTimes(1);
  });

  it('keeps the turn key held until it settles', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    const hookGate = deferred();
    const hookStarted = deferred();

    const first = persist(store, turnPayload(key), async () => {
      hookStarted.resolve();
      await hookGate.promise;
    });
    await hookStarted.promise;
    const second = persist(store, turnPayload(key));
    await settle();

    expect(store.getChatTurnPersistenceState).toHaveBeenCalledTimes(1);
    hookGate.resolve();
    expect((await first).kind).toBe('created');
    expect((await second).kind).toBe('duplicate');
    expect(store.getChatTurnPersistenceState).toHaveBeenCalledTimes(2);
  });
});

// -- Failure paths ----------------------------------------------------------------------

describe('persistDurableChatTurn failure paths', () => {
  it('stores the turn anyway when the state read fails', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    store.getChatTurnPersistenceState.mockRejectedValueOnce(new Error('store busy'));

    const result = await persist(store, turnPayload(key));

    expect(result).toEqual({ kind: 'created', ...key });
    expect(store.storeChatExchange).toHaveBeenCalledTimes(1);
  });

  it('rejects unchanged when the write fails, leaves no state and lets a retry write again', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    const failure = new Error('write failed');
    store.storeChatExchange.mockRejectedValueOnce(failure);
    const afterStored = vi.fn(async () => {});

    await expect(persist(store, turnPayload(key), afterStored)).rejects.toBe(failure);
    expect(store.states.has(turnStateKey(key.sessionId, key.turnId))).toBe(false);
    expect(afterStored).not.toHaveBeenCalled();

    const retry = await persist(store, turnPayload(key), afterStored);
    expect(retry.kind).toBe('created');
    expect(store.storeChatExchange).toHaveBeenCalledTimes(2);
    expect(afterStored).toHaveBeenCalledTimes(1);
  });

  it('rejects unchanged when an upward transition fails, and a retry records it again', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    store.seed(key.sessionId, key.turnId, 'pending');
    const failure = new Error('transition failed');
    store.recordChatTurnPersistenceTransition.mockRejectedValueOnce(failure);
    const afterStored = vi.fn(async () => {});

    await expect(persist(store, turnPayload(key), afterStored)).rejects.toBe(failure);
    expect(store.storeChatExchange).not.toHaveBeenCalled();
    expect(afterStored).not.toHaveBeenCalled();
    expect(store.states.get(turnStateKey(key.sessionId, key.turnId))).toBe('pending');

    const retry = await persist(store, turnPayload(key));
    expect(retry.kind).toBe('transitioned');
    expect(store.recordChatTurnPersistenceTransition).toHaveBeenCalledTimes(2);
  });

  it('runs the reports queued behind a failed one, each re-reading the durable state', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    const failure = new Error('write failed');
    const writeGate = deferred();
    const writeStarted = deferred();
    store.storeChatExchange.mockImplementationOnce(async () => {
      writeStarted.resolve();
      await writeGate.promise;
      throw failure;
    });

    const first = persist(store, turnPayload(key)).catch((error: unknown) => error);
    await writeStarted.promise;
    const second = persist(store, turnPayload(key));
    const third = persist(store, turnPayload(key));
    await settle();
    writeGate.resolve();
    const results = await Promise.all([first, second, third]);

    expect(results[0]).toBe(failure);
    expect((results[1] as DurableChatTurnOutcome).kind).toBe('created');
    expect((results[2] as DurableChatTurnOutcome).kind).toBe('duplicate');
    expect(store.getChatTurnPersistenceState).toHaveBeenCalledTimes(3);
    expect(store.storeChatExchange).toHaveBeenCalledTimes(2);
  });
});

// -- Serialization ----------------------------------------------------------------------

/** Wrap every store method so a test can see how many are running at once. */
function trackOverlap(store: DurableChatTurnStoreDouble) {
  const tracker = { running: 0, peak: 0 };
  for (const method of ['getChatTurnPersistenceState', 'storeChatExchange', 'recordChatTurnPersistenceTransition'] as const) {
    const original = store[method].getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    (store[method] as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => {
      tracker.running += 1;
      tracker.peak = Math.max(tracker.peak, tracker.running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await original(...args);
      } finally {
        tracker.running -= 1;
      }
    });
  }
  return tracker;
}

describe('persistDurableChatTurn per-(sessionId, turnId) serialization', () => {
  it('runs concurrent reports for one turn one at a time: one created, the rest duplicates', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    const overlap = trackOverlap(store);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => persist(store, turnPayload(key))),
    );

    expect(results.filter((result) => result.kind === 'created')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'duplicate')).toHaveLength(5);
    expect(store.storeChatExchange).toHaveBeenCalledTimes(1);
    expect(store.getChatTurnPersistenceState).toHaveBeenCalledTimes(6);
    expect(overlap.peak).toBe(1);
  });

  it('lets a queued report read the state only after the report ahead of it has written', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    const held = holdNext(store, 'storeChatExchange');

    const first = persist(store, turnPayload(key));
    await held.started;
    const second = persist(store, turnPayload(key));
    const third = persist(store, turnPayload(key));
    await settle();

    expect(store.getChatTurnPersistenceState).toHaveBeenCalledTimes(1);
    expect(store.storeChatExchange).toHaveBeenCalledTimes(1);
    held.release();
    expect((await Promise.all([first, second, third])).map((result) => result.kind))
      .toEqual(['created', 'duplicate', 'duplicate']);
    expect(store.getChatTurnPersistenceState).toHaveBeenCalledTimes(3);
  });

  it('runs concurrent reports in arrival order, so a later state never overtakes an earlier one', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();

    const results = await Promise.all((['pending', 'failed', 'stored'] as const).map(
      (persistenceState) => persist(store, turnPayload(key, { persistenceState })),
    ));

    expect(results.map((result) => result.kind)).toEqual(['created', 'transitioned', 'transitioned']);
    expect(store.states.get(turnStateKey(key.sessionId, key.turnId))).toBe('stored');
  });

  it('holds a report that arrives after the first settled for the second one still running', async () => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    const firstWrite = holdNext(store, 'storeChatExchange');

    const first = persist(store, turnPayload(key));
    await firstWrite.started;
    const second = persist(store, turnPayload(key));
    // The second report's state read is the store's second call: hold it, so it stays in flight.
    const secondRead = holdNext(store, 'getChatTurnPersistenceState');
    firstWrite.release();
    await first;
    await secondRead.started;

    const third = persist(store, turnPayload(key));
    await settle();
    // The first report has settled, the second is still running, and the third has not started.
    expect(store.getChatTurnPersistenceState).toHaveBeenCalledTimes(2);

    secondRead.release();
    expect((await second).kind).toBe('duplicate');
    expect((await third).kind).toBe('duplicate');
    expect(store.getChatTurnPersistenceState).toHaveBeenCalledTimes(3);
  });

  it.each([
    { label: 'another turn of the same session', other: (key: TurnKey): TurnKey => ({ ...key, turnId: `${key.turnId}-other` }) },
    { label: 'the same turn id in another session', other: (key: TurnKey): TurnKey => ({ ...key, sessionId: `${key.sessionId}-other` }) },
    { label: 'another session and turn', other: (): TurnKey => freshKey() },
  ])('does not make $label wait for a turn whose write is held', async ({ other }) => {
    const store = makeDurableChatTurnStore();
    const key = freshKey();
    const held = holdNext(store, 'storeChatExchange');

    const slow = persist(store, turnPayload(key));
    await held.started;
    const fast = await persist(store, turnPayload(other(key)));

    expect(fast.kind).toBe('created');
    held.release();
    expect((await slow).kind).toBe('created');
    expect(store.storeChatExchange).toHaveBeenCalledTimes(2);
  });

  it('runs reports for different turns in parallel', async () => {
    const store = makeDurableChatTurnStore();
    const overlap = trackOverlap(store);

    await Promise.all(Array.from({ length: 4 }, () => persist(store, turnPayload(freshKey()))));

    expect(overlap.peak).toBeGreaterThan(1);
  });
});
