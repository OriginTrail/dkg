/**
 * Always-reported state summary for `dkg doctor` (OT-RFC-41 §4.7.0).
 *
 * Eighteen fields gathered from a mix of:
 *   - `~/.dkg/config.json` + `~/.dkg/daemon.pid` + `~/.dkg/previous-version`
 *   - `~/.dkg/auto-update/{last-check,last-error}.json`
 *   - `GET /api/status` (added by §4.9 — populates daemon.commit, distTag, buildTime, installMode)
 *   - `/proc/<pid>/cmdline` (Linux) / `ps -o command=` (macOS) — daemon entryPoint
 *   - `which dkg` + `<cli> --version` — CLI globalPath / version
 *   - `npm root -g` — paths.npmGlobalDkg
 *
 * Each gather step swallows its own errors and falls back to `null`.
 * The summary is informational; no check ever crashes on a
 * partially-collected summary.
 */
import { join } from 'node:path';
import { inspectNodeRuntime } from '../node-runtime-preflight.js';
import type { DoctorDeps, LocalInstallMode, StateSummary } from './types.js';

const AUTO_UPDATE_LAST_CHECK_FILE = 'auto-update/last-check.json';
const AUTO_UPDATE_LAST_ERROR_FILE = 'auto-update/last-error.json';
const AUTO_UPDATE_LAST_ERROR_MAX_BYTES = 1024;

/**
 * Detect the running CLI's install mode locally. Used as a fallback
 * when `GET /api/status#installMode` is unreachable (daemon down).
 * On a healthy daemon the API value supersedes this, since the
 * daemon's own entry-point resolution is the authoritative signal.
 *
 * Heuristic order:
 *   1. `isMonorepo` flag from deps — set by the orchestrator before
 *      calling this — wins. Monorepo work is unambiguous.
 *   2. `cli.globalPath` (if resolved) inside `/usr/local/lib/node_modules/`,
 *      `/opt/homebrew/lib/node_modules/` (Apple Silicon Homebrew),
 *      `~/.nvm/`, or `~/.volta/` → `npm-global`.
 *   3. CLI path inside an arbitrary `node_modules/` (not one of the
 *      global patterns above) → `npm-local`.
 *   4. Otherwise: `unknown`.
 */
export function detectLocalInstallMode(
  isMonorepo: boolean,
  cliGlobalPath: string | null,
): LocalInstallMode {
  if (isMonorepo) return 'monorepo';
  if (!cliGlobalPath) return 'unknown';
  const normalised = cliGlobalPath.replace(/\\/g, '/');
  const globalMarkers = [
    '/usr/local/lib/node_modules/',
    '/opt/homebrew/lib/node_modules/',
    '/usr/lib/node_modules/',
    '/.nvm/',
    '/.volta/',
    '/.fnm/',
    '/.asdf/installs/nodejs/',
  ];
  for (const marker of globalMarkers) {
    if (normalised.includes(marker)) return 'npm-global';
  }
  if (normalised.includes('/node_modules/')) return 'npm-local';
  return 'unknown';
}

/**
 * Resolve the running daemon's entry point (argv[1]) from its PID
 * using platform-appropriate primitives. Returns `null` when the
 * resolution fails for any reason (no PID, process gone, permission
 * denied, unknown platform) — the doctor's UI surfaces that as
 * `daemon.entryPoint: null`.
 */
async function resolveDaemonEntryPoint(
  deps: DoctorDeps,
  pid: number,
): Promise<string | null> {
  if (process.platform === 'linux') {
    const cmdline = await deps.readFile(`/proc/${pid}/cmdline`);
    if (!cmdline) return null;
    // /proc/<pid>/cmdline is NUL-separated argv. argv[1] is the script.
    const parts = cmdline.split('\0').filter(Boolean);
    return parts[1] ?? null;
  }
  // macOS / BSD: `ps -o command= -p <pid>` returns the full command
  // line as a single string. Use Node's path-ish split on whitespace
  // to extract argv[1]. This isn't perfect for paths with spaces,
  // but matches what an operator running `ps` by hand would see.
  if (process.platform === 'darwin' || process.platform === 'freebsd' || process.platform === 'openbsd') {
    const result = await deps.runCommand('ps', ['-o', 'command=', '-p', String(pid)]);
    if (!result || result.code !== 0) return null;
    const tokens = result.stdout.trim().split(/\s+/);
    return tokens[1] ?? null;
  }
  return null;
}

/**
 * Read and parse `~/.dkg/config.json`. Returns `{}` on missing /
 * malformed config — checks downstream report explicit findings
 * for those conditions.
 */
async function readDkgConfig(deps: DoctorDeps): Promise<Record<string, unknown>> {
  const raw = await deps.readFile(join(deps.dkgHome, 'config.json'));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readPid(deps: DoctorDeps): Promise<number | null> {
  const raw = await deps.readFile(join(deps.dkgHome, 'daemon.pid'));
  if (!raw) return null;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readPreviousVersion(deps: DoctorDeps): Promise<string | null> {
  const raw = await deps.readFile(join(deps.dkgHome, 'previous-version'));
  return raw ? raw.trim() || null : null;
}

async function readActiveSlot(deps: DoctorDeps, nodeRole: 'edge' | 'core' | null): Promise<string | null> {
  if (nodeRole !== 'core') return null;
  const slot = await deps.readlink(join(deps.dkgHome, 'releases', 'current'));
  return slot ?? null;
}

async function readAutoUpdateLastCheck(deps: DoctorDeps): Promise<string | null> {
  const raw = await deps.readFile(join(deps.dkgHome, AUTO_UPDATE_LAST_CHECK_FILE));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const ts = parsed && typeof parsed === 'object' ? (parsed as { timestamp?: unknown }).timestamp : null;
    return typeof ts === 'string' ? ts : null;
  } catch {
    return null;
  }
}

async function readAutoUpdateLastError(deps: DoctorDeps): Promise<string | null> {
  const raw = await deps.readFile(join(deps.dkgHome, AUTO_UPDATE_LAST_ERROR_FILE));
  if (!raw) return null;
  // Truncate to 1 KB to keep the JSON output digestable. The full
  // error remains on disk for an operator to grep manually.
  return raw.length > AUTO_UPDATE_LAST_ERROR_MAX_BYTES
    ? raw.slice(0, AUTO_UPDATE_LAST_ERROR_MAX_BYTES) + '\n…[truncated]'
    : raw;
}

async function resolveCliGlobalPath(deps: DoctorDeps): Promise<string | null> {
  // `which` on POSIX, `where.exe` on Windows. Both return non-zero
  // when the binary isn't on PATH.
  const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = await deps.runCommand(cmd, ['dkg']);
  if (!result || result.code !== 0) return null;
  const first = result.stdout.split(/\r?\n/).find((line) => line.trim());
  return first ? first.trim() : null;
}

async function resolveCliVersion(deps: DoctorDeps, cliPath: string | null): Promise<string | null> {
  if (!cliPath) return null;
  // Spawn the resolved CLI so we report what `which dkg` says, not
  // whatever's currently exec-ing the doctor. Mismatch between the
  // two is itself a finding in §4.7.4 — surfacing them separately
  // here lets the version-skew check do the comparison.
  const result = await deps.runCommand(cliPath, ['--version']);
  if (!result || result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function resolveNpmGlobalDkg(deps: DoctorDeps): Promise<string | null> {
  const result = await deps.runCommand('npm', ['root', '-g']);
  if (!result || result.code !== 0) return null;
  const root = result.stdout.trim();
  if (!root) return null;
  return join(root, '@origintrail-official', 'dkg');
}

/**
 * Collect the §4.7.0 state summary. Each sub-step is independent
 * and swallows its own failures — partial collection is preferred
 * over no collection at all. The doctor's checks below operate on
 * whatever fields landed.
 */
export async function collectStateSummary(deps: DoctorDeps): Promise<StateSummary> {
  const config = await readDkgConfig(deps);
  const nodeRoleRaw = (config as { nodeRole?: unknown }).nodeRole;
  const nodeRole: 'edge' | 'core' | null =
    nodeRoleRaw === 'core' ? 'core' : nodeRoleRaw === 'edge' ? 'edge' : 'edge';

  const autoUpdateRaw = (config as { autoUpdate?: Record<string, unknown> }).autoUpdate ?? {};
  const enabled = autoUpdateRaw.enabled === false ? false : true;
  const checkIntervalMinutes =
    typeof autoUpdateRaw.checkIntervalMinutes === 'number'
      ? autoUpdateRaw.checkIntervalMinutes
      : 30;
  const allowPrerelease = Boolean(autoUpdateRaw.allowPrerelease ?? true);
  const source = typeof autoUpdateRaw.source === 'string' ? autoUpdateRaw.source : null;

  const pid = await readPid(deps);
  const entryPoint = pid !== null ? await resolveDaemonEntryPoint(deps, pid) : null;

  const cliGlobalPath = await resolveCliGlobalPath(deps);
  const cliVersion = await resolveCliVersion(deps, cliGlobalPath);

  // Probe the daemon. Any per-field failure leaves `null` so checks
  // can still operate on the rest of the summary.
  const statusUrl = `http://127.0.0.1:${deps.apiPort}/api/status`;
  const status = await deps.fetchJson(statusUrl);
  const unreachableReason = status === null ? 'GET /api/status returned no parseable body' : undefined;

  const stringField = (name: string): string | null => {
    if (!status) return null;
    const v = (status as Record<string, unknown>)[name];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };

  const daemonInstallModeRaw = stringField('installMode');
  const daemonInstallMode: 'npm-global' | 'npm-local' | 'monorepo' | 'unknown' | null =
    daemonInstallModeRaw === 'npm-global'
      || daemonInstallModeRaw === 'npm-local'
      || daemonInstallModeRaw === 'monorepo'
      || daemonInstallModeRaw === 'unknown'
        ? daemonInstallModeRaw
        : status
          // §4.9 not deployed yet on this daemon — fall back to local detection.
          ? detectLocalInstallMode(deps.isMonorepo, cliGlobalPath)
          : detectLocalInstallMode(deps.isMonorepo, cliGlobalPath);

  const activeSlot = await readActiveSlot(deps, nodeRole);
  const npmGlobalDkg = await resolveNpmGlobalDkg(deps);
  const previousVersion = await readPreviousVersion(deps);
  const lastCheck = await readAutoUpdateLastCheck(deps);
  const lastError = await readAutoUpdateLastError(deps);

  return {
    runtime: inspectNodeRuntime(deps.runtimeHost),
    daemon: {
      pid,
      entryPoint,
      version: stringField('version'),
      commit: stringField('commit'),
      commitShort: stringField('commitShort'),
      buildTime: stringField('buildTime'),
      distTag: stringField('distTag'),
      installMode: daemonInstallMode,
      nodeRole,
      ...(unreachableReason ? { unreachableReason } : {}),
    },
    cli: {
      globalPath: cliGlobalPath,
      version: cliVersion,
    },
    paths: {
      dkgHome: deps.dkgHome,
      dkgHomeEnv: deps.dkgHomeEnv,
      activeSlot,
      npmGlobalDkg,
      pluginsRoot: join(deps.dkgHome, 'plugins'),
    },
    autoUpdate: {
      enabled,
      checkIntervalMinutes,
      allowPrerelease,
      source,
      lastCheck,
      lastError,
    },
    previousVersion,
  };
}
