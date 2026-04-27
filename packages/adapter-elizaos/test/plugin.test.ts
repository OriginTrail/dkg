import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dkgPlugin,
  dkgPublish,
  dkgQuery,
  dkgFindAgents,
  dkgSendMessage,
  dkgInvokeSkill,
  dkgPersistChatTurn,
  dkgKnowledgeProvider,
  dkgService,
  __resetPersistedUserTurnCacheForTests,
} from '../src/index.js';

describe('dkgPlugin', () => {
  it('has name and description', () => {
    expect(dkgPlugin.name).toBe('dkg');
    expect(typeof dkgPlugin.description).toBe('string');
    expect(dkgPlugin.description.length).toBeGreaterThan(0);
  });

  it('exports 6 actions (incl. K-11 chat-persist)', () => {
    expect(dkgPlugin.actions).toHaveLength(6);
  });

  it('exports at least 1 provider', () => {
    expect(dkgPlugin.providers!.length).toBeGreaterThanOrEqual(1);
  });

  it('exports at least 1 service', () => {
    expect(dkgPlugin.services!.length).toBeGreaterThanOrEqual(1);
  });
});

describe('actions', () => {
  const actions = [dkgPublish, dkgQuery, dkgFindAgents, dkgSendMessage, dkgInvokeSkill, dkgPersistChatTurn];

  it.each(actions.map(a => [a.name, a]))('%s has name, description, similes, and handler', (_name, action) => {
    expect(typeof action.name).toBe('string');
    expect(action.name.length).toBeGreaterThan(0);
    expect(typeof action.description).toBe('string');
    expect(Array.isArray(action.similes)).toBe(true);
    expect(typeof action.handler).toBe('function');
  });

  it('action names are unique', () => {
    const names = actions.map(a => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('DKG_PUBLISH action has validate function', () => {
    expect(typeof dkgPublish.validate).toBe('function');
  });
});

describe('dkgKnowledgeProvider', () => {
  it('has a get method', () => {
    expect(typeof dkgKnowledgeProvider.get).toBe('function');
  });
});

describe('dkgService', () => {
  it('has a name', () => {
    expect(typeof dkgService.name).toBe('string');
    expect(dkgService.name.length).toBeGreaterThan(0);
  });
});

describe('dkgPlugin.hooks wiring', () => {
  it('exposes onChatTurn / onAssistantReply / chatPersistenceHook as functions that delegate to dkgService.persistChatTurn', async () => {
    const p = dkgPlugin as any;
    expect(typeof p.hooks.onChatTurn).toBe('function');
    expect(typeof p.hooks.onAssistantReply).toBe('function');
    expect(typeof p.chatPersistenceHook).toBe('function');

    // Invoking each hook without a live DKGAgent MUST surface the
    // "DKG node not started" error — confirming the hook actually
    // routes into dkgService.persistChatTurn rather than being a stub.
    const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
    const msg = { content: { text: 'hi' }, id: 'm', userId: 'u', roomId: 'r' } as any;

    for (const hook of [p.hooks.onChatTurn, p.hooks.onAssistantReply, p.chatPersistenceHook]) {
      await expect(hook(runtime, msg)).rejects.toThrow(/DKG node not started/);
    }
  });

  // PR #229 bot review (r3131820494, adapter-elizaos/src/index.ts:355).
  // The previous declaration `(...args: Parameters<typeof
  // dkgService.onChatTurn>) => …` collapsed the overloaded service
  // signature into the catch-all `Memory + Record<string, unknown>`
  // shape, so a downstream caller could omit `userMessageId` /
  // `userTurnPersisted` and only discover the violation at runtime.
  // We now declare an explicit overloaded callable
  // (`DkgChatTurnHook`) so the user-turn / assistant-reply split is
  // enforced at compile time. This test pins the contract by:
  //
  //   (a) validating that a well-formed assistant-reply call still
  //       compiles (positive path),
  //   (b) using `// @ts-expect-error` to assert that an
  //       assistant-reply call MISSING `userMessageId` is rejected
  //       at compile time (negative path).
  //
  // The negative branch is the failure mode the bot flagged: under
  // the pre-fix `Parameters<>`-derived signature the @ts-expect-error
  // marker would itself error ("unused @ts-expect-error directive"),
  // so this is a real regression guard, not a stylistic comment.
  it('PR #229 r3131820494: hook surface enforces the assistant-reply contract at compile time', async () => {
    type Hook = typeof dkgPlugin.hooks.onAssistantReply;
    const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
    const msg = { content: { text: 'hi' }, id: 'm', userId: 'u', roomId: 'r' } as any;

    // Positive path — a complete AssistantReplyChatTurnOptions
    // satisfies the typed surface. We don't actually invoke it here
    // because a real call would need a live DKGAgent; the test only
    // pins the SHAPE.
    const positive: Parameters<Hook> = [
      runtime,
      msg,
      undefined,
      { mode: 'assistant-reply', userMessageId: 'u-1' },
    ];
    expect(positive.length).toBe(4);

    // Negative path — `mode: 'assistant-reply'` without
    // `userMessageId` MUST be a compile-time error against the
    // typed overloads. If TypeScript ever stops rejecting this
    // (regression to `Parameters<typeof onChatTurn>` or similar),
    // the @ts-expect-error directive becomes unused and this test
    // fails to compile.
    // @ts-expect-error - assistant-reply without userMessageId is rejected
    const negative: Parameters<Hook> = [
      runtime,
      msg,
      undefined,
      { mode: 'assistant-reply' },
    ];
    expect(Array.isArray(negative)).toBe(true);
  });
});

// -----------------------------------------------------------------------
// PR #229 bot review round 14 — r14-2: onAssistantReply MUST plumb an
// explicit `userTurnPersisted` signal when the caller doesn't.
// -----------------------------------------------------------------------
describe('dkgPlugin.hooks.onAssistantReply — r14-2 userTurnPersisted plumbing', () => {
  beforeEach(() => {
    // r16-2: the plugin now consults an in-process cache of successful
    // onChatTurn writes. Reset between tests so r14-2 semantics (default
    // false absent explicit caller signal) remain observable in
    // isolation — the r16-2 suite below tests the cache-hit path.
    __resetPersistedUserTurnCacheForTests();
  });

  it('defaults userTurnPersisted to false when the caller does not set it', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const msg = { content: { text: 'hi' }, id: 'm', userId: 'u', roomId: 'r' } as any;

      await (dkgPlugin as any).hooks.onAssistantReply(runtime, msg, {}, {});
      expect(spy).toHaveBeenCalledTimes(1);
      const opts = spy.mock.calls[0][3] as any;
      expect(opts.mode).toBe('assistant-reply');
      // The key r14-2 invariant: the handler must set userTurnPersisted
      // explicitly so persistChatTurnImpl's legacy inference (presence of
      // userMessageId == "persisted") cannot be reached by accident.
      expect(opts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('defaults userTurnPersisted to false EVEN when userMessageId is inferred from message.replyTo', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const msg = {
        content: { text: 'hi' },
        id: 'm', userId: 'u', roomId: 'r',
        // Runtime provides the parent id — this is exactly the case the
        // bot flagged: under the old inference, persistChatTurnImpl
        // would see `userMessageId` present and take the append-only
        // branch even though the user turn was never persisted.
        replyTo: 'parent-123',
      } as any;

      await (dkgPlugin as any).hooks.onAssistantReply(runtime, msg, {}, {});
      expect(spy).toHaveBeenCalledTimes(1);
      const opts = spy.mock.calls[0][3] as any;
      expect(opts.userMessageId).toBe('parent-123');
      expect(opts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('honours an explicit userTurnPersisted:true from the caller (well-known chain opt-in)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const msg = { content: { text: 'hi' }, id: 'm', userId: 'u', roomId: 'r', replyTo: 'p' } as any;

      await (dkgPlugin as any).hooks.onAssistantReply(
        runtime, msg, {}, { userTurnPersisted: true },
      );
      const opts = spy.mock.calls[0][3] as any;
      // Caller opt-in wins — they know their hook chain ordered
      // onChatTurn before onAssistantReply in-process.
      expect(opts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('honours an explicit userTurnPersisted:false from the caller', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const msg = { content: { text: 'hi' }, id: 'm', userId: 'u', roomId: 'r', replyTo: 'p' } as any;

      await (dkgPlugin as any).hooks.onAssistantReply(
        runtime, msg, {}, { userTurnPersisted: false },
      );
      const opts = spy.mock.calls[0][3] as any;
      expect(opts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// -----------------------------------------------------------------------
// PR #229 bot review round 16 — r16-2: the plugin's own
// onChatTurn → onAssistantReply chain must take the APPEND-ONLY path
// (userTurnPersisted=true) when it knows onChatTurn just persisted the
// matching user message in this same process. r14-2's "default false"
// was correct FROM THE BOUNDARY (we can't trust unknown upstream hook
// wiring), but from the boundary of the plugin's own hook chain we
// DO know — because the plugin dispatched onChatTurn. r16-2 adds a
// small in-process cache so the plugin's own chain binds readers to
// the real user-message subject instead of a headless stub.
// -----------------------------------------------------------------------
describe('dkgPlugin.hooks — r16-2: onChatTurn → onAssistantReply in-process chain', () => {
  beforeEach(() => {
    __resetPersistedUserTurnCacheForTests();
  });

  it('after onChatTurn succeeds for (roomId, msgId), onAssistantReply for same replyTo takes the APPEND-ONLY path', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-1', userId: 'u', roomId: 'r42' } as any;
      const assistantMsg = {
        content: { text: 'reply' }, id: 'asst-1', userId: 'a', roomId: 'r42',
        replyTo: 'user-1',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, assistantMsg, {}, {});

      // First call = onChatTurn (user-turn path, no mode), second = reply.
      expect(spy).toHaveBeenCalledTimes(2);
      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.mode).toBe('assistant-reply');
      expect(replyOpts.userMessageId).toBe('user-1');
      // r16-2 key invariant: the cache hit flips the default to TRUE.
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn FAILURE does NOT populate the cache — reply falls through to safe headless branch', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any);
    // First call throws (simulates a failed onChatTurn write), second
    // call resolves (the assistant reply's own persist).
    spy.mockRejectedValueOnce(new Error('boom'))
       .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hi' }, id: 'user-fail', userId: 'u', roomId: 'rX' } as any;
      const assistantMsg = {
        content: { text: 'reply' }, id: 'asst-fail', userId: 'a', roomId: 'rX',
        replyTo: 'user-fail',
      } as any;

      await expect(
        (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {}),
      ).rejects.toThrow(/boom/);
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, assistantMsg, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      // Cache stayed clean → headless branch → the r15-2 collision
      // guard keeps the stub URI distinct from any real subject.
      expect(replyOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('reply in a DIFFERENT room (same msgId coincidence) falls through to headless — cache is (roomId, msgId)-keyed', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hi' }, id: 'shared-id', userId: 'u', roomId: 'room-A' } as any;
      const replyInOtherRoom = {
        content: { text: 'reply' }, id: 'a1', userId: 'a', roomId: 'room-B',
        replyTo: 'shared-id',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, replyInOtherRoom, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('explicit caller opt-out (userTurnPersisted:false) WINS over the cache (caller signal is authoritative)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hi' }, id: 'u-auth', userId: 'u', roomId: 'rA' } as any;
      const reply = {
        content: { text: 'r' }, id: 'a-auth', userId: 'a', roomId: 'rA',
        replyTo: 'u-auth',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(
        runtime, reply, {}, { userTurnPersisted: false },
      );

      const replyOpts = spy.mock.calls[1][3] as any;
      // Cache would have said "true"; explicit caller said "false".
      expect(replyOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('reply WITHOUT replyTo/parentId/inReplyTo has no correlation key → headless (defence-in-depth)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hi' }, id: 'u-iso', userId: 'u', roomId: 'rZ' } as any;
      // No replyTo — proactive assistant message with no parent.
      const reply = {
        content: { text: 'r' }, id: 'a-iso', userId: 'a', roomId: 'rZ',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      // No userMessageId → correlation impossible → headless path.
      expect(replyOpts.userTurnPersisted).toBe(false);
      expect(replyOpts.userMessageId).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

// -----------------------------------------------------------------------
// PR #229 bot review round 17 — r17-1: the persistedUserTurns cache
// MUST be scoped per-runtime. Process hosting multiple Eliza runtimes
// (multi-tenant daemon, orchestrator, test harness) would otherwise
// cross-contaminate: runtime A's successful onChatTurn would make
// runtime B's onAssistantReply take the append-only path for a turn
// envelope that only exists in A's graph. B's reply becomes
// unreadable (no matching dkg:ChatTurn / userMsg subject in B).
// -----------------------------------------------------------------------
describe('dkgPlugin.hooks — r17-1: persisted-user-turn cache is per-runtime', () => {
  beforeEach(() => {
    __resetPersistedUserTurnCacheForTests();
  });

  it('runtime A onChatTurn does NOT affect runtime B onAssistantReply (cross-runtime isolation)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtimeA = { getSetting: () => undefined, character: { name: 'A' } } as any;
      const runtimeB = { getSetting: () => undefined, character: { name: 'B' } } as any;
      // Same roomId+msgId coincidence between the two tenants — the
      // worst-case the bot flagged.
      const userMsg = { content: { text: 'hi' }, id: 'shared-msg', userId: 'u', roomId: 'shared-room' } as any;
      const replyOnB = {
        content: { text: 'r' }, id: 'asst-b', userId: 'a', roomId: 'shared-room',
        replyTo: 'shared-msg',
      } as any;

      // Runtime A successfully persists the user turn.
      await (dkgPlugin as any).hooks.onChatTurn(runtimeA, userMsg, {}, {});
      // Runtime B receives an assistant reply pointing at the SAME
      // (roomId, msgId) coordinates — but B never wrote the envelope.
      await (dkgPlugin as any).hooks.onAssistantReply(runtimeB, replyOnB, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userMessageId).toBe('shared-msg');
      // r17-1 invariant: B must NOT take the append-only path.
      // Pre-r17-1 (process-global cache) this flipped to `true` and
      // B's reply became unreadable in B's graph.
      expect(replyOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('same runtime handles cache hits correctly (no regression on r16-2 intra-runtime sharing)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'same' } } as any;
      const userMsg = { content: { text: 'hi' }, id: 'u-17', userId: 'u', roomId: 'r-17' } as any;
      const reply = {
        content: { text: 'r' }, id: 'a-17', userId: 'a', roomId: 'r-17',
        replyTo: 'u-17',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      // Same runtime → cache hit → append-only path (r16-2 behaviour
      // preserved; only the SCOPE of the cache changed).
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('non-object runtime (null/undefined edge case) falls through to the anon map without crashing', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      // Pathological script that forgets to pass runtime. The plugin
      // must not throw on the WeakMap lookup — WeakMap keys must be
      // objects.
      const userMsg = { content: { text: 'hi' }, id: 'u-anon', userId: 'u', roomId: 'r-anon' } as any;
      const reply = {
        content: { text: 'r' }, id: 'a-anon', userId: 'a', roomId: 'r-anon',
        replyTo: 'u-anon',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(null, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(null, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      // Same "runtime" (null → same anon bucket) so cache hits.
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('runtime A onChatTurn FAIL → runtime B cache stays clean AND runtime A cache stays clean (no cross-leak via failure)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any);
    spy.mockRejectedValueOnce(new Error('fail-A')) // onChatTurn in A
       .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const rtA = { getSetting: () => undefined, character: { name: 'A' } } as any;
      const rtB = { getSetting: () => undefined, character: { name: 'B' } } as any;
      const userMsg = { content: { text: 'hi' }, id: 'u-fail', userId: 'u', roomId: 'rF' } as any;
      const replyA = { content: { text: 'r' }, id: 'a-a', userId: 'a', roomId: 'rF', replyTo: 'u-fail' } as any;
      const replyB = { content: { text: 'r' }, id: 'a-b', userId: 'a', roomId: 'rF', replyTo: 'u-fail' } as any;

      await expect((dkgPlugin as any).hooks.onChatTurn(rtA, userMsg, {}, {})).rejects.toThrow(/fail-A/);
      await (dkgPlugin as any).hooks.onAssistantReply(rtA, replyA, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(rtB, replyB, {}, {});

      // Both runtimes fall through to headless because nothing was
      // ever recorded.
      expect(spy.mock.calls[1][3].userTurnPersisted).toBe(false);
      expect(spy.mock.calls[2][3].userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

// -----------------------------------------------------------------------
// PR #229 bot review round 24 — r24-2: the onChatTurn → onAssistantReply
// in-process cache MUST scope by the destination `(contextGraphId,
// assertionName)` tuple as well as `(roomId, userMsgId)`.
//
// Before this fix: a successful onChatTurn in context graph A silently
// short-circuited an onAssistantReply in context graph B for the same
// (roomId, userMsgId), leaving graph B with only `hasAssistantMessage`
// and no user-turn envelope / session root. That violates the contract
// "a successful persistChatTurn call lands a complete turn in the
// destination".
// -----------------------------------------------------------------------
describe('dkgPlugin.hooks — r24-2: cache is scoped by destination assertion graph', () => {
  beforeEach(() => {
    __resetPersistedUserTurnCacheForTests();
  });

  it('onChatTurn into CG A does NOT mark the turn as persisted for CG B', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-1', userId: 'u', roomId: 'room-r24-2' } as any;
      const assistantMsg = {
        content: { text: 'reply' }, id: 'asst-1', userId: 'a', roomId: 'room-r24-2',
        replyTo: 'user-1',
      } as any;

      // onChatTurn lands in graph-a / chat-turns
      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {
        contextGraphId: 'graph-a',
        assertionName: 'chat-turns',
      });

      // onAssistantReply targets graph-b (DIFFERENT destination)
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, assistantMsg, {}, {
        contextGraphId: 'graph-b',
        assertionName: 'chat-turns',
      });

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.mode).toBe('assistant-reply');
      // Before r24-2 this would have been true (cache hit from the
      // graph-a onChatTurn) and graph-b would have only received
      // the append-only assistant quads — no user-turn envelope, no
      // session root.
      expect(replyOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn into CG A does NOT mark the turn as persisted for assertion "b" in CG A', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-a1', userId: 'u', roomId: 'room-r24-2-a' } as any;
      const assistantMsg = {
        content: { text: 'reply' }, id: 'asst-a1', userId: 'a', roomId: 'room-r24-2-a',
        replyTo: 'user-a1',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {
        contextGraphId: 'agent-context',
        assertionName: 'assertion-alpha',
      });

      await (dkgPlugin as any).hooks.onAssistantReply(runtime, assistantMsg, {}, {
        contextGraphId: 'agent-context',
        assertionName: 'assertion-beta',
      });

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn + onAssistantReply in the SAME destination STILL hit the append-only path (the r16-2 invariant survives)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-same', userId: 'u', roomId: 'room-r24-2-same' } as any;
      const assistantMsg = {
        content: { text: 'reply' }, id: 'asst-same', userId: 'a', roomId: 'room-r24-2-same',
        replyTo: 'user-same',
      } as any;

      const dest = { contextGraphId: 'agent-context', assertionName: 'chat-turns' };
      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, dest);
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, assistantMsg, {}, dest);

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('default destination (no explicit contextGraphId / assertionName) matches the same defaults persistChatTurnImpl uses', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hi' }, id: 'user-def', userId: 'u', roomId: 'room-r24-2-def' } as any;
      const assistantMsg = {
        content: { text: 'reply' }, id: 'asst-def', userId: 'a', roomId: 'room-r24-2-def',
        replyTo: 'user-def',
      } as any;

      // Both calls omit the destination → both resolve to the
      // plugin defaults → cache hit should still fire.
      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, assistantMsg, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR #229 bot review (r3147347... — adapter-elizaos/src/index.ts:353).
// `onChatTurnHandler` recorded the persisted-user-turn cache entry
// UNCONDITIONALLY using `(message as any).id`. The exported
// `DkgChatTurnHook` interface ALSO accepts the assistant-reply overload
// (`mode: 'assistant-reply'`), so a caller wiring the same handler into
// a reply path could poison the cache under the assistant message id —
// any future user-turn id that collided with that assistant id would
// then take the append-only branch against a turn envelope that never
// existed.
//
// Fix: skip the cache write when `options.mode === 'assistant-reply'`,
// and prefer `options.userMessageId` over `message.id` when the caller
// drove the user-turn path with an explicit id (so the cache key
// matches what `onAssistantReply` will look up).
// ─────────────────────────────────────────────────────────────────────────────
describe('dkgPlugin.hooks.onChatTurn — r29-2: assistant-reply mode does NOT poison the user-turn cache', () => {
  beforeEach(() => {
    __resetPersistedUserTurnCacheForTests();
  });

  it('onChatTurn called with mode:"assistant-reply" does NOT mark the assistant id as a persisted user-turn', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      // The caller (mis-)wires the user-turn hook with an
      // assistant-shaped payload. message.id here is the ASSISTANT
      // message id; pre-fix this would have been recorded as a
      // persisted user-turn under that id.
      const assistantMsgPosingAsUser = {
        content: { text: 'reply' }, id: 'asst-poison-id', userId: 'a', roomId: 'room-poison',
      } as any;
      await (dkgPlugin as any).hooks.onChatTurn(
        runtime,
        assistantMsgPosingAsUser,
        {},
        { mode: 'assistant-reply' },
      );

      // Now a legitimate reply arrives whose userMessageId
      // coincidentally collides with the assistant id we just
      // (mis-)used. With the fix, the cache must NOT have been
      // populated → reply takes the headless branch.
      const collidingReply = {
        content: { text: 'r' }, id: 'asst-real', userId: 'a', roomId: 'room-poison',
        replyTo: 'asst-poison-id',
      } as any;
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, collidingReply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.mode).toBe('assistant-reply');
      expect(replyOpts.userMessageId).toBe('asst-poison-id');
      // Pre-fix this would have been `true` (poisoned cache hit).
      expect(replyOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn user-turn path prefers options.userMessageId over message.id when both are supplied', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = {
        content: { text: 'hello' }, id: 'incidental-msg-id', userId: 'u', roomId: 'room-explicit',
      } as any;

      // Caller pre-mints a stable user-turn id different from
      // message.id (the multi-step pipeline case from the comment).
      await (dkgPlugin as any).hooks.onChatTurn(
        runtime,
        userMsg,
        {},
        { userMessageId: 'pre-minted-uid' },
      );

      // The reply uses the pre-minted id → must hit the cache.
      const reply = {
        content: { text: 'r' }, id: 'a1', userId: 'a', roomId: 'room-explicit',
        replyTo: 'pre-minted-uid',
      } as any;
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userMessageId).toBe('pre-minted-uid');
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn user-turn path WITHOUT options.userMessageId still falls back to message.id (regression guard)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = {
        content: { text: 'hello' }, id: 'msg-fallback', userId: 'u', roomId: 'room-fb',
      } as any;
      const reply = {
        content: { text: 'r' }, id: 'a1', userId: 'a', roomId: 'room-fb',
        replyTo: 'msg-fallback',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
