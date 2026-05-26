/**
 * `dkg migrate-to-npm` — convert a git-checkout install into an
 * npm-style install in place.
 *
 * # Why this exists
 *
 * The incident driver: operators (e.g. beacon-01) historically installed
 * by `git clone`-ing the repo into `~/dkg-v9/` and running the CLI from
 * `~/dkg-v9/packages/cli/dist/cli.js`. The daemon's auto-updater then
 * detects this as a "monorepo" install (`isStandaloneInstall() === false`)
 * and routes future updates through the build-from-source path
 * (`performUpdate`) rather than the npm path (`performNpmUpdate`).
 *
 * Build-from-source is fragile in long-running daemons: it runs `tsc` +
 * dependent build steps on every update, exposes the daemon to any
 * regression that lands on the tracked branch (rc.10's PR #639 triggered
 * the shutdown deadlock this way), and is harder to pin to a known-good
 * version. The npm path installs a pre-built artifact pinned to a
 * specific version, which is what production cores should run.
 *
 * # What the script actually does (and what it doesn't)
 *
 * **Load-bearing change**: rename `<repoRoot>/package.json` so that
 * `findPackageRepoDir` (in `packages/core/src/blue-green.ts`) can no
 * longer find the marker pair `package.json + packages/` and stops
 * treating this directory as a monorepo root. `isStandaloneInstall()`
 * then returns `true` on next boot, and the auto-updater routes through
 * `performNpmUpdate`.
 *
 * **Note (correction vs the original plan):** the plan said `.git` was
 * the marker. It is NOT — the walker uses `package.json + packages/`
 * presence. Renaming `.git` is cosmetic-only; we still do it because
 * (a) it eliminates operator confusion ("git layout means I should
 * `git pull` to update", which is exactly the failure mode we're fixing),
 * and (b) it prevents stray cron jobs or CI that walk for `.git`.
 *
 * **Forward-compat change**: write `autoUpdate.source = "npm"` into
 * `~/.dkg/config.json`. Until PR-2 (#659) lands this is silently ignored
 * by the daemon, BUT once it merges this becomes the load-bearing pin
 * (the rename becomes belt-and-braces). Writing both keeps the script
 * correct across the merge boundary.
 *
 * # What we DON'T touch
 *
 *   - `packages/` and `packages/cli/dist/` — the operator's `dkg` PATH
 *     symlink typically points into this tree. Renaming would break the
 *     ability to invoke `dkg` at all until they `npm install -g`. The
 *     runbook documents that follow-up step.
 *   - `node_modules/` and `pnpm-lock.yaml` — same reason; the current
 *     `packages/cli/dist/cli.js` runtime resolves modules from here.
 *   - The blue-green slot tree under `~/.dkg/releases/{a,b}/` — that's
 *     state, not source-tree.
 *
 * # State-directory orphan detection
 *
 * `resolveDkgConfigHome()` returns `~/.dkg-dev` in monorepo layout (when
 * `~/.dkg/config.json` doesn't already exist), and `~/.dkg` otherwise.
 * Post-migration the walker returns null, so the same call resolves to
 * `~/.dkg`. If the operator's actual state lives in `~/.dkg-dev`, the
 * CLI would silently read from a different (likely empty) directory
 * after migration — looking like a fresh install with no agents, no
 * decryption keys, nothing. We hard-refuse in that case with an
 * actionable error pointing at the manual remediation.
 *
 * Beacon-01 uses `~/.dkg` (operator opted in pre-dkg-dev split), so the
 * common case for the incident-driver hosts goes through cleanly.
 */

import { existsSync } from 'node:fs';
import { rename, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import {
  isDkgMonorepoRoot,
  resolveDkgConfigHome,
} from '@origintrail-official/dkg-core';

export type MigrationActionKind = 'rename' | 'config-write';
type ConfigFormat = 'json' | 'yaml';

export interface RenameAction {
  kind: 'rename';
  from: string;
  to: string;
  /**
   * `true` if this rename is required for the migration to take effect.
   * `false` if it's cosmetic / safety-net cleanup. The dry-run output
   * surfaces this distinction so the operator sees what's actually
   * load-bearing.
   */
  loadBearing: boolean;
  /** One-line operator-readable justification for the action. */
  reason: string;
}

export interface ConfigWriteAction {
  kind: 'config-write';
  /** Path of the config file we'll edit. */
  configPath: string;
  /** Preserve the active config format for yaml-only installs. */
  configFormat: ConfigFormat;
  /** Dotted path within the config object, e.g. `autoUpdate.source`. */
  key: string;
  value: unknown;
  reason: string;
}

export type MigrationAction = RenameAction | ConfigWriteAction;

export interface MigrationPlan {
  /** Steps the operator would execute on `--apply`. */
  actions: MigrationAction[];
  /** Non-fatal observations the operator should read before applying. */
  warnings: string[];
  /**
   * Conditions that make `--apply` unsafe. Non-empty `blockers` means
   * the script will refuse to mutate even with `--apply`. Operator must
   * resolve manually (or override with `--force` for the alive-check
   * blocker only).
   */
  blockers: string[];
  /**
   * `true` when the source tree is already in standalone-style layout.
   * The plan in this case has zero actions and zero blockers; idempotent
   * re-run is a no-op success.
   */
  alreadyMigrated: boolean;
}

export interface BuildPlanOpts {
  repoRoot: string;
  /** Suffix for backup renames, e.g. timestamp string. Operator-readable. */
  backupSuffix: string;
  /**
   * Where state currently lives — what `dkgDir()` resolves to RIGHT NOW.
   * Used for the orphan-detection blocker.
   */
  dkgHomeNow: string;
  /**
   * Where state WOULD live after migration — what `dkgDir()` would
   * resolve to after the walker returns null. For the orphan check.
   */
  dkgHomePostMigration: string;
  /**
   * Result of `readPid()` + `isProcessRunning(pid)`. Decoupled from FS
   * so the plan-builder stays pure.
   */
  daemonAlive: boolean;
  /**
   * `true` when the operator passes `--force`. Causes the alive blocker
   * to downgrade to a warning rather than block apply.
   */
  forceAliveBypass: boolean;
  /**
   * Current value of `autoUpdate.source` in the config. When already
   * `'npm'`, the config-write action is skipped.
   */
  currentAutoUpdateSource: 'npm' | 'git' | 'auto' | undefined;
  /** Override for `existsSync` — injected by tests. */
  exists?: (path: string) => boolean;
}

const SOURCE_TREE_ARTIFACTS_LOAD_BEARING: ReadonlyArray<{
  name: string;
  reason: string;
}> = [
  {
    name: 'package.json',
    // The walker (packages/core/src/blue-green.ts:findPackageRepoDir)
    // requires BOTH `package.json` AND `packages/` to call a directory a
    // monorepo root. Renaming `package.json` is sufficient to break the
    // walker; we leave `packages/` because the operator's dkg PATH
    // symlink typically points into it.
    reason: 'breaks isStandaloneInstall() walker; required to flip auto-update to npm path',
  },
];

const SOURCE_TREE_ARTIFACTS_COSMETIC: ReadonlyArray<{
  name: string;
  reason: string;
}> = [
  {
    name: '.git',
    reason: 'cosmetic — eliminates operator confusion ("git layout means git pull to update")',
  },
];

const DKG_HOME_STATE_MARKERS = [
  'config.json',
  'config.yaml',
  'daemon.pid',
  'api.port',
  'auth.token',
  'data',
  'releases',
] as const;

function resolveConfigWriteTarget(
  dkgHome: string,
  exists: (path: string) => boolean,
): { path: string; format: ConfigFormat } {
  const jsonPath = join(dkgHome, 'config.json');
  if (exists(jsonPath)) return { path: jsonPath, format: 'json' };
  const yamlPath = join(dkgHome, 'config.yaml');
  if (exists(yamlPath)) return { path: yamlPath, format: 'yaml' };
  return { path: jsonPath, format: 'json' };
}

function hasDkgHomeState(dkgHome: string, exists: (path: string) => boolean): boolean {
  return DKG_HOME_STATE_MARKERS.some((marker) => exists(join(dkgHome, marker)));
}

/**
 * Pure plan-builder. Inspects the source tree, produces an action list
 * + blocker list + warnings without touching the filesystem.
 *
 * The returned plan is what `--dry-run` (default) prints. `--apply`
 * passes the same plan to `applyPlan()`.
 */
export function buildMigrationPlan(opts: BuildPlanOpts): MigrationPlan {
  const exists = opts.exists ?? existsSync;
  const actions: MigrationAction[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  const loadBearingPresent = SOURCE_TREE_ARTIFACTS_LOAD_BEARING.some((a) =>
    exists(join(opts.repoRoot, a.name)),
  );
  const cosmeticPresent = SOURCE_TREE_ARTIFACTS_COSMETIC.some((a) =>
    exists(join(opts.repoRoot, a.name)),
  );

  if (opts.dkgHomeNow !== opts.dkgHomePostMigration && hasDkgHomeState(opts.dkgHomeNow, exists)) {
    // Classic orphan case: state in ~/.dkg-dev, post-migration the CLI
    // looks at ~/.dkg. Hard refuse — no `--force` override; this one is
    // genuinely unsafe.
    const remediation = exists(opts.dkgHomePostMigration)
      ? `Destination ${opts.dkgHomePostMigration} already exists; do not run a plain \`mv\`. ` +
        `Merge/copy the state from ${opts.dkgHomeNow} into ${opts.dkgHomePostMigration} manually, ` +
        `or set \`DKG_HOME=${opts.dkgHomeNow}\` permanently in your shell rc and re-run.`
      : `Run \`mv ${opts.dkgHomeNow} ${opts.dkgHomePostMigration}\` BEFORE re-running this command, ` +
        `or set \`DKG_HOME=${opts.dkgHomeNow}\` permanently in your shell rc and re-run.`;
    blockers.push(
      `state-directory orphan risk: state currently lives in ${opts.dkgHomeNow}, ` +
        `but post-migration the CLI would resolve to ${opts.dkgHomePostMigration}. ` +
        remediation,
    );
  }

  if (
    !loadBearingPresent &&
    !cosmeticPresent &&
    opts.currentAutoUpdateSource === 'npm' &&
    blockers.length === 0
  ) {
    // Codex review (3301781920): only short-circuit when the config pin
    // is explicitly `npm`. An `undefined` source on a partially-migrated
    // tree (markers gone, but the previous run died before writing the
    // pin) needs the config-write action to finish the repair, even
    // though the markers are absent.
    return { actions: [], warnings: [], blockers: [], alreadyMigrated: true };
  }

  if (opts.daemonAlive) {
    const msg = `daemon is alive — refusing to mutate the source tree while a worker process holds files open`;
    if (opts.forceAliveBypass) {
      warnings.push(
        `${msg}. --force was passed: proceeding anyway. Operator must SIGKILL the worker FIRST or accept that any in-flight write may be lost.`,
      );
    } else {
      blockers.push(`${msg}. Stop the daemon (\`dkg stop\` or \`kill -9 <pid>\`) then re-run, or pass --force to bypass.`);
    }
  }

  for (const artifact of SOURCE_TREE_ARTIFACTS_LOAD_BEARING) {
    const from = join(opts.repoRoot, artifact.name);
    if (!exists(from)) continue;
    actions.push({
      kind: 'rename',
      from,
      to: `${from}.pre-npm-migration-${opts.backupSuffix}`,
      loadBearing: true,
      reason: artifact.reason,
    });
  }

  for (const artifact of SOURCE_TREE_ARTIFACTS_COSMETIC) {
    const from = join(opts.repoRoot, artifact.name);
    if (!exists(from)) continue;
    actions.push({
      kind: 'rename',
      from,
      to: `${from}.pre-npm-migration-${opts.backupSuffix}`,
      loadBearing: false,
      reason: artifact.reason,
    });
  }

  if (opts.currentAutoUpdateSource !== 'npm') {
    const configTarget = resolveConfigWriteTarget(opts.dkgHomeNow, exists);
    actions.push({
      kind: 'config-write',
      configPath: configTarget.path,
      configFormat: configTarget.format,
      key: 'autoUpdate.source',
      value: 'npm',
      reason:
        'forward-compat with PR-2 (#659): once that lands, this pin makes the npm path explicit ' +
        'rather than relying on the auto-detect fallback. Silently ignored until then.',
    });
  }

  return { actions, warnings, blockers, alreadyMigrated: false };
}

/**
 * Apply a plan returned by `buildMigrationPlan`. Caller is responsible
 * for refusing to apply if `plan.blockers.length > 0` (the CLI command
 * does this; tests verify both behaviours).
 *
 * Renames are done in declaration order. Config writes happen last so
 * that if a rename throws, the config isn't left pointing at a
 * still-existing source tree (which would be a confusing post-mortem
 * state — partially renamed AND config-flipped).
 */
export async function applyPlan(
  plan: MigrationPlan,
  log: (msg: string) => void,
  io: ApplyPlanIo = defaultApplyPlanIo,
): Promise<void> {
  if (plan.blockers.length > 0) {
    throw new Error(
      `applyPlan called with ${plan.blockers.length} blocker(s) present — caller should have refused before invoking. Blockers: ${plan.blockers.join('; ')}`,
    );
  }
  for (const action of plan.actions) {
    if (action.kind === 'config-write') {
      await validateConfigKeyWrite(action.configPath, action.key, action.configFormat, io);
    }
  }
  for (const action of plan.actions) {
    if (action.kind === 'rename') {
      log(`renaming ${action.from} → ${action.to}`);
      await io.rename(action.from, action.to);
    }
  }
  for (const action of plan.actions) {
    if (action.kind === 'config-write') {
      log(`writing ${action.key}=${JSON.stringify(action.value)} → ${action.configPath}`);
      await writeConfigKey(action.configPath, action.key, action.value, action.configFormat, io);
    }
  }
}

export interface ApplyPlanIo {
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export const defaultApplyPlanIo: ApplyPlanIo = {
  rename: (from, to) => rename(from, to),
  async readFile(path) {
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return null;
      throw err;
    }
  },
  writeFile: (path, contents) => writeFile(path, contents),
  mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConfigObject(raw: string | null, configPath: string, format: ConfigFormat): Record<string, unknown> {
  if (!raw) return {};
  const parsed = format === 'yaml' ? yaml.load(raw) : JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${configPath} must contain a config object`);
  }
  return parsed;
}

async function validateConfigKeyWrite(
  configPath: string,
  dottedKey: string,
  format: ConfigFormat,
  io: ApplyPlanIo,
): Promise<void> {
  const segments = dottedKey.split('.');
  const parsed = parseConfigObject(await io.readFile(configPath), configPath, format);
  if (segments.length === 2 && parsed[segments[0]] !== undefined && !isRecord(parsed[segments[0]])) {
    throw new Error(`${configPath} key ${segments[0]} must be an object before writing ${dottedKey}`);
  }
}

/**
 * Read `configPath` (or treat as empty object if missing), set the dotted key,
 * and write back in the same active format. Keeps yaml-only operators on YAML
 * instead of creating a new JSON file that would shadow their existing config.
 *
 * Only supports two-segment keys (`autoUpdate.source`) because that's
 * all this migration writes. Deeper-nesting support is YAGNI — add when
 * the second writer needs it.
 */
async function writeConfigKey(
  configPath: string,
  dottedKey: string,
  value: unknown,
  format: ConfigFormat,
  io: ApplyPlanIo,
): Promise<void> {
  const segments = dottedKey.split('.');
  if (segments.length === 0 || segments.length > 2) {
    throw new Error(`writeConfigKey only supports 1- or 2-segment keys; got ${dottedKey}`);
  }
  const existing = await io.readFile(configPath);
  const parsed = parseConfigObject(existing, configPath, format);
  if (segments.length === 1) {
    parsed[segments[0]] = value;
  } else {
    const topValue = parsed[segments[0]] ?? {};
    if (!isRecord(topValue)) {
      throw new Error(`${configPath} key ${segments[0]} must be an object before writing ${dottedKey}`);
    }
    const top = topValue;
    top[segments[1]] = value;
    parsed[segments[0]] = top;
  }
  await io.mkdir(dirname(configPath));
  const rendered = format === 'yaml'
    ? yaml.dump(parsed, { noRefs: true, lineWidth: 120 })
    : JSON.stringify(parsed, null, 2) + '\n';
  await io.writeFile(configPath, rendered);
}

/**
 * Operator-facing dry-run renderer. Centralised so the CLI command
 * stays a thin shell and the format can be regression-tested.
 */
export function renderPlan(plan: MigrationPlan): string {
  if (plan.alreadyMigrated) {
    return 'Already migrated: no source-tree markers found and config is at autoUpdate.source = "npm".\n';
  }

  const lines: string[] = [];
  lines.push('Migration plan (dry run; pass --apply to execute):');
  lines.push('');

  if (plan.actions.length === 0) {
    lines.push('  (no actions)');
  }
  for (const action of plan.actions) {
    if (action.kind === 'rename') {
      const tag = action.loadBearing ? '[LOAD-BEARING]' : '[cosmetic]   ';
      lines.push(`  ${tag} rename ${action.from}`);
      lines.push(`                  → ${action.to}`);
      lines.push(`                  reason: ${action.reason}`);
    } else {
      lines.push(`  [CONFIG]      set ${action.key} = ${JSON.stringify(action.value)}`);
      lines.push(`                  in ${action.configPath}`);
      lines.push(`                  reason: ${action.reason}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of plan.warnings) lines.push(`  ⚠ ${w}`);
  }

  if (plan.blockers.length > 0) {
    lines.push('');
    lines.push('Blockers (must be resolved before --apply will run):');
    for (const b of plan.blockers) lines.push(`  ✗ ${b}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Walk up from `startDir` looking for a DKG monorepo root.
 *
 * Used by `dkg migrate-to-npm` when the executing CLI is a globally
 * installed binary (so `repoDir()` resolves from `node_modules` and
 * returns `null`) but the operator is `cd`-ed into the checkout they
 * want to migrate. Without this fallback the command never finds the
 * load-bearing top-level `package.json` to rename (Codex 3300428735).
 *
 * The default `isMonorepo` predicate is `isDkgMonorepoRoot` from core,
 * which checks structural markers (`pnpm-workspace.yaml`, `packages/`,
 * `project.json`) plus the canonical `packages/cli/package.json` name
 * `@origintrail-official/dkg`. Tests inject a custom predicate so they
 * don't need on-disk fixtures.
 */
export function findDkgMonorepoRootFromCwd(
  startDir: string,
  isMonorepo: (dir: string) => boolean = isDkgMonorepoRoot,
): string | null {
  let cur = startDir;
  for (;;) {
    if (isMonorepo(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Resolve the DKG home the migration should read/write FROM (i.e. the
 * one the live CLI is currently using).
 *
 * Codex review (3302171976): basing this on `isDkgMonorepoRoot(repoRoot)`
 * is wrong on a partially-migrated checkout. After the load-bearing
 * `package.json` rename the structural monorepo markers
 * (`pnpm-workspace.yaml`, `project.json`, `packages/cli/package.json`)
 * remain, so `isDkgMonorepoRoot` still returns true. But `repoDir()`
 * in the live CLI now returns `null` (the rename broke
 * `findPackageRepoDir`'s `package.json + packages/` check), so the
 * running daemon and CLI read `~/.dkg`. If the migration command keeps
 * resolving to `~/.dkg-dev` based on the structural markers, it
 * "fixes" a config the daemon never reads.
 *
 * We mirror the live CLI's view instead: when `repoDir()` returned a
 * concrete path the install is still in monorepo mode (and uses
 * `~/.dkg-dev`); when it's `null` the install is standalone (uses
 * `~/.dkg`), regardless of what walking-up-from-cwd found.
 */
export function resolveMigrationDkgHome(opts: {
  detectedRepoRoot: string | null;
  homeDir: string;
  /** Test override forwarded to `resolveDkgConfigHome` to bypass DKG_HOME. */
  env?: Pick<NodeJS.ProcessEnv, 'DKG_HOME'>;
  /** Test override forwarded to `resolveDkgConfigHome` to bypass on-disk state. */
  configExists?: boolean;
}): string {
  return resolveDkgConfigHome({
    isDkgMonorepo: opts.detectedRepoRoot !== null,
    homeDir: opts.homeDir,
    env: opts.env,
    configExists: opts.configExists,
  });
}
