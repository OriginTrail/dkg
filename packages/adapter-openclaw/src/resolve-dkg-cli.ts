/**
 * Resolve the DKG CLI entrypoint so setup can invoke `dkg start` without
 * depending on shell PATH resolution.
 *
 * Context: `pnpm dkg openclaw setup` in a cloned monorepo does not put the
 * `dkg` bin on PATH for child processes, so `execSync('dkg start')` fails
 * with "dkg: not found". Global installs and `pnpm exec dkg ...` do put it
 * on PATH. This resolver produces an absolute entrypoint that works in all
 * three contexts, and is spawned via `process.execPath` (node) so that
 * Windows — which does not honor `.js` shebangs — works the same as POSIX.
 *
 * Resolution order:
 *   1. `DKG_CLI_PATH` env var — explicit override.
 *   2. `require.resolve('@origintrail-official/dkg')` — fast path when the
 *      CLI package is resolvable from adapter-openclaw's node_modules scope.
 *   3. `resolveCliPackageDir()` + `dist/cli.js` — covers monorepo dev,
 *      local install, and global install via `npm prefix -g`. Required
 *      because standalone `npm i -g @origintrail-official/dkg-adapter-openclaw`
 *      installs the adapter without the CLI as a dep, so (2) fails.
 *   4. `process.argv[1]` — when the adapter runs inside the CLI process,
 *      argv[1] is the CLI entrypoint itself. This handles `pnpm dkg ...`.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { resolveCliPackageDir } from './setup.js';

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
