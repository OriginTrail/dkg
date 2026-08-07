/**
 * DKG bridge extension for Prime Intellect Prime Agent.
 *
 * Hosts a loopback HTTP bridge inside the worker process that owns a live
 * session, exposing the same `/health`, `/send`, `/stream` contract the DKG
 * daemon already speaks for Hermes bridge targets. This is what makes the
 * integration *collocation* rather than "spawn a second agent": the extension
 * is imported into the running session's process, so a message posted from the
 * Node UI lands in the session the user is actually using.
 *
 * Lifecycle constraints, all verified against prime-agent @0e0d2339:
 *
 *  - The factory receives only `pi`; there is no session id and no
 *    `sessionManager` on it, and every *action* method throws pre-bind
 *    ("Extension runtime not initialized"). So we register handlers here and
 *    do nothing else.
 *  - Session identity is `ctx.sessionManager.getSessionId()` — a uuidv7,
 *    unique by construction and stable for the session's lifetime. It is only
 *    reachable from a handler ctx, so the earliest we can bind is
 *    `session_start`.
 *  - `session_shutdown` fires for ALL of quit | reload | new | resume | fork,
 *    is awaited, and is emitted before ctx invalidation. Cleanup is
 *    unconditional: reload/new/resume/fork keep the process alive and
 *    immediately construct a successor that will bind again.
 *  - A stale listener CAN survive. Extensions are re-imported with
 *    `moduleCache: false`, so the successor's module closure has no reference
 *    to our server, and nothing in the host closes extension-owned sockets.
 *    Hence: ephemeral port (`listen(0)`) always, never a fixed one, and an
 *    explicit `server.on('error')` because EADDRINUSE surfaces asynchronously
 *    and would otherwise become an uncaught exception.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* ── minimal structural types for the host API (no runtime dependency) ─────── */

interface SessionManagerLike {
  getSessionId(): string;
  getSessionFile?(): string | undefined;
  getSessionDir?(): string;
}
interface ExtensionCtxLike {
  sessionManager: SessionManagerLike;
  abort?(): void;
}
interface MessageUpdateEvent {
  assistantMessageEvent?: {
    type?: string;
    text?: string;
    delta?: string;
    reason?: string;
    error?: { errorMessage?: string; stopReason?: string };
  };
  message?: { role?: string; content?: unknown; errorMessage?: string; stopReason?: string };
}
interface AssistantMessageDiagnosticLike {
  type: string;
  timestamp: number;
  details?: Record<string, unknown>;
}
interface MessageEndEvent {
  message?: {
    role?: string;
    stopReason?: string;
    diagnostics?: AssistantMessageDiagnosticLike[];
    [key: string]: unknown;
  };
}
interface MessageEndEventResult {
  message: NonNullable<MessageEndEvent['message']>;
}
interface AgentMessageLike {
  role?: string;
  content?: unknown;
  customType?: string;
  details?: unknown;
}
interface BeforeAgentStartEvent {
  prompt?: string;
}
interface BeforeAgentStartEventResult {
  message: {
    customType: string;
    content: string;
    display: boolean;
    details: { ownershipToken: string };
  };
}
interface MessageStartEvent {
  message?: AgentMessageLike;
}
interface ContextEvent {
  messages?: AgentMessageLike[];
}
interface InputEvent {
  text?: string;
  source?: string;
}
type InputEventResult =
  | { action: 'continue' }
  | { action: 'transform'; text: string }
  | { action: 'handled' };
interface ExtensionApiLike {
  on(event: string, handler: (event: any, ctx: ExtensionCtxLike) => unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
  registerTool?(tool: unknown): void;
}

/* ── configuration ────────────────────────────────────────────────────────── */

const ADAPTER_STATE_DIRNAME = '.dkg-adapter-prime-agent';
const TURN_IDLE_TIMEOUT_MS = 15 * 60_000; // matches the daemon's channel timeout
// Deliberately below the daemon's 60-minute transport backstop so the bridge
// emits a terminal verdict and releases its one-turn guard before the daemon
// has to abort the HTTP connection.
const TURN_HARD_TIMEOUT_MS = 55 * 60_000;
// A dead-pid descriptor younger than this is never pruned: it may be a live
// republication that landed (atomic rename, fresh mtime) between our read and
// the rm. Mirrored in the daemon-side reader (`session-registry.ts`).
const PRUNE_MIN_AGE_MS = 30_000;
// Removed by our `input` handler before Prime creates the user message. The
// opaque tag distinguishes this extension's submission from another extension
// (or an identical local prompt) without exposing metadata to the model.
const BRIDGE_INPUT_TAG_PREFIX = '\u2063dkg-bridge-turn:';
const BRIDGE_TURN_MARKER_TYPE = 'dkg.bridge.turn-owner';

function agentDir(): string {
  return process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), '.prime', 'agent');
}
function stateDir(): string {
  return join(agentDir(), ADAPTER_STATE_DIRNAME);
}
function sessionsDir(): string {
  return join(stateDir(), 'sessions');
}

/**
 * Bridge token. Never invent one: if the operator has not provisioned a token
 * the bridge refuses every request with 503, exactly as the OpenClaw reference
 * bridge does. An unauthenticated bridge would be a local privilege boundary
 * hole, since anything on the loopback interface could drive the agent.
 */
function expectedToken(): string | undefined {
  const fromEnv = process.env.DKG_BRIDGE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(readFileSync(join(stateDir(), 'dkg.json'), 'utf8')) as {
      bridge_token?: string;
    };
    return cfg.bridge_token?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time compare; the OpenClaw reference uses `!==`, we do better. */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Same liveness rule as the daemon-side reader (`session-registry.ts`). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/* ── per-session bridge ───────────────────────────────────────────────────── */

interface PendingTurn {
  correlationId: string;
  prompt: string;
  taggedPrompt: string;
  ownershipToken: string;
  inputObserved: boolean;
  chunks: string[];
  subscribers: Set<ServerResponse>;
  responseSettled: boolean;
  resolve: (outcome: TurnOutcome) => void;
  idleTimer?: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
}

interface TurnOutcome {
  text: string;
  timedOut?: true;
  error?: string;
  errorCode?: PrimeAgentTurnErrorCode;
}

// Must stay in lock-step with SANITIZED_PRIME_AGENT_BRIDGE_FAILURES in
// packages/cli/src/daemon/routes/prime-agent.ts (the daemon's forwarding
// allowlist) and the per-code branches in
// packages/node-ui/src/ui/components/Shell/PanelRight/local-agent-errors.ts:
// a code missing from the daemon map degrades to a generic BRIDGE_ERROR on
// /send while /stream forwards it verbatim, and the two transports diverge.
type PrimeAgentTurnErrorCode =
  | 'PRIME_AGENT_PROVIDER_UNAUTHORIZED'
  | 'PRIME_AGENT_PROVIDER_ERROR'
  | 'PRIME_AGENT_TURN_ABORTED'
  | 'PRIME_AGENT_TURN_TIMEOUT'
  | 'PRIME_AGENT_DELIVERY_FAILED';

interface SanitizedTurnFailure {
  code: PrimeAgentTurnErrorCode;
  message: string;
}

// Classification only ever needs the head of each diagnostic; the cap also
// keeps the regex off provider-sized inputs, which are attacker-influenced.
// Capped per field (not after joining) so an oversized first diagnostic
// cannot starve the second out of classification entirely, and the trailing
// partial token is stripped so truncation cannot fabricate a marker (a cut
// through "status: 4013" must not leave a matching "status: 401").
const PROVIDER_FAILURE_CLASSIFICATION_MAX_CHARS = 4096;

function clipDiagnostic(value: string): string {
  if (value.length <= PROVIDER_FAILURE_CLASSIFICATION_MAX_CHARS) return value;
  return value.slice(0, PROVIDER_FAILURE_CLASSIFICATION_MAX_CHARS).replace(/\w+$/, '');
}

function sanitizedProviderFailure(event: MessageUpdateEvent): SanitizedTurnFailure {
  const assistantEvent = event.assistantMessageEvent;
  const raw = [assistantEvent?.error?.errorMessage, event.message?.errorMessage]
    .filter((value): value is string => typeof value === 'string')
    .map(clipDiagnostic)
    .join('\n');
  // `\s*(?:[:=]\s*)?` is the linear-time equivalent of `\s*[:=]?\s*`: two
  // adjacent unbounded \s* backtrack quadratically on a long whitespace run,
  // and this runs on raw provider error text.
  if (
    /\bunauthori[sz]ed\b|\bauthentication failed\b|\binvalid[_ ]api[_ ]key\b|\bincorrect api key\b|\b(?:http|status(?: code)?)\s*(?:[:=]\s*)?401\b/i.test(raw)
  ) {
    return {
      code: 'PRIME_AGENT_PROVIDER_UNAUTHORIZED',
      message: 'Prime Agent provider authentication failed. Check the configured provider credentials.',
    };
  }
  if (assistantEvent?.reason === 'aborted' || event.message?.stopReason === 'aborted') {
    return {
      code: 'PRIME_AGENT_TURN_ABORTED',
      message: 'Prime Agent turn was aborted.',
    };
  }
  return {
    code: 'PRIME_AGENT_PROVIDER_ERROR',
    message: 'Prime Agent provider request failed.',
  };
}

class SessionBridge {
  readonly #pi: ExtensionApiLike;
  readonly #sessionId: string;
  #server: Server | undefined;
  #descriptorPath: string | undefined;
  #bridgeUrl: string | undefined;
  /** Fixed for the bridge's lifetime; re-publications move only lastActiveAt. */
  #startedAt: string | undefined;
  #turn: PendingTurn | undefined;
  // `before_agent_start` results are cached on Prime's queued action. The
  // hidden ownership marker therefore follows the bridge prompt into the run
  // that actually commits, even if another local/retry run starts after its
  // preparation hook. Local turns and agent.continue() retries have no marker.
  #activeRunTurn: PendingTurn | undefined;
  #runHasFreshPrompt = false;
  // A terminal HTTP verdict must stop Prime from continuing that logical turn
  // in the background. Retry starts have no before_agent_start; abort them
  // until a genuinely fresh prompt boundary supersedes the failed run.
  #failedRunQuarantined = false;
  #failedRunFailure: SanitizedTurnFailure | undefined;
  #agentActive = false;
  #abortActiveAgent: (() => void) | undefined;
  #closed = false;
  readonly #turnIdleTimeoutMs: number;
  readonly #turnHardTimeoutMs: number;

  constructor(
    pi: ExtensionApiLike,
    sessionId: string,
    options: { turnIdleTimeoutMs?: number; turnHardTimeoutMs?: number } = {},
  ) {
    this.#pi = pi;
    this.#sessionId = sessionId;
    this.#turnIdleTimeoutMs = options.turnIdleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
    this.#turnHardTimeoutMs = options.turnHardTimeoutMs ?? TURN_HARD_TIMEOUT_MS;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((err) => {
        this.#json(res, 500, { error: `bridge error: ${String(err).slice(0, 200)}` });
      });
    });
    this.#server = server;

    // EADDRINUSE and friends arrive asynchronously; without this the process
    // would take an uncaught exception. Ephemeral ports make it very unlikely,
    // but "unlikely" is not a design.
    server.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[dkg-bridge] server error for session ${this.#sessionId}: ${String(err)}`);
      this.#cleanupDescriptor();
    });

    await new Promise<void>((resolve) => {
      // Port 0 = ephemeral. A fixed port would collide across the N concurrent
      // sessions a single worker hosts, and would be held by any orphaned
      // listener that survived a /reload.
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('bridge failed to acquire a loopback port');
      }
      // A crashed worker never removes its file, and Prime Agent's daemon may
      // not read the directory for a long time. Pruning at every session start
      // makes crashes converge without waiting for a daemon read. Live
      // descriptors are never touched: several live sessions is a legitimate
      // state (the daemon resumes sessions across terminal restarts) resolved
      // by election, not deletion.
      this.#pruneDeadSiblingDescriptors();
      this.#bridgeUrl = `http://127.0.0.1:${address.port}`;
      this.#startedAt = new Date().toISOString();
      this.#publishDescriptor(this.#startedAt);
    } catch (err) {
      // Descriptor publication can fail after listen() succeeded (EACCES,
      // ENOSPC). The factory drops its bridge reference on a start failure, so
      // an open listener here would hold its port until process exit; close it
      // before the error propagates.
      this.#server = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      throw err;
    }
  }

  /**
   * Atomic (temp file + `wx` + same-directory rename) so readers see either the
   * old descriptor or the new one, never a torn write. Re-published per turn
   * with a fresh `lastActiveAt`; `startedAt` and the bridge URL never move.
   */
  #publishDescriptor(lastActiveAt: string): void {
    if (!this.#bridgeUrl || !this.#startedAt) return;
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.#sessionId}.json`);
    const descriptor = {
      sessionId: this.#sessionId,
      bridgeUrl: this.#bridgeUrl,
      pid: process.pid,
      startedAt: this.#startedAt,
      lastActiveAt,
    };
    const temporaryPath = join(dir, `.${this.#sessionId}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporaryPath, path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    this.#descriptorPath = path;
  }

  #pruneDeadSiblingDescriptors(): void {
    try {
      const dir = sessionsDir();
      const own = `${this.#sessionId}.json`;
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.json') || entry === own) continue;
        const full = join(dir, entry);
        let pid: unknown;
        try {
          pid = (JSON.parse(readFileSync(full, 'utf8')) as { pid?: unknown })?.pid;
        } catch {
          // Same policy as the reader: a malformed file may be a concurrent or
          // externally-managed write whose ownership is unknown. Leave it.
          continue;
        }
        if (typeof pid !== 'number' || isProcessAlive(pid)) continue;
        // A dead pid alone does not justify deleting by path: Prime Agent's
        // daemon respawns sessions, and the respawned bridge republishes a
        // LIVE descriptor at this exact path via atomic rename. If that rename
        // lands between our read and the rm, path-based deletion would take
        // out the live file — so only files old enough that no republication
        // can explain their mtime are removed. If the race is ever lost
        // anyway, the descriptor is republished on that session's next
        // agent_start, so a wrong deletion self-heals.
        try {
          if (Date.now() - statSync(full).mtimeMs < PRUNE_MIN_AGE_MS) continue;
        } catch {
          continue; // already gone: nothing left to prune
        }
        rmSync(full, { force: true });
      }
    } catch {
      /* best effort: pruning must never prevent the bridge from starting */
    }
  }

  #cleanupDescriptor(): void {
    if (!this.#descriptorPath) return;
    try {
      rmSync(this.#descriptorPath, { force: true });
    } catch {
      /* the daemon prunes by pid liveness anyway */
    }
    this.#descriptorPath = undefined;
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#cleanupDescriptor();
    if (this.#turn) {
      this.#settleResponse({ text: this.#turn.chunks.join(''), error: 'Bridge stopped' });
      this.#clearTurn(this.#turn);
    }
    this.#activeRunTurn = undefined;
    this.#runHasFreshPrompt = false;
    this.#failedRunQuarantined = false;
    this.#failedRunFailure = undefined;
    this.#agentActive = false;
    this.#abortActiveAgent = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // close() waits for idle keep-alive sockets; SSE clients would hold it
      // open indefinitely, so drop them explicitly.
      server.closeAllConnections?.();
    });
  }

  /* ── request routing ────────────────────────────────────────────────────── */

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    const expected = expectedToken();
    if (!expected) {
      this.#json(res, 503, { error: 'Bridge auth token unavailable' });
      return;
    }
    if (!tokenMatches(req.headers['x-dkg-bridge-token'] as string | undefined, expected)) {
      this.#json(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      // Echo the session id: this is how the daemon detects a descriptor that
      // points at a recycled port now owned by a different session.
      this.#json(res, 200, { ok: true, sessionId: this.#sessionId, pid: process.pid });
      return;
    }
    if (req.method === 'POST' && path === '/send') {
      await this.#handleSend(req, res, false);
      return;
    }
    if (req.method === 'POST' && path === '/stream') {
      await this.#handleSend(req, res, true);
      return;
    }
    this.#json(res, 404, { error: 'Not found' });
  }

  async #handleSend(req: IncomingMessage, res: ServerResponse, stream: boolean): Promise<void> {
    let payload: { text?: string; correlationId?: string };
    try {
      payload = JSON.parse(await readBody(req)) as typeof payload;
    } catch {
      this.#json(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    const correlationId = typeof payload.correlationId === 'string' ? payload.correlationId : '';
    if (!text || !correlationId) {
      this.#json(res, 400, { error: 'Missing "text" or "correlationId"' });
      return;
    }
    if (this.#turn || this.#agentActive) {
      // One turn at a time per session — the agent itself is single-turn, and
      // interleaving two callers' deltas would corrupt both transcripts.
      this.#json(res, 429, { error: 'Session is busy with another turn', retryAfter: 5 });
      return;
    }

    const done = new Promise<TurnOutcome>((resolve) => {
      const ownershipToken = randomUUID();
      const turn: PendingTurn = {
        correlationId,
        prompt: text,
        taggedPrompt: `${BRIDGE_INPUT_TAG_PREFIX}${ownershipToken}\u2063${text}`,
        ownershipToken,
        inputObserved: false,
        chunks: [],
        subscribers: new Set(),
        responseSettled: false,
        resolve,
      };
      this.#turn = turn;
    });
    const admittedTurn = this.#turn!;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Flush headers immediately with an SSE comment. Without a first write,
      // Node buffers the head, so the client's fetch() would not resolve until
      // the first delta — which for a slow first token looks like a hang, and
      // for a turn that produces no tokens at all never resolves.
      res.write(': open\n\n');
      admittedTurn.subscribers.add(res);
      req.on('close', () => admittedTurn.subscribers.delete(res));
    }

    // Inject as a real user message so the turn is indistinguishable from one
    // the operator typed locally — which is the point of collocation.
    // Requests observed while the session is active are rejected above. Use a
    // follow-up for the remaining race window so a locally-started turn is
    // never interrupted by a remote UI message.
    try {
      this.#pi.sendUserMessage(admittedTurn.taggedPrompt, { deliverAs: 'followUp' });
    } catch {
      this.#failTurn(admittedTurn, {
        code: 'PRIME_AGENT_DELIVERY_FAILED',
        message: 'Prime Agent rejected the local message before starting the turn.',
      });
    }

    const outcome = await done;

    if (outcome.error || outcome.timedOut) {
      const error = outcome.error ?? `Prime Agent turn idle for ${this.#turnIdleTimeoutMs}ms`;
      if (stream) {
        writeSse(res, {
          type: 'error',
          error,
          ...(outcome.errorCode ? { code: outcome.errorCode } : {}),
          source: 'prime-agent-channel',
          retryable: false,
          correlationId,
        });
        writeSse(res, {
          type: 'final',
          text: outcome.text,
          correlationId,
          sessionId: this.#sessionId,
          timedOut: outcome.timedOut === true,
        });
        res.end();
      } else {
        this.#json(res, outcome.timedOut ? 504 : 503, {
          error,
          ...(outcome.errorCode ? { code: outcome.errorCode } : {}),
          source: 'prime-agent-channel',
          retryable: false,
          text: outcome.text,
          correlationId,
          sessionId: this.#sessionId,
          timedOut: outcome.timedOut === true,
        });
      }
      return;
    }

    if (stream) {
      writeSse(res, { type: 'final', text: outcome.text, correlationId, sessionId: this.#sessionId });
      res.end();
    } else {
      this.#json(res, 200, { text: outcome.text, correlationId, sessionId: this.#sessionId });
    }
  }

  /* ── agent event plumbing ───────────────────────────────────────────────── */

  onInput(event: InputEvent): InputEventResult {
    if (event.source !== 'extension' || typeof event.text !== 'string') {
      return { action: 'continue' };
    }
    const turn = this.#turn;
    if (turn && !turn.responseSettled && event.text === turn.taggedPrompt) {
      turn.inputObserved = true;
      return { action: 'transform', text: turn.prompt };
    }
    // A tagged submission whose HTTP request was already cleared must never
    // execute later. Swallow it instead of letting the internal tag or a
    // fail-then-execute side effect reach Prime.
    if (event.text.startsWith(BRIDGE_INPUT_TAG_PREFIX)) return { action: 'handled' };
    return { action: 'continue' };
  }

  onBeforeAgentStart(event: BeforeAgentStartEvent): BeforeAgentStartEventResult | undefined {
    // Prime caches this result on the queued turn action. Unlike transient
    // bridge state, the marker survives a deferred handoff and is emitted only
    // when that exact prepared action enters the agent loop.
    const turn = this.#turn;
    if (!turn || !turn.inputObserved || turn.responseSettled || event.prompt !== turn.prompt) {
      return undefined;
    }
    return {
      message: {
        customType: BRIDGE_TURN_MARKER_TYPE,
        content: '',
        display: false,
        details: { ownershipToken: turn.ownershipToken },
      },
    };
  }

  onMessageStart(event: MessageStartEvent): void {
    const message = event.message;
    if (message?.role === 'user') {
      this.#runHasFreshPrompt = true;
      this.#failedRunQuarantined = false;
      this.#failedRunFailure = undefined;
      return;
    }
    if (message?.role !== 'custom' || message.customType !== BRIDGE_TURN_MARKER_TYPE) return;
    const ownershipToken =
      message.details && typeof message.details === 'object'
        ? (message.details as { ownershipToken?: unknown }).ownershipToken
        : undefined;
    const turn = this.#turn;
    if (turn && !turn.responseSettled && ownershipToken === turn.ownershipToken) {
      this.#activeRunTurn = turn;
      this.#armTurnTimers(turn);
    }
  }

  onContext(event: ContextEvent): { messages: AgentMessageLike[] } | undefined {
    if (!event.messages?.some((message) => message.customType === BRIDGE_TURN_MARKER_TYPE)) {
      return undefined;
    }
    // The marker is transport metadata, not conversation content. Keep it out
    // of every provider request while retaining it in Prime's event stream as
    // a reliable committed-action identity signal.
    return {
      messages: event.messages.filter((message) => message.customType !== BRIDGE_TURN_MARKER_TYPE),
    };
  }

  onBeforeProviderRequest(ctx?: ExtensionCtxLike): void {
    if (!this.#failedRunQuarantined || this.#runHasFreshPrompt) return;
    // Prime retry/continue runs have agent_start but no newly emitted user
    // message. Abort at the last hook before provider I/O so a turn that has
    // already returned a terminal HTTP verdict cannot resume or execute tools.
    try {
      if (typeof ctx?.abort === 'function') ctx.abort();
      else this.#abortActiveAgent?.();
    } catch {
      /* quarantine still prevents this run from owning a bridge request */
    }
  }

  onMessageUpdate(event: MessageUpdateEvent): void {
    const turn = this.#activeRunTurn;
    if (!turn || this.#turn !== turn || turn.responseSettled) return;
    const assistantEvent = event.assistantMessageEvent;
    const eventType = assistantEvent?.type;
    // Prime's provider stream contract declares `error` terminal. Treat it as
    // authoritative even when Prime fails to emit the higher-level agent_end:
    // finish the HTTP/SSE turn, clear admission, and never expose the raw
    // provider payload (which may contain credential-bearing diagnostics).
    if (eventType === 'error') {
      // The provider has already declared this stream terminal. Do not call
      // ctx.abort() here: Prime may emit agent_end synchronously from abort,
      // before the matching message_end hook can replace the finalized error
      // with the non-retryable bridge marker. Genuine timer failures still
      // abort below because their provider stream is not terminal yet.
      this.#failTurn(turn, sanitizedProviderFailure(event), false);
      return;
    }
    // At the pinned Prime Agent API, only text_delta is user-visible answer
    // text. Thinking/tool-call deltas still prove liveness, but must never leak
    // into the response transcript.
    if (
      eventType === 'text_delta' ||
      eventType === 'thinking_delta' ||
      eventType === 'toolcall_delta'
    ) {
      this.#armIdleTimer(turn);
    }
    if (eventType !== 'text_delta') return;
    const delta = assistantEvent?.delta;
    if (typeof delta !== 'string' || delta.length === 0) return;
    turn.chunks.push(delta);
    for (const res of turn.subscribers) {
      writeSse(res, { type: 'delta', text: delta, correlationId: turn.correlationId });
    }
  }

  onMessageEnd(event: MessageEndEvent): MessageEndEventResult | undefined {
    const message = event.message;
    const activeTurn = this.#activeRunTurn;
    // Prime Agent 0.7 may finalize a provider failure directly at message_end
    // without first emitting a message_update error to extensions. Treat the
    // finalized bridge-owned error as authoritative too; otherwise agent_end
    // resolves the HTTP turn as an empty success and the UI renders a blank
    // assistant row while Prime performs its hidden retry.
    if (
      !this.#failedRunQuarantined &&
      activeTurn &&
      this.#turn === activeTurn &&
      message?.role === 'assistant' &&
      message.stopReason === 'error'
    ) {
      this.#failTurn(activeTurn, sanitizedProviderFailure({ message }), false);
    }
    if (
      !this.#failedRunQuarantined ||
      message?.role !== 'assistant' ||
      message.stopReason !== 'error'
    ) {
      return undefined;
    }
    const failure = this.#failedRunFailure;
    const diagnostics = (Array.isArray(message.diagnostics) ? message.diagnostics : [])
      // A structured auth diagnostic makes Prime force one credential-source
      // retry even when the message is otherwise marked terminal. The bridge
      // already returned that failure to its HTTP caller, so retain the safe
      // classification below instead of the provider payload that triggers a
      // second hidden request.
      .filter((diagnostic) => diagnostic.type !== 'provider_stream_failure');
    const hasLifecycleFailure = diagnostics.some(
      (diagnostic) => diagnostic.type === 'agent_lifecycle_failure',
    );
    // Prime retries every assistant `stopReason: error` unless the finalized
    // message is explicitly terminal. Mark only the bridge-owned run that has
    // already returned a terminal HTTP verdict. This is handled synchronously
    // in Prime's public message_end replacement hook, before its retry decision,
    // avoiding the race inherent in trying to abort a retry timer later.
    return {
      message: {
        ...message,
        ...(failure ? { errorMessage: failure.message } : {}),
        diagnostics: [
          ...diagnostics,
          ...(!hasLifecycleFailure ? [{
            type: 'agent_lifecycle_failure',
            timestamp: Date.now(),
            details: {
              source: 'dkg-bridge',
              reason: 'terminal_bridge_response_settled',
              ...(failure ? { code: failure.code } : {}),
            },
          }] : []),
        ],
      },
    };
  }

  onAgentStart(ctx?: ExtensionCtxLike): void {
    this.#activeRunTurn = undefined;
    this.#runHasFreshPrompt = false;
    this.#agentActive = true;
    this.#abortActiveAgent = typeof ctx?.abort === 'function' ? () => ctx.abort!() : undefined;
    // Election stamp, once per turn — agent_start fires for locally-typed and
    // bridge-injected turns alike, so whichever session the operator actually
    // uses wins routing. Not per message_update: thousands of delta events per
    // turn would turn a discovery file into a write amplifier. A failed stamp
    // must never break the turn, hence best-effort.
    if (this.#closed || !this.#descriptorPath) return;
    try {
      this.#publishDescriptor(new Date().toISOString());
    } catch {
      /* the previous descriptor is still valid, just less recent */
    }
  }

  onAgentEnd(): void {
    this.#runHasFreshPrompt = false;
    const turn = this.#activeRunTurn;
    this.#activeRunTurn = undefined;
    if (turn) {
      if (this.#turn === turn && !turn.responseSettled) {
        this.#settleResponse({ text: turn.chunks.join('') });
      }
      this.#clearTurn(turn);
    }

    this.#failedRunQuarantined = false;
    this.#failedRunFailure = undefined;
    this.#agentActive = false;
    this.#abortActiveAgent = undefined;
  }

  #armTurnTimers(turn: PendingTurn): void {
    if (turn.idleTimer || turn.hardTimer) return;
    this.#armIdleTimer(turn);
    turn.hardTimer = setTimeout(() => {
      if (this.#turn !== turn) return;
      this.#failTurn(turn, {
        code: 'PRIME_AGENT_TURN_TIMEOUT',
        message: `Prime Agent turn exceeded the ${this.#turnHardTimeoutMs}ms hard limit.`,
      });
    }, this.#turnHardTimeoutMs);
    turn.hardTimer.unref?.();
  }

  #armIdleTimer(turn: PendingTurn): void {
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    turn.idleTimer = setTimeout(() => {
      if (this.#turn !== turn || turn.responseSettled) return;
      // Resolve the HTTP request visibly as a timeout, but retain #turn until
      // agent_end or the separate hard limit. This prevents late deltas from
      // bleeding into a new request while a merely-slow turn is still running,
      // while also guaranteeing that the session cannot stay busy forever.
      this.#settleResponse({ text: turn.chunks.join(''), timedOut: true });
    }, this.#turnIdleTimeoutMs);
  }

  #settleResponse(outcome: TurnOutcome): void {
    const turn = this.#turn;
    if (!turn || turn.responseSettled) return;
    turn.responseSettled = true;
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    turn.resolve(outcome);
  }

  #clearTurn(turn: PendingTurn): void {
    if (turn.idleTimer) clearTimeout(turn.idleTimer);
    if (turn.hardTimer) clearTimeout(turn.hardTimer);
    if (this.#turn === turn) this.#turn = undefined;
  }

  #failTurn(
    turn: PendingTurn,
    failure: SanitizedTurnFailure,
    abortActiveAgent = true,
  ): void {
    const ownsActiveRun = this.#activeRunTurn === turn;
    if (this.#turn === turn) {
      this.#settleResponse({
        text: turn.chunks.join(''),
        error: failure.message,
        errorCode: failure.code,
      });
      this.#clearTurn(turn);
    }
    if (!ownsActiveRun) return;
    this.#failedRunQuarantined = true;
    this.#failedRunFailure = failure;
    // Keep #agentActive true until the actual agent_end so the bridge does not
    // admit a successor into a run that has not reached a boundary yet.
    if (abortActiveAgent) {
      try {
        this.#abortActiveAgent?.();
      } catch {
        /* the ownership quarantine remains authoritative */
      }
    }
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/** SSE frame format the daemon's passthrough expects: `data: <json>\n\n`. */
function writeSse(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/* ── extension entry point ────────────────────────────────────────────────── */

export default function dkgBridgeExtension(pi: ExtensionApiLike): void {
  // Deliberately nothing here but registration: in the factory body `pi` has no
  // session identity and every action method throws pre-bind.
  let bridge: SessionBridge | undefined;

  pi.on('session_start', async (_event: unknown, ctx: ExtensionCtxLike) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      bridge = new SessionBridge(pi, sessionId);
      await bridge.start();
    } catch (err) {
      // Never take the session down because our bridge could not bind.
      // eslint-disable-next-line no-console
      console.error(`[dkg-bridge] failed to start: ${String(err)}`);
      bridge = undefined;
    }
  });

  pi.on('message_update', (event: MessageUpdateEvent) => {
    bridge?.onMessageUpdate(event);
  });

  pi.on('message_end', (event: MessageEndEvent) => bridge?.onMessageEnd(event));

  pi.on('input', (event: InputEvent) => bridge?.onInput(event) ?? { action: 'continue' });

  pi.on('before_agent_start', (event: BeforeAgentStartEvent) => bridge?.onBeforeAgentStart(event));

  pi.on('agent_start', (_event: unknown, ctx: ExtensionCtxLike) => {
    bridge?.onAgentStart(ctx);
  });

  pi.on('message_start', (event: MessageStartEvent) => {
    bridge?.onMessageStart(event);
  });

  pi.on('context', (event: ContextEvent) => bridge?.onContext(event));

  pi.on('before_provider_request', (_event: unknown, ctx: ExtensionCtxLike) => {
    bridge?.onBeforeProviderRequest(ctx);
  });

  pi.on('agent_end', () => {
    bridge?.onAgentEnd();
  });

  // Unconditional: reload/new/resume/fork all keep the process alive and build
  // a successor that will bind again. Gating on reason === 'quit' would leak a
  // listener that holds its port until process exit.
  pi.on('session_shutdown', async () => {
    const current = bridge;
    bridge = undefined;
    await current?.stop();
  });
}

export { SessionBridge, sanitizedProviderFailure, tokenMatches, sessionsDir, stateDir };
