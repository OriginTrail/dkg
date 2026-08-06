/**
 * Host-contract integration: the BUILT extension bundle running inside the
 * fake Prime Agent host (`test-fixtures/fake-prime-agent-host.mjs`), a real
 * child process. Everything is real except the LLM — process boundary, pid
 * liveness, loopback HTTP bridge, descriptor files — so this asserts the
 * adapter's cross-process contract end to end, including the token chain from
 * the DKG home's auth.token through setup's dkg.json into the bridge, with no
 * env-var injection anywhere.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrimeAgentSessionDescriptor } from '../src/types.js';
import { isProcessAlive, readLiveSessions, sessionDescriptorPath } from '../src/session-registry.js';
import { ADAPTER_CONFIG_FILENAME, resolvePrimeAgentProfile, setupPrimeAgentProfile } from '../src/setup.js';

const FIXTURE = fileURLToPath(new URL('../test-fixtures/fake-prime-agent-host.mjs', import.meta.url));
const BUNDLE = fileURLToPath(new URL('../extension/dist/extension.js', import.meta.url));
const TOKEN = 'auth-token-provisioned-in-dkg-home';

interface HostEvent {
  evt: string;
  [k: string]: unknown;
}

/** Env the child must not inherit: the whole point is the file-based chain. */
const SCRUBBED_ENV_KEYS = [
  'DKG_BRIDGE_TOKEN',
  'DKG_API_TOKEN',
  'DKG_AUTH_TOKEN',
  'PRIME_AGENT_CODING_AGENT_DIR',
] as const;

// Safety net: SIGKILL anything still running if the worker dies mid-test.
const liveChildren = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

class FakeHost {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #backlog: HostEvent[] = [];
  #waiters: Array<{ match: (e: HostEvent) => boolean; resolve: (e: HostEvent) => void }> = [];
  #stderr = '';
  #buffer = '';

  constructor(agentDir: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: agentDir };
    for (const key of SCRUBBED_ENV_KEYS) {
      if (key !== 'PRIME_AGENT_CODING_AGENT_DIR') delete env[key];
    }
    this.child = spawn(process.execPath, [FIXTURE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    liveChildren.add(this.child);
    this.child.stdout!.setEncoding('utf8');
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => {
      this.#stderr += chunk;
    });
    this.child.stdout!.on('data', (chunk: string) => this.#onStdout(chunk));
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        liveChildren.delete(this.child);
        resolve({ code, signal });
      });
    });
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (!line) continue;
      let event: HostEvent;
      try {
        event = JSON.parse(line) as HostEvent;
      } catch {
        continue;
      }
      const at = this.#waiters.findIndex((w) => w.match(event));
      if (at !== -1) this.#waiters.splice(at, 1)[0].resolve(event);
      else this.#backlog.push(event);
    }
  }

  send(cmd: Record<string, unknown>): void {
    this.child.stdin!.write(`${JSON.stringify(cmd)}\n`);
  }

  /** Event-driven: resolves from the backlog or on arrival, never by polling. */
  waitFor(match: (e: HostEvent) => boolean, label: string, timeoutMs = 10_000): Promise<HostEvent> {
    const backlogged = this.#backlog.findIndex(match);
    if (backlogged !== -1) return Promise.resolve(this.#backlog.splice(backlogged, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (event: HostEvent) => {
          clearTimeout(timer);
          resolve(event);
        },
      };
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `timed out waiting for ${label}; backlog=${JSON.stringify(this.#backlog)}; stderr=${this.#stderr || '(empty)'}`,
          ),
        );
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
    }
    await this.exited;
  }
}

let root: string;
let agentDir: string;
let dkgHome: string;
let sessionsDir: string;
let savedEnv: Partial<Record<(typeof SCRUBBED_ENV_KEYS)[number], string | undefined>>;
const hosts: FakeHost[] = [];

/** Millisecond-resolution ISO stamps need a real gap to be strictly ordered. */
const clockTick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const authed = (token = TOKEN) => ({
  'x-dkg-bridge-token': token,
  'content-type': 'application/json',
});

async function startHost(): Promise<FakeHost> {
  const host = new FakeHost(agentDir);
  hosts.push(host);
  await host.waitFor((e) => e.evt === 'ready', 'ready');
  return host;
}

async function startSession(host: FakeHost, sessionId: string): Promise<PrimeAgentSessionDescriptor> {
  host.send({ cmd: 'start-session', sessionId });
  await host.waitFor(
    (e) => e.evt === 'session-started' && e.sessionId === sessionId,
    `session-started ${sessionId}`,
  );
  // prune:false — the reader must not preempt prunes these tests attribute to
  // the extension's own session_start pass.
  const mine = readLiveSessions(sessionsDir, { prune: false }).find((s) => s.sessionId === sessionId);
  if (!mine) throw new Error(`extension published no descriptor for ${sessionId}`);
  return mine;
}

/** Script one full turn after the extension surfaces the injected message. */
async function scriptTurn(host: FakeHost, sessionId: string, deltas: string[]): Promise<HostEvent> {
  const userMessage = await host.waitFor(
    (e) => e.evt === 'user-message' && e.sessionId === sessionId,
    `user-message ${sessionId}`,
  );
  host.send({ cmd: 'agent-start', sessionId });
  for (const delta of deltas) {
    host.send({ cmd: 'message-update', sessionId, eventType: 'text_delta', delta });
  }
  host.send({ cmd: 'agent-end', sessionId });
  return userMessage;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of SCRUBBED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), 'pa-host-'));
  agentDir = join(root, 'prime-agent');
  dkgHome = join(root, 'dkg-home');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dkgHome, { recursive: true });
  // The node's credential, exactly as `dkg init` provisions it.
  writeFileSync(join(dkgHome, 'auth.token'), `# managed by dkg\n${TOKEN}\n`);
  setupPrimeAgentProfile({ agentDir, dkgHome, extensionPath: BUNDLE });
  sessionsDir = resolvePrimeAgentProfile({ agentDir }).sessionsDir;
});

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.dispose()));
  hosts.length = 0;
  for (const key of SCRUBBED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('token chain', () => {
  it('flows auth.token -> setup dkg.json -> bridge auth with no env injection', async () => {
    // Setup persisted the file-sourced token; nothing else can supply it to
    // the child because the spawn env is scrubbed of every token variable.
    const config = JSON.parse(
      readFileSync(join(resolvePrimeAgentProfile({ agentDir }).stateDir, ADAPTER_CONFIG_FILENAME), 'utf8'),
    ) as { bridge_token?: string };
    expect(config.bridge_token).toBe(TOKEN);

    const host = await startHost();
    const descriptor = await startSession(host, 'sess-token-chain');
    expect(descriptor.pid).toBe(host.child.pid); // a real foreign process

    const health = await fetch(`${descriptor.bridgeUrl}/health`, { headers: authed() });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      sessionId: 'sess-token-chain',
      pid: host.child.pid,
    });

    const denied = await fetch(`${descriptor.bridgeUrl}/health`, { headers: authed('wrong-token') });
    expect(denied.status).toBe(401);

    const pending = fetch(`${descriptor.bridgeUrl}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'ping across the boundary', correlationId: 'c-token' }),
    });
    const userMessage = await scriptTurn(host, 'sess-token-chain', ['pong ', 'assembled']);
    expect(userMessage.text).toBe('ping across the boundary');
    expect(userMessage.options).toMatchObject({ deliverAs: 'followUp' });

    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      text: 'pong assembled',
      correlationId: 'c-token',
      sessionId: 'sess-token-chain',
    });
  });
});

describe('streaming across the process boundary', () => {
  it('delivers SSE delta frames then a terminating final frame', async () => {
    const host = await startHost();
    const descriptor = await startSession(host, 'sess-stream');

    // The bridge flushes headers immediately, so this resolves pre-turn.
    const response = await fetch(`${descriptor.bridgeUrl}/stream`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'stream it', correlationId: 'c-stream' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    await scriptTurn(host, 'sess-stream', ['alpha', 'beta']);

    // text() resolving is the termination proof: the server ends the response
    // on the final frame, otherwise this would hang past the test timeout.
    const body = await response.text();
    const frames = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);

    expect(frames.map((f) => f.type)).toEqual(['delta', 'delta', 'final']);
    expect(frames[0]).toMatchObject({ type: 'delta', text: 'alpha', correlationId: 'c-stream' });
    expect(frames[1]).toMatchObject({ type: 'delta', text: 'beta', correlationId: 'c-stream' });
    expect(frames[2]).toMatchObject({
      type: 'final',
      text: 'alphabeta',
      correlationId: 'c-stream',
      sessionId: 'sess-stream',
    });
  });
});

describe('lifecycle', () => {
  it('shutdown removes the descriptor; a same-process restart rebinds fresh', async () => {
    const host = await startHost();
    await startSession(host, 'sess-reload-1');

    host.send({ cmd: 'shutdown-session', sessionId: 'sess-reload-1' });
    await host.waitFor(
      (e) => e.evt === 'session-shutdown' && e.sessionId === 'sess-reload-1',
      'session-shutdown sess-reload-1',
    );
    expect(existsSync(sessionDescriptorPath(sessionsDir, 'sess-reload-1'))).toBe(false);

    // The reload/resume shape: same process, successor session. Armed before
    // start-session, so it is active by the time session-started arrives.
    host.send({ cmd: 'auto-respond', sessionId: 'sess-reload-2', reply: 'auto pilot reply' });
    const second = await startSession(host, 'sess-reload-2');
    expect(second.pid).toBe(host.child.pid);
    // The successor may legitimately draw ANY ephemeral port, including the
    // one just released — the guarantee is a fresh live bridge that answers
    // for the new session, not port inequality (which is kernel behavior).
    const successorHealth = await fetch(`${second.bridgeUrl}/health`, { headers: authed() });
    expect(successorHealth.status).toBe(200);
    expect(await successorHealth.json()).toMatchObject({ ok: true, sessionId: 'sess-reload-2' });

    // auto-respond drives the full turn without any control-channel scripting.
    const response = await fetch(`${second.bridgeUrl}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'hello resumed session', correlationId: 'c-auto' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ text: 'auto pilot reply', correlationId: 'c-auto' });
    // The user-message event is emitted in auto-respond mode too.
    const userMessage = await host.waitFor(
      (e) => e.evt === 'user-message' && e.sessionId === 'sess-reload-2',
      'user-message sess-reload-2',
    );
    expect(userMessage.text).toBe('hello resumed session');

    // exit runs session_shutdown for every live session, then exits 0.
    host.send({ cmd: 'exit' });
    await host.waitFor(
      (e) => e.evt === 'session-shutdown' && e.sessionId === 'sess-reload-2',
      'session-shutdown sess-reload-2',
    );
    expect((await host.exited).code).toBe(0);
    expect(existsSync(sessionDescriptorPath(sessionsDir, 'sess-reload-2'))).toBe(false);
  });
});

describe('crash convergence', () => {
  it('prunes an aged dead-pid descriptor at the next session_start, keeping live ones', async () => {
    const hostA = await startHost();
    await startSession(hostA, 'sess-live');

    const hostB = await startHost();
    const crashed = await startSession(hostB, 'sess-crashed');
    hostB.child.kill('SIGKILL'); // no shutdown handlers run
    await hostB.exited;

    const crashedPath = sessionDescriptorPath(sessionsDir, 'sess-crashed');
    expect(existsSync(crashedPath)).toBe(true); // the crash left it behind
    expect(isProcessAlive(crashed.pid)).toBe(false);

    // Prune is age-gated (a fresh mtime could be a respawn's republication),
    // so age the file past the 30s threshold.
    const past = new Date(Date.now() - 120_000);
    utimesSync(crashedPath, past, past);

    await startSession(hostA, 'sess-after-crash');
    expect(existsSync(crashedPath)).toBe(false); // pruned by the extension
    expect(existsSync(sessionDescriptorPath(sessionsDir, 'sess-live'))).toBe(true);
    expect(existsSync(sessionDescriptorPath(sessionsDir, 'sess-after-crash'))).toBe(true);
  });
});

describe('election stamp', () => {
  it('orders the most recently ACTIVE session first — lastActiveAt beats startedAt', async () => {
    const host = await startHost();
    const older = await startSession(host, 'sess-older');
    await clockTick(); // distinct startedAt stamps
    const newer = await startSession(host, 'sess-newer');
    expect(newer.startedAt > older.startedAt).toBe(true); // the premise

    // Nobody active yet: the newest-started session wins.
    expect(readLiveSessions(sessionsDir).map((s) => s.sessionId)).toEqual([
      'sess-newer',
      'sess-older',
    ]);

    await clockTick(); // the activity stamp must beat newer's startedAt
    // A real turn on the OLDER session. The /send response resolves only after
    // agent_end, and agent_start (which writes the election stamp) precedes
    // it, so the HTTP response is the synchronization point.
    const pending = fetch(`${older.bridgeUrl}/send`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ text: 'wake the older session', correlationId: 'c-elect' }),
    });
    await scriptTurn(host, 'sess-older', ['ack']);
    expect((await pending).status).toBe(200);

    const ordered = readLiveSessions(sessionsDir);
    expect(ordered.map((s) => s.sessionId)).toEqual(['sess-older', 'sess-newer']);
    expect(ordered[0].startedAt).toBe(older.startedAt); // startedAt never moves
    expect(ordered[0].lastActiveAt! > newer.startedAt).toBe(true);
  });
});
