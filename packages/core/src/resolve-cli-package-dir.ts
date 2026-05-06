/**
 * `resolveCliPackageDir` — locates the `@origintrail-official/dkg` CLI
 * package root on disk. Probes three layouts in the order they're
 * likeliest to succeed during setup:
 *   (1) Monorepo dev checkout — sibling `packages/cli` of this module.
 *   (2) Local install — `./node_modules/@origintrail-official/dkg`, found
 *       via `createRequire(import.meta.url).resolve('.../package.json')`.
 *   (3) Global install — `npm prefix -g` + `[lib/]node_modules/...`.
 *
 * Returns `null` when the CLI isn't reachable; callers are responsible
 * for emitting the error message that's appropriate for the specific
 * file they were looking for (SKILL.md, testnet.json, etc.).
 *
 * Lives in its own module (separate from `resolve-dkg-cli.ts`) so
 * `resolveDkgCli`'s `vi.mock('@origintrail-official/dkg-core/...')` test
 * harness can replace it via the standard ESM mock path. Combining the
 * two helpers in one module would put intra-module calls outside vitest's
 * mock interception scope.
 *
 * Moved here from `packages/adapter-openclaw/src/setup.ts` in S1 of issue
 * #386 because adapter-hermes also needs it (helper-reuse-rec §43-46) and
 * the dependency direction is `cli → adapters → core`.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Walk from this module's location up to the `packages/` directory and
 * over to `packages/cli`. Works in both dev (TS sources at
 * `packages/core/src/`) and built (`packages/core/dist/`) contexts:
 *   - `packages/core/src/../../cli` = `packages/cli`
 *   - `packages/core/dist/../../cli` = `packages/cli`
 *
 * The previous OpenClaw-side implementation used `adapterRoot()` to walk
 * from `packages/adapter-openclaw/src/`; the math here gives the exact
 * same destination from this module's location.
 */
function monorepoCliCandidate(): string {
  return resolve(__dirname, '..', '..', 'cli');
}

export function resolveCliPackageDir(): string | null {
  // (1) Monorepo dev checkout — sibling `packages/cli`.
  const monorepoCandidate = monorepoCliCandidate();
  if (existsSync(join(monorepoCandidate, 'package.json'))) {
    return monorepoCandidate;
  }

  // (2) Local install — `./node_modules/@origintrail-official/dkg/...`.
  // This path is invisible to `npm prefix -g` since the CLI lives inside the
  // calling project rather than the global prefix.
  try {
    const req = createRequire(import.meta.url);
    const cliPkgJson = req.resolve('@origintrail-official/dkg/package.json');
    const localInstallCandidate = dirname(cliPkgJson);
    if (existsSync(join(localInstallCandidate, 'package.json'))) {
      return localInstallCandidate;
    }
  } catch { /* fall through to npm prefix -g */ }

  // (3) Global install — `npm install -g @origintrail-official/dkg`.
  try {
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const candidates = [
      join(npmPrefix, 'lib', 'node_modules', '@origintrail-official', 'dkg'),
      join(npmPrefix, 'node_modules', '@origintrail-official', 'dkg'),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'package.json'))) {
        return candidate;
      }
    }
  } catch { /* fall through */ }

  return null;
}
