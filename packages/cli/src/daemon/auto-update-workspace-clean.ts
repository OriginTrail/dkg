import { lstat, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nodeUiStaticIndexPath } from '../node-ui-static.js';
import type { _autoUpdateIo } from './manifest.js';
import { randomUUID } from 'node:crypto';

async function directory(path: string): Promise<boolean> {
  try {
    // Do not follow node_modules, scope or package symlinks outside the slot.
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Remove only undeclared, unpacked root copies of packages in packages/*.
 * pnpm install can retain these old npm copies, allowing them to shadow a
 * workspace package's self-reference and its exports during TypeScript builds.
 * The caller holds the update lock and supplies the inactive git slot.
 */
export async function cleanStaleWorkspacePackages(
  slot: string,
  log: (message: string) => void,
): Promise<void> {
  const modules = join(slot, 'node_modules');
  const packages = join(slot, 'packages');
  if (!await directory(modules) || !await directory(packages)) return;
  const root = JSON.parse(await readFile(join(slot, 'package.json'), 'utf8'));
  const declared = new Set<string>(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap((field) => Object.keys(root[field] ?? {})));
  const quarantineRoot = join(slot, '.dkg-stale-workspace-dependencies');
  let quarantine: string | undefined;
  for (const entry of await readdir(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let name: unknown;
    try {
      ({ name } = JSON.parse(await readFile(join(packages, entry.name, 'package.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (typeof name !== 'string' || declared.has(name)) continue;
    // Restrict names to a single package, optionally within a single scope.
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error(`Invalid workspace package name in ${entry.name}`);
    }
    if (name.startsWith('@') && !await directory(join(modules, name.split('/')[0]))) continue;
    const installed = join(modules, name);
    if (!await directory(installed)) continue;
    if (!quarantine) {
      try {
        await mkdir(quarantineRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!await directory(quarantineRoot)) throw new Error('Unsafe workspace quarantine path');
      }
      quarantine = join(quarantineRoot, randomUUID());
      await mkdir(quarantine);
    }
    const destination = join(quarantine, name.replace('/', '+'));
    await rename(installed, destination);
    log(`Auto-update: quarantined stale undeclared workspace copy ${name} at ${destination}`);
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
 * Implemented in pure Node (`readdir` + `rm`/`unlink`) so it has no
 * dependency on POSIX `find`/`rm`. If even the Node implementation fails
 * (e.g. EACCES on `packages/`), we fall back to `git clean -fdx` so we
 * never proceed to build/swap with potentially stale `dist/*.js` from a
 * previous commit. If the fallback also fails the caller throws — better
 * to fail the update than to silently activate stale code.
 */
export async function cleanGeneratedOutputs(
  targetDir: string,
  log: (m: string) => void,
  io: Pick<typeof _autoUpdateIo, 'execFile' | 'readdir' | 'rm'>,
): Promise<void> {
  const { execFile: execFileAsync, readdir, rm } = io;
  try {
    const packagesDir = join(targetDir, 'packages');
    let pkgEntries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      pkgEntries = await readdir(packagesDir, { withFileTypes: true });
    } catch (err: any) {
      // No packages/ dir is unusual but not fatal — nothing to clean.
      if (err?.code === 'ENOENT') {
        log('Auto-update: no packages/ directory found; nothing to pre-clean.');
        return;
      }
      throw err;
    }
    let removedDist = 0;
    let removedTsBuildInfo = 0;
    for (const entry of pkgEntries) {
      if (!entry.isDirectory()) continue;
      const distPath = join(packagesDir, entry.name, 'dist');
      const tsBuildInfoPath = join(packagesDir, entry.name, 'tsconfig.tsbuildinfo');
      // `rm({ recursive: true, force: true })` is a no-op on missing paths.
      await rm(distPath, { recursive: true, force: true });
      await rm(tsBuildInfoPath, { force: true });
      removedDist += 1;
      removedTsBuildInfo += 1;
    }
    // Also wipe packages/cli's generated repo-root copies. The cli build
    // script (`packages/cli/package.json#build`) copies repo-root
    // `network/*.json` into `packages/cli/network/` and `project.json` into
    // `packages/cli/project.json`. Without this step, deleting or renaming a
    // root network config (e.g. removing `network/devnet.json`) leaves the
    // stale package-local copy in the inactive slot, and `candidateRoots()`
    // picks it up after the swap (monorepo-root precedence saves us in dev,
    // but published-NPM / detached layouts do not have a monorepo ancestor).
    // Use `force: true` so missing paths are a no-op (e.g. fresh clone where
    // these have never been generated).
    const cliPkgDir = join(packagesDir, 'cli');
    await rm(join(cliPkgDir, 'network'), { recursive: true, force: true });
    await rm(join(cliPkgDir, 'project.json'), { force: true });
    // A reused slot must not report its old compiler identity after a historical build.
    await rm(join(cliPkgDir, 'build-info.json'), { force: true });
    await rm(dirname(nodeUiStaticIndexPath(targetDir)), { recursive: true, force: true });
    log(
      `Auto-update: cleared stale dist/ (${removedDist} pkgs) + tsconfig.tsbuildinfo (${removedTsBuildInfo} pkgs) + cli/network/ + cli/project.json + cli/build-info.json + node-ui/dist-ui before build (incremental caches preserved).`,
    );
  } catch (primaryErr: any) {
    log(
      `Auto-update: Node-based pre-build clean failed (${primaryErr?.message ?? String(primaryErr)}); falling back to git clean -fdx.`,
    );
    // Fallback wipes more than we'd like (also nukes node_modules + Hardhat
    // cache, so the next build is cold) but is correct: the alternative is
    // proceeding with possibly-stale dist/*.js, which is exactly the bug
    // we're trying to prevent. If even this fails, throw — abort the update
    // rather than swap a dirty slot.
    await execFileAsync('git', ['clean', '-fdx'], {
      cwd: targetDir,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    log('Auto-update: fallback git clean -fdx completed.');
  }
}
