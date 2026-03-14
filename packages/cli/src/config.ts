import { readFile, writeFile, mkdir, symlink, rename, unlink, readlink } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface AutoUpdateConfig {
  enabled: boolean;
  repo: string;
  branch: string;
  /** Allow auto-updating to pre-release versions (e.g. 9.0.5-rc.1). */
  allowPrerelease?: boolean;
  /** Optional SSH private key path for git-based update fetches/clones. */
  sshKeyPath?: string;
  /** Optional raw GIT_SSH_COMMAND override for git-based update fetches/clones. */
  sshCommand?: string;
  checkIntervalMinutes: number;
}

export interface NetworkConfig {
  networkName: string;
  networkId: string;
  genesisVersion: number;
  relays: string[];
  defaultParanets: string[];
  defaultNodeRole: 'core' | 'edge';
  autoUpdate?: {
    enabled: boolean;
    repo: string;
    branch: string;
    allowPrerelease?: boolean;
    sshKeyPath?: string;
    sshCommand?: string;
    checkIntervalMinutes: number;
  };
  chain?: {
    type: 'evm';
    rpcUrl: string;
    hubAddress: string;
    chainId: string;
  };
  faucet?: {
    url: string;
    mode: string;
  };
}

export interface ChainConfig {
  /** 'evm' for real blockchain, omit or 'mock' for in-memory (testing only) */
  type: 'evm' | 'mock';
  /** JSON-RPC endpoint URL */
  rpcUrl: string;
  /** Hub contract address */
  hubAddress: string;
  /** Chain identifier (e.g., 'base:84532') */
  chainId?: string;
}

/** Optional LLM config for the Node UI chatbot (OpenAI-compatible API). */
export interface LlmConfig {
  /** API key (e.g. OpenAI, Anthropic, or compatible provider). */
  apiKey: string;
  /** Model name (default: gpt-4o-mini). */
  model?: string;
  /** Base URL for the API (default: https://api.openai.com/v1). */
  baseURL?: string;
}

export interface DkgConfig {
  name: string;
  relay?: string;
  apiPort: number;
  /** Host to bind the API server (default '127.0.0.1', use '0.0.0.0' for external access). */
  apiHost?: string;
  listenPort: number;
  nodeRole: 'core' | 'edge';
  /** Public multiaddrs to announce (for VPS/cloud nodes where the public IP is not on the interface). */
  announceAddresses?: string[];
  /** Bootstrap peer multiaddrs to connect to on startup (for direct peer discovery without relay). */
  bootstrapPeers?: string[];
  paranets?: string[];
  autoUpdate?: AutoUpdateConfig;
  chain?: ChainConfig;
  /** Optional LLM for the Node UI chatbot (natural language → SPARQL, answers). */
  llm?: LlmConfig;
  /** Block explorer URL for TX links (default: derived from chainId). */
  blockExplorerUrl?: string;
  /** Triple store backend override (default: oxigraph-worker with file persistence). */
  store?: { backend: string; options?: Record<string, unknown> };
  /** Set to true when this node is used with the OpenClaw adapter. Controls Agent Hub tab visibility. */
  openclawAdapter?: boolean;
  /** Optional OpenClaw bridge/gateway routing hints for the local channel transport. */
  openclawChannel?: {
    bridgeUrl?: string;
    gatewayUrl?: string;
  };
  /**
   * API authentication. When enabled, all non-public endpoints require
   * a Bearer token in the Authorization header. A token is auto-generated
   * on first start and stored in `<DKG_HOME>/auth.token`.
   */
  auth?: { enabled?: boolean; tokens?: string[] };
  /** Opt-in telemetry streaming to central network dashboard. */
  telemetry?: { enabled?: boolean };
  /** Workspace data TTL in milliseconds. Default: 30 days (2592000000). Set to 0 to disable cleanup. */
  workspaceTtlMs?: number;
}

/**
 * Hardcoded per-network telemetry endpoints.
 * Nodes resolve the correct endpoints from the network they're on.
 * Operators only see a single toggle — no endpoint configuration.
 */
export const TELEMETRY_ENDPOINTS: Record<string, { syslog: { host: string; port: number }; otlp: string }> = {
  testnet: {
    syslog: { host: 'loggly.origin-trail.network', port: 12201 },
    otlp: 'https://telemetry-testnet.origintrail.io/v1/metrics',
  },
  mainnet: {
    syslog: { host: 'loggly.origin-trail.network', port: 0 }, // TODO: assign mainnet syslog port
    otlp: 'https://telemetry.origintrail.io/v1/metrics',
  },
};

const DEFAULT_CONFIG: DkgConfig = {
  name: 'dkg-node',
  apiPort: 9200,
  listenPort: 0,
  nodeRole: 'edge',
  paranets: [],
};

let _networkConfig: NetworkConfig | null = null;

/**
 * Load the network config from network/testnet.json.
 *
 * Candidate paths (tried in order):
 *  1. Monorepo root when running from packages/cli/dist/
 *  2. Monorepo root when running from packages/cli/src/ during dev
 *  3. Bundled alongside dist/ in the published NPM package (dist/../network/)
 *
 * Monorepo paths are checked first so that edits to the repo-root
 * network/testnet.json are picked up immediately during development
 * without requiring a rebuild of the CLI package.
 */
export async function loadNetworkConfig(): Promise<NetworkConfig | null> {
  if (_networkConfig) return _networkConfig;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(thisDir, '..', '..', '..', 'network', 'testnet.json'),       // monorepo from dist/
      join(thisDir, '..', '..', '..', '..', 'network', 'testnet.json'), // monorepo from src/ during dev
      join(thisDir, '..', 'network', 'testnet.json'),                   // NPM package (network/ at package root)
    ];
    for (const path of candidates) {
      try {
        const raw = await readFile(path, 'utf-8');
        _networkConfig = JSON.parse(raw) as NetworkConfig;
        return _networkConfig;
      } catch { /* try next */ }
    }
    return null;
  } catch {
    return null;
  }
}

export function dkgDir(): string {
  if (process.env.DKG_HOME) return process.env.DKG_HOME;
  if (repoDir()) return join(homedir(), '.dkg-dev');
  return join(homedir(), '.dkg');
}

/**
 * Resolve the repo root from the compiled code location.
 * Works from packages/cli/dist/ (compiled) or packages/cli/src/ (dev).
 */
export function findRepoDir(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function repoDir(): string | null {
  return findRepoDir(dirname(fileURLToPath(import.meta.url)));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function gitCommandEnv(autoUpdate?: Pick<AutoUpdateConfig, 'sshKeyPath' | 'sshCommand'> | null): NodeJS.ProcessEnv {
  const sshCommand = process.env.DKG_GIT_SSH_COMMAND?.trim() || autoUpdate?.sshCommand?.trim();
  const sshKeyPath = process.env.DKG_SSH_KEY_PATH?.trim() || autoUpdate?.sshKeyPath?.trim();
  const env = { ...process.env };

  if (sshCommand) {
    env.GIT_SSH_COMMAND = sshCommand;
    return env;
  }

  if (sshKeyPath) {
    env.GIT_SSH_COMMAND = `ssh -i ${shellQuote(sshKeyPath)} -o IdentitiesOnly=yes`;
  }

  return env;
}

function githubHttpsRepo(repoUrl: string | undefined): boolean {
  if (!repoUrl) return false;
  return /^https:\/\/github\.com\//i.test(repoUrl.trim());
}

export function gitCommandArgs(
  repoUrl?: string,
  autoUpdate?: Pick<AutoUpdateConfig, 'sshKeyPath' | 'sshCommand'> | null,
): string[] {
  const token = process.env.GITHUB_TOKEN?.trim();
  const sshCommand = process.env.DKG_GIT_SSH_COMMAND?.trim() || autoUpdate?.sshCommand?.trim();
  const sshKeyPath = process.env.DKG_SSH_KEY_PATH?.trim() || autoUpdate?.sshKeyPath?.trim();
  if (!token || sshCommand || sshKeyPath || !githubHttpsRepo(repoUrl)) return [];

  const basic = Buffer.from(`x-access-token:${token}`, 'utf-8').toString('base64');
  return ['-c', `http.extraHeader=Authorization: Basic ${basic}`];
}

export function releasesDir(): string {
  return join(dkgDir(), 'releases');
}

/** Read the active slot from the `releases/current` symlink. Falls back to the `active` file. */
export async function activeSlot(): Promise<'a' | 'b' | null> {
  try {
    const raw = await readlink(join(releasesDir(), 'current'));
    const target = basename(raw);
    if (target === 'a' || target === 'b') return target;
  } catch { /* symlink doesn't exist */ }
  try {
    const raw = (await readFile(join(releasesDir(), 'active'), 'utf-8')).trim();
    if (raw === 'a' || raw === 'b') return raw;
  } catch { /* file doesn't exist */ }
  return null;
}

export async function inactiveSlot(): Promise<'a' | 'b'> {
  const active = await activeSlot();
  return (active ?? 'a') === 'a' ? 'b' : 'a';
}

/**
 * Atomically swap the `releases/current` symlink to point to `target` slot.
 * Uses tmp-symlink + rename to avoid any window where the symlink is broken.
 */
export async function swapSlot(target: 'a' | 'b'): Promise<void> {
  const rDir = releasesDir();
  const currentLink = join(rDir, 'current');
  const tmpLink = join(rDir, 'current.tmp');

  // Check if already pointing to target
  try {
    const dest = await readlink(currentLink);
    if (dest === target) {
      await writeFile(join(rDir, 'active'), target);
      return;
    }
  } catch { /* link doesn't exist yet */ }

  try { await unlink(tmpLink); } catch { /* ok if missing */ }
  await symlink(target, tmpLink);
  await rename(tmpLink, currentLink);
  await writeFile(join(rDir, 'active'), target);
}

export function configPath(): string {
  return join(dkgDir(), 'config.json');
}

export function pidPath(): string {
  return join(dkgDir(), 'daemon.pid');
}

export function logPath(): string {
  return join(dkgDir(), 'daemon.log');
}

export function apiPortPath(): string {
  return join(dkgDir(), 'api.port');
}

export async function ensureDkgDir(): Promise<void> {
  await mkdir(dkgDir(), { recursive: true });
}

export async function loadConfig(): Promise<DkgConfig> {
  try {
    const raw = await readFile(configPath(), 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: DkgConfig): Promise<void> {
  await ensureDkgDir();
  await writeFile(configPath(), JSON.stringify(config, null, 2) + '\n');
}

export function configExists(): boolean {
  return existsSync(configPath());
}

export async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(pidPath(), 'utf-8');
    return parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

export async function writePid(pid: number): Promise<void> {
  await writeFile(pidPath(), String(pid));
}

export async function removePid(): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(pidPath());
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') throw err;
  }
}

export async function readApiPort(): Promise<number | null> {
  try {
    const raw = await readFile(apiPortPath(), 'utf-8');
    return parseInt(raw.trim(), 10);
  } catch {
    return null;
  }
}

export async function writeApiPort(port: number): Promise<void> {
  await writeFile(apiPortPath(), String(port));
}

export async function removeApiPort(): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(apiPortPath());
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOENT') throw err;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── NPM / standalone helpers ────────────────────────────────────────

export const CLI_NPM_PACKAGE = '@origintrail-official/dkg';

/**
 * True when running from an `npm install`-ed package rather than a
 * monorepo checkout. In standalone mode the auto-updater uses NPM
 * instead of git to fetch new versions.
 */
export function isStandaloneInstall(): boolean {
  return repoDir() === null;
}

/**
 * Resolve the CLI entry point within a blue-green slot.
 * Supports both git layout (packages/cli/dist/cli.js) and
 * NPM layout (node_modules/@origintrail-official/dkg/dist/cli.js).
 */
export function slotEntryPoint(slotDir: string): string | null {
  const gitPath = join(slotDir, 'packages', 'cli', 'dist', 'cli.js');
  if (existsSync(gitPath)) return gitPath;
  const npmPath = join(slotDir, 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js');
  if (existsSync(npmPath)) return npmPath;
  return null;
}
