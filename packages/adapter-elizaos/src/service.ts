/**
 * DKGService — manages the DKG agent lifecycle within ElizaOS.
 *
 * Initialized once per ElizaOS agent runtime. Reads config from runtime
 * settings (DKG_*), starts a DKGAgent, and publishes the agent profile.
 */
import { DKGAgent, type DKGAgentConfig } from '@origintrail-official/dkg-agent';
import type {
  ChatTurnPersistOptions,
  IAgentRuntime,
  Memory,
  PersistableMemory,
  Service,
  State,
} from './types.js';
import { persistChatTurnImpl } from './actions.js';

let agentInstance: DKGAgent | null = null;

export function getAgent(): DKGAgent | null {
  return agentInstance;
}

function requireAgent(): DKGAgent {
  if (!agentInstance) throw new Error('DKG node not started — is DKGService initialized?');
  return agentInstance;
}

export { requireAgent };

/**
 * Chat-turn persistence result shape — shared across every user-turn
 * and assistant-reply overload below.
 */
export interface ChatTurnPersistResult {
  tripleCount: number;
  turnUri: string;
  kcId: string;
}

/**
 * Options shape for the ASSISTANT-REPLY path.
 *
 * the assistant-reply path takes
 * a plain `Memory` (the ElizaOS-side assistant message may not have a
 * stable `id`), but it MUST carry `options.userMessageId` so the
 * persister can reconstruct the same `turnUri`/`userMsgUri` the
 * preceding user-turn hook emitted. Expressing that as a narrow type
 * lets the compiler catch the missing id instead of letting
 * `persistChatTurnImpl` throw at runtime.
 *
 * `userTurnPersisted` is also
 * MANDATORY on this overload. `persistChatTurnImpl` infers the flag
 * from "does `userMessageId` exist?" when it's omitted (see the
 * `legacyInference` branch in actions.ts), which is exactly the
 * unsafe shortcut round-13 introduced `ChatTurnPersistOptions.userTurnPersisted`
 * to close: a caller can know the parent id without knowing the
 * corresponding user-turn write succeeded (hook disabled, earlier
 * write failed, reconnect replay), and the cheap-append-only path
 * produces unreadable assistant replies. Requiring the boolean on
 * the TYPED overload forces the caller to think about whether the
 * user turn really made it to disk before taking the append path.
 *
 * Callers that genuinely don't know whether the user turn was
 * persisted (e.g. external integrations restarting mid-session)
 * should pass `userTurnPersisted: false` — that routes the
 * persister through the safe full-envelope branch, which always
 * produces a readable reply.
 */
export interface AssistantReplyChatTurnOptions extends ChatTurnPersistOptions {
  readonly mode: 'assistant-reply';
  readonly userMessageId: string;
  readonly userTurnPersisted: boolean;
  /**
   * When the matching user-turn write embedded a PROVISIONAL
   * assistant string (typical case: a partial-streaming completion
   * the host parked on `assistantText` / `state.lastAssistantReply`
   * before the final reply landed) and the later assistant-reply
   * write brings DIFFERENT final text, the impl needs to route the
   * second write through the headless branch (onto a distinct
   * `msg:agent-headless:K` URI) AND tag it with
   * `dkg:supersedesCanonicalAssistant "true"` so the reader's
   * dedupe inverts its preference for THIS turn key only — surfacing
   * the fresh final reply and dropping the stale provisional. Without
   * the marker the dedupe keeps preferring the canonical and freezes
   * stale text in chat history.
   *
   * The plugin wrapper (`onAssistantReplyHandler` in `src/index.ts`)
   * sets this automatically based on its provisional-text cache vs
   * the incoming reply, so plugin-routed traffic gets safe behaviour
   * for free. Direct `dkgService.persistChatTurn(...)` integrations
   * that bypass the plugin (the path the bot called out) need the
   * SAME knob exposed at the public type so they can opt into the
   * supersede branch when their own caching detects the same shape
   * — otherwise they'd append a second `schema:text` onto the
   * canonical assistant message and `ChatMemoryManager.getSession()`
   * would keep surfacing the stale provisional text.
   *
   * Defaults to `false` (legacy append-only behaviour). Setting it
   * REQUIRES `userTurnPersisted: false` so the impl actually takes
   * the headless branch — combining `userTurnPersisted: true` with
   * `assistantSupersedesCanonical: true` is a contradiction and the
   * runtime guard in `persistChatTurnImpl` ignores the supersede
   * marker when the append-only branch is selected.
   */
  readonly assistantSupersedesCanonical?: boolean;
}

/**
 * Options shape for the USER-TURN path.
 *
 * `mode` is either explicitly `'user-turn'` or left undefined (the
 * default). User-turn persistence normally derives the turn source
 * id from `message.id` (see `PersistableMemory`).
 *
 * `userMessageId` was
 * previously declared `?: never` on this path, but r31-6 added
 * runtime support for an explicit pre-mint id on the user-turn
 * path too: hosts that want the persisted-turn cache key and the
 * on-disk turn URI to converge against a pre-minted id (so the
 * matching `onAssistantReply` can take the safe append-only path)
 * have to set `userMessageId` here. Forbidding the field at the
 * type level meant TS callers had to drop to `as any` or the
 * deprecated `dkgServiceLegacy` to access the runtime-supported
 * pre-mint flow, which defeated the typed surface.
 *
 * Make `userMessageId?: string` to match the runtime contract —
 * when present and non-empty, `persistChatTurnImpl` keys the
 * canonical turn URI off it; when absent, it falls back to
 * `message.id`. Either way the behaviour is identical to what
 * `dkgServiceLegacy` already accepts.
 */
export interface UserTurnChatTurnOptions extends ChatTurnPersistOptions {
  readonly mode?: 'user-turn';
  readonly userMessageId?: string;
}

/**
 * export a real extended service
 * type with *split signatures* so the compiler enforces the
 * user-turn / assistant-reply contracts that `persistChatTurnImpl`
 * previously only enforced at runtime.
 *
 *   - User-turn path (default):
 *       `message: PersistableMemory` — `message.id` is mandatory.
 *       `options.mode` omitted or `'user-turn'`.
 *   - Assistant-reply path:
 *       `message: Memory` — `message.id` can be missing.
 *       `options.mode === 'assistant-reply'` AND
 *       `options.userMessageId` (the parent user-turn id) required.
 *
 * service.ts:128): a third
 * catch-all overload accepted `options?: Record<string, unknown>`
 * for "legacy compat". Because TypeScript matches overloads in
 * declaration order, an object literal like
 * `{ mode: 'assistant-reply' }` would (a) fail the strict
 * assistant-reply overload (missing `userMessageId` /
 * `userTurnPersisted`), then (b) fall through to the catch-all and
 * compile cleanly — defeating the entire compile-time enforcement
 * the typed overloads were added to provide. The runtime guard in
 * `persistChatTurnImpl` still threw, but only after the type check
 * had already let the bad call through.
 *
 * the catch-all is REMOVED from the public surface.
 *
 * service.ts:133) restored a third
 * `@deprecated` catch-all overload directly on this interface to
 * preserve compile-time tolerance for dynamic-bag integrations.
 *
 * service.ts:180) — the r31-2 placement
 * was wrong: even sitting AFTER the strict overloads in declaration
 * order, the catch-all turned `dkgService.persistChatTurn(…, { mode:
 * 'assistant-reply' })` (no `userMessageId` / `userTurnPersisted`)
 * into a clean compile again. TypeScript's overload algorithm tries
 * each signature in declaration order and reports an error only
 * when NONE match, so an object literal that fails overload 2
 * (missing the mandatory reply fields) still satisfied the catch-
 * all and the call compiled — exactly the smuggling hole r30-8
 * closed. The bot was right to flag this as reopening the hole;
 * the only safe placement for a dynamic-bag escape hatch is OFF the
 * main `dkgService` surface entirely.
 *
 * Final shape: the public `DKGService` carries ONLY the
 * two typed overloads. Two named handles are available for callers
 * who legitimately need the wide options bag:
 *   - {@link dkgServiceLegacy} — `@deprecated` public handle that
 *     preserves the wide-`Record<string, unknown>`
 *     signature for downstream integrations that genuinely cannot
 *     narrow at the call site (e.g. framework adapters whose
 *     options shape is determined by the host). Same runtime impl
 *     as `dkgService` — same defence-in-depth guard inside
 *     `persistChatTurnImpl` — but with no compile-time enforcement
 *     of the typed contract.
 *   - {@link _dkgServiceLoose} — internal-only (underscore-
 *     prefixed) handle used by the adapter plugin wiring in
 *     `src/index.ts` for hook dispatch.
 *
 * Migration path: TS callers stay on `dkgService` and either narrow
 * their options to one of the typed shapes OR move to
 * `dkgServiceLegacy` with an explicit acknowledgement that the
 * compile-time contract is opt-out. `as any` callers are unaffected
 * — they were never type-checked.
 */
export interface DKGService extends Service {
  persistChatTurn(
    runtime: IAgentRuntime,
    message: PersistableMemory,
    state?: State,
    options?: UserTurnChatTurnOptions,
  ): Promise<ChatTurnPersistResult>;
  persistChatTurn(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: AssistantReplyChatTurnOptions,
  ): Promise<ChatTurnPersistResult>;

  onChatTurn(
    runtime: IAgentRuntime,
    message: PersistableMemory,
    state?: State,
    options?: UserTurnChatTurnOptions,
  ): Promise<ChatTurnPersistResult>;
  onChatTurn(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: AssistantReplyChatTurnOptions,
  ): Promise<ChatTurnPersistResult>;
}

/**
 * Internal-only "loose" handle for adapter plugin wiring (see
 * {@link _dkgServiceLoose}). This is the runtime impl shape — wide
 * `Record<string, unknown>` options bag — and it is NOT part of the
 * public `DKGService` API. Exporting it makes adapter-internal
 * routing in `src/index.ts` type-check without exposing the unsafe
 * catch-all to downstream consumers.
 *
 * @internal
 */
export interface DKGServiceLoose extends Service {
  persistChatTurn(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
  ): Promise<ChatTurnPersistResult>;
  onChatTurn(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
  ): Promise<ChatTurnPersistResult>;
}

// The runtime object literal validates against the loose impl
// shape; the public `DKGService` cast at the bottom of this file
// narrows the surface seen by downstream callers — the catch-all
// signature lives only on the internal `DKGServiceLoose` handle.
type DKGServiceImpl = DKGServiceLoose;

const dkgServiceImpl: DKGServiceImpl = {
  name: 'dkg-node',

  async initialize(runtime: IAgentRuntime): Promise<void> {
    if (agentInstance) return;

    const relayPeersRaw = runtime.getSetting('DKG_RELAY_PEERS');
    const bootstrapRaw = runtime.getSetting('DKG_BOOTSTRAP_PEERS');

    const config: DKGAgentConfig = {
      name: runtime.character?.name ?? runtime.getSetting('DKG_AGENT_NAME') ?? 'elizaos-agent',
      framework: 'ElizaOS',
      description: runtime.getSetting('DKG_AGENT_DESCRIPTION'),
      dataDir: runtime.getSetting('DKG_DATA_DIR') ?? '.dkg/elizaos',
      listenPort: runtime.getSetting('DKG_LISTEN_PORT')
        ? parseInt(runtime.getSetting('DKG_LISTEN_PORT')!, 10)
        : undefined,
      relayPeers: relayPeersRaw ? relayPeersRaw.split(',').map(s => s.trim()) : undefined,
      bootstrapPeers: bootstrapRaw ? bootstrapRaw.split(',').map(s => s.trim()) : undefined,
    };

    agentInstance = await DKGAgent.create(config);
    await agentInstance.start();
    await agentInstance.publishProfile();
  },

  async cleanup(): Promise<void> {
    if (!agentInstance) return;
    await agentInstance.stop();
    agentInstance = null;
  },

  /**
   * Spec §09A_FRAMEWORK_ADAPTERS — chat-turn persistence hook surface.
   * Delegates to the same RDF-emitting impl as DKG_PERSIST_CHAT_TURN so
   * frameworks that don't expose actions can still route turns through
   * the DKG node.
   *
   * the public interface splits
   * user-turn and assistant-reply overloads so the compiler enforces
   * the contract; the implementation below keeps the loose
   * `Memory + Record<string, unknown>` shape internally so existing
   * callers that went through `dkgService as any` still work at
   * runtime, and `persistChatTurnImpl` still provides the final
   * defence-in-depth via its own runtime guards.
   */
  async persistChatTurn(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options: Record<string, unknown> = {},
  ): Promise<ChatTurnPersistResult> {
    const agent = requireAgent();
    return persistChatTurnImpl(agent, runtime, message, (state ?? {}) as State, options);
  },

  /** Alias used by the ElizaOS hook contract (`hooks.onChatTurn`). */
  async onChatTurn(
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options: Record<string, unknown> = {},
  ): Promise<ChatTurnPersistResult> {
    return dkgServiceImpl.persistChatTurn(runtime, message, state, options);
  },
};

// publish the same runtime
// object under the narrowed `DKGService` contract so downstream TS
// consumers see the split user-turn / assistant-reply overloads and
// get compile-time errors when they omit `message.id` on the
// user-turn path or `options.userMessageId` on the assistant-reply
// path. The runtime behaviour is identical — every call still routes
// through `persistChatTurnImpl`, whose own runtime guards provide
// defence-in-depth for callers that bypass the TS types (e.g. the
// plugin wiring in `src/index.ts`).
export const dkgService: DKGService = dkgServiceImpl as unknown as DKGService;

/**
 * Internal-only handle for adapter plugin wiring (`src/index.ts`).
 *
 * service.ts:128): the public
 * `DKGService` no longer carries the wide
 * `options?: Record<string, unknown>` catch-all overload, because
 * that catch-all silently accepted `{ mode: 'assistant-reply' }`
 * literals and let downstream TS callers smuggle the strict
 * `AssistantReplyChatTurnOptions` contract past the compile-time
 * check. The catch-all still exists at runtime — it has to, because
 * the adapter plugin wires up generic `(runtime, message, state,
 * options) => …` hook handlers whose `options` shape is determined
 * by the framework rather than the adapter — but it now lives
 * exclusively on this internal handle. External code that imports
 * `_dkgServiceLoose` voids the typed contract on purpose; the
 * runtime guards in `persistChatTurnImpl` remain the single source
 * of truth for malformed payloads regardless of how the call was
 * routed.
 *
 * @internal
 */
export const _dkgServiceLoose: DKGServiceLoose = dkgServiceImpl;

/**
 * @deprecated
 *
 * Public dynamic-bag handle for downstream integrations that
 * genuinely cannot narrow their options at the call site (typically
 * framework adapters whose options shape is determined by the host
 * runtime). Mirrors the wide signature so a
 * `dkgServiceLegacy.persistChatTurn(rt, msg, st, optsBag)` call
 * type-checks against `Record<string, unknown>` without an explicit
 * cast.
 *
 * Kept as a separately-named export rather than an overload on
 * `DKGService` so callers must opt out of the typed contract
 * explicitly at the import site — see the comment on
 * {@link DKGService} for why a catch-all overload on the main
 * interface would reopen the type-smuggling hole.
 *
 * **Migration path** (in order of preference):
 *   1. Best — narrow your options to {@link UserTurnChatTurnOptions}
 *      or {@link AssistantReplyChatTurnOptions} at the call site
 *      and stay on `dkgService`. The compiler enforces the
 *      mandatory fields (`mode` / `userMessageId` /
 *      `userTurnPersisted`) on every call.
 *   2. Migrate to `dkgServiceLegacy` if (1) is genuinely
 *      impossible. You keep the runtime defence-in-depth guard
 *      inside `persistChatTurnImpl` but lose compile-time field
 *      enforcement.
 *   3. Last resort — `dkgService as any` if you need a one-off
 *      escape. (Now equivalent to (2) at the type level, but more
 *      visible at the call site as a deliberate opt-out.)
 *
 * Same runtime impl as `dkgService` — calling either dispatches
 * through `persistChatTurnImpl`, whose own runtime guards remain
 * the single source of truth for malformed payloads.
 */
export const dkgServiceLegacy: DKGServiceLoose = dkgServiceImpl;
