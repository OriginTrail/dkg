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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
}
interface MessageUpdateEvent {
  assistantMessageEvent?: { type?: string; text?: string; delta?: string };
  message?: { role?: string; content?: unknown };
}
interface ExtensionApiLike {
  on(event: string, handler: (event: any, ctx: ExtensionCtxLike) => unknown): void;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
  registerTool?(tool: unknown): void;
}

/* ── configuration ────────────────────────────────────────────────────────── */

const ADAPTER_STATE_DIRNAME = '.dkg-adapter-prime-agent';
const TURN_IDLE_TIMEOUT_MS = 15 * 60_000; // matches the daemon's channel timeout

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

/* ── per-session bridge ───────────────────────────────────────────────────── */

interface PendingTurn {
  correlationId: string;
  chunks: string[];
  subscribers: Set<ServerResponse>;
  settled: boolean;
  resolve: (outcome: TurnOutcome) => void;
  timer: NodeJS.Timeout;
}

interface TurnOutcome {
  text: string;
  timedOut?: true;
  error?: string;
}

class SessionBridge {
  readonly #pi: ExtensionApiLike;
  readonly #sessionId: string;
  #server: Server | undefined;
  #descriptorPath: string | undefined;
  #turn: PendingTurn | undefined;
  #agentActive = false;
  #closed = false;
  readonly #turnIdleTimeoutMs: number;

  constructor(
    pi: ExtensionApiLike,
    sessionId: string,
    options: { turnIdleTimeoutMs?: number } = {},
  ) {
    this.#pi = pi;
    this.#sessionId = sessionId;
    this.#turnIdleTimeoutMs = options.turnIdleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
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

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('bridge failed to acquire a loopback port');
    }
    const bridgeUrl = `http://127.0.0.1:${address.port}`;
    this.#publishDescriptor(bridgeUrl);
  }

  #publishDescriptor(bridgeUrl: string): void {
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.#sessionId}.json`);
    const descriptor = {
      sessionId: this.#sessionId,
      bridgeUrl,
      pid: process.pid,
      startedAt: new Date().toISOString(),
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
      this.#resolveTurn({ text: this.#turn.chunks.join(''), error: 'Bridge stopped' });
      this.#turn = undefined;
    }
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
      const turn: PendingTurn = {
        correlationId,
        chunks: [],
        subscribers: new Set(),
        settled: false,
        resolve,
        timer: undefined as unknown as NodeJS.Timeout,
      };
      this.#turn = turn;
      this.#armIdleTimer(turn);
    });

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
      const turn = this.#turn!;
      turn.subscribers.add(res);
      req.on('close', () => turn.subscribers.delete(res));
    }

    // Inject as a real user message so the turn is indistinguishable from one
    // the operator typed locally — which is the point of collocation.
    // Requests observed while the session is active are rejected above. Use a
    // follow-up for the remaining race window so a locally-started turn is
    // never interrupted by a remote UI message.
    this.#pi.sendUserMessage(text, { deliverAs: 'followUp' });

    const outcome = await done;

    if (outcome.error || outcome.timedOut) {
      const error = outcome.error ?? `Prime Agent turn idle for ${this.#turnIdleTimeoutMs}ms`;
      if (stream) {
        writeSse(res, { type: 'error', error, correlationId });
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

  onMessageUpdate(event: MessageUpdateEvent): void {
    const turn = this.#turn;
    if (!turn || turn.settled) return;
    const assistantEvent = event.assistantMessageEvent;
    const eventType = assistantEvent?.type;
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

  onAgentStart(): void {
    this.#agentActive = true;
  }

  onAgentEnd(): void {
    this.#agentActive = false;
    const turn = this.#turn;
    if (!turn) return;
    if (!turn.settled) this.#resolveTurn({ text: turn.chunks.join('') });
    clearTimeout(turn.timer);
    this.#turn = undefined;
  }

  #armIdleTimer(turn: PendingTurn): void {
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => {
      if (this.#turn !== turn || turn.settled) return;
      // Resolve the HTTP request visibly as a timeout, but retain #turn until
      // the real agent_end. This prevents late deltas from bleeding into a new
      // request while the old Prime Agent turn is still running.
      this.#resolveTurn({ text: turn.chunks.join(''), timedOut: true });
    }, this.#turnIdleTimeoutMs);
  }

  #resolveTurn(outcome: TurnOutcome): void {
    const turn = this.#turn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.timer);
    turn.resolve(outcome);
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

  pi.on('agent_start', () => {
    bridge?.onAgentStart();
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

export { SessionBridge, tokenMatches, sessionsDir, stateDir };
