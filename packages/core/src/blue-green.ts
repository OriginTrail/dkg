import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Find the nearest package workspace root used by the CLI migration path. */
export function findPackageRepoDir(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the CLI entry point within a blue-green slot.
 * Supports both git layout (packages/cli/dist/cli.js) and
 * NPM layout (node_modules/@origintrail-official/dkg/dist/cli.js).
 */
export function blueGreenSlotEntryPoint(slotDir: string): string | null {
  const gitPath = join(slotDir, 'packages', 'cli', 'dist', 'cli.js');
  if (existsSync(gitPath)) return gitPath;
  const npmPath = join(slotDir, 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js');
  if (existsSync(npmPath)) return npmPath;
  return null;
}

/** Return true when a blue-green slot has an entry point and install metadata. */
export function blueGreenSlotReady(slotDir: string): boolean {
  const entry = blueGreenSlotEntryPoint(slotDir);
  if (!entry) return false;
  return existsSync(join(slotDir, '.git')) || existsSync(join(slotDir, 'package.json'));
}
