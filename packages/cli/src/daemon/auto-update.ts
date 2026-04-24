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
  type AutoUpdateConfig,
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
  const { dkgDir, writeFile } = _autoUpdateIo;
  const pendingFile = join(dkgDir(), ".update-pending.json");
  await writeFile(pendingFile, JSON.stringify(state, null, 2));
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
      await writeFile(versionFile, pending.version);
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
    await writeFile(versionFile, resolvedVersion);
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
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  refOverride?: string,
): Promise<string | null> {
  const result = await checkForNewCommitWithStatus(au, log, refOverride);
  return result.status === "available" ? (result.commit ?? null) : null;
}

export async function checkForNewCommitWithStatus(
  au: AutoUpdateConfig,
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
      return { status: "error" };
    }
    if (latestCommit === currentCommit) return { status: "up-to-date" };
    return { status: "available", commit: latestCommit };
  } catch (err: any) {
    log(
      `Auto-update: failed to check for new commit (${err?.message ?? String(err)})`,
    );
    return { status: "error" };
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

/**
 * Core blue-green update logic. Builds the new version in the inactive slot,
 * then atomically swaps the `releases/current` symlink.
 * Returns true if an update was applied (caller should SIGTERM to restart).
 */
export async function performUpdate(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  opts: {
    refOverride?: string;
    allowPrerelease?: boolean;
    verifyTagSignature?: boolean;
  } = {},
): Promise<boolean> {
  const status = await performUpdateWithStatus(au, log, opts);
  return status === "updated";
}

export async function performUpdateWithStatus(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  opts: {
    refOverride?: string;
    allowPrerelease?: boolean;
    verifyTagSignature?: boolean;
  } = {},
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
  try {
    return await _performUpdateInner(au, log, opts);
  } finally {
    await releaseUpdateLock();
    _updateInProgress = false;
  }
}

async function _performUpdateInner(
  au: AutoUpdateConfig,
  log: (msg: string) => void,
  opts: {
    refOverride?: string;
    allowPrerelease?: boolean;
    verifyTagSignature?: boolean;
  },
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

  let currentCommit = "";
  try {
    currentCommit = (await readFile(commitFile, "utf-8")).trim();
  } catch {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        encoding: "utf-8",
        cwd: activeDir,
      });
      currentCommit = stdout.trim();
      await writeFile(commitFile, currentCommit);
    } catch {
      return "failed";
    }
  }

  const pending = await readPendingUpdateState();
  if (pending) {
    const active = await activeSlot();
    if (active === pending.target) {
      if (pending.commit) await writeFile(commitFile, pending.commit);
      if (pending.version) await writeFile(versionFile, pending.version);
      await clearPendingUpdateState();
      currentCommit = pending.commit || currentCommit;
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
    log(
      `Auto-update: cleaning slot ${target} working tree (git clean -fdx)...`,
    );
    await execFileAsync("git", ["clean", "-fdx"], {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 120_000,
    });
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

  try {
    await execAsync("pnpm install --frozen-lockfile", {
      cwd: targetDir,
      encoding: "utf-8",
      timeout: 180_000,
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
      await execAsync("pnpm build:runtime", {
        cwd: targetDir,
        encoding: "utf-8",
        timeout: 180_000,
      });
    } else {
      log(
        "Auto-update: target repo has no build:runtime script; falling back to pnpm build.",
      );
      await execAsync("pnpm build", {
        cwd: targetDir,
        encoding: "utf-8",
        timeout: 180_000,
      });
      usedFullBuildFallback = true;
    }

    if (usedFullBuildFallback) {
      log(
        "Auto-update: contract build check skipped (full build fallback already executed).",
      );
    } else {
      let shouldBuildContracts = false;
      try {
        if (
          /^[0-9a-f]{6,40}$/i.test(currentCommit) &&
          /^[0-9a-f]{6,40}$/i.test(checkedOutCommit)
        ) {
          const { stdout } = await execFileAsync(
            "git",
            ["diff", "--name-only", `${currentCommit}..${checkedOutCommit}`],
            {
              cwd: targetDir,
              encoding: "utf-8",
              timeout: 30_000,
            },
          );
          const changedPaths = String(stdout)
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          shouldBuildContracts = changedPaths.some((p) =>
            p.startsWith("packages/evm-module/contracts/"),
          );
        }
      } catch (diffErr: any) {
        log(
          `Auto-update: contract-change check failed (${diffErr.message}); skipping contract build.`,
        );
        shouldBuildContracts = false;
      }

      if (shouldBuildContracts) {
        log(
          "Auto-update: contract folder changes detected; building @origintrail-official/dkg-evm-module...",
        );
        await execAsync(
          "pnpm --filter @origintrail-official/dkg-evm-module build",
          {
            cwd: targetDir,
            encoding: "utf-8",
            timeout: 300_000,
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
      await execAsync(
        "node packages/cli/scripts/bundle-markitdown-binaries.mjs --build-current-platform --best-effort",
        {
          cwd: targetDir,
          encoding: "utf-8",
          timeout: 900_000,
        },
      );
    } catch (markItDownErr: any) {
      log(
        `Auto-update: MarkItDown staging failed in slot ${target} â€” ${markItDownErr.message}. Continuing without document conversion on this node.`,
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
    await writeFile(commitFile, checkedOutCommit);
    if (nextVersion) await writeFile(versionFile, nextVersion);
    await clearPendingUpdateState();
    const swapElapsedMs = Date.now() - swapStartedAt;
    log(
      `Auto-update: swap complete; active slot is now ${target} (${checkedOutCommit.slice(0, 8)}) in ${swapElapsedMs}ms.`,
    );
  } catch (swapErr: any) {
    await clearPendingUpdateState();
    log(`Auto-update: symlink swap failed — ${swapErr.message}`);
    return "failed";
  }
  log(
    `Auto-update: build succeeded in slot ${target}` +
      `${nextVersion ? ` (version ${nextVersion})` : ""}. Swapped symlink. Restarting...`,
  );
  log("v9 auto-update test live leeroy jenkins");
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
  au: AutoUpdateConfig,
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
