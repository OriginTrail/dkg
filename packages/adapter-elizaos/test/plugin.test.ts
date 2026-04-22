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
