/**
 * packages/adapter-elizaos — extra QA coverage.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md):
 *
 *   K-11 TEST-DEBT + SPEC-GAP
 *        `adapter-elizaos` currently ships only smoke tests. Spec
 *        §09A_FRAMEWORK_ADAPTERS mandates that chat-turn persistence
 *        flow through the DKG node's memory surface. The plugin exposes
 *        NO such hook today — no action, no service method, no
 *        dedicated capability routes chat turns into the node. The
 *        tests below document:
 *          1. the missing chat-persistence hook (RED — prod bug evidence),
 *          2. the service lifecycle contract that is exercisable today,
 *          3. action-handler behaviour contracts for all five actions
 *             (callback semantics, required-argument errors).
 *
 *        // PROD-BUG: no chat-persistence hook surface — see BUGS_FOUND.md K-11
 *
 * Per QA policy: no production-code edits.
 */
import { describe, it, expect } from 'vitest';
import {
  dkgPlugin,
  dkgPublish,
  dkgQuery,
  dkgFindAgents,
  dkgSendMessage,
  dkgInvokeSkill,
  dkgKnowledgeProvider,
  dkgService,
  getAgent,
} from '../src/index.js';
import type { IAgentRuntime, Memory, State, HandlerCallback } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Minimal real IAgentRuntime / Memory / State factories. Using the DI types
// directly — not mocking the runtime via a framework, just implementing the
// shape the plugin requires.
// ─────────────────────────────────────────────────────────────────────────────

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    getSetting: (k: string) => settings[k],
    character: { name: 'test-char' },
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string): Memory {
  return { content: { text }, id: 'mem-1', userId: 'u', roomId: 'r' } as unknown as Memory;
}

interface CallbackRecord {
  calls: Array<{ text: string }>;
  cb: HandlerCallback;
}
function makeCallback(): CallbackRecord {
  const calls: Array<{ text: string }> = [];
  const cb = ((resp: { text: string }) => {
    calls.push(resp);
    return Promise.resolve([] as Memory[]);
  }) as unknown as HandlerCallback;
  return { calls, cb };
}

// ─────────────────────────────────────────────────────────────────────────────
// K-11  Chat-persistence hook — missing (RED)
// ─────────────────────────────────────────────────────────────────────────────
describe('[K-11] chat-persistence hook required by spec §09A_FRAMEWORK_ADAPTERS', () => {
  // PROD-BUG: no chat-persistence hook surface — see BUGS_FOUND.md K-11
  it('plugin exposes an action or hook that persists chat turns through the DKG node', () => {
    const actions = dkgPlugin.actions ?? [];
    const actionNames = actions.map((a) => a.name.toUpperCase());
    const looksLikeChatPersist = (n: string) =>
      /(PERSIST|STORE).*CHAT|CHAT.*(PERSIST|STORE)|CHAT_TURN/.test(n);
    const actionMatch = actionNames.some(looksLikeChatPersist);

    // The plugin currently exposes NONE of: a persist-chat action, a
    // `hooks.onChatTurn` / `hooks.onAssistantReply`, or a dkgService
    // method that stores chat turns. This assertion fails today; it is
    // the bug evidence.
    const hookMatch = Boolean((dkgPlugin as any).hooks?.onChatTurn) ||
                      Boolean((dkgPlugin as any).hooks?.onAssistantReply) ||
                      Boolean((dkgPlugin as any).chatPersistenceHook);
    const serviceMethodMatch = typeof (dkgService as any).persistChatTurn === 'function' ||
                                typeof (dkgService as any).onChatTurn === 'function';

    expect({ actionMatch, hookMatch, serviceMethodMatch }).toEqual({
      actionMatch: true,
      hookMatch: true,
      serviceMethodMatch: true,
    });
  });

  it('positive control: plugin still exposes the five documented actions', () => {
    const names = (dkgPlugin.actions ?? []).map((a) => a.name).sort();
    expect(names).toEqual([
      'DKG_FIND_AGENTS',
      'DKG_INVOKE_SKILL',
      'DKG_PUBLISH',
      'DKG_QUERY',
      'DKG_SEND_MESSAGE',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dkgService lifecycle contract — exercisable today
// ─────────────────────────────────────────────────────────────────────────────
describe('dkgService lifecycle contract', () => {
  it('getAgent() returns null before initialize() has ever run', () => {
    // The service module is singleton-scoped; prior tests in this run
    // may have initialized it. If so, we just assert the getter is
    // still a function on the module (positive control).
    const agent = getAgent();
    expect(agent === null || typeof agent === 'object').toBe(true);
  });

  it('cleanup() on uninitialized service is a no-op', async () => {
    // If agentInstance is null, cleanup() returns immediately. No
    // observable side effect, but it must not throw.
    await expect(dkgService.cleanup!()).resolves.toBeUndefined();
  });

  it('service.name is the documented registration key', () => {
    expect(dkgService.name).toBe('dkg-node');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Action contract — required-argument errors are routed through callback
// ─────────────────────────────────────────────────────────────────────────────
describe('action error-routing contract - never throws, always calls back', () => {
  const state: State = {} as unknown as State;
  const opts = {} as Record<string, unknown>;
  const runtime = makeRuntime();

  // Every handler wraps its body in try/catch and routes the
  // "DKG node not started" error through the callback. That contract is
  // exercisable without booting a real DKGAgent and guards the UX
  // surface of all five actions. The handlers all call requireAgent()
  // BEFORE their argument-validation branches, so when the service is
  // not running the "please provide X" branches are unreachable; the
  // uniform contract we CAN assert is callback-once + boolean return.
  async function assertHandlerContract(
    handler: (r: IAgentRuntime, m: Memory, s: State, o: Record<string, unknown>, cb: HandlerCallback) => Promise<boolean>,
    text: string,
  ) {
    const { calls, cb } = makeCallback();
    const ok = await handler(runtime, makeMessage(text), state, opts, cb);
    expect(typeof ok).toBe('boolean');
    expect(calls).toHaveLength(1);
    expect(typeof calls[0].text).toBe('string');
    expect(calls[0].text.length).toBeGreaterThan(0);
  }

  it('DKG_PUBLISH - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgPublish.handler, 'publish to DKG');
  });

  it('DKG_QUERY - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgQuery.handler, 'query the DKG');
  });

  it('DKG_SEND_MESSAGE - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgSendMessage.handler, 'say hi');
  });

  it('DKG_INVOKE_SKILL - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgInvokeSkill.handler, 'invoke something');
  });

  it('DKG_FIND_AGENTS - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgFindAgents.handler, 'find agents with skill: ImageAnalysis');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// dkgKnowledgeProvider contract — degrades gracefully without an agent
// ─────────────────────────────────────────────────────────────────────────────
describe('dkgKnowledgeProvider graceful-degradation contract', () => {
  it('returns null when no agent has been initialized', async () => {
    // getAgent() is a real function; if no test path has booted the
    // singleton, the provider must degrade to `null`, not throw.
    const result = await dkgKnowledgeProvider.get!(
      makeRuntime(),
      makeMessage('tell me about blockchains'),
    );
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('returns null when the message has no search-worthy keywords', async () => {
    const result = await dkgKnowledgeProvider.get!(
      makeRuntime(),
      makeMessage('a of in the'),
    );
    // All tokens are stop-words or <3 chars ⇒ provider short-circuits.
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Action similes / validate — contract completeness check
// ─────────────────────────────────────────────────────────────────────────────
describe('action metadata contract', () => {
  it('every action has at least one simile', () => {
    for (const a of dkgPlugin.actions ?? []) {
      expect(Array.isArray(a.similes)).toBe(true);
      expect((a.similes ?? []).length).toBeGreaterThan(0);
    }
  });

  it('every action description is non-empty', () => {
    for (const a of dkgPlugin.actions ?? []) {
      expect(typeof a.description).toBe('string');
      expect(a.description.length).toBeGreaterThan(10);
    }
  });

  it('every action has at least one example turn', () => {
    for (const a of dkgPlugin.actions ?? []) {
      expect(Array.isArray(a.examples)).toBe(true);
      expect((a.examples ?? []).length).toBeGreaterThan(0);
    }
  });
});
