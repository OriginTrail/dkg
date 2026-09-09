import { detectClients, tildify, clientSkillPath, type ClientTarget } from './mcp-client-registry.js';
import { readRegistration, classifyRegistration, writeRegistration, type DesiredRegistration, type RegistrationRead } from './mcp-client-config.js';
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
 * `servers.dkg` instead. The `format` + `serverContainer` fields on
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
import { renderStandaloneDkgNodeSkill } from './skill-template.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { resolveSetupNetworkName } from '@origintrail-official/dkg-core';
import {
  assertSelectableNetwork,
  resolveKnownNetworkConfigName,
  type DkgConfig,
} from './config.js';

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
  /**
   * Network overlay to set up on (mainnet-gnosis | mainnet-base | testnet).
   * Persisted as config.networkConfig; a fresh node defaults to
   * mainnet-gnosis. Mirrors `dkg init --network`.
   */
  network?: string;
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
  /** Canonical persisted-config network resolver, injectable for tests. */
  resolveKnownNetworkConfigName: typeof resolveKnownNetworkConfigName;
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
  /**
   * Eagerly creates the node's operational wallets (generate-if-absent)
   * before the daemon starts, so faucet funding (testnet) and manual mainnet
   * funding have wallets to target even if the daemon never fully boots.
   * Idempotent. From `@origintrail-official/dkg-agent`; injectable for tests.
   */
  loadOpWallets: typeof import('@origintrail-official/dkg-agent').loadOpWallets;
  /**
   * Shared best-effort faucet orchestrator — the SAME one openclaw/hermes use.
   * Reads `wallets.json` (with retry when the daemon was started this run),
   * gates on `network.faucet.url`, calls the faucet, and logs manual curl
   * instructions on failure. Non-throwing. From `@origintrail-official/dkg-core`.
   */
  fundWalletsBestEffort: typeof import('@origintrail-official/dkg-core').fundWalletsBestEffort;
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
      const verb = { register: 'Register', refresh: 'Refresh' }[p.action];
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

type RegistrationState = 'registered' | 'stale' | 'not-registered';

interface ClientState {
  target: ClientTarget;
  state: RegistrationState;
  current: RegistrationRead;
}

function classify(
  target: ClientTarget,
  expected: DesiredRegistration,
): ClientState {
  const current = readRegistration(target);
  return { target, state: classifyRegistration(current, expected), current };
}

/**
 * RFC-41 §4.5: explicit SKILL.md delivery into skill-discovery
 * directories of MCP-aware clients that don't walk `node_modules`.
 *
 * Cursor scans `~/.cursor/skills/<skill>/SKILL.md`; Claude Code
 * scans `~/.claude/skills/<skill>/SKILL.md`. Neither walks the
 * `node_modules` tree where the bundled SKILL.md ships inside the
 * `@origintrail-official/dkg` npm package. So `dkg mcp setup`
 * explicitly copies the bundled file into each client's
 * user-level skill directory at registration time.
 *
 * Returns the absolute path written, or `null` if this client
 * doesn't support skill delivery (the table maps Cursor + Claude
 * Code to fixed destinations; other client targets get `null`
 * and the caller skips the copy step).
 */

/**
 * Copy the bundled SKILL.md into the per-client skills directory if
 * one applies. Idempotent — a re-run with the same bundled content
 * overwrites with identical bytes (Cursor / Claude Code re-read on
 * launch, so updates land on the next client restart).
 *
 * Errors are non-fatal: a write failure here logs a warning and
 * returns — the MCP registration that triggered this copy already
 * succeeded, and skill delivery is a best-effort enhancement.
 * Operators can fall back to `GET /api/skills` from the daemon, or
 * `dkg mcp setup --force` re-runs.
 *
 * Returns the absolute path written, or `null` if no skill delivery
 * was attempted (client doesn't support it, or the write failed).
 */
function deliverSkillToClient(target: ClientTarget): string | null {
  const home = homedir();
  const skillPath = clientSkillPath(target.id, home);
  if (!skillPath) return null;
  try {
    const skillContent = renderStandaloneDkgNodeSkill();
    const skillDir = dirname(skillPath);
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, skillContent);
    return skillPath;
  } catch (err: any) {
    process.stderr.write(
      `[setup] WARNING: SKILL.md delivery to ${target.name} (${tildify(skillPath)}) ` +
        `failed (${err?.message ?? err}); the MCP server registration still applied. ` +
        `Re-run \`dkg mcp setup\` after resolving the issue, or use GET /api/skills as a fallback.\n`,
    );
    return null;
  }
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
  // Reject an unknown / pre-deployment `--network` value up front (parity
  // with the openclaw/hermes setup actions) rather than FATAL-ing at boot.
  await assertSelectableNetwork(opts.network);

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
  const entryArgs = expectedEntry.args.join(' ');
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

  // Resolve the target network once (explicit --network wins; else keep an
  // existing node's networkConfig; else fresh→mainnet-gnosis, legacy→testnet)
  // and reuse it for both the config write and the faucet gate, so the
  // persisted selector, the loaded network slice, and the faucet decision
  // (mainnet has no faucet) all agree.
  type LoadedNetworkConfig = ReturnType<McpSetupActionDeps['loadNetworkConfig']>;
  const loadedNetworks = new Map<string, LoadedNetworkConfig>();
  const loadSetupNetworkConfig = (name: string): LoadedNetworkConfig => {
    const cached = loadedNetworks.get(name);
    if (cached !== undefined) return cached;
    const network = deps.loadNetworkConfig(name);
    loadedNetworks.set(name, network);
    return network;
  };

  const persistedNodeConfig = readPersistedConfig(dkgDirPath) as
    | Pick<DkgConfig, 'networkConfig' | 'chain'>
    | undefined;
  const existingNetworkConfig = deps.resolveKnownNetworkConfigName(persistedNodeConfig);
  // `--network` is honored only for a FRESH node (existing nodes keep their
  // current network; switch via `dkg init --network`). Dropping it on an
  // existing node keeps the faucet decision aligned with the booted network
  // (the config-write is already skipped for an unchanged existing node).
  const explicitNetwork = configExists ? undefined : opts.network;
  const setupNetworkConfigName = resolveSetupNetworkName({
    explicit: explicitNetwork,
    existingNetworkConfig,
    configExisted: configExists,
  });
  const requestedNetwork = opts.network?.trim();
  if (configExists && requestedNetwork && requestedNetwork !== setupNetworkConfigName) {
    const current = existingNetworkConfig
      ? `is already configured for "${setupNetworkConfigName}"`
      : `has no explicit network (defaults to "${setupNetworkConfigName}")`;
    console.log(
      `[setup] --network ${requestedNetwork} ignored: this node ${current}. ` +
      'Use `dkg init --network` to switch an existing node.',
    );
  }

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
      const network = loadSetupNetworkConfig(setupNetworkConfigName);
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
        networkConfigName: setupNetworkConfigName,
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

  // Ensure the node's wallets exist BEFORE starting the daemon — matching
  // `dkg init` — so faucet funding (testnet) and manual mainnet funding have
  // wallets to target even if the daemon never fully boots. Runs OUTSIDE the
  // config-write skip-gate above (an existing node can still lack wallets) and
  // regardless of `--no-fund` (mainnet has no faucet but still needs wallets).
  // Best-effort; the daemon's boot-time loadOpWallets is an idempotent fallback.
  if (!dryRun) {
    try {
      await deps.loadOpWallets(dkgDirPath);
    } catch (err: any) {
      console.warn(`[setup] Could not pre-create wallets (${err?.message ?? err}); the daemon will generate them on first start.`);
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
  // Delegates to the SAME shared orchestrator as `dkg openclaw setup` /
  // `dkg hermes setup` (`fundWalletsBestEffort`) instead of a bespoke
  // `/api/status` reachability probe. The old probe gated funding on a 2s
  // `GET /api/status` responding — which routinely times out on a real
  // testnet node (peers + store make `/api/status` slow), so funding was
  // silently skipped even though wallets and a faucet existed. The
  // orchestrator needs only `wallets.json` (eager-created above, issue #1306)
  // + a `network.faucet.url`; it reads wallets with retry when the daemon was
  // started this run (so a freshly-flushed wallets.json is picked up), gates
  // on the faucet, calls it, and logs manual `curl` instructions on failure.
  // Funding is non-fatal — `fundWalletsBestEffort` never throws, so the outer
  // try/catch only guards the `loadNetworkConfig` lookup.
  //
  // The `--no-start + already-running daemon → fund` goal (F14) is preserved:
  // funding no longer depends on a reachability probe, only on wallets.json
  // existing — which it does whether the daemon ran this invocation, a prior
  // one, or the #1306 eager-create produced it.
  if (!shouldFund) {
    console.log('[setup] Skipping wallet funding (--no-fund)');
  } else if (dryRun) {
    console.log('[setup] [dry-run] Would attempt wallet funding');
  } else {
    try {
      const network = loadSetupNetworkConfig(setupNetworkConfigName);
      await deps.fundWalletsBestEffort({
        network,
        idempotencySeed: effectiveAgentName,
        didStartDaemon: shouldStart,
      });
    } catch (err: any) {
      console.warn(`[setup] Faucet step skipped: ${err?.message ?? err}`);
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
      return { target: c, state: 'not-registered', current: { kind: 'absent' } };
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
        // RFC-41 §4.5: explicit SKILL.md delivery for Cursor + Claude Code,
        // which don't walk node_modules for skill discovery. Returns null
        // for clients that don't support skill delivery; logs a warning
        // on failure but doesn't fail the MCP registration that just succeeded.
        const skillPath = deliverSkillToClient(s.target);
        if (skillPath) {
          console.log(`    └─ SKILL.md copied to ${tildify(skillPath)}`);
        }
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
      // Bound the health probe with a 2s timeout so a partially-up daemon
      // (port bound but unresponsive) can't block setup completion.
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
  console.log('     dkg_knowledge_asset_create, dkg_knowledge_asset_write, dkg_knowledge_asset_query, and friends.');
  console.log('');
  } finally {
    // Codex Round-3 Fix 3: restore the prior `DKG_HOME` (or unset
    // if it wasn't set going in). Runs on both throw and normal
    // exit so the env mutation is bounded to the action's body.
    if (previousDkgHome !== undefined) process.env.DKG_HOME = previousDkgHome;
    else delete process.env.DKG_HOME;
  }
}
