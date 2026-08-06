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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionBridge, tokenMatches } from '../extension/src/extension.js';

const TOKEN = 'test-bridge-token-value';
let workDir: string;
let bridge: SessionBridge;
let sent: string[];
let sendOptions: Array<{ deliverAs?: 'steer' | 'followUp' } | undefined>;
let base: string;

/** Minimal stand-in for the host ExtensionAPI surface the bridge uses. */
function stubPi(onSend: (text: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void) {
  return {
    on: () => {},
    sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => onSend(content, options),
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
    bridge.onAgentStart();
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
    expect(sent).toEqual(['hello agent']);

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
    bridge.onAgentStart();
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

    const first = await fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'long turn', correlationId: 'c-timeout' }),
    });
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

  it('releases a provider-auth failure, sanitizes it, and ignores the failed turn late agent_end', async () => {
    const firstResponse = await fetch(`${base}/stream`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'use the provider', correlationId: 'c-provider-auth' }),
    });
    await new Promise((r) => setTimeout(r, 20));
    bridge.onAgentStart();
    bridge.onMessageUpdate({
      assistantMessageEvent: {
        type: 'error',
        reason: 'error',
        error: {
          errorMessage: '{"error":{"message":"Unauthorized","providerToken":"must-not-leak"}}',
        },
      },
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'provider key sk-must-not-leak was Unauthorized',
      },
    });

    const firstText = await firstResponse.text();
    expect(firstText).toContain('"type":"error"');
    expect(firstText).toContain('"code":"PRIME_AGENT_PROVIDER_UNAUTHORIZED"');
    expect(firstText).toContain('"type":"final"');
    expect(firstText).not.toContain('must-not-leak');
    expect(firstText).not.toContain('sk-');

    // Start the successor before Prime emits the failed turn's late agent_end.
    // That stale event must be consumed without resolving this new request.
    const second = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'retry after credentials are fixed', correlationId: 'c-retry' }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(['use the provider', 'retry after credentials are fixed']);
    bridge.onAgentEnd();
    const settledByStaleEnd = await Promise.race([
      second.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    expect(settledByStaleEnd).toBe(false);

    bridge.onAgentStart();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } });
    bridge.onAgentEnd();
    const secondResponse = await second;
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({ text: 'recovered', correlationId: 'c-retry' });
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
    await new Promise((r) => setTimeout(r, 10));
    bridge.onAgentStart({
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
    const recovered = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'after hard timeout', correlationId: 'c-after-hard' }),
    });
    await new Promise((r) => setTimeout(r, 20));
    bridge.onAgentStart();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'accepted' } });
    bridge.onAgentEnd();
    expect((await recovered).status).toBe(200);
  });

  it('discards a zombie turn stale deltas and abort error so they never touch the successor', async () => {
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
    bridge.onAgentStart();
    expect((await firstPromise).status).toBe(504);

    await new Promise((r) => setTimeout(r, 90));

    const successor = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'successor', correlationId: 'c-successor' }),
    });
    await until(() => sent.length === 2);
    expect(sent).toEqual(['zombie turn', 'successor']);
    // The zombie keeps talking before the successor's agent_start: trailing
    // deltas, an abort's own error frame, then its agent_end. None of it may
    // contaminate, fail, or settle the successor request.
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'zombie-tail ' } });
    bridge.onMessageUpdate({
      assistantMessageEvent: { type: 'error', reason: 'aborted' },
      message: { role: 'assistant', stopReason: 'aborted' },
    });
    bridge.onAgentEnd();

    bridge.onAgentStart();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'fresh answer' } });
    bridge.onAgentEnd();
    const res = await successor;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: 'fresh answer', correlationId: 'c-successor' });
  });

  it('keeps a queued successor alive on zombie liveness instead of spuriously idling it out', async () => {
    await bridge.stop();
    bridge = new SessionBridge(stubPi((t, options) => { sent.push(t); sendOptions.push(options); }) as never, 'sess-zombie-liveness', {
      turnIdleTimeoutMs: 80,
      turnHardTimeoutMs: 400,
    });
    await bridge.start();
    base = await bridgeBaseUrl(bridge);

    const firstPromise = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'zombie turn', correlationId: 'c-liveness-zombie' }),
    });
    await until(() => sent.length === 1);
    bridge.onAgentStart();
    expect((await firstPromise).status).toBe(504);
    await new Promise((r) => setTimeout(r, 340));

    // Successor admitted while the zombie is still draining. Its idle window
    // (80ms) is shorter than the zombie's remaining run (5 x 25ms): the
    // discarded deltas must still count as liveness, or the successor 504s
    // while its queued message later executes invisibly.
    const successor = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'queued successor', correlationId: 'c-liveness-succ' }),
    });
    await until(() => sent.length === 2);
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'zombie noise' } });
    }
    bridge.onAgentEnd();

    bridge.onAgentStart();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'fresh' } });
    bridge.onAgentEnd();
    const res = await successor;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: 'fresh', correlationId: 'c-liveness-succ' });
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
    bridge.onAgentStart({
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
    bridge.onAgentStart();
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

    // No agent turn ever started, so the stale-event guard set by the failure
    // must not swallow the next real turn's events.
    const retry = fetch(`${base}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'deliverable', correlationId: 'c-deliver-2' }),
    });
    await until(() => sent.length === 1);
    expect(sent).toEqual(['deliverable']);
    bridge.onAgentStart();
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
    await new Promise((r) => setTimeout(r, 30));
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'thinking_delta', delta: 'secret' } });
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_end', text: 'cumulative' } });
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'visible' } });
    bridge.onAgentEnd();
    const response = await pending;
    expect(await response.json()).toMatchObject({ text: 'visible' });
  });
});

describe('/stream', () => {
  it('emits data: <json> frames of delta then final', async () => {
    const res = await fetch(`${base}/stream`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'stream please', correlationId: 'c-s' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    await new Promise((r) => setTimeout(r, 30));
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
