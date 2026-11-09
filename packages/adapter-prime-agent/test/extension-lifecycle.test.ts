import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dkgBridgeExtension, { SessionBridge, sessionsDir, stateDir } from '../extension/src/extension.js';

type Host = Parameters<typeof dkgBridgeExtension>[0];
type Handler = Parameters<Host['on']>[1];
const token = 'factory-test-token';
const ctx = { sessionManager: { getSessionId: () => 'factory-session' }, abort: vi.fn() };
let root: string;
let handlers: Map<string, Handler>;
let host: Host;
const emit = (name: string, event: unknown = {}) => {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`missing ${name} handler`);
  return handler(event, ctx);
};
const descriptorPath = () => join(sessionsDir(), 'factory-session.json');
const bridgeUrl = () => JSON.parse(readFileSync(descriptorPath(), 'utf8')).bridgeUrl as string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prime-factory-'));
  vi.stubEnv('PRIME_AGENT_CODING_AGENT_DIR', root);
  vi.stubEnv('DKG_BRIDGE_TOKEN', token);
  handlers = new Map();
  host = { on: (name, handler) => {
    expect(handlers.has(name)).toBe(false);
    handlers.set(name, handler);
  }, sendUserMessage: vi.fn() };
  ctx.abort.mockClear();
  dkgBridgeExtension(host);
});

afterEach(async () => {
  await emit('session_shutdown');
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('host extension lifecycle', () => {
  it('registers every hook without sending messages or touching disk before session binding', async () => {
    expect([...handlers.keys()].sort()).toEqual([
      'agent_end', 'agent_start', 'before_agent_start', 'before_provider_request', 'context',
      'input', 'message_end', 'message_start', 'message_update', 'session_shutdown', 'session_start',
    ]);
    expect(host.sendUserMessage).not.toHaveBeenCalled();
    expect(existsSync(stateDir())).toBe(false);
    expect(emit('input', { text: 'hello', source: 'terminal' })).toEqual({ action: 'continue' });
    for (const name of ['message_update', 'message_end', 'before_agent_start', 'agent_start', 'message_start', 'context', 'before_provider_request', 'agent_end']) {
      expect(emit(name)).toBeUndefined();
    }
    await emit('session_shutdown');
    expect(existsSync(stateDir())).toBe(false);
  });

  it.each(['quit', 'reload', 'fork', 'resume', 'new'])('closes and unpublishes the bridge on %s and allows a successor', async reason => {
    await emit('session_start');
    const base = bridgeUrl();
    const health = await fetch(`${base}/health`, { headers: { 'x-dkg-bridge-token': token } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, sessionId: 'factory-session', pid: process.pid, busy: false });
    await emit('session_shutdown', { reason });
    expect(existsSync(descriptorPath())).toBe(false);
    await expect(fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    expect(emit('input', { text: 'after shutdown' })).toEqual({ action: 'continue' });
    await emit('session_start');
    const successor = await fetch(`${bridgeUrl()}/health`, { headers: { 'x-dkg-bridge-token': token } });
    expect(successor.status).toBe(200);
    expect(await successor.json()).toMatchObject({ sessionId: 'factory-session', busy: false });
  });

  it('contains descriptor publication failures and keeps the host usable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(stateDir(), 'not a directory');
    await expect(Promise.resolve(emit('session_start'))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('[dkg-bridge] failed to start:');
    expect(existsSync(descriptorPath())).toBe(false);
    expect(emit('input')).toEqual({ action: 'continue' });
    rmSync(stateDir());
    await emit('session_start');
    expect(existsSync(descriptorPath())).toBe(true);
  });

  it('delivers a real HTTP turn through registered host hooks and strips transport metadata', async () => {
    let delivered!: (prompt: string) => void;
    const delivery = new Promise<string>(resolve => { delivered = resolve; });
    host.sendUserMessage = vi.fn(prompt => {
      expect(emit('input', { source: 'extension', text: prompt })).toEqual({ action: 'continue' });
      delivered(prompt);
    });
    await emit('session_start');
    const response = fetch(`${bridgeUrl()}/send`, {
      method: 'POST', headers: { 'x-dkg-bridge-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'question', correlationId: 'factory-turn' }),
      signal: AbortSignal.timeout(5_000),
    });
    const prompt = await delivery;
    const prepared = emit('before_agent_start', { prompt }) as NonNullable<ReturnType<SessionBridge['onBeforeAgentStart']>>;
    expect(prepared.message).toMatchObject({ display: false, customType: 'dkg.bridge.turn-owner' });
    emit('agent_start');
    const message = { role: 'user', content: prompt };
    emit('message_start', { message });
    expect(message.content).toBe('question');
    emit('message_start', { message: { role: 'custom', ...prepared.message } });
    expect(emit('context', { messages: [{ role: 'user', content: prompt }, { role: 'custom', ...prepared.message }] }))
      .toEqual({ messages: [{ role: 'user', content: 'question' }] });
    emit('before_provider_request');
    expect(ctx.abort).not.toHaveBeenCalled();
    emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'private thought' } });
    emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
    expect(emit('message_end', { message: { role: 'assistant', stopReason: 'stop' } })).toBeUndefined();
    emit('agent_end');
    const reply = await response;
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ text: 'answer', correlationId: 'factory-turn', sessionId: 'factory-session' });
  });

  it('reads the private config token when no environment token exists and rejects empty tokens', async () => {
    vi.stubEnv('DKG_BRIDGE_TOKEN', '');
    mkdirSync(stateDir());
    const path = join(stateDir(), 'dkg.json');
    writeFileSync(path, JSON.stringify({ bridge_token: ` ${token} ` }));
    await emit('session_start');
    const base = bridgeUrl();
    const accepted = await fetch(`${base}/health`, { headers: { 'x-dkg-bridge-token': token } });
    expect(accepted.status).toBe(200);
    await accepted.arrayBuffer();
    writeFileSync(path, JSON.stringify({ bridge_token: ' ' }));
    const rejected = await fetch(`${base}/health`, { headers: { 'x-dkg-bridge-token': token } });
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: 'Bridge auth token unavailable' });
  });
});

describe('provider context sanitization', () => {
  it('preserves ordinary and malformed content while stripping only the first valid tagged block', () => {
    const bridge = new SessionBridge(host, 'context-only');
    const tag = '\u2063dkg-bridge-turn:owner\u2063';
    const input = [
      { role: 'user', content: `${tag}plain` },
      { role: 'user', content: [null, 7, { type: 'image', data: 'image' }, { type: 'text', text: 'ordinary' }, { type: 'text', text: `${tag}blocks`, extra: true }, { type: 'text', text: 'trailing' }] },
      { role: 'assistant', content: `${tag}assistant text` },
      { role: 'user', content: 42 },
      { role: 'user', content: '\u2063dkg-bridge-turn:missing-separator' },
      { role: 'user', content: '\u2063dkg-bridge-turn:\u2063empty-owner' },
    ];
    const before = structuredClone(input);
    expect(bridge.onContext({ messages: input })).toEqual({ messages: [
      { role: 'user', content: 'plain' },
      { role: 'user', content: [null, 7, { type: 'image', data: 'image' }, { type: 'text', text: 'ordinary' }, { type: 'text', text: 'blocks', extra: true }, { type: 'text', text: 'trailing' }] },
      ...input.slice(2),
    ] });
    expect(input).toEqual(before);
    expect(bridge.onContext({})).toBeUndefined();
    expect(bridge.onContext({ messages: input.slice(2) })).toBeUndefined();
  });
});
