import { existsSync, lstatSync } from 'node:fs';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { releasesDir, repoDir, swapSlot, loadConfig, loadNetworkConfig } from './config.js';

/**
 * One-time migration from old single-directory layout to blue-green slots.
 * Called before `dkg start` if `~/.dkg/releases/current` doesn't exist.
 */
export async function migrateToBlueGreen(
  log: (msg: string) => void = console.log,
  opts: { allowRemoteBootstrap?: boolean } = {},
): Promise<void> {
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

  const repo = repoDir();
  const hasLocalRepo = existsSync(join(repo, '.git'));
  const normalizeCloneRepo = (value: string): string => {
    const v = value.trim();
    if (!v) return v;
    if (v.startsWith('/') || v.includes('://') || v.startsWith('git@')) return v;
    if (/^[^/\s]+\/[^/\s]+$/.test(v)) return `https://github.com/${v}.git`;
    return v;
  };

  let sourceRepo = repo;
  let sourceBranch = process.env.DKG_BRANCH?.trim() || 'main';
  if (!hasLocalRepo) {
    const config = await loadConfig().catch(() => ({} as any));
    const network = await loadNetworkConfig().catch(() => undefined);
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
      log('Migration: local repo has no .git; skipping remote bootstrap in this mode.');
      return;
    }
    log(`Migration: local repo has no .git, bootstrapping from ${sourceRepo}@${sourceBranch}`);
  }

  await mkdir(rDir, { recursive: true });

  const slotA = join(rDir, 'a');
  const slotB = join(rDir, 'b');
  const slotEntry = (slotDir: string) => join(slotDir, 'packages', 'cli', 'dist', 'cli.js');
  const slotReady = (slotDir: string) => existsSync(join(slotDir, '.git')) && existsSync(slotEntry(slotDir));
  if (hadCurrentLink && slotReady(slotA) && slotReady(slotB)) return;

  log('Migrating to blue-green release slots...');

  const git = (args: string[], cwd?: string): string =>
    String(execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 120_000,
      ...(cwd ? { cwd } : {}),
    })).trim();

  if (!slotReady(slotA)) {
    await rm(slotA, { recursive: true, force: true });
    if (hasLocalRepo) {
      git(['clone', '--local', repo, slotA]);
    } else {
      git(['clone', '--branch', sourceBranch, sourceRepo, slotA]);
    }
    execSync('pnpm install --frozen-lockfile', { cwd: slotA, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
    execSync('pnpm build', { cwd: slotA, encoding: 'utf-8', stdio: 'pipe', timeout: 180_000 });
    log(`  Slot a: cloned and built from ${hasLocalRepo ? repo : sourceRepo}`);
  }

  if (!slotReady(slotB)) {
    try {
      await rm(slotB, { recursive: true, force: true });
      if (hasLocalRepo) {
        // Keep slot B source aligned with slot A/local repo state.
        git(['clone', '--reference', slotA, '--dissociate', repo, slotB]);
      } else {
        const repoUrl = sourceRepo;
        git(['clone', '--reference', slotA, '--dissociate', repoUrl, slotB]);
      }
      if (!hasLocalRepo) {
        git(['checkout', sourceBranch], slotB);
      }
      execSync('pnpm install --frozen-lockfile', { cwd: slotB, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      execSync('pnpm build', { cwd: slotB, encoding: 'utf-8', stdio: 'pipe', timeout: 180_000 });
      log(`  Slot b: cloned and built`);
    } catch (err: any) {
      log(`  Slot b: clone/build failed (${err.message}). Will be prepared on first update.`);
      await rm(slotB, { recursive: true, force: true });
      try {
        const repoUrl = hasLocalRepo ? repo : sourceRepo;
        git(['clone', repoUrl, slotB]);
        if (!hasLocalRepo) {
          git(['checkout', sourceBranch], slotB);
        }
      } catch { await mkdir(slotB, { recursive: true }); }
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
