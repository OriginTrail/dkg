/**
 * Shared helpers for resolving DKG_HOME, API port, PID, and auth tokens.
 *
 * These were previously duplicated across cli, mcp-server, and adapter-openclaw.
 * Centralizing them here ensures consistent behavior everywhere.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** Resolve the DKG home directory ($DKG_HOME or ~/.dkg). */
export function dkgHomeDir(): string {
  return process.env.DKG_HOME ?? join(homedir(), '.dkg');
}

export interface ResolveDkgConfigHomeOptions {
  /** Test/embedding override for the environment object. Defaults to process.env. */
  env?: Pick<NodeJS.ProcessEnv, 'DKG_HOME'>;
  /** Test/embedding override for the OS home directory. Defaults to homedir(). */
  homeDir?: string;
  /** Explicit monorepo signal. When omitted, the helper detects from its own package path. */
  isDkgMonorepo?: boolean;
  /** Optional start directory for monorepo detection. Defaults to this module's directory. */
  startDir?: string;
  /** Optional test override for whether `<home>/.dkg/config.json` exists. */
  configExists?: boolean;
}

/**
 * Resolve the DKG home used by config-writing flows such as `dkg init` and
 * adapter setup.
 *
 * This intentionally differs from `resolveDkgHome({ daemonUrl })`: that helper
 * observes daemon pid/port files for runtime adapter reads, while this helper
 * mirrors the CLI setup contract:
 *
 *   1. `DKG_HOME` wins.
 *   2. In a DKG monorepo checkout, if `~/.dkg/config.json` does not already
 *      exist, use `~/.dkg-dev` so development state stays separate from a
 *      globally installed CLI.
 *   3. Otherwise use `~/.dkg`.
 */
export function resolveDkgConfigHome(opts: ResolveDkgConfigHomeOptions = {}): string {
  const envHome = opts.env ? opts.env.DKG_HOME : process.env.DKG_HOME;
  if (envHome) return envHome;

  const home = opts.homeDir ?? homedir();
  const defaultDir = join(home, '.dkg');
  const configExists = opts.configExists ?? existsSync(join(defaultDir, 'config.json'));
  const isMonorepo = opts.isDkgMonorepo ?? findDkgMonorepoRoot(opts.startDir) !== null;
  if (isMonorepo && !configExists) return join(home, '.dkg-dev');
  return defaultDir;
}

/** Resolve `<dkgHome>/auth.token` for an already-resolved DKG home. */
export function dkgAuthTokenPath(dkgHome: string): string {
  return join(dkgHome, 'auth.token');
}

/**
 * Return true when `dir` is the DKG monorepo root.
 *
 * Combines structural markers (`pnpm-workspace.yaml`, `packages/`,
 * `project.json`) with a DKG-specific sub-marker:
 * `packages/cli/package.json` whose `name` is `@origintrail-official/dkg`.
 * The structural markers can match an unrelated pnpm/Nx workspace; the
 * canonical package name is reserved for us on npm and cannot be spoofed
 * without colliding with our published package.
 */
export function isDkgMonorepoRoot(dir: string): boolean {
  try {
    if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) return false;
    if (!existsSync(join(dir, 'packages'))) return false;
    if (!existsSync(join(dir, 'project.json'))) return false;

    const cliPkgPath = join(dir, 'packages', 'cli', 'package.json');
    if (!existsSync(cliPkgPath)) return false;
    const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf-8'));
    return cliPkg?.name === '@origintrail-official/dkg';
  } catch {
    return false;
  }
}

/** Find the nearest DKG monorepo root at or above `startDir`. */
export function findDkgMonorepoRoot(
  startDir = dirname(fileURLToPath(import.meta.url)),
): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (isDkgMonorepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Auto-resolve the active DKG home directory by observing what the running
 * daemon already wrote.
 *
 * Two install modes coexist on the same host: npm-installed daemons use
 * `~/.dkg`, monorepo-dev daemons use `~/.dkg-dev`. The CLI's `dkgDir()`
 * decides between them via `isDkgMonorepo()` markers, but those markers are
 * scoped to the caller's CWD — they're not visible to a separate process
 * (e.g. the OpenClaw gateway) that loads this adapter from somewhere else
 * on disk. Rather than duplicating the CLI's heuristic and re-deriving the
 * decision (issue #318 is exactly that bug), this resolver observes the
 * daemon's *effect*: at startup the daemon writes `daemon.pid` and
 * `api.port` into its chosen home dir.
 *
 * Resolution priority:
 *   1. `process.env.DKG_HOME` — explicit operator/user override wins.
 *   2. Liveness + `daemonUrl` port match (combined) — `process.kill(pid, 0)`
 *      confirms the home's daemon is running, AND its `api.port` matches
 *      the gateway's configured target. Both checks together defend
 *      against PID reuse (T73 — Codex): a stale `daemon.pid` whose PID
 *      has been recycled to an unrelated process passes the bare
 *      liveness check but its api.port won't match daemonUrl. When
 *      `daemonUrl` is absent, this degrades to liveness alone.
 *   3. `api.port` ↔ `daemonUrl` port match (alone) — fires when step 2
 *      couldn't disambiguate (e.g., both pids dead in cold-start, or a
 *      live PID in one home conflicts with a port match in another from
 *      PID reuse). Returns the home whose recorded port matches the
 *      gateway's target — operator intent wins.
 *   4. mtime fallback — when daemonUrl can't disambiguate (no
 *      daemonUrl, or both/neither home matches the port), pick the dir
 *      whose `api.port` was most recently modified. This is overwhelmingly
 *      the dir the user is about to start the daemon in again.
 *   5. Fresh-install fallback (no daemon signals at all): delegates to
 *      `resolveDkgConfigHome()` — `~/.dkg-dev` in a monorepo checkout
 *      without an existing `~/.dkg/config.json`, otherwise `~/.dkg`.
 *      Single source of truth keeps the runtime resolver in lockstep
 *      with the setup-time resolver so a cold-start gateway in a fresh
 *      monorepo install doesn't cache `~/.dkg` while setup writes the
 *      daemon config to `~/.dkg-dev` (Codex T75).
 *
 * Cost: a handful of sync filesystem reads plus 1–2 `process.kill(_, 0)`
 * calls. Sub-millisecond. Called once at adapter `register()` time.
 */
export interface ResolveDkgHomeOptions {
  /** Daemon URL — used for `api.port` ↔ port-match disambiguation. */
  daemonUrl?: string;
  /**
   * Test/embedding override for the monorepo signal used by step (5)'s
   * fresh-install fallback. When omitted, detection runs via
   * `findDkgMonorepoRoot()` from this module's path (which correctly
   * identifies monorepo when adapter and core are loaded from the
   * checkout, and returns null when both are in `node_modules/`).
   */
  isDkgMonorepo?: boolean;
}

export function resolveDkgHome(opts?: ResolveDkgHomeOptions): string {
  if (process.env.DKG_HOME) return process.env.DKG_HOME;

  const home = homedir();
  const dkg = join(home, '.dkg');
  const dkgDev = join(home, '.dkg-dev');

  const dkgPid = readDaemonPidSync(dkg);
  const dkgDevPid = readDaemonPidSync(dkgDev);
  const dkgAlive = dkgPid != null && isProcessAlive(dkgPid);
  const dkgDevAlive = dkgDevPid != null && isProcessAlive(dkgDevPid);

  // T73 — Compute port match against daemonUrl up-front; used by both the
  // step-1 combined check (defends against PID reuse) and the step-2
  // standalone port-match (cold start, both pids dead).
  let dkgPortMatch = false;
  let dkgDevPortMatch = false;
  let dkgPortAbsent = true;
  let dkgDevPortAbsent = true;
  let havePortTarget = false;
  if (opts?.daemonUrl) {
    const target = extractPort(opts.daemonUrl);
    if (target != null) {
      havePortTarget = true;
      const dkgPortFile = readDkgApiPortSync(dkg);
      const dkgDevPortFile = readDkgApiPortSync(dkgDev);
      dkgPortAbsent = dkgPortFile == null;
      dkgDevPortAbsent = dkgDevPortFile == null;
      dkgPortMatch = dkgPortFile === target;
      dkgDevPortMatch = dkgDevPortFile === target;
    }
  }

  // (1) Liveness + port match — for a home to win at this step, its daemon
  //     PID must be alive AND (when daemonUrl is set) its api.port must
  //     either match the target OR be absent. T73 — Codex flagged that
  //     bare `process.kill(pid, 0)` only proves SOME process owns that
  //     PID; a stale daemon.pid whose PID has been recycled to an
  //     unrelated process (firefox, systemd, anything) passes the
  //     liveness check and beats the later port-match step, returning
  //     the wrong home. Cross-checking api.port closes that gap when
  //     the homes have distinct ports.
  //
  //     The "or absent" relaxation handles two real cases:
  //     (a) Narrow startup race: daemon wrote daemon.pid but hasn't yet
  //         bound HTTP and written api.port. Without this relaxation,
  //         a fresh daemon would briefly resolve to the wrong home.
  //     (b) Test setups that mock liveness without api.port (legitimate
  //         per the daemon's own file-write order: pid first, port
  //         after bind).
  //
  //     PID reuse is still caught: a recycled PID inherits the OLD
  //     daemon's api.port file (which persists across crashes — the
  //     daemon never cleans it up at shutdown), so api.port WILL be
  //     present, and if it doesn't match daemonUrl this home is
  //     correctly rejected.
  //
  //     When the homes share a port (default 9200 on both), no port-based
  //     check can disambiguate; that case relies on liveness alone, with
  //     PID reuse there a much narrower risk (collision would have to be
  //     on the active daemon, not a stale dir).
  //
  //     When daemonUrl is absent, falls back to liveness alone.
  const dkgPortOK = !havePortTarget || dkgPortMatch || dkgPortAbsent;
  const dkgDevPortOK = !havePortTarget || dkgDevPortMatch || dkgDevPortAbsent;
  const dkgAuthoritative = dkgAlive && dkgPortOK;
  const dkgDevAuthoritative = dkgDevAlive && dkgDevPortOK;
  if (dkgAuthoritative && !dkgDevAuthoritative) return dkg;
  if (dkgDevAuthoritative && !dkgAuthoritative) return dkgDev;

  // (2) Port match alone — fires when step (1) couldn't disambiguate
  //     (e.g., both pids dead in cold-start, or live pid in one home
  //     conflicts with port match in the other from PID-reuse). T72 —
  //     previously gated on both-alive only; now generalized so the
  //     gateway's configured target wins regardless of liveness state.
  //
  //     Only fires when EXACTLY ONE home matches the target port. If both
  //     home dirs have the same port written (typical when an operator
  //     switches between npm and monorepo daemons that both default to
  //     9200), the port match is ambiguous and we fall through to mtime
  //     for tiebreak. If neither matches, the gateway is talking to a
  //     daemon neither home has ever hosted — fall through to mtime for
  //     a defensible default.
  if (havePortTarget) {
    if (dkgDevPortMatch && !dkgPortMatch) return dkgDev;
    if (dkgPortMatch && !dkgDevPortMatch) return dkg;
  }

  // (3) No daemonUrl, or daemonUrl port matched neither home: pick freshest
  //     by api.port mtime. Overwhelmingly the dir the user is about to
  //     restart the daemon in.
  const dkgMtime = mtimeOfMs(join(dkg, 'api.port'));
  const dkgDevMtime = mtimeOfMs(join(dkgDev, 'api.port'));
  if (dkgDevMtime != null && (dkgMtime == null || dkgDevMtime > dkgMtime)) return dkgDev;
  if (dkgMtime != null) return dkg;

  // (4) No daemon signals at all (fresh install, gateway started before
  //     the first daemon run). Delegate to `resolveDkgConfigHome` so the
  //     two resolvers stay in lockstep — any future change to monorepo /
  //     global-config rules updates both call paths from a single source
  //     of truth. Without this delegation, a cold-start gateway in a
  //     fresh monorepo install would cache `~/.dkg` while setup wrote the
  //     daemon to `~/.dkg-dev`, and the adapter would read auth.token /
  //     agent-keystore.json from the wrong dir for its plugin lifetime
  //     (Codex T75 — surfaced after PR #337 introduced
  //     `resolveDkgConfigHome` without backporting the monorepo knowledge
  //     here).
  //
  //     The `isDkgMonorepo` opt forwards through so test callers can
  //     control monorepo detection symmetrically; `process.env.DKG_HOME`
  //     was already short-circuited at the top of this function, so the
  //     redundant env re-check inside `resolveDkgConfigHome` is a no-op
  //     here.
  return resolveDkgConfigHome({ isDkgMonorepo: opts?.isDkgMonorepo });
}

/** Sync variant of `readDaemonPid` for use in `resolveDkgHome` (called from sync constructors). */
function readDaemonPidSync(dkgHome: string): number | null {
  try {
    const raw = readFileSync(join(dkgHome, 'daemon.pid'), 'utf-8');
    return parseStrictPosInt(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Sync read of `<dkgHome>/api.port`. Used by `resolveDkgHome` for the
 * two-daemon tiebreak. Does NOT honor `DKG_API_PORT` env (unlike the async
 * `readDkgApiPort`) because this is per-home-dir disambiguation, not a
 * global override.
 */
function readDkgApiPortSync(dkgHome: string): number | null {
  try {
    const raw = readFileSync(join(dkgHome, 'api.port'), 'utf-8');
    return parsePort(raw.trim());
  } catch {
    return null;
  }
}

/** Extract the numeric port from a URL string. Returns null if absent or invalid. */
function extractPort(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) return parsePort(parsed.port);
    if (parsed.protocol === 'http:') return 80;
    if (parsed.protocol === 'https:') return 443;
    return null;
  } catch {
    return null;
  }
}

/** Modification time of a file in ms since epoch, or null if unreadable / missing. */
function mtimeOfMs(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/** Read the daemon PID from $DKG_HOME/daemon.pid. Returns null if missing or invalid. */
export async function readDaemonPid(dkgHome?: string): Promise<number | null> {
  try {
    const raw = await readFile(join(dkgHome ?? dkgHomeDir(), 'daemon.pid'), 'utf-8');
    return parseStrictPosInt(raw.trim());
  } catch {
    return null;
  }
}

/** Check whether a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the API port from $DKG_API_PORT env or $DKG_HOME/api.port file.
 * If $DKG_API_PORT is set but invalid, returns null immediately (does not
 * fall through to the file) to avoid silently connecting to a stale port.
 */
export async function readDkgApiPort(dkgHome?: string): Promise<number | null> {
  if (process.env.DKG_API_PORT !== undefined) {
    return parsePort(process.env.DKG_API_PORT.trim());
  }

  try {
    const raw = await readFile(join(dkgHome ?? dkgHomeDir(), 'api.port'), 'utf-8');
    return parsePort(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Load the first non-comment, non-blank line from $DKG_HOME/auth.token.
 * Returns undefined if the file does not exist or is unreadable.
 */
export function loadAuthTokenSync(dkgHome?: string): string | undefined {
  const filePath = join(dkgHome ?? dkgHomeDir(), 'auth.token');
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith('#')) return t;
    }
  } catch { /* unreadable */ }
  return undefined;
}

const DECIMAL_INT_RE = /^[0-9]+$/;

/**
 * Parse a string as a strict positive decimal integer.
 * Rejects empty strings, hex (0x...), scientific notation (1e3), floats, and negative values.
 */
function parseStrictPosInt(value: string): number | null {
  if (!DECIMAL_INT_RE.test(value)) return null;
  const n = Number(value);
  return n > 0 ? n : null;
}

/** Parse a string as a valid TCP port (1–65535). Only accepts decimal digit strings. */
function parsePort(value: string): number | null {
  const n = parseStrictPosInt(value);
  if (n === null || n > 65535) return null;
  return n;
}

/** Async variant of loadAuthTokenSync. */
export async function loadAuthToken(dkgHome?: string): Promise<string | undefined> {
  const filePath = join(dkgHome ?? dkgHomeDir(), 'auth.token');
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = await readFile(filePath, 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith('#')) return t;
    }
  } catch { /* unreadable */ }
  return undefined;
}

/**
 * EIP-55 mixed-case checksum for an eth address.
 *
 * Retained narrow purpose: normalize explicit caller-supplied
 * `agent_address` values before WM queries. The daemon stores assertion graph
 * URIs under checksum-case default agent addresses, and SPARQL graph IRIs are
 * case-sensitive.
 *
 * @param address - hex-encoded eth address, with or without `0x` prefix.
 *                  Case-insensitive on input.
 * @returns The address in EIP-55 mixed-case form, with `0x` prefix.
 */
export function toEip55Checksum(address: string): string {
  const lower = address.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) {
    throw new Error(`toEip55Checksum: not a 40-hex-digit eth address: ${address}`);
  }
  // EIP-55 hashes the lowercase HEX STRING (ASCII bytes), then uppercases each
  // alpha character in the address whose corresponding hash nibble is >= 8.
  const hashBytes = keccak_256(new TextEncoder().encode(lower));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (ch >= 'a' && ch <= 'f') {
      // Each byte yields two hex nibbles. Even index -> high nibble.
      const byte = hashBytes[i >> 1];
      const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
      out += nibble >= 8 ? ch.toUpperCase() : ch;
    } else {
      out += ch;
    }
  }
  return out;
}
