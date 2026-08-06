/**
 * Daemon routes against the REAL extension bridge, across a real process
 * boundary.
 *
 * `daemon-prime-agent.test.ts` drives `handlePrimeAgentRoutes` against a stub
 * bridge; here the bridge is the BUILT extension bundle running inside the
 * fake Prime Agent host fixture (`test-fixtures/fake-prime-agent-host.mjs` in
 * the adapter package) — a real child process per host. Everything the live
 * smoke depends on is therefore exercised for real: descriptor discovery from
 * the sessions dir, pid-liveness exclusion of crashed hosts, the pre-send
 * health gate, bridge auth sourced from the adapter's dkg.json (no
 * DKG_BRIDGE_TOKEN env var anywhere), the SSE pump, and the lastActiveAt
 * election that decides where an unaddressed message lands.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setupPrimeAgentProfile } from '@origintrail-official/dkg-adapter-prime-agent';
import type { DkgConfig } from '../src/config.js';
import { readPrimeAgentSessions } from '../src/daemon/prime-agent.js';
import { handlePrimeAgentRoutes } from '../src/daemon/routes/prime-agent.js';

// Resolve fixture and bundle from the adapter PACKAGE, not a relative guess:
// the test must keep working if this file or the adapter moves.
const adapterRequire = createRequire(import.meta.url);
const ADAPTER_ROOT = dirname(
  adapterRequire.resolve('@origintrail-official/dkg-adapter-prime-agent/package.json'),
);
const FIXTURE = join(ADAPTER_ROOT, 'test-fixtures', 'fake-prime-agent-host.mjs');
const BUNDLE = join(ADAPTER_ROOT, 'extension', 'dist', 'extension.js');
const TOKEN = 'auth-token-provisioned-in-dkg-home';

interface HostEvent {
  evt: string;
  [k: string]: unknown;
}

/**
 * Env the test and the child must not inherit: the whole point is the
 * file-based token chain (auth.token -> setup's dkg.json -> bridge), and
 * daemon-side discovery must see only OUR temp agent dir.
 */
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

/** Driver for one fake-host process (same protocol as the adapter's own test). */
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

  /**
   * Absence check: events already received but never consumed by a waitFor.
   * Host stdout is ordered, so once a LATER event from the same host has been
   * observed, an earlier stray would have to be sitting here.
   */
  backlogMatching(match: (e: HostEvent) => boolean): HostEvent[] {
    return this.#backlog.filter(match);
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
let savedEnv: Partial<Record<(typeof SCRUBBED_ENV_KEYS)[number], string | undefined>>;
const hosts: FakeHost[] = [];

/** Millisecond-resolution ISO stamps need a real gap to be strictly ordered. */
const clockTick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function startHost(): Promise<FakeHost> {
  const host = new FakeHost(agentDir);
  hosts.push(host);
  await host.waitFor((e) => e.evt === 'ready', 'ready');
  return host;
}

async function startSession(host: FakeHost, sessionId: string): Promise<void> {
  host.send({ cmd: 'start-session', sessionId });
  // The extension publishes the session's descriptor during session_start, so
  // once this settles the daemon-side discovery is guaranteed to see it.
  await host.waitFor(
    (e) => e.evt === 'session-started' && e.sessionId === sessionId,
    `session-started ${sessionId}`,
  );
}

/** Drive agent_start -> deltas -> agent_end for an already-injected message. */
function completeTurn(host: FakeHost, sessionId: string, deltas: string[]): void {
  host.send({ cmd: 'agent-start', sessionId });
  for (const delta of deltas) {
    host.send({ cmd: 'message-update', sessionId, eventType: 'text_delta', delta });
  }
  host.send({ cmd: 'agent-end', sessionId });
}

/** Script one full turn after the extension surfaces the injected message. */
async function scriptTurn(host: FakeHost, sessionId: string, deltas: string[]): Promise<HostEvent> {
  const userMessage = await host.waitFor(
    (e) => e.evt === 'user-message' && e.sessionId === sessionId,
    `user-message ${sessionId}`,
  );
  completeTurn(host, sessionId, deltas);
  return userMessage;
}

/* Route-side helpers, copied from daemon-prime-agent.test.ts (not exported). */

function enabledConfig(): DkgConfig {
  return {
    name: 'test-node',
    apiPort: 9200,
    listenPort: 0,
    nodeRole: 'edge',
    localAgentIntegrations: {
      'prime-agent': {
        enabled: true,
        capabilities: { localChat: true },
        transport: { kind: 'prime-agent-channel' },
      },
    },
  } as unknown as DkgConfig;
}

function makeJsonRequest(method: string, path: string, payload?: unknown) {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = {};
  setTimeout(() => {
    if (payload !== undefined) req.emit('data', Buffer.from(JSON.stringify(payload)));
    req.emit('end');
  }, 0);
  return req;
}

function makeJsonResponse() {
  const res = new EventEmitter() as any;
  res.statusCode = 0;
  res.headers = {};
  res.body = '';
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = (status: number, headers: Record<string, string>) => {
    res.statusCode = status;
    res.headers = headers;
    res.headersSent = true;
  };
  res.write = (chunk: string | Uint8Array) => {
    // The stream pump forwards raw Uint8Array chunks, not Node Buffers.
    res.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  res.end = (chunk?: string | Buffer) => {
    if (chunk) res.write(chunk);
    res.writableEnded = true;
  };
  return res;
}

/**
 * One daemon-route invocation with the REAL fetch to the real bridge. The
 * returned promise settles only when the route handler has fully answered, so
 * callers script the host turn concurrently and await `done` after.
 */
function callRoute(method: string, path: string, payload?: unknown) {
  const res = makeJsonResponse();
  const done = handlePrimeAgentRoutes({
    req: makeJsonRequest(method, path, payload),
    res,
    config: enabledConfig(),
    bridgeAuthToken: TOKEN,
    path,
  } as any);
  return { res, done };
}

beforeEach(() => {
  savedEnv = {};
  for (const key of SCRUBBED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), 'dkg-pa-host-int-'));
  agentDir = join(root, 'prime-agent');
  dkgHome = join(root, 'dkg-home');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(dkgHome, { recursive: true });
  // The node's credential, exactly as `dkg init` provisions it. The adapter's
  // real setup carries it into dkg.json (mode 0600) in the state dir — the file
  // the extension bridge reads. The route side then presents the SAME value as
  // ctx.bridgeAuthToken; no token env var exists anywhere in this test.
  writeFileSync(join(dkgHome, 'auth.token'), `# managed by dkg\n${TOKEN}\n`);
  setupPrimeAgentProfile({ agentDir, dkgHome, extensionPath: BUNDLE });
  // Daemon-side session discovery reads this at request time.
  process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
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

describe('send chain', () => {
  it('delivers through the real bridge as a followUp and returns the assembled turn', async () => {
    const host = await startHost();
    await startSession(host, 's-send');

    const { res, done } = callRoute('POST', '/api/prime-agent-channel/send', {
      text: 'ping across the wire',
      correlationId: 'c-send',
    });
    const userMessage = await scriptTurn(host, 's-send', ['pong ', 'assembled']);
    // The injected message crossed the process boundary verbatim, delivered as
    // a follow-up so a locally-started turn is never interrupted.
    expect(userMessage.text).toBe('ping across the wire');
    expect(userMessage.options).toMatchObject({ deliverAs: 'followUp' });

    await done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      text: 'pong assembled',
      sessionId: 's-send',
      correlationId: 'c-send',
    });
  });
});

describe('stream chain', () => {
  it('relays delta frames then exactly one final frame and ends the response', async () => {
    const host = await startHost();
    await startSession(host, 's-stream');

    const { res, done } = callRoute('POST', '/api/prime-agent-channel/stream', {
      text: 'stream it',
      correlationId: 'c-stream',
    });
    await scriptTurn(host, 's-stream', ['alpha', 'beta']);
    await done;

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    const frames = (res.body as string)
      .split('\n\n')
      .filter((frame: string) => frame.startsWith('data: '))
      .map((frame: string) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
    expect(frames.map((f) => f.type)).toEqual(['delta', 'delta', 'final']);
    expect(frames[0]).toMatchObject({ type: 'delta', text: 'alpha', correlationId: 'c-stream' });
    expect(frames[1]).toMatchObject({ type: 'delta', text: 'beta', correlationId: 'c-stream' });
    expect(frames[2]).toMatchObject({
      type: 'final',
      text: 'alphabeta',
      correlationId: 'c-stream',
      sessionId: 's-stream',
    });
    // The pump ended the response on the final frame — and wrote nothing after.
    expect(res.writableEnded).toBe(true);
    const afterFinal = (res.body as string).slice(res.body.indexOf('data: {"type":"final"'));
    expect(afterFinal.split('\n\n').filter((f: string) => f.startsWith('data: '))).toHaveLength(1);
  });
});

describe('busy turn', () => {
  it('answers 429 SESSION_BUSY for a second send mid-turn, leaving the first unaffected', async () => {
    const host = await startHost();
    await startSession(host, 's-busy');

    const first = callRoute('POST', '/api/prime-agent-channel/send', {
      text: 'long running question',
      correlationId: 'c-first',
    });
    // The user-message event proves the bridge registered the turn: from here
    // on any second send must hit the one-turn-at-a-time guard.
    const firstUserMessage = await host.waitFor(
      (e) => e.evt === 'user-message' && e.sessionId === 's-busy',
      'user-message s-busy',
    );
    expect(firstUserMessage.text).toBe('long running question');

    const second = callRoute('POST', '/api/prime-agent-channel/send', {
      text: 'impatient interjection',
      correlationId: 'c-second',
    });
    await second.done;
    expect(second.res.statusCode).toBe(429);
    const busy = JSON.parse(second.res.body);
    expect(busy.code).toBe('PRIME_AGENT_SESSION_BUSY');
    expect(busy.correlationId).toBe('c-second');

    // Now complete the first turn — its response must be untouched by the
    // rejected interjection.
    completeTurn(host, 's-busy', ['finally ', 'done']);
    await first.done;
    expect(first.res.statusCode).toBe(200);
    expect(JSON.parse(first.res.body)).toMatchObject({
      text: 'finally done',
      sessionId: 's-busy',
      correlationId: 'c-first',
    });
    // The rejected send never became a user message in the session. The HTTP
    // response and the child's stdout are unordered channels, so first consume
    // a LATER ordered stdout event (a throwaway session start) — any stray
    // user-message from the rejected send would precede it in the FIFO pipe
    // and still be in the backlog when we assert.
    host.send({ cmd: 'start-session', sessionId: 's-busy-probe' });
    await host.waitFor(
      (e) => e.evt === 'session-started' && e.sessionId === 's-busy-probe',
      'session-started s-busy-probe',
    );
    expect(host.backlogMatching((e) => e.evt === 'user-message')).toHaveLength(0);
  });
});

describe('election across two host processes', () => {
  it('routes an unaddressed send to the session with the most recent agent activity', async () => {
    const hostA = await startHost();
    await startSession(hostA, 's-old');
    await clockTick(); // distinct startedAt stamps
    const hostB = await startHost();
    await startSession(hostB, 's-new');

    // Premise: with no activity anywhere the newest-STARTED session wins.
    expect(readPrimeAgentSessions().map((s) => s.sessionId)).toEqual(['s-new', 's-old']);

    await clockTick(); // the activity stamp must strictly beat s-new's startedAt
    // A real addressed turn on s-old. agent_start writes the election stamp and
    // precedes agent_end, which the 200 waits on — so the response resolving is
    // the proof the stamp is on disk.
    const warm = callRoute('POST', '/api/prime-agent-channel/send', {
      text: 'wake the old session',
      correlationId: 'c-warm',
      sessionId: 's-old',
    });
    await scriptTurn(hostA, 's-old', ['ack']);
    await warm.done;
    expect(warm.res.statusCode).toBe(200);

    // The property the live smoke cares about: unaddressed lands on s-old —
    // host A is the one that emits user-message.
    const unaddressed = callRoute('POST', '/api/prime-agent-channel/send', {
      text: 'route me by activity',
      correlationId: 'c-elect',
    });
    const delivered = await scriptTurn(hostA, 's-old', ['landed on old']);
    expect(delivered.text).toBe('route me by activity');
    await unaddressed.done;
    expect(unaddressed.res.statusCode).toBe(200);
    expect(JSON.parse(unaddressed.res.body)).toMatchObject({
      text: 'landed on old',
      sessionId: 's-old',
      correlationId: 'c-elect',
    });
    // Host B never saw a user message.
    expect(hostB.backlogMatching((e) => e.evt === 'user-message')).toHaveLength(0);
  });
});

describe('no silent reroute on crash', () => {
  it('409s a send addressed to a SIGKILLed host and only unaddressed sends reach the survivor', async () => {
    const hostA = await startHost();
    await startSession(hostA, 's-old');
    await clockTick();
    const hostB = await startHost();
    await startSession(hostB, 's-new');

    // Crash host A: no shutdown handlers run, its descriptor stays on disk —
    // only the dead pid excludes it from discovery.
    hostA.child.kill('SIGKILL');
    await hostA.exited;

    const addressed = callRoute('POST', '/api/prime-agent-channel/send', {
      text: 'must not arrive anywhere',
      correlationId: 'c-dead',
      sessionId: 's-old',
    });
    await addressed.done;
    expect(addressed.res.statusCode).toBe(409);
    const body = JSON.parse(addressed.res.body);
    expect(body.code).toBe('PRIME_AGENT_NO_SESSION');
    expect(body.correlationId).toBe('c-dead');

    // An unaddressed send still reaches the survivor.
    const unaddressed = callRoute('POST', '/api/prime-agent-channel/send', {
      text: 'find the survivor',
      correlationId: 'c-live',
    });
    const delivered = await scriptTurn(hostB, 's-new', ['alive']);
    // Host stdout is ordered: had the dead-addressed send been rerouted to
    // s-new, its user-message would have been consumed here (wrong text) or
    // still be backlogged below.
    expect(delivered.text).toBe('find the survivor');
    await unaddressed.done;
    expect(unaddressed.res.statusCode).toBe(200);
    expect(JSON.parse(unaddressed.res.body)).toMatchObject({
      text: 'alive',
      sessionId: 's-new',
      correlationId: 'c-live',
    });
    expect(hostB.backlogMatching((e) => e.evt === 'user-message')).toHaveLength(0);
  });
});

describe('health integration', () => {
  it('reports the live session while a host is up and idle after every host exits', async () => {
    const host = await startHost();
    await startSession(host, 's-health');

    const up = callRoute('GET', '/api/prime-agent-channel/health');
    await up.done;
    expect(up.res.statusCode).toBe(200);
    expect(JSON.parse(up.res.body)).toMatchObject({
      ok: true,
      sessionCount: 1,
      target: 's-health',
    });

    // Graceful exit: session_shutdown removes the descriptor before exit 0.
    host.send({ cmd: 'exit' });
    await host.waitFor(
      (e) => e.evt === 'session-shutdown' && e.sessionId === 's-health',
      'session-shutdown s-health',
    );
    expect((await host.exited).code).toBe(0);

    const down = callRoute('GET', '/api/prime-agent-channel/health');
    await down.done;
    expect(down.res.statusCode).toBe(200);
    expect(JSON.parse(down.res.body)).toMatchObject({ ok: false, sessionCount: 0 });
  });
});
