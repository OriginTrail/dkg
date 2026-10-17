// SPDX-License-Identifier: Apache-2.0
import { existsSync, realpathSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { userInfo } from 'node:os';
import type { McpConfigSelection } from './mcp-client-registry.js';
import type { DesiredRegistration } from './mcp-client-config.js';
import type { McpRuntime } from './mcp-runtime.js';

/**
 * The canonical MCP-server entry written into client config files.
 *
 * Codex Round-4 unification: BOTH installed and monorepo modes
 * register the SAME shape — `process.execPath` (absolute path to
 * the currently-running Node binary) as `command`, and the absolute
 * CLI script path as the first arg. This skips the `dkg` bin shim
 * entirely.
 *
 * Why this matters: F30 (round-1 of this PR) wrote the resolved
 * absolute `dkg` bin path expecting that to free GUI MCP clients
 * from PATH dependencies. But the `dkg` bin on POSIX is a
 * `#!/usr/bin/env node` script — `env` then needs `node` on PATH.
 * On Windows the `.cmd` shim invokes `node.exe` similarly. Both
 * still ENOENT in the GUI-client environment F30 was trying to
 * fix. Calling Node directly with the script path eliminates BOTH
 * PATH lookups (the `dkg` shim AND the `node` binary the shim
 * would have invoked). GUI clients spawn the registered command
 * with no PATH lookup at all.
 *
 * Installed-mode CLI script path: `realpathSync(process.argv[1])`.
 * `process.argv[1]` is the script Node is currently executing —
 * guaranteed valid and on disk. `realpathSync` canonicalises
 * symlinks (npm's bin-shim is typically a symlink on POSIX)
 * so the registered path is stable across `npm relink`.
 *
 * Monorepo-mode CLI script path: `<root>/packages/cli/dist/cli.js`.
 * Validated via `existsSync` to fail loudly on a fresh checkout
 * with no build (Codex Round-1 Bug 3 contract).
 */
export function canonicalEntry(
  context: 'installed' | 'monorepo',
  monorepoRoot: string | null,
  dkgHome: string,
): DesiredRegistration {
  let cliJsPath: string;
  if (context === 'monorepo' && monorepoRoot) {
    cliJsPath = join(monorepoRoot, 'packages', 'cli', 'dist', 'cli.js');
    if (!existsSync(cliJsPath)) {
      throw new Error(
        `Local CLI dist not found at ${cliJsPath}. Run \`pnpm --filter @origintrail-official/dkg build\` first, then re-run \`dkg mcp setup\`.`,
      );
    }
  } else {
    // Installed mode: resolve the CLI script Node is currently
    // executing. `process.argv[1]` points at the npm bin-shim's
    // target (the actual cli.js file); `realpathSync` follows
    // symlinks for stability across npm relink / version-manager
    // rotations.
    const installedCliPath = realpathSync(process.argv[1]);
    // Codex Round-6 Fix 8: detect ephemeral package-manager cache
    // paths (npx / pnpm dlx / yarn dlx / bunx). Persisting one of
    // those into a client config means the registration silently
    // breaks on the next cache cleanup. Throw an actionable error
    // so the operator installs globally instead.
    const ephemeralReason = detectEphemeralInstallPath(installedCliPath);
    if (ephemeralReason) {
      throw new Error(
        `Detected ephemeral install path (${ephemeralReason}): ${installedCliPath}\n` +
        `MCP client registrations must persist across runs. Install dkg globally first:\n` +
        `  npm install -g @origintrail-official/dkg && dkg mcp setup`,
      );
    }
    cliJsPath = installedCliPath;
  }
  // Codex Round-9 Fix 16: propagate the resolved bootstrap home
  // via the standard `env: { DKG_HOME: <path> }` field on the MCP
  // server entry. GUI clients (Claude Desktop, Cursor, VSCode +
  // Copilot, Windsurf) all support this shape and DON'T inherit
  // shell env when spawning the registered command — so without
  // this propagation, an operator who set `DKG_HOME=/custom`
  // would have setup write config / auth.token to `/custom` while
  // the spawned MCP server fell back to `~/.dkg` and missed both.
  // Always emitted (even for the default `~/.dkg`) so the
  // registered entry is fully self-contained: operators can move
  // / copy it between machines and it resolves identically without
  // depending on shell state.
  return {
    command: process.execPath,
    args: [cliJsPath, 'mcp', 'serve'],
    env: { DKG_HOME: dkgHome },
  };
}

/**
 * Codex Round-6 Fix 8: detect ephemeral package-manager cache paths
 * that would yield non-persistent MCP registrations. Returns a
 * short label of the matched cache pattern, or `null` if the path
 * looks persistent.
 *
 * Patterns matched (path is normalized to forward-slashes +
 * lower-case before matching, so Windows backslashes and casing
 * don't escape the heuristic):
 *   - npm  : `/_npx/`                                 (npx CLI cache)
 *   - pnpm : `/.pnpm/dlx-`, `/dlx-`                   (pnpm dlx cache)
 *   - yarn : `/.yarn/cache/`, `/.yarn/berry/cache/`   (yarn berry dlx)
 *   - bun  : `/.bun/install/cache/`                   (bunx cache)
 *
 * Heuristic posture: positive-allow-list-against-cache, not
 * negative-allow-list-of-globals. Globally installed bins always
 * live outside these cache paths, so any false-negative still
 * yields a working install. A false-positive throws and the
 * operator gets a clear hint to install globally — recoverable.
 */
function detectEphemeralInstallPath(absPath: string): string | null {
  const norm = absPath.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/_npx/')) return 'npx cache';
  if (norm.includes('/.pnpm/dlx-') || norm.includes('/dlx-')) return 'pnpm dlx cache';
  if (norm.includes('/.yarn/cache/') || norm.includes('/.yarn/berry/cache/')) return 'yarn cache';
  if (norm.includes('/.bun/install/cache/')) return 'bun cache';
  return null;
}

/** Windows clients must enter the same distro and user that ran setup. */
export function clientMcpEntry(
  canonical: DesiredRegistration, selection: McpConfigSelection, runtime: McpRuntime,
): DesiredRegistration {
  if (runtime !== 'wsl' || !selection.aliases.some(client => client.location === 'windows-wsl')) {
    return canonical;
  }
  if (selection.aliases.some(client => client.location !== 'windows-wsl')) {
    throw new Error('This MCP config is shared by Linux and Windows clients. Give them separate config files before running setup.');
  }
  const distro = process.env.WSL_DISTRO_NAME;
  if (!distro || /\p{Cc}/u.test(distro)) {
    throw new Error('WSL_DISTRO_NAME is required to pin Windows MCP clients to this WSL distribution. Run setup inside the intended distribution.');
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  if (!/^[A-Za-z]:[\\/]/.test(systemRoot) || /[\\/]\.\.?([\\/]|$)/.test(systemRoot)) {
    throw new Error('Windows MCP launch requires an absolute Windows SystemRoot (for example C:\\Windows).');
  }
  return {
    command: win32.join(systemRoot, 'System32', 'wsl.exe'),
    args: ['--distribution', distro, '--user', userInfo().username, '--exec', '/usr/bin/env', '--',
      `DKG_HOME=${canonical.env.DKG_HOME}`, canonical.command, ...canonical.args],
    // Keep the standard client environment field for classification and tooling;
    // the explicit env assignment above also crosses the Windows/WSL boundary.
    env: { ...canonical.env },
  };
}
