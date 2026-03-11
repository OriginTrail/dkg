import { existsSync } from 'node:fs';
import { mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { releasesDir, repoDir, swapSlot } from './config.js';

/**
 * One-time migration from old single-directory layout to blue-green slots.
 * Called before `dkg start` if `~/.dkg/releases/current` doesn't exist.
 */
export async function migrateToBlueGreen(log: (msg: string) => void = console.log): Promise<void> {
  const rDir = releasesDir();
  const currentLink = join(rDir, 'current');
  const hadCurrentLink = existsSync(currentLink);

  const repo = repoDir();
  if (!existsSync(join(repo, '.git'))) {
    log('Migration: skipping — current code directory is not a git repo');
    return;
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
    git(['clone', '--local', repo, slotA]);
    execSync('pnpm install --frozen-lockfile', { cwd: slotA, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
    execSync('pnpm build', { cwd: slotA, encoding: 'utf-8', stdio: 'pipe', timeout: 180_000 });
    log(`  Slot a: cloned and built from ${repo}`);
  }

  if (!slotReady(slotB)) {
    try {
      await rm(slotB, { recursive: true, force: true });
      const repoUrl = git(['remote', 'get-url', 'origin'], repo);
      git(['clone', '--reference', slotA, '--dissociate', repoUrl, slotB]);
      execSync('pnpm install --frozen-lockfile', { cwd: slotB, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      execSync('pnpm build', { cwd: slotB, encoding: 'utf-8', stdio: 'pipe', timeout: 180_000 });
      log(`  Slot b: cloned and built`);
    } catch (err: any) {
      log(`  Slot b: clone/build failed (${err.message}). Will be prepared on first update.`);
      await rm(slotB, { recursive: true, force: true });
      try {
        const repoUrl = git(['remote', 'get-url', 'origin'], repo);
        git(['clone', repoUrl, slotB]);
      } catch { await mkdir(slotB, { recursive: true }); }
    }
  }

  if (!hadCurrentLink) {
    await swapSlot('a');
    log('Migration complete: releases/current → a');
    return;
  }

  log('Migration complete: repaired incomplete blue-green slots');
}
