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
 *   2. `require.resolve('@origintrail-official/dkg')` — works when the CLI
 *      package is resolvable from adapter-openclaw (global install).
 *   3. `process.argv[1]` — when the adapter runs inside the CLI process,
 *      argv[1] is the CLI entrypoint itself. This handles `pnpm dkg ...`.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';

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
  } catch { /* fall through to argv[1] */ }

  const argv1 = process.argv[1];
  if (argv1 && basename(argv1) === 'cli.js' && existsSync(argv1)) {
    return { node, cliPath: argv1 };
  }

  throw new Error(
    'Could not resolve the DKG CLI entrypoint. ' +
    'Set DKG_CLI_PATH to the absolute path of the CLI (e.g. ' +
    '/path/to/packages/cli/dist/cli.js) and try again.',
  );
}
