import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, rm, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { releasesDir, repoDir, swapSlot, loadConfig, loadNetworkConfig, loadProjectConfig, gitCommandEnv, gitCommandArgs, slotReady } from './config.js';
import {
  FULL_BUILD_COMMAND,
  isNodeUiGitLayoutSlot,
  NODE_UI_PACKAGE_NAME_FALLBACKS,
  nodeUiPackageJsonPath,
  nodeUiPackageNamesFromCliPackageJson,
  nodeUiPackageNameFromPackageJson,
  nodeUiNpmStaticIndexPaths,
  nodeUiStaticBuildCommand,
  nodeUiStaticIndexPath,
  runtimeBuildCommandFromPackageJson,
} from './node-ui-static.js';

function npmCliPackageJsonPath(slotDir: string): string {
  return join(
    slotDir,
    'node_modules',
    '@origintrail-official',
    'dkg',
    'package.json',
  );
}

function nodeUiPackageNamesForNpmSlot(slotDir: string): string[] {
  try {
    return nodeUiPackageNamesFromCliPackageJson(
      readFileSync(npmCliPackageJsonPath(slotDir), 'utf-8'),
    );
  } catch {
    return NODE_UI_PACKAGE_NAME_FALLBACKS;
  }
}

function npmNodeUiStaticIndexPaths(slotDir: string): string[] {
  return nodeUiNpmStaticIndexPaths(slotDir, nodeUiPackageNamesForNpmSlot(slotDir));
}

function hasNpmNodeUiStaticBundle(slotDir: string): boolean {
  return npmNodeUiStaticIndexPaths(slotDir).some((indexFile) => existsSync(indexFile));
}

function hasRequiredNodeUiStaticBundle(slotDir: string): boolean {
  if (isNodeUiGitLayoutSlot(slotDir)) {
    return existsSync(nodeUiStaticIndexPath(slotDir));
  }
  return hasNpmNodeUiStaticBundle(slotDir);
}

function assertNodeUiStaticBundle(slotDir: string): void {
  const indexFile = nodeUiStaticIndexPath(slotDir);
  if (!existsSync(indexFile)) {
    throw new Error(`Node UI static bundle missing (${indexFile})`);
  }
}

function assertNpmNodeUiStaticBundle(slotDir: string): void {
  if (!hasNpmNodeUiStaticBundle(slotDir)) {
    throw new Error(`Node UI static bundle missing (${npmNodeUiStaticIndexPaths(slotDir).join(', ')})`);
  }
}

export const _migrationIo = {
  execSync: execSync as (...args: any[]) => any,
  execFileSync: execFileSync as (...args: any[]) => any,
  repoDir: repoDir as () => string | null,
  loadConfig: loadConfig as () => Promise<any>,
  loadNetworkConfig: loadNetworkConfig as () => Promise<any>,
  swapSlot: swapSlot as (slot: 'a' | 'b') => Promise<void>,
};

/**
 * One-time migration from old single-directory layout to blue-green slots.
 * Called before `dkg start` if `~/.dkg/releases/current` doesn't exist.
 */
export async function migrateToBlueGreen(
  log: (msg: string) => void = console.log,
  opts: { allowRemoteBootstrap?: boolean; repairLiveNodeUi?: boolean } = {},
): Promise<void> {
  const { execSync, execFileSync, repoDir, loadConfig, loadNetworkConfig, swapSlot: swapActiveSlot } = _migrationIo;
  const repairLiveNodeUi = opts.repairLiveNodeUi ?? true;
  const INSTALL_TIMEOUT_MS = 10 * 60_000;
  const BUILD_TIMEOUT_MS = 15 * 60_000;
  const rDir = releasesDir();
  const currentLink = join(rDir, 'current');
  let hadCurrentLink = false;
  if (existsSync(currentLink)) {
    try {
      hadCurrentLink = lstatSync(currentLink).isSymbolicLink();
      if (!hadCurrentLink) {
        log('Migration: found non-symlink releases/current; removing and recreating symlink.');
        await rm(currentLink, { recursive: true, force: true });
      }
    } catch {
      hadCurrentLink = false;
      await rm(currentLink, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const config = await loadConfig().catch(() => ({} as any));
  const network = await loadNetworkConfig().catch(() => undefined);
  const gitEnv = gitCommandEnv(config?.autoUpdate ?? network?.autoUpdate);
  const localRepo = repoDir();
  const hasLocalRepo = Boolean(localRepo && existsSync(join(localRepo, '.git')));
  const normalizeCloneRepo = (value: string): string => {
    const v = value.trim();
    if (!v) return v;
    if (v.startsWith('/') || v.includes('://') || v.startsWith('git@')) return v;
    if (/^[^/\s]+\/[^/\s]+$/.test(v)) return `https://github.com/${v}.git`;
    return v;
  };

  let sourceRepo = localRepo ?? '';
  let sourceBranch = process.env.DKG_BRANCH?.trim() || 'main';
  if (!hasLocalRepo) {
    const proj = loadProjectConfig();
    sourceRepo = normalizeCloneRepo(
      process.env.DKG_REPO
        ?? config?.autoUpdate?.repo
        ?? network?.autoUpdate?.repo
        ?? `${proj.githubUrl}.git`,
    );
    sourceBranch = (
      process.env.DKG_BRANCH
      ?? config?.autoUpdate?.branch
      ?? network?.autoUpdate?.branch
      ?? proj.defaultBranch
    ).trim() || proj.defaultBranch;
    if (!opts.allowRemoteBootstrap) {
      log('Migration: no local checkout with .git; skipping remote bootstrap in this mode.');
      return;
    }
    log(`Migration: no local checkout with .git, bootstrapping from ${sourceRepo}@${sourceBranch}`);
  }

  await mkdir(rDir, { recursive: true });

  const slotA = join(rDir, 'a');
  const slotB = join(rDir, 'b');
  if (
    hadCurrentLink &&
    slotReady(slotA) &&
    slotReady(slotB) &&
    hasRequiredNodeUiStaticBundle(slotA) &&
    hasRequiredNodeUiStaticBundle(slotB)
  ) {
    return;
  }

  log('Migrating to blue-green release slots...');

  const runSlotCommand = (cmd: string, cwd: string, timeout: number): void => {
    execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout,
    });
  };

  const resolveNodeUiPackageNames = (slotDir: string): string[] => {
    try {
      return [nodeUiPackageNameFromPackageJson(
        readFileSync(nodeUiPackageJsonPath(slotDir), 'utf-8'),
      )];
    } catch {
      return NODE_UI_PACKAGE_NAME_FALLBACKS;
    }
  };

  const runNodeUiStaticBuild = (slotDir: string): void => {
    let lastError: unknown;
    for (const packageName of resolveNodeUiPackageNames(slotDir)) {
      try {
        runSlotCommand(
          nodeUiStaticBuildCommand(packageName),
          slotDir,
          BUILD_TIMEOUT_MS,
        );
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  };

  const runtimeBuildCommand = (slotDir: string): string => {
    try {
      return runtimeBuildCommandFromPackageJson(
        readFileSync(join(slotDir, 'package.json'), 'utf-8'),
      );
    } catch {
      return FULL_BUILD_COMMAND;
    }
  };

  const buildRuntimeAndNodeUi = (slotDir: string): void => {
    runSlotCommand(runtimeBuildCommand(slotDir), slotDir, BUILD_TIMEOUT_MS);
    if (!existsSync(nodeUiStaticIndexPath(slotDir))) {
      runNodeUiStaticBuild(slotDir);
    }
    assertNodeUiStaticBundle(slotDir);
  };

  const repairNodeUiStaticBundle = (slotDir: string): void => {
    if (isNodeUiGitLayoutSlot(slotDir)) {
      runNodeUiStaticBuild(slotDir);
      assertNodeUiStaticBundle(slotDir);
      return;
    }

    assertNpmNodeUiStaticBundle(slotDir);
  };

  const activeSlotFromCurrent = async (): Promise<'a' | 'b' | null> => {
    try {
      const target = (await readlink(currentLink)).trim().split(/[\\/]/).pop();
      if (target === 'a' || target === 'b') return target;
    } catch {
      // Fall back to active metadata below.
    }
    try {
      const activeRaw = (await readFile(join(rDir, 'active'), 'utf-8')).trim();
      if (activeRaw === 'a' || activeRaw === 'b') return activeRaw;
    } catch {
      return null;
    }
    return null;
  };

  const slotReadyWithNodeUi = (label: 'a' | 'b'): boolean => {
    const slotDir = label === 'a' ? slotA : slotB;
    return slotReady(slotDir) && hasRequiredNodeUiStaticBundle(slotDir);
  };

  const hasRestorableSlot = (): boolean =>
    slotReadyWithNodeUi('a') || slotReadyWithNodeUi('b');
  let noCurrentRepairError: unknown;

  const ensureNodeUiBundle = (
    slotDir: string,
    label: 'a' | 'b',
    liveSlot: 'a' | 'b' | null,
  ): void => {
    if (!slotReady(slotDir) || hasRequiredNodeUiStaticBundle(slotDir)) return;
    if (liveSlot === label) {
      if (!repairLiveNodeUi) {
        log(`  Slot ${label}: Node UI static bundle missing in active slot; leaving live slot untouched.`);
        return;
      }
      log(`  Slot ${label}: Node UI static bundle missing in active slot; rebuilding UI assets in place.`);
    } else {
      log(`  Slot ${label}: Node UI static bundle missing; building UI assets.`);
    }
    try {
      repairNodeUiStaticBundle(slotDir);
      log(`  Slot ${label}: Node UI static bundle built`);
    } catch (err: any) {
      if (liveSlot === label) {
        log(
          `  Slot ${label}: Node UI static bundle repair failed (${err?.message ?? String(err)}). ` +
            'Continuing startup with the existing Node UI fallback page.',
        );
        return;
      }
      if (!liveSlot) {
        noCurrentRepairError ??= err;
        log(
          `  Slot ${label}: Node UI static bundle repair failed (${err?.message ?? String(err)}). ` +
            'Trying remaining slots before selecting an initial slot.',
        );
        return;
      }
      log(
        `  Slot ${label}: Node UI static bundle repair failed (${err?.message ?? String(err)}). ` +
          'Leaving inactive slot for the next update to rebuild.',
      );
    }
  };

  const git = (args: string[], cwd?: string, repoUrl?: string): string =>
    String(execFileSync('git', [...gitCommandArgs(repoUrl, config?.autoUpdate ?? network?.autoUpdate), ...args], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 120_000,
      env: gitEnv,
      ...(cwd ? { cwd } : {}),
    })).trim();

  if (!slotReady(slotA)) {
    await rm(slotA, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    if (hasLocalRepo) {
      git(['clone', '--local', localRepo!, slotA], undefined, localRepo!);
    } else {
      git(['clone', '--branch', sourceBranch, sourceRepo, slotA], undefined, sourceRepo);
    }
    runSlotCommand('pnpm install --frozen-lockfile', slotA, INSTALL_TIMEOUT_MS);
    buildRuntimeAndNodeUi(slotA);
    log(`  Slot a: cloned and built from ${hasLocalRepo ? localRepo : sourceRepo}`);
  }

  if (!slotReady(slotB)) {
    try {
      await rm(slotB, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (hasLocalRepo) {
        // Keep slot B source aligned with slot A/local repo state.
        git(['clone', '--reference', slotA, '--dissociate', localRepo!, slotB], undefined, localRepo!);
      } else {
        const repoUrl = sourceRepo;
        git(['clone', '--reference', slotA, '--dissociate', repoUrl, slotB], undefined, repoUrl);
      }
      if (!hasLocalRepo) {
        git(['checkout', sourceBranch], slotB);
      }
      runSlotCommand('pnpm install --frozen-lockfile', slotB, INSTALL_TIMEOUT_MS);
      buildRuntimeAndNodeUi(slotB);
      log(`  Slot b: cloned and built`);
    } catch (err: any) {
      log(`  Slot b: clone/build failed (${err.message}). Retrying clone only.`);
      await rm(slotB, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      try {
        const repoUrl = hasLocalRepo ? localRepo! : sourceRepo;
        git(['clone', repoUrl, slotB], undefined, repoUrl);
        if (!hasLocalRepo) {
          git(['checkout', sourceBranch], slotB);
        }
      } catch {
        // Keep slot B absent if bootstrap fails; avoid leaving a broken empty directory.
        await rm(slotB, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
        log('  Slot b: fallback clone failed; slot left uninitialized for later self-heal.');
      }
    }
  }

  const liveSlot = hadCurrentLink ? await activeSlotFromCurrent() : null;
  ensureNodeUiBundle(slotA, 'a', liveSlot);
  ensureNodeUiBundle(slotB, 'b', liveSlot);

  if (hadCurrentLink && liveSlot && !slotReadyWithNodeUi(liveSlot)) {
    if (!repairLiveNodeUi) {
      log(`Migration complete: active slot ${liveSlot} is missing Node UI static bundle; live slot left untouched.`);
      return;
    }
    log(
      `Migration complete: active slot ${liveSlot} is missing Node UI static bundle; ` +
        'startup will continue with the existing Node UI fallback page.',
    );
    return;
  }

  if (!hadCurrentLink) {
    let initialSlot: 'a' | 'b' | null = null;
    try {
      const activeRaw = (await readFile(join(rDir, 'active'), 'utf-8')).trim();
      if ((activeRaw === 'a' || activeRaw === 'b') && slotReadyWithNodeUi(activeRaw)) {
        initialSlot = activeRaw;
      }
    } catch {
      // No prior active metadata; default to a.
    }
    initialSlot ??= slotReadyWithNodeUi('a') ? 'a' : null;
    initialSlot ??= slotReadyWithNodeUi('b') ? 'b' : null;
    if (!initialSlot) {
      if (noCurrentRepairError) throw noCurrentRepairError;
      throw new Error('No blue-green slot has the required Node UI static bundle');
    }
    await swapActiveSlot(initialSlot);
    log(`Migration complete: releases/current → ${initialSlot}`);
    return;
  }

  log('Migration complete: repaired incomplete blue-green slots');
}
