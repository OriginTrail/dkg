/**
 * The Stage-1 gate: the extension's bridge must satisfy the contract the DKG
 * daemon already speaks, with no Prime Agent running. We drive `SessionBridge`
 * directly with a stub `pi`, so this asserts OUR half of the wire independent
 * of upstream.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionBridge, tokenMatches } from '../extension/src/extension.js';

const TOKEN = 'test-bridge-token-value';
let workDir: string;
let bridge: SessionBridge;
let sent: string[];
let sendOptions: Array<{ deliverAs?: 'steer' | 'followUp' } | undefined>;
let base: string;

function visiblePrompt(text: string): string {
  const prefix = '\u2063dkg-bridge-turn:';
  if (!text.startsWith(prefix)) return text;
  const separator = text.indexOf('\u2063', prefix.length);
  return separator < 0 ? text : text.slice(separator + 1);
}

/** Minimal stand-in for the host ExtensionAPI surface the bridge uses. */
function stubPi(onSend: (text: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void) {
  return {
    on: () => {},
    sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => {
      // Mirror Prime's submission flow faithfully: the bridge keeps its tag on
      // the prepared action and nothing strips it until message_start. `sent`
      // therefore records the RAW submission; assertions apply visiblePrompt()
      // wherever they mean operator-visible text, so the strip point stays in
      // the code under test instead of hiding in this harness.
      const result = bridge.onInput({ source: 'extension', text: content });
      if (result.action === 'handled') return;
      onSend(result.action === 'transform' ? result.text : content, options);
    },
  };
}

/**
 * Deterministic barrier on an observable side effect (usually `sent` growing):
 * fixed sleeps race the loopback HTTP round-trip under CI load, a poll cannot.
 */
async function until(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('until(): condition not reached in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function bridgeBaseUrl(b: SessionBridge): Promise<string> {
  // The bridge publishes its descriptor; read the port back out of it.
  const { readLiveSessions } = await import('../src/session-registry.js');
  const sessions = readLiveSessions(join(workDir, '.dkg-adapter-prime-agent', 'sessions'), {
    prune: false,
  });
  const mine = sessions.find((s) => s.sessionId === b.sessionId);
  if (!mine) throw new Error('bridge did not publish a descriptor');
  return mine.bridgeUrl;
}

type PreparedBridgeRun = NonNullable<ReturnType<SessionBridge['onBeforeAgentStart']>>;

/** Commit a bridge action using the marker Prime cached during preparation. */
function startBridgeRun(
  ctx?: Parameters<SessionBridge['onAgentStart']>[0],
  prepared?: PreparedBridgeRun,
): void {
  const prompt = sent.at(-1);
  if (!prompt) throw new Error('startBridgeRun(): no injected prompt');
  const ownership = prepared ?? bridge.onBeforeAgentStart({ prompt });
  if (!ownership) throw new Error('startBridgeRun(): prompt did not receive an ownership marker');
  bridge.onAgentStart(ctx);
  bridge.onMessageStart({
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  });
  bridge.onMessageStart({
    message: { role: 'custom', ...ownership.message },
  });
}

/** A locally typed prompt is a fresh run, but must not claim a bridge request. */
function startLocalRun(
  prompt = 'locally typed prompt',
  ctx?: Parameters<SessionBridge['onAgentStart']>[0],
): void {
  bridge.onBeforeAgentStart({ prompt });
  bridge.onAgentStart(ctx);
  bridge.onMessageStart({
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  });
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'pa-bridge-'));
  process.env.PRIME_AGENT_CODING_AGENT_DIR = workDir;
  process.env.DKG_BRIDGE_TOKEN = TOKEN;
  sent = [];
  sendOptions = [];
  bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-test');
  await bridge.start();
  base = await bridgeBaseUrl(bridge);
});

afterEach(async () => {
  await bridge.stop();
  delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
  delete process.env.DKG_BRIDGE_TOKEN;
  rmSync(workDir, { recursive: true, force: true });
});

const authed = (extra: Record<string, string> = {}) => ({
  'x-dkg-bridge-token': TOKEN,
  'content-type': 'application/json',
  ...extra,
});

describe('bind + discovery', () => {
  it('binds an ephemeral loopback port and publishes a descriptor', () => {
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // Never a fixed port: a stale listener from a prior /reload would hold it.
    expect(base.endsWith(':0')).toBe(false);
  });

  it('removes its descriptor on stop', async () => {
    const { readLiveSessions } = await import('../src/session-registry.js');
    const dir = join(workDir, '.dkg-adapter-prime-agent', 'sessions');
    expect(readLiveSessions(dir, { prune: false })).toHaveLength(1);
    await bridge.stop();
    expect(readLiveSessions(dir, { prune: false })).toHaveLength(0);
  });

  it('closes the bound listener when descriptor publication fails', async () => {
    // Occupy the sessions path with a regular file so the publish step's
    // mkdirSync throws AFTER listen() has succeeded. Unlike chmod-based
    // denial this holds on every platform and when running as root.
    const badDir = mkdtempSync(join(tmpdir(), 'pa-bridge-bad-'));
    mkdirSync(join(badDir, '.dkg-adapter-prime-agent'), { recursive: true });
    writeFileSync(join(badDir, '.dkg-adapter-prime-agent', 'sessions'), 'not a directory');
    process.env.PRIME_AGENT_CODING_AGENT_DIR = badDir;
    const failing = new SessionBridge(stubPi(() => {}) as never, 'sess-publish-fail');

    // The bridge never exposes its server, so learn the ephemeral port through
    // a scoped listen() wrap; restored before any assertion can throw.
    const captured: { server?: HttpServer; port?: number } = {};
    const originalListen = HttpServer.prototype.listen;
    (HttpServer.prototype as any).listen = function (this: HttpServer, ...args: unknown[]) {
      captured.server = this;
      this.once('listening', () => {
        const address = this.address();
        if (address && typeof address !== 'string') captured.port = address.port;
      });
      return (originalListen as any).apply(this, args);
    };
    try {
      await expect(failing.start()).rejects.toThrow();
    } finally {
      HttpServer.prototype.listen = originalListen;
      process.env.PRIME_AGENT_CODING_AGENT_DIR = workDir;
      rmSync(badDir, { recursive: true, force: true });
    }

    expect(captured.port).toBeDefined();
    expect(captured.server?.listening).toBe(false);
    // The port is actually released: a fresh bind to the same port succeeds
    // where an orphaned listener would produce EADDRINUSE.
    const rebind = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      rebind.on('error', reject);
      rebind.listen(captured.port, '127.0.0.1', () => resolve());
    });
    await new Promise<void>((resolve) => rebind.close(() => resolve()));
  });
});

describe('session election', () => {
  const dir = () => join(workDir, '.dkg-adapter-prime-agent', 'sessions');
  const readOwn = () =>
    JSON.parse(readFileSync(join(dir(), 'sess-test.json'), 'utf8')) as {
      startedAt: string;
      lastActiveAt: string;
    };

  it('re-publishes a fresh lastActiveAt on agent_start with startedAt fixed', async () => {
    const before = readOwn();
    // The initial descriptor claims activity at start, nothing earlier.
    expect(before.lastActiveAt).toBe(before.startedAt);
    // ISO stamps have millisecond resolution; a strictly-newer stamp needs a
    // real gap.
    await new Promise((r) => setTimeout(r, 15));
    startLocalRun();
    const after = readOwn();
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.lastActiveAt > before.lastActiveAt).toBe(true);
    bridge.onAgentEnd();
  });

  it('prunes dead-pid siblings at start but never a malformed file', async () => {
    const deadPath = join(dir(), 'dead-sibling.json');
    writeFileSync(
      deadPath,
      JSON.stringify({
        sessionId: 'dead-sibling',
        bridgeUrl: 'http://127.0.0.1:1',
        // pid 2^31-1 is effectively guaranteed not to exist.
        pid: 2147483647,
        startedAt: new Date().toISOString(),
      }),
    );
    // Age the file past the prune threshold: deletion is age-gated because a
    // fresh mtime could be a respawned session's republication.
    const past = new Date(Date.now() - 120_000);
    utimesSync(deadPath, past, past);
    // A malformed file may be another process's in-flight write: unknown
    // ownership, so start must leave it alone.
    writeFileSync(join(dir(), 'in-flight.json'), '{not json');

    const sibling = new SessionBridge(stubPi(() => {}) as never, 'sess-sibling');
    await sibling.start();
    try {
      expect(existsSync(deadPath)).toBe(false);
      expect(existsSync(join(dir(), 'in-flight.json'))).toBe(true);
      // Live descriptors survive — election, not deletion.
      expect(existsSync(join(dir(), 'sess-test.json'))).toBe(true);
      expect(existsSync(join(dir(), 'sess-sibling.json'))).toBe(true);
    } finally {
      await sibling.stop();
    }
  });

  it('keeps a dead-pid sibling whose mtime is fresh (republish race)', async () => {
    // The TOCTOU shape: between reading a dead pid and deleting by path, a
    // respawned session can republish a LIVE descriptor at that path. A fresh
    // mtime is indistinguishable from that republication, so it must survive.
    const freshDeadPath = join(dir(), 'fresh-dead.json');
    writeFileSync(
      freshDeadPath,
      JSON.stringify({
        sessionId: 'fresh-dead',
        bridgeUrl: 'http://127.0.0.1:1',
        pid: 2147483647,
        startedAt: new Date().toISOString(),
      }),
    );

    const sibling = new SessionBridge(stubPi(() => {}) as never, 'sess-sibling-fresh');
    await sibling.start();
    try {
      expect(existsSync(freshDeadPath)).toBe(true);
    } finally {
      await sibling.stop();
    }
  });
});

describe('auth', () => {
  it('401s a wrong token', async () => {
    const res = await fetch(`${base}/health`, { headers: { 'x-dkg-bridge-token': 'wrong' } });
    expect(res.status).toBe(401);
  });

  it('401s a missing token', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(401);
  });

  it('503s when the operator has provisioned no token at all', async () => {
    delete process.env.DKG_BRIDGE_TOKEN;
    const res = await fetch(`${base}/health`, { headers: { 'x-dkg-bridge-token': TOKEN } });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/token unavailable/i);
    process.env.DKG_BRIDGE_TOKEN = TOKEN;
  });

  it('compares tokens in constant time and rejects length mismatches', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches('short', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });
});

describe('/health', () => {
  it('returns ok:true and echoes the session id so a recycled port is detectable', async () => {
    const res = await fetch(`${base}/health`, { headers: authed() });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The daemon's probe requires ok === true specifically, not just a 2xx.
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe('sess-test');
    expect(body.pid).toBe(process.pid);
  });
});

describe('/send', () => {
  it('injects the text into the session and echoes the correlationId', async () => {
    const p = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'hello agent', correlationId: 'c-1' }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.map(visiblePrompt)).toEqual(['hello agent']);

    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'hi ' } });
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'there' } });
    bridge.onAgentEnd();

    const res = await p;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ text: 'hi there', correlationId: 'c-1', sessionId: 'sess-test' });
    expect(sendOptions).toEqual([{ deliverAs: 'followUp' }]);
  });

  it('400s a malformed body and a missing correlationId', async () => {
    const bad = await fetch(`${base}/send`, { method: 'POST', headers: authed(), body: '{oops' });
    expect(bad.status).toBe(400);
    const noCorr = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'x' }),
    });
    expect(noCorr.status).toBe(400);
  });

  it('429s a second concurrent turn rather than interleaving transcripts', async () => {
    const first = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'one', correlationId: 'c-a' }),
    });
    await new Promise((r) => setTimeout(r, 30));
    startBridgeRun();
    const second = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'two', correlationId: 'c-b' }),
    });
    expect(second.status).toBe(429);
    bridge.onAgentEnd();
    await first;
  });

  it('rejects bridge input while a locally-started agent turn is active', async () => {
    startLocalRun();
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'remote', correlationId: 'c-local-busy' }),
    });
    expect(res.status).toBe(429);
    expect(sent).toEqual([]);
    bridge.onAgentEnd();
  });

  it('reports an idle timeout and stays busy until the real agent_end', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-timeout', {
      turnIdleTimeoutMs: 40,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const firstPending = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'long turn', correlationId: 'c-timeout' }),
    });
    await until(() => sent.length === 1);
    startBridgeRun();
    const first = await firstPending;
    expect(first.status).toBe(504);
    expect(await first.json()).toMatchObject({ timedOut: true, correlationId: 'c-timeout' });

    const whileStillRunning = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'must wait', correlationId: 'c-too-soon' }),
    });
    expect(whileStillRunning.status).toBe(429);

    // Late output from the timed-out turn is ignored, and only agent_end opens
    // admission for the next bridge request.
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'late-old-output' } });
    bridge.onAgentEnd();
  });

  it('sanitizes a terminal provider failure and releases admission without agent_end', async () => {
    const firstResponse = await fetch(`${base}/stream`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'use the provider', correlationId: 'c-provider-auth' }),
    });
    await until(() => sent.length === 1);
    let failedRunAbortCount = 0;
    const failedRunCtx = {
      sessionManager: { getSessionId: () => 'sess-test' },
      abort: () => { failedRunAbortCount += 1; },
    };
    startBridgeRun(failedRunCtx);
    // Prime Agent 0.7 can expose provider failures only at message_end, with no
    // preceding message_update error for extensions.
    const finalizedFailure = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'provider key sk-must-not-leak was Unauthorized',
      diagnostics: [{ type: 'provider_stream_failure', timestamp: 1 }],
    };
    const replacement = bridge.onMessageEnd({ message: finalizedFailure });

    const firstText = await firstResponse.text();
    expect(firstText).toContain('"type":"error"');
    expect(firstText).toContain('"code":"PRIME_AGENT_PROVIDER_UNAUTHORIZED"');
    expect(firstText).toContain('"type":"final"');
    expect(firstText).not.toContain('must-not-leak');
    expect(firstText).not.toContain('sk-');
    // A terminal provider event must finalize through message_end naturally.
    // Aborting here can re-enter agent_end first and erase the marker that
    // makes the finalized error non-retryable.
    expect(failedRunAbortCount).toBe(0);

    // Some provider failures never produce agent_end. Once message_end has the
    // terminal lifecycle marker, the bridge must admit a successor instead of
    // remaining 429-busy forever.
    const second = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'retry after credentials are fixed', correlationId: 'c-retry' }),
    });
    await until(() => sent.length === 2);
    expect(sent.map(visiblePrompt)).toEqual(['use the provider', 'retry after credentials are fixed']);
    expect(replacement?.message).toMatchObject({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Prime Agent provider authentication failed. Check the configured provider credentials.',
      diagnostics: [
        {
          type: 'agent_lifecycle_failure',
          details: {
            source: 'dkg-bridge',
            reason: 'terminal_bridge_response_settled',
            code: 'PRIME_AGENT_PROVIDER_UNAUTHORIZED',
          },
        },
      ],
    });
    // The finalized message marker makes Prime's retry decision deterministic,
    // so no immediate abort races message_end even though admission reopened.
    expect(failedRunAbortCount).toBe(0);

    // Prime may prepare the queued action before its retry wins the handoff.
    // Its hidden ownership marker is cached on that action and excluded from
    // provider context; it must not be consumed by the intervening retry run.
    const preparedSuccessor = bridge.onBeforeAgentStart({ prompt: sent.at(-1) });
    expect(preparedSuccessor).toBeDefined();
    const providerContext = bridge.onContext({
      messages: [
        { role: 'user', content: [{ type: 'text', text: sent.at(-1) }] },
        { role: 'custom', ...preparedSuccessor!.message },
      ],
    });
    expect(providerContext?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'retry after credentials are fixed' }] },
    ]);

    // Prime auto-retry uses agent.continue(), so it emits no ownership marker.
    // It remains unowned, is aborted, and neither its output nor its end can
    // settle the queued successor.
    let retryAbortCount = 0;
    const retryCtx = {
      sessionManager: { getSessionId: () => 'sess-test' },
      abort: () => { retryAbortCount += 1; },
    };
    bridge.onAgentStart(retryCtx);
    bridge.onBeforeProviderRequest(retryCtx);
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'retry output from failed turn' } });
    bridge.onAgentEnd();
    expect(retryAbortCount).toBe(1);
    const settledByStaleEnd = await Promise.race([
      second.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(settledByStaleEnd).toBe(false);

    startBridgeRun(undefined, preparedSuccessor);
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } });
    bridge.onAgentEnd();
    const secondResponse = await second;
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({ text: 'recovered', correlationId: 'c-retry' });
  });

  it('carries a message_update provider failure into the terminal message_end marker', async () => {
    const failedResponse = await fetch(`${base}/stream`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'stream through the provider', correlationId: 'c-update-error' }),
    });
    await until(() => sent.length === 1);
    let abortCount = 0;
    startBridgeRun({
      sessionManager: { getSessionId: () => 'sess-test' },
      abort: () => { abortCount += 1; },
    });

    bridge.onMessageUpdate({
      assistantMessageEvent: {
        type: 'error',
        error: { errorMessage: 'provider key sk-update-secret was Unauthorized' },
      },
    });
    const replacement = bridge.onMessageEnd({
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'provider key sk-update-secret was Unauthorized',
        diagnostics: [{ type: 'provider_stream_failure', timestamp: 1 }],
      },
    });

    const failedText = await failedResponse.text();
    expect(failedText).toContain('"type":"error"');
    expect(failedText).toContain('"code":"PRIME_AGENT_PROVIDER_UNAUTHORIZED"');
    expect(failedText).not.toContain('update-secret');
    expect(failedText).not.toContain('sk-');
    expect(abortCount).toBe(0);
    expect(replacement?.message).toMatchObject({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Prime Agent provider authentication failed. Check the configured provider credentials.',
      diagnostics: [
        {
          type: 'agent_lifecycle_failure',
          details: {
            source: 'dkg-bridge',
            reason: 'terminal_bridge_response_settled',
            code: 'PRIME_AGENT_PROVIDER_UNAUTHORIZED',
          },
        },
      ],
    });
    expect(replacement?.message.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'provider_stream_failure' })]),
    );

    bridge.onAgentEnd();
    const recovered = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'next real turn', correlationId: 'c-after-update-error' }),
    });
    await until(() => sent.length === 2);
    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'healthy' } });
    bridge.onAgentEnd();
    expect(await recovered.then((response) => response.json())).toMatchObject({
      text: 'healthy',
      correlationId: 'c-after-update-error',
    });
  });

  it('uses a separate hard limit to abort and release a turn that never emits agent_end', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-hard-timeout', {
      turnIdleTimeoutMs: 30,
      turnHardTimeoutMs: 80,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);
    let abortCount = 0;

    const firstPromise = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'hung turn', correlationId: 'c-hard-timeout' }),
    });
    await until(() => sent.length === 1);
    startBridgeRun({
      sessionManager: { getSessionId: () => 'sess-hard-timeout' },
      abort: () => { abortCount += 1; },
    });

    const first = await firstPromise;
    expect(first.status).toBe(504);
    const whileStillRunning = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'too soon', correlationId: 'c-too-soon-hard' }),
    });
    expect(whileStillRunning.status).toBe(429);

    await new Promise((r) => setTimeout(r, 70));
    expect(abortCount).toBe(1);
    // The hard timeout aborts but keeps admission closed until Prime confirms
    // the lifecycle boundary with agent_end.
    bridge.onAgentEnd();
    expect(abortCount).toBe(1);
    const recovered = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'after hard timeout', correlationId: 'c-after-hard' }),
    });
    await until(() => sent.length === 2);
    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'accepted' } });
    bridge.onAgentEnd();
    expect((await recovered).status).toBe(200);
  });

  it('keeps a zombie run closed through its end, then releases a fresh successor', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-stale-events', {
      turnIdleTimeoutMs: 30,
      turnHardTimeoutMs: 80,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    // No abort in ctx: the hard timeout cannot stop this turn, only release it.
    const firstPromise = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'zombie turn', correlationId: 'c-zombie' }),
    });
    await until(() => sent.length === 1);
    startBridgeRun();
    expect((await firstPromise).status).toBe(504);

    await new Promise((r) => setTimeout(r, 90));

    const tooSoon = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'successor', correlationId: 'c-successor' }),
    });
    expect(tooSoon.status).toBe(429);
    expect(sent.map(visiblePrompt)).toEqual(['zombie turn']);

    // The zombie keeps talking after its terminal verdict. It owns no live
    // bridge request, and admission stays closed until its real agent_end.
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'zombie-tail ' } });
    bridge.onMessageUpdate({
      assistantMessageEvent: { type: 'error', reason: 'aborted' },
      message: { role: 'assistant', stopReason: 'aborted' },
    });
    bridge.onAgentEnd();
    await new Promise((r) => setTimeout(r, 0));

    const successor = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'successor', correlationId: 'c-successor' }),
    });
    await until(() => sent.length === 2);
    expect(sent.map(visiblePrompt)).toEqual(['zombie turn', 'successor']);

    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'fresh answer' } });
    bridge.onAgentEnd();
    const res = await successor;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: 'fresh answer', correlationId: 'c-successor' });
  });

  it('does not let an identical local prompt claim the queued bridge action', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-local-race', {
      // This assertion exercises action ownership, not timeout arbitration.
      // Keep both deadlines comfortably outside the observation window so a
      // loaded CI worker cannot legitimately settle the queued request first.
      turnIdleTimeoutMs: 5_000,
      turnHardTimeoutMs: 10_000,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const pending = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'bridge prompt', correlationId: 'c-local-race' }),
    });
    await until(() => sent.length === 1);
    expect(sent.map(visiblePrompt)).toEqual(['bridge prompt']);

    // The local action has the exact same operator-visible text, but it does
    // not carry the bridge's opaque prepared-action tag and gets no marker.
    expect(bridge.onBeforeAgentStart({ prompt: 'bridge prompt' })).toBeUndefined();
    startLocalRun('bridge prompt');
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'local answer' } });
    bridge.onAgentEnd();

    // Neither the local output nor its lifecycle boundary can settle the
    // bridge request that is still queued behind it.
    const settledByLocalFailure = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(settledByLocalFailure).toBe(false);

    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'fresh' } });
    bridge.onAgentEnd();
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: 'fresh', correlationId: 'c-local-race' });
  });

  it('bounds a pre-start async rejection and aborts a prepared action that commits later', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-prestart-timeout', {
      turnIdleTimeoutMs: 5_000,
      turnHardTimeoutMs: 70,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const pending = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'validate me', correlationId: 'c-prestart-timeout' }),
    });
    await until(() => sent.length === 1);

    // Prime may cache before_agent_start metadata and then lose the action to
    // a local handoff. Its public extension send API returns void, so an async
    // validation failure itself is not observable by the bridge.
    const taggedPrompt = sent.at(-1);
    const prepared = bridge.onBeforeAgentStart({ prompt: taggedPrompt });
    expect(prepared).toBeDefined();

    const failed = await pending;
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      code: 'PRIME_AGENT_TURN_TIMEOUT',
      retryable: false,
      correlationId: 'c-prestart-timeout',
    });

    // If the already-prepared action appears after that terminal response, its
    // internal tag is removed before display/persistence and provider I/O is
    // aborted. This rules out a fail-then-execute side effect.
    let abortCount = 0;
    const ctx = {
      sessionManager: { getSessionId: () => 'sess-prestart-timeout' },
      abort: () => { abortCount += 1; },
    };
    const userMessage = {
      role: 'user',
      content: [{ type: 'text', text: taggedPrompt }],
    };
    bridge.onAgentStart(ctx);
    bridge.onMessageStart({ message: userMessage });
    bridge.onMessageStart({ message: { role: 'custom', ...prepared!.message } });
    expect(userMessage.content[0].text).toBe('validate me');
    bridge.onBeforeProviderRequest(ctx);
    expect(abortCount).toBe(1);
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'must not escape' } });
    bridge.onAgentEnd();

    const retry = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'fresh prompt', correlationId: 'c-after-prestart-timeout' }),
    });
    await until(() => sent.length === 2);
    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'fresh answer' } });
    bridge.onAgentEnd();
    expect(await retry.then((res) => res.json())).toMatchObject({ text: 'fresh answer' });
  });

  it('quarantines a stale action no matter which identity carrier is emitted first', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-marker-first', {
      turnIdleTimeoutMs: 5_000,
      turnHardTimeoutMs: 70,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const pending = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'validate me', correlationId: 'c-marker-first' }),
    });
    await until(() => sent.length === 1);
    const taggedPrompt = sent.at(-1);
    const prepared = bridge.onBeforeAgentStart({ prompt: taggedPrompt });
    expect(prepared).toBeDefined();
    expect((await pending).status).toBe(503);

    // Nothing pins which of the two cached carriers Prime emits first. If the
    // marker lands before the tagged user message, the quarantine must not be
    // consumed by the marker and then cleared by the message.
    let abortCount = 0;
    const ctx = {
      sessionManager: { getSessionId: () => 'sess-marker-first' },
      abort: () => { abortCount += 1; },
    };
    const userMessage = { role: 'user', content: [{ type: 'text', text: taggedPrompt }] };
    bridge.onAgentStart(ctx);
    bridge.onMessageStart({ message: { role: 'custom', ...prepared!.message } });
    bridge.onMessageStart({ message: userMessage });
    expect(userMessage.content[0].text).toBe('validate me');
    bridge.onBeforeProviderRequest(ctx);
    expect(abortCount).toBe(1);
    bridge.onAgentEnd();
  });

  it('quarantines when a pending turn fails between its tagged user message and marker', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-between-carriers', {
      turnIdleTimeoutMs: 5_000,
      turnHardTimeoutMs: 70,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const pending = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'validate me', correlationId: 'c-between-carriers' }),
    });
    await until(() => sent.length === 1);
    const taggedPrompt = sent.at(-1);
    const prepared = bridge.onBeforeAgentStart({ prompt: taggedPrompt });
    expect(prepared).toBeDefined();

    let abortCount = 0;
    const ctx = {
      sessionManager: { getSessionId: () => 'sess-between-carriers' },
      abort: () => { abortCount += 1; },
    };
    bridge.onAgentStart(ctx);
    bridge.onMessageStart({
      message: { role: 'user', content: [{ type: 'text', text: taggedPrompt }] },
    });

    // The absolute deadline lands after the own tagged prompt opened the run,
    // but before Prime emits its cached ownership marker. Failure-time
    // provenance must poison the assembling run without relying on the marker.
    expect((await pending).status).toBe(503);
    bridge.onBeforeProviderRequest(ctx);
    expect(abortCount).toBe(1);
    bridge.onAgentEnd();
  });

  it('ignores a replayed historical ownership marker', () => {
    let abortCount = 0;
    const ctx = {
      sessionManager: { getSessionId: () => 'sess-test' },
      abort: () => { abortCount += 1; },
    };
    bridge.onAgentStart(ctx);
    bridge.onMessageStart({
      message: {
        role: 'custom',
        customType: 'dkg.bridge.turn-owner',
        content: '',
        details: { ownershipToken: 'completed-historical-turn' },
      },
    });
    bridge.onBeforeProviderRequest(ctx);
    expect(abortCount).toBe(0);
    bridge.onAgentEnd();
  });

  it('does not let a later user message clear a stale-action quarantine', () => {
    const stalePrompt = '\u2063dkg-bridge-turn:stale-token\u2063dead request';
    let abortCount = 0;
    const ctx = {
      sessionManager: { getSessionId: () => 'sess-test' },
      abort: () => { abortCount += 1; },
    };
    bridge.onAgentStart(ctx);
    bridge.onMessageStart({
      message: { role: 'user', content: [{ type: 'text', text: stalePrompt }] },
    });
    // Prime supports injecting a steer into an active run. It is fresh user
    // content, but cannot make the already-present stale bridge action safe.
    bridge.onMessageStart({
      message: { role: 'user', content: [{ type: 'text', text: 'operator steer' }] },
    });
    bridge.onBeforeProviderRequest(ctx);
    expect(abortCount).toBe(1);
    bridge.onAgentEnd();
  });

  it('quarantines an orphaned tagged action from a predecessor bridge generation', async () => {
    // A queued tagged action can outlive the bridge instance that created it
    // (reload/resume builds a successor with no memory of the token). Its
    // commit must be sanitized and aborted, not executed as an unowned ghost.
    const orphanPrompt = '\u2063dkg-bridge-turn:token-from-a-previous-bridge\u2063do the thing';
    let abortCount = 0;
    const ctx = {
      sessionManager: { getSessionId: () => 'sess-test' },
      abort: () => { abortCount += 1; },
    };
    const userMessage = { role: 'user', content: [{ type: 'text', text: orphanPrompt }] };
    bridge.onAgentStart(ctx);
    bridge.onMessageStart({ message: userMessage });
    expect(userMessage.content[0].text).toBe('do the thing');
    bridge.onBeforeProviderRequest(ctx);
    expect(abortCount).toBe(1);
    bridge.onAgentEnd();

    // A genuinely fresh bridge turn on this generation still recovers.
    const retry = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'fresh prompt', correlationId: 'c-after-orphan' }),
    });
    await until(() => sent.length === 1);
    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'fresh answer' } });
    bridge.onAgentEnd();
    expect(await retry.then((res) => res.json())).toMatchObject({ text: 'fresh answer' });
  });

  it('reports PRIME_AGENT_TURN_TIMEOUT when the hard limit fires while the turn is still live', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-hard-first', {
      turnIdleTimeoutMs: 5_000,
      turnHardTimeoutMs: 80,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);
    let abortCount = 0;

    const pending = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'never ends', correlationId: 'c-hard-first' }),
    });
    await until(() => sent.length === 1);
    startBridgeRun({
      sessionManager: { getSessionId: () => 'sess-hard-first' },
      abort: () => { abortCount += 1; },
    });

    const res = await pending;
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'PRIME_AGENT_TURN_TIMEOUT',
      source: 'prime-agent-channel',
      retryable: false,
      correlationId: 'c-hard-first',
    });
    expect(body.error).toContain('hard limit');
    expect(abortCount).toBe(1);
  });

  it('shapes the /send 503 provider-failure body exactly as the daemon allowlist parses it', async () => {
    const pending = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'use the provider', correlationId: 'c-send-auth' }),
    });
    await until(() => sent.length === 1);
    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'partial ' } });
    bridge.onMessageUpdate({
      assistantMessageEvent: {
        type: 'error',
        reason: 'error',
        error: { errorMessage: 'Unauthorized: provider key sk-must-not-leak' },
      },
    });

    const res = await pending;
    expect(res.status).toBe(503);
    const body = await res.json();
    // The daemon's sanitizedPrimeAgentBridgeFailure reads the top-level `code`
    // of this body, and its terminal branch forwards `text`; this pins the
    // producer half of that wire contract.
    expect(body).toMatchObject({
      code: 'PRIME_AGENT_PROVIDER_UNAUTHORIZED',
      source: 'prime-agent-channel',
      retryable: false,
      text: 'partial ',
      correlationId: 'c-send-auth',
      sessionId: 'sess-test',
    });
    const rawBody = JSON.stringify(body);
    expect(rawBody).not.toContain('must-not-leak');
    expect(rawBody).not.toContain('sk-');
    bridge.onAgentEnd();
  });

  it('fails fast with PRIME_AGENT_DELIVERY_FAILED when injection throws, then recovers fully', async () => {
    await bridge.stop();
    let rejectNext = true;
    bridge = new SessionBridge(stubPi((t) => {
      if (rejectNext) {
        rejectNext = false;
        throw new Error('session rejected the message');
      }
      sent.push(t);
    }) as never, 'sess-delivery');
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const failed = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'undeliverable', correlationId: 'c-deliver' }),
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      code: 'PRIME_AGENT_DELIVERY_FAILED',
      retryable: false,
      correlationId: 'c-deliver',
    });

    // No agent turn ever started, so a synchronous delivery rejection creates
    // no failed-run quarantine and the next admitted prompt can own its run.
    const retry = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'deliverable', correlationId: 'c-deliver-2' }),
    });
    await until(() => sent.length === 1);
    expect(sent.map(visiblePrompt)).toEqual(['deliverable']);
    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'delivered' } });
    bridge.onAgentEnd();
    const res = await retry;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: 'delivered', correlationId: 'c-deliver-2' });
  });

  it('only emits verified text_delta events, not thinking or cumulative snapshots', async () => {
    const pending = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'filter events', correlationId: 'c-filter' }),
    });
    await until(() => sent.length === 1);
    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: 'secret' } });
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_end', text: 'cumulative' } });
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'visible' } });
    bridge.onAgentEnd();
    const response = await pending;
    expect(await response.json()).toMatchObject({ text: 'visible' });
  });
});

describe('/stream', () => {
  it('keeps a non-text turn alive without exposing thinking or tool-call content', async () => {
    await bridge.stop();
    bridge = new SessionBridge(
      stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never,
      'sess-keepalive',
      { sseKeepaliveIntervalMs: 20 },
    );
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const res = await fetch(`${base}/stream`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'work silently', correlationId: 'c-keepalive' }),
    });
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain(': open');
    await until(() => sent.length === 1);
    startBridgeRun();

    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden reasoning' } });
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'toolcall_delta', delta: 'secret tool args' } });

    const heartbeat = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 150)),
    ]);
    expect(heartbeat).toBeDefined();
    const heartbeatText = decoder.decode(heartbeat?.value);
    expect(heartbeatText).toContain(': keepalive');
    expect(heartbeatText).not.toContain('hidden reasoning');
    expect(heartbeatText).not.toContain('secret tool args');

    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'visible' } });
    bridge.onAgentEnd();
    const remainder: string[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder.push(decoder.decode(chunk.value));
    }
    expect(remainder.join('')).toContain('"type":"final"');
    expect(remainder.join('')).toContain('visible');
  });

  it('stops the keepalive interval when the downstream stream disconnects', async () => {
    await bridge.stop();
    bridge = new SessionBridge(
      stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never,
      'sess-keepalive-disconnect',
      { sseKeepaliveIntervalMs: 20 },
    );
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const controller = new AbortController();
      const res = await fetch(`${base}/stream`, {
        method: 'POST',
        headers: authed(),
        body: JSON.stringify({ text: 'disconnect me', correlationId: 'c-disconnect' }),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      await reader.read(); // consume `: open` so the body is actively observed
      const keepaliveTimer = setIntervalSpy.mock.results.at(-1)?.value;
      expect(keepaliveTimer).toBeDefined();

      controller.abort();
      await reader.read().catch(() => undefined);
      await until(() => clearIntervalSpy.mock.calls.some(([timer]) => timer === keepaliveTimer));
      const health = await fetch(`${base}/health`, { headers: authed() }).then((response) => response.json());
      expect(health).toMatchObject({
        ok: true,
        busy: true,
        turnState: 'queued',
        clientConnected: false,
      });
      expect(health.clientDisconnectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Several keepalive intervals with the subscriber gone must not write to
      // the dead response or keep an interval alive. The Prime turn itself is
      // not cancelled and still settles at its real lifecycle boundary.
      await new Promise((r) => setTimeout(r, 70));
      startBridgeRun();
      bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'unseen tail' } });
      bridge.onAgentEnd();

      const next = fetch(`${base}/send`, {
        method: 'POST',
        headers: authed(),
        body: JSON.stringify({ text: 'after abort', correlationId: 'c-after-abort' }),
      });
      await until(() => sent.length === 2);
      startBridgeRun();
      bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'accepted' } });
      bridge.onAgentEnd();
      const recovered = await next;
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ text: 'accepted', correlationId: 'c-after-abort' });
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('emits data: <json> frames of delta then final', async () => {
    const res = await fetch(`${base}/stream`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'stream please', correlationId: 'c-s' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    await until(() => sent.length === 1);
    startBridgeRun();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'alpha' } });
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'beta' } });
    bridge.onAgentEnd();

    const text = await res.text();
    const frames = text
      .split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.slice(6)));

    expect(frames.filter((f) => f.type === 'delta').map((f) => f.text)).toEqual(['alpha', 'beta']);
    const final = frames.find((f) => f.type === 'final');
    expect(final).toMatchObject({ type: 'final', text: 'alphabeta', correlationId: 'c-s' });
  });
});

describe('unknown routes', () => {
  it('404s', async () => {
    const res = await fetch(`${base}/nope`, { headers: authed() });
    expect(res.status).toBe(404);
  });
});
