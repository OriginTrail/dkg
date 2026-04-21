/**
 * Non-interactive setup script for the DKG OpenClaw adapter.
 *
 * Handles the entire DKG node + adapter setup end-to-end:
 *  1. Discover OpenClaw workspace and agent name
 *  2. Write ~/.dkg/config.json with testnet defaults
 *  3. Start the DKG daemon
 *  4. Merge adapter plugin into ~/.openclaw/openclaw.json
 *  5. Write workspace config.json with feature flags
 *  6. Copy the canonical DKG node skill into the OpenClaw workspace
 *  7. Verify setup
 *
 * Every step is idempotent — re-running is safe.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

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

  // Try multiple paths where workspace might be configured
  const workspaceDir: string | undefined =
    config?.agents?.defaults?.workspace ??
    config?.workspace ??
    config?.workspaceDir;

  if (workspaceDir) {
    const expanded = workspaceDir.replace(/^~/, homedir());
    // Resolve relative paths from the config file's directory, not cwd,
    // so setup produces the same result regardless of working directory.
    const resolved = resolve(dirname(configPath), expanded);
    return { configPath, workspaceDir: resolved };
  }

  // Default workspace location
  const defaultWs = join(openclawDir(), 'workspace');
  if (existsSync(defaultWs)) {
    return { configPath, workspaceDir: defaultWs };
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

  // Fallback: generate a unique name
  const id = Math.random().toString(36).slice(2, 7);
  const name = `openclaw-agent-${id}`;
  warn(`Could not determine agent name from IDENTITY.md — using "${name}"`);
  return name;
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

  // Explicit CLI overrides (--name, --port) take precedence over existing config.
  // Auto-detected values only fill in when no existing value is present.
  const config: Record<string, any> = {
    ...existing,
    name: overrides?.nameExplicit ? agentName : (existing.name ?? agentName),
    apiPort: overrides?.portExplicit ? apiPort : (existing.apiPort ?? apiPort),
    nodeRole: existing.nodeRole ?? (network.defaultNodeRole as 'edge' | 'core'),
    contextGraphs: existing.contextGraphs
      ?? existing.paranets
      ?? network.defaultContextGraphs
      ?? network.defaultParanets,
    chain: existing.chain ?? network.chain,
    auth: existing.auth ?? { enabled: true },
  };

  // Preserve an existing relay override but never pin a new one — the daemon
  // reads the full relay list from network config (testnet.json) automatically,
  // which is better than hard-coding a single relay into the user's config.
  if (existing.relay) {
    config.relay = existing.relay;
  }

  // Preserve auto-update from network defaults if not set
  if (!existing.autoUpdate && network.autoUpdate) {
    config.autoUpdate = network.autoUpdate;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  log(`Wrote ${configPath} (${network.networkName}, ${config.nodeRole}, port ${config.apiPort})`);
}

// ---------------------------------------------------------------------------
// Step 4: Start DKG daemon
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
    // Use dkg start which handles the daemon lifecycle
    execSync('dkg start', { stdio: 'inherit', timeout: 30_000 });
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
// Step 5: Merge adapter into openclaw.json
// ---------------------------------------------------------------------------

const ADAPTER_PLUGIN_ID = 'adapter-openclaw';

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

export function mergeOpenClawConfig(openclawConfigPath: string, adapterPath: string): void {
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

  // Ensure plugin-registered tools are visible to the agent
  if (!config.tools) config.tools = {};
  if (!Array.isArray(config.tools.alsoAllow)) {
    // Preserve existing string value if present
    const existing = config.tools.alsoAllow;
    config.tools.alsoAllow = existing ? [existing] : [];
  }
  if (!config.tools.alsoAllow.includes('group:plugins')) {
    config.tools.alsoAllow.push('group:plugins');
    log('Added "group:plugins" to tools.alsoAllow');
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
    if (config.plugins.slots.memory && config.plugins.slots.memory !== pluginId) {
      log(`plugins.slots.memory was "${config.plugins.slots.memory}" — overwriting with "${pluginId}"`);
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
 *   - flips `plugins.entries["adapter-openclaw"].enabled = false` (keeps other fields)
 *   - clears `plugins.slots.memory` iff it currently equals `"adapter-openclaw"`
 *
 * Leaves `tools.alsoAllow` (shared with other plugins), workspace `config.json`
 * (user-owned), and any workspace `SKILL.md` copies alone. Idempotent — a
 * second call produces zero diff. Backs up to `.bak.<ts>` only when content
 * changes (same contract as merge).
 */
export function unmergeOpenClawConfig(openclawConfigPath: string): void {
  if (!openclawConfigPath || !existsSync(openclawConfigPath)) {
    openclawConfigPath = join(openclawDir(), 'openclaw.json');
    if (!existsSync(openclawConfigPath)) {
      throw new Error(`openclaw.json not found at ${openclawConfigPath}`);
    }
  }

  const raw = readFileSync(openclawConfigPath, 'utf-8');
  const config = JSON.parse(raw);
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

  // Flip entry.enabled to false (preserve other plugin-specific fields)
  if (config.plugins && config.plugins.entries) {
    const entry = config.plugins.entries[pluginId];
    if (entry && typeof entry === 'object' && entry.enabled !== false) {
      entry.enabled = false;
      log(`Disabled ${pluginId} in plugins.entries`);
    }
  }

  // Clear slots.memory iff it still points at the adapter
  if (config.plugins && config.plugins.slots && config.plugins.slots.memory === pluginId) {
    delete config.plugins.slots.memory;
    log(`Cleared plugins.slots.memory (was "${pluginId}")`);
  }

  const updated = JSON.stringify(config, null, 2) + '\n';
  if (updated === raw) {
    log('openclaw.json already disconnected from adapter — no changes needed');
    return;
  }

  // Backup only when content actually changes (same contract as mergeOpenClawConfig)
  const backupPath = `${openclawConfigPath}.bak.${Date.now()}`;
  writeFileSync(backupPath, raw);

  writeFileSync(openclawConfigPath, updated);
  log(`Unmerged adapter from ${openclawConfigPath} (backed up original)`);
}

// ---------------------------------------------------------------------------
// Step 6: Write workspace config
// ---------------------------------------------------------------------------

export function writeWorkspaceConfig(workspaceDir: string, apiPort: number, portExplicit?: boolean): void {
  const configPath = join(workspaceDir, 'config.json');

  let existing: Record<string, any> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      warn(`Could not parse ${configPath} — will overwrite`);
    }
  }

  // Deep-merge: preserve existing dkg-node sub-config.
  // daemonUrl is only overridden when --port is explicitly passed; otherwise
  // the existing value is kept so custom URLs (e.g. remote daemons) survive re-runs.
  // Feature flags default to true on first run but are not overridden on re-runs
  // so that user-configured `false` values are respected.
  const dkgNode = existing['dkg-node'] ?? {};
  const nextDkgNode = {
    ...dkgNode,
    daemonUrl: portExplicit ? `http://127.0.0.1:${apiPort}` : (dkgNode.daemonUrl ?? `http://127.0.0.1:${apiPort}`),
    memory: { enabled: true, ...dkgNode.memory },
    channel: { enabled: true, ...dkgNode.channel },
  };
  if (nextDkgNode.game !== undefined) {
    delete nextDkgNode.game;
    log('Removed legacy dkg-node.game config from workspace config');
  }
  existing['dkg-node'] = nextDkgNode;

  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
  log('Wrote workspace config (memory=on, channel=on)');
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

// ---------------------------------------------------------------------------
// Step 8: Verify
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
  if (!dryRun && network) {
    writeDkgConfig(agentName, network, apiPort, {
      nameExplicit: options.name != null,
      portExplicit: options.port != null,
    });
    // Read back the effective port from the merged config so downstream steps
    // (daemon start, workspace config, verify) use the correct port even when
    // an existing config had a different apiPort that was preserved.
    try {
      const merged = JSON.parse(readFileSync(join(dkgDir(), 'config.json'), 'utf-8'));
      const mergedPort = Number(merged.apiPort);
      if (Number.isInteger(mergedPort) && mergedPort >= 1 && mergedPort <= 65535) {
        effectivePort = mergedPort;
      }
    } catch { /* use apiPort */ }
  } else if (network) {
    log(`[dry-run] Would write ~/.dkg/config.json (${network.networkName}, port ${apiPort})`);
  }

  // Step 4: Start daemon
  throwIfAborted();
  if (shouldStart && !dryRun) {
    await startDaemon(effectivePort);
  } else if (shouldStart) {
    log('[dry-run] Would start DKG daemon');
  } else {
    log('Skipping daemon start (--no-start)');
  }

  // Step 5: Merge adapter into openclaw.json
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
  if (!dryRun) {
    mergeOpenClawConfig(openclawConfigPath, resolvedAdapterPath);
  } else {
    log(`[dry-run] Would merge adapter (${resolvedAdapterPath}) into openclaw.json`);
  }

  // Step 6: Write workspace config
  throwIfAborted();
  if (!dryRun) {
    writeWorkspaceConfig(workspaceDir, effectivePort, options.port != null);
  } else {
    log('[dry-run] Would write workspace config.json');
  }

  // Step 7: Copy the canonical DKG node skill into the OpenClaw workspace
  throwIfAborted();
  if (!dryRun) {
    installCanonicalNodeSkill(workspaceDir);
  } else {
    log('[dry-run] Would copy the canonical DKG node skill into the OpenClaw workspace');
  }

  // Prompt to reload gateway. Modern OpenClaw usually auto-restarts shortly
  // after config changes, but manual restart remains the safe fallback.
  log('Reload the OpenClaw gateway if it does not auto-restart after the config update');

  // Step 8: Verify
  throwIfAborted();
  if (shouldVerify && !dryRun) {
    await verifySetup(effectivePort, { openclawConfigPath });
  } else if (shouldVerify) {
    log('[dry-run] Would verify setup');
  }

  console.log('\n[setup] Done.\n');
}
