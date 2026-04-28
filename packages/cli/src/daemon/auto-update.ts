// Auto-update subsystem extracted from the legacy monolithic
// `daemon.ts`. Two independent flavours of update: `performNpmUpdate`
// (standalone npm-installed `dkg` binary) and `performUpdate` (dkg-v9
// monorepo checkout, blue/green release slots). Live "last check"
// state is shared with `handleRequest`'s `/status` endpoint via
// `daemonState` in `./state.js`.

import { execSync, exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync, readFileSync, openSync, closeSync, unlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import {
  readFile, writeFile, mkdir, rm, chmod, copyFile, stat, rename, unlink,
} from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  dkgDir,
  releasesDir,
  activeSlot,
  inactiveSlot,
  swapSlot,
  gitCommandArgs,
  gitCommandEnv,
  isStandaloneInstall,
  slotEntryPoint,
  CLI_NPM_PACKAGE,
  type DkgConfig,
  type ResolvedAutoUpdateConfig,
} from '../config.js';
import {
  _autoUpdateIo,
  DAEMON_EXIT_CODE_RESTART,
  currentBundledMarkItDownAssetName,
  carryForwardBundledMarkItDownBinary,
} from './manifest.js';
import { daemonState } from './state.js';
import {
  expectedBundledMarkItDownBuildMetadata,
  readCliPackageVersion,
} from '../extraction/markitdown-bundle-metadata.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const daemonRequire = createRequire(import.meta.url);

/** Normalize repo to "owner/name" (strip URL prefix or .git suffix). */
export function normalizeRepo(repo: string): string {
  const t = repo.trim().replace(/\.git$/i, "");
  const m = t.match(/github\.com[/:](\S+\/\S+?)(?:\/|$)/);
  if (m) return m[1];
  return t;
}

export function parseTagName(ref: string): string | null {
  const m = ref.match(/^refs\/tags\/(.+)$/);
  return m ? m[1] : null;
}

export function isValidRef(ref: string): boolean {
  return /^[\w./+\-]+$/.test(ref) && !ref.startsWith("-");
}

export function isValidRepoSpec(repo: string): boolean {
  const trimmed = repo.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("-")) return false;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  if (/\s/.test(trimmed)) return false;

  if (trimmed.startsWith("/") || /^[A-Za-z]:\\/.test(trimmed)) return true; // Absolute local path.
  if (trimmed.startsWith("file://")) return true;
  if (
    trimmed.startsWith("https://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("git@")
  )
    return true;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(trimmed)) return true; // owner/name or owner/name.git
  if (/^[A-Za-z0-9._/\-]+$/.test(trimmed)) return true; // Relative local path.

  return false;
}

export function repoToFetchUrl(repo: string): string {
  const trimmed = repo.trim();
  if (!isValidRepoSpec(trimmed)) {
    throw new Error(`invalid autoUpdate.repo "${repo}"`);
  }
  if (!trimmed) return trimmed;
  if (
    trimmed.startsWith("/") ||
    trimmed.includes("://") ||
    trimmed.startsWith("git@")
  )
    return trimmed;
  const normalized = normalizeRepo(trimmed);
  if (/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return `https://github.com/${normalized}.git`;
  }
  return trimmed;
}

export function githubRepoForApi(repo: string): string | null {
  const trimmed = repo.trim().replace(/\.git$/i, "");
  if (!trimmed) return null;
  const urlMatch = trimmed.match(
    /github\.com[/:]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\/|$)/i,
  );
  if (urlMatch) return urlMatch[1];
  // Treat plain owner/name as GitHub shorthand; explicit paths should use ./ or / prefixes.
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) return trimmed;
  return null;
}

export async function resolveRemoteCommitSha(
  repoSpec: string,
  ref: string,
  log: (msg: string) => void,
  gitEnv: NodeJS.ProcessEnv,
): Promise<string | null> {
  const { fetch, execFile: execFileAsync } = _autoUpdateIo;
  let fetchUrl = "";
  try {
    fetchUrl = repoToFetchUrl(repoSpec);
  } catch (err: any) {
    log(`Auto-update: ${err?.message ?? "invalid autoUpdate.repo"}`);
    return null;
  }
  const githubRepo = githubRepoForApi(repoSpec);
  const isSshRepo =
    fetchUrl.startsWith("git@") || fetchUrl.startsWith("ssh://");
  const apiRef = ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");

  // Fast path for GitHub repos to preserve token-authenticated checks.
  if (githubRepo && !isSshRepo) {
    const url = `https://api.github.com/repos/${githubRepo}/commits/${encodeURIComponent(apiRef)}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 422 && ref.startsWith("refs/tags/")) {
        log(`Auto-update: tag "${apiRef}" not found in ${githubRepo}`);
        return null;
      }
      if (res.status === 404) {
        log(
          `Auto-update: GitHub returned 404 for ${githubRepo} ref "${ref}". ` +
            "If the repo is private, set GITHUB_TOKEN. Otherwise check repo/ref in config.",
        );
      } else {
        log(`Auto-update: GitHub API returned ${res.status} for ${url}`);
      }
      return null;
    }
    const data = (await res.json()) as { sha?: string };
    return data.sha ? String(data.sha).trim() : null;
  }

  // Generic path for local/non-GitHub repositories.
  const queryRefs = ref.startsWith("refs/tags/") ? [ref, `${ref}^{}`] : [ref];
  try {
    const raw = await execFileAsync(
      "git",
      [...gitCommandArgs(fetchUrl, null), "ls-remote", fetchUrl, ...queryRefs],
      {
        encoding: "utf-8",
        timeout: 30_000,
        env: gitEnv,
      },
    );
    const stdout =
      typeof raw === "string" ? raw : String((raw as any)?.stdout ?? "");
    const lines = String(stdout).trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      log(`Auto-update: ref "${ref}" not found in ${fetchUrl}`);
      return null;
    }
    const peeledTagRef = `${ref}^{}`;
    const parsed = lines
      .map((line) => line.split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([sha, remoteRef]) => ({
        sha: sha.trim(),
        remoteRef: remoteRef.trim(),
      }))
      .filter((entry) => /^[0-9a-f]{7,40}$/i.test(entry.sha));
    const peeled = parsed.find((entry) => entry.remoteRef === peeledTagRef);
    if (peeled) return peeled.sha;
    const exact = parsed.find((entry) => entry.remoteRef === ref);
    if (exact) return exact.sha;
    return parsed[0]?.sha ?? null;
  } catch (err: any) {
    log(
      `Auto-update: failed to resolve remote ref ${ref} from ${fetchUrl} (${err?.message ?? String(err)})`,
    );
    return null;
  }
}

export type PendingUpdateState = {
  target: "a" | "b";
  commit: string;
  version?: string;
  ref: string;
  createdAt: string;
};

export type CommitCheckStatus = {
  status: "available" | "up-to-date" | "error";
  commit?: string;
};

export async function readPendingUpdateState(): Promise<PendingUpdateState | null> {
  const { dkgDir, readFile } = _autoUpdateIo;
  const pendingFile = join(dkgDir(), ".update-pending.json");
  try {
    const raw = await readFile(pendingFile, "utf-8");
    const parsed = JSON.parse(raw) as PendingUpdateState;
    if ((parsed.target !== "a" && parsed.target !== "b") || !parsed.ref)
      return null;
    if (!parsed.commit && !parsed.version) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingUpdateState(): Promise<void> {
  const { dkgDir, unlink } = _autoUpdateIo;
  const pendingFile = join(dkgDir(), ".update-pending.json");
  try {
    await unlink(pendingFile);
  } catch {
    /* ok */
  }
}

export async function writePendingUpdateState(
  state: PendingUpdateState,
): Promise<void> {
  const pendingFile = join(_autoUpdateIo.dkgDir(), ".update-pending.json");
  await writeFileAtomic(pendingFile, JSON.stringify(state, null, 2));
}

/**
 * Write `data` to `path` via temp file + POSIX rename so a crash mid-write
 * never leaves a partially-written file at `path`. Used for bookkeeping files
 * that the daemon reads on startup or compares against — `.current-commit`,
 * `.current-version`, `.update-pending.json`, `.update-status.json`.
 *
 * Witnessed corruption that motivates this: on dkg-v9-relay-01 we found
 * `.current-commit` containing the same 40-char SHA written end-to-end with
 * no separator — an interrupted/retried `writeFile` to an existing file does
 * not truncate atomically. Reading that 80-char value then never matched any
 * remote SHA, sending the auto-updater into a permanent "update available"
 * loop that never converged.
 *
 * Falls back to a non-atomic write if `rename` is not available on the IO
 * surface (older test stubs); production always has it.
 */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const { writeFile, rename, unlink } = _autoUpdateIo;
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, data);
  try {
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ─── NPM-based auto-update helpers ──────────────────────────────────

/**
 * Query the NPM registry for the latest published version of the CLI package.
 * Uses `dist-tags.latest` by default; when `allowPrerelease` is true, also
 * checks `beta` / `next` tags and picks the highest semver.
 */
export type NpmVersionResult =
  | { version: string; error?: false }
  | { version: null; error: true }
  | { version: null; error: false };

export async function resolveLatestNpmVersion(
  log: (msg: string) => void,
  allowPrerelease = true,
): Promise<NpmVersionResult> {
  const { fetch } = _autoUpdateIo;
  const url = `https://registry.npmjs.org/${CLI_NPM_PACKAGE}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log(
        `Auto-update (npm): registry returned ${res.status} for ${CLI_NPM_PACKAGE}`,
      );
      return { version: null, error: true };
    }
    const data = (await res.json()) as { "dist-tags"?: Record<string, string> };
    const tags = data["dist-tags"];
    if (!tags) return { version: null, error: true };

    const stable = tags.latest ?? null;
    if (!allowPrerelease) {
      if (stable && !stable.includes("-")) return { version: stable };
      log(
        "Auto-update (npm): latest dist-tag is a pre-release and allowPrerelease=false, skipping",
      );
      return { version: null, error: false };
    }

    const candidates = [stable, tags.dev, tags.beta, tags.next].filter(
      Boolean,
    ) as string[];
    if (candidates.length === 0) return { version: null, error: false };
    candidates.sort((a, b) => compareSemver(b, a));
    return { version: candidates[0] };
  } catch (err: any) {
    log(
      `Auto-update (npm): registry check failed (${err?.message ?? String(err)})`,
    );
    return { version: null, error: true };
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
  const pb = b.replace(/^v/, "").split(/[-+]/)[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  const stripBuild = (s: string) => s.replace(/\+.*$/, "");
  const preA = a.includes("-")
    ? stripBuild(a.split("-").slice(1).join("-"))
    : "";
  const preB = b.includes("-")
    ? stripBuild(b.split("-").slice(1).join("-"))
    : "";
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return preA.localeCompare(preB, undefined, { numeric: true });
}

export function getCurrentCliVersion(): string {
  const { readFileSync } = _autoUpdateIo;
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    );
    return String(pkg.version ?? "").trim();
  } catch {
    return "";
  }
}

export type NpmVersionStatus = {
  status: "available" | "up-to-date" | "error";
  version?: string;
};

export async function checkForNpmVersionUpdate(
  log: (msg: string) => void,
  allowPrerelease = true,
): Promise<NpmVersionStatus> {
  const { dkgDir, readFile } = _autoUpdateIo;
  const versionFile = join(dkgDir(), ".current-version");
  let currentVersion = "";
  try {
    currentVersion = (await readFile(versionFile, "utf-8")).trim();
  } catch {
    currentVersion = getCurrentCliVersion();
  }

  if (!currentVersion) {
    log("Auto-update (npm): unable to determine current version");
    return { status: "error" };
  }

  const result = await resolveLatestNpmVersion(log, allowPrerelease);
  if (result.version === null)
    return { status: result.error ? "error" : "up-to-date" };

  if (result.version === currentVersion) return { status: "up-to-date" };
  if (compareSemver(result.version, currentVersion) <= 0)
    return { status: "up-to-date" };

  return { status: "available", version: result.version };
}

/**
 * Install a specific version of the CLI package into a blue-green slot via npm.
 * The slot contains a minimal package.json; `npm install` fetches the
 * pre-built package and all its dependencies.
 */
async function _performNpmUpdateInner(
  targetVersion: string,
  log: (msg: string) => void,
): Promise<UpdateStatus> {
  const { readFile, writeFile, mkdir, rm, existsSync, exec: execAsync, dkgDir, releasesDir, activeSlot, swapSlot, readCliPackageVersion, hasVerifiedBundledMarkItDownBinary, expectedBundledMarkItDownBuildMetadata } = _autoUpdateIo;
  const rDir = releasesDir();
  await mkdir(rDir, { recursive: true });

  const versionFile = join(dkgDir(), ".current-version");
  const pending = await readPendingUpdateState();
  if (pending) {
    const active = await activeSlot();
    if (active === pending.target && pending.version === targetVersion) {
      await writeFileAtomic(versionFile, pending.version);
      await clearPendingUpdateState();
      log(
        `Auto-update (npm): recovered pending update state for slot ${pending.target} (v${pending.version}).`,
      );
      return "updated";
    }
    await clearPendingUpdateState();
    if (active === pending.target && pending.version !== targetVersion) {
      log(
        `Auto-update (npm): pending version ${pending.version} differs from target ${targetVersion}, proceeding with fresh install.`,
      );
    } else {
      log("Auto-update (npm): cleared stale pending update state.");
    }
  }

  const active = (await activeSlot()) ?? "a";
  const activeDir = join(rDir, active);
  const target = active === "a" ? "b" : "a";
  const targetDir = join(rDir, target);

  log(
    `Auto-update (npm): installing ${CLI_NPM_PACKAGE}@${targetVersion} into slot ${target}...`,
  );

  try {
    // Clean the target slot to prevent stale artifacts (e.g. old git builds)
    // from being mistaken for a valid entry point after install.
    await rm(targetDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
    await mkdir(targetDir, { recursive: true });

    const slotPkg = {
      name: "dkg-release-slot",
      private: true,
      dependencies: { [CLI_NPM_PACKAGE]: targetVersion },
    };
    await writeFile(
      join(targetDir, "package.json"),
      JSON.stringify(slotPkg, null, 2),
    );

    const installStart = Date.now();
    await execAsync(`npm install --production --no-audit --no-fund`, {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 180_000,
    });
    const installMs = Date.now() - installStart;
    log(`Auto-update (npm): npm install completed in ${installMs}ms.`);
  } catch (installErr: any) {
    log(
      `Auto-update (npm): npm install failed — ${installErr?.message ?? String(installErr)}`,
    );
    return "failed";
  }

  const npmPkgDir = join(
    targetDir,
    "node_modules",
    "@origintrail-official",
    "dkg",
  );
  const npmEntry = join(npmPkgDir, "dist", "cli.js");
  if (!existsSync(npmEntry)) {
    log(`Auto-update (npm): entry point missing after install. Aborting swap.`);
    return "failed";
  }
  let resolvedVersion = readCliPackageVersion(npmPkgDir);
  if (!resolvedVersion) {
    resolvedVersion = targetVersion;
    log(
      `Auto-update (npm): could not read installed package version, using spec "${targetVersion}"`,
    );
  }
  const bundledMarkItDownAsset = currentBundledMarkItDownAssetName();
  if (bundledMarkItDownAsset) {
    const bundledMarkItDownPath = join(
      npmPkgDir,
      "bin",
      bundledMarkItDownAsset,
    );
    const expectedMetadata = expectedBundledMarkItDownBuildMetadata(
      npmPkgDir,
    ) ?? { cliVersion: resolvedVersion };
    if (
      !(await hasVerifiedBundledMarkItDownBinary(
        bundledMarkItDownPath,
        expectedMetadata,
      ))
    ) {
      const reused = await carryForwardBundledMarkItDownBinary({
        sourceCandidates: [
          join(
            activeDir,
            "node_modules",
            "@origintrail-official",
            "dkg",
            "bin",
            bundledMarkItDownAsset,
          ),
        ],
        targetBinaryPath: bundledMarkItDownPath,
        log,
        context: "Auto-update (npm)",
        expectedMetadata,
      });
      if (!reused) {
        log(
          `Auto-update (npm): bundled MarkItDown binary missing after install (${bundledMarkItDownPath}). Continuing without document conversion on this node.`,
        );
      }
    }
  }

  await writePendingUpdateState({
    target: target as "a" | "b",
    commit: "",
    version: resolvedVersion,
    ref: `npm:${resolvedVersion}`,
    createdAt: new Date().toISOString(),
  });

  try {
    log(`Auto-update (npm): swapping active slot to ${target}...`);
    await swapSlot(target as "a" | "b");
    await writeFileAtomic(versionFile, resolvedVersion);
    await clearPendingUpdateState();
    log(
      `Auto-update (npm): slot ${target} active (${CLI_NPM_PACKAGE}@${resolvedVersion}).`,
    );
  } catch (swapErr: any) {
    await clearPendingUpdateState();
    log(`Auto-update (npm): symlink swap failed — ${swapErr.message}`);
    return "failed";
  }

  return "updated";
}

// ─── Git-based auto-update helpers ──────────────────────────────────

/**
 * Check GitHub for a new commit on the configured branch.
 * Returns the latest commit SHA if an update is available, null otherwise.
 */
export async function checkForNewCommit(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
  refOverride?: string,
): Promise<string | null> {
  const result = await checkForNewCommitWithStatus(au, log, refOverride);
  return result.status === "available" ? (result.commit ?? null) : null;
}

export async function checkForNewCommitWithStatus(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
  refOverride?: string,
): Promise<CommitCheckStatus> {
  const { dkgDir, readFile, activeSlot, releasesDir, execSync } = _autoUpdateIo;
  const commitFile = join(dkgDir(), ".current-commit");
  let currentCommit = "";
  try {
    currentCommit = (await readFile(commitFile, "utf-8")).trim();
  } catch {
    const active = await activeSlot();
    const activeDir = join(releasesDir(), active ?? "a");
    try {
      currentCommit = execSync("git rev-parse HEAD", {
        encoding: "utf-8",
        cwd: activeDir,
        stdio: "pipe",
      }).trim();
    } catch {
      currentCommit = "";
    }
  }

  const ref = (refOverride ?? au.branch).trim() || "main";
  const gitEnv = gitCommandEnv(au);
  if (!isValidRef(ref)) {
    log(`Auto-update: invalid branch/ref "${ref}"`);
    return { status: "error" };
  }

  try {
    const latestCommit = await resolveRemoteCommitSha(
      au.repo,
      ref,
      log,
      gitEnv,
    );
    if (!latestCommit) {
      await recordCheck({ ref, status: 'error' });
      return { status: "error" };
    }
    if (latestCommit === currentCommit) {
      await recordCheck({ ref, status: 'up-to-date', remoteCommit: latestCommit });
      return { status: "up-to-date" };
    }
    await recordCheck({ ref, status: 'available', remoteCommit: latestCommit });
    return { status: "available", commit: latestCommit };
  } catch (err: any) {
    log(
      `Auto-update: failed to check for new commit (${err?.message ?? String(err)})`,
    );
    await recordCheck({ ref, status: 'error' });
    return { status: "error" };
  }
}

async function recordCheck(args: { ref: string; status: 'available' | 'up-to-date' | 'error'; remoteCommit?: string }): Promise<void> {
  try {
    const prev = (await readAutoUpdateStatus()) ?? { consecutiveFailures: 0 };
    await writeAutoUpdateStatus({
      ...prev,
      lastCheck: {
        at: new Date().toISOString(),
        ref: args.ref,
        status: args.status,
        ...(args.remoteCommit ? { remoteCommit: args.remoteCommit } : {}),
      },
    });
  } catch {
    /* observability-only */
  }
}

let _updateInProgress = false;
let _lockToken: string | null = null;
export type UpdateStatus = "updated" | "up-to-date" | "failed";

export async function acquireUpdateLock(log: (msg: string) => void): Promise<boolean> {
  const { releasesDir, mkdir, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } = _autoUpdateIo;
  const lockPath = join(releasesDir(), ".update.lock");
  try {
    await mkdir(releasesDir(), { recursive: true });
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, token);
    closeSync(fd);
    _lockToken = token;
    return true;
  } catch (err: any) {
    if (err.code === "EEXIST") {
      try {
        const raw = String(readFileSync(lockPath, "utf-8")).trim();
        const parts = raw.split(":");
        const pidStr = parts[0] ?? raw;
        const lockPid = parseInt(pidStr, 10);
        const lockTime = parseInt(parts[1] ?? "0", 10);
        const STALE_MS = 15 * 60 * 1000; // 15 minutes
        if (lockTime && Date.now() - lockTime > STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {}
          return acquireUpdateLock(log);
        }
        if (lockPid === process.pid) {
          _lockToken = raw;
          return true;
        }
        if (lockPid) {
          try {
            process.kill(lockPid, 0);
            log("Auto-update: another update process holds the lock, skipping");
            return false;
          } catch {
            // Lock holder is dead, remove stale lock
            try {
              unlinkSync(lockPath);
            } catch {}
            return acquireUpdateLock(log);
          }
        }
      } catch {
        /* can't read lock */
      }
    }
    // Fail closed: do not proceed if lock semantics are uncertain.
    log(
      `Auto-update: could not acquire lock (${err.code ?? err.message}), skipping`,
    );
    return false;
  }
}

export async function releaseUpdateLock(): Promise<void> {
  const { releasesDir, readFileSync, unlinkSync } = _autoUpdateIo;
  const lockPath = join(releasesDir(), ".update.lock");
  try {
    if (!_lockToken) return;
    const raw = String(readFileSync(lockPath, "utf-8")).trim();
    if (raw !== _lockToken) return;
    unlinkSync(lockPath);
  } catch {
    /* ok */
  }
  _lockToken = null;
}

// ─── Build-step helpers ────────────────────────────────────────────────

/** Default per-step build timeouts (milliseconds). Override via config. */
export const DEFAULT_BUILD_TIMEOUTS = {
  install: 180_000,
  build: 180_000,
  contracts: 300_000,
  markitdown: 900_000,
} as const;

export function resolveBuildTimeouts(
  au: Pick<ResolvedAutoUpdateConfig, 'buildTimeoutMs'>,
): { install: number; build: number; contracts: number; markitdown: number } {
  const t = au.buildTimeoutMs ?? {};
  return {
    install: positiveOr(t.install, DEFAULT_BUILD_TIMEOUTS.install),
    build: positiveOr(t.build, DEFAULT_BUILD_TIMEOUTS.build),
    contracts: positiveOr(t.contracts, DEFAULT_BUILD_TIMEOUTS.contracts),
    markitdown: positiveOr(t.markitdown, DEFAULT_BUILD_TIMEOUTS.markitdown),
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Run a build command with a timeout, then best-effort sweep orphan build
 * subprocesses on failure. Node's `exec` SIGTERMs the direct child on timeout
 * but pnpm's grandchildren (notably `solcjs-runner`) survive and pin a CPU,
 * which has caused subsequent update attempts on the same host to time out
 * even faster ("doom loop" observed on dkg-v9-relay-02/04). The sweep targets
 * narrow process-name patterns so we never kill unrelated workloads.
 */
export async function runBuildStep(
  execAsync: (cmd: string, opts: any) => Promise<any>,
  cmd: string,
  opts: { cwd: string; timeoutMs: number; label: string; log: (m: string) => void; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  const startedAt = Date.now();
  try {
    const result = await execAsync(cmd, {
      cwd: opts.cwd,
      encoding: 'utf-8',
      timeout: opts.timeoutMs,
      ...(opts.env ? { env: opts.env } : {}),
    });
    return { stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? '') };
  } catch (err: any) {
    const elapsedMs = Date.now() - startedAt;
    const timedOut =
      err?.killed === true ||
      err?.signal === 'SIGTERM' ||
      (typeof err?.message === 'string' && /timed? ?out/i.test(err.message));
    opts.log(
      `Auto-update: build step "${opts.label}" failed after ${elapsedMs}ms` +
        `${timedOut ? ` (timeout ${opts.timeoutMs}ms)` : ''} — ${err?.message ?? String(err)}`,
    );
    if (timedOut) {
      sweepOrphanBuildProcesses(opts.cwd, opts.log);
    }
    throw err;
  }
}

/**
 * After a build-step timeout, Node's `exec` SIGTERMs only the immediate child
 * (pnpm); grandchildren like `solcjs-runner`/`hardhat compile`/`tsc` survive
 * and pin a CPU, which has caused subsequent updates on the same host to time
 * out even faster ("doom loop" observed on dkg-v9-relay-02/04).
 *
 * We deliberately do NOT pattern-match command lines here: a host-wide
 * `pkill -f pnpm|hardhat|...` would also kill an operator's interactive
 * `pnpm install` or any unrelated workload running under the same user.
 * Instead we scope by:
 *   1) only OUR EUID's processes (`pgrep -u "$EUID"`), and
 *   2) only those whose `/proc/<pid>/cwd` resolves under the slot directory
 *      we're rebuilding.
 *
 * Build subprocesses inherit cwd from pnpm (which we run in `cwd: targetDir`),
 * so they all match. Anything outside the slot — interactive shells, other
 * services, builds in unrelated repos — is untouched.
 */
function sweepOrphanBuildProcesses(slotDir: string, log: (m: string) => void): void {
  const { execSync } = _autoUpdateIo;
  if (!slotDir || !slotDir.startsWith('/')) return;
  try {
    const script =
      'set -u; ' +
      'for pid in $(pgrep -u "$EUID" 2>/dev/null); do ' +
      '  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true); ' +
      '  case "$cwd" in ' +
      '    "$DKG_AU_SLOT"|"$DKG_AU_SLOT/"*) kill -KILL "$pid" 2>/dev/null || true ;; ' +
      '  esac; ' +
      'done';
    execSync(script, {
      stdio: 'ignore',
      timeout: 5_000,
      shell: '/bin/sh',
      env: { ...process.env, DKG_AU_SLOT: slotDir.replace(/\/+$/, '') },
    });
    log(`Auto-update: swept orphan build subprocesses with cwd under ${slotDir} (best-effort).`);
  } catch {
    /* best effort, never throw */
  }
}

/**
 * Wipe per-package `dist/` directories and `tsconfig.tsbuildinfo` files in
 * the slot before building. Called on the default (`forceClean: false`) path
 * because most upstream packages build with bare `tsc`, which does not
 * remove generated files when their source is deleted/renamed. Without this,
 * a fetch-and-rebuild cycle could leave stale `.js` in `dist/` and quietly
 * activate it on the next slot swap. The `forceClean: true` path runs
 * `git clean -fdx` instead (which already covers dist/), so this helper is
 * not called there. We deliberately do NOT touch:
 *   - `node_modules/` (preserved → pnpm install stays incremental)
 *   - `packages/evm-module/cache/` and `.../artifacts/` (Hardhat compile
 *     cache; cold solc builds on ARM64 routinely exceed the build-step
 *     timeout, so this cache is critical to keep)
 *
 * Best-effort: failure here is logged but doesn't abort the update.
 */
async function cleanGeneratedOutputs(
  targetDir: string,
  log: (m: string) => void,
): Promise<void> {
  const { execFile: execFileAsync } = _autoUpdateIo;
  try {
    await execFileAsync(
      'find',
      [
        'packages',
        '-mindepth', '2',
        '-maxdepth', '2',
        '-type', 'd',
        '-name', 'dist',
        '-prune',
        '-exec', 'rm', '-rf', '{}', '+',
      ],
      { cwd: targetDir, encoding: 'utf-8', timeout: 30_000 },
    );
    await execFileAsync(
      'find',
      [
        'packages',
        '-mindepth', '2',
        '-maxdepth', '2',
        '-type', 'f',
        '-name', 'tsconfig.tsbuildinfo',
        '-delete',
      ],
      { cwd: targetDir, encoding: 'utf-8', timeout: 30_000 },
    );
    log('Auto-update: cleared stale dist/ + tsconfig.tsbuildinfo before build (incremental caches preserved).');
  } catch (err: any) {
    log(`Auto-update: pre-build clean failed (${err?.message ?? String(err)}); proceeding anyway.`);
  }
}

/**
 * Decide whether to rebuild Solidity contracts. Same semantics as the original
 * inline check (skip on terminal diff failure) plus one robustness improvement:
 * if the parent commit isn't reachable in the slot's pack files (most common
 * cause is a shallow clone or upstream force-push rebase), try a single
 * `git fetch --depth=1 origin <currentCommit>` and retry the diff once before
 * giving up. We've never observed an ABI/JS mismatch from this skipping in
 * practice, so we err toward "less work" rather than "build to be safe".
 */
async function shouldRebuildContracts(args: {
  au: ResolvedAutoUpdateConfig;
  fetchUrl: string;
  currentCommit: string;
  checkedOutCommit: string;
  targetDir: string;
  execFileAsync: (file: string, args: string[], opts: any) => Promise<any>;
  log: (m: string) => void;
}): Promise<boolean> {
  const { au, fetchUrl, currentCommit, checkedOutCommit, targetDir, execFileAsync, log } = args;
  if (
    !/^[0-9a-f]{6,40}$/i.test(currentCommit) ||
    !/^[0-9a-f]{6,40}$/i.test(checkedOutCommit)
  ) {
    log('Auto-update: contract-change check skipped (commit SHAs invalid); skipping contract build.');
    return false;
  }
  const tryDiff = async (): Promise<{ ok: boolean; stdout?: string; err?: any }> => {
    try {
      const result = await execFileAsync(
        'git',
        ['diff', '--name-only', `${currentCommit}..${checkedOutCommit}`],
        { cwd: targetDir, encoding: 'utf-8', timeout: 30_000 },
      );
      return { ok: true, stdout: String(result?.stdout ?? '') };
    } catch (err: any) {
      return { ok: false, err };
    }
  };
  let diff = await tryDiff();
  if (!diff.ok) {
    // Most common cause: the parent commit isn't in the slot's pack files.
    // Fetch it explicitly (depth=1 on the SHA), then retry once. The slots
    // are initialized with bare `git init` and fetched via direct URL — no
    // `origin` remote is configured — so we must mirror the main fetch and
    // pass the URL + auth args explicitly. Best-effort: if the fetch itself
    // errors, skip the build (legacy behaviour); we've never observed a
    // real ABI/JS mismatch from this path.
    try {
      log(`Auto-update: contract-diff failed; fetching parent commit ${currentCommit.slice(0, 8)} to retry.`);
      await execFileAsync(
        'git',
        [...gitCommandArgs(fetchUrl, au), 'fetch', '--depth=1', fetchUrl, currentCommit],
        {
          cwd: targetDir,
          encoding: 'utf-8',
          timeout: 30_000,
          env: gitCommandEnv(au),
        },
      );
      diff = await tryDiff();
    } catch (fetchErr: any) {
      log(`Auto-update: parent-commit fetch failed (${fetchErr?.message ?? fetchErr}); skipping contract build.`);
      return false;
    }
  }
  if (!diff.ok) {
    log(
      `Auto-update: contract-change check failed (${diff.err?.message ?? diff.err}); skipping contract build.`,
    );
    return false;
  }
  const changedPaths = String(diff.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return changedPaths.some((p) => p.startsWith('packages/evm-module/contracts/'));
}

// ─── Persisted update outcome ──────────────────────────────────────────

/**
 * Single-row history file at `<DKG_HOME>/.update-status.json`. Operators (and
 * the dashboard / Graylog alerting) read this to detect stuck nodes without
 * needing to scrape the daemon log. `consecutiveFailures >= 3` is a good
 * alert threshold given a 30-min check interval.
 */
export interface AutoUpdateStatusFile {
  /** Last check (regardless of outcome). */
  lastCheck?: { at: string; ref: string; remoteCommit?: string; status: 'available' | 'up-to-date' | 'error' };
  /** Last attempted update (i.e. a remote commit was newer than local). */
  lastAttempt?: {
    at: string;
    ref: string;
    fromCommit: string;
    toCommit?: string;
    status: UpdateStatus;
    errorMessage?: string;
    elapsedMs: number;
  };
  /** Last successful update. */
  lastSuccess?: { at: string; ref: string; fromCommit: string; toCommit: string; version?: string };
  /** Consecutive failed attempts since the last `updated` outcome. */
  consecutiveFailures: number;
}

const STATUS_FILE_NAME = '.update-status.json';

export async function readAutoUpdateStatus(): Promise<AutoUpdateStatusFile | null> {
  const { dkgDir, readFile } = _autoUpdateIo;
  try {
    const raw = await readFile(join(dkgDir(), STATUS_FILE_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as AutoUpdateStatusFile;
    if (typeof parsed?.consecutiveFailures !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeAutoUpdateStatus(status: AutoUpdateStatusFile): Promise<void> {
  try {
    await writeFileAtomic(
      join(_autoUpdateIo.dkgDir(), STATUS_FILE_NAME),
      JSON.stringify(status, null, 2),
    );
  } catch {
    /* status file is observability-only; never break update flow */
  }
}

async function recordAttempt(args: {
  ref: string;
  fromCommit: string;
  toCommit?: string;
  status: UpdateStatus;
  errorMessage?: string;
  startedAt: number;
  version?: string;
}): Promise<void> {
  const prev = (await readAutoUpdateStatus()) ?? { consecutiveFailures: 0 };
  const nowIso = new Date().toISOString();
  const elapsedMs = Date.now() - args.startedAt;
  const next: AutoUpdateStatusFile = {
    ...prev,
    lastAttempt: {
      at: nowIso,
      ref: args.ref,
      fromCommit: args.fromCommit,
      ...(args.toCommit ? { toCommit: args.toCommit } : {}),
      status: args.status,
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      elapsedMs,
    },
    // Caller guards `up-to-date` so it never reaches here; only `updated`
    // resets the counter, every other terminal status (failed/error) bumps it.
    consecutiveFailures:
      args.status === 'updated'
        ? 0
        : (prev.consecutiveFailures ?? 0) + 1,
  };
  if (args.status === 'updated' && args.toCommit) {
    next.lastSuccess = {
      at: nowIso,
      ref: args.ref,
      fromCommit: args.fromCommit,
      toCommit: args.toCommit,
      ...(args.version ? { version: args.version } : {}),
    };
  }
  await writeAutoUpdateStatus(next);
}

/**
 * Core blue-green update logic. Builds the new version in the inactive slot,
 * then atomically swaps the `releases/current` symlink.
 * Returns true if an update was applied (caller should SIGTERM to restart).
 */
export interface PerformUpdateOptions {
  refOverride?: string;
  allowPrerelease?: boolean;
  verifyTagSignature?: boolean;
  /**
   * If true, run `git clean -fdx` in the inactive slot before building.
   * Default false: preserve `node_modules/` and the Hardhat compile cache so
   * the build is incremental. Cold rebuilds on ARM64 historically exceeded
   * the 5-minute build-step timeout. Operators who want a known-clean state
   * should set this explicitly.
   */
  forceClean?: boolean;
}

export async function performUpdate(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
  opts: PerformUpdateOptions = {},
): Promise<boolean> {
  const status = await performUpdateWithStatus(au, log, opts);
  return status === "updated";
}

export async function performUpdateWithStatus(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
  opts: PerformUpdateOptions = {},
): Promise<UpdateStatus> {
  if (_updateInProgress) {
    log("Auto-update: another update is already in progress, skipping");
    return "failed";
  }
  _updateInProgress = true;
  const locked = await acquireUpdateLock(log);
  if (!locked) {
    _updateInProgress = false;
    return "failed";
  }
  const startedAt = Date.now();
  let status: UpdateStatus = "failed";
  let errorMessage: string | undefined;
  // Allocate the capture object up-front so we still have whatever metadata
  // `_performUpdateInner` filled in (notably `fromCommit`) even if the inner
  // function throws — those exceptional paths are exactly what the persisted
  // status file is meant to surface.
  const outcome: { fromCommit: string; toCommit?: string; version?: string; ref: string } = {
    fromCommit: '',
    ref: (opts.refOverride ?? au.branch) || 'main',
  };
  try {
    status = await _performUpdateInner(au, log, opts, outcome);
    return status;
  } catch (err: any) {
    errorMessage = err?.message ?? String(err);
    throw err;
  } finally {
    await releaseUpdateLock();
    _updateInProgress = false;
    // Only persist when we got far enough to know the current commit;
    // otherwise the attempt is uninteresting (slots not initialized, etc.)
    // and would just pollute consecutiveFailures. Also skip "up-to-date"
    // outcomes — those are no-ops, not attempts, and recording them would
    // reset `consecutiveFailures` back to 0 on every idle poll, masking
    // a real preceding failure from the alerting signal.
    if (outcome.fromCommit && status !== 'up-to-date') {
      try {
        await recordAttempt({
          ref: outcome.ref,
          fromCommit: outcome.fromCommit,
          toCommit: outcome.toCommit,
          status,
          ...(errorMessage ? { errorMessage } : {}),
          startedAt,
          ...(outcome.version ? { version: outcome.version } : {}),
        });
      } catch {
        /* status persistence is observability-only */
      }
    }
  }
}

async function _performUpdateInner(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
  opts: PerformUpdateOptions,
  captured?: { fromCommit: string; toCommit?: string; version?: string; ref: string },
): Promise<UpdateStatus> {
  const { readFile, writeFile, mkdir, existsSync, exec: execAsync, execFile: execFileAsync, dkgDir, releasesDir, activeSlot, inactiveSlot, swapSlot, hasVerifiedBundledMarkItDownBinary, expectedBundledMarkItDownBuildMetadata } = _autoUpdateIo;
  const rDir = releasesDir();
  const activeDir = join(rDir, (await activeSlot()) ?? "a");
  const target = await inactiveSlot();
  const targetDir = join(rDir, target);

  // Bail out if the active slot is missing; target slot can self-heal below.
  if (!existsSync(activeDir)) {
    log(
      'Auto-update: skipping — blue-green slots not initialized (run "dkg start" first)',
    );
    return "failed";
  }

  const commitFile = join(dkgDir(), ".current-commit");
  const versionFile = join(dkgDir(), ".current-version");

  // Read the persisted current commit. Defensive length check: witnessed
  // corruption on dkg-v9-relay-01 (Apr 28 2026) had the file containing the
  // same 40-char SHA written twice end-to-end with no separator (80 chars),
  // which made the auto-updater spin because the value never matched any
  // real remote SHA. Anything longer than SHA-256 (64 chars) is by definition
  // corrupt; treat as missing and re-derive from `git rev-parse HEAD`. This
  // also self-heals pre-existing on-disk corruption on the next update cycle
  // because the next write goes through `writeFileAtomic`.
  let currentCommit = "";
  try {
    const raw = (await readFile(commitFile, "utf-8")).trim();
    if (raw && raw.length <= 64) {
      currentCommit = raw;
    } else if (raw) {
      log(
        `Auto-update: ${commitFile} contains malformed value (len=${raw.length}); re-deriving from active slot HEAD.`,
      );
    }
  } catch {
    /* file missing — fall through to derive from HEAD */
  }
  if (!currentCommit) {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        encoding: "utf-8",
        cwd: activeDir,
      });
      currentCommit = stdout.trim();
      await writeFileAtomic(commitFile, currentCommit);
    } catch {
      return "failed";
    }
  }

  if (captured) captured.fromCommit = currentCommit;

  const pending = await readPendingUpdateState();
  if (pending) {
    const active = await activeSlot();
    if (active === pending.target) {
      if (pending.commit) await writeFileAtomic(commitFile, pending.commit);
      if (pending.version) await writeFileAtomic(versionFile, pending.version);
      await clearPendingUpdateState();
      currentCommit = pending.commit || currentCommit;
      if (captured) captured.fromCommit = currentCommit;
      log(
        `Auto-update: recovered pending update state for slot ${pending.target}.`,
      );
    } else {
      await clearPendingUpdateState();
      log("Auto-update: cleared stale pending update state.");
    }
  }

  const ref = (opts.refOverride ?? au.branch).trim() || "main";
  const gitEnv = gitCommandEnv(au);

  if (!isValidRef(ref)) {
    log(`Auto-update: invalid branch/ref "${ref}"`);
    return "failed";
  }
  const latestCommit = await resolveRemoteCommitSha(au.repo, ref, log, gitEnv);
  if (!latestCommit) return "failed";

  if (latestCommit === currentCommit) return "up-to-date";

  log(
    `Auto-update: new commit detected (${latestCommit.slice(0, 8)}) for "${ref}", building in slot ${target}...`,
  );
  let checkedOutCommit = latestCommit;
  let fetchUrl = "";

  try {
    fetchUrl = repoToFetchUrl(au.repo);
  } catch (repoErr: any) {
    log(`Auto-update: ${repoErr?.message ?? "invalid autoUpdate.repo"}`);
    return "failed";
  }

  if (!existsSync(join(targetDir, ".git"))) {
    try {
      log(
        `Auto-update: slot ${target} missing git metadata; reinitializing slot repo.`,
      );
      await mkdir(targetDir, { recursive: true });
      await execFileAsync("git", ["init"], {
        cwd: targetDir,
        encoding: "utf-8",
        timeout: 30_000,
      });
    } catch (initErr: any) {
      log(
        `Auto-update: failed to initialize slot ${target} repo — ${initErr?.message ?? String(initErr)}`,
      );
      return "failed";
    }
  }

  try {
    const maybeTag = parseTagName(ref);
    const fetchRef = maybeTag ? `${ref}:${ref}` : ref;
    const fetchStartedAt = Date.now();
    log(
      `Auto-update: fetching "${ref}" from ${fetchUrl} into slot ${target}...`,
    );
    await execFileAsync(
      "git",
      [...gitCommandArgs(fetchUrl, au), "fetch", fetchUrl, fetchRef],
      {
        cwd: targetDir,
        encoding: "utf-8",
        timeout: 120_000,
        env: gitEnv,
      },
    );
    if (opts.verifyTagSignature && maybeTag) {
      await execFileAsync("git", ["verify-tag", maybeTag], {
        cwd: targetDir,
        encoding: "utf-8",
        timeout: 30_000,
      });
    }
    await execFileAsync("git", ["checkout", "--force", "FETCH_HEAD"], {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 60_000,
    });
    // Intentionally NOT running `git clean -fdx` by default here: untracked
    // files in the slot are dominated by `node_modules/` and the Hardhat
    // compile cache, which we want to PRESERVE so the subsequent build is
    // incremental (cold rebuilds on ARM64 routinely exceed 5 minutes due to
    // WASM solc and historically tripped the build-step timeout).
    //
    // BUT: a lot of packages here build with bare `tsc`, which doesn't
    // delete files removed/renamed in the source tree. If we just left
    // untracked files alone, an update could activate stale `dist/*.js`
    // from an older commit. So we DO wipe generated outputs (`dist/` and
    // `tsconfig.tsbuildinfo` per package) before each build — narrow enough
    // to leave incremental caches intact, broad enough to prevent stale
    // module activation. Operators wanting a fully cold rebuild can still
    // pass `opts.forceClean: true` (manual rebuild path) to also wipe
    // node_modules + caches.
    if (opts.forceClean) {
      log(
        `Auto-update: forceClean=true; running git clean -fdx in slot ${target} (cold rebuild)...`,
      );
      await execFileAsync("git", ["clean", "-fdx"], {
        cwd: targetDir,
        encoding: "utf-8",
        timeout: 120_000,
      });
    } else {
      await cleanGeneratedOutputs(targetDir, log);
    }
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 30_000,
    });
    const resolved = String(stdout).trim();
    if (/^[0-9a-f]{7,40}$/i.test(resolved)) checkedOutCommit = resolved;
    const fetchElapsedMs = Date.now() - fetchStartedAt;
    log(
      `Auto-update: fetch complete in slot ${target}, checked out ${checkedOutCommit.slice(0, 8)} ` +
        `(in ${fetchElapsedMs}ms).`,
    );
  } catch (fetchErr: any) {
    log(
      `Auto-update: git fetch/checkout/verify failed in slot ${target} — ${fetchErr.message}`,
    );
    return "failed";
  }

  const timeouts = resolveBuildTimeouts(au);

  try {
    await runBuildStep(execAsync, "pnpm install --frozen-lockfile", {
      cwd: targetDir,
      timeoutMs: timeouts.install,
      label: "pnpm install",
      log,
    });
    let usedFullBuildFallback = false;
    let hasRuntimeBuildScript = false;
    try {
      const rootPkgRaw = await readFile(
        join(targetDir, "package.json"),
        "utf-8",
      );
      const rootPkg = JSON.parse(rootPkgRaw) as {
        scripts?: Record<string, string>;
      };
      hasRuntimeBuildScript =
        typeof rootPkg.scripts?.["build:runtime"] === "string";
    } catch {
      hasRuntimeBuildScript = false;
    }

    if (hasRuntimeBuildScript) {
      await runBuildStep(execAsync, "pnpm build:runtime", {
        cwd: targetDir,
        timeoutMs: timeouts.build,
        label: "pnpm build:runtime",
        log,
      });
    } else {
      log(
        "Auto-update: target repo has no build:runtime script; falling back to pnpm build.",
      );
      await runBuildStep(execAsync, "pnpm build", {
        cwd: targetDir,
        timeoutMs: timeouts.build,
        label: "pnpm build",
        log,
      });
      usedFullBuildFallback = true;
    }

    if (usedFullBuildFallback) {
      log(
        "Auto-update: contract build check skipped (full build fallback already executed).",
      );
    } else {
      const shouldBuildContracts = await shouldRebuildContracts({
        au,
        fetchUrl,
        currentCommit,
        checkedOutCommit,
        targetDir,
        execFileAsync,
        log,
      });

      if (shouldBuildContracts) {
        log(
          "Auto-update: contract folder changes detected; building @origintrail-official/dkg-evm-module...",
        );
        await runBuildStep(
          execAsync,
          "pnpm --filter @origintrail-official/dkg-evm-module build",
          {
            cwd: targetDir,
            timeoutMs: timeouts.contracts,
            label: "pnpm --filter dkg-evm-module build",
            log,
          },
        );
        log(
          "Auto-update: @origintrail-official/dkg-evm-module build completed.",
        );
      } else {
        log(
          "Auto-update: no contract folder changes detected; skipping @origintrail-official/dkg-evm-module build.",
        );
      }
    }

    log("Auto-update: staging MarkItDown binary for the inactive slot...");
    try {
      await runBuildStep(
        execAsync,
        "node packages/cli/scripts/bundle-markitdown-binaries.mjs --build-current-platform --best-effort",
        {
          cwd: targetDir,
          timeoutMs: timeouts.markitdown,
          label: "bundle-markitdown",
          log,
        },
      );
    } catch (markItDownErr: any) {
      log(
        `Auto-update: MarkItDown staging failed in slot ${target} — ${markItDownErr.message}. Continuing without document conversion on this node.`,
      );
    }
  } catch (err: any) {
    log(
      `Auto-update: build failed in slot ${target} — ${err.message}. Active slot untouched.`,
    );
    return "failed";
  }

  const entryFile = join(targetDir, "packages", "cli", "dist", "cli.js");
  if (!existsSync(entryFile)) {
    log(`Auto-update: build output missing (${entryFile}). Aborting swap.`);
    return "failed";
  }
  const bundledMarkItDownAsset = currentBundledMarkItDownAssetName();
  if (bundledMarkItDownAsset) {
    const bundledMarkItDownPath = join(
      targetDir,
      "packages",
      "cli",
      "bin",
      bundledMarkItDownAsset,
    );
    const expectedMetadata = expectedBundledMarkItDownBuildMetadata(
      join(targetDir, "packages", "cli"),
    );
    if (
      !(await hasVerifiedBundledMarkItDownBinary(
        bundledMarkItDownPath,
        expectedMetadata,
      ))
    ) {
      const reused = await carryForwardBundledMarkItDownBinary({
        sourceCandidates: [
          join(activeDir, "packages", "cli", "bin", bundledMarkItDownAsset),
          join(
            activeDir,
            "node_modules",
            "@origintrail-official",
            "dkg",
            "bin",
            bundledMarkItDownAsset,
          ),
        ],
        targetBinaryPath: bundledMarkItDownPath,
        log,
        context: "Auto-update",
        expectedMetadata,
      });
      if (!reused) {
        log(
          `Auto-update: bundled MarkItDown binary missing (${bundledMarkItDownPath}). Continuing without document conversion on this node.`,
        );
      }
    }
  }

  let nextVersion = "";
  try {
    const pkgRaw = await readFile(
      join(targetDir, "packages", "cli", "package.json"),
      "utf-8",
    );
    nextVersion = String(
      (JSON.parse(pkgRaw) as { version?: string }).version ?? "",
    ).trim();
  } catch {
    // Version is optional metadata for operators; commit SHA remains source of truth.
  }
  const allowPrerelease = opts.allowPrerelease ?? au.allowPrerelease ?? true;
  if (
    nextVersion &&
    !allowPrerelease &&
    /^[0-9]+\.[0-9]+\.[0-9]+-/.test(nextVersion)
  ) {
    log(
      `Auto-update: target version ${nextVersion} is pre-release and allowPrerelease=false. Aborting swap.`,
    );
    return "failed";
  }

  await writePendingUpdateState({
    target,
    commit: checkedOutCommit,
    version: nextVersion || undefined,
    ref,
    createdAt: new Date().toISOString(),
  });
  try {
    const swapStartedAt = Date.now();
    log(`Auto-update: swapping active slot to ${target}...`);
    await swapSlot(target);
    await writeFileAtomic(commitFile, checkedOutCommit);
    if (nextVersion) await writeFileAtomic(versionFile, nextVersion);
    await clearPendingUpdateState();
    const swapElapsedMs = Date.now() - swapStartedAt;
    log(
      `Auto-update: swap complete; active slot is now ${target} (${checkedOutCommit.slice(0, 8)}) in ${swapElapsedMs}ms.`,
    );
    if (captured) {
      captured.toCommit = checkedOutCommit;
      if (nextVersion) captured.version = nextVersion;
    }
  } catch (swapErr: any) {
    await clearPendingUpdateState();
    log(`Auto-update: symlink swap failed — ${swapErr.message}`);
    return "failed";
  }
  log(
    `Auto-update: build succeeded in slot ${target}` +
      `${nextVersion ? ` (version ${nextVersion})` : ""}. Swapped symlink. Restarting...`,
  );
  return "updated";
}

export async function performNpmUpdate(
  targetVersion: string,
  log: (msg: string) => void,
): Promise<UpdateStatus> {
  if (_updateInProgress) {
    log("Auto-update (npm): another update is already in progress, skipping");
    return "failed";
  }
  _updateInProgress = true;
  const locked = await acquireUpdateLock(log);
  if (!locked) {
    _updateInProgress = false;
    return "failed";
  }
  try {
    return await _performNpmUpdateInner(targetVersion, log);
  } finally {
    await releaseUpdateLock();
    _updateInProgress = false;
  }
}

export async function checkForUpdate(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    const updated = await performUpdate(au, log);
    return updated;
  } catch (err: any) {
    log(`Auto-update: error — ${err.message}`);
    return false;
  }
}
