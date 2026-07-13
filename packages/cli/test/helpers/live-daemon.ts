/**
 * Shared real-daemon test harness (NO mocks).
 *
 * Spins a real built CLI daemon (`packages/cli/dist/cli.js daemon-worker`) in
 * edge role, wired against the SHARED HARDHAT NODE that the cli vitest config's
 * global setup boots (`packages/chain/test/hardhat-global-setup.ts`, port 9548).
 * There is NO mock chain adapter and NO fake daemon context — every request
 * below is a true HTTP round-trip against the production route handlers running
 * inside a real daemon process. This is the harness route/behaviour tests use
 * instead of hand-building a `RequestContext` with fabricated agent stubs (which
 * return canned data and silently drift from the real daemon).
 *
 * Edge role is deliberate: these are HTTP-layer tests, so the daemon must not
 * register on-chain ACK/storage handlers (whose absence would time out
 * `DKGAgent.start()`). Edge is a real production node mode — it skips profile
 * registration and just dials core nodes for publishes.
 *
 * Mirrors the inline harness in `daemon-http-behavior-extra.test.ts`; extracted
 * here so the de-mocked route suites share one spinner.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { getSharedContext, HARDHAT_KEYS } from '../../../chain/test/evm-test-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', '..', 'dist', 'cli.js');

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface LiveDaemon {
  home: string;
  apiPort: number;
  listenPort: number;
  child: ChildProcess;
  token: string | null;
  /** `http://127.0.0.1:<apiPort>` */
  base: string;
  exitCode?: number | null;
}

// Spread ports across runs so a crashed prior run's lingering socket can't
// collide. The cli package runs vitest single-worker, so within-run collisions
// aren't a concern; this only guards cross-run reuse.
let portCounter = 0;
function uniquePort(base: number): number {
  return base + ((portCounter++ * 7) % 900);
}

export interface StartDaemonOpts {
  authEnabled?: boolean;
  /** Enable a real async publisher and seed its wallet file. */
  publisherEnabled?: boolean;
  /** Extra keys merged into config.json (e.g. preset contextGraphs). */
  extraConfig?: Record<string, unknown>;
  readyTimeoutMs?: number;
  /**
   * Extra env vars for the daemon process. A value of `undefined` DELETES an
   * inherited var — use this to make a test hermetic against ambient env (e.g.
   * pin `DKG_MAX_INFLIGHT` instead of inheriting the developer/CI value).
   */
  env?: Record<string, string | undefined>;
}

/** Boot a real edge daemon against the shared Hardhat node and wait for readiness. */
export async function startLiveDaemon(opts: StartDaemonOpts = {}): Promise<LiveDaemon> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI not built at ${CLI_ENTRY}. Run "pnpm --filter @origintrail-official/dkg build" first.`,
    );
  }
  const authEnabled = opts.authEnabled ?? true;
  const home = await mkdtemp(join(tmpdir(), 'dkg-live-daemon-'));
  const apiPort = uniquePort(21000);
  const listenPort = uniquePort(21900);
  const { rpcUrl, hubAddress } = getSharedContext();

  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      name: 'live-daemon-test',
      apiPort,
      listenPort,
      apiHost: '127.0.0.1',
      nodeRole: 'edge',
      relay: 'none',
      auth: { enabled: authEnabled },
      store: { backend: 'oxigraph-worker', options: { path: join(home, 'store.nq') } },
      chain: { type: 'evm', rpcUrl, hubAddress, chainId: 'evm:31337' },
      ...(opts.publisherEnabled ? { publisher: { enabled: true } } : {}),
      contextGraphs: [],
      ...(opts.extraConfig ?? {}),
    }),
  );

  // Seed the op wallet with the harness CORE_OP key so the daemon boots with a
  // deterministic signer instead of auto-generating one.
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await writeFile(
    join(home, 'wallets.json'),
    JSON.stringify({ wallets: [{ address: coreOp.address, privateKey: coreOp.privateKey }] }, null, 2) + '\n',
    { mode: 0o600 },
  );
  if (opts.publisherEnabled) {
    await writeFile(
      join(home, 'publisher-wallets.json'),
      JSON.stringify({ wallets: [{ address: coreOp.address, privateKey: coreOp.privateKey }] }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    DKG_HOME: home,
    DKG_API_PORT: String(apiPort),
    DKG_NO_BLUE_GREEN: '1',
    DKG_DISABLE_TELEMETRY: '1',
    ...(opts.env ?? {}),
  };
  // Drop keys explicitly cleared via `env: { KEY: undefined }` so a test can
  // remove an inherited var (spawn would otherwise pass it through).
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: childEnv,
    stdio: 'ignore',
  });

  const daemon: LiveDaemon = {
    home,
    apiPort,
    listenPort,
    child,
    token: null,
    base: `http://127.0.0.1:${apiPort}`,
  };
  child.once('exit', (code) => {
    daemon.exitCode = code;
  });

  const deadlineLoops = Math.ceil((opts.readyTimeoutMs ?? 45_000) / 500);
  for (let i = 0; i < deadlineLoops; i++) {
    if (child.exitCode !== null) throw new Error(`Daemon exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${daemon.base}/api/status`);
      if (res.ok) break;
    } catch {
      /* not ready yet */
    }
    await sleep(500);
    if (i === deadlineLoops - 1) throw new Error('Daemon did not become ready in time');
  }

  if (authEnabled) {
    const raw = await readFile(join(home, 'auth.token'), 'utf-8');
    daemon.token =
      raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('#')) ?? null;
    if (!daemon.token) throw new Error('auth enabled but no token written');
  }
  if (opts.publisherEnabled) {
    // `/api/status` becomes ready before the zero-delay publisher startup task.
    // Poll its explicit readiness field rather than fabricating a business
    // publish request whose validation order could change independently.
    for (let i = 0; i < 60; i += 1) {
      const res = await fetch(`${daemon.base}/api/status`, {
        headers: daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {},
      });
      const body = await res.json().catch(() => ({})) as {
        asyncPublisher?: { available?: boolean; reason?: string };
      };
      if (body.asyncPublisher?.available === true) break;
      if (body.asyncPublisher?.reason !== 'publisher_starting') {
        throw new Error(`Async publisher failed readiness: ${body.asyncPublisher?.reason ?? res.status}`);
      }
      await sleep(100);
      if (i === 59) throw new Error('Async publisher did not become ready in time');
    }
  }
  return daemon;
}

/** SIGTERM the daemon, escalate to SIGKILL, and wipe its home dir. */
export async function stopLiveDaemon(daemon: LiveDaemon | undefined): Promise<void> {
  if (!daemon) return;
  daemon.child.kill('SIGTERM');
  await sleep(1200);
  if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
  await rm(daemon.home, { recursive: true, force: true }).catch(() => {});
}

export function authHeaders(daemon: LiveDaemon, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {}),
    ...extra,
  };
}

/** POST JSON to a daemon route, returning {status, body} (body parsed if JSON). */
export async function postJson(
  daemon: LiveDaemon,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${daemon.base}${path}`, {
    method: 'POST',
    headers: authHeaders(daemon),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

export interface EventStream {
  /** All SSE frames received so far (excluding heartbeat comments). */
  events: Array<{ event: string; data: any }>;
  /**
   * Resolve with the first frame (past or future) matching `predicate`, or
   * reject after `timeoutMs`. Lets a test perform an op then await its event.
   */
  waitFor(predicate: (f: { event: string; data: any }) => boolean, timeoutMs?: number): Promise<{ event: string; data: any }>;
  close(): void;
}

/**
 * Subscribe to the daemon's real `GET /api/events` Server-Sent-Events stream
 * and collect frames. This is how memory-graph / notification emissions are
 * observed end-to-end: the route handler calls `emitMemoryGraphChanged`, the
 * daemon `sseBroadcast`s a `memory_graph_changed` frame, and it arrives here —
 * the real emit pipeline, no injected emitter stub.
 */
export async function openEventStream(daemon: LiveDaemon): Promise<EventStream> {
  const controller = new AbortController();
  const res = await fetch(`${daemon.base}/api/events`, {
    headers: daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {},
    signal: controller.signal,
  });
  if (!res.ok || !res.body) throw new Error(`/api/events not ok: ${res.status}`);

  const events: Array<{ event: string; data: any }> = [];
  const waiters: Array<{ predicate: (f: any) => boolean; resolve: (f: any) => void }> = [];

  const pushFrame = (frame: { event: string; data: any }) => {
    events.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(frame)) {
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  };

  // Drain the stream in the background, parsing SSE frames (blocks separated by
  // a blank line; `event:` + `data:` lines; `:`-prefixed comments = heartbeats).
  (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue; // heartbeat/comment
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          let data: any = dataLines.join('\n');
          try { data = JSON.parse(data); } catch { /* leave as string */ }
          pushFrame({ event, data });
        }
      }
    } catch { /* aborted on close() */ }
  })();

  return {
    events,
    waitFor(predicate, timeoutMs = 8000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === wrapped);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('Timed out waiting for SSE frame'));
        }, timeoutMs);
        const wrapped = (f: any) => { clearTimeout(timer); resolve(f); };
        waiters.push({ predicate, resolve: wrapped });
      });
    },
    close() {
      controller.abort();
    },
  };
}

/** GET a daemon route with auth, returning {status, body} (body parsed if JSON). */
export async function getJson(
  daemon: LiveDaemon,
  path: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${daemon.base}${path}`, { headers: authHeaders(daemon) });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

/**
 * POST a real multipart/form-data body to a daemon route (postJson can't —
 * import-file routes parse multipart, not JSON). Builds a real boundary-encoded
 * body so the daemon runs its real parseMultipart, not a fake.
 */
export async function postMultipart(
  daemon: LiveDaemon,
  path: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; value: string }>,
): Promise<{ status: number; body: any }> {
  const boundary = `dkgLiveDaemon${Date.now().toString(36)}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) header += `; filename="${p.filename}"`;
    header += '\r\n';
    if (p.contentType) header += `Content-Type: ${p.contentType}\r\n`;
    header += '\r\n';
    chunks.push(Buffer.from(header, 'utf-8'), Buffer.from(p.value, 'utf-8'), Buffer.from('\r\n', 'utf-8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
  const res = await fetch(`${daemon.base}${path}`, {
    method: 'POST',
    headers: {
      ...(daemon.token ? { Authorization: `Bearer ${daemon.token}` } : {}),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(chunks),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
