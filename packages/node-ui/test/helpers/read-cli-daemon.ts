import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const CLI_SRC = resolve(__dirname, '..', '..', '..', 'cli', 'src');

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
}

/**
 * Return the concatenated source of the daemon across the split layout.
 *
 * Pre-PR-#258 all daemon code lived in `packages/cli/src/daemon.ts`.
 * After the split this is a barrel that re-exports from `daemon/*.ts`
 * and `daemon/routes/*.ts`. Many tests in this package were written
 * against the monolithic file and do pure source-string scans (route
 * registration, security headers, ordering within a handler block).
 * Re-targeting each assertion to the specific sub-module would be
 * noisy and fragile as the split evolves; concatenating all daemon
 * sources preserves the original semantics (does this symbol/pattern
 * exist *somewhere* in the daemon?) without coupling the tests to
 * the current file layout.
 *
 * Ordering-dependent assertions (e.g. `chatOclawBlock.indexOf(...)`)
 * are still correct as long as the slice they operate on lives in a
 * single sub-module, which is the case for every pre-split block
 * that the tests slice out — the split boundaries were chosen along
 * handler-group lines, so each handler body stays intact.
 */
export function readDaemonSources(): string {
  const files: string[] = [];
  const barrel = resolve(CLI_SRC, 'daemon.ts');
  try {
    statSync(barrel);
    files.push(barrel);
  } catch {
    // Pre-split checkout (daemon/index.ts only). Nothing to add.
  }
  const daemonDir = resolve(CLI_SRC, 'daemon');
  try {
    walk(daemonDir, files);
  } catch {
    // Pre-split checkout: no daemon/ directory, barrel alone is the source.
  }
  return files.map((f) => readFileSync(f, 'utf-8')).join('\n');
}
