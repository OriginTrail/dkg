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
import type {
  DkgAssistantReplyHook,
  DkgUserTurnHook,
} from '../src/index.js';
import type { AssistantReplyChatTurnOptions } from '../src/service.js';

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
    //
    // r19-2 update: `userTurnPersisted` is now MANDATORY on the
    // typed assistant-reply overload — explicit `false` routes
    // through the safe full-envelope branch.
    const positive: Parameters<Hook> = [
      runtime,
      msg,
      undefined,
      { mode: 'assistant-reply', userMessageId: 'u-1', userTurnPersisted: false },
    ];
    expect(positive.length).toBe(4);

    // Negative path — `mode: 'assistant-reply'` without
    // `userMessageId` (and `userTurnPersisted`) MUST be a
    // compile-time error against the typed overloads. If TypeScript
    // ever stops rejecting this (regression to
    // `Parameters<typeof onChatTurn>` or similar, OR the catch-all
    // overload creeping back in), the @ts-expect-error directive
    // becomes unused and this test fails to compile.
    //
    // r30-8 update: `Parameters<Hook>` resolves to the LAST overload
    // signature, which is the assistant-reply one. We narrow the
    // 4th element's type to `AssistantReplyChatTurnOptions` so the
    // `@ts-expect-error` lands on a single, predictable line — the
    // literal that's missing the mandatory `userMessageId` and
    // `userTurnPersisted` fields.
    // @ts-expect-error r30-8: assistant-reply literal missing
    // userMessageId AND userTurnPersisted is rejected by the strict
    // overload (no catch-all to fall through to anymore).
    const badOpts: AssistantReplyChatTurnOptions = { mode: 'assistant-reply' };
    const negative: Parameters<Hook> = [runtime, msg, undefined, badOpts];
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
      expect((spy.mock.calls[1][3] as { userTurnPersisted: boolean }).userTurnPersisted).toBe(false);
      expect((spy.mock.calls[2][3] as { userTurnPersisted: boolean }).userTurnPersisted).toBe(false);
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

// -----------------------------------------------------------------------
// PR #229 bot review (r31-1 — adapter-elizaos/src/actions.ts:1107 /
// adapter-elizaos/src/actions.ts:1149).
//
// The user-turn branch in `persistChatTurnImpl` ALSO writes the
// assistant Message + `dkg:hasAssistantMessage` link when the
// host plumbs `assistantText` / `assistantReply.text` /
// `state.lastAssistantReply` into the same call. ElizaOS hosts that
// populate that AND also emit `hooks.onAssistantReply` for the same
// turn would, pre-r31, see the second call re-emit
// `buildAssistantMessageQuads(...)` onto the SAME `msg:agent:${turnKey}`
// URI — stacking duplicate `schema:text` / `schema:dateCreated` /
// `schema:author` triples (multi-valued RDF predicates) and making
// downstream `LIMIT 1` queries nondeterministic across replays.
//
// Fix: a parallel `persistedAssistantMessages` cache keyed the same
// way as `persistedUserTurns` (`(roomId, userMsgId, contextGraphId,
// assertionName)`). `onChatTurnHandler` records a hit when the
// user-turn write was successful AND `assistantText` was non-empty;
// `onAssistantReplyHandler` reads the cache and plumbs
// `assistantAlreadyPersisted: true` so `persistChatTurnImpl` returns
// a synthetic no-op (no duplicate quads). Defence-in-depth lives in
// the impl: even direct callers that bypass the wrapper get the
// no-op when they pass the flag explicitly.
// -----------------------------------------------------------------------
describe('dkgPlugin.hooks — r31-1: assistant-message double-write guard', () => {
  beforeEach(() => {
    __resetPersistedUserTurnCacheForTests();
  });

  it('onChatTurn carrying assistantText + onAssistantReply for SAME turn → second call short-circuits with assistantAlreadyPersisted=true', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-r31-1', userId: 'u', roomId: 'room-r31-1' } as any;
      const reply = {
        content: { text: 'reply' }, id: 'asst-r31-1', userId: 'a', roomId: 'room-r31-1',
        replyTo: 'user-r31-1',
      } as any;

      // Host wires the assistant text into the user-turn payload.
      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {
        assistantText: 'reply',
      });
      // Then fires the dedicated assistant-reply hook for the same
      // turn.
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      expect(spy).toHaveBeenCalledTimes(2);
      const replyOpts = spy.mock.calls[1][3] as any;
      // r16-2 invariant: cache hit on the user-turn → append-only.
      expect(replyOpts.userTurnPersisted).toBe(true);
      // r31-1 invariant: cache hit on the ASSISTANT side → wrapper
      // plumbs the guard flag → impl returns synthetic no-op so no
      // duplicate `msg:agent:${turnKey}` quads land.
      expect(replyOpts.assistantAlreadyPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn WITHOUT assistantText + onAssistantReply for SAME turn → second call writes normally (assistantAlreadyPersisted absent)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-r31-2', userId: 'u', roomId: 'room-r31-2' } as any;
      const reply = {
        content: { text: 'reply' }, id: 'asst-r31-2', userId: 'a', roomId: 'room-r31-2',
        replyTo: 'user-r31-2',
      } as any;

      // Bare onChatTurn — no assistantText. The user-turn branch in
      // the impl emits ONLY the user message + envelope, so the
      // assistant leg is genuinely missing from the canonical turn.
      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userTurnPersisted).toBe(true);
      // r31-1: no cache hit on the assistant side → guard flag MUST
      // be absent so the impl writes the assistant Message + link.
      // (Pre-r31 this was always undefined; post-r31 we must
      // preserve that for the legitimate "user turn only, assistant
      // reply later" flow — flipping it on here would silently
      // drop the assistant leg entirely.)
      expect(replyOpts.assistantAlreadyPersisted).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn with state.lastAssistantReply also populates the assistant cache when incoming reply text matches (parity with assistantText)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-r31-3', userId: 'u', roomId: 'room-r31-3' } as any;
      // r31-5: the cache stores the FULL assistant text persisted on
      // the user-turn write, and `onAssistantReplyHandler` only sets
      // `assistantAlreadyPersisted=true` when the incoming reply text
      // matches (idempotent retry). So the parity assertion across
      // input shapes (`state.lastAssistantReply`, `assistantText`,
      // `assistantReply.text`) is now: same text in & out ⇒ cache
      // hit ⇒ suppression. We use BYTE-IDENTICAL text here so the
      // parity invariant survives the new payload comparison.
      const persistedText = 'reply';
      const reply = {
        content: { text: persistedText }, id: 'asst-r31-3', userId: 'a', roomId: 'room-r31-3',
        replyTo: 'user-r31-3',
      } as any;

      // Host plumbs the assistant text via `state` instead of
      // `options.assistantText`. The impl's resolution chain
      // (`assistantText ?? assistantReply.text ?? state.lastAssistantReply`)
      // accepts both shapes, so the wrapper's marker MUST mirror
      // that or the cache would miss.
      await (dkgPlugin as any).hooks.onChatTurn(
        runtime, userMsg, { lastAssistantReply: persistedText }, {},
      );
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.assistantAlreadyPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn with assistantReply.text also populates the assistant cache when incoming reply text matches (parity with assistantText)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-r31-4', userId: 'u', roomId: 'room-r31-4' } as any;
      // r31-5: see the matching state.lastAssistantReply test —
      // payload comparison means the cache only suppresses when
      // the recorded text matches the incoming reply.
      const persistedText = 'reply via assistantReply';
      const reply = {
        content: { text: persistedText }, id: 'asst-r31-4', userId: 'a', roomId: 'room-r31-4',
        replyTo: 'user-r31-4',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {
        assistantReply: { text: persistedText },
      });
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.assistantAlreadyPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // -----------------------------------------------------------------------
  // PR #229 bot review (r31-5 — adapter-elizaos/src/index.ts:555).
  //
  // Pre-fix the cache stored a bare `true` per `(roomId, userMsgId,
  // dest)` key, so ANY non-empty `assistantText` /
  // `assistantReply.text` / `state.lastAssistantReply` plumbed
  // through `onChatTurn` flipped the cache → the later real
  // `onAssistantReply` saw `assistantAlreadyPersisted=true` and
  // short-circuited, leaving the stored reply stuck on the
  // partial/wrong text.
  //
  // Fix: cache stores the FULL assistant text (not a bare `true`)
  // and `onAssistantReplyHandler` only suppresses when the incoming
  // reply text MATCHES the cached value byte-for-byte (idempotent
  // retry). Mismatches mean the host pipelined a provisional /
  // stale text through `onChatTurn` and the FINAL reply landed
  // later — we leave the flag unset so the impl emits the new
  // assistant message instead of freezing the stale snapshot.
  // -----------------------------------------------------------------------
  describe('dkgPlugin.hooks — r31-5: assistant-cache payload comparison (no stale-text freeze)', () => {
    beforeEach(() => {
      __resetPersistedUserTurnCacheForTests();
    });

    it('onChatTurn caches PROVISIONAL text + onAssistantReply with FINAL different text → wrapper does NOT set assistantAlreadyPersisted (the FINAL reply gets written, no stale freeze)', async () => {
      const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
        .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
      try {
        const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
        const userMsg = { content: { text: 'hello' }, id: 'user-r31-5-stale', userId: 'u', roomId: 'room-r31-5-stale' } as any;
        // Host plumbs an in-flight LLM PARTIAL — typical for the
        // streaming-completion / provisional-state pattern the bot
        // bot review called out.
        await (dkgPlugin as any).hooks.onChatTurn(
          runtime, userMsg, { lastAssistantReply: 'partial reply…' }, {},
        );
        // Then the FINAL reply lands via the dedicated hook with a
        // different (longer/corrected) text.
        const finalReply = {
          content: { text: 'partial reply, now with the full corrected text.' },
          id: 'asst-r31-5-stale', userId: 'a', roomId: 'room-r31-5-stale',
          replyTo: 'user-r31-5-stale',
        } as any;
        await (dkgPlugin as any).hooks.onAssistantReply(runtime, finalReply, {}, {});

        const replyOpts = spy.mock.calls[1][3] as any;
        // r31-5 invariant: cached text differs from incoming reply
        // text → wrapper MUST NOT set the suppression flag, so the
        // impl writes the (final, correct) reply quads. Pre-fix this
        // would have been `true` and the stale "partial reply…"
        // would have been the only stored assistant text.
        expect(replyOpts.assistantAlreadyPersisted).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it('onChatTurn caches text + onAssistantReply with IDENTICAL text → wrapper sets assistantAlreadyPersisted=true (idempotent retry case still works)', async () => {
      const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
        .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
      try {
        const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
        const userMsg = { content: { text: 'hello' }, id: 'user-r31-5-match', userId: 'u', roomId: 'room-r31-5-match' } as any;
        const persistedText = 'reply text — final, matches both calls';
        await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {
          assistantText: persistedText,
        });
        const reply = {
          content: { text: persistedText }, id: 'asst-r31-5-match', userId: 'a', roomId: 'room-r31-5-match',
          replyTo: 'user-r31-5-match',
        } as any;
        await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

        const replyOpts = spy.mock.calls[1][3] as any;
        // r31-5: matching text means the second call is genuinely a
        // duplicate — suppression fires (preserves the r31-1
        // protection against stacking duplicate `schema:text`
        // triples on the same `msg:agent:${turnKey}` URI).
        expect(replyOpts.assistantAlreadyPersisted).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('onChatTurn caches text + onAssistantReply provides the SAME text on options.assistantText (incoming text not on message.content) → suppression still fires', async () => {
      const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
        .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
      try {
        const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
        const userMsg = { content: { text: 'hello' }, id: 'user-r31-5-opts', userId: 'u', roomId: 'room-r31-5-opts' } as any;
        const persistedText = 'reply via options';
        await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {
          assistantText: persistedText,
        });
        // Caller passes the reply text via options instead of
        // `message.content.text` — the wrapper's incoming-text
        // resolution chain accepts BOTH shapes (parity with how
        // the user-turn side records the text in the first place).
        const reply = {
          content: { text: '' }, id: 'asst-r31-5-opts', userId: 'a', roomId: 'room-r31-5-opts',
          replyTo: 'user-r31-5-opts',
        } as any;
        await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {
          assistantText: persistedText,
        });

        const replyOpts = spy.mock.calls[1][3] as any;
        expect(replyOpts.assistantAlreadyPersisted).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('onChatTurn caches text + onAssistantReply provides the SAME text on options.assistantReply.text → suppression still fires', async () => {
      const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
        .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
      try {
        const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
        const userMsg = { content: { text: 'hello' }, id: 'user-r31-5-rep', userId: 'u', roomId: 'room-r31-5-rep' } as any;
        const persistedText = 'reply via assistantReply.text';
        await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {
          assistantReply: { text: persistedText },
        });
        const reply = {
          content: { text: '' }, id: 'asst-r31-5-rep', userId: 'a', roomId: 'room-r31-5-rep',
          replyTo: 'user-r31-5-rep',
        } as any;
        await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {
          assistantReply: { text: persistedText },
        });

        const replyOpts = spy.mock.calls[1][3] as any;
        expect(replyOpts.assistantAlreadyPersisted).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('onChatTurn writes EMPTY assistantText (truthy guard fails) → cache stays clean → no false-positive suppression on a NON-EMPTY incoming reply', async () => {
      const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
        .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
      try {
        const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
        const userMsg = { content: { text: 'hello' }, id: 'user-r31-5-empty', userId: 'u', roomId: 'room-r31-5-empty' } as any;
        // Host fires onChatTurn with no assistant text at all (the
        // standard "user turn only, reply later" flow). The wrapper
        // does not even invoke `markAssistantPersisted` because the
        // truthiness check fails — cache stays empty, the safety
        // net (refusing to cache empty strings inside
        // `markAssistantPersisted`) is the second line of defence.
        await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});
        const reply = {
          content: { text: 'real reply' }, id: 'asst-r31-5-empty', userId: 'a', roomId: 'room-r31-5-empty',
          replyTo: 'user-r31-5-empty',
        } as any;
        await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

        const replyOpts = spy.mock.calls[1][3] as any;
        expect(replyOpts.assistantAlreadyPersisted).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it('explicit caller assistantAlreadyPersisted=true STILL wins over the payload comparison (caller signal is authoritative)', async () => {
      const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
        .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
      try {
        const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
        const userMsg = { content: { text: 'hello' }, id: 'user-r31-5-explicit', userId: 'u', roomId: 'room-r31-5-explicit' } as any;
        // No prior onChatTurn → cache is empty → payload comparison
        // would not fire. But the caller knows authoritatively the
        // assistant write was already done elsewhere and explicitly
        // sets the flag — the wrapper must defer to that
        // (explicit > implicit, same precedence as the cache check).
        const reply = {
          content: { text: 'reply text' }, id: 'asst-r31-5-explicit', userId: 'a', roomId: 'room-r31-5-explicit',
          replyTo: 'user-r31-5-explicit',
        } as any;
        await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {
          assistantAlreadyPersisted: true,
        });

        const replyOpts = spy.mock.calls[0][3] as any;
        expect(replyOpts.assistantAlreadyPersisted).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('explicit caller assistantAlreadyPersisted=false WINS over the cache (caller signal is authoritative)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-r31-5', userId: 'u', roomId: 'room-r31-5' } as any;
      const reply = {
        content: { text: 'reply' }, id: 'asst-r31-5', userId: 'a', roomId: 'room-r31-5',
        replyTo: 'user-r31-5',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, { assistantText: 'reply' });
      // Caller explicitly says "the cached assistant write is stale —
      // re-write it". Cache MUST defer to the explicit signal so a
      // host that knows better (e.g. just rotated context graph
      // mid-turn) can force a re-emit. The wrapper's check
      // `opts.assistantAlreadyPersisted === undefined` provides this.
      await (dkgPlugin as any).hooks.onAssistantReply(
        runtime, reply, {}, { assistantAlreadyPersisted: false },
      );

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.assistantAlreadyPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('onChatTurn with assistantText FAILS → assistant cache stays clean (no false positive on retry)', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any);
    spy.mockRejectedValueOnce(new Error('write-failed'))
       .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-r31-fail', userId: 'u', roomId: 'room-r31-fail' } as any;
      const reply = {
        content: { text: 'reply' }, id: 'asst-r31-fail', userId: 'a', roomId: 'room-r31-fail',
        replyTo: 'user-r31-fail',
      } as any;

      // onChatTurn throws BEFORE the wrapper records the cache hit.
      // The post-success hook (`markAssistantPersisted`) must NOT
      // fire on a failed write — otherwise a retry path would
      // silently drop the assistant leg.
      await expect(
        (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, { assistantText: 'reply' }),
      ).rejects.toThrow(/write-failed/);
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      // userTurnPersisted is also false (same r16-2 cleanliness)
      expect(replyOpts.userTurnPersisted).toBe(false);
      expect(replyOpts.assistantAlreadyPersisted).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('assistant cache is scoped per destination — onChatTurn into CG A does NOT short-circuit assistant-reply into CG B', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'user-r31-dest', userId: 'u', roomId: 'room-r31-dest' } as any;
      const reply = {
        content: { text: 'reply' }, id: 'asst-r31-dest', userId: 'a', roomId: 'room-r31-dest',
        replyTo: 'user-r31-dest',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {
        contextGraphId: 'graph-a', assertionName: 'chat-turns',
        assistantText: 'reply',
      });
      // Different destination → cache miss → no short-circuit.
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {
        contextGraphId: 'graph-b', assertionName: 'chat-turns',
      });

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.assistantAlreadyPersisted).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('assistant cache is scoped per runtime — onChatTurn on runtime A does NOT short-circuit assistant-reply on runtime B', async () => {
    const spy = vi.spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const rtA = { getSetting: () => undefined, character: { name: 'A' } } as any;
      const rtB = { getSetting: () => undefined, character: { name: 'B' } } as any;
      const userMsg = { content: { text: 'hello' }, id: 'shared-id', userId: 'u', roomId: 'shared-room' } as any;
      const reply = {
        content: { text: 'reply' }, id: 'a-shared', userId: 'a', roomId: 'shared-room',
        replyTo: 'shared-id',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(rtA, userMsg, {}, { assistantText: 'reply' });
      await (dkgPlugin as any).hooks.onAssistantReply(rtB, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.assistantAlreadyPersisted).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR #229 bot review (r31-2 — adapter-elizaos/src/index.ts:602 + :635).
//
// Pre-r31-2:
//   - `dkgPlugin.hooks.onAssistantReply` was typed as `DkgChatTurnHook`,
//     a union of user-turn AND assistant-reply overloads. A downstream
//     caller could write `hooks.onAssistantReply(runtime, msg, state, {})`
//     (no `mode`, no `userMessageId`, no `userTurnPersisted`) and
//     compile cleanly even though the implementation only makes sense
//     for assistant replies.
//   - `dkgPlugin.chatPersistenceHook` was exported with the same union
//     type but wired to `onChatTurnHandler`. Assistant replies routed
//     through this alias bypassed `onAssistantReplyHandler`'s
//     `replyTo` / `parentId` / `inReplyTo` inference AND the r31-1
//     `assistantAlreadyPersisted` cache check. Same logical message
//     could persist with different shapes depending on which
//     exported hook a host happened to use.
//
// Fix:
//   - `DkgAssistantReplyHook`: single-overload callable that ONLY
//     accepts `AssistantReplyChatTurnOptions` (mandatory `mode`,
//     `userMessageId`, `userTurnPersisted`).
//   - `DkgUserTurnHook`: single-overload callable that ONLY accepts
//     `UserTurnChatTurnOptions`.
//   - `onAssistantReply` is now typed `DkgAssistantReplyHook`;
//     `chatPersistenceHook` is now typed `DkgUserTurnHook`.
//   - Defence-in-depth runtime dispatch in `onChatTurnHandler`: if
//     `options.mode === 'assistant-reply'`, route through
//     `onAssistantReplyHandler` so `as any` callers and
//     framework-driven dynamic options bags still get the correct
//     reply-side semantics.
// ─────────────────────────────────────────────────────────────────────────────
describe('dkgPlugin.hooks — r31-2: hook-surface narrowing + dispatch', () => {
  beforeEach(() => {
    __resetPersistedUserTurnCacheForTests();
  });

  it('`DkgAssistantReplyHook` is the assistant-reply-only callable shape (compile-time pin)', () => {
    // Direct typed cast: the plugin's `onAssistantReply` MUST be
    // assignable to `DkgAssistantReplyHook`. If the type ever
    // widens back to `DkgChatTurnHook` or similar, this assignment
    // becomes a structural mismatch and tsc surfaces it.
    const hook: DkgAssistantReplyHook = dkgPlugin.hooks.onAssistantReply;
    expect(typeof hook).toBe('function');

    // Positive control: a strict assistant-reply tuple satisfies
    // the single overload.
    type Args = Parameters<DkgAssistantReplyHook>;
    const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
    const msg = { content: { text: 'reply' }, id: 'm', userId: 'u', roomId: 'r' } as any;
    const positive: Args = [
      runtime,
      msg,
      undefined,
      { mode: 'assistant-reply', userMessageId: 'u-1', userTurnPersisted: false },
    ];
    expect(positive.length).toBe(4);

    // Negative control: a literal that's missing
    // `userMessageId` / `userTurnPersisted` MUST be rejected by
    // the strict overload. If TS ever stops flagging this, the
    // hook surface has regressed back to the union type.
    // @ts-expect-error r31-2: assistant-reply literal missing
    // userMessageId AND userTurnPersisted is rejected by the
    // strict single-overload `DkgAssistantReplyHook` shape.
    const badOpts: AssistantReplyChatTurnOptions = { mode: 'assistant-reply' };
    const negative: Args = [runtime, msg, undefined, badOpts];
    expect(negative.length).toBe(4);
  });

  it('`DkgUserTurnHook` is the user-turn-only callable shape (compile-time pin)', () => {
    // Direct typed cast: the plugin's `chatPersistenceHook` MUST
    // be assignable to `DkgUserTurnHook`. Future widening would
    // surface as a structural mismatch.
    const hook: DkgUserTurnHook = dkgPlugin.chatPersistenceHook;
    expect(typeof hook).toBe('function');

    // Positive control: a strict user-turn tuple satisfies the
    // single overload (omitting options is also legal because
    // `UserTurnChatTurnOptions` parameter is `?` on `DkgUserTurnHook`).
    type Args = Parameters<DkgUserTurnHook>;
    const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
    const msg = { content: { text: 'hi' }, id: 'm', userId: 'u', roomId: 'r' } as any;
    const positive: Args = [runtime, msg, undefined, { mode: 'user-turn' }];
    expect(positive.length).toBe(4);
  });

  it('`onChatTurnHandler` dispatches assistant-reply payloads through `onAssistantReplyHandler` (defence-in-depth)', async () => {
    // The narrow types reject mis-typed calls at compile time. The
    // RUNTIME dispatch covers everything that bypasses the typed
    // surface — `as any` callers, framework-driven dynamic options
    // bags, and tests like this one. We assert the dispatch fires
    // by observing that `onAssistantReply`-style logic
    // (`replyTo` → `userMessageId` inference) runs even when the
    // payload lands on `dkgPlugin.hooks.onChatTurn` with
    // `mode: 'assistant-reply'`.
    const spy = vi
      .spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const reply = {
        content: { text: 'r' },
        id: 'asst-1',
        userId: 'a',
        roomId: 'room-r31-2',
        // `replyTo` is the canonical field
        // `onAssistantReplyHandler` reads to derive
        // `userMessageId`. If the dispatch is missing,
        // `onChatTurnHandler` would just route the payload as-is
        // and `userMessageId` would be `undefined` on the call.
        replyTo: 'parent-user-msg',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, reply, {}, {
        mode: 'assistant-reply',
      });

      // `onAssistantReplyHandler` derives `userMessageId` from
      // `message.replyTo`. The dispatch fired iff the spied call
      // sees that derived field.
      const callOpts = spy.mock.calls[0][3] as any;
      expect(callOpts.mode).toBe('assistant-reply');
      expect(callOpts.userMessageId).toBe('parent-user-msg');
      // r14-2: `userTurnPersisted` defaulted to `false` (no cache hit).
      expect(callOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('`chatPersistenceHook` ALSO dispatches assistant-reply payloads correctly (parity with onChatTurn — same handler underneath)', async () => {
    // The whole point of bug 4 was that `chatPersistenceHook`
    // (wired to `onChatTurnHandler`) and `onAssistantReply` (wired
    // to `onAssistantReplyHandler`) used to behave differently for
    // the same assistant-reply payload. Post-fix, both surfaces
    // route assistant-reply payloads through the same handler, so
    // their behaviour is identical.
    const spy = vi
      .spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const reply = {
        content: { text: 'r' },
        id: 'asst-2',
        userId: 'a',
        roomId: 'room-parity',
        parentId: 'parent-via-parentId',
      } as any;

      await (dkgPlugin as any).chatPersistenceHook(runtime, reply, {}, {
        mode: 'assistant-reply',
      });

      const callOpts = spy.mock.calls[0][3] as any;
      expect(callOpts.mode).toBe('assistant-reply');
      // `parentId` is the second-tier fallback in
      // `onAssistantReplyHandler`'s inference chain. If
      // `chatPersistenceHook` had bypassed the dispatch, this
      // field would be missing.
      expect(callOpts.userMessageId).toBe('parent-via-parentId');
      expect(callOpts.userTurnPersisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('user-turn payloads through `onChatTurn` STILL take the user-turn handler path (dispatch is mode-gated, not unconditional)', async () => {
    // Negative control on the dispatch: a user-turn payload (no
    // `mode: 'assistant-reply'`) MUST NOT trip the assistant-reply
    // dispatch. We pin this by observing that the user-turn cache
    // gets populated (cache write only fires on the user-turn
    // branch of `onChatTurnHandler`).
    const spy = vi
      .spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = {
        content: { text: 'hi' },
        id: 'user-msg-r31-2',
        userId: 'u',
        roomId: 'room-cache-pin',
      } as any;

      await (dkgPlugin as any).hooks.onChatTurn(runtime, userMsg, {}, {});

      // First call: user-turn → no `mode: 'assistant-reply'`
      // injected by the handler.
      const userCallOpts = spy.mock.calls[0][3] as any;
      expect(userCallOpts?.mode).toBeUndefined();

      // Reset spy and fire a follow-up assistant reply against
      // the same user-message id. Cache hit → `userTurnPersisted: true`.
      const reply = {
        content: { text: 'r' },
        id: 'asst-cache-pin',
        userId: 'a',
        roomId: 'room-cache-pin',
        replyTo: 'user-msg-r31-2',
      } as any;
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('the `chatPersistenceHook` user-turn cache is populated when called with a plain user-turn payload (no mode override)', async () => {
    // Same pin as the previous test, but routing through the
    // `chatPersistenceHook` alias to confirm the user-turn branch
    // of `onChatTurnHandler` still fires correctly post-dispatch
    // refactor.
    const spy = vi
      .spyOn(dkgService, 'persistChatTurn' as any)
      .mockResolvedValue({ tripleCount: 0, turnUri: '', kcId: '' } as any);
    try {
      const runtime = { getSetting: () => undefined, character: { name: 'x' } } as any;
      const userMsg = {
        content: { text: 'hi' },
        id: 'user-msg-cph',
        userId: 'u',
        roomId: 'room-cph',
      } as any;

      await (dkgPlugin as any).chatPersistenceHook(runtime, userMsg, {}, {});

      const reply = {
        content: { text: 'r' },
        id: 'asst-cph',
        userId: 'a',
        roomId: 'room-cph',
        replyTo: 'user-msg-cph',
      } as any;
      await (dkgPlugin as any).hooks.onAssistantReply(runtime, reply, {}, {});

      const replyOpts = spy.mock.calls[1][3] as any;
      expect(replyOpts.userTurnPersisted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
