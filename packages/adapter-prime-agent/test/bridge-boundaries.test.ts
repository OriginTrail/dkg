import * as fs from 'node:fs';
import * as http from 'node:http';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionBridge, sessionsDir } from '../extension/src/extension.js';
import { createBridgeHost, commitBridgeRun } from './bridge-host-support.js';

// Keep real files and loopback HTTP; inject failures only at OS boundaries.
vi.mock('node:fs', async (original) => ({ ...await original<typeof fs>() }));
vi.mock('node:http', async (original) => ({ ...await original<typeof http>() }));

const token = 'boundary-test-token';
const headers = { 'x-dkg-bridge-token': token, 'content-type': 'application/json' };
const realDelay = globalThis.setTimeout;
let root: string;
let bridge: SessionBridge;
let server: http.Server;
let response: http.ServerResponse | undefined;
let base: string;
let sent: string[];

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('HTTP boundary was not reached');
    await new Promise(resolve => realDelay(resolve, 2));
  }
}

async function start(options: ConstructorParameters<typeof SessionBridge>[2] = {}) {
  bridge = new SessionBridge(createBridgeHost(() => bridge, text => sent.push(text)), 'boundary-session', options);
  await bridge.start();
  base = JSON.parse(fs.readFileSync(join(sessionsDir(), 'boundary-session.json'), 'utf8')).bridgeUrl;
}

function commit(abort?: () => void) {
  return commitBridgeRun(bridge, { prompt: sent.at(-1), userContent: 'string',
    context: { sessionManager: { getSessionId: () => bridge.sessionId }, abort } });
}

function send(path = '/send', body: unknown = { text: 'answer this', correlationId: 'boundary' }) {
  return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const health = () => fetch(`${base}/health`, { headers }).then(res => res.json());
const frames = (text: string) => text.split('\n\n').filter(frame => frame.startsWith('data: '))
  .map(frame => JSON.parse(frame.slice(6)));

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'prime-boundaries-'));
  vi.stubEnv('PRIME_AGENT_CODING_AGENT_DIR', root);
  vi.stubEnv('DKG_BRIDGE_TOKEN', token);
  sent = [];
  response = undefined;
  const createServer = http.createServer;
  vi.spyOn(http, 'createServer').mockImplementation((...args: Parameters<typeof http.createServer>) => {
    server = createServer(...args);
    server.on('request', (_req, res) => { response = res; });
    return server;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await bridge?.stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bridge lifecycle and filesystem boundaries', () => {
  it('uses the default agent directory when no override is set', () => {
    vi.stubEnv('PRIME_AGENT_CODING_AGENT_DIR', undefined);
    expect(sessionsDir()).toBe(join(homedir(), '.prime', 'agent', '.dkg-adapter-prime-agent', 'sessions'));
  });

  it('can stop before binding, and ignores host activity after shutdown', async () => {
    bridge = new SessionBridge({ on: () => {}, sendUserMessage: vi.fn() }, 'never-bound');
    bridge.onAgentStart();
    bridge.onAgentEnd();
    await bridge.stop();
    await bridge.stop();
    bridge.onAgentStart();
    expect(fs.existsSync(sessionsDir())).toBe(false);
  });

  it('closes a bound listener if the OS cannot supply its address', async () => {
    vi.spyOn(http.Server.prototype, 'address').mockReturnValueOnce(null);
    await expect(start()).rejects.toThrow('bridge failed to acquire a loopback port');
    expect(server.listening).toBe(false);
    expect(fs.existsSync(sessionsDir())).toBe(false);
  });

  it('unpublishes a descriptor on an asynchronous server error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await start();
    server.emit('error', new Error('fixture listener failure'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fixture listener failure'));
    expect(fs.existsSync(join(sessionsDir(), 'boundary-session.json'))).toBe(false);
    await bridge.stop();
    expect(server.listening).toBe(false);
  });

  it('preserves the previous descriptor when activity republication fails', async () => {
    await start();
    const path = join(sessionsDir(), 'boundary-session.json');
    const original = fs.readFileSync(path, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    const pending = send();
    await until(() => sent.length === 1);
    commit();
    expect(fs.readFileSync(path, 'utf8')).toBe(original);
    expect(fs.readdirSync(sessionsDir())).toEqual(['boundary-session.json']);
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'still works' } });
    bridge.onAgentEnd();
    expect(await (await pending).json()).toMatchObject({ text: 'still works' });
  });

  it('still closes the listener when descriptor cleanup fails', async () => {
    await start();
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('read-only directory'); });
    await bridge.stop();
    expect(server.listening).toBe(false);
    expect(fs.existsSync(join(sessionsDir(), 'boundary-session.json'))).toBe(true);
  });

  it('handles invalid sibling PIDs, permission-protected processes and a concurrent removal', async () => {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    for (const [name, pid] of [['invalid', -1], ['protected', 1234], ['vanished', 4321]] as const) {
      const file = join(sessionsDir(), `${name}.json`);
      fs.writeFileSync(file, JSON.stringify({ pid }));
      fs.utimesSync(file, old, old);
    }
    const kill = vi.spyOn(process, 'kill').mockImplementation(pid => {
      throw Object.assign(new Error('fixture process check'), { code: pid === 1234 ? 'EPERM' : 'ESRCH' });
    });
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path).endsWith('vanished.json')) {
        fs.rmSync(path);
        throw Object.assign(new Error('concurrent removal'), { code: 'ENOENT' });
      }
      return Reflect.apply(stat, fs, [path, ...args]);
    }) as typeof fs.statSync);
    await start();
    expect(fs.readdirSync(sessionsDir()).sort()).toEqual(['boundary-session.json', 'protected.json']);
    expect(kill).not.toHaveBeenCalledWith(-1, 0);
    expect(kill).toHaveBeenCalledWith(1234, 0);
    expect(await health()).toMatchObject({ ok: true, busy: false });
  });
});

describe('request and host-event boundaries', () => {
  it.each([{}, { text: 42, correlationId: 'id' }, { text: ' \n ', correlationId: 'id' }, { text: 'ok', correlationId: 7 }])(
    'rejects incomplete input without admitting a turn: %j', async (payload) => {
      await start();
      const result = await send('/send', payload);
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: 'Missing "text" or "correlationId"' });
      expect(sent).toEqual([]);
      expect(await health()).toMatchObject({ busy: false });
    },
  );

  it('rejects a body over the byte limit and remains available for the next request', async () => {
    await start();
    await expect(send('/send', { text: 'x'.repeat(1_000_001), correlationId: 'large' })).rejects.toThrow();
    expect(sent).toEqual([]);
    expect(await health()).toMatchObject({ ok: true, busy: false });
  });

  it('ignores incomplete host events and never exposes malformed text deltas', async () => {
    await start();
    for (const input of [{}, { source: 'extension' }, { source: 'terminal', text: 'local' }, { source: 'extension', text: 'other extension' }]) {
      expect(bridge.onInput(input)).toEqual({ action: 'continue' });
    }
    expect(bridge.onInput({ source: 'extension', text: '\u2063dkg-bridge-turn:expired\u2063old' }))
      .toEqual({ action: 'handled' });
    const pending = send();
    await until(() => sent.length === 1);
    const prepared = commit();
    bridge.onMessageStart({});
    bridge.onMessageStart({ message: { role: 'custom', customType: 'dkg.bridge.turn-owner' } });
    bridge.onMessageStart({ message: { role: 'custom', ...prepared.message } });
    for (const event of [{}, { assistantMessageEvent: { type: 'text_delta' } }, { assistantMessageEvent: { type: 'text_delta', delta: '' } }]) {
      bridge.onMessageUpdate(event);
    }
    expect(bridge.onMessageEnd({})).toBeUndefined();
    bridge.onAgentEnd();
    const result = await pending;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ text: '', correlationId: 'boundary', sessionId: 'boundary-session' });
  });

  it('does not duplicate an existing lifecycle diagnostic on a terminal provider failure', async () => {
    await start();
    const pending = send();
    await until(() => sent.length === 1);
    commit();
    const lifecycle = { type: 'agent_lifecycle_failure', timestamp: 123, details: { reason: 'already terminal' } };
    const result = bridge.onMessageEnd({ message: {
      role: 'assistant', stopReason: 'error', errorMessage: 'secret provider payload',
      diagnostics: [{ type: 'provider_stream_failure', timestamp: 122 }, lifecycle],
    } });
    expect(result?.message.diagnostics).toEqual([lifecycle]);
    expect(result?.message.errorMessage).not.toContain('secret provider payload');
    expect((await pending).status).toBe(503);
    expect(await health()).toMatchObject({ busy: false });
  });
});

describe('stream terminal outcomes', () => {
  it('emits a sanitized provider error and final partial text, with heartbeats disabled', async () => {
    await start({ sseKeepaliveIntervalMs: 0 });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const result = await send('/stream');
    await until(() => sent.length === 1);
    commit();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'error', error: { errorMessage: 'secret-token' } } });
    const text = await result.text();
    expect(interval).not.toHaveBeenCalled();
    expect(text).not.toContain('secret-token');
    expect(frames(text)).toEqual([
      { type: 'delta', text: 'partial', correlationId: 'boundary' },
      expect.objectContaining({ type: 'error', source: 'prime-agent-channel', retryable: false, correlationId: 'boundary' }),
      { type: 'final', text: 'partial', correlationId: 'boundary', sessionId: 'boundary-session', timedOut: false },
    ]);
  });

  it('drops a subscriber and stops heartbeats when a downstream write throws', async () => {
    await start({ sseKeepaliveIntervalMs: 100 });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const result = await send('/stream');
    await until(() => sent.length === 1);
    const streamResponse = response!;
    const write = streamResponse.write.bind(streamResponse);
    const failedWrite = vi.spyOn(streamResponse, 'write').mockImplementation(((chunk: unknown, ...args: unknown[]) => {
      if (chunk === ': keepalive\n\n') throw new Error('downstream socket failed');
      return Reflect.apply(write, streamResponse, [chunk, ...args]);
    }) as typeof streamResponse.write);
    await vi.advanceTimersByTimeAsync(100);
    expect(await health()).toMatchObject({ clientConnected: false, busy: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failedWrite).toHaveBeenCalledTimes(1);
    failedWrite.mockRestore();
    commit();
    bridge.onAgentEnd();
    expect(frames(await result.text())).toEqual([
      { type: 'final', text: '', correlationId: 'boundary', sessionId: 'boundary-session' },
    ]);
  });

  it('closes an outstanding stream and clears turn timers on shutdown', async () => {
    await start({ turnIdleTimeoutMs: 120_000, turnHardTimeoutMs: 240_000, sseKeepaliveIntervalMs: 30_000 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const scheduleTimeout = vi.spyOn(globalThis, 'setTimeout');
    const scheduleInterval = vi.spyOn(globalThis, 'setInterval');
    const clearTimeout = vi.spyOn(globalThis, 'clearTimeout');
    const clearInterval = vi.spyOn(globalThis, 'clearInterval');
    const result = await send('/stream');
    // Observe socket failure immediately: shutdown intentionally closes all HTTP
    // connections, so delivery of a terminal frame is not guaranteed.
    const drained = result.text().then(() => 'ended', () => 'closed');
    await until(() => sent.length === 1);
    commit();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
    const idleIndex = scheduleTimeout.mock.calls.map(([, ms], index) => ms === 120_000 ? index : -1).filter(index => index >= 0).at(-1)!;
    const hardIndex = scheduleTimeout.mock.calls.findIndex(([, ms]) => ms === 240_000);
    const intervalIndex = scheduleInterval.mock.calls.findIndex(([, ms]) => ms === 30_000);
    const idle = scheduleTimeout.mock.results[idleIndex]?.value;
    const hard = scheduleTimeout.mock.results[hardIndex]?.value;
    const heartbeat = scheduleInterval.mock.results[intervalIndex]?.value;
    expect(idle).toBeDefined(); expect(hard).toBeDefined(); expect(heartbeat).toBeDefined();
    // Ignore cancellation caused by the earlier delta resetting its idle timer.
    clearTimeout.mockClear(); clearInterval.mockClear();
    await bridge.stop();
    expect(['ended', 'closed']).toContain(await drained);
    expect(server.listening).toBe(false);
    expect(fs.existsSync(join(sessionsDir(), 'boundary-session.json'))).toBe(false);
    expect(clearTimeout).toHaveBeenCalledWith(idle);
    expect(clearTimeout).toHaveBeenCalledWith(hard);
    expect(clearInterval).toHaveBeenCalledExactlyOnceWith(heartbeat);
    bridge.onAgentEnd();
    await bridge.stop();
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it('ends an idle stream with a timeout and does not release the live agent early', async () => {
    await start({ turnIdleTimeoutMs: 100, turnHardTimeoutMs: 1_000, sseKeepaliveIntervalMs: 0 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = await send('/stream');
    await until(() => sent.length === 1);
    commit();
    bridge.onMessageUpdate({ assistantMessageEvent: { type: 'text_delta', delta: 'partial' } });
    await vi.advanceTimersByTimeAsync(100);
    expect(frames(await result.text())).toEqual([
      { type: 'delta', text: 'partial', correlationId: 'boundary' },
      { type: 'error', error: 'Prime Agent turn idle for 100ms', source: 'prime-agent-channel', retryable: false, correlationId: 'boundary' },
      { type: 'final', text: 'partial', correlationId: 'boundary', sessionId: 'boundary-session', timedOut: true },
    ]);
    expect(await health()).toMatchObject({ busy: true });
    bridge.onAgentEnd();
    expect(await health()).toMatchObject({ busy: false });
  });

  it('quarantines a timed-out run even when the host abort callback throws', async () => {
    await start({ turnIdleTimeoutMs: 1_000, turnHardTimeoutMs: 100 });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = send();
    await until(() => sent.length === 1);
    const abort = vi.fn(() => { throw new Error('host abort failed'); });
    commit(abort);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe(503);
    expect(abort).toHaveBeenCalledOnce();
    bridge.onAgentEnd();
    bridge.onAgentStart({ sessionManager: { getSessionId: () => bridge.sessionId }, abort });
    bridge.onBeforeProviderRequest();
    expect(abort).toHaveBeenCalledTimes(2);
    bridge.onAgentEnd();
    expect(await health()).toMatchObject({ busy: false });
  });
});
