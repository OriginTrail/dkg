/**
 * `startDaemon` — start the DKG node daemon non-interactively from an
 * adapter setup flow. Spawns `node <cliPath> start` via
 * `process.execPath`, waits for `/api/status` to respond, and is no-op
 * when the daemon is already running on the expected port.
 *
 * Moved here from `packages/adapter-openclaw/src/setup.ts` in S1 of
 * issue #386. Both adapters (OpenClaw + Hermes) need this to satisfy
 * acceptance criterion 3 ("`--no-start` truly means do not start the
 * DKG daemon"); CLI package can't host it because the dependency
 * direction is `cli → adapters → core`.
 *
 * Logging keeps the `[setup] ...` prefix so user-visible output is
 * unchanged from the OpenClaw-pre-extraction wording. Adapters that
 * want a different prefix (e.g. Hermes might prefer `[hermes-setup]`)
 * can wrap this with their own `console.log` shims; we don't take a
 * logger param to keep the extraction behavior-equivalent for S1.
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blueGreenSlotReady, findPackageRepoDir } from './blue-green.js';
import { resolveDkgConfigHome } from './dkg-home.js';
import { resolveDkgCli } from './resolve-dkg-cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DKG_START_TIMEOUT_MS = 30_000;
const DKG_START_MIGRATION_TIMEOUT_MS = 60 * 60_000;

function log(msg: string): void {
  console.log(`[setup] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[setup] WARNING: ${msg}`);
}

/**
 * Resolve the DKG home directory the same way adapter setup does.
 * Used here for `daemon.pid` and `releases/` lookups.
 */
function dkgDir(): string {
  return resolveDkgConfigHome({ startDir: __dirname });
}

function hasLocalRepoForCli(cliPath: string): boolean {
  let physicalCliPath = cliPath;
  try {
    physicalCliPath = realpathSync(cliPath);
  } catch {
    // `resolveDkgCli` surfaces missing CLI paths later; keep timeout detection conservative here.
  }
  const repo = findPackageRepoDir(dirname(physicalCliPath));
  return Boolean(repo && existsSync(join(repo, '.git')));
}

function blueGreenMigrationMayRunDuringStart(cliPath: string): boolean {
  if (process.env.DKG_NO_BLUE_GREEN) return false;
  if (!hasLocalRepoForCli(cliPath)) return false;

  const releasesPath = join(dkgDir(), 'releases');
  const currentLink = join(releasesPath, 'current');

  try {
    if (!lstatSync(currentLink).isSymbolicLink()) return true;
  } catch {
    return true;
  }

  return !blueGreenSlotReady(join(releasesPath, 'a'))
    || !blueGreenSlotReady(join(releasesPath, 'b'));
}

function daemonStartSpawnOptions(cliPath: string): SpawnSyncOptions {
  const options: SpawnSyncOptions = { stdio: 'inherit' };
  options.timeout = blueGreenMigrationMayRunDuringStart(cliPath)
    ? DKG_START_MIGRATION_TIMEOUT_MS
    : DKG_START_TIMEOUT_MS;
  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon(apiPort: number): Promise<void> {
  // Check if already running
  const pidPath = join(dkgDir(), 'daemon.pid');
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      if (pid && isProcessRunning(pid)) {
        // Verify the running daemon is reachable on the expected port
        try {
          const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
          if (res.ok) {
            log(`DKG daemon already running (PID ${pid}, port ${apiPort})`);
            return;
          }
        } catch { /* not reachable on expected port */ }
        // PID is alive but not reachable — could be a stale PID, PID reuse,
        // or a port mismatch. Warn and fall through to attempt dkg start,
        // which will either succeed (if the PID wasn't actually DKG) or
        // fail with a clear error (if port is genuinely in use).
        warn(
          `PID ${pid} is alive but daemon not reachable on port ${apiPort}. ` +
          'Attempting to start — if this fails, run "dkg stop" first.',
        );
      }
    } catch { /* stale pid file */ }
  }

  log('Starting DKG daemon...');
  try {
    // Resolve the CLI entrypoint as an absolute path and spawn via
    // process.execPath so we don't depend on `dkg` being on PATH — which
    // `pnpm dkg openclaw setup` does not guarantee in a cloned monorepo.
    const { node, cliPath } = resolveDkgCli();
    const result = spawnSync(node, [cliPath, 'start'], daemonStartSpawnOptions(cliPath));
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `dkg start exited with ${result.status ?? `signal ${result.signal}`}`,
      );
    }
  } catch (err: any) {
    throw new Error(`Failed to start DKG daemon: ${err.message}`);
  }

  // Poll for readiness
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
      if (res.ok) {
        log('DKG daemon is ready');
        return;
      }
    } catch { /* not ready yet */ }
    await sleep(1_000);
  }

  warn('Daemon started but health check timed out — it may still be initializing');
}
