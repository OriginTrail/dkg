/** Route-plugins live-daemon E2E: spawns one daemon with the sample-fixture plugins and asserts HTTP behaviour.
 *  Patterned after `daemon-http-behavior-extra.test.ts` (edge-role node, no profile registration). */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { getSharedContext, HARDHAT_KEYS } from '../../../chain/test/evm-test-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', '..', 'dist', 'cli.js');
const FIXTURE_DIR = resolvePath(
  __dirname,
  '..',
  '..',
  'test-fixtures',
  'sample-route-plugin',
  'dist',
);
const ECHO_FIXTURE = join(FIXTURE_DIR, 'index.js');
const THROW_FIXTURE = join(FIXTURE_DIR, 'throwing.js');

interface Daemon {
  home: string;
  apiPort: number;
  listenPort: number;
  child: ChildProcess;
  token: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

function uniquePort(base: number): number {
  return base + Math.floor(Math.random() * 1000);
}

// Bases must be ≥1000 apart so the two `uniquePort` rolls never overlap (each samples [base, base+1000)).
const API_PORT_BASE = 19900; // -> [19900, 20899]
const LISTEN_PORT_BASE = 21000; // -> [21000, 21999]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function writeDaemonConfig(
  home: string,
  apiPort: number,
  listenPort: number,
): Promise<void> {
  const { rpcUrl, hubAddress } = getSharedContext();
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      name: 'plugin-routes-e2e',
      apiPort,
      listenPort,
      apiHost: '127.0.0.1',
      nodeRole: 'edge',
      relay: 'none',
      auth: { enabled: true },
      store: {
        backend: 'oxigraph-worker',
        options: { path: join(home, 'store.nq') },
      },
      chain: {
        type: 'evm',
        rpcUrl,
        hubAddress,
        chainId: 'evm:31337',
      },
      contextGraphs: [],
      routePlugins: [ECHO_FIXTURE, THROW_FIXTURE],
    }),
  );
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await writeFile(
    join(home, 'wallets.json'),
    JSON.stringify({
      wallets: [{ address: coreOp.address, privateKey: coreOp.privateKey }],
    }, null, 2) + '\n',
    { mode: 0o600 },
  );
}

async function startDaemon(): Promise<Daemon> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI not built at ${CLI_ENTRY}. Run "pnpm --filter @origintrail-official/dkg build" first.`,
    );
  }
  if (!existsSync(ECHO_FIXTURE) || !existsSync(THROW_FIXTURE)) {
    throw new Error(`Sample route-plugin fixtures missing under ${FIXTURE_DIR}`);
  }
  const home = await mkdtemp(join(tmpdir(), 'dkg-plugin-routes-e2e-'));
  const apiPort = uniquePort(API_PORT_BASE);
  const listenPort = uniquePort(LISTEN_PORT_BASE);
  await writeDaemonConfig(home, apiPort, listenPort);

  // Pipe daemon stdio to a file so startup failures (port bind, plugin load, chain init) surface in error messages.
  const stdioLog = join(home, 'daemon-stdio.log');
  const logHandle = await open(stdioLog, 'a');
  const child = spawn('node', [CLI_ENTRY, 'daemon-worker'], {
    env: {
      ...process.env,
      DKG_HOME: home,
      DKG_API_PORT: String(apiPort),
      DKG_NO_BLUE_GREEN: '1',
      DKG_DISABLE_TELEMETRY: '1',
    },
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });

  const readDaemonStdioTail = async (n = 80): Promise<string> => {
    try {
      const buf = await readFile(stdioLog, 'utf-8');
      const lines = buf.split('\n');
      return lines.slice(-n).join('\n').trim();
    } catch {
      return '<could not read daemon stdio log>';
    }
  };

  const daemon: Daemon = {
    home,
    apiPort,
    listenPort,
    child,
    token: '',
  };
  child.once('exit', (code, signal) => {
    daemon.exitCode = code;
    daemon.signal = signal;
  });

  // afterAll can't reach our resources until we return — clean up on throw so a flaky startup doesn't leak the daemon / port.
  try {
    for (let i = 0; i < 90; i++) {
      // Cover signal-exit too: `exitCode === null` with `signalCode !== null` means the daemon was killed mid-startup.
      if (child.exitCode !== null || child.signalCode !== null) {
        const tail = await readDaemonStdioTail();
        throw new Error(
          `Daemon exited early (code=${child.exitCode}, signal=${child.signalCode}).\n--- daemon stdio tail ---\n${tail}`,
        );
      }
      try {
        const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
        if (res.ok) break;
      } catch {
        /* not ready yet */
      }
      await sleep(500);
      if (i === 89) {
        const tail = await readDaemonStdioTail();
        throw new Error(
          `Daemon did not become ready within 45s.\n--- daemon stdio tail ---\n${tail}`,
        );
      }
    }
    // Close the parent's handle; the child still owns its dup'd fd so the log keeps growing until daemon exit.
    await logHandle.close();

    const raw = await readFile(join(home, 'auth.token'), 'utf-8');
    const token = raw
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#'));
    if (!token) throw new Error('No auth token found in auth.token');
    daemon.token = token;

    return daemon;
  } catch (err) {
    // Both fields null = still alive; signal-exits leave exitCode null but set signalCode.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        sleep(5_000),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    await logHandle.close().catch(() => {});
    await rm(home, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function stopDaemon(d: Daemon | null): Promise<void> {
  if (!d) return;
  if (d.child.exitCode === null) {
    const exited = new Promise<void>((resolve) => {
      d.child.once('exit', () => resolve());
    });
    d.child.kill('SIGTERM');
    await Promise.race([exited, sleep(10_000)]);
    if (d.child.exitCode === null) d.child.kill('SIGKILL');
  }
  await rm(d.home, { recursive: true, force: true }).catch(() => {});
}

let daemon: Daemon | null = null;

beforeAll(async () => {
  daemon = await startDaemon();
}, 90_000);

afterAll(async () => {
  await stopDaemon(daemon);
  daemon = null;
}, 20_000);

function urlFor(path: string): string {
  return `http://127.0.0.1:${daemon!.apiPort}${path}`;
}

describe('Route plugins — live daemon E2E', () => {
  it('echo plugin handles POST /api/sample-fixture/echo with the request body', async () => {
    const res = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ echoed: { hello: 'world' } });
  });

  it('rejects an unauthenticated request to a plugin route (auth gate runs BEFORE plugin dispatch)', async () => {
    // Locks the security boundary: route-plugins are an extension
    // surface but they MUST NOT bypass the daemon's auth gate. A
    // regression where plugin routes were dispatched first (and the
    // bearer-token check ran only on built-in routes) would let a
    // misconfigured plugin leak data without auth. Probe with no
    // header, then with a wrong token, expecting both to fail.
    const noAuth = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect([401, 403]).toContain(noAuth.status);

    const wrongAuth = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not-a-real-token-xyz',
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect([401, 403]).toContain(wrongAuth.status);
  });

  it('two consecutive successful echo calls return independent responses (no plugin state leak)', async () => {
    // Defends against plugin authors capturing the request context
    // in a closure or holding it across requests. Two distinct bodies
    // → two distinct echoed responses, never aliased.
    const r1 = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: JSON.stringify({ pass: 1 }),
    });
    const r2 = await fetch(urlFor('/api/sample-fixture/echo'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: JSON.stringify({ pass: 2 }),
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const d1 = await r1.json();
    const d2 = await r2.json();
    expect(d1).toEqual({ echoed: { pass: 1 } });
    expect(d2).toEqual({ echoed: { pass: 2 } });
  });

  it('built-in /api/status still answers 200 in the same daemon (regression)', async () => {
    const res = await fetch(urlFor('/api/status'));
    expect(res.status).toBe(200);
  });

  it('throwing plugin yields a 500 PluginError with the plugin name', async () => {
    const res = await fetch(urlFor('/api/sample-fixture/throw'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${daemon!.token}`,
      },
      body: '{}',
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('PluginError');
    expect(data.plugin).toBe('sample-fixture-throw');
    expect(typeof data.message).toBe('string');
  });

  it('daemon survives a plugin throw — /api/status still answers 200 after the 500', async () => {
    const res = await fetch(urlFor('/api/status'));
    expect(res.status).toBe(200);
  });

  it('HEAD /.well-known/skill.md mirrors the GET headers (ETag, Cache-Control, Vary) with no body', async () => {
    // HEAD must return the same caching headers GET would, so HTTP-cache-aware clients can validate
    // their cached copy without a body roundtrip. Body must be empty (HEAD spec).
    const headRes = await fetch(urlFor('/.well-known/skill.md'), { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('content-type')).toContain('text/markdown');
    const etag = headRes.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(headRes.headers.get('cache-control')).toBeTruthy();
    expect(headRes.headers.get('vary')).toBeTruthy();
    const headBody = await headRes.text();
    expect(headBody).toBe('');

    // Conditional GET with the HEAD-discovered ETag must return 304.
    const getRes = await fetch(urlFor('/.well-known/skill.md'), {
      headers: { 'If-None-Match': etag! },
    });
    expect(getRes.status).toBe(304);

    // Conditional HEAD with matching ETag must also return 304.
    const headIfMatch = await fetch(urlFor('/.well-known/skill.md'), {
      method: 'HEAD',
      headers: { 'If-None-Match': etag! },
    });
    expect(headIfMatch.status).toBe(304);
  });
});
