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
} from './actions.js';

/**
 * PR #229 bot review round 16 (r16-2): bounded cache of user-message
 * ids whose `onChatTurn` write completed successfully IN THIS PROCESS.
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
 * Right answer: the plugin KNOWS whether onChatTurn landed, because
 * IT is the code that dispatched `persistChatTurn`. Track the set
 * of successfully-persisted (roomId, userMsgId) tuples here, then
 * consult it when onAssistantReply fires. If we find a hit we pass
 * `userTurnPersisted: true` (cheap append-only path — safe, reader
 * contract already holds via the real user message). Otherwise we
 * still pass `false` and take the headless branch (r14-2 invariant
 * preserved for cases where the user-turn write truly was skipped).
 *
 * Cache design:
 *   - Keyed by `${roomId}\0${userMsgId}` (the same pair that determines
 *     `turnKey` in `persistChatTurnImpl`) so we never confuse a
 *     user-message id that happens to repeat across rooms.
 *   - Bounded to `MAX_ENTRIES` so a long-running node doesn't
 *     accumulate unbounded state — we drop the oldest entries in
 *     insertion order (Map iteration order is insertion-ordered
 *     in every JS engine we care about). The worst-case consequence
 *     of eviction is that a late-arriving onAssistantReply for an
 *     old user turn falls through to the headless branch, which is
 *     the documented-safe path (r15-2 collision guard still holds).
 *   - Only records onChatTurn RESOLUTIONS, not rejections. If the
 *     user-turn write throws we deliberately NEVER record it so the
 *     assistant reply falls through to the safe headless branch.
 */
const PERSISTED_USER_TURN_CACHE_MAX = 10_000;
const persistedUserTurns = new Map<string, true>();

function persistedUserTurnKey(roomId: unknown, userMsgId: unknown): string | null {
  const r = typeof roomId === 'string' ? roomId : '';
  const u = typeof userMsgId === 'string' ? userMsgId : '';
  if (!u) return null; // no user message id → cannot correlate
  return `${r}\u0000${u}`;
}

function markUserTurnPersisted(roomId: unknown, userMsgId: unknown): void {
  const k = persistedUserTurnKey(roomId, userMsgId);
  if (!k) return;
  // Refresh LRU ordering: remove + re-insert so the entry moves to
  // the tail (most-recent). Eviction pops the head.
  persistedUserTurns.delete(k);
  persistedUserTurns.set(k, true);
  if (persistedUserTurns.size > PERSISTED_USER_TURN_CACHE_MAX) {
    const oldest = persistedUserTurns.keys().next().value;
    if (oldest !== undefined) persistedUserTurns.delete(oldest);
  }
}

function hasUserTurnBeenPersisted(roomId: unknown, userMsgId: unknown): boolean {
  const k = persistedUserTurnKey(roomId, userMsgId);
  return k !== null && persistedUserTurns.has(k);
}

/**
 * Test-only: drop every recorded user-turn so tests that exercise
 * the plugin's `onChatTurn → onAssistantReply` chain can start from
 * a clean slate. Exported as `__resetPersistedUserTurnCacheForTests`
 * (double-underscore prefix marks it as a non-public surface — the
 * only documented consumer is the plugin test suite).
 */
export function __resetPersistedUserTurnCacheForTests(): void {
  persistedUserTurns.clear();
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
    opts.userTurnPersisted = hasUserTurnBeenPersisted(roomId, userMessageId);
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
  // reach this line and the cache stays clean.
  const roomId = (message as any)?.roomId;
  const userMsgId = (message as any)?.id;
  markUserTurnPersisted(roomId, userMsgId);
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
