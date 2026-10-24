import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDkgMonorepoRoot } from '@origintrail-official/dkg-core';

/**
 * Return true when `dir` is the published DKG CLI package root, as
 * determined by an adjacent package manifest and the packaged project asset.
 */
function isDkgPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    return pkg?.name === '@origintrail-official/dkg'
      && existsSync(join(dir, 'project.json'));
  } catch {
    return false;
  }
}

/**
 * Resolve validated roots for CLI runtime assets in priority order.
 *
 * Monorepo roots win so source edits are never shadowed by generated package
 * copies. Published installs have no monorepo ancestor and fall back to the
 * package root identified by package name plus its required project asset.
 */
export function runtimeAssetRoots(): string[] {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const out: string[] = [];

  // `src/` and `dist/` are currently at the same depth. Keep both validated
  // candidates to preserve the established root model if one layout moves.
  const monorepoCandidates = [
    join(thisDir, '..', '..', '..'),
    join(thisDir, '..', '..', '..', '..'),
  ];
  for (const dir of monorepoCandidates) {
    if (isDkgMonorepoRoot(dir) && !out.includes(dir)) out.push(dir);
  }

  const packageRoot = join(thisDir, '..');
  if (isDkgPackageRoot(packageRoot) && !out.includes(packageRoot)) {
    out.push(packageRoot);
  }

  return out;
}

/** Build candidate paths for one packaged runtime asset using the shared root model. */
export function runtimeAssetPaths(relativePath: string): string[] {
  return runtimeAssetRoots().map(root => join(root, relativePath));
}
