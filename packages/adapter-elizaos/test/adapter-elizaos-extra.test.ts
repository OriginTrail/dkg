/** Exact contracts for a stopped ElizaOS service. Initialized paths live in behavior.test.ts. */
import { beforeEach, describe, it, expect, vi } from 'vitest';

// These surface/stopped-service tests must not construct an external DKG node.
vi.mock('@origintrail-official/dkg-agent', () => ({ DKGAgent: { create: vi.fn() } }));
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
  };
}

function makeMessage(text: string): Memory {
  return { content: { text }, agentId: 'agent', userId: 'u', roomId: 'r' };
}

interface CallbackRecord {
  calls: Array<{ text: string }>;
  cb: HandlerCallback;
}
function makeCallback(): CallbackRecord {
  const calls: Array<{ text: string }> = [];
  const cb: HandlerCallback = (resp) => { calls.push(resp); };
  return { calls, cb };
}

beforeEach(async () => {
  await dkgService.cleanup!();
  expect(getAgent()).toBeNull();
});

// K-11 (chat-persistence hook) sentinel removed — the plugin does not yet
// expose a persist-chat action or `hooks.onChatTurn` / `onAssistantReply`;
// feature is unimplemented. See v10 roadmap spec §09A_FRAMEWORK_ADAPTERS.
describe('[adapter-elizaos] positive controls (actions surface)', () => {
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
    expect(getAgent()).toBeNull();
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
  const state: State = {};
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
    errorPrefix: string,
  ) {
    const { calls, cb } = makeCallback();
    const ok = await handler(runtime, makeMessage(text), state, opts, cb);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(`${errorPrefix}: DKG node not started — is DKGService initialized?`);
  }

  it('DKG_PUBLISH - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgPublish.handler, 'publish to DKG', 'DKG publish failed');
  });

  it('DKG_QUERY - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgQuery.handler, 'query the DKG', 'DKG query failed');
  });

  it('DKG_SEND_MESSAGE - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgSendMessage.handler, 'say hi', 'Message send failed');
  });

  it('DKG_INVOKE_SKILL - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgInvokeSkill.handler, 'invoke something', 'Skill invocation failed');
  });

  it('DKG_FIND_AGENTS - errors routed via callback, never thrown', async () => {
    await assertHandlerContract(dkgFindAgents.handler, 'find agents with skill: ImageAnalysis', 'Agent discovery failed');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// dkgKnowledgeProvider contract — degrades gracefully without an agent
// ─────────────────────────────────────────────────────────────────────────────
describe('dkgKnowledgeProvider graceful-degradation contract', () => {
  it('returns null when no agent has been initialized', async () => {
    // The beforeEach explicitly establishes the stopped-service precondition.
    const result = await dkgKnowledgeProvider.get!(
      makeRuntime(),
      makeMessage('tell me about blockchains'),
    );
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
