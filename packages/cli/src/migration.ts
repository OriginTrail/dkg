import { existsSync, lstatSync } from 'node:fs';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { releasesDir, repoDir, swapSlot, loadConfig, loadNetworkConfig, gitCommandEnv, gitCommandArgs, slotEntryPoint } from './config.js';

export const _migrationIo = {
  execSync: execSync as (...args: any[]) => any,
  execFileSync: execFileSync as (...args: any[]) => any,
  repoDir: repoDir as () => string | null,
  loadConfig: loadConfig as () => Promise<any>,
  loadNetworkConfig: loadNetworkConfig as () => Promise<any>,
};

/**
 * One-time migration from old single-directory layout to blue-green slots.
 * Called before `dkg start` if `~/.dkg/releases/current` doesn't exist.
 */
export async function migrateToBlueGreen(
  log: (msg: string) => void = console.log,
  opts: { allowRemoteBootstrap?: boolean } = {},
): Promise<void> {
  const { execSync, execFileSync, repoDir, loadConfig, loadNetworkConfig } = _migrationIo;
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
    sourceRepo = normalizeCloneRepo(
      process.env.DKG_REPO
        ?? config?.autoUpdate?.repo
        ?? network?.autoUpdate?.repo
        ?? 'https://github.com/OriginTrail/dkg-v9.git',
    );
    sourceBranch = (
      process.env.DKG_BRANCH
      ?? config?.autoUpdate?.branch
      ?? network?.autoUpdate?.branch
      ?? 'main'
    ).trim() || 'main';
    if (!opts.allowRemoteBootstrap) {
      log('Migration: no local checkout with .git; skipping remote bootstrap in this mode.');
      return;
    }
    log(`Migration: no local checkout with .git, bootstrapping from ${sourceRepo}@${sourceBranch}`);
  }

  await mkdir(rDir, { recursive: true });

  const slotA = join(rDir, 'a');
  const slotB = join(rDir, 'b');
  const slotReady = (slotDir: string) => {
    const entry = slotEntryPoint(slotDir);
    if (!entry) return false;
    return existsSync(join(slotDir, '.git')) || existsSync(join(slotDir, 'package.json'));
  };
  if (hadCurrentLink && slotReady(slotA) && slotReady(slotB)) return;

  log('Migrating to blue-green release slots...');

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
    execSync('pnpm install --frozen-lockfile', {
      cwd: slotA,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: INSTALL_TIMEOUT_MS,
    });
    execSync('pnpm build:runtime', {
      cwd: slotA,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: BUILD_TIMEOUT_MS,
    });
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
      execSync('pnpm install --frozen-lockfile', {
        cwd: slotB,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: INSTALL_TIMEOUT_MS,
      });
      execSync('pnpm build:runtime', {
        cwd: slotB,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: BUILD_TIMEOUT_MS,
      });
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

  if (!hadCurrentLink) {
    let initialSlot: 'a' | 'b' = 'a';
    try {
      const activeRaw = (await readFile(join(rDir, 'active'), 'utf-8')).trim();
      if ((activeRaw === 'a' || activeRaw === 'b') && slotReady(join(rDir, activeRaw))) {
        initialSlot = activeRaw;
      }
    } catch {
      // No prior active metadata; default to a.
    }
    await swapSlot(initialSlot);
    log(`Migration complete: releases/current → ${initialSlot}`);
    return;
  }

  log('Migration complete: repaired incomplete blue-green slots');
}
