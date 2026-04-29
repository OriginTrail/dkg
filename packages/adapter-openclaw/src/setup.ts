/**
 * Non-interactive setup script for the DKG OpenClaw adapter.
 *
 * Handles the entire DKG node + adapter setup end-to-end:
 *  1. Discover OpenClaw workspace
 *  2. Discover agent name
 *  3. Write ~/.dkg/config.json with testnet defaults
 *  4. Preflight ~/.openclaw/openclaw.json (exists / parseable / writable /
 *     not wrong-slot-wired) so deterministic setup errors fail fast
 *     before daemon start and the faucet call burn resources
 *  5. Start the DKG daemon
 *  6. Read wallets and fund the first three via the testnet faucet
 *     (skippable with `--no-fund`; non-fatal on failure)
 *  7. Copy the canonical DKG node skill into the OpenClaw workspace
 *  8. Merge adapter plugin into ~/.openclaw/openclaw.json (including
 *     plugins.entries.adapter-openclaw.config with feature flags)
 *  9. Verify setup
 *
 * Every step is idempotent — re-running is safe.
 */

import { execSync, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { requestFaucetFunding } from '@origintrail-official/dkg-core';
import type { DkgOpenClawConfig } from './types.js';
import { resolveDkgCli } from './resolve-dkg-cli.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  workspace?: string;
  name?: string;
  port?: string;
  verify?: boolean;
  start?: boolean;
  dryRun?: boolean;
  /**
   * Fund the first three node wallets via the testnet faucet on first setup.
   * Defaults to `true`; the adapter treats `fund === false` (set by
   * `--no-fund`) as the only opt-out. Faucet failures are non-fatal — a
   * failed call logs manual `curl` instructions and setup continues.
   */
  fund?: boolean;
  /**
   * Abort signal for cooperative cancellation. Checked at each step boundary
   * so an aborted job stops between steps without further filesystem writes
   * — matches the granularity of the previous child-process SIGKILL model.
   * Long-running sync calls (e.g. `execSync('dkg start', ...)`) are not
   * interrupted mid-call; cancellation takes effect before the next step.
   */
  signal?: AbortSignal;
}

interface NetworkConfig {
  networkName: string;
  relays: string[];
  defaultContextGraphs: string[];
  /** @deprecated Legacy key in older network config files */
  defaultParanets?: string[];
  defaultNodeRole: string;
  autoUpdate?: {
    enabled: boolean;
    repo: string;
    branch: string;
    checkIntervalMinutes: number;
  };
  chain?: {
    type: string;
    rpcUrl: string;
    hubAddress: string;
    chainId: string;
  };
  faucet?: {
    url: string;
    mode: string;
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(`[setup] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[setup] WARNING: ${msg}`);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Root of the adapter package, derived from the script's own location.
 * This is always correct for the currently running code — no global install
 * resolution, no version comparison, no npm prefix lookups.
 */
function adapterRoot(): string {
  const root = resolve(__dirname, '..');
  if (existsSync(join(root, 'package.json'))) return root;
  return __dirname;
}

/**
 * Check whether an adapter path looks ephemeral (npx cache).
 * Npx cache paths typically contain `_npx` or a temp directory marker.
 */
function isEphemeralPath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/');
  return normalized.includes('/_npx/') || normalized.includes('\\_npx\\');
}

function dkgDir(): string {
  return process.env.DKG_HOME ?? join(homedir(), '.dkg');
}

function openclawDir(): string {
  return process.env.OPENCLAW_HOME ?? join(homedir(), '.openclaw');
}

/**
 * Resolve the `openclaw.json` config path, honoring `OPENCLAW_HOME` the same
 * way `runSetup()` does. Exported so out-of-process callers (e.g. the DKG
 * daemon's post-setup invariant check and disconnect handler in
 * `packages/cli/src/daemon.ts`) read the same file that `mergeOpenClawConfig`
 * writes to; hardcoding `join(homedir(), '.openclaw', 'openclaw.json')` on the
 * daemon side caused false slot-election failures when the user set
 * `OPENCLAW_HOME` to a non-default location.
 */
export function openclawConfigPath(): string {
  return join(openclawDir(), 'openclaw.json');
}

function canonicalWorkspaceSkillPath(workspaceDir: string): string {
  return join(workspaceDir, 'skills', 'dkg-node', 'SKILL.md');
}

// ---------------------------------------------------------------------------
// Step 1: Discover OpenClaw workspace
// ---------------------------------------------------------------------------

/**
 * Pure resolver for the workspace directory from an already-parsed
 * openclaw.json object. Shared between `discoverWorkspace` (setup / install
 * path) and the daemon's Disconnect path so install + removal agree on
 * exactly the same target directory.
 *
 * Resolution rules (matching `discoverWorkspace` semantics):
 *   1. Priority order across the three known keys:
 *      `agents.defaults.workspace` → `workspace` → `workspaceDir`.
 *      First non-empty string wins.
 *   2. Leading `~` is expanded to `homedir()`.
 *   3. Relative paths are resolved against `dirname(openclawConfigPath)`,
 *      not `cwd` — so a given openclaw.json produces the same absolute
 *      workspace no matter where the process is invoked from.
 *   4. When no key is set, fall back to `dirname(openclawConfigPath)/workspace`
 *      (co-located with the config file, matching the relative-path
 *      resolution in rule 3) only if that directory exists on disk. R9-1:
 *      must NOT read the process-wide `$OPENCLAW_HOME` here — a legacy
 *      install whose openclaw.json lives at a non-default path would
 *      otherwise resolve to the default `~/.openclaw/workspace` on
 *      Disconnect and clean up (or miss) the wrong SKILL.md.
 *   5. Otherwise return `null`. Callers decide whether to throw or
 *      skip-best-effort.
 */
export function resolveWorkspaceDirFromConfig(
  config: unknown,
  openclawConfigPath: string,
): string | null {
  const cfg = (config ?? {}) as Record<string, any>;
  const candidate: unknown =
    cfg?.agents?.defaults?.workspace ??
    cfg?.workspace ??
    cfg?.workspaceDir;

  if (typeof candidate === 'string' && candidate.trim()) {
    const expanded = candidate.replace(/^~/, homedir());
    return resolve(dirname(openclawConfigPath), expanded);
  }

  const defaultWs = join(dirname(openclawConfigPath), 'workspace');
  if (existsSync(defaultWs)) return defaultWs;

  return null;
}

export function discoverWorkspace(override?: string): { configPath: string; workspaceDir: string } {
  if (override) {
    const ws = resolve(override.replace(/^~/, homedir()));
    if (!existsSync(ws)) throw new Error(`Workspace path does not exist: ${ws}`);
    if (!statSync(ws).isDirectory()) throw new Error(`Workspace path is not a directory: ${ws}`);
    return { configPath: '', workspaceDir: ws };
  }

  const configPath = join(openclawDir(), 'openclaw.json');
  if (!existsSync(configPath)) {
    throw new Error(
      `OpenClaw config not found at ${configPath}. ` +
      'Is OpenClaw installed? Use --workspace to override.',
    );
  }

  const raw = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw);

  const resolved = resolveWorkspaceDirFromConfig(config, configPath);
  if (resolved) {
    return { configPath, workspaceDir: resolved };
  }

  throw new Error(
    'Could not determine OpenClaw workspace directory. ' +
    'Set agents.defaults.workspace in openclaw.json or use --workspace.',
  );
}

// ---------------------------------------------------------------------------
// Step 2: Discover agent name
// ---------------------------------------------------------------------------

export function discoverAgentName(workspaceDir: string, override?: string): string {
  if (override) return override;

  const identityPath = join(workspaceDir, 'IDENTITY.md');
  if (existsSync(identityPath)) {
    const raw = readFileSync(identityPath, 'utf-8');
    // Look for a "Name: value" field (common IDENTITY.md format)
    for (const line of raw.split('\n')) {
      const nameMatch = line.match(/^\s*[-*]*\s*\**Name\**\s*:\s*(.+)/i);
      if (nameMatch) return nameMatch[1].trim();
    }
  }

  // Before falling back to a fresh random name, honor an already-persisted
  // `~/.dkg/config.json.name` from a prior setup run. `writeDkgConfig` uses
  // the same first-wins semantics for this field (existing.name wins unless
  // --name is passed); mirroring that here keeps re-runs on an
  // IDENTITY.md-absent workspace stable across invocations, which in turn
  // keeps the faucet `callerId` and `Idempotency-Key` stable so retries
  // don't create duplicate faucet requests.
  const persistedName = readPersistedAgentName();
  if (persistedName) {
    log(`Using persisted agent name "${persistedName}" from ${join(dkgDir(), 'config.json')}`);
    return persistedName;
  }

  // Fallback: generate a unique name
  const id = Math.random().toString(36).slice(2, 7);
  const name = `openclaw-agent-${id}`;
  warn(`Could not determine agent name from IDENTITY.md — using "${name}"`);
  return name;
}

/**
 * Read `name` from `~/.dkg/config.json` if the file exists and contains a
 * non-empty string. Missing file, unparseable JSON, or non-string `name`
 * all return `undefined` — the caller falls through to its next discovery
 * step (random fallback in `discoverAgentName`).
 */
function readPersistedAgentName(): string | undefined {
  const configPath = join(dkgDir(), 'config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (typeof raw?.name === 'string' && raw.name.trim()) {
      return raw.name.trim();
    }
  } catch {
    // Intentionally swallow — `writeDkgConfig` handles its own corruption
    // warning when the same file is unparseable; no reason to double-warn.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Step 3: Write DKG config
// ---------------------------------------------------------------------------

/**
 * Locate the `@origintrail-official/dkg` CLI package root. Probes three
 * layouts in the order they're likeliest to succeed during setup:
 *   (1) Monorepo dev checkout — `packages/cli` sibling of this adapter.
 *   (2) Local install — `./node_modules/@origintrail-official/dkg`, found
 *       via `createRequire(import.meta.url).resolve('.../package.json')`.
 *   (3) Global install — `npm prefix -g` + `[lib/]node_modules/...`.
 *
 * Returns `null` when the CLI isn't reachable; callers are responsible for
 * emitting the error message that's appropriate for the specific file they
 * were looking for (SKILL.md, testnet.json, etc.).
 */
export function resolveCliPackageDir(): string | null {
  // (1) Monorepo dev checkout — sibling `packages/cli`.
  const monorepoCandidate = resolve(adapterRoot(), '..', 'cli');
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

export function loadNetworkConfig(): NetworkConfig {
  const cliDir = resolveCliPackageDir();
  if (cliDir) {
    const candidate = join(cliDir, 'network', 'testnet.json');
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf-8'));
    }
  }

  // Monorepo pre-build fallback: the cli package copies `network/*.json`
  // from the repo root into `packages/cli/network/` during its build, so
  // before `pnpm build` has run the cli-scoped path above won't resolve.
  // Probe the repo-root `network/testnet.json` directly so the monorepo dev
  // flow (tests, scratch checkouts) keeps working pre-build.
  const monorepoPath = resolve(__dirname, '..', '..', '..', 'network', 'testnet.json');
  if (existsSync(monorepoPath)) {
    return JSON.parse(readFileSync(monorepoPath, 'utf-8'));
  }
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'network', 'testnet.json');
  if (existsSync(devPath)) {
    return JSON.parse(readFileSync(devPath, 'utf-8'));
  }

  throw new Error(
    'Could not find network/testnet.json. Ensure the DKG CLI is installed ' +
    '(npm install -g @origintrail-official/dkg).',
  );
}

export function resolveCanonicalNodeSkillSourcePath(): string {
  const cliDir = resolveCliPackageDir();
  if (cliDir) {
    const candidate = join(cliDir, 'skills', 'dkg-node', 'SKILL.md');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Could not find the canonical DKG node SKILL.md in the installed CLI package. ' +
    'Ensure @origintrail-official/dkg is installed.',
  );
}

export interface DkgConfigOverrides {
  /** True when the user explicitly passed --name. */
  nameExplicit?: boolean;
  /** True when the user explicitly passed --port. */
  portExplicit?: boolean;
}

/**
 * Strip fields under `existing.chain` and `existing.autoUpdate` whose values
 * equal the corresponding network default — those are leftovers from earlier
 * setup runs that auto-copied the whole block (the bug fixed in PR #322).
 *
 * Heuristic is safe: if an operator deliberately overrode a field, the value
 * differs from the current network default and is preserved. If the value
 * matches the default, it's either (a) an auto-copy we want to drop so future
 * rotations propagate, or (b) a coincidence where the operator picked the same
 * value — in which case dropping it is still functionally a no-op (the
 * resolver will re-derive the same value at runtime). `autoUpdate.enabled` is
 * kept regardless: status/telemetry endpoints read it directly without
 * falling back to the network value.
 */
function pruneNetworkPinnedDefaults(
  existing: Record<string, any>,
  network: NetworkConfig,
): void {
  if (existing.chain && typeof existing.chain === 'object' && network.chain) {
    for (const key of Object.keys(existing.chain) as Array<keyof NonNullable<NetworkConfig['chain']>>) {
      if (existing.chain[key] === network.chain[key]) {
        delete existing.chain[key];
      }
    }
    if (Object.keys(existing.chain).length === 0) {
      delete existing.chain;
    }
  }

  if (existing.autoUpdate && typeof existing.autoUpdate === 'object' && network.autoUpdate) {
    for (const key of Object.keys(existing.autoUpdate)) {
      if (key === 'enabled') continue;
      if (existing.autoUpdate[key] === (network.autoUpdate as any)[key]) {
        delete existing.autoUpdate[key];
      }
    }
    // Drop the parent if only `enabled` survived AND it matches the network
    // default — the dedicated `enabled`-mirroring branch below will re-add it.
    // Otherwise keep whatever the operator actually pinned (different enabled,
    // custom field we don't know about, etc.).
    const keys = Object.keys(existing.autoUpdate);
    if (
      keys.length === 0 ||
      (keys.length === 1 && keys[0] === 'enabled'
        && existing.autoUpdate.enabled === network.autoUpdate.enabled)
    ) {
      delete existing.autoUpdate;
    }
  }
}

function migrateLegacyOpenClawTransport(existing: Record<string, any>): void {
  const legacyTransport = existing.openclawChannel;
  if (!legacyTransport || typeof legacyTransport !== 'object') return;

  const bridgeUrl = typeof legacyTransport.bridgeUrl === 'string' && legacyTransport.bridgeUrl.trim()
    ? legacyTransport.bridgeUrl.trim()
    : undefined;
  const gatewayUrl = typeof legacyTransport.gatewayUrl === 'string' && legacyTransport.gatewayUrl.trim()
    ? legacyTransport.gatewayUrl.trim()
    : undefined;
  if (!bridgeUrl && !gatewayUrl) return;

  if (!existing.localAgentIntegrations || typeof existing.localAgentIntegrations !== 'object') {
    existing.localAgentIntegrations = {};
  }

  const currentOpenClaw = existing.localAgentIntegrations.openclaw && typeof existing.localAgentIntegrations.openclaw === 'object'
    ? existing.localAgentIntegrations.openclaw
    : {};
  const currentTransport = currentOpenClaw.transport && typeof currentOpenClaw.transport === 'object'
    ? currentOpenClaw.transport
    : {};

  existing.localAgentIntegrations.openclaw = {
    ...currentOpenClaw,
    transport: {
      kind: currentTransport.kind ?? 'openclaw-channel',
      ...(bridgeUrl ? { bridgeUrl } : {}),
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...currentTransport,
    },
  };
}

export function writeDkgConfig(
  agentName: string,
  network: NetworkConfig,
  apiPort: number,
  overrides?: DkgConfigOverrides,
): void {
  const dir = dkgDir();
  const configPath = join(dir, 'config.json');

  mkdirSync(dir, { recursive: true });

  // Load existing config if present — merge, don't overwrite
  let existing: Record<string, any> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
      log(`Merging into existing ${configPath}`);
    } catch {
      warn(`Could not parse existing ${configPath} — will overwrite`);
    }
  }
  migrateLegacyOpenClawTransport(existing);
  delete existing.openclawAdapter;
  delete existing.openclawChannel;

  // Heal legacy configs: earlier setup runs auto-copied the entire `chain`
  // and `autoUpdate` blocks from `network/<env>.json`. Those copies look
  // identical to operator overrides on disk via `...existing`, so a rerun
  // after a hub/RPC/branch rotation would NOT pick up the new defaults —
  // exactly the failure mode we hit on the testnet relays after the hub
  // rotated. Strip any field whose value equals the current network default
  // (= clearly a stale auto-copy, never a deliberate override). Real
  // operator customisations (e.g. private RPC) won't match a default and
  // are left intact. `autoUpdate.enabled` is kept regardless because the
  // status/telemetry consumers below depend on it being present.
  pruneNetworkPinnedDefaults(existing, network);

  // Explicit CLI overrides (--name, --port) take precedence over existing config.
  // Auto-detected values only fill in when no existing value is present.
  //
  // We intentionally do NOT persist `chain` or `autoUpdate` from
  // `network/<env>.json` into the user's config when they're absent —
  // the daemon already does field-level merging at runtime via
  // `resolveChainConfig` (cli/src/config.ts) and `resolveAutoUpdateConfig`
  // (same file, see docstring at "dkg init intentionally omits repo/branch").
  // Pinning the network defaults here would cement them and break future
  // hub rotations / branch rotations / RPC swaps in `network/<env>.json`,
  // which is exactly the failure mode we just had to fight through on the
  // testnet relay nodes after the hub address was rotated. The `...existing`
  // spread above still preserves any chain/autoUpdate the operator added
  // manually (e.g. private RPC override).
  const config: Record<string, any> = {
    ...existing,
    name: overrides?.nameExplicit ? agentName : (existing.name ?? agentName),
    apiPort: overrides?.portExplicit ? apiPort : (existing.apiPort ?? apiPort),
    nodeRole: existing.nodeRole ?? (network.defaultNodeRole as 'edge' | 'core'),
    contextGraphs: existing.contextGraphs
      ?? existing.paranets
      ?? network.defaultContextGraphs
      ?? network.defaultParanets,
    auth: existing.auth ?? { enabled: true },
  };

  // Preserve an existing relay override but never pin a new one — the daemon
  // reads the full relay list from network config (testnet.json) automatically,
  // which is better than hard-coding a single relay into the user's config.
  if (existing.relay) {
    config.relay = existing.relay;
  }

  // Persist only the `enabled` flag mirrored from the network default.
  // `repo`/`branch`/`checkIntervalMinutes`/etc. are intentionally omitted
  // (see big comment above on the resolver contract), but the `enabled`
  // flag has to stay because several consumers — `/api/status`,
  // `/api/info`, the telemetry log pusher in `lifecycle.ts`, and
  // `resolveAutoUpdateEnabled` itself — read `config.autoUpdate?.enabled`
  // directly without falling back to `network.autoUpdate.enabled`.
  // Dropping the whole block would make those report auto-update as
  // disabled on fresh testnet OpenClaw installs even though the updater
  // is in fact running.
  if (!existing.autoUpdate && network.autoUpdate?.enabled !== undefined) {
    config.autoUpdate = { enabled: network.autoUpdate.enabled };
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  log(`Wrote ${configPath} (${network.networkName}, ${config.nodeRole}, port ${config.apiPort})`);
}

// ---------------------------------------------------------------------------
// Step 5: Start DKG daemon
// ---------------------------------------------------------------------------

export async function startDaemon(apiPort: number): Promise<void> {
  // Check if already running
  const pidPath = join(dkgDir(), 'daemon.pid');
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      if (pid && isProcessRunning(pid)) {
        // Verify the running daemon is reachable on the expected port
        try {
          const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
          if (res.ok) {
            log(`DKG daemon already running (PID ${pid}, port ${apiPort})`);
            return;
          }
        } catch { /* not reachable on expected port */ }
        // PID is alive but not reachable — could be a stale PID, PID reuse,
        // or a port mismatch. Warn and fall through to attempt dkg start,
        // which will either succeed (if the PID wasn't actually DKG) or
        // fail with a clear error (if port is genuinely in use).
        warn(
          `PID ${pid} is alive but daemon not reachable on port ${apiPort}. ` +
          'Attempting to start — if this fails, run "dkg stop" first.',
        );
      }
    } catch { /* stale pid file */ }
  }

  log('Starting DKG daemon...');
  try {
    // Resolve the CLI entrypoint as an absolute path and spawn via
    // process.execPath so we don't depend on `dkg` being on PATH — which
    // `pnpm dkg openclaw setup` does not guarantee in a cloned monorepo.
    const { node, cliPath } = resolveDkgCli();
    const result = spawnSync(node, [cliPath, 'start'], {
      stdio: 'inherit',
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `dkg start exited with ${result.status ?? `signal ${result.signal}`}`,
      );
    }
  } catch (err: any) {
    throw new Error(`Failed to start DKG daemon: ${err.message}`);
  }

  // Poll for readiness
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
      if (res.ok) {
        log('DKG daemon is ready');
        return;
      }
    } catch { /* not ready yet */ }
    await sleep(1_000);
  }

  warn('Daemon started but health check timed out — it may still be initializing');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 6: Read wallets and fund via testnet faucet
// ---------------------------------------------------------------------------

/**
 * Read the wallet addresses the daemon has written to `~/.dkg/wallets.json`.
 *
 * Returns an empty list (with a warning) when the file is missing or
 * malformed. `runSetup` retries a few times after daemon start because the
 * daemon writes `wallets.json` asynchronously and may not have flushed it
 * by the time the health check passes.
 */
export function readWallets(): string[] {
  const walletsPath = join(dkgDir(), 'wallets.json');
  if (!existsSync(walletsPath)) {
    warn('wallets.json not found — daemon may not have started yet');
    return [];
  }

  let raw: any;
  try {
    raw = JSON.parse(readFileSync(walletsPath, 'utf-8'));
  } catch {
    warn('wallets.json is malformed or still being written — skipping');
    return [];
  }
  // The daemon writes { wallets: [{ address, privateKey }] }.
  // Handle this shape first, then fall back to other formats.
  const walletList: any[] = Array.isArray(raw?.wallets) ? raw.wallets
    : Array.isArray(raw) ? raw
    : [];
  const addresses: string[] = [];
  for (const w of walletList) {
    if (w?.address) addresses.push(w.address);
  }

  if (addresses.length) {
    log(`Wallets: ${addresses.join(', ')}`);
  }
  return addresses;
}

/**
 * Print a ready-to-paste `curl` block for manual faucet funding. Called
 * only on faucet failure; the caller is expected to continue (funding is
 * best-effort / non-fatal).
 *
 * Addresses are capped at the first 3 to match `requestFaucetFunding`'s
 * server-side cap (`packages/core/src/faucet.ts`). Including more wallets
 * in the body would be rejected by the faucet. When the caller passes >3
 * addresses, the extras are listed in a follow-on note so the operator
 * knows which wallets still need funding (via a separate request or a
 * re-run after cooldown).
 */
export function logManualFundingInstructions(addresses: string[], faucetUrl: string, mode: string): void {
  const fundable = addresses.slice(0, 3);
  const extras = addresses.slice(3);
  console.log('\nTo fund wallets manually, run:');
  console.log(`  curl -X POST "${faucetUrl}" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -H "Idempotency-Key: $(date +%s)" \\`);
  console.log(`    --data-raw '{"mode":"${mode}","wallets":${JSON.stringify(fundable)}}'`);
  if (extras.length > 0) {
    console.log(`\nNote: faucet supports up to 3 wallets per call; the command above funds the first 3.`);
    console.log(`Fund the remaining ${extras.length} wallet(s) with a separate request:`);
    console.log(`  ${extras.join(', ')}`);
  }
  console.log('');
}

/**
 * Read wallet addresses, retrying up to 5 times with a 1s delay between
 * attempts. The daemon writes `~/.dkg/wallets.json` asynchronously after
 * its health check passes, so the file is often missing on the first read
 * immediately after `startDaemon` returns.
 *
 * Exported (internal to this package — not re-exported from `index.ts`) so
 * the retry accounting can be unit-tested without spawning a real daemon.
 * Defaults preserve production behavior: `sleep` for the real `setTimeout`
 * delay, `readWallets` for the real filesystem read.
 */
export async function readWalletsWithRetry(
  sleepFn: (ms: number) => Promise<void> = sleep,
  readFn: () => string[] = readWallets,
): Promise<string[]> {
  let walletAddresses = readFn();
  for (let i = 0; i < 5 && !walletAddresses.length; i++) {
    await sleepFn(1_000);
    walletAddresses = readFn();
  }
  return walletAddresses;
}

// ---------------------------------------------------------------------------
// Step 4 (preflight) + Step 8: Merge adapter into openclaw.json
// ---------------------------------------------------------------------------

const ADAPTER_PLUGIN_ID = 'adapter-openclaw';

/**
 * Result of `preflightOpenClawConfig` — the pure, staged validation of
 * `openclaw.json` that Step 8 (merge) relies on. Surfacing the parsed
 * config + migration pointer here lets the caller reuse them without
 * re-reading the file.
 */
export interface OpenClawPreflightResult {
  /**
   * Absolute path to the `openclaw.json` the subsequent merge step will
   * write to. Resolves the `--workspace`-override case (where
   * `discoverWorkspace` returns an empty configPath) to the default
   * `~/.openclaw/openclaw.json`, matching `mergeOpenClawConfig`'s own
   * resolution.
   */
  effectiveConfigPath: string;
  /**
   * The parsed JSON of the file at `effectiveConfigPath`. Reused by the
   * caller for migration-pointer discovery and any downstream inspection
   * so we don't re-parse the file twice.
   */
  rawExisting: any;
  /**
   * If a prior install wrote `plugins.entries.adapter-openclaw.config.installedWorkspace`
   * and this run is targeting a different workspace, the migration-cleanup
   * step later in `runSetup` retires the prior install's SKILL.md. Empty
   * string means "no migration cleanup required".
   */
  priorInstalledForMigration: string;
}

/**
 * Validate `openclaw.json` before any destructive setup step runs. This
 * is the Codex PR #234 R6-2 + R8-2 preflight lifted out of `runSetup` so
 * it can run earlier (before `startDaemon` + the faucet call) — catching
 * a deterministic misconfiguration (missing file, invalid JSON, non-
 * writable, wrong-slot-wired) before the user's 3-calls-per-8h faucet
 * allowance is spent on a setup that was always going to fail at merge.
 *
 * Pure staged checks:
 *   1. `openclaw.json` exists at the effective config path.
 *   2. The file parses as JSON.
 *   3. The file is writable.
 *   4. The containing directory is writable (R11-3 — `mergeOpenClawConfig`
 *      writes `openclaw.json.bak.<ts>` as a sibling of the config, so a
 *      file-writable-but-dir-readonly arrangement would fail mid-merge).
 *   5. `plugins.slots.contextEngine !== ADAPTER_PLUGIN_ID` (R8-2 — the
 *      adapter declares `kind: "memory"`; mis-wiring would let step 8
 *      write SKILL.md to disk before throwing).
 *
 * Also captures the migration pointer (`entry.config.installedWorkspace`)
 * for the post-merge cleanup step. A missing pointer means no migration
 * cleanup is required; we decline to fall back to `resolveWorkspaceDirFromConfig`
 * here (R11-2 — no destructive best-guess on pre-launch configs).
 *
 * Throws with actionable messages matching the in-body preflight's error
 * text. Callers are responsible for swallowing/abortng as appropriate —
 * in the `runSetup` happy path these errors should propagate so the user
 * sees them immediately on the command line.
 */
export function preflightOpenClawConfig(openclawConfigPath: string): OpenClawPreflightResult {
  // `discoverWorkspace` returns configPath: '' when `--workspace` was used,
  // so resolve the effective path the same way `mergeOpenClawConfig` does
  // at setup.ts:524 — default to `~/.openclaw/openclaw.json` when empty.
  const effectiveConfigPath = openclawConfigPath && openclawConfigPath.trim()
    ? openclawConfigPath
    : join(openclawDir(), 'openclaw.json');

  if (!existsSync(effectiveConfigPath)) {
    throw new Error(
      `openclaw.json not found at ${effectiveConfigPath} — ` +
      `install OpenClaw first`,
    );
  }

  let rawExisting: any;
  try {
    rawExisting = JSON.parse(readFileSync(effectiveConfigPath, 'utf-8'));
  } catch (err: any) {
    throw new Error(
      `openclaw.json at ${effectiveConfigPath} is not valid JSON: ${err?.message ?? err}`,
    );
  }

  try {
    accessSync(effectiveConfigPath, fsConstants.W_OK);
  } catch (err: any) {
    throw new Error(
      `openclaw.json at ${effectiveConfigPath} is not writable: ${err?.message ?? err}`,
    );
  }

  // R11-3: `mergeOpenClawConfig` creates `openclaw.json.bak.<ts>` as a
  // sibling of the config file. A writable config file inside a read-only
  // directory would pass the file-level check above and then fail at
  // backup creation AFTER merge has already written SKILL.md — the exact
  // orphan scenario R6-2 was designed to prevent. Check the directory
  // too.
  const configDir = dirname(effectiveConfigPath);
  try {
    accessSync(configDir, fsConstants.W_OK);
  } catch (err: any) {
    throw new Error(
      `openclaw.json directory ${configDir} is not writable (backup file creation would fail): ${err?.message ?? err}`,
    );
  }

  // R8-2: pre-validate the wrong-slot guard `mergeOpenClawConfig` runs
  // later. A misconfigured `plugins.slots.contextEngine === "adapter-openclaw"`
  // would let the install-skill step write SKILL.md to disk before merge
  // threw. Running the same check here fails fast with no disk mutation.
  // Note: unpreventable failure modes (disk-full on write, backup rename
  // failure, abort between install-skill and merge) remain covered by
  // the canary ordering + `openclaw-entry.mjs` sync-on-load self-heal —
  // the worst case is a retry where the migration cleans up any orphan.
  if (rawExisting?.plugins?.slots?.contextEngine === ADAPTER_PLUGIN_ID) {
    throw new Error(
      `Refusing to install: plugins.slots.contextEngine is set to "${ADAPTER_PLUGIN_ID}" ` +
      `but the adapter declares kind: "memory". Clear plugins.slots.contextEngine first.`,
    );
  }

  // Migration discovery: only trust the explicit
  // `entry.config.installedWorkspace` pointer written by a prior merge.
  // No legacy fallback via `resolveWorkspaceDirFromConfig` — pre-launch,
  // pre-R2 configs don't exist at scale, and the config-derived workspace
  // isn't guaranteed to be where an earlier `--workspace`-overridden
  // install actually put SKILL.md. A missing pointer simply means no
  // migration cleanup runs (R11-2 decline of destructive best-guess).
  let priorInstalledForMigration = '';
  const existingEntry = rawExisting?.plugins?.entries?.[ADAPTER_PLUGIN_ID];
  if (existingEntry && typeof existingEntry === 'object') {
    const installedFromEntryConfig = typeof existingEntry.config?.installedWorkspace === 'string'
      && existingEntry.config.installedWorkspace.trim()
      ? existingEntry.config.installedWorkspace.trim()
      : undefined;
    if (installedFromEntryConfig) {
      priorInstalledForMigration = installedFromEntryConfig;
    }
  }

  return { effectiveConfigPath, rawExisting, priorInstalledForMigration };
}

/**
 * Shared predicate between merge and unmerge so the unmerge only removes
 * load paths that setup would itself have written. User-added paths that
 * happen to mention "openclaw" fall through untouched.
 */
function isAdapterLoadPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/@origintrail-official/dkg-adapter-openclaw')
    || normalized.endsWith('/packages/adapter-openclaw')
    || normalized.includes('/packages/adapter-openclaw/');
}

/**
 * Shape of `plugins.entries.adapter-openclaw.config` that
 * `mergeOpenClawConfig` accepts. A `Pick` of `DkgOpenClawConfig` so the
 * write-path stays aligned with the runtime's config contract: callers
 * can pass any of the same sub-fields the adapter reads at load time,
 * including `channel.port` for advanced bridge-port overrides.
 */
export type AdapterEntryConfig = Pick<DkgOpenClawConfig, 'daemonUrl' | 'memory' | 'channel'>;

export function mergeOpenClawConfig(
  openclawConfigPath: string,
  adapterPath: string,
  entryConfig: AdapterEntryConfig,
  installedWorkspace: string,
  options?: { overrideDaemonUrl?: boolean },
): void {
  if (!openclawConfigPath || !existsSync(openclawConfigPath)) {
    // If we got here via --workspace override, the openclaw.json path may be unknown.
    // Try the default location.
    openclawConfigPath = join(openclawDir(), 'openclaw.json');
    if (!existsSync(openclawConfigPath)) {
      throw new Error(`openclaw.json not found at ${openclawConfigPath}`);
    }
  }

  const raw = readFileSync(openclawConfigPath, 'utf-8');
  const config = JSON.parse(raw);

  // Ensure plugins structure exists
  if (!config.plugins) config.plugins = {};
  if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
  if (!config.plugins.load || typeof config.plugins.load !== 'object') config.plugins.load = {};
  if (!Array.isArray(config.plugins.load.paths)) config.plugins.load.paths = [];
  if (!config.plugins.entries) config.plugins.entries = {};

  const pluginId = ADAPTER_PLUGIN_ID;
  // Normalize adapter path to forward slashes for cross-platform compatibility
  const normalizedPath = adapterPath.replace(/\\/g, '/');

  // Add to allow list (idempotent)
  if (!config.plugins.allow.includes(pluginId)) {
    config.plugins.allow.push(pluginId);
    log(`Added ${pluginId} to plugins.allow`);
  } else {
    log(`${pluginId} already in plugins.allow`);
  }

  // Add to load paths (idempotent — check normalized versions)
  // Filter out non-string entries from legacy/malformed configs
  config.plugins.load.paths = config.plugins.load.paths.filter((p: unknown) => typeof p === 'string');
  const retainedPaths = config.plugins.load.paths.filter((p: string) => !isAdapterLoadPath(p));
  const removedLoadPathCount = config.plugins.load.paths.length - retainedPaths.length;
  if (removedLoadPathCount > 0) {
    config.plugins.load.paths = retainedPaths;
    log(`Removed ${removedLoadPathCount} stale adapter-openclaw load path(s)`);
  } else {
    config.plugins.load.paths = retainedPaths;
  }
  const existingPaths = config.plugins.load.paths.map((p: string) => p.replace(/\\/g, '/'));
  if (!existingPaths.includes(normalizedPath)) {
    config.plugins.load.paths.push(normalizedPath);
    log(`Added adapter path to plugins.load.paths`);
  } else {
    log('Adapter path already in plugins.load.paths');
  }

  // Add to entries or ensure enabled (preserves other plugin-specific fields)
  // Normalize non-object entries (e.g. boolean/string from legacy config)
  const entry = config.plugins.entries[pluginId];
  if (!entry || typeof entry !== 'object') {
    config.plugins.entries[pluginId] = { enabled: true };
    log(`Added ${pluginId} to plugins.entries`);
  } else if (!entry.enabled) {
    entry.enabled = true;
    log(`Re-enabled ${pluginId} in plugins.entries`);
  } else {
    log(`${pluginId} already in plugins.entries`);
  }

  // Populate entry.config with first-wins semantics: user-customized values
  // survive re-runs (same pattern as previousMemorySlotOwner). Sub-objects
  // (memory, channel) are shallow-merged per-key so new defaults added in a
  // later release flow in while user overrides for existing keys hold.
  // When `overrideDaemonUrl` is set (caller passed --port explicitly), the
  // new `daemonUrl` wins over any existing value.
  //
  // `installedWorkspace` lives INSIDE `entry.config` (not at entry root) —
  // OpenClaw's gateway schema strict-rejects unknown keys on plugin entries
  // themselves (`plugins.entries.adapter-openclaw: Unrecognized key`), but
  // `entry.config` is the plugin-owned passthrough space where our
  // `daemonUrl` / `memory` / `channel` fields already live. Latest-wins via
  // explicit placement AFTER the `existingEntryConfig` spread so a re-install
  // updates the pointer (matches the behavior of the `--port` override on
  // `entry.config.daemonUrl`).
  const entryForConfig = config.plugins.entries[pluginId];

  const hadConfig = entryForConfig.config && typeof entryForConfig.config === 'object';
  const existingEntryConfig: Record<string, any> = hadConfig ? { ...entryForConfig.config } : {};
  if (options?.overrideDaemonUrl) {
    delete existingEntryConfig.daemonUrl;
  }
  const existingMemory = existingEntryConfig.memory && typeof existingEntryConfig.memory === 'object'
    ? existingEntryConfig.memory
    : {};
  const existingChannel = existingEntryConfig.channel && typeof existingEntryConfig.channel === 'object'
    ? existingEntryConfig.channel
    : {};
  const priorInstalledWorkspace =
    typeof existingEntryConfig.installedWorkspace === 'string'
      ? existingEntryConfig.installedWorkspace
      : undefined;
  entryForConfig.config = {
    ...entryConfig,
    ...existingEntryConfig,
    memory: { ...entryConfig.memory, ...existingMemory },
    channel: { ...entryConfig.channel, ...existingChannel },
    // Explicit placement AFTER the `existingEntryConfig` spread — latest-wins
    // for the adapter-owned pointer so a re-install updates it cleanly.
    installedWorkspace,
  };
  if (!hadConfig) {
    log(`Populated plugins.entries.${pluginId}.config`);
  }
  if (priorInstalledWorkspace !== installedWorkspace) {
    log(`Set plugins.entries.${pluginId}.config.installedWorkspace = "${installedWorkspace}"`);
  }

  // Ensure plugin-registered tools are visible to the agent. Track whether THIS
  // merge pass actually mutates anything under `config.tools` so `mergedToolsShape`
  // can be refreshed only when we've genuinely written to the section. If the user
  // has already settled the tools section (or has intentionally changed it after an
  // earlier merge), no mutation fires here and the snapshot stays whatever a prior
  // merge captured — preserving the correct ownership semantics for unmerge.
  let mutatedTools = false;
  if (!config.tools) config.tools = {};
  if (!Array.isArray(config.tools.alsoAllow)) {
    // Preserve existing string value if present
    const existing = config.tools.alsoAllow;
    config.tools.alsoAllow = existing ? [existing] : [];
  }
  if (!config.tools.alsoAllow.includes('group:plugins')) {
    config.tools.alsoAllow.push('group:plugins');
    mutatedTools = true;
    log('Added "group:plugins" to tools.alsoAllow');
  }

  // Ensure tools.profile exposes plugin-registered tools. OpenClaw's
  // `CORE_TOOL_PROFILES` allowlist (applied at registry resolution) filters
  // plugin-registered tools out of the default `"coding"` profile, making
  // `dkg_*` invisible to the agent even when the plugin loads in full mode.
  //
  // Capture the pre-merge profile onto the adapter entry so `unmergeOpenClawConfig`
  // can restore it on disconnect. First-wins: once captured, re-running merge
  // does not clobber the original (matches the `previousMemorySlotOwner` pattern).
  // `null` sentinel = "absent before merge" → disconnect should delete the key.
  const adapterEntryForCapture = config.plugins.entries[pluginId] as Record<string, any>;
  if (!config.tools.profile) {
    if (adapterEntryForCapture && !('previousToolsProfile' in adapterEntryForCapture)) {
      adapterEntryForCapture.previousToolsProfile = null;
    }
    config.tools.profile = 'full';
    mutatedTools = true;
    log('Set tools.profile = "full" to expose plugin tools');
  } else if (config.tools.profile === 'coding') {
    if (adapterEntryForCapture && !('previousToolsProfile' in adapterEntryForCapture)) {
      adapterEntryForCapture.previousToolsProfile = 'coding';
    }
    config.tools.profile = 'full';
    mutatedTools = true;
    log('Upgraded tools.profile from "coding" to "full" to expose plugin tools');
  }
  // If the user explicitly set "minimal" or "messaging", respect that — they may
  // have restricted the profile intentionally and can re-expand with alsoAllow.
  // No capture because we didn't mutate.

  // Ensure channels.dkg-ui has at least one non-`enabled` key so OpenClaw's
  // loader keeps the plugin in `full` runtime mode (not `setup-runtime`, where
  // api.registerTool is a noop — see openclaw/src/plugins/loader.ts:816 and
  // openclaw/src/config/channel-configured-shared.ts:21 for the check).
  //
  // Port derivation reads from the POST-MERGE `plugins.entries.adapter-openclaw
  // .config.channel.port`, not the incoming `entryConfig.channel.port`. The
  // entry-config merge above applies first-wins semantics: when the user
  // already has a custom adapter port (e.g. 9300), it's preserved on the entry
  // even if the caller passed a default `entryConfig`. Reading the post-merge
  // state keeps the top-level `channels.dkg-ui.port` in sync with whatever the
  // adapter entry actually resolved to. Falls back to the openclaw.plugin.json
  // configSchema default (9201) when no port is set anywhere.
  const mergedChannel = entryForConfig.config?.channel as { port?: unknown; enabled?: unknown } | undefined;
  const mergedChannelPort = mergedChannel?.port;
  const adapterChannelPort = typeof mergedChannelPort === 'number' && Number.isInteger(mergedChannelPort)
    ? mergedChannelPort
    : 9201;
  // Preserve the user's explicit `enabled` value from the adapter entry. If they
  // set `plugins.entries.adapter-openclaw.config.channel.enabled = false`, we
  // must not silently re-enable the channel here — even though the top-level
  // `channels.dkg-ui` entry still needs a non-`enabled` key (the `port` below)
  // to satisfy OpenClaw's meaningful-config check and keep the plugin in full
  // runtime mode.
  const adapterChannelEnabled =
    typeof mergedChannel?.enabled === 'boolean' ? mergedChannel.enabled : true;
  if (!config.channels || typeof config.channels !== 'object') {
    config.channels = {};
  }
  // `previousChannelsDkgUi` is first-wins — it captures the ORIGINAL pre-merge
  // user state (absent / degenerate) at the very first install so unmerge can
  // restore verbatim. `mergedChannelsDkgUi` tracks our LATEST output and MUST
  // be refreshed on every write, since a later re-merge (e.g. after the user
  // deletes or strips channels.dkg-ui, forcing us to re-create at a different
  // port) would otherwise leave a stale snapshot and break the deep-equal
  // ownership check on disconnect.
  const dkgUiChannel = config.channels['dkg-ui'];
  const lastMergedChannel = adapterEntryForCapture?.mergedChannelsDkgUi as Record<string, unknown> | undefined;
  if (!dkgUiChannel || typeof dkgUiChannel !== 'object') {
    // Channel absent before merge → on disconnect, delete it (only if still
    // matches the shape we wrote).
    const created = { enabled: adapterChannelEnabled, port: adapterChannelPort };
    if (adapterEntryForCapture) {
      if (!('previousChannelsDkgUi' in adapterEntryForCapture)) {
        adapterEntryForCapture.previousChannelsDkgUi = null; // first-wins
      }
      adapterEntryForCapture.mergedChannelsDkgUi = { ...created }; // always refresh
    }
    config.channels['dkg-ui'] = created;
    log(`Created channels.dkg-ui with port ${adapterChannelPort} to keep plugin in full runtime mode`);
  } else {
    // Check whether the existing entry has any non-`enabled` key.
    const hasNonEnabledKey = Object.keys(dkgUiChannel).some((k) => k !== 'enabled');
    if (!hasNonEnabledKey) {
      // Degenerate shape → upgrade.
      const upgraded = { ...dkgUiChannel, port: adapterChannelPort };
      if (adapterEntryForCapture) {
        if (!('previousChannelsDkgUi' in adapterEntryForCapture)) {
          adapterEntryForCapture.previousChannelsDkgUi = { ...dkgUiChannel }; // first-wins
        }
        adapterEntryForCapture.mergedChannelsDkgUi = { ...upgraded }; // always refresh
      }
      config.channels['dkg-ui'] = upgraded;
      log(`Added port ${adapterChannelPort} to channels.dkg-ui to keep plugin in full runtime mode`);
    } else if (lastMergedChannel && isDeepStrictEqual(dkgUiChannel, lastMergedChannel)) {
      // Channel is byte-identical to what we wrote last time → still adapter-
      // owned. Refresh it with the current `adapterChannelPort` so a re-run
      // after the user edits `plugins.entries.adapter-openclaw.config.channel.port`
      // (or passes a different port via entryConfig) propagates to the top-level
      // channel instead of leaving the old adapter-written port in place.
      const refreshed: Record<string, unknown> = { ...dkgUiChannel, port: adapterChannelPort };
      if (!isDeepStrictEqual(refreshed, lastMergedChannel)) {
        if (adapterEntryForCapture) {
          adapterEntryForCapture.mergedChannelsDkgUi = { ...refreshed };
        }
        config.channels['dkg-ui'] = refreshed;
        log(`Refreshed channels.dkg-ui.port to ${adapterChannelPort} (last merge output preserved)`);
      }
      // else: already up to date — no-op keeps idempotency on successive re-runs.
    }
    // Otherwise the user has modified channels.dkg-ui since install (or created
    // it themselves with non-enabled keys). Leave alone. No refresh because we
    // didn't mutate — disconnect must not touch a user-owned channel.
  }

  // Capture the full `config.tools` shape AFTER all merge mutations (profile +
  // alsoAllow) — but ONLY when this pass actually mutated `config.tools`.
  // Unmerge uses this as a deep-equal ownership check: if the user has edited
  // anything under `tools` since our last write, we leave our mutations alone.
  //
  // Gating on `mutatedTools` matters for the re-run case where an earlier merge
  // set `profile: "full"` + captured the snapshot, the user later changed the
  // profile to `"minimal"` and added other `tools.*` fields, and now setup runs
  // again: our profile block no longer mutates (respects "minimal"), alsoAllow
  // is already present (no push), so we don't touch `config.tools` at all. If
  // we unconditionally overwrote `mergedToolsShape` with the user's current
  // tools shape, unmerge would then see a perfect deep-equal match and revert
  // `previousToolsProfile` — silently clobbering the user's "minimal" choice.
  // Keeping the snapshot at the PRIOR adapter output means unmerge's deep-equal
  // fails (correct ownership: user now owns the section) and the revert is
  // skipped. On the no-op first merge (tools.profile already "full" + alsoAllow
  // already present), no snapshot is captured at all — also correct, because we
  // never took ownership of the section.
  if (mutatedTools && adapterEntryForCapture) {
    adapterEntryForCapture.mergedToolsShape = structuredClone(config.tools);
  }

  // Elect the adapter into OpenClaw's memory slot. Combined with
  // "kind": "memory" in openclaw.plugin.json and api.registerMemoryCapability(...)
  // inside DkgNodePlugin.register(), this replaces the default memory-core
  // plugin with the DKG-backed provider.
  if (!config.plugins.slots || typeof config.plugins.slots !== 'object') {
    config.plugins.slots = {};
  }
  // Wrong-slot guard: the context-engine slot is for a different plugin kind;
  // accidentally writing our adapter ID there would be a bug.
  if (config.plugins.slots.contextEngine === pluginId) {
    throw new Error(
      `Refusing to merge adapter: plugins.slots.contextEngine is set to "${pluginId}" ` +
      `but the adapter declares kind: "memory". Clear plugins.slots.contextEngine first.`,
    );
  }
  if (config.plugins.slots.memory !== pluginId) {
    // Capture the prior non-adapter owner so `unmergeOpenClawConfig` can
    // restore it on disconnect. First-wins: if the entry already carries a
    // `previousMemorySlotOwner` from an earlier merge, keep it rather than
    // overwriting with whatever's currently in the slot. This guards against
    // losing the original owner if the slot gets manipulated between merges.
    const currentOwner = config.plugins.slots.memory;
    if (currentOwner && currentOwner !== pluginId) {
      const adapterEntry = config.plugins.entries[pluginId];
      if (adapterEntry && typeof adapterEntry === 'object' && !adapterEntry.previousMemorySlotOwner) {
        adapterEntry.previousMemorySlotOwner = currentOwner;
        log(`plugins.slots.memory was "${currentOwner}" — saved as previousMemorySlotOwner for restoration on disconnect`);
      } else if (adapterEntry && typeof adapterEntry === 'object') {
        log(`plugins.slots.memory was "${currentOwner}" — existing previousMemorySlotOwner="${adapterEntry.previousMemorySlotOwner}" preserved (first-wins)`);
      }
    }
    config.plugins.slots.memory = pluginId;
    log(`Set plugins.slots.memory = "${pluginId}"`);
  } else {
    log(`plugins.slots.memory already = "${pluginId}"`);
  }

  const updated = JSON.stringify(config, null, 2) + '\n';
  if (updated === raw) {
    log('openclaw.json already up to date — no changes needed');
    return;
  }

  // Backup only when content actually changes
  const backupPath = `${openclawConfigPath}.bak.${Date.now()}`;
  writeFileSync(backupPath, raw);

  writeFileSync(openclawConfigPath, updated);
  log(`Updated ${openclawConfigPath} (backed up original)`);
}

/**
 * Symmetric undo of `mergeOpenClawConfig`. Scoped to only the fields setup
 * would have written:
 *   - removes `"adapter-openclaw"` from `plugins.allow`
 *   - filters `plugins.load.paths` by the same `isAdapterLoadPath` predicate
 *   - removes `plugins.entries["adapter-openclaw"]` entirely (including any
 *     `config` sub-object — the adapter owns the whole entry)
 *   - restores `plugins.slots.memory` to the prior owner captured during merge
 *     (`entries["adapter-openclaw"].previousMemorySlotOwner`, read before the
 *     entry is deleted), or clears it when no prior owner was persisted.
 *
 * Leaves `tools.alsoAllow` (shared with other plugins), workspace `config.json`
 * (user-owned), and any workspace `SKILL.md` copies alone. Idempotent — a
 * second call produces zero diff. Backs up to `.bak.<ts>` only when content
 * changes (same contract as merge).
 *
 * Already-disconnected shortcut: a missing or unparseable `openclaw.json` is
 * treated as "nothing to unmerge" — logs a one-liner and returns without
 * throwing or writing `.bak`. The adapter cannot be loading from a config
 * that doesn't exist (or can't be parsed), so blocking the Disconnect UI
 * flow on it would strand users who removed or relocated OpenClaw.
 */
export interface UnmergeResult {
  /**
   * Prior memory-slot owner captured by `mergeOpenClawConfig` and read out of
   * the adapter entry BEFORE it was deleted. Used to restore `plugins.slots.memory`
   * when the adapter had displaced another plugin at install time.
   */
  previousMemorySlotOwner?: string;
}

export function unmergeOpenClawConfig(openclawConfigPath: string): UnmergeResult {
  // Fall back to the default `~/.openclaw/openclaw.json` ONLY when no path was
  // supplied. If the caller passed an explicit path that happens to be missing
  // (e.g. the user relocated OpenClaw), never swap to the default home —
  // that would unmerge the wrong config and corrupt the user's real setup.
  if (!openclawConfigPath || !openclawConfigPath.trim()) {
    openclawConfigPath = join(openclawDir(), 'openclaw.json');
  }
  if (!existsSync(openclawConfigPath)) {
    log(`openclaw.json not found at ${openclawConfigPath} — nothing to unmerge`);
    return {};
  }

  const raw = readFileSync(openclawConfigPath, 'utf-8');
  let config: any;
  try {
    config = JSON.parse(raw);
  } catch (err: any) {
    log(`openclaw.json at ${openclawConfigPath} is not valid JSON (${err?.message ?? err}) — nothing to unmerge`);
    return {};
  }
  const pluginId = ADAPTER_PLUGIN_ID;

  // Remove from plugins.allow
  if (config.plugins && Array.isArray(config.plugins.allow)) {
    const filtered = config.plugins.allow.filter((id: unknown) => id !== pluginId);
    if (filtered.length !== config.plugins.allow.length) {
      config.plugins.allow = filtered;
      log(`Removed ${pluginId} from plugins.allow`);
    }
  }

  // Remove adapter load paths (same predicate as merge)
  if (config.plugins && config.plugins.load && Array.isArray(config.plugins.load.paths)) {
    const strings = config.plugins.load.paths.filter((p: unknown) => typeof p === 'string');
    const kept = strings.filter((p: string) => !isAdapterLoadPath(p));
    const removed = strings.length - kept.length;
    if (removed > 0) {
      config.plugins.load.paths = kept;
      log(`Removed ${removed} adapter-openclaw load path(s) from plugins.load.paths`);
    } else if (strings.length !== config.plugins.load.paths.length) {
      // Normalize away non-string entries even when nothing adapter-owned was present
      config.plugins.load.paths = strings;
    }
  }

  // Read the prior memory-slot owner that `mergeOpenClawConfig` persisted
  // BEFORE we mutate the entry. A string value means we should restore the
  // slot on disconnect; anything else means the slot was empty at merge time.
  //
  // `entry.config.installedWorkspace` is intentionally NOT returned here — post-PR
  // #234 R3-2 the daemon reads it directly from openclaw.json before calling
  // this function, so the skill cleanup runs BEFORE the entry is deleted.
  // That ordering lets a failed skill cleanup retry against the still-present
  // authority pointer instead of relying on a return value we discard on crash.
  let previousMemorySlotOwner: string | undefined;
  // `null` sentinel (captured from merge) = key was absent before merge → delete it.
  // Defined string / object = restore verbatim. `undefined` = no capture, leave as-is.
  let previousToolsProfile: string | null | undefined;
  let previousChannelsDkgUi: Record<string, unknown> | null | undefined;
  // Exact merge-produced shapes, captured at merge time. Used as deep-equal
  // ownership checks on unmerge — a loose "holds our string" / "has a port key"
  // guard would also match post-merge user edits (custom fields under `tools`,
  // auth tokens / port changes on `channels.dkg-ui`) and clobber them on
  // disconnect.
  let mergedChannelsDkgUi: Record<string, unknown> | undefined;
  let mergedToolsShape: Record<string, unknown> | undefined;
  const entry = config.plugins?.entries?.[pluginId];
  if (entry && typeof entry === 'object') {
    if (typeof entry.previousMemorySlotOwner === 'string') {
      previousMemorySlotOwner = entry.previousMemorySlotOwner;
    }
    if ('previousToolsProfile' in entry) {
      previousToolsProfile = entry.previousToolsProfile;
    }
    if ('previousChannelsDkgUi' in entry) {
      previousChannelsDkgUi = entry.previousChannelsDkgUi;
    }
    if (entry.mergedChannelsDkgUi && typeof entry.mergedChannelsDkgUi === 'object') {
      mergedChannelsDkgUi = entry.mergedChannelsDkgUi as Record<string, unknown>;
    }
    if (entry.mergedToolsShape && typeof entry.mergedToolsShape === 'object') {
      mergedToolsShape = entry.mergedToolsShape as Record<string, unknown>;
    }
  }

  // Delete the adapter entry entirely. The adapter owns this entry — all of
  // its fields (enabled, config, previousMemorySlotOwner) are setup-written,
  // so there's no user-customizable state to preserve. A fresh merge will
  // rebuild everything from scratch, including re-capturing the current slot
  // owner into previousMemorySlotOwner.
  if (config.plugins && config.plugins.entries && pluginId in config.plugins.entries) {
    delete config.plugins.entries[pluginId];
    log(`Removed ${pluginId} from plugins.entries`);
  }

  // Restore or clear slots.memory iff it still points at the adapter. If the
  // user has externally re-owned the slot between merge and unmerge we leave
  // it untouched — only the adapter's own claim gets reversed.
  if (config.plugins && config.plugins.slots && config.plugins.slots.memory === pluginId) {
    if (previousMemorySlotOwner) {
      config.plugins.slots.memory = previousMemorySlotOwner;
      log(`Restored plugins.slots.memory to "${previousMemorySlotOwner}" (was "${pluginId}")`);
    } else {
      delete config.plugins.slots.memory;
      log(`Cleared plugins.slots.memory (was "${pluginId}")`);
    }
  }

  // Restore or clear tools.profile iff the current `config.tools` DEEP-EQUALS
  // the exact shape merge wrote. The bare `=== 'full'` check would fire even
  // after the user added unrelated fields under `tools` (e.g. tools.web), so
  // we'd quietly revert their profile alongside a section they're actively
  // using. Matching the channels.dkg-ui pattern: compare the whole `tools`
  // object against the captured `mergedToolsShape` snapshot — any divergence
  // (added field, removed field, changed value anywhere under `tools`) means
  // the user now owns this section and we leave the profile alone.
  const currentTools = config.tools && typeof config.tools === 'object'
    ? (config.tools as Record<string, unknown>)
    : undefined;
  const toolsMatchMerge =
    !!currentTools
    && !!mergedToolsShape
    && isDeepStrictEqual(currentTools, mergedToolsShape);
  if (toolsMatchMerge) {
    if (previousToolsProfile === null) {
      if ('profile' in currentTools) {
        delete currentTools.profile;
        log('Removed tools.profile (set to "full" by merge, unchanged since)');
      }
    } else if (typeof previousToolsProfile === 'string') {
      currentTools.profile = previousToolsProfile;
      log(`Restored tools.profile to "${previousToolsProfile}"`);
    }
  } else if (previousToolsProfile !== undefined && currentTools) {
    log('Preserving tools.profile — tools section user-modified since merge');
  }

  // Restore or clear channels.dkg-ui iff the current value DEEP-EQUALS the exact
  // shape merge wrote. A loose "has a port key" check would also match user edits
  // made after install (post-merge port change, added auth/custom fields) and
  // clobber them on disconnect. Using `isDeepStrictEqual` against the captured
  // `mergedChannelsDkgUi` is strict ownership: any divergence from the merge
  // output — including the user re-customizing the port — means the user now
  // owns this channel, and we leave it alone.
  const currentChannel = config.channels && typeof config.channels === 'object'
    ? (config.channels['dkg-ui'] as Record<string, unknown> | undefined)
    : undefined;
  const currentMatchesMerge =
    !!currentChannel
    && !!mergedChannelsDkgUi
    && isDeepStrictEqual(currentChannel, mergedChannelsDkgUi);
  if (previousChannelsDkgUi === null) {
    if (currentMatchesMerge) {
      delete config.channels['dkg-ui'];
      log('Removed channels.dkg-ui (created by merge, unchanged since)');
      // If the container is now empty AND we created the channel (inferred from
      // previousChannelsDkgUi === null), remove the empty `channels: {}` orphan
      // so a connect → disconnect round trip returns the config to its
      // pre-merge shape byte-for-byte.
      if (
        config.channels
        && typeof config.channels === 'object'
        && Object.keys(config.channels).length === 0
      ) {
        delete config.channels;
        log('Removed empty channels container (no other channels remaining)');
      }
    } else if (currentChannel) {
      log('Preserving channels.dkg-ui — user-modified since merge');
    }
  } else if (previousChannelsDkgUi && typeof previousChannelsDkgUi === 'object') {
    if (currentMatchesMerge) {
      config.channels['dkg-ui'] = { ...previousChannelsDkgUi };
      log('Restored channels.dkg-ui to pre-merge state');
    } else if (currentChannel) {
      log('Preserving channels.dkg-ui — user-modified since merge');
    }
  }

  const updated = JSON.stringify(config, null, 2) + '\n';
  if (updated === raw) {
    log('openclaw.json already disconnected from adapter — no changes needed');
    return { previousMemorySlotOwner };
  }

  // Backup only when content actually changes (same contract as mergeOpenClawConfig)
  const backupPath = `${openclawConfigPath}.bak.${Date.now()}`;
  writeFileSync(backupPath, raw);

  writeFileSync(openclawConfigPath, updated);
  log(`Unmerged adapter from ${openclawConfigPath} (backed up original)`);
  return { previousMemorySlotOwner };
}

/**
 * Post-unmerge invariant check, counterpart to `verifyMemorySlotInvariants`
 * but for the Disconnect flow. Confirms every field `mergeOpenClawConfig`
 * writes has been unwound by `unmergeOpenClawConfig`:
 *   - `plugins.slots.memory !== "adapter-openclaw"`.
 *   - `plugins.allow` does not contain `"adapter-openclaw"`.
 *   - `plugins.load.paths` contains no entry matching `isAdapterLoadPath`.
 *   - `plugins.entries["adapter-openclaw"]?.enabled` is not `true`.
 *
 * Returns `null` when all invariants hold (disconnect is clean). Returns a
 * descriptive string naming the first failed invariant otherwise — callers
 * (e.g. the DKG daemon's PUT `/api/local-agent-integrations/:id` handler in
 * `packages/cli/src/daemon.ts`) surface the string as `runtime.lastError` and
 * refuse to transition the integration to `disconnected`.
 *
 * Non-throwing by design. File-state handling mirrors
 * `unmergeOpenClawConfig`:
 *   - Missing file → returns `null`. The invariants hold trivially because
 *     no adapter can be loading from a config that doesn't exist; blocking
 *     Disconnect in this case would strand users who removed OpenClaw.
 *   - Unparseable file → returns a descriptive string. That's a genuinely
 *     broken state worth surfacing — we can't verify invariants one way or
 *     the other.
 */
export function verifyUnmergeInvariants(configPath: string): string | null {
  if (!existsSync(configPath)) {
    return null;
  }

  let config: any;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err: any) {
    return `Could not parse ${configPath}: ${err?.message ?? err}`;
  }

  const pluginId = ADAPTER_PLUGIN_ID;
  const plugins = config?.plugins;

  if (plugins?.slots?.memory === pluginId) {
    return `plugins.slots.memory is still "${pluginId}"`;
  }
  if (Array.isArray(plugins?.allow) && plugins.allow.includes(pluginId)) {
    return `plugins.allow still contains "${pluginId}"`;
  }
  if (Array.isArray(plugins?.load?.paths)) {
    const stragglers = plugins.load.paths.filter(
      (p: unknown) => typeof p === 'string' && isAdapterLoadPath(p),
    );
    if (stragglers.length > 0) {
      return `plugins.load.paths still contains adapter path "${stragglers[0]}"`;
    }
  }
  const entry = plugins?.entries?.[pluginId];
  if (entry && typeof entry === 'object' && entry.enabled === true) {
    return `plugins.entries["${pluginId}"] is still present with enabled=true`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Step 7: Copy the canonical DKG node skill into the OpenClaw workspace
// ---------------------------------------------------------------------------

export function installCanonicalNodeSkill(
  workspaceDir: string,
  sourcePath = resolveCanonicalNodeSkillSourcePath(),
): string {
  const targetPath = canonicalWorkspaceSkillPath(workspaceDir);
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  log(`Installed canonical node skill from ${sourcePath} to ${targetPath}`);
  return targetPath;
}

/**
 * Symmetric counterpart to {@link installCanonicalNodeSkill}: removes the
 * adapter-owned `$WORKSPACE_DIR/skills/dkg-node/SKILL.md` doc installed by
 * step 7 of setup. Called from the daemon-side disconnect path so the agent-
 * facing skill is retired alongside the openclaw.json entry.
 *
 * Idempotent: a missing file is a no-op. After removing the file we also try
 * `rmdirSync` on the now-empty `skills/dkg-node/` parent so Disconnect leaves
 * no adapter-named empty directories behind — but we never touch the outer
 * `skills/` dir (user skills live there) and we swallow ENOTEMPTY when a
 * sibling file was placed alongside SKILL.md.
 */
export function removeCanonicalNodeSkill(workspaceDir: string): void {
  const targetPath = canonicalWorkspaceSkillPath(workspaceDir);
  if (!existsSync(targetPath)) {
    log(`No canonical node skill at ${targetPath} — nothing to remove`);
    return;
  }
  try {
    unlinkSync(targetPath);
    log(`Removed canonical node skill from ${targetPath}`);
  } catch (err: any) {
    warn(`Failed to remove canonical node skill at ${targetPath}: ${err?.message ?? err}`);
    return;
  }
  try {
    rmdirSync(dirname(targetPath));
  } catch {
    // Directory not empty (sibling file placed by user) or already gone — fine.
  }
}

/**
 * Post-remove invariant check, counterpart to `verifyUnmergeInvariants` but
 * for the skill-file side of Disconnect. Returns `null` when the canonical
 * node skill at `<installedWorkspace>/skills/dkg-node/SKILL.md` is absent
 * (clean retirement). Returns a descriptive string when it's still present —
 * the daemon's Disconnect path treats this as a failure to surface via
 * `runtime.lastError`, so the UI never reports "disconnected" while the
 * workspace still carries the adapter-owned skill doc (Codex PR #234 R2-2).
 *
 * Non-throwing by design.
 */
export function verifySkillRemoved(installedWorkspace: string): string | null {
  const targetPath = canonicalWorkspaceSkillPath(installedWorkspace);
  if (existsSync(targetPath)) {
    return `canonical node skill still present at ${targetPath}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 9: Verify
// ---------------------------------------------------------------------------

export async function verifySetup(
  apiPort: number,
  opts?: { openclawConfigPath?: string },
): Promise<void> {
  log('Verifying setup...');

  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/status`);
    if (res.ok) {
      const data = await res.json() as any;
      const peerId = data?.peerId ?? data?.result?.peerId ?? 'unknown';
      log(`Daemon reachable (peer ID: ${peerId})`);
    } else {
      warn(`Daemon returned ${res.status} on /api/status`);
    }
  } catch (err: any) {
    warn(`Could not reach daemon at port ${apiPort}: ${err.message}`);
  }

  // Check wallets exist (daemon writes { wallets: [...] })
  const walletsPath = join(dkgDir(), 'wallets.json');
  if (existsSync(walletsPath)) {
    try {
      const raw = JSON.parse(readFileSync(walletsPath, 'utf-8'));
      const list = Array.isArray(raw?.wallets) ? raw.wallets : Array.isArray(raw) ? raw : [];
      log(`${list.length} wallet(s) found`);
    } catch {
      warn('wallets.json is malformed — cannot verify wallet count');
    }
  } else {
    warn('wallets.json not found');
  }

  // Memory-authority post-install invariants. See the openclaw-dkg-primary-memory
  // plan §5.8 / §7 B1,B2,B13 gates.
  // B40: pass through the actual openclaw.json path the setup run merged
  // into, not the default `~/.openclaw/openclaw.json`. When the operator
  // runs `dkg openclaw setup --workspace ...`, verification must read
  // the same file setup wrote, otherwise it reports false slot-election
  // failures against an untouched default config.
  verifyMemorySlotInvariants(opts?.openclawConfigPath);

  log(`Node UI: http://127.0.0.1:${apiPort}/ui`);
}

/**
 * Memory-authority invariants that must hold after setup:
 *   (a) ~/.openclaw/openclaw.json plugins.slots.memory === "adapter-openclaw"
 *   (b) ~/.openclaw/openclaw.json plugins.slots.contextEngine !== "adapter-openclaw"
 *   (c) packages/adapter-openclaw/openclaw.plugin.json has "kind": "memory"
 * Logged as pass/fail per invariant. Non-throwing (warns on failure) so
 * that a partial install is still surfaced rather than hidden.
 */
export function verifyMemorySlotInvariants(configPath?: string): void {
  // B40: prefer the explicit path the setup run passed in — this is
  // the actual openclaw.json `mergeOpenClawConfig` wrote to, honoring
  // `--workspace` overrides. Fall back to the default
  // `~/.openclaw/openclaw.json` location only when no path was passed
  // (direct CLI invocation of the verify command, etc.).
  const openclawConfigPath = configPath && configPath.trim()
    ? configPath
    : join(openclawDir(), 'openclaw.json');
  if (!existsSync(openclawConfigPath)) {
    warn(`Memory-slot verification skipped: openclaw.json not found at ${openclawConfigPath}`);
    return;
  }

  try {
    const raw = readFileSync(openclawConfigPath, 'utf-8');
    const config = JSON.parse(raw);
    const slotMemory = config?.plugins?.slots?.memory;
    if (slotMemory === 'adapter-openclaw') {
      log('[verify] plugins.slots.memory === "adapter-openclaw" ✓');
    } else {
      warn(`[verify] plugins.slots.memory !== "adapter-openclaw" (got: ${JSON.stringify(slotMemory)}) — memory slot election FAILED`);
    }
    const slotContextEngine = config?.plugins?.slots?.contextEngine;
    if (slotContextEngine !== 'adapter-openclaw') {
      log(`[verify] plugins.slots.contextEngine !== "adapter-openclaw" ✓`);
    } else {
      warn(`[verify] plugins.slots.contextEngine === "adapter-openclaw" — wrong-slot guard FAILED`);
    }
  } catch (err: any) {
    warn(`[verify] Could not parse ${openclawConfigPath}: ${err.message}`);
  }

  const manifestPath = join(adapterRoot(), 'openclaw.plugin.json');
  if (!existsSync(manifestPath)) {
    warn(`[verify] openclaw.plugin.json not found at ${manifestPath} — manifest kind check SKIPPED`);
    return;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (manifest?.kind === 'memory') {
      log('[verify] openclaw.plugin.json has "kind": "memory" ✓');
    } else {
      warn(`[verify] openclaw.plugin.json kind !== "memory" (got: ${JSON.stringify(manifest?.kind)}) — manifest declaration FAILED`);
    }
  } catch (err: any) {
    warn(`[verify] Could not parse ${manifestPath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSetup(options: SetupOptions): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const shouldVerify = options.verify !== false;
  const shouldStart = options.start !== false;
  const apiPort = Number(options.port ?? '9200');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`Invalid port "${options.port}" — must be an integer between 1 and 65535`);
  }

  // Cooperative cancellation: check at each step boundary. Matches the
  // previous child-process model where SIGKILL only took effect between
  // steps, so we don't try to interrupt mid-call sync work like
  // `execSync('dkg start', ...)`.
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw new Error('Setup aborted');
    }
  };

  console.log('\nDKG OpenClaw Adapter Setup');
  console.log('='.repeat(40) + '\n');

  if (dryRun) {
    log('DRY RUN — no files will be modified\n');
  }

  // Step 1: Discover OpenClaw workspace
  throwIfAborted();
  const { configPath: openclawConfigPath, workspaceDir } = discoverWorkspace(options.workspace);
  log(`OpenClaw workspace: ${workspaceDir}`);

  // Step 2: Discover agent name
  throwIfAborted();
  const agentName = discoverAgentName(workspaceDir, options.name);
  log(`Agent name: ${agentName}`);

  // Step 3: Write DKG config
  throwIfAborted();
  let network: NetworkConfig | null = null;
  try {
    network = loadNetworkConfig();
  } catch (err: any) {
    if (dryRun) {
      warn(`Could not load network config: ${err.message}`);
      log('[dry-run] Skipping config write (network config unavailable)');
    } else {
      throw err;
    }
  }
  let effectivePort = apiPort;
  // The post-merge `name` wins over the freshly-discovered `agentName` for
  // downstream use (notably the faucet `callerId` / `Idempotency-Key`), so
  // that a later IDENTITY.md edit — which changes what `discoverAgentName`
  // returns — doesn't drift the faucet identity away from the node's
  // actual persisted identity. `writeDkgConfig` already enforces first-wins
  // on `name` unless `--name` was passed; this line makes the faucet caller
  // agree with whatever that enforcement produces. Starts as the pre-merge
  // value so the dry-run / skipped-writeDkgConfig path still has something
  // sensible to pass.
  let effectiveAgentName = agentName;
  if (!dryRun && network) {
    writeDkgConfig(agentName, network, apiPort, {
      nameExplicit: options.name != null,
      portExplicit: options.port != null,
    });
    // Read back the effective port AND effective name from the merged
    // config so downstream steps (daemon start, workspace config, verify,
    // faucet funding) use the persisted values even when an existing config
    // had a different apiPort or name that was preserved.
    try {
      const merged = JSON.parse(readFileSync(join(dkgDir(), 'config.json'), 'utf-8'));
      const mergedPort = Number(merged.apiPort);
      if (Number.isInteger(mergedPort) && mergedPort >= 1 && mergedPort <= 65535) {
        effectivePort = mergedPort;
      }
      if (typeof merged.name === 'string' && merged.name.trim()) {
        effectiveAgentName = merged.name.trim();
      }
    } catch { /* use pre-merge values */ }
  } else if (network) {
    log(`[dry-run] Would write ~/.dkg/config.json (${network.networkName}, port ${apiPort})`);
  }

  // Step 4: Preflight ~/.openclaw/openclaw.json BEFORE the daemon spins up
  // or the faucet is called.
  //
  // The preflight validates that openclaw.json exists, parses, is writable,
  // and isn't wrong-slot-wired (R6-2 + R8-2 from Codex PR #234). Running it
  // here — rather than inline inside Step 8 (merge) — means a deterministic
  // setup misconfiguration (missing openclaw.json, invalid JSON, etc.)
  // throws BEFORE startDaemon and the faucet call, so a user running
  // against a broken openclaw.json doesn't burn a slot of the 3-calls-per-8h
  // IP-level faucet budget on a setup that was always going to fail at
  // merge. The result is cached and reused by Step 8 below — no duplicate
  // reads or parses. `dryRun` short-circuits so dry-run stays a pure
  // no-op with no filesystem access beyond the workspace probe.
  throwIfAborted();
  const preflight = !dryRun ? preflightOpenClawConfig(openclawConfigPath) : null;

  // Step 5: Start daemon
  throwIfAborted();
  if (shouldStart && !dryRun) {
    await startDaemon(effectivePort);
  } else if (shouldStart) {
    log('[dry-run] Would start DKG daemon');
  } else {
    log('Skipping daemon start (--no-start)');
  }

  // Step 6: Read wallets and fund via testnet faucet.
  // Delegates to the shared `requestFaucetFunding` in `@origintrail-official/dkg-core`,
  // which is the same implementation the `dkg init` CLI path uses. The
  // faucet URL and mode come from `network.faucet.*`; a missing
  // `network.faucet.url` logs and skips (matches the CLI parity decision).
  // Faucet failures (HTTP error, thrown exception, `success === false`) log
  // a manual `curl` block and continue — setup is non-fatal on funding.
  // Wallet read retries 5×1s because the daemon writes `wallets.json`
  // asynchronously after the health check passes.
  throwIfAborted();
  const shouldFund = options.fund !== false;
  if (!dryRun && shouldFund) {
    const faucetUrl = network?.faucet?.url;
    const faucetMode = network?.faucet?.mode;
    if (!faucetUrl || !faucetMode) {
      log('Skipping wallet funding (no faucet configured in network config)');
    } else {
      // Retry only makes sense if we actually started the daemon this run —
      // with `--no-start`, the wallet file either exists already or never
      // will. `readWalletsWithRetry` is extracted to keep the loop bound
      // covered by unit tests (see test/setup.test.ts retry-accounting).
      const walletAddresses = shouldStart
        ? await readWalletsWithRetry()
        : readWallets();
      if (walletAddresses.length > 0) {
        log('Funding wallets via testnet faucet...');
        try {
          const result = await requestFaucetFunding(faucetUrl, faucetMode, walletAddresses, effectiveAgentName);
          if (result.success) {
            log(`Funded: ${result.funded.join(', ')}`);
          } else {
            warn(`Faucet request did not fund any wallets${result.error ? ` (${result.error})` : ''}`);
            logManualFundingInstructions(walletAddresses, faucetUrl, faucetMode);
          }
        } catch (err: any) {
          warn(`Faucet call failed: ${err?.message ?? String(err)}`);
          logManualFundingInstructions(walletAddresses, faucetUrl, faucetMode);
        }
      } else {
        warn('No wallet addresses available to fund (daemon did not produce wallets.json)');
      }
    }
  } else if (!dryRun && !shouldFund) {
    log('Skipping wallet funding (--no-fund)');
  } else {
    log('[dry-run] Would read wallets and fund via faucet');
  }

  // Steps 6–7: Install canonical skill + merge adapter into openclaw.json.
  // Use the script's own location as the adapter path — always correct for
  // the currently running code. Warn if the path looks ephemeral (npx cache).
  throwIfAborted();
  const resolvedAdapterPath = adapterRoot();
  if (isEphemeralPath(resolvedAdapterPath)) {
    warn(
      'Adapter is running from an npx cache path which may not persist.\n' +
      '         Install the DKG CLI globally for a stable plugin path:\n' +
      '         npm install -g @origintrail-official/dkg',
    );
  }
  const portExplicit = options.port != null;
  const entryConfig: AdapterEntryConfig = {
    daemonUrl: `http://127.0.0.1:${effectivePort}`,
    memory: { enabled: true },
    channel: { enabled: true },
  };

  // Codex PR #234 R3-3 / R4-2 / R5-2 / R5-3: workspace migration narrative.
  // If a prior install targeted a different workspace (e.g.
  // `dkg openclaw setup --workspace /dir-a` then `--workspace /dir-b`),
  // step 8b below retires the old SKILL.md — but only AFTER the new install
  // has fully landed (install-new → merge → cleanup-old). Canary-deploy
  // ordering: if install-new throws, openclaw.json still points at the
  // OLD workspace, which IS the real install, so a retry sees OLD as the
  // prior and migrates normally (R5-3).
  //
  // R6-2 + R8-2 preflight already ran at Step 4 (before daemon start and
  // the faucet call). The cached result is reused here for migration
  // discovery so we don't re-read or re-parse openclaw.json. Failure
  // modes like disk-full on write or backup rename remain covered by the
  // canary ordering + `openclaw-entry.mjs` sync-on-load self-heal — the
  // worst case is a retry where step 8b's migration cleans up any orphan.
  const priorInstalledForMigration = preflight?.priorInstalledForMigration ?? '';

  // Step 7: Install the canonical DKG node skill into the OpenClaw workspace
  // FIRST (canary). If this throws, openclaw.json is untouched and still
  // points at whatever the prior install was — user keeps a working install.
  // Step 4's preflight already guarantees step 8 won't then fail on an
  // easily-detectable config-level problem (missing / invalid-JSON /
  // non-writable), so the install→merge sequence is robust against the
  // Codex R6-2 failure modes.
  throwIfAborted();
  if (!dryRun) {
    installCanonicalNodeSkill(workspaceDir);
  } else {
    log('[dry-run] Would copy the canonical DKG node skill into the OpenClaw workspace');
  }

  // Step 8: Merge adapter wiring into openclaw.json. Flips `entry.config.installedWorkspace`
  // to the new workspace — safe now that the new SKILL.md is on disk (R5-3).
  throwIfAborted();
  if (!dryRun) {
    mergeOpenClawConfig(openclawConfigPath, resolvedAdapterPath, entryConfig, workspaceDir, {
      overrideDaemonUrl: portExplicit,
    });
  } else {
    log(`[dry-run] Would merge adapter (${resolvedAdapterPath}) into openclaw.json`);
  }

  // Step 8b: Workspace-migration cleanup — runs AFTER install-new + merge.
  // Strictly-additive install sequence (R4-2): if any earlier step throws,
  // the prior install's SKILL.md is still on disk, which is strictly better
  // than leaving the user with no install at all. A failure here still
  // leaves a working new install; a subsequent `dkg openclaw setup` re-run
  // would detect and clean the orphan naturally on the next migration pass.
  //
  // R6-3: `removeCanonicalNodeSkill` swallows unlink errors (locked file,
  // permissions, etc.) so the new-install path never fails on a best-effort
  // cleanup. But merge has already flipped `entry.config.installedWorkspace` to the
  // new path, so a silent-miss here would orphan the prior workspace's
  // SKILL.md permanently (Disconnect only knows about the new path). Call
  // `verifySkillRemoved` immediately after and surface residue as a loud
  // warning with the orphan path + explicit cleanup command. Not thrown —
  // the new install is valid; the residue is a stale-file nuisance, not a
  // broken install.
  //
  // R7-1: compare CANONICAL paths, not raw strings. Symlink aliases
  // (`/tmp/ws` ↔ `/private/tmp/ws` on macOS), case-only differences on
  // case-insensitive filesystems (NTFS, APFS), and relative/absolute
  // variants of the same directory can all look like a workspace change
  // through raw string compare — and the cleanup below would then delete
  // the just-installed SKILL.md through the old alias. `realpathSync`
  // resolves symlinks AND normalizes case/separators. Falls back to the
  // raw string when realpath throws (e.g. the prior workspace was deleted
  // off-disk between setups) — raw compare is still a correct lower-bound
  // for "definitely different paths".
  if (!dryRun && priorInstalledForMigration) {
    let priorCanonical = priorInstalledForMigration;
    let currentCanonical = workspaceDir;
    try { priorCanonical = realpathSync(priorInstalledForMigration); } catch { /* path gone — keep raw */ }
    try { currentCanonical = realpathSync(workspaceDir); } catch { /* path gone — keep raw */ }
    if (priorCanonical !== currentCanonical) {
      log(`Migrating install workspace: ${priorInstalledForMigration} → ${workspaceDir}`);
      removeCanonicalNodeSkill(priorInstalledForMigration);
      const residue = verifySkillRemoved(priorInstalledForMigration);
      if (residue) {
        const orphan = canonicalWorkspaceSkillPath(priorInstalledForMigration);
        warn(
          `Migration cleanup did not remove the old SKILL.md — ${residue}. ` +
          `The new install at ${workspaceDir} is functional, but the orphan ` +
          `must be removed manually: rm "${orphan}"`,
        );
      }
    }
  }

  // Prompt to reload gateway. Modern OpenClaw usually auto-restarts shortly
  // after config changes, but manual restart remains the safe fallback.
  log('Reload the OpenClaw gateway if it does not auto-restart after the config update');

  // Step 9: Verify
  throwIfAborted();
  if (shouldVerify && !dryRun) {
    await verifySetup(effectivePort, { openclawConfigPath });
  } else if (shouldVerify) {
    log('[dry-run] Would verify setup');
  }

  console.log('\n[setup] Done.\n');
}
