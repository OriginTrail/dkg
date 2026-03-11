import { existsSync } from 'node:fs';
import { mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { releasesDir, repoDir, swapSlot } from './config.js';

/**
 * One-time migration from old single-directory layout to blue-green slots.
 * Called before `dkg start` if `~/.dkg/releases/current` doesn't exist.
 */
export async function migrateToBlueGreen(log: (msg: string) => void = console.log): Promise<void> {
  const rDir = releasesDir();
  const currentLink = join(rDir, 'current');

  if (existsSync(currentLink)) return;

  const repo = repoDir();
  if (!existsSync(join(repo, '.git'))) {
    log('Migration: skipping — current code directory is not a git repo');
    return;
  }

  log('Migrating to blue-green release slots...');
  await mkdir(rDir, { recursive: true });

  const slotA = join(rDir, 'a');
  const slotB = join(rDir, 'b');

  if (!existsSync(slotA)) {
    execSync(`git clone --local "${repo}" "${slotA}"`, { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
    log(`  Slot a: cloned from ${repo}`);
  }

  if (!existsSync(slotB)) {
    try {
      const repoUrl = execSync('git remote get-url origin', { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
      execSync(`git clone --reference "${slotA}" --dissociate "${repoUrl}" "${slotB}"`, { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      execSync('pnpm install --frozen-lockfile', { cwd: slotB, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      execSync('pnpm build', { cwd: slotB, encoding: 'utf-8', stdio: 'pipe', timeout: 180_000 });
      log(`  Slot b: cloned and built`);
    } catch (err: any) {
      log(`  Slot b: clone/build failed (${err.message}). Will be prepared on first update.`);
      await rm(slotB, { recursive: true, force: true });
      try {
        const repoUrl = execSync('git remote get-url origin', { cwd: repo, encoding: 'utf-8', stdio: 'pipe' }).trim();
        execSync(`git clone "${repoUrl}" "${slotB}"`, { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      } catch { await mkdir(slotB, { recursive: true }); }
    }
  }

  await swapSlot('a');
  log('Migration complete: releases/current → a');
}
