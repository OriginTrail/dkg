/**
 * Minimal ElizaOS types.
 *
 * These mirror the ElizaOS core interfaces that plugins interact with.
 * The full types live in @elizaos/core; these are the subset needed
 * to build a DKG adapter plugin.
 */

export interface IAgentRuntime {
  getSetting(key: string): string | undefined;
  character?: { name?: string };
}

/**
 * Minimal subset of the ElizaOS `Memory` message surface that the DKG
 * adapter needs at runtime. Fields outside `{ userId, agentId, roomId,
 * content }` are optional because the upstream ElizaOS type doesn't
 * model them, but the DKG chat-persistence code *does* read them:
 *
 *   - `id`         → stable turn source id (required by
 *                    `persistChatTurnImpl` in the user-turn path; the
 *                    function throws loudly if missing so the caller
 *                    boundary surfaces the violation instead of
 *                    silently fabricating a time-based id).
 *   - `createdAt`  → preferred source for `schema:dateCreated` so
 *                    retries produce byte-identical quads.
 *   - `timestamp`, `date`, `ts` → legacy aliases accepted for the
 *                    same purpose (matches adapter callers in the
 *                    wild — we normalise via `coerceToIsoDateTime`).
 *   - `inReplyTo`  → link from an assistant reply back to its user
 *                    turn so downstream consumers can reconstruct
 *                    threading even without running through the chat
 *                    memory reader.
 *
 * Exposing these on the PUBLIC adapter type (PR #229 bot review
 * round 13, r13-3) means downstream TypeScript consumers can't satisfy
 * `Memory` and still deterministically throw at runtime — the
 * contract is enforced at compile time.
 */
export interface Memory {
  userId: string;
  agentId: string;
  roomId: string;
  content: { text: string; action?: string };
  readonly id?: string;
  readonly createdAt?: number | string;
  readonly timestamp?: number | string;
  readonly date?: string;
  readonly ts?: string;
  readonly inReplyTo?: string;
}

/**
 * Narrowed `Memory` variant that the user-turn persistence path
 * requires. `id` is the stable turn-source identifier — when
 * missing, `persistChatTurnImpl` throws deterministically because
 * fabricating a time-based id would break idempotence across
 * retries. Splitting the type (PR #229 bot review round 16, r16-4)
 * lets downstream TypeScript callers see this requirement at
 * COMPILE TIME instead of discovering it via a runtime exception.
 *
 * Assistant-reply paths don't need this — they derive the turn key
 * from `ChatTurnPersistOptions.userMessageId` instead — so the
 * plain `Memory` type stays as-is for those callers.
 *
 * Usage:
 *
 *   // user-turn persistence path (onChatTurn):
 *   async function persistUserTurn(runtime: IAgentRuntime, m: PersistableMemory) {
 *     await hooks.onChatTurn(runtime, m, state, options);
 *   }
 *
 *   // assistant-reply path (onAssistantReply):
 *   // r19-2: `userTurnPersisted` is MANDATORY on the typed
 *   // assistant-reply options — callers that don't know whether
 *   // the preceding user-turn hook persisted should pass `false`
 *   // to route through the safe full-envelope branch.
 *   async function persistReply(runtime: IAgentRuntime, m: Memory, userMessageId: string) {
 *     await hooks.onAssistantReply(runtime, m, state, {
 *       mode: 'assistant-reply',
 *       userMessageId,
 *       userTurnPersisted: false,
 *     });
 *   }
 */
export type PersistableMemory = Memory & { readonly id: string };

/**
 * Options recognised by `persistChatTurnImpl` and the
 * `dkgService.persistChatTurn` / `hooks.onChatTurn` /
 * `hooks.onAssistantReply` surfaces. Exposed as a named type so
 * callers get full type checking on every field they rely on.
 *
 * See PR #229 bot review round 13 (r13-1, r13-3).
 */
export interface ChatTurnPersistOptions {
  readonly contextGraphId?: string;
  readonly assistantText?: string;
  readonly assistantReply?: { readonly text?: string };
  readonly assertionName?: string;
  readonly mode?: 'user-turn' | 'assistant-reply';
  readonly userMessageId?: string;
  /**
   * Explicit signal from the caller that the user-turn envelope (the
   * `dkg:ChatTurn` subject + user message Message + `hasUserMessage`
   * edge) has ALREADY been persisted by a prior `onChatTurn` / user
   * path. When this flag is `true` the assistant-reply path takes the
   * cheap append-only branch (just adds the assistant message +
   * `hasAssistantMessage` link). When `false` or undefined it emits
   * the full headless envelope so the reply is discoverable even if
   * the matching user-turn hook never ran.
   *
   * r13-1 rationale: pre-round-13 this was INFERRED from the presence
   * of `userMessageId` alone — which is unsafe because the caller can
   * legitimately know the parent id without knowing the user-turn
   * write succeeded (hook disabled, earlier write failed, reconnect
   * replay). Preferring an explicit boolean defaults the ambiguous
   * case to the safer full-envelope behaviour while still letting
   * well-known callers (the ElizaOS hooks that chain
   * onChatTurn → onAssistantReply in-process) opt into the cheap
   * path.
   */
  readonly userTurnPersisted?: boolean;
  /**
   * PR #229 bot review (r31-1 — actions.ts:1107 / actions.ts:1149).
   *
   * Explicit signal from the caller that the ASSISTANT leg of this
   * turn has already been persisted by a prior write — typically the
   * matching user-turn `onChatTurn` call that picked up
   * `assistantText` / `assistantReply.text` / `state.lastAssistantReply`
   * from the same payload and emitted both legs in a single envelope.
   *
   * When `true` on the assistant-reply path, `persistChatTurnImpl`
   * returns a synthetic no-op result (`tripleCount: 0`) without
   * emitting any quads. This prevents the second `onAssistantReply`
   * call from stacking duplicate `schema:text` / `schema:dateCreated`
   * / `schema:author` triples onto the same `msg:agent:${turnKey}`
   * URI (RDF predicates are multi-valued, so a stale `LIMIT 1`
   * query downstream would bind nondeterministic values).
   *
   * The plugin wrapper (`onAssistantReplyHandler` in `src/index.ts`)
   * reads an in-process `persistedAssistantMessages` cache and sets
   * this flag automatically; direct callers of
   * `dkgService.persistChatTurn` / `_dkgServiceLoose.persistChatTurn`
   * may set it themselves to opt into the same protection.
   */
  readonly assistantAlreadyPersisted?: boolean;
  readonly ts?: string;
  readonly timestamp?: string;
}

export interface State {
  [key: string]: unknown;
}

export interface HandlerCallback {
  (response: { text: string; action?: string }): void;
}

export interface ActionExample {
  user: string;
  content: { text: string; action?: string };
}

export interface Action {
  name: string;
  similes: string[];
  description: string;
  examples: ActionExample[][];
  validate?: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
  handler: (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback: HandlerCallback,
  ) => Promise<boolean>;
}

export interface Provider {
  get: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<string | null>;
}

export interface Service {
  name: string;
  initialize?: (runtime: IAgentRuntime) => Promise<void>;
  cleanup?: () => Promise<void>;
}

export interface Plugin {
  name: string;
  description: string;
  actions?: Action[];
  providers?: Provider[];
  services?: Service[];
}
