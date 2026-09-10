import { lstat, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
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
