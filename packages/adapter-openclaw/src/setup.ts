/**
 * Non-interactive setup script for the DKG OpenClaw adapter.
 *
 * Handles the entire DKG node + adapter setup end-to-end:
 *  1. Install DKG CLI (full node) via npm if not present
 *  2. Discover OpenClaw workspace and agent name
 *  3. Write ~/.dkg/config.json with testnet defaults
 *  4. Start the DKG daemon
 *  5. Fund wallets via testnet faucet
 *  6. Merge adapter plugin into ~/.openclaw/openclaw.json
 *  7. Write workspace config.json with feature flags
 *  8. Copy the canonical DKG node skill into the OpenClaw workspace
 *  9. Verify setup
 *
 * Every step is idempotent — re-running is safe.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
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
  fund?: boolean;
  verify?: boolean;
  start?: boolean;
  dryRun?: boolean;
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

function canonicalWorkspaceSkillPath(workspaceDir: string): string {
  return join(workspaceDir, 'skills', 'dkg-node', 'SKILL.md');
}

// ---------------------------------------------------------------------------
// Step 1: Install DKG CLI
// ---------------------------------------------------------------------------

export function installDkgCli(): void {
  try {
    const version = execSync('dkg --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    log(`DKG CLI already installed (${version})`);
    return;
  } catch {
    // Not installed — proceed to install
  }

  log('Installing DKG CLI (full node)... npm install -g @origintrail-official/dkg');
  try {
    execSync('npm install -g @origintrail-official/dkg', { stdio: 'inherit' });
    const version = execSync('dkg --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    log(`DKG CLI installed (${version})`);
  } catch (err: any) {
    throw new Error(`Failed to install DKG CLI: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Discover OpenClaw workspace
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
// Step 3: Discover agent name
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
// Step 4: Write DKG config
// ---------------------------------------------------------------------------

export function loadNetworkConfig(): NetworkConfig {
  // Try resolving from the installed CLI package first
  try {
    // Use dynamic resolution — CLI is installed globally
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const candidates = [
      join(npmPrefix, 'lib', 'node_modules', '@origintrail-official', 'dkg', 'network', 'testnet.json'),
      join(npmPrefix, 'node_modules', '@origintrail-official', 'dkg', 'network', 'testnet.json'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, 'utf-8'));
      }
    }
  } catch { /* fall through */ }

  // Monorepo fallback
  const monorepoPath = resolve(__dirname, '..', '..', '..', 'network', 'testnet.json');
  if (existsSync(monorepoPath)) {
    return JSON.parse(readFileSync(monorepoPath, 'utf-8'));
  }

  // Another monorepo path (from src/ during dev)
  const devPath = resolve(__dirname, '..', '..', '..', '..', 'network', 'testnet.json');
  if (existsSync(devPath)) {
    return JSON.parse(readFileSync(devPath, 'utf-8'));
  }

  throw new Error(
    'Could not find network/testnet.json. Ensure the DKG CLI is installed ' +
    '(npm install -g @origintrail-official/dkg).',
  );
}

function resolveCanonicalNodeSkillSourcePath(): string {
  const localWorkspaceCandidate = resolve(adapterRoot(), '..', 'cli', 'skills', 'dkg-node', 'SKILL.md');
  if (existsSync(localWorkspaceCandidate)) return localWorkspaceCandidate;

  try {
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const candidates = [
      join(npmPrefix, 'lib', 'node_modules', '@origintrail-official', 'dkg', 'skills', 'dkg-node', 'SKILL.md'),
      join(npmPrefix, 'node_modules', '@origintrail-official', 'dkg', 'skills', 'dkg-node', 'SKILL.md'),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* fall through */ }

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
// Step 6: Read wallets and fund via faucet
// ---------------------------------------------------------------------------

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

export async function fundWallets(addresses: string[]): Promise<void> {
  if (!addresses.length) {
    warn('No wallet addresses to fund');
    return;
  }

  log('Funding wallets via testnet faucet...');
  try {
    // Use a stable idempotency key based on wallet addresses so re-runs
    // don't create duplicate faucet requests and hit rate limits.
    const idempotencyKey = `dkg-openclaw-setup-${addresses.sort().join('-')}`;
    const res = await fetch('https://euphoria.origin-trail.network/faucet/fund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        mode: 'v9_base_sepolia',
        wallets: addresses,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      log(`Faucet response: ${JSON.stringify(data)}`);
    } else {
      const text = await res.text();
      warn(`Faucet returned ${res.status}: ${text}`);
      logManualFundingInstructions(addresses);
    }
  } catch (err: any) {
    warn(`Faucet call failed: ${err.message}`);
    logManualFundingInstructions(addresses);
  }
}

function logManualFundingInstructions(addresses: string[]): void {
  console.log('\nTo fund wallets manually, run:');
  console.log(`  curl -X POST "https://euphoria.origin-trail.network/faucet/fund" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -H "Idempotency-Key: $(date +%s)" \\`);
  console.log(`    --data-raw '{"mode":"v9_base_sepolia","wallets":${JSON.stringify(addresses)}}'`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Step 7: Merge adapter into openclaw.json
// ---------------------------------------------------------------------------

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

  const pluginId = 'adapter-openclaw';
  // Normalize adapter path to forward slashes for cross-platform compatibility
  const normalizedPath = adapterPath.replace(/\\/g, '/');
  const isAdapterLoadPath = (value: string): boolean => {
    const normalized = value.replace(/\\/g, '/').toLowerCase();
    return normalized.includes('/@origintrail-official/dkg-adapter-openclaw')
      || normalized.endsWith('/packages/adapter-openclaw')
      || normalized.includes('/packages/adapter-openclaw/');
  };

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

// ---------------------------------------------------------------------------
// Step 8: Write workspace config
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
// Step 9: Copy the canonical DKG node skill into the OpenClaw workspace
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
// Step 10: Verify
// ---------------------------------------------------------------------------

export async function verifySetup(apiPort: number): Promise<void> {
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

  log(`Node UI: http://127.0.0.1:${apiPort}/ui`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runSetup(options: SetupOptions): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const shouldFund = options.fund !== false;
  const shouldVerify = options.verify !== false;
  const shouldStart = options.start !== false;
  const apiPort = Number(options.port ?? '9200');
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error(`Invalid port "${options.port}" — must be an integer between 1 and 65535`);
  }

  console.log('\nDKG OpenClaw Adapter Setup');
  console.log('='.repeat(40) + '\n');

  if (dryRun) {
    log('DRY RUN — no files will be modified\n');
  }

  // Step 1: Ensure DKG CLI is installed
  if (!dryRun) {
    installDkgCli();
  } else {
    log('[dry-run] Would install DKG CLI if not present');
  }

  // Step 2: Discover OpenClaw workspace
  const { configPath: openclawConfigPath, workspaceDir } = discoverWorkspace(options.workspace);
  log(`OpenClaw workspace: ${workspaceDir}`);

  // Step 3: Discover agent name
  const agentName = discoverAgentName(workspaceDir, options.name);
  log(`Agent name: ${agentName}`);

  // Step 4: Write DKG config
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

  // Step 5: Start daemon
  if (shouldStart && !dryRun) {
    await startDaemon(effectivePort);
  } else if (shouldStart) {
    log('[dry-run] Would start DKG daemon');
  } else {
    log('Skipping daemon start (--no-start)');
  }

  // Step 6: Read wallets and optionally fund
  // Retry a few times since wallets.json may be written slightly after daemon start.
  let walletAddresses: string[] = [];
  if (!dryRun) {
    walletAddresses = readWallets();
    if (!walletAddresses.length && shouldStart) {
      for (let i = 0; i < 5 && !walletAddresses.length; i++) {
        await sleep(1_000);
        walletAddresses = readWallets();
      }
    }
    if (shouldFund && walletAddresses.length > 0) {
      await fundWallets(walletAddresses);
    } else if (!shouldFund) {
      log('Skipping wallet funding (--no-fund)');
    }
  } else {
    log('[dry-run] Would read wallets and fund via faucet');
  }

  // Step 7: Merge adapter into openclaw.json
  // Use the script's own location as the adapter path — always correct for
  // the currently running code. Warn if the path looks ephemeral (npx cache).
  const resolvedAdapterPath = adapterRoot();
  if (isEphemeralPath(resolvedAdapterPath)) {
    warn(
      'Adapter is running from an npx cache path which may not persist.\n' +
      '         Install the adapter globally for a stable plugin path:\n' +
      '         npm install -g @origintrail-official/dkg-adapter-openclaw',
    );
  }
  if (!dryRun) {
    mergeOpenClawConfig(openclawConfigPath, resolvedAdapterPath);
  } else {
    log(`[dry-run] Would merge adapter (${resolvedAdapterPath}) into openclaw.json`);
  }

  // Step 8: Write workspace config
  if (!dryRun) {
    writeWorkspaceConfig(workspaceDir, effectivePort, options.port != null);
  } else {
    log('[dry-run] Would write workspace config.json');
  }

  // Step 9: Copy the canonical DKG node skill into the OpenClaw workspace
  if (!dryRun) {
    installCanonicalNodeSkill(workspaceDir);
  } else {
    log('[dry-run] Would copy the canonical DKG node skill into the OpenClaw workspace');
  }

  // Prompt to reload gateway. Modern OpenClaw usually auto-restarts shortly
  // after config changes, but manual restart remains the safe fallback.
  log('Reload the OpenClaw gateway if it does not auto-restart after the config update');

  // Step 10: Verify
  if (shouldVerify && !dryRun) {
    await verifySetup(effectivePort);
  } else if (shouldVerify) {
    log('[dry-run] Would verify setup');
  }

  console.log('\n[setup] Done.\n');
}
