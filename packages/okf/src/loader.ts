/**
 * The package's only filesystem surface: read an OKF bundle directory into the
 * in-memory `BundleFile[]` the pure mapper consumes. Kept separate so the mapper
 * itself stays I/O-free and unit-testable in isolation.
 */

import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BundleFile } from './types.js';

/**
 * Recursively read all `.md` files under `dir` as bundle-relative POSIX paths.
 *
 * Symbolic links are NOT followed (`lstat`, not `stat`): a bundle could ship a
 * `secret.md -> ~/.dkg/auth.token` symlink, and following it would slurp a local
 * file into the graph and (with `--share`) gossip it. Symlinked entries are
 * skipped and collected in `skippedSymlinks` so callers can surface them.
 */
export function loadBundleDir(dir: string): BundleFile[] {
  return loadBundleDirWithReport(dir).files;
}

export function loadBundleDirWithReport(dir: string): {
  files: BundleFile[];
  skippedSymlinks: string[];
} {
  const out: BundleFile[] = [];
  const skippedSymlinks: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        skippedSymlinks.push(relative(dir, full).split(sep).join('/'));
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && entry.endsWith('.md')) {
        const rel = relative(dir, full).split(sep).join('/');
        out.push({ path: rel, content: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(dir);
  return { files: out, skippedSymlinks };
}
