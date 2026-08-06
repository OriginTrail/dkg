/**
 * The Stage-1 gate: the extension's bridge must satisfy the contract the DKG
 * daemon already speaks, with no Prime Agent running. We drive `SessionBridge`
 * directly with a stub `pi`, so this asserts OUR half of the wire independent
 * of upstream.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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
