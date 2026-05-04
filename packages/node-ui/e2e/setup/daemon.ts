import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const cliPath = resolve(here, '..', '..', '..', '..', 'cli', 'dist', 'cli.js');
// Vite's inject-dkg-token plugin (vite.config.ts) reads from
// `<repo>/.devnet/node1` first. We host the test daemon here so Vite picks
// up the same token Playwright injects — without this, Vite's <script>
// override fights the fixture and the UI ends up unauthenticated.
const dkgHome = resolve(here, '..', '..', '..', '..', '..', '.devnet', 'node1');

export interface DaemonState {
  dkgHome: string;
  apiPort: number;
  authToken: string;
  pid: number;
}

let proc: ChildProcess | null = null;
let state: DaemonState | null = null;

export async function startDaemon(opts: { apiPort?: number } = {}): Promise<DaemonState> {
  if (state) return state;

  if (!existsSync(cliPath)) {
    throw new Error(
      `dkg CLI not built at ${cliPath}. Run \`pnpm --filter @origintrail-official/dkg build\` ` +
        `(or use the root \`pnpm test:ui\` script which chains the build).`,
    );
  }

  const apiPort = opts.apiPort ?? 9200;
  // Wipe any prior run's data so each suite starts clean.
  await rm(dkgHome, { recursive: true, force: true }).catch(() => {});
  await mkdir(dkgHome, { recursive: true });

  const config = {
    name: 'qa-test-node',
    apiPort,
    apiHost: '127.0.0.1',
    listenPort: 0,
    nodeRole: 'edge' as const,
    auth: { enabled: true },
    // Isolated test mode: no relays (`"none"` is the daemon's documented
    // disable signal — see packages/cli/src/daemon/lifecycle.ts), empty
    // bootstrap, empty subscribed CGs, no auto-update. The daemon comes
    // up, exposes its API, but doesn't dial out to the live testnet.
    // This eliminates the flake from peer-flood / sync activity competing
    // with API responsiveness.
    relay: 'none',
    bootstrapPeers: [],
    contextGraphs: [],
    autoUpdate: { enabled: false },
  };
  await writeFile(join(dkgHome, 'config.json'), JSON.stringify(config, null, 2));

  proc = spawn(process.execPath, [cliPath, 'start', '-f'], {
    env: { ...process.env, DKG_HOME: dkgHome, DKG_NO_BLUE_GREEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});

  await waitForApi(apiPort, 60_000);
  const authToken = await readAuthToken(dkgHome);

  state = { dkgHome, apiPort, authToken, pid: proc.pid! };
  return state;
}

export async function stopDaemon(): Promise<void> {
  if (!state || !proc) return;
  proc.kill('SIGTERM');
  await new Promise<void>((r) => {
    if (!proc) return r();
    const t = setTimeout(() => {
      proc?.kill('SIGKILL');
      r();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(t);
      r();
    });
  });
  // Don't wipe dkgHome on stop — it's `.devnet/node1` which the Vite plugin
  // reads at startup. Wiping mid-run would leave Vite holding an orphaned
  // token. The next startDaemon clears it before re-init.
  proc = null;
  state = null;
}

export function currentState(): DaemonState | null {
  return state;
}

async function waitForApi(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(1500),
      });
      // Accept any HTTP response — auth-protected routes return 401, which
      // still proves the server is up and routing.
      if (resp.status > 0) return;
    } catch {
      // Not ready yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Daemon API never came up on :${port}`);
}

/**
 * Poll /api/status with auth until the daemon reports a peerId — the
 * status payload is empty until libp2p initialisation finishes, and the
 * UI's first fetchContextGraphs can race that window. This drains the
 * race so the very first test sees a fully bootstrapped daemon.
 */
export async function waitForDaemonReady(port: number, token: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { peerId?: string };
        if (data.peerId) return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Daemon never reported a peerId');
}

async function readAuthToken(dkgHome: string): Promise<string> {
  // The token file has a comment header — pick the first non-comment line.
  const raw = await readFile(join(dkgHome, 'auth.token'), 'utf8');
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  if (!line) throw new Error('auth.token had no token line');
  return line;
}
