/**
 * @origintrail-official/dkg-adapter-elizaos — ElizaOS plugin that turns any ElizaOS agent
 * into a DKG V9 node.
 *
 * Usage in a character config:
 *
 *   import { dkgPlugin } from '@origintrail-official/dkg-adapter-elizaos';
 *
 *   const character = {
 *     plugins: [dkgPlugin],
 *     settings: {
 *       DKG_DATA_DIR: '.dkg/my-agent',
 *       DKG_RELAY_PEERS: '/ip4/1.2.3.4/tcp/9090/p2p/12D3KooW...',
 *     },
 *   };
 */
import type { Plugin } from './types.js';
import { dkgService } from './service.js';
import { dkgKnowledgeProvider } from './provider.js';
import {
  dkgPublish,
  dkgQuery,
  dkgFindAgents,
  dkgSendMessage,
  dkgInvokeSkill,
  dkgPersistChatTurn,
  CHAT_AGENT_CONTEXT_GRAPH,
  CHAT_TURNS_ASSERTION,
} from './actions.js';

/**
 * PR #229 bot review round 16 (r16-2) + round 17 (r17-1): bounded cache
 * of user-message ids whose `onChatTurn` write completed successfully
 * IN THIS PROCESS, SCOPED PER RUNTIME.
 *
 * Context: r14-2 plumbed an explicit `userTurnPersisted` boolean up
 * to `persistChatTurnImpl`, and r15-2 ensured that even when the
 * plugin's own handler defaulted that flag to `false` the resulting
 * stub could not collide with the real user-message subject. But
 * the plugin's in-process `onChatTurn → onAssistantReply` chain
 * always runs the user-turn write successfully BEFORE the assistant
 * reply fires (ElizaOS hook ordering is synchronous per-turn), so
 * the "headless default" case makes readers like
 * `getSessionGraphDelta()` see an extra `dkg:hasUserMessage` stub
 * edge alongside the real one — readers can bind to the stub and
 * surface a blank turn.
 *
 * r16-2's first pass made the cache a single process-global Map.
 * r17-1 fixed the cross-agent leak: one process can legitimately
 * host MULTIPLE Eliza runtimes (multi-tenant daemon, test harness,
 * orchestrator). A successful `onChatTurn` in runtime A must NOT
 * make runtime B's `onAssistantReply` silently take the append-only
 * path for the same `(roomId, userMsgId)` coincidence — B never
 * wrote the user-turn envelope, so the reply would become
 * unreadable in B's graph.
 *
 * Fix: a `WeakMap<runtime, Map<key, true>>` — every runtime object
 * gets its own LRU Map; when the runtime is garbage-collected, its
 * entire cache disappears automatically (no leak on runtime
 * replacement). Each per-runtime Map is still bounded to
 * `PERSISTED_USER_TURN_CACHE_MAX` entries. Keys within a runtime
 * are `${roomId}\u0000${userMsgId}` (the same pair that determines
 * `turnKey` in `persistChatTurnImpl`).
 *
 * Fallback: if the caller invokes the hooks with a non-object
 * runtime (e.g. a `null` / `undefined` stub from a one-off script),
 * we degrade to a single "anonymous" per-process Map so the r16-2
 * in-process sharing property still holds for that caller. This
 * cannot bridge two runtimes because both of them would have to
 * be non-object to hit the fallback, which is not a realistic
 * multi-tenant shape.
 *
 * Only records onChatTurn RESOLUTIONS, not rejections. If the
 * user-turn write throws we deliberately NEVER record it so the
 * assistant reply falls through to the safe headless branch.
 */
const PERSISTED_USER_TURN_CACHE_MAX = 10_000;
/**
 * Per-runtime caches. WeakMap so we don't pin runtime instances in
 * memory past their natural lifetime (service reload, hot-swap).
 * Keyed by identity of the runtime object — two distinct runtime
 * instances with identical shape each get their own Map.
 *
 * Declared `let` so `__resetPersistedUserTurnCacheForTests` can
 * rebind it to a brand-new WeakMap (WeakMap has no `.clear()` in
 * the language spec). In production this binding is only written
 * once at module load.
 */
let persistedUserTurnsByRuntime: WeakMap<object, Map<string, true>> = new WeakMap();
/**
 * Fallback for non-object runtimes. Primarily exists to keep one-off
 * scripts and tests that pass a literal object or `null` working —
 * in production `runtime` is always an `IAgentRuntime` instance.
 */
let persistedUserTurnsAnon: Map<string, true> = new Map();

function resolveRuntimeCache(runtime: unknown): Map<string, true> {
  if (runtime !== null && typeof runtime === 'object') {
    let m = persistedUserTurnsByRuntime.get(runtime as object);
    if (!m) {
      m = new Map<string, true>();
      persistedUserTurnsByRuntime.set(runtime as object, m);
    }
    return m;
  }
  return persistedUserTurnsAnon;
}

/**
 * Bot review PR #229 round 24 (r24-2): the persisted-user-turn cache
 * MUST key by the destination assertion graph as well as
 * `(roomId, userMsgId)`.
 *
 * Before: key was `${roomId}\u0000${userMsgId}`. A caller that routed
 * the same `(roomId, userMsgId)` into two different stores — by
 * varying `options.contextGraphId` / `options.assertionName` between
 * `onChatTurn` and `onAssistantReply` — would see the second store's
 * `onAssistantReply` silently take the append-only path (because the
 * runtime-global cache hit from the FIRST store's successful turn
 * write tricked `hasUserTurnBeenPersisted` into returning `true`),
 * leaving the second store with only `hasAssistantMessage` and no
 * user/session envelope.
 *
 * After: the key includes the resolved destination tuple
 * `(contextGraphId, assertionName)`, matching exactly the
 * `(contextGraphId, assertionName)` that `persistChatTurnImpl` will
 * use when it finally calls `agent.assertion.write(...)`. When the
 * caller does not override either, we resolve the same defaults
 * `persistChatTurnImpl` would (settings → env → constants) so the
 * two code paths agree.
 *
 * Implementation note: we intentionally do NOT add the destination
 * to `persistedUserTurnKey`'s arity; we instead compose
 * `resolveDestination` from the runtime + options and prefix the
 * key. This keeps the public helpers backward-compatible and the
 * change localised.
 */
function resolveDestinationFromOptions(
  runtime: unknown,
  options: unknown,
): { contextGraphId: string; assertionName: string } {
  const optsAny = (options as Record<string, unknown>) ?? {};
  const rt = (runtime as {
    getSetting?: (k: string) => unknown;
  }) ?? {};
  const getSetting = typeof rt.getSetting === 'function' ? rt.getSetting.bind(rt) : () => undefined;
  const contextGraphId =
    (typeof optsAny.contextGraphId === 'string' && optsAny.contextGraphId) ||
    (typeof getSetting('DKG_CHAT_CG') === 'string' && (getSetting('DKG_CHAT_CG') as string)) ||
    CHAT_AGENT_CONTEXT_GRAPH;
  const assertionName =
    (typeof optsAny.assertionName === 'string' && optsAny.assertionName) ||
    (typeof getSetting('DKG_CHAT_ASSERTION') === 'string' && (getSetting('DKG_CHAT_ASSERTION') as string)) ||
    CHAT_TURNS_ASSERTION;
  return { contextGraphId, assertionName };
}

function persistedUserTurnKey(
  roomId: unknown,
  userMsgId: unknown,
  destContextGraphId: string,
  destAssertionName: string,
): string | null {
  const r = typeof roomId === 'string' ? roomId : '';
  const u = typeof userMsgId === 'string' ? userMsgId : '';
  if (!u) return null; // no user message id → cannot correlate
  return `${destContextGraphId}\u0000${destAssertionName}\u0000${r}\u0000${u}`;
}

function markUserTurnPersisted(
  runtime: unknown,
  roomId: unknown,
  userMsgId: unknown,
  destContextGraphId: string,
  destAssertionName: string,
): void {
  const k = persistedUserTurnKey(roomId, userMsgId, destContextGraphId, destAssertionName);
  if (!k) return;
  const m = resolveRuntimeCache(runtime);
  // Refresh LRU ordering: remove + re-insert so the entry moves to
  // the tail (most-recent). Eviction pops the head.
  m.delete(k);
  m.set(k, true);
  if (m.size > PERSISTED_USER_TURN_CACHE_MAX) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
}

function hasUserTurnBeenPersisted(
  runtime: unknown,
  roomId: unknown,
  userMsgId: unknown,
  destContextGraphId: string,
  destAssertionName: string,
): boolean {
  const k = persistedUserTurnKey(roomId, userMsgId, destContextGraphId, destAssertionName);
  if (k === null) return false;
  // For object runtimes, a WeakMap miss means "this runtime has
  // never recorded ANY user turn" — no need to materialize an
  // empty Map just to answer false.
  if (runtime !== null && typeof runtime === 'object') {
    const m = persistedUserTurnsByRuntime.get(runtime as object);
    return m !== undefined && m.has(k);
  }
  return persistedUserTurnsAnon.has(k);
}

/**
 * Test-only: drop every recorded user-turn so tests that exercise
 * the plugin's `onChatTurn → onAssistantReply` chain can start from
 * a clean slate. Exported as `__resetPersistedUserTurnCacheForTests`
 * (double-underscore prefix marks it as a non-public surface — the
 * only documented consumer is the plugin test suite).
 *
 * Resets BOTH the anonymous fallback Map and the per-runtime
 * WeakMap (the WeakMap itself cannot be cleared in-place, so we
 * rebind it — old entries become unreachable and GC-eligible).
 */
export function __resetPersistedUserTurnCacheForTests(): void {
  persistedUserTurnsAnon = new Map();
  // Rebind the WeakMap: the previous instance (and every
  // runtime→Map association inside it) becomes unreachable and
  // GC-eligible. WeakMap has no `.clear()` in the spec — rebinding
  // is the canonical "drop everything" operation.
  persistedUserTurnsByRuntime = new WeakMap();
}

/**
 * Bot review A6 + 2nd-pass follow-ups (assistant-reply corruption /
 * duplicate-publish):
 *
 *   1. Wiring `onChatTurn` AND `onAssistantReply` to the SAME
 *      `persistChatTurn` handler used to double-publish — the second call
 *      either re-emitted the whole turn (duplicate metadata + new
 *      timestamp) or recorded the assistant text AS `userMessage` because
 *      `persistChatTurnImpl` derived `userText` from `message.content.text`.
 *   2. Fix v1 (commit ce5983a6) added a dedicated `onAssistantReplyHandler`
 *      but still forwarded the assistant `Memory` straight through, which
 *      meant `message.content.text` was again read as `userMessage`.
 *   3. Fix v2 (this revision) introduces an explicit `mode:
 *      'assistant-reply'` flag on the persist call. In that mode
 *      `persistChatTurnImpl` skips the user-message + turn-envelope quads
 *      and only writes the assistant `schema:Message` subject + a single
 *      `dkg:hasAssistantMessage` link onto the existing turn. The user
 *      message id from the matching `onChatTurn` call is forwarded via
 *      `userMessageId` so both calls land on the SAME `urn:dkg:chat:turn:`
 *      / `urn:dkg:chat:msg:user:` URIs (deterministic per (roomId,
 *      messageId) tuple).
 *
 * Frameworks that fire only `onChatTurn` keep working — the user-turn
 * branch already accepts both user-only and user+assistant payloads
 * (`options.assistantText` / `state.lastAssistantReply`). Frameworks that
 * fire both hooks no longer corrupt the turn.
 */
async function onAssistantReplyHandler(
  runtime: Parameters<typeof dkgService.onChatTurn>[0],
  message: Parameters<typeof dkgService.onChatTurn>[1],
  state?: Parameters<typeof dkgService.onChatTurn>[2],
  options: Record<string, unknown> = {},
) {
  // ElizaOS conventions: when an assistant reply fires, the matching
  // user-message id is normally on `message.replyTo` / `message.parentId`
  // / `message.inReplyTo`. We thread it through as `userMessageId` so the
  // assistant-reply path lands on the same turnUri as the user-turn.
  const userMessageId =
    (message as any)?.replyTo
    ?? (message as any)?.parentId
    ?? (message as any)?.inReplyTo
    ?? (options as any)?.userMessageId;
  const opts: Record<string, unknown> = {
    ...options,
    mode: 'assistant-reply' as const,
  };
  if (userMessageId) opts.userMessageId = String(userMessageId);
  // PR #229 bot review round 16 (r16-2): resolve `userTurnPersisted`
  // from a REAL in-process signal instead of the r14-2 "default
  // false" — which made every reply take the headless path (stub
  // user message + full envelope) even when onChatTurn had just
  // landed successfully for the same user message in this same
  // process. Readers like `getSessionGraphDelta()` then bound to
  // the stub and surfaced blank turns.
  //
  // Precedence:
  //   1. Explicit caller-provided `userTurnPersisted` boolean — the
  //      caller's hook wiring wins.
  //   2. In-process cache hit on `(roomId, userMessageId)` — means
  //      this plugin's own `onChatTurn` wrapper recorded a successful
  //      user-turn write for the same user message id. Safe to take
  //      the cheap append-only path; readers bind to the real user
  //      message, the stub is never emitted.
  //   3. No hit → true headless path (hook was disabled, user-turn
  //      write errored, or we're seeing `onAssistantReply` without a
  //      matching `onChatTurn` — e.g. on reconnect replay). Fall
  //      through to `userTurnPersisted: false` so the impl emits the
  //      full envelope, and the r15-2 collision guard keeps the stub
  //      on a distinct URI namespace (no corruption risk).
  if (typeof (options as any)?.userTurnPersisted === 'boolean') {
    opts.userTurnPersisted = (options as any).userTurnPersisted;
  } else {
    const roomId = (message as any)?.roomId;
    // r17-1: scope cache lookup by runtime identity — different
    // Eliza runtimes in the same process MUST NOT see each
    // other's user-turn writes, otherwise runtime B's
    // onAssistantReply would take the append-only path for a
    // turn envelope that only exists in runtime A's graph.
    // r24-2: look up cache under the RESOLVED destination tuple
    // (contextGraphId, assertionName) — same defaulting chain as
    // `persistChatTurnImpl`. Prevents a successful onChatTurn in
    // store A from silently short-circuiting onAssistantReply in
    // store B for the same (roomId, userMsgId) pair.
    const dest = resolveDestinationFromOptions(runtime, opts);
    opts.userTurnPersisted = hasUserTurnBeenPersisted(
      runtime,
      roomId,
      userMessageId,
      dest.contextGraphId,
      dest.assertionName,
    );
  }
  return dkgService.persistChatTurn(runtime, message, state, opts);
}

/**
 * Wrapper around `dkgService.onChatTurn` that records a successful
 * user-turn persistence in the in-process cache (r16-2). Failures
 * are re-thrown unchanged and DELIBERATELY NOT recorded so the
 * later `onAssistantReply` falls through to the safe headless
 * branch instead of the append-only path that would assume a turn
 * envelope that never got written.
 */
async function onChatTurnHandler(
  runtime: Parameters<typeof dkgService.onChatTurn>[0],
  message: Parameters<typeof dkgService.onChatTurn>[1],
  state?: Parameters<typeof dkgService.onChatTurn>[2],
  options?: Parameters<typeof dkgService.onChatTurn>[3],
) {
  const result = await dkgService.persistChatTurn(runtime, message, state, options);
  // Only mark AFTER the write resolved — if it throws we never
  // reach this line and the cache stays clean. r17-1: scope the
  // record by the runtime identity so runtime B never sees
  // runtime A's successful user-turn writes. r24-2: ALSO scope
  // by the destination tuple so the same (roomId, userMsgId)
  // routed into a second store re-emits the full envelope there.
  const roomId = (message as any)?.roomId;
  const userMsgId = (message as any)?.id;
  const dest = resolveDestinationFromOptions(runtime, options);
  markUserTurnPersisted(runtime, roomId, userMsgId, dest.contextGraphId, dest.assertionName);
  return result;
}

export const dkgPlugin: Plugin & {
  hooks: {
    onChatTurn: (...args: Parameters<typeof dkgService.onChatTurn>) => ReturnType<typeof dkgService.onChatTurn>;
    onAssistantReply: (...args: Parameters<typeof dkgService.onChatTurn>) => ReturnType<typeof dkgService.onChatTurn>;
  };
  chatPersistenceHook: (...args: Parameters<typeof dkgService.onChatTurn>) => ReturnType<typeof dkgService.onChatTurn>;
} = {
  name: 'dkg',
  description:
    'Turns this ElizaOS agent into a DKG node — publish knowledge, ' +
    'query the graph, discover agents, and invoke remote skills over a ' +
    'decentralized P2P network.',
  actions: [dkgPublish, dkgQuery, dkgFindAgents, dkgSendMessage, dkgInvokeSkill, dkgPersistChatTurn],
  providers: [dkgKnowledgeProvider],
  services: [dkgService],
  hooks: {
    // r16-2: route onChatTurn through `onChatTurnHandler` so
    // successful writes are recorded in the in-process cache that
    // onAssistantReply consults.
    onChatTurn: (runtime, message, state, options) =>
      onChatTurnHandler(runtime, message, state, options),
    // A6: dedicated handler — merges assistant text into the matching
    // turnUri rather than duplicating the whole turn.
    onAssistantReply: (runtime, message, state, options) =>
      onAssistantReplyHandler(runtime, message, state, options),
  },
  chatPersistenceHook: (runtime, message, state, options) =>
    onChatTurnHandler(runtime, message, state, options),
};

export { dkgService, getAgent } from './service.js';
export { dkgKnowledgeProvider } from './provider.js';
export {
  dkgPublish,
  dkgQuery,
  dkgFindAgents,
  dkgSendMessage,
  dkgInvokeSkill,
  dkgPersistChatTurn,
} from './actions.js';
export type {
  Plugin,
  Action,
  Provider,
  Service,
  IAgentRuntime,
  Memory,
  PersistableMemory,
  State,
  HandlerCallback,
  ChatTurnPersistOptions,
} from './types.js';
