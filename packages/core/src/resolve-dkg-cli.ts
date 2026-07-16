/**
 * `resolveDkgCli` — resolves the DKG CLI entrypoint (`dist/cli.js`) so
 * setup can invoke `dkg start` without depending on shell PATH
 * resolution. Order:
 *   1. `DKG_CLI_PATH` env var — explicit override.
 *   2. `require.resolve('@origintrail-official/dkg')` — fast path when
 *      the CLI package is resolvable from this module's node_modules
 *      scope.
 *   3. `resolveCliPackageDir()` + `dist/cli.js` — covers monorepo dev,
 *      local install, and global install via `npm prefix -g`.
 *   4. `process.argv[1]` — when this code runs inside the CLI process,
 *      argv[1] is the CLI entrypoint itself. Handles `pnpm dkg ...`.
 *
 * Spawned via `process.execPath` (node) so that Windows — which does not
 * honor `.js` shebangs — works the same as POSIX.
 *
 * Moved here from `packages/adapter-openclaw/src/resolve-dkg-cli.ts` in
 * S1 of issue #386 because adapter-hermes also needs to spawn `dkg start`
 * and the dependency direction is `cli → adapters → core`.
 *
 * `resolveCliPackageDir` lives in a separate module
 * (`./resolve-cli-package-dir.js`) so vitest can `vi.mock` that path
 * independently of this one — combining both helpers into one module
 * would put `resolveDkgCli`'s call to `resolveCliPackageDir` outside
 * vitest's mock interception scope.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { resolveCliPackageDir } from './resolve-cli-package-dir.js';

export interface ResolvedDkgCli {
  /** Absolute path to the node executable to spawn. */
  node: string;
  /** Absolute path to the CLI entrypoint JS file. */
  cliPath: string;
}

export function resolveDkgCli(): ResolvedDkgCli {
  const node = process.execPath;

  const override = process.env.DKG_CLI_PATH;
  if (override && override.trim().length > 0) {
    if (!existsSync(override)) {
      throw new Error(
        `DKG_CLI_PATH is set to "${override}" but that file does not exist.`,
      );
    }
    return { node, cliPath: override };
  }

  try {
    const require = createRequire(import.meta.url);
    const cliPath = require.resolve('@origintrail-official/dkg');
    if (existsSync(cliPath)) {
      return { node, cliPath };
    }
  } catch (err: any) {
    if (err?.code !== 'MODULE_NOT_FOUND' && err?.code !== 'ERR_MODULE_NOT_FOUND') {
      throw err;
    }
    // fall through to the next resolution arm
  }

  const pkgDir = resolveCliPackageDir();
  if (pkgDir) {
    const cliPath = join(pkgDir, 'dist', 'cli.js');
    if (existsSync(cliPath)) {
      return { node, cliPath };
    }
  }

  const argv1 = process.argv[1];
  if (argv1 && basename(argv1) === 'cli.js' && existsSync(argv1)) {
    return { node, cliPath: argv1 };
  }

  throw new Error(
    'Could not resolve the DKG CLI entrypoint. Tried DKG_CLI_PATH, ' +
    "require.resolve('@origintrail-official/dkg'), resolveCliPackageDir() " +
    '+ dist/cli.js, and process.argv[1]. Set DKG_CLI_PATH to the absolute ' +
    'path of the CLI (e.g. /path/to/packages/cli/dist/cli.js, or on a global ' +
    'install: <npm prefix -g>/lib/node_modules/@origintrail-official/dkg/dist/cli.js) ' +
    'and try again.',
  );
}
