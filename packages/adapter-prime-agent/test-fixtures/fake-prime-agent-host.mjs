/**
 * Fake Prime Agent extension host — a reusable child-process test fixture.
 *
 * CI has no real Prime Agent, but the adapter's seam is narrow: the real host
 * jiti-imports the extension bundle into the worker process that owns a
 * session and hands the factory a `pi` object. This script imports the BUILT
 * bundle (`../extension/dist/extension.js` — the artifact that ships) and
 * implements that same surface, so a driver gets everything real except the
 * LLM: a real process boundary, a real pid for liveness checks, a real
 * loopback HTTP bridge, real descriptor files.
 *
 * Host contract emulated (see the header of `extension/src/extension.ts` for
 * the verified upstream behavior):
 *  - the default-export factory is called once per started session, so each
 *    factory call owns its closure — the same isolation the real host gets by
 *    re-importing with `moduleCache: false`;
 *  - `pi.on(event, handler)` registers handlers; session identity reaches the
 *    extension ONLY via `ctx.sessionManager.getSessionId()` on the handler ctx;
 *  - `session_start` and `session_shutdown` handlers are awaited; a session is
 *    considered gone only after its shutdown handlers settle;
 *  - many concurrent sessions live in one process, exactly like a real worker.
 *
 * Control protocol: JSON lines on stdin/stdout, one object per line.
 *   in : {"cmd":"start-session","sessionId":"..."}
 *        {"cmd":"agent-start","sessionId":"..."}
 *        {"cmd":"message-update","sessionId":"...","eventType":"text_delta","delta":"..."}
 *        {"cmd":"agent-end","sessionId":"..."}
 *        {"cmd":"shutdown-session","sessionId":"..."}
 *        {"cmd":"auto-respond","sessionId":"...","reply":"..."}
 *        {"cmd":"exit"}
 *   out: {"evt":"ready"}                                      on boot
 *        {"evt":"session-started","sessionId":...}            session_start settled
 *        {"evt":"user-message","sessionId":...,"text":...,"options":...}
 *                                                             pi.sendUserMessage called
 *        {"evt":"session-shutdown","sessionId":...}           session_shutdown settled
 *        {"evt":"error","message":...}
 *
 * Commands are applied strictly in stdin order (an internal queue serializes
 * them even though handlers are async), so `auto-respond` sent before
 * `start-session` is guaranteed to be in effect once `session-started` is
 * observed. In auto-respond mode every `pi.sendUserMessage` asynchronously
 * (setImmediate) triggers agent_start → one text_delta message_update with the
 * configured reply → agent_end, so a driver that cannot interleave commands
 * (e.g. Playwright) still gets a full turn; the user-message event is emitted
 * either way.
 *
 * PRIME_AGENT_CODING_AGENT_DIR is read by the extension itself; this host
 * never resolves, overrides, or duplicates that logic. On stdin close or
 * {"cmd":"exit"} every live session gets session_shutdown, then the process
 * exits 0. No dependencies; plain Node ESM.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'extension', 'dist', 'extension.js');

// The parent may kill us mid-write; a torn pipe must not become a crash loop.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fail(message) {
  emit({ evt: 'error', message });
}

async function main() {
  if (!existsSync(bundlePath)) {
    process.stderr.write(
      `fake-prime-agent-host: built extension bundle missing at ${bundlePath} — ` +
        'run "pnpm run build:extension" in packages/adapter-prime-agent first\n',
    );
    process.exitCode = 2;
    return;
  }
  const { default: createExtension } = await import(pathToFileURL(bundlePath).href);
  if (typeof createExtension !== 'function') {
    process.stderr.write(
      `fake-prime-agent-host: ${bundlePath} has no default-export extension factory\n`,
    );
    process.exitCode = 2;
    return;
  }

  /** sessionId -> { sessionId, handlers, ctx, autoReply } */
  const sessions = new Map();
  /** auto-respond configured before its session started (deterministic setup). */
  const pendingAutoReplies = new Map();

  async function dispatch(session, event, payload = {}) {
    for (const handler of session.handlers.get(event) ?? []) {
      // The real host awaits lifecycle handlers; awaiting all of them keeps
      // "session-started"/"session-shutdown" honest acknowledgements.
      await handler(payload, session.ctx);
    }
  }

  function scheduleAutoTurn(session, reply) {
    setImmediate(() => {
      enqueue(async () => {
        if (!sessions.has(session.sessionId)) return; // shut down meanwhile
        await dispatch(session, 'agent_start');
        await dispatch(session, 'message_update', {
          assistantMessageEvent: { type: 'text_delta', delta: reply },
        });
        await dispatch(session, 'agent_end');
      });
    });
  }

  async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
      fail(`session already started: ${sessionId}`);
      return;
    }
    const session = {
      sessionId,
      handlers: new Map(),
      autoReply: pendingAutoReplies.get(sessionId),
      // Session identity is reachable ONLY here, mirroring the real host: the
      // factory itself receives no id and no sessionManager.
      ctx: { sessionManager: { getSessionId: () => sessionId } },
    };
    pendingAutoReplies.delete(sessionId);
    const pi = {
      on(event, handler) {
        const list = session.handlers.get(event) ?? [];
        list.push(handler);
        session.handlers.set(event, list);
      },
      sendUserMessage(content, options) {
        emit({
          evt: 'user-message',
          sessionId,
          text: content,
          ...(options !== undefined ? { options } : {}),
        });
        if (session.autoReply !== undefined) scheduleAutoTurn(session, session.autoReply);
      },
      registerTool() {},
    };
    // One factory call per started session: each call owns its closure, which
    // is exactly the isolation the real host's moduleCache:false re-import
    // provides one level up.
    createExtension(pi);
    sessions.set(sessionId, session);
    await dispatch(session, 'session_start');
    emit({ evt: 'session-started', sessionId });
  }

  async function shutdownSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      fail(`unknown session: ${sessionId}`);
      return;
    }
    // Awaited before the session is considered gone, like the real host.
    await dispatch(session, 'session_shutdown');
    sessions.delete(sessionId);
    emit({ evt: 'session-shutdown', sessionId });
  }

  let exiting = false;
  async function shutdownAllAndExit() {
    if (exiting) return;
    exiting = true;
    for (const sessionId of [...sessions.keys()]) {
      await shutdownSession(sessionId);
    }
    // Natural exit, no process.exit(): pending pipe writes (the final events
    // above) keep the loop alive until flushed, so nothing gets truncated.
    rl.close();
    process.stdin.destroy();
    process.exitCode = 0;
  }

  function requireLiveSession(cmd) {
    const session = sessions.get(cmd.sessionId);
    if (!session) fail(`unknown session: ${String(cmd.sessionId)}`);
    return session;
  }

  async function handleCommand(cmd) {
    switch (cmd.cmd) {
      case 'start-session': {
        if (typeof cmd.sessionId !== 'string' || !cmd.sessionId) {
          fail('start-session requires a sessionId');
          return;
        }
        await startSession(cmd.sessionId);
        return;
      }
      case 'agent-start': {
        const session = requireLiveSession(cmd);
        if (session) await dispatch(session, 'agent_start');
        return;
      }
      case 'message-update': {
        const session = requireLiveSession(cmd);
        if (session) {
          await dispatch(session, 'message_update', {
            assistantMessageEvent: { type: cmd.eventType, delta: cmd.delta },
          });
        }
        return;
      }
      case 'agent-end': {
        const session = requireLiveSession(cmd);
        if (session) await dispatch(session, 'agent_end');
        return;
      }
      case 'shutdown-session': {
        await shutdownSession(String(cmd.sessionId));
        return;
      }
      case 'auto-respond': {
        if (typeof cmd.sessionId !== 'string' || typeof cmd.reply !== 'string') {
          fail('auto-respond requires sessionId and reply');
          return;
        }
        const session = sessions.get(cmd.sessionId);
        if (session) session.autoReply = cmd.reply;
        else pendingAutoReplies.set(cmd.sessionId, cmd.reply);
        return;
      }
      case 'exit': {
        await shutdownAllAndExit();
        return;
      }
      default:
        fail(`unknown cmd: ${String(cmd.cmd)}`);
    }
  }

  // Strict stdin ordering even though handlers are async: every command (and
  // every auto-turn) is appended to one promise chain.
  let queue = Promise.resolve();
  function enqueue(job) {
    queue = queue.then(job).catch((err) => fail(String(err?.stack ?? err)));
    return queue;
  }

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      fail(`invalid control line: ${trimmed.slice(0, 120)}`);
      return;
    }
    enqueue(() => handleCommand(cmd));
  });
  rl.on('close', () => {
    enqueue(() => shutdownAllAndExit());
  });

  emit({ evt: 'ready' });
}

await main();
