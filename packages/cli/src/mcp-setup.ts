/**
 * `dkg mcp setup` — bundled init + daemon-start + MCP-client registration.
 *
 * Mirrors `dkg openclaw setup` so the user-visible flow is two commands
 * end-to-end:
 *
 *   npm install -g @origintrail-official/dkg
 *   dkg mcp setup
 *
 * Step order (each step is idempotent and skippable):
 *   1. Init `~/.dkg/config.json` if absent (uses the same network defaults
 *      + merge semantics as `dkg openclaw setup` — `loadNetworkConfig` +
 *      `writeDkgConfig` are re-exported from `@origintrail-official/dkg-adapter-openclaw`
 *      so behaviour stays byte-aligned).
 *   2. Start the daemon if not already reachable on the configured API
 *      port (uses the same `startDaemon` openclaw-setup uses — readiness
 *      probe, stale-PID handling, etc.).
 *   3. Optionally fund the node's wallets via testnet faucet (mirrors
 *      openclaw-setup's --no-fund posture).
 *   4. Detect MCP-aware clients (`detectClients()`) and register the
 *      context-aware canonical entry. Detected clients today: Cursor,
 *      Claude Code, Claude Desktop, Windsurf, VSCode + Copilot Chat,
 *      Cline, and Codex CLI. (Continue was attempted in PR #443 then
 *      reverted because its MCP config is workspace-local, not
 *      user-global — structural mismatch with `dkg mcp setup`'s
 *      machine-wide UX. Deferred to a follow-up issue.)
 *      State-aware (`registered` / `stale` / `not registered`) per
 *      client and fast-exits on no-op re-runs.
 *
 * Context-awareness (phase 2): when invoked from inside a dkg-v9
 * monorepo dev checkout (detected via
 * `findDkgMonorepoRoot()` from `@origintrail-official/dkg-core`),
 * the canonical entry writes the absolute path to the local CLI
 * dist instead of the global `dkg` bin — so a contributor's local
 * build runs even when a stale globally-installed `dkg` is on PATH.
 * `--installed` / `--monorepo` are mutually-exclusive overrides.
 *
 * Per-client format / entry-shape dispatch (phase 1): Cursor, Claude
 * Code, Claude Desktop, Windsurf, and Cline all use canonical
 * `mcpServers.dkg` JSON. VSCode + Copilot Chat keys under
 * `servers.dkg` instead. The `format` + `entryPath` fields on
 * `ClientTarget` describe each client's contract; `writeRegistration`
 * and `classify` dispatch on those without per-client write logic.
 *
 * Flags (parity with `dkg openclaw setup` where applicable):
 *   --port <n>     Override daemon API port (default 9200).
 *   --name <s>     Override agent name (used only on first init).
 *   --no-start     Skip daemon start (configure only).
 *   --no-fund      Skip wallet funding via testnet faucet.
 *   --no-verify    Skip post-setup verification probe.
 *   --dry-run      Preview steps; no filesystem or network writes.
 *   --force        Refresh every detected client regardless of state.
 *   --print-only   Emit canonical JSON only; skip every other step.
 *   --yes          Auto-confirm registrations (default false: prompt
 *                  per-client interactively in TTY mode; non-TTY auto-
 *                  confirms automatically — CI / scripts work without
 *                  the flag, but passing it explicitly is the safer
 *                  scripted-environment posture).
 *   --installed    Force installed-mode command form even from a
 *                  monorepo cwd (mutually exclusive with --monorepo).
 *   --monorepo     Force monorepo-mode command form (errors if no
 *                  DKG monorepo root locatable; mutually exclusive
 *                  with --installed).
 *
 * Tokens and URLs are NOT in the emitted client-config block — the MCP
 * server reads them from `~/.dkg/config.yaml` + the daemon-written
 * `auth.token` via `loadConfig` (`packages/mcp-dkg/src/config.ts`).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform, release as osRelease } from 'node:os';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import TOML from '@iarna/toml';

export interface McpSetupCliOptions {
  /** Refresh every detected client regardless of current registration state. */
  force?: boolean;
  /** Emit the canonical JSON block to stdout; do not detect clients or write. */
  printOnly?: boolean;
  /**
   * Auto-confirm per-client registrations (default false). In TTY
   * mode without `--yes`, the action prompts per detected client
   * before writing. In non-TTY mode (CI, piped input, no controlling
   * terminal) the prompt is skipped — non-interactive environments
   * auto-confirm so scripts don't hang. Pass `--yes` explicitly in
   * scripts for the safer posture.
   */
  yes?: boolean;
  /** Override daemon API port (default 9200). Mirrors openclaw-setup. */
  port?: string;
  /** Override agent name (used only on first init). Mirrors openclaw-setup. */
  name?: string;
  /** Skip daemon start (configure only). Mirrors openclaw-setup. */
  start?: boolean;
  /** Skip wallet funding via testnet faucet. Mirrors openclaw-setup. */
  fund?: boolean;
  /** Skip post-setup verification probe. Mirrors openclaw-setup. */
  verify?: boolean;
  /** Preview without writing or starting anything. Mirrors openclaw-setup. */
  dryRun?: boolean;
  /**
   * Force installed-mode command form even when invoked from inside
   * a monorepo dev checkout. Escape hatch for contributors who want
   * to test the published-CLI shape from a dev cwd. Mutually
   * exclusive with `--monorepo`.
   */
  installed?: boolean;
  /**
   * Force monorepo-mode command form (writes the absolute path to
   * the local CLI dist). Errors if no monorepo root can be located.
   * Mutually exclusive with `--installed`.
   */
  monorepo?: boolean;
}

/**
 * Setup context — drives `canonicalEntry`'s output shape. `'installed'`
 * is the default for npm-installed CLIs (writes
 * `{ command: "dkg", args: ["mcp", "serve"] }`); `'monorepo'` is the
 * contributor-from-dev-checkout case (writes
 * `{ command: "node", args: ["<repo>/packages/cli/dist/cli.js",
 * "mcp", "serve"] }` so the contributor's local-build runs, not a
 * stale globally-installed version).
 */
export type SetupContext = 'installed' | 'monorepo';

/**
 * F31: per-client registration plan item. Lifted to module scope so
 * the `confirmPlan` helper can take and return arrays of these
 * without re-declaring the shape inside the action body. `Action`
 * mirrors the local enum the planning loop produces.
 */
export type PlannedAction = 'register' | 'refresh' | 'skip';
export interface PlannedItem {
  s: ClientState;
  action: PlannedAction;
}

/**
 * Dependency surface for `mcpSetupAction`. All bundled-flow primitives
 * are injected so the action can be unit-tested without touching the
 * real filesystem or spawning the daemon. The CLI wiring in `cli.ts`
 * dynamically imports `@origintrail-official/dkg-adapter-openclaw` and
 * passes its real implementations.
 */
export interface McpSetupActionDeps {
  loadNetworkConfig: typeof import('@origintrail-official/dkg-adapter-openclaw').loadNetworkConfig;
  /**
   * Codex Round-23 Fix 30: agent-agnostic config-write helper from
   * `dkg-core`. Pre-fix this dep was `adapter-openclaw`'s
   * `writeDkgConfig` wrapper, which ran 3 OpenClaw-specific
   * mutations (`migrateLegacyOpenClawTransport`, plus
   * `delete existing.openclawAdapter` / `delete existing.openclawChannel`)
   * before delegating to this same `ensureDkgNodeConfig`. Those
   * mutations are no-ops on MCP-only configs but the dependency
   * was architecturally wrong — MCP setup shouldn't reach into
   * the OpenClaw adapter for config writes. Calling the agent-
   * agnostic helper directly drops the dead OpenClaw baggage from
   * the MCP-only setup path. The OpenClaw migrations stay scoped
   * to `dkg openclaw setup`'s own `writeDkgConfig` call site.
   */
  ensureDkgNodeConfig: typeof import('@origintrail-official/dkg-core').ensureDkgNodeConfig;
  startDaemon: typeof import('@origintrail-official/dkg-adapter-openclaw').startDaemon;
  readWalletsWithRetry: typeof import('@origintrail-official/dkg-adapter-openclaw').readWalletsWithRetry;
  logManualFundingInstructions: typeof import('@origintrail-official/dkg-adapter-openclaw').logManualFundingInstructions;
  /** Faucet primitive from `@origintrail-official/dkg-core`. */
  requestFaucetFunding: typeof import('@origintrail-official/dkg-core').requestFaucetFunding;
  /**
   * Walks ancestors looking for a DKG monorepo root. Defaulted to the
   * dkg-core implementation in production; injectable so tests can
   * stub it without touching the real filesystem.
   */
  findDkgMonorepoRoot: typeof import('@origintrail-official/dkg-core').findDkgMonorepoRoot;
  /**
   * Codex Round-2 Bug A: resolve the DKG home directory used by the
   * config / daemon / faucet steps below. Defaults to the dkg-core
   * implementation in production; injectable so tests can pin a
   * deterministic home without depending on `homedir()` or env. When
   * mcp-setup detects monorepo context it forwards the signal here
   * so the bootstrap state lands in the same `~/.dkg-dev` that the
   * registered local CLI dist will read at MCP-client startup time.
   */
  resolveDkgConfigHome: typeof import('@origintrail-official/dkg-core').resolveDkgConfigHome;
  /**
   * F31: per-client interactive confirm hook. Defaulted to the
   * production readline-based implementation. Injectable so tests
   * can stub deterministic answer streams without managing a real
   * TTY. The helper takes the `planned` array and returns a
   * possibly-modified copy where declined items are downgraded to
   * `'skip'`.
   *
   * Optional — `mcpSetupAction` falls back to the module-level
   * `confirmPlan` when not supplied so existing call sites keep
   * working unchanged.
   */
  confirmPlan?: (
    planned: readonly PlannedItem[],
    opts: { yes: boolean },
  ) => Promise<PlannedItem[]>;
}

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
function canonicalEntry(
  context: SetupContext,
  monorepoRoot: string | null,
  dkgHome: string,
): Record<string, unknown> {
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

/**
 * F31 production-side per-client confirm prompt. Reads each
 * to-be-written client name from the planned array and asks the
 * operator interactively before writing. Skipped entries pass
 * through unchanged (we don't prompt about no-ops).
 *
 * Auto-confirm conditions (skip prompts entirely):
 *   - `opts.yes === true` (operator passed `--yes`).
 *   - `process.stdin.isTTY === false` OR `process.stdout.isTTY === false`.
 *     Codex Round-4 Fix 5 tightened the TTY guard: the pre-fix
 *     stdin-only check would block on an invisible readline prompt
 *     when stdout was redirected/captured but stdin still happened
 *     to be a TTY (e.g. `dkg mcp setup > log.txt` from an
 *     interactive shell). Both must be a TTY for prompting; any
 *     non-TTY end auto-confirms.
 *   - Zero non-skip entries in the plan (nothing to confirm).
 *
 * Default empty answer (operator just hits Enter) accepts the
 * registration — the prompt prefix is `[Y/n]` so the lower-case
 * default is "yes". Only `n` / `no` (case-insensitive) declines.
 *
 * Exported so `cli.ts` can pass it through to `mcpSetupAction`'s
 * deps surface in production. Tests inject their own stub.
 */
export async function confirmPlan(
  planned: readonly PlannedItem[],
  opts: { yes: boolean },
): Promise<PlannedItem[]> {
  const writes = planned.filter((p) => p.action !== 'skip');
  if (
    opts.yes ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    writes.length === 0
  ) {
    return [...planned];
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result: PlannedItem[] = [];
    for (const p of planned) {
      if (p.action === 'skip') {
        result.push(p);
        continue;
      }
      const verb = p.action === 'register' ? 'Register' : 'Refresh';
      const ans = (
        await rl.question(
          `${verb} DKG MCP with ${p.s.target.name} (${p.s.target.displayPath})? [Y/n] `,
        )
      )
        .trim()
        .toLowerCase();
      const declined = ans === 'n' || ans === 'no';
      if (declined) {
        console.log(`  → declined; will skip ${p.s.target.name}`);
        result.push({ ...p, action: 'skip' });
      } else {
        result.push(p);
      }
    }
    return result;
  } finally {
    rl.close();
  }
}

/**
 * Return the absolute directory of the currently-running CLI script,
 * canonicalised through `realpath` (the npm bin shim is typically a
 * symlink). Returns `null` if `process.argv[1]` is unset or the
 * realpath lookup fails — caller falls back to safer defaults.
 *
 * Codex Round-13 Fix 19 helper. Used by `detectContext` to locate
 * the running CLI's actual on-disk position, which is the correct
 * signal for "is this the monorepo build?" (NOT `process.cwd()`,
 * which is incidental — a global `dkg` invoked from inside a
 * monorepo checkout would have `cwd` inside the repo while argv[1]
 * resolves to the npm global install location).
 */
function dirnameOfRunningCli(): string | null {
  try {
    if (!process.argv[1]) return null;
    return dirname(realpathSync(process.argv[1]));
  } catch {
    return null;
  }
}

/**
 * Detect the setup context. With `force` set to a literal value, that
 * value wins (with `--monorepo` requiring a discoverable monorepo
 * root from the running CLI's location). Without `force`, walk
 * ancestors of the running CLI's actual on-disk location: a hit
 * means the running CLI is the monorepo dev build; a miss means
 * we're globally installed.
 *
 * Codex Round-13 Fix 19: previously `process.cwd()` was the search
 * start (Round-1 FIX 1's reaction to the wrong default which walked
 * from `@origintrail-official/dkg-core`'s installed location). But
 * cwd is incidental. A global `dkg` invoked from inside a monorepo
 * checkout would have setup steps 1-3 bootstrap against the global
 * home while the persisted MCP entry switched to the monorepo dist
 * (mismatch; hard-fails if dist is unbuilt). The right signal for
 * "which CLI is this?" is `realpath(process.argv[1])` — the script
 * Node is currently running.
 *
 * `--installed` and `--monorepo` are mutually exclusive — the caller
 * is expected to have validated that before calling. We accept the
 * narrow union here so the action can pass through whichever flag
 * commander produced without re-validating.
 */
function detectContext(
  findRoot: typeof import('@origintrail-official/dkg-core').findDkgMonorepoRoot,
  opts: { force?: SetupContext } = {},
): { context: SetupContext; monorepoRoot: string | null } {
  if (opts.force === 'installed') {
    return { context: 'installed', monorepoRoot: null };
  }
  // Round-13 Fix 19: search from the running CLI's directory.
  const cliDir = dirnameOfRunningCli();
  if (opts.force === 'monorepo') {
    // Codex Round-15 Fix 21: forced --monorepo searches `cwd` FIRST.
    // The flag's contract is "use the monorepo from THIS checkout"
    // — the user's explicit cwd-context intent overrides auto-detect
    // heuristics. Pre-fix (Round-13 FIX 19) we tried `cliDir` first,
    // which hard-failed when a global `dkg` was invoked from inside
    // a valid monorepo with `--monorepo` (the global install path
    // doesn't have a monorepo above it). Falls back to `cliDir`
    // before throwing for the test pattern that invokes the dist
    // directly without a matching cwd; auto-detect path below
    // stays cliDir-first because cwd is incidental for unflagged
    // invocations.
    let root = findRoot(process.cwd());
    if (!root && cliDir) root = findRoot(cliDir);
    if (!root) {
      throw new Error(
        '--monorepo flag passed but no DKG monorepo root could be located from this CLI invocation.',
      );
    }
    return { context: 'monorepo', monorepoRoot: root };
  }
  // Auto-detect: if the running CLI's location is unknown, default
  // to installed (safer than guessing monorepo from cwd).
  if (!cliDir) {
    return { context: 'installed', monorepoRoot: null };
  }
  const root = findRoot(cliDir);
  return root
    ? { context: 'monorepo', monorepoRoot: root }
    : { context: 'installed', monorepoRoot: null };
}

interface ClientTarget {
  name: string;
  configPath: string;
  /** Pretty path for display, with `~` substituted back in. */
  displayPath: string;
  /**
   * Per-client config-file format. Defaults to `'json'` so the existing
   * Cursor + Claude Code targets stay byte-identical post-refactor.
   * Codex CLI uses `'toml'`. The `'yaml'` variant is reserved for
   * future clients (Continue was attempted in PR #443 then reverted
   * because its MCP config is workspace-local, not user-global —
   * structural mismatch with `dkg mcp setup`'s machine-wide UX);
   * `readConfigBody` / `writeConfigBody` keep `NotImplementedError`
   * stubs for the YAML branch so re-adding a YAML client is purely
   * additive when the time comes.
   */
  format?: 'json' | 'toml' | 'yaml';
  /**
   * Dotted path to the per-server entry inside the parsed config.
   * Defaults to `'mcpServers.dkg'` — the shape Cursor / Claude Code /
   * Claude Desktop / Windsurf / Cline all use. Clients diverging from
   * that shape (VSCode + Copilot Chat uses `servers.dkg`; Codex CLI
   * uses `mcp_servers.dkg` under TOML) declare the alternate path
   * here so a single registration helper covers all surfaces without
   * per-client write logic.
   */
  entryPath?: string;
}

const DEFAULT_FORMAT: NonNullable<ClientTarget['format']> = 'json';
const DEFAULT_ENTRY_PATH = 'mcpServers.dkg';

/**
 * Resolve a dotted entry-path (`'mcpServers.dkg'`, `'servers.dkg'`,
 * `'mcp_servers.dkg'`) into its head segments + final key. Used by
 * both classify (read) and writeRegistration (write) to navigate the
 * parsed config object identically.
 */
function splitEntryPath(entryPath: string | undefined): { head: string[]; leaf: string } {
  const path = entryPath ?? DEFAULT_ENTRY_PATH;
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Invalid entryPath "${entryPath}": must be a non-empty dotted path`);
  }
  return { head: parts.slice(0, -1), leaf: parts[parts.length - 1] };
}

/**
 * Walk a parsed config object down a list of head segments, lazily
 * creating intermediate `Record<string, unknown>` containers for any
 * missing levels. Returns the parent container of the leaf key.
 *
 * Used at write time only. At read time we tolerate missing
 * intermediates (the entry just classifies as `not-registered`).
 */
function ensurePathContainer(
  body: Record<string, unknown>,
  head: string[],
): Record<string, unknown> {
  let cursor: Record<string, unknown> = body;
  for (const segment of head) {
    const next = cursor[segment];
    if (next === undefined || next === null || typeof next !== 'object') {
      const fresh: Record<string, unknown> = {};
      cursor[segment] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  return cursor;
}

/**
 * Read the leaf value at a dotted entry-path; returns `undefined` if
 * any intermediate is missing or non-object. Used by `classify` so
 * staleness detection works regardless of how deep the entry is
 * nested.
 */
function readEntryAt(
  body: Record<string, unknown>,
  entryPath: string | undefined,
): unknown {
  const { head, leaf } = splitEntryPath(entryPath);
  let cursor: unknown = body;
  for (const segment of head) {
    if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
    return undefined;
  }
  return (cursor as Record<string, unknown>)[leaf];
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function tildify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/**
 * Codex Round-6 Fix 9: resolve the Linux config base directory,
 * honouring `XDG_CONFIG_HOME` when set. Per the XDG Base Directory
 * spec, applications that store config under `~/.config` should
 * defer to `$XDG_CONFIG_HOME` first — users who relocate app
 * configs (common on multi-user systems and dotfile-managed
 * setups) were previously invisible to `dkg mcp setup`'s detection
 * sweep. Used by the Claude Desktop / VSCode + Copilot Chat /
 * Cline Linux path resolvers below.
 */
function linuxConfigDir(home: string): string {
  return process.env.XDG_CONFIG_HOME ?? join(home, '.config');
}

/**
 * Resolve Claude Desktop's per-platform config path. The macOS path
 * uses `~/Library/Application Support/Claude/`; Windows uses
 * `%APPDATA%\Claude\`; Linux follows XDG-ish convention at
 * `~/.config/Claude/`. The display path tildifies the home prefix
 * so the operator-facing log reads consistently across platforms.
 */
function claudeDesktopPaths(home: string): { configPath: string; displayPath: string } {
  const p = platform();
  if (p === 'darwin') {
    const configPath = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    return { configPath, displayPath: '~/Library/Application Support/Claude/claude_desktop_config.json' };
  }
  if (p === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const configPath = join(appData, 'Claude', 'claude_desktop_config.json');
    return { configPath, displayPath: configPath.replace(home, '~') };
  }
  // Linux + everything else: XDG-style. Per Claude's docs the active
  // config under Linux is `<XDG_CONFIG_HOME>/Claude/claude_desktop_config.json`,
  // falling back to `~/.config/Claude/...` when XDG_CONFIG_HOME is unset.
  const configPath = join(linuxConfigDir(home), 'Claude', 'claude_desktop_config.json');
  return { configPath, displayPath: tildify(configPath) };
}

/**
 * Resolve VSCode + Copilot Chat's per-platform user-settings MCP
 * config path. VSCode keeps user-scoped settings under
 * `<userDataDir>/User/`; on Mac this is
 * `~/Library/Application Support/Code/User/mcp.json`; on Windows
 * it's `%APPDATA%\Code\User\mcp.json`; on Linux it's
 * `~/.config/Code/User/mcp.json`. Note this is the user-scoped
 * (cross-workspace) config, not the per-workspace `.vscode/mcp.json`.
 *
 * Diverges from the canonical `mcpServers.dkg` shape: Copilot Chat's
 * MCP wiring uses `servers.dkg` instead. The phase-1 entryPath
 * dispatch handles that without per-client write logic.
 */
function vscodeMcpPaths(home: string): { configPath: string; displayPath: string } {
  const p = platform();
  if (p === 'darwin') {
    const configPath = join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    return { configPath, displayPath: '~/Library/Application Support/Code/User/mcp.json' };
  }
  if (p === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const configPath = join(appData, 'Code', 'User', 'mcp.json');
    return { configPath, displayPath: configPath.replace(home, '~') };
  }
  const configPath = join(linuxConfigDir(home), 'Code', 'User', 'mcp.json');
  return { configPath, displayPath: tildify(configPath) };
}

/**
 * Resolve Cline (VSCode extension) per-platform config path. Cline
 * stores its MCP wiring inside VSCode's per-extension globalStorage
 * directory under the extension publisher.id namespace
 * (`saoudrizwan.claude-dev`). Same `mcpServers.dkg` JSON shape as
 * Cursor / Claude Code; what's hard is just the deeply-nested path.
 *
 * macOS: `~/Library/Application Support/Code/User/globalStorage/...`
 * Windows: `%APPDATA%\Code\User\globalStorage\...`
 * Linux:  `~/.config/Code/User/globalStorage/...`
 *
 * Mirrors `vscodeMcpPaths` for the per-platform Code-user-data root,
 * with the per-extension globalStorage suffix appended.
 */
function clineMcpPaths(home: string): { configPath: string; displayPath: string } {
  const suffix = join(
    'globalStorage',
    'saoudrizwan.claude-dev',
    'settings',
    'cline_mcp_settings.json',
  );
  const p = platform();
  if (p === 'darwin') {
    const configPath = join(home, 'Library', 'Application Support', 'Code', 'User', suffix);
    return { configPath, displayPath: `~/Library/Application Support/Code/User/${suffix.replace(/\\/g, '/')}` };
  }
  if (p === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const configPath = join(appData, 'Code', 'User', suffix);
    return { configPath, displayPath: configPath.replace(home, '~') };
  }
  const configPath = join(linuxConfigDir(home), 'Code', 'User', suffix);
  return { configPath, displayPath: tildify(configPath) };
}

/**
 * Discover MCP-aware clients on the machine. We look at the standard
 * config-file locations rather than probing for installed binaries — a
 * config file is the artifact `dkg mcp setup` actually writes into, and
 * its existence (or non-existence) is the signal that matters.
 *
 * Per-client docs source-of-truth (verify on next-cycle if anything
 * drifts):
 *   - Cursor:        `~/.cursor/mcp.json` — global per-user MCP config
 *   - Claude Code:   `~/.claude.json` — user-scoped path the MCP-server
 *     wiring already uses across the rest of the codebase
 *   - Claude Desktop: per-platform (see `claudeDesktopPaths`)
 *   - Windsurf (Codeium): `~/.codeium/windsurf/mcp_config.json`
 *
 * Detection is deliberately permissive: any client whose config file is
 * already present OR whose config directory is already present counts as
 * "detected" for write purposes. Operators with a fresh machine and no
 * client installed still see the fallback "no clients detected; run
 * `dkg mcp setup --print-only`" message.
 */
/**
 * Codex Round-13 Fix 20: detect WSL2. Linux platform with `microsoft`
 * / `WSL` markers in env, kernel release, or `/proc/version`. WSL
 * users running `dkg mcp setup` from inside their WSL distro need
 * to register Windows-side GUI clients (Claude Desktop, Windsurf,
 * VSCode + Copilot, Cline) AS WELL AS any Linux-native clients —
 * pre-fix they got the Linux-only set and the README's WSL2
 * promise silently failed for the apps users actually run.
 *
 * Multi-signal detection (env first; cheaper than fs reads):
 *   - `WSL_DISTRO_NAME` / `WSL_INTEROP` set by the WSL launcher.
 *   - `os.release()` contains `microsoft` or `wsl` (WSL kernels
 *     identify themselves there).
 *   - `/proc/version` contains the same markers (slower fallback).
 */
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const release = osRelease().toLowerCase();
    if (release.includes('microsoft') || release.includes('wsl')) return true;
  } catch { /* fall through */ }
  try {
    const procVersion = readFileSync('/proc/version', 'utf-8').toLowerCase();
    if (procVersion.includes('microsoft') || procVersion.includes('wsl')) return true;
  } catch { /* /proc/version not readable; not WSL */ }
  return false;
}

/**
 * Resolve a Windows-side env var (e.g. `%USERPROFILE%`,
 * `%APPDATA%`) into a WSL-mounted Linux path (`/mnt/c/...`). Uses
 * `cmd.exe` to read the env var, then `wslpath` to convert. Returns
 * `null` on any failure (cmd.exe / wslpath missing, env var
 * unset, conversion error) so callers fall back to Linux-only
 * detection.
 *
 * Codex Round-13 Fix 20 helper.
 */
function wslWindowsEnvPath(envVarName: string): string | null {
  try {
    const winPath = execSync(`cmd.exe /c "echo %${envVarName}%"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // `cmd.exe` echoes `%FOO%` literally when the var is unset.
    if (!winPath || winPath.startsWith('%')) return null;
    // Strip Windows CR if present.
    const cleaned = winPath.replace(/\r/g, '');
    // wslpath -u takes the Windows path and emits the /mnt/c/...
    // form. Quote the input to handle spaces in usernames.
    const linuxPath = execSync(`wslpath -u '${cleaned.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return linuxPath || null;
  } catch {
    return null;
  }
}

/**
 * Exported for Codex Round-13 Fix 20 tests — direct unit testing
 * of WSL2 client-detection branch without going through the full
 * `mcpSetupAction` body. Production callers go via the action.
 * The resolver arg is test-only so WSL Windows path discovery can
 * be exercised without real cmd.exe / wslpath binaries.
 */
export function detectClients(
  resolveWslWindowsEnvPath: (envVarName: string) => string | null =
    wslWindowsEnvPath,
): ClientTarget[] {
  const home = homedir();
  const claudeDesktop = claudeDesktopPaths(home);
  const vscodeMcp = vscodeMcpPaths(home);
  const candidates: ClientTarget[] = [
    {
      name: 'Cursor',
      configPath: join(home, '.cursor', 'mcp.json'),
      displayPath: '~/.cursor/mcp.json',
    },
    {
      name: 'Claude Code',
      configPath: join(home, '.claude.json'),
      displayPath: '~/.claude.json',
    },
    {
      name: 'Claude Desktop',
      configPath: claudeDesktop.configPath,
      displayPath: claudeDesktop.displayPath,
    },
    {
      name: 'Windsurf',
      configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      displayPath: '~/.codeium/windsurf/mcp_config.json',
    },
    {
      name: 'VSCode',
      configPath: vscodeMcp.configPath,
      displayPath: vscodeMcp.displayPath,
      // Copilot Chat's MCP wiring keys under `servers`, not the
      // canonical `mcpServers`. Phase-1 entryPath dispatch handles
      // it without per-client write logic.
      entryPath: 'servers.dkg',
    },
    (() => {
      const cline = clineMcpPaths(home);
      return {
        name: 'Cline',
        configPath: cline.configPath,
        displayPath: cline.displayPath,
        // Cline uses the canonical `mcpServers.dkg` shape; only the
        // path is unusual (deep-nested under VSCode's per-extension
        // globalStorage). entryPath defaults to `mcpServers.dkg`
        // so no override needed.
      };
    })(),
    {
      // Codex CLI (OpenAI). Config: `~/.codex/config.toml`. Entry path:
      // `[mcp_servers.<name>]` table — Codex CLI's canonical naming
      // (note `mcp_servers`, snake-cased, distinct from the
      // `mcpServers` JSON convention used by every other client).
      // Verified against Codex CLI docs at
      // https://github.com/openai/codex (issue #437, 2026-05-08).
      name: 'Codex CLI',
      configPath: join(home, '.codex', 'config.toml'),
      displayPath: '~/.codex/config.toml',
      format: 'toml',
      entryPath: 'mcp_servers.dkg',
    },
  ];

  // Codex Round-13 Fix 20: when running inside WSL2, ALSO probe the
  // Windows-side config locations for the four GUI clients users
  // typically run on Windows even when their dev shell is in WSL.
  // Linux-side entries above are preserved (some WSL users run
  // native Linux GUI clients too); the new entries are additive
  // with disambiguated names so the operator-facing log is clear.
  if (isWSL()) {
    const winUserProfile = resolveWslWindowsEnvPath('USERPROFILE');
    const winAppData = resolveWslWindowsEnvPath('APPDATA');
    if (winAppData) {
      // Claude Desktop on Windows: %APPDATA%\Claude\claude_desktop_config.json.
      const claudeWinPath = join(winAppData, 'Claude', 'claude_desktop_config.json');
      candidates.push({
        name: 'Claude Desktop (Windows-side via WSL)',
        configPath: claudeWinPath,
        displayPath: claudeWinPath,
      });
      // VSCode + Copilot Chat on Windows: %APPDATA%\Code\User\mcp.json.
      const vscodeWinPath = join(winAppData, 'Code', 'User', 'mcp.json');
      candidates.push({
        name: 'VSCode (Windows-side via WSL)',
        configPath: vscodeWinPath,
        displayPath: vscodeWinPath,
        entryPath: 'servers.dkg',
      });
      // Cline on Windows: %APPDATA%\Code\User\globalStorage\
      // saoudrizwan.claude-dev\settings\cline_mcp_settings.json.
      const clineWinPath = join(
        winAppData, 'Code', 'User',
        'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json',
      );
      candidates.push({
        name: 'Cline (Windows-side via WSL)',
        configPath: clineWinPath,
        displayPath: clineWinPath,
      });
    }
    if (winUserProfile) {
      // Windsurf on Windows: %USERPROFILE%\.codeium\windsurf\mcp_config.json
      // (the `~/.codeium/...` path resolves under USERPROFILE on Windows,
      // not APPDATA).
      const windsurfWinPath = join(winUserProfile, '.codeium', 'windsurf', 'mcp_config.json');
      candidates.push({
        name: 'Windsurf (Windows-side via WSL)',
        configPath: windsurfWinPath,
        displayPath: windsurfWinPath,
      });
      // Codex Round-17 Fix 23: Cursor on Windows — same shape as
      // Linux Cursor (~/.cursor/mcp.json + canonical mcpServers.dkg
      // entry), just resolved through %USERPROFILE%. Round-13 FIX 20
      // skipped this; "Windows Cursor + WSL shell" is a common dev
      // setup that was silently unregistered until now even though
      // Cursor's been in the detection set since round 1.
      const cursorWinPath = join(winUserProfile, '.cursor', 'mcp.json');
      candidates.push({
        name: 'Cursor (Windows-side via WSL)',
        configPath: cursorWinPath,
        displayPath: cursorWinPath,
      });
      // PR #443 local review: do not register Windows-side Codex
      // from a WSL process yet. The canonical entry is computed from
      // the current Linux/WSL Node + CLI paths; writing that into
      // %USERPROFILE%\.codex\config.toml would leave Windows Codex
      // unable to spawn the MCP server. Add this only once we emit a
      // Windows-compatible wrapper command, e.g. via wsl.exe.
    }
  }

  return candidates.filter((c) => {
    if (existsSync(c.configPath)) return true;
    if (existsSync(dirname(c.configPath))) return true;
    return false;
  });
}

type RegistrationState = 'registered' | 'stale' | 'not-registered';

interface ClientState {
  target: ClientTarget;
  state: RegistrationState;
  current: unknown;
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(
      `Existing file is not valid JSON: ${tildify(path)}. Move it aside and re-run.`,
    );
  }
}

/**
 * PR #443 round-5 Codex Review: mirror `readJson`'s friendly-recovery
 * wrapping for the TOML branch. `@iarna/toml`'s parse error includes
 * line/column info but no path and no suggested next-step; an
 * operator hitting a malformed `~/.codex/config.toml` would see the
 * raw library message and abort the entire `dkg mcp setup` flow with
 * no clear recovery path. Wrap with the same shape JSON uses so the
 * operator-facing error names the file and the move-it-aside
 * recovery procedure.
 */
function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  // `@iarna/toml`'s parser returns `{}` for an all-whitespace file
  // already, but normalising empty-string up front mirrors readJson
  // and skips the parse call for the common parent-dir-only-detected
  // first-write case.
  if (!raw.trim()) return {};
  try {
    const parsed = TOML.parse(raw);
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `Existing file is not valid TOML: ${tildify(path)}. Move it aside and re-run.`,
    );
  }
}

/**
 * Read the parsed body of a per-client config, dispatching on
 * `target.format`. JSON is the default + most-common format. TOML
 * (Codex CLI) uses `@iarna/toml`. The YAML branch is a reserved
 * stub today — see `ClientTarget.format` for the PR #443 history.
 * Missing-file is normalised to `{}` for the live formats so
 * first-write callers don't have to special-case
 * detection-via-parent-dir candidates.
 */
function readConfigBody(target: ClientTarget): Record<string, unknown> {
  const format = target.format ?? DEFAULT_FORMAT;
  switch (format) {
    case 'json':
      return readJson(target.configPath);
    case 'toml':
      return readToml(target.configPath);
    case 'yaml':
      // YAML branch is reserved for a future client (PR #443
      // attempted Continue here, then reverted because Continue's
      // MCP config is workspace-local, not user-global). Re-adding
      // a YAML client is purely additive: declare the candidate
      // with `format: 'yaml'` and replace this stub with the
      // `js-yaml.load` call. Throwing eagerly here means a future
      // candidate that ships pre-stub-replacement trips cleanly at
      // registration time rather than silently writing garbage.
      throw new Error(
        `YAML config format not yet implemented (target: ${target.name}).`,
      );
    default:
      throw new Error(`Unknown client config format: ${String(format)}`);
  }
}

function serialiseTomlEntryOnly(
  target: ClientTarget,
  body: Record<string, unknown>,
): string {
  const nested: Record<string, unknown> = {};
  const { head, leaf } = splitEntryPath(target.entryPath);
  const container = ensurePathContainer(nested, head);
  container[leaf] = readEntryAt(body, target.entryPath) ?? {};
  return TOML.stringify(nested as TOML.JsonMap);
}

interface TomlLine {
  text: string;
  eol: string;
}

function splitTomlLines(raw: string): TomlLine[] {
  const lines: TomlLine[] = [];
  const re = /(.*?)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    if (match[0] === '') break;
    lines.push({ text: match[1], eol: match[2] });
  }
  return lines;
}

function splitTomlKeyPath(path: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of path) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === '"' && ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === '.') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.map((part) => {
    if (
      part.length >= 2 &&
      ((part.startsWith('"') && part.endsWith('"')) ||
        (part.startsWith("'") && part.endsWith("'")))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

const TOML_PATH_SEPARATOR = '\0';

function normaliseTomlHeaderPath(path: string): string {
  return splitTomlKeyPath(path).join(TOML_PATH_SEPARATOR);
}

function normaliseTomlOwnedPath(path: string): string {
  return path.split('.').filter(Boolean).join(TOML_PATH_SEPARATOR);
}

function tomlParentPath(path: string): string | null {
  const parts = path.split('.').filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('.');
}

function tomlTableHeaderPath(line: string): string | null {
  const arrayMatch = line.match(/^\s*\[\[\s*(.+?)\s*\]\]\s*(?:#.*)?$/);
  if (arrayMatch) return normaliseTomlHeaderPath(arrayMatch[1]);
  const tableMatch = line.match(/^\s*\[\s*(.+?)\s*\]\s*(?:#.*)?$/);
  if (tableMatch) return normaliseTomlHeaderPath(tableMatch[1]);
  return null;
}

function ownsTomlTablePath(path: string, ownedPath: string): boolean {
  return path === ownedPath || path.startsWith(`${ownedPath}${TOML_PATH_SEPARATOR}`);
}

type TomlMultilineDelimiter = '"""' | "'''";

function advanceTomlMultilineDelimiter(
  line: string,
  state: TomlMultilineDelimiter | null,
): TomlMultilineDelimiter | null {
  let i = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  while (i < line.length) {
    if (state) {
      const end = line.indexOf(state, i);
      if (end === -1) return state;
      i = end + state.length;
      state = null;
      continue;
    }

    const ch = line[i];
    if (quote === '"') {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        quote = null;
      }
      i++;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (ch === '#') break;
    if (line.startsWith('"""', i)) {
      state = '"""';
      i += 3;
      continue;
    }
    if (line.startsWith("'''", i)) {
      state = "'''";
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i++;
      continue;
    }
    i++;
  }

  return state;
}

function tomlTableHeaderPaths(lines: TomlLine[]): Array<string | null> {
  let multilineDelimiter: TomlMultilineDelimiter | null = null;
  return lines.map((line) => {
    const headerPath = multilineDelimiter ? null : tomlTableHeaderPath(line.text);
    multilineDelimiter = advanceTomlMultilineDelimiter(line.text, multilineDelimiter);
    return headerPath;
  });
}

function isTomlCommentOrBlank(line: TomlLine): boolean {
  const trimmed = line.text.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function normaliseNewlines(text: string, newline: string): string {
  return text.replace(/\r\n|\n|\r/g, newline);
}

function appendTomlTable(raw: string, replacement: string, newline: string): string {
  if (!raw.trim()) return replacement;
  let out = raw;
  if (!out.endsWith('\n') && !out.endsWith('\r')) out += newline;
  if (!out.endsWith(`${newline}${newline}`)) out += newline;
  return out + replacement;
}

function replaceTomlTable(
  raw: string,
  ownedPath: string,
  replacement: string,
  parsedRawHasOwnedEntry: boolean,
  parsedRawHasOwnedParent: boolean,
): string | null {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const ownedPathKey = normaliseTomlOwnedPath(ownedPath);
  const parentPathKey = tomlParentPath(ownedPath);
  const normalisedParentPathKey = parentPathKey
    ? normaliseTomlOwnedPath(parentPathKey)
    : null;
  const replacementBlock = normaliseNewlines(
    replacement.endsWith('\n') || replacement.endsWith('\r')
      ? replacement
      : replacement + newline,
    newline,
  );
  const lines = splitTomlLines(raw);
  const headerPaths = tomlTableHeaderPaths(lines);
  const ranges: { start: number; end: number }[] = [];
  let hasRootTable = false;
  let hasParentTableFamily = normalisedParentPathKey === null;

  for (let i = 0; i < lines.length; i++) {
    const headerPath = headerPaths[i];
    if (!headerPath) continue;
    if (
      normalisedParentPathKey &&
      ownsTomlTablePath(headerPath, normalisedParentPathKey)
    ) {
      hasParentTableFamily = true;
    }
    if (!ownsTomlTablePath(headerPath, ownedPathKey)) continue;
    if (headerPath === ownedPathKey) hasRootTable = true;
    let end = i + 1;
    while (end < lines.length && headerPaths[end] === null) {
      end++;
    }
    let replaceEnd = end;
    while (replaceEnd > i + 1 && isTomlCommentOrBlank(lines[replaceEnd - 1])) {
      replaceEnd--;
    }
    ranges.push({ start: i, end: replaceEnd });
    i = end - 1;
  }

  if (parsedRawHasOwnedEntry && !hasRootTable) {
    return null;
  }

  if (parsedRawHasOwnedParent && !hasParentTableFamily && ranges.length === 0) {
    return null;
  }

  if (ranges.length === 0) {
    return appendTomlTable(raw, replacementBlock, newline);
  }

  let inserted = false;
  let rangeIndex = 0;
  let out = '';
  for (let i = 0; i < lines.length;) {
    const range = ranges[rangeIndex];
    if (range && i === range.start) {
      if (!inserted) {
        out += replacementBlock;
        inserted = true;
      }
      i = range.end;
      rangeIndex++;
      continue;
    }
    out += lines[i].text + lines[i].eol;
    i++;
  }
  return out;
}

function readPathAt(body: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined;
  let cursor: unknown = body;
  for (const segment of path.split('.').filter(Boolean)) {
    if (cursor === undefined || cursor === null || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function tomlRawHasEntry(raw: string, entryPath: string | undefined): boolean {
  if (!raw.trim()) return false;
  try {
    const parsed = TOML.parse(raw) as Record<string, unknown>;
    return readEntryAt(parsed, entryPath) !== undefined;
  } catch {
    return false;
  }
}

function tomlRawHasPath(raw: string, path: string | undefined): boolean {
  if (!raw.trim()) return false;
  try {
    const parsed = TOML.parse(raw) as Record<string, unknown>;
    return readPathAt(parsed, path) !== undefined;
  } catch {
    return false;
  }
}

function writeTomlConfigBody(
  target: ClientTarget,
  body: Record<string, unknown>,
): void {
  const raw = existsSync(target.configPath)
    ? readFileSync(target.configPath, 'utf8')
    : '';
  const ownedPath = target.entryPath ?? DEFAULT_ENTRY_PATH;
  const ownedParentPath = tomlParentPath(ownedPath) ?? undefined;
  const serialisedEntry = serialiseTomlEntryOnly(target, body);
  const patched = replaceTomlTable(
    raw,
    ownedPath,
    serialisedEntry,
    tomlRawHasEntry(raw, target.entryPath),
    tomlRawHasPath(raw, ownedParentPath),
  );
  if (patched === null) {
    process.stderr.write(
      `[setup] WARNING: ${target.name} config at ${tildify(target.configPath)} ` +
        `uses a TOML shape that cannot be patched safely for ${ownedPath}; ` +
        'rewriting the TOML file to avoid invalid or duplicate definitions. ' +
        'Comments/formatting outside this entry may not be preserved.\n',
    );
  }
  writeFileSync(
    target.configPath,
    patched ?? TOML.stringify(body as TOML.JsonMap),
  );
}

/**
 * Serialize a parsed body to disk, dispatching on `target.format`.
 * Mirrors `readConfigBody`'s dispatch shape. JSON output keeps the
 * pre-refactor formatting (2-space indent, trailing newline)
 * byte-for-byte. TOML patches only the owned MCP table. YAML is a
 * reserved-stub branch today.
 *
 * FIX 26 merge: format-agnostic. The merge in `writeRegistration`
 * operates on the parsed body object before it reaches this writer,
 * so the per-format spread/stringify path here never sees the merge
 * logic.
 */
function writeConfigBody(target: ClientTarget, body: Record<string, unknown>): void {
  const format = target.format ?? DEFAULT_FORMAT;
  const dir = dirname(target.configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  switch (format) {
    case 'json':
      writeFileSync(target.configPath, JSON.stringify(body, null, 2) + '\n');
      return;
    case 'toml':
      writeTomlConfigBody(target, body);
      return;
    case 'yaml':
      // Mirror `readConfigBody`'s YAML stub. See the comment there
      // for the rationale (PR #443 Continue revert; YAML branch
      // reserved for a future client).
      throw new Error(
        `YAML config format not yet implemented (target: ${target.name}).`,
      );
    default:
      throw new Error(`Unknown client config format: ${String(format)}`);
  }
}

function classify(
  target: ClientTarget,
  expected: Record<string, unknown>,
): ClientState {
  const body = readConfigBody(target);
  const current = readEntryAt(body, target.entryPath) as
    | Record<string, unknown>
    | null
    | undefined;
  // Treat both `undefined` (key absent) and `null` (key present but
  // explicitly nulled) as "not-registered". Pre-F7 a `{ dkg: null }`
  // entry classified as `stale`, which made the operator-facing
  // log line claim there was a current value to refresh — there
  // wasn't. Same registration outcome under `--force`; clearer log.
  if (current === undefined || current === null) {
    return { target, state: 'not-registered', current: null };
  }
  // Codex Round-4 staleness contract: pure string equality. The
  // canonical entry is now uniform `process.execPath + cli.js path`
  // for both installed and monorepo modes (round-4 unified the
  // shape), so all earlier asymmetric equivalence rules collapse
  // to a single check. Any divergence — legacy bare-`"dkg"`,
  // resolved-`/usr/local/bin/dkg`, a stale repo-root path from a
  // moved checkout, etc. — classifies as `stale` and refreshes to
  // the new shape on stock re-run. Auto-migration fires for free.
  const expectedCommand = expected.command;
  const currentCommand = (current as Record<string, unknown>).command;
  const commandMatches = currentCommand === expectedCommand;
  const argsMatch =
    Array.isArray((current as Record<string, unknown>).args) &&
    JSON.stringify((current as Record<string, unknown>).args) ===
      JSON.stringify(expected.args);
  // Codex Round-9 Fix 16 + Round-15 Fix 22: compare ONLY the
  // `env.DKG_HOME` field, not the whole env object. Round-9 used
  // strict JSON.stringify equality on env, but that turned any
  // user-added MCP env var (NODE_OPTIONS, HTTPS_PROXY, custom
  // debug flags) into spurious "stale drift" — and combined with
  // writeRegistration's full-entry replace, those user vars got
  // silently wiped on every re-run. Post-fix: only DKG_HOME
  // matters for staleness; user-added keys are preserved by the
  // write-time merge in writeRegistration. A pre-Fix-16 entry
  // lacking `env` entirely classifies as `stale` (currentDkgHome
  // === undefined !== expectedDkgHome) and migrates forward.
  const currentEnvObj =
    (current as Record<string, unknown>).env &&
    typeof (current as Record<string, unknown>).env === 'object'
      ? ((current as Record<string, unknown>).env as Record<string, unknown>)
      : undefined;
  const currentDkgHome = currentEnvObj?.DKG_HOME;
  const expectedDkgHome =
    expected.env && typeof expected.env === 'object'
      ? (expected.env as Record<string, unknown>).DKG_HOME
      : undefined;
  const envMatch = currentDkgHome === expectedDkgHome;
  const matches =
    typeof current === 'object' &&
    current !== null &&
    commandMatches &&
    argsMatch &&
    envMatch;
  return {
    target,
    state: matches ? 'registered' : 'stale',
    current: current ?? null,
  };
}

function writeRegistration(
  target: ClientTarget,
  entry: Record<string, unknown>,
): void {
  const body = readConfigBody(target);

  // Codex Round-15 Fix 22 + Round-19 Fix 26: when refreshing an
  // existing entry, MERGE the entire existing entry — not just
  // env — with the expected entry. Round-15 Fix 22 added env-merge
  // (NODE_OPTIONS, HTTPS_PROXY, etc. preserved) but the rest of
  // the entry was still being replaced wholesale, which clobbered
  // top-level keys clients use to anchor MCP servers (e.g. `cwd`
  // for workspace-scoped servers, custom keys like `restartPolicy`).
  //
  // Spread order: existing entry first, then expected entry, then
  // explicit env merge. The fields THIS COMMAND owns are
  // `command`, `args`, and `env.DKG_HOME` — those override
  // existing values via the second spread + explicit env override.
  // Everything else passes through from the existing entry
  // unchanged: arbitrary top-level keys (cwd, restartPolicy, …)
  // and arbitrary env keys (NODE_OPTIONS, HTTPS_PROXY, …).
  const { head, leaf } = splitEntryPath(target.entryPath);
  const container = ensurePathContainer(body, head);
  const currentEntry = container[leaf];
  const currentEntryObj =
    currentEntry && typeof currentEntry === 'object'
      ? (currentEntry as Record<string, unknown>)
      : {};
  const currentEnv =
    currentEntryObj.env && typeof currentEntryObj.env === 'object'
      ? (currentEntryObj.env as Record<string, unknown>)
      : {};
  const expectedEnv =
    entry.env && typeof entry.env === 'object'
      ? (entry.env as Record<string, unknown>)
      : {};
  const mergedEntry: Record<string, unknown> = {
    ...currentEntryObj,
    ...entry,
    env: { ...currentEnv, ...expectedEnv },
  };
  container[leaf] = mergedEntry;
  writeConfigBody(target, body);
}

/**
 * Fallback agent-name minter for first-init when no `--name` is passed
 * and no persisted config exists. Mirrors `discoverAgentName`'s
 * unique-fallback shape (`openclaw-agent-XXXXX`) but with `mcp-` prefix
 * so support traffic can tell which setup verb produced the identity.
 * Re-runs hit the persisted name instead because `writeDkgConfig`
 * preserves an existing `name` field.
 */
function mintFallbackAgentName(): string {
  const id = Math.random().toString(36).slice(2, 7);
  return `mcp-agent-${id}`;
}

/**
 * Codex Round-7 Fix 12: read the persisted DKG node config from
 * either `config.json` (preferred) or `config.yaml` (fallback).
 * Round-3's yaml support in `resolveDkgConfigHome()`'s configExists
 * short-circuit treated yaml-only homes as established, but the
 * step-1 reconcile path stayed JSON-only. The asymmetry meant
 * yaml-only users hit the configExists fast path and then silently
 * fell back to defaults for `name` / `apiPort` — daemon start /
 * funding / verification all targeted the wrong values.
 *
 * Precedence: JSON wins over YAML when both exist. Deterministic
 * for users who hand-edit one file while the daemon writes to the
 * other; matches the existing `resolveDkgConfigHome` order.
 *
 * Returns `undefined` on missing or corrupt files (both formats
 * tolerate parse failure — downstream uses pre-merge defaults
 * silently rather than crashing setup).
 */
function readPersistedConfig(dkgDirPath: string): Record<string, unknown> | undefined {
  const jsonPath = join(dkgDirPath, 'config.json');
  if (existsSync(jsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    } catch { /* corrupt JSON; fall through to YAML attempt */ }
  }
  const yamlPath = join(dkgDirPath, 'config.yaml');
  if (existsSync(yamlPath)) {
    try {
      const raw = yaml.load(readFileSync(yamlPath, 'utf-8'));
      if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
    } catch { /* corrupt YAML; let writeDkgConfig handle */ }
  }
  return undefined;
}

/**
 * Read the persisted agent name from the DKG node config (JSON or
 * YAML). Returns `undefined` for missing/corrupt files. Used so a
 * second `dkg mcp setup` run on a config whose `name` was set by a
 * prior init doesn't regenerate a fresh random fallback.
 *
 * Codex Round-7 Fix 12: now accepts YAML configs in addition to
 * JSON via the shared `readPersistedConfig()` helper.
 */
function readPersistedAgentName(dkgDirPath: string): string | undefined {
  const persisted = readPersistedConfig(dkgDirPath);
  const name = persisted?.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  return undefined;
}

/**
 * Main entrypoint invoked by the `dkg mcp setup` commander handler in
 * `cli.ts`. Idempotent — re-running on a fully-set-up tree prints
 * step-by-step skip notices and exits cleanly without touching any
 * file or restarting the daemon.
 */
export async function mcpSetupAction(
  opts: McpSetupCliOptions,
  deps: McpSetupActionDeps,
): Promise<void> {
  const force = opts.force === true;
  const printOnly = opts.printOnly === true;
  const dryRun = opts.dryRun === true;
  const shouldStart = opts.start !== false;
  const shouldFund = opts.fund !== false;
  const shouldVerify = opts.verify !== false;
  const apiPort = Number(opts.port ?? '9200');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`Invalid port "${opts.port}" — must be an integer between 1 and 65535`);
  }

  // Phase-2: detect setup context (installed vs monorepo dev). Drives
  // `canonicalEntry`'s output shape so a contributor's local CLI dist
  // is the one Cursor / Claude Code etc. invoke, not a stale globally-
  // installed version. `--installed` / `--monorepo` are mutually
  // exclusive overrides; flag them at the boundary so a misuse
  // surfaces with a clear error rather than silent precedence.
  if (opts.installed === true && opts.monorepo === true) {
    throw new Error(
      '--installed and --monorepo are mutually exclusive; pass at most one.',
    );
  }
  const forcedContext: SetupContext | undefined = opts.installed
    ? 'installed'
    : opts.monorepo
      ? 'monorepo'
      : undefined;
  const { context, monorepoRoot } = detectContext(deps.findDkgMonorepoRoot, {
    force: forcedContext,
  });

  // Codex Round-9 Fix 16: dkgDirPath has to be resolved BEFORE
  // `canonicalEntry()` so we can propagate it via the entry's `env:
  // { DKG_HOME }` field. Round-3/Round-5/Round-8 layered the cascade
  // — see comment block on `previousDkgHome` capture below for the
  // full rationale chain.
  //
  // Codex Round-3 Fix 3 + Round-8 Fix 14: capture the operator's
  // pre-existing `DKG_HOME` BEFORE our own mutation — both for
  // try/finally restore (Round-3 Fix 3) AND for env-precedence
  // priority (Round-8 Fix 14). DKG_HOME is the highest-precedence
  // operator override; it MUST win over the `--monorepo` bypass and
  // over the auto-detect fallback. Pre-Fix-14 the `--monorepo`
  // branch ignored env entirely, so an operator with `DKG_HOME` set
  // who passed `--monorepo` would have setup state land in
  // `~/.dkg-dev` while the rest of the CLI (every other downstream
  // call into `resolveDkgConfigHome` / `dkgDir()`) honoured the
  // env override — splitting state across two homes.
  const previousDkgHome = process.env.DKG_HOME;

  // dkgDirPath cascade (highest priority first):
  //   1. `previousDkgHome` (operator-set DKG_HOME) — wins always.
  //   2. `--monorepo` bypass (Round-5 Fix 6) — explicit dev-isolation
  //      contract; bypasses configExists short-circuit but defers
  //      to env override above.
  //   3. `resolveDkgConfigHome` auto-detect — respects configExists
  //      so global-install users on incidental monorepo cwd aren't
  //      silently redirected.
  let dkgDirPath: string;
  if (previousDkgHome) {
    dkgDirPath = previousDkgHome;
  } else if (forcedContext === 'monorepo' && monorepoRoot) {
    dkgDirPath = join(homedir(), '.dkg-dev');
  } else {
    dkgDirPath = deps.resolveDkgConfigHome({ isDkgMonorepo: context === 'monorepo' });
  }

  // Codex Round-4: both modes register `process.execPath` + the
  // absolute CLI script path. No more `which dkg` resolution — the
  // shape is uniform and PATH-free, eliminating both the `dkg` bin
  // shim AND the `node` binary the shim would have invoked from
  // GUI clients' lookup chain.
  // Codex Round-9 Fix 16: third arg propagates dkgDirPath into the
  // entry's `env: { DKG_HOME }` field so spawned MCP servers read
  // the same home setup just bootstrapped (GUI clients don't
  // inherit shell env).
  const expectedEntry = canonicalEntry(context, monorepoRoot, dkgDirPath);

  // Codex Round-7 Fix 11 + Round-8 Fix 13: surface the exact
  // command + args that will be persisted into client configs.
  // The `--installed` / `--monorepo` flags only govern the
  // bootstrap home — the registered binary is always whichever
  // CLI is currently running. Logging it here lets operators
  // verify before any client write happens.
  //
  // Routed to STDERR (not console.log → stdout) because this
  // line runs BEFORE the `--print-only` early return, and
  // `dkg mcp setup --print-only` MUST emit a single canonical
  // JSON document on stdout for `… | jq …` and redirect-into-
  // config workflows to work. Same convention as the VSCode
  // disambiguation note (Round-2 Bug B): operator advisories on
  // stderr; data on stdout. Round-7 originally used console.log
  // and broke --print-only stdout purity for the second time.
  const entryArgs = (expectedEntry.args as string[]).join(' ');
  process.stderr.write(`[setup] Registering CLI: ${expectedEntry.command} ${entryArgs}\n`);

  if (printOnly) {
    const block = {
      mcpServers: {
        dkg: expectedEntry,
      },
    };
    process.stdout.write(JSON.stringify(block, null, 2) + '\n');
    // Codex Round-2: VSCode + Copilot Chat keys MCP servers under
    // `servers`, not the canonical `mcpServers`. Round-1 of this
    // fix appended the note + a second JSON object to stdout, but
    // that breaks `dkg mcp setup --print-only | jq …` and any
    // redirect-based workflow — the flag contract is "stdout is the
    // canonical JSON document". Keep stdout a single JSON document
    // and emit the disambiguation to stderr instead, matching the
    // standard CLI convention (data on stdout, advisories on stderr).
    process.stderr.write(
      '\n' +
        'Note: VSCode + GitHub Copilot Chat uses a different shape — ' +
        '`servers.dkg` instead of `mcpServers.dkg`. For VSCode, paste:\n' +
        JSON.stringify({ servers: { dkg: expectedEntry } }, null, 2) +
        '\n',
    );
    return;
  }

  console.log('\nDKG MCP setup');
  console.log('='.repeat(40));
  if (dryRun) {
    console.log('[setup] DRY RUN — no files will be modified, no daemon will start\n');
  }

  // ── Step 1: ensure <dkg-home>/config.json ─────────────────────────
  // Mirrors `dkg openclaw setup` step 3 byte-for-byte. If the file
  // already exists, `writeDkgConfig` merges (first-wins on `name` /
  // `apiPort` unless explicit overrides are passed).
  //
  // Codex Round-2 Bug A: thread the monorepo signal into DKG-home
  // resolution so the bootstrap state (config, daemon pid, faucet
  // wallets, auth.token) lands in the SAME directory the registered
  // local CLI dist will read at MCP-client startup. Setting
  // `DKG_HOME` for the duration of this action overrides the
  // package-path-based auto-detection inside adapter-openclaw's
  // `dkgDir()` and dkg-core's daemon-lifecycle, keeping all four
  // flows aligned. (`dkgDirPath` itself was computed up-front for
  // Round-9 Fix 16 — we just install the env mutation here.)
  process.env.DKG_HOME = dkgDirPath;
  try {
  const yamlPath = join(dkgDirPath, 'config.yaml');
  const jsonPath = join(dkgDirPath, 'config.json');
  const configExists = existsSync(yamlPath) || existsSync(jsonPath);

  let effectivePort = apiPort;
  let effectiveAgentName = opts.name?.trim() || readPersistedAgentName(dkgDirPath) || mintFallbackAgentName();

  /**
   * F6 fix: read-back must run on BOTH branches (skip-write AND
   * write-then-read), not just inside the `else`. The pre-F6 layout
   * only reconciled `effectivePort` after `writeDkgConfig` ran,
   * leaving the skip-write branch with the CLI default 9200 even when
   * the persisted config had a different port. Concrete reproducer:
   * a user previously ran `dkg openclaw setup --port 9300`; running
   * `dkg mcp setup` with no flags would start the daemon on 9200 and
   * the verification probe + registered MCP entry would point at the
   * wrong port.
   *
   * Pulling the read-back into a helper that runs unconditionally
   * after the (optional) write keeps the daemon-start, faucet, and
   * verify steps all aligned with the persisted config — which is
   * the source of truth for an existing install.
   */
  const reconcileFromPersistedConfig = (): void => {
    // Codex Round-7 Fix 12: read JSON-or-YAML via the shared
    // `readPersistedConfig()` helper. Pre-fix this branch only
    // tried `config.json`, so a yaml-only install would silently
    // fall through with the CLI defaults (port 9200, random name)
    // and the daemon / funding / verify steps would target the
    // wrong values. Round-3's configExists short-circuit had
    // already established yaml-only homes; this completes the
    // contract.
    const merged = readPersistedConfig(dkgDirPath);
    if (!merged) return;
    const mergedPort = Number((merged as { apiPort?: unknown }).apiPort);
    if (Number.isInteger(mergedPort) && mergedPort >= 1 && mergedPort <= 65535) {
      effectivePort = mergedPort;
    }
    const mergedName = (merged as { name?: unknown }).name;
    if (typeof mergedName === 'string' && mergedName.trim()) {
      effectiveAgentName = mergedName.trim();
    }
  };

  // F25: reconcile BEFORE the branch decision so dry-run preview
  // and skip-write log lines see the persisted-port value. Pre-F25
  // the dry-run branch printed the CLI-default `apiPort` (9200)
  // even when `~/.dkg/config.json` had `apiPort: 9300`. Lifting
  // the call here also collapses the two duplicate calls (one in
  // the skip-write branch, one in the write-then-read branch)
  // into a single up-front read.
  if (configExists) {
    reconcileFromPersistedConfig();
  }

  if (configExists && opts.name == null && opts.port == null) {
    console.log(`[setup] Node config exists (${tildify(existsSync(yamlPath) ? yamlPath : jsonPath)}); leaving untouched.`);
  } else if (dryRun) {
    console.log(`[setup] [dry-run] Would write ${tildify(jsonPath)} (port ${effectivePort}, name "${effectiveAgentName}")`);
  } else {
    try {
      const network = deps.loadNetworkConfig();
      // Codex Round-23 Fix 30: call the agent-agnostic
      // ensureDkgNodeConfig directly. The caller-loads-existing
      // contract means we pre-read the persisted config (yaml or
      // json) here and pass it through; the helper merges with
      // network defaults + overrides. No OpenClaw migration step
      // — MCP-only configs never have the legacy openclawAdapter
      // / openclawChannel keys this setup never wrote.
      const existing = readPersistedConfig(dkgDirPath) ?? {};
      deps.ensureDkgNodeConfig({
        agentName: effectiveAgentName,
        network,
        apiPort,
        existing,
        overrides: {
          nameExplicit: opts.name != null,
          portExplicit: opts.port != null,
        },
      });
      // Re-read after ensureDkgNodeConfig in case the helper's
      // field-level merge changed `apiPort` / `name` (first-wins
      // semantics on existing fields, explicit overrides on new).
      reconcileFromPersistedConfig();
    } catch (err: any) {
      console.error(`[setup] Failed to load network config: ${err?.message ?? err}`);
      throw err;
    }
  }

  // ── Step 2: start the daemon ──────────────────────────────────────
  // `startDaemon` is no-op when a healthy daemon is already reachable
  // on `effectivePort`; otherwise it spawns one and polls for
  // readiness up to 30s. Same primitive openclaw-setup uses — see
  // `packages/adapter-openclaw/src/setup.ts:606+`.
  if (shouldStart && !dryRun) {
    await deps.startDaemon(effectivePort);
  } else if (shouldStart && dryRun) {
    console.log('[setup] [dry-run] Would start DKG daemon');
  } else {
    console.log('[setup] Skipping daemon start (--no-start)');
  }

  // ── Step 3: optional faucet ───────────────────────────────────────
  // Reads wallets from `~/.dkg/wallets.json` (written async by the
  // daemon) with the same 5×1s retry openclaw-setup uses. Faucet
  // failures log a manual `curl` block and continue — funding is
  // non-fatal for setup.
  //
  // F14: the funding decision is decoupled from `shouldStart`. The
  // pre-fix outer guard `if (shouldFund && !dryRun && shouldStart)`
  // silently skipped funding whenever `--no-start` was supplied,
  // even when the daemon was already running from a prior invocation
  // and a re-run-to-retry-funding was the user's actual goal.
  // Post-fix flow:
  //   1. Honour `--no-fund` (explicit opt-out, unchanged).
  //   2. Honour `--dry-run` (no network calls).
  //   3. Probe daemon reachability at `/api/status` on
  //      `effectivePort`. If unreachable, log explicit
  //      "skipping wallet funding (daemon not reachable on port X)"
  //      with the reason — replaces the silent omission. If
  //      reachable, proceed with funding regardless of which
  //      invocation started the daemon.
  if (!shouldFund) {
    console.log('[setup] Skipping wallet funding (--no-fund)');
  } else if (dryRun) {
    console.log('[setup] [dry-run] Would attempt wallet funding');
  } else {
    let daemonReachable = false;
    try {
      // F26: bound the probe with AbortSignal.timeout(2000) so a
      // partially-up daemon (port bound but unresponsive — half-stuck
      // process or deadlocked startup) doesn't hang setup. The probe
      // is best-effort; treating timeout as "not reachable" is the
      // correct fallback because we move on to log the explicit
      // skip-with-reason message anyway.
      const probe = await fetch(`http://127.0.0.1:${effectivePort}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      daemonReachable = probe.ok;
    } catch { /* not reachable (or timed out) */ }

    if (!daemonReachable) {
      console.log(
        `[setup] Skipping wallet funding (daemon not reachable on port ${effectivePort})`,
      );
    } else {
      try {
        const network = deps.loadNetworkConfig();
        const faucetUrl = network.faucet?.url;
        const faucetMode = network.faucet?.mode ?? 'testnet';
        if (!faucetUrl) {
          console.log('[setup] No faucet URL configured for this network; skipping wallet funding.');
        } else {
          const wallets = await deps.readWalletsWithRetry();
          if (wallets.length === 0) {
            console.log('[setup] No wallets to fund yet (daemon may not have flushed wallets.json).');
          } else {
            try {
              const result = await deps.requestFaucetFunding(faucetUrl, faucetMode, wallets, effectiveAgentName);
              if (result?.success === false) {
                console.warn(
                  `[setup] Faucet returned failure${result.error ? ` (${result.error})` : ''}; emitting manual instructions.`,
                );
                deps.logManualFundingInstructions(wallets, faucetUrl, faucetMode);
              } else if (result?.error) {
                const failedWallets = Array.isArray(result.failedWallets) && result.failedWallets.length
                  ? result.failedWallets
                  : wallets;
                console.warn(`[setup] Faucet partially completed (${result.error}); emitting manual instructions for remaining wallet(s).`);
                deps.logManualFundingInstructions(failedWallets, faucetUrl, faucetMode);
              } else {
                const fundedWalletCount = Array.isArray(result?.fundedWallets) && result.fundedWallets.length
                  ? result.fundedWallets.length
                  : wallets.length;
                console.log(`[setup] Funded ${fundedWalletCount} wallet(s) via testnet faucet.`);
              }
            } catch (err: any) {
              console.warn(`[setup] Faucet call failed (${err?.message ?? err}); emitting manual instructions.`);
              deps.logManualFundingInstructions(wallets, faucetUrl, faucetMode);
            }
          }
        }
      } catch (err: any) {
        console.warn(`[setup] Faucet step skipped: ${err?.message ?? err}`);
      }
    }
  }

  // ── Step 4: client detection + classification ─────────────────────
  console.log('');
  const clients = detectClients();
  if (clients.length === 0) {
    console.log('No MCP-aware clients detected.');
    console.log('  Print the canonical JSON for manual paste:');
    console.log('    dkg mcp setup --print-only');
    return;
  }

  // Codex Round-8 Fix 15: per-client classify error isolation.
  // Pre-fix, a malformed config in any one detected client (e.g. a
  // truncated VSCode `Code/User/mcp.json`, a broken Cline
  // `cline_mcp_settings.json`) would throw out of `classify(...)`
  // and abort the entire setup before other clients were even
  // touched. This is especially load-bearing for VSCode/Cline,
  // whose dirname-heuristic detection is broad enough to flag any
  // `Code/User/` directory as a candidate even when Copilot Chat
  // / Cline isn't actually installed.
  //
  // Fixed: track classify failures alongside states. On failure,
  // emit a stderr warning, mark the target as failed, and force
  // the planner below to `skip` it so no write is attempted on a
  // client we couldn't read. Other clients continue unaffected.
  const classifyFailed = new Set<string>();
  const states: ClientState[] = clients.map((c) => {
    try {
      return classify(c, expectedEntry);
    } catch (err: any) {
      process.stderr.write(
        `[setup] WARNING: ${c.name} classify failed (${err?.message ?? err}); skipping this client.\n`,
      );
      classifyFailed.add(c.name);
      return { target: c, state: 'not-registered', current: null };
    }
  });
  const planned: PlannedItem[] = states.map((s) => {
    if (classifyFailed.has(s.target.name)) return { s, action: 'skip' };
    if (force) return { s, action: 'refresh' };
    if (s.state === 'not-registered') return { s, action: 'register' };
    if (s.state === 'stale') return { s, action: 'refresh' };
    return { s, action: 'skip' };
  });

  for (const { s, action } of planned) {
    const stateLabel =
      s.state === 'registered'
        ? 'registered'
        : s.state === 'stale'
          ? 'stale'
          : 'not registered';
    const actionLabel =
      action === 'register'
        ? 'will register'
        : action === 'refresh'
          ? 'will refresh'
          : 'leaving alone';
    console.log(`  ${s.target.name.padEnd(13)} (${s.target.displayPath}) — ${stateLabel}; ${actionLabel}`);
  }

  // F31: per-client interactive confirm. Skipped on `--yes`, in
  // non-TTY environments (CI, piped input), or when nothing's
  // pending — see `confirmPlan` JSDoc for the auto-confirm matrix.
  // Skip in dry-run too: dry-run is preview-only, no point asking
  // the operator about writes that won't happen.
  const confirm = deps.confirmPlan ?? confirmPlan;
  const confirmed = dryRun
    ? planned
    : await confirm(planned, { yes: opts.yes === true });

  const writes = confirmed.filter((p) => p.action !== 'skip');
  if (writes.length === 0) {
    if (planned.some((p) => p.action !== 'skip')) {
      // Codex Round-5 Fix 7: clarify the flag guidance. `--force`
      // refreshes already-registered clients; `--yes` skips
      // prompts. The flags are orthogonal — a re-run with only
      // `--force` would re-prompt the same declined entries (since
      // they're still classified as register/refresh, not skip,
      // and confirmPlan still prompts in TTY mode regardless of
      // force). To get past the prompt loop, the operator wants
      // `--yes` (alone if the entries were unregistered; combined
      // with `--force` if they want to also refresh
      // already-registered clients).
      console.log('\nAll pending registrations declined. Re-run with --yes to skip prompts (or --force --yes to also refresh already-registered clients).');
    } else {
      console.log('\nClients all up-to-date; nothing to write. Re-run with --force to refresh anyway.');
    }
  } else if (dryRun) {
    console.log('\n[setup] [dry-run] Would write to the clients listed above.');
  }
  // Codex Round-9 Fix 17: collect per-client write failures so we
  // can throw a structured aggregate error after the loop. Round-8
  // Fix 15 (continue past per-client failures) is the right intent
  // — but it accidentally exited setup with code 0 even when zero
  // clients were actually updated, giving CI / scripted runs a
  // false-success signal. Fix 17 keeps the continue-and-attempt
  // behaviour AND restores the non-zero exit by throwing once the
  // loop finishes, citing every failed client (classify-failed +
  // write-failed).
  const writeFailures: { name: string; error: string }[] = [];
  if (!dryRun && writes.length > 0) {
    console.log('');
    for (const { s, action } of writes) {
      try {
        writeRegistration(s.target, expectedEntry);
        console.log(`  ${action === 'register' ? 'Registered' : 'Refreshed'} ${s.target.name} → ${s.target.displayPath}`);
      } catch (err: any) {
        // Codex Round-8 Fix 15: per-client write error isolation.
        // Pre-fix this `throw err` aborted the entire setup on the
        // first per-client write failure — every subsequent client
        // (and step 5's verification probe) was skipped. Operators
        // hitting a permissions issue on one client config (e.g.
        // VSCode's `Code/User/mcp.json` owned by root after a
        // previous sudo run) would have to fix that one file by
        // hand before any other registration could be written.
        // Fixed: emit a stderr warning and continue with the rest
        // of the writes loop. Round-9 Fix 17 collects the failure
        // for the post-loop aggregate throw.
        const msg = err?.message ?? String(err);
        process.stderr.write(
          `[setup] WARNING: ${s.target.name} write failed (${msg}); other clients still attempted.\n`,
        );
        writeFailures.push({ name: s.target.name, error: msg });
      }
    }
  }

  // Codex Round-9 Fix 17: aggregate every classify-failed (Fix 15)
  // and write-failed client into a single structured error. Three
  // cases:
  //   - zero clients failed → fall through to step 5 verification
  //     and the existing "Next steps" hint.
  //   - all attempted clients failed → throw "No client configs
  //     updated" (hardest case; the registration step did nothing).
  //   - mixed (some succeeded, some failed) → throw "N failed; M
  //     succeeded" (partial; CI still sees non-zero so the
  //     pipeline can re-run after the operator addresses the
  //     per-client warnings emitted above).
  //
  // Skipped under dry-run (no writes attempted) and on the
  // pure-decline path (planned has writes but operator declined
  // every prompt — that's a deliberate operator action, not a
  // failure).
  if (!dryRun) {
    const allFailures: { name: string; error: string }[] = [
      ...Array.from(classifyFailed).map((name) => ({ name, error: 'classify failed' })),
      ...writeFailures,
    ];
    if (allFailures.length > 0) {
      const successfulWrites = writes.length - writeFailures.length;
      const lines = allFailures.map((f) => `  - ${f.name}: ${f.error}`).join('\n');
      if (successfulWrites === 0) {
        throw new Error(
          `No client configs updated. ${allFailures.length} client(s) failed:\n${lines}`,
        );
      }
      throw new Error(
        `${allFailures.length} client(s) failed to register; ${successfulWrites} succeeded:\n${lines}\nReview the warnings above and re-run \`dkg mcp setup\` after resolving the issues.`,
      );
    }
  }

  // ── Step 5: optional verification ─────────────────────────────────
  // Probe the daemon's `/api/status` to confirm it's healthy on the
  // effective port. Cheap reachability check; if the daemon is up but
  // misconfigured (auth, etc.) the probe still passes — deeper checks
  // are out of scope for setup.
  if (shouldVerify && !dryRun && shouldStart) {
    try {
      // F26: same hang-bound as the funding-step reachability probe.
      // A partially-up daemon must not block setup completion.
      const res = await fetch(`http://127.0.0.1:${effectivePort}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        console.log(`\n[setup] Daemon healthy at http://127.0.0.1:${effectivePort}.`);
      } else {
        console.warn(`\n[setup] Daemon responded with HTTP ${res.status} at http://127.0.0.1:${effectivePort}.`);
      }
    } catch (err: any) {
      console.warn(`\n[setup] Verification probe failed: ${err?.message ?? err}`);
    }
  }

  // ── Final hint ────────────────────────────────────────────────────
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart your MCP-aware client (Cursor / Claude Code) so it picks up the new server.');
  console.log('  2. From inside the client, ask "what tools does dkg expose?" — you should see');
  console.log('     dkg_assertion_create, dkg_assertion_write, dkg_assertion_query, and friends.');
  console.log('');
  } finally {
    // Codex Round-3 Fix 3: restore the prior `DKG_HOME` (or unset
    // if it wasn't set going in). Runs on both throw and normal
    // exit so the env mutation is bounded to the action's body.
    if (previousDkgHome !== undefined) process.env.DKG_HOME = previousDkgHome;
    else delete process.env.DKG_HOME;
  }
}

export { expandHome };
