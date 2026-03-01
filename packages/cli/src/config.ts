import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface AutoUpdateConfig {
  enabled: boolean;
  repo: string;
  branch: string;
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
    checkIntervalMinutes: number;
  };
  chain?: {
    type: 'evm';
    rpcUrl: string;
    hubAddress: string;
    chainId: string;
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
  paranets?: string[];
  autoUpdate?: AutoUpdateConfig;
  chain?: ChainConfig;
  /** Optional LLM for the Node UI chatbot (natural language → SPARQL, answers). */
  llm?: LlmConfig;
  /** Block explorer URL for TX links (default: derived from chainId). */
  blockExplorerUrl?: string;
}

const DEFAULT_CONFIG: DkgConfig = {
  name: 'dkg-node',
  apiPort: 9200,
  listenPort: 0,
  nodeRole: 'edge',
  paranets: [],
};

let _networkConfig: NetworkConfig | null = null;

/**
 * Load the network config from network/testnet.json in the repo root.
 * Walks up from this file's location to find it.
 */
export async function loadNetworkConfig(): Promise<NetworkConfig | null> {
  if (_networkConfig) return _networkConfig;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    // Walk up from packages/cli/dist (or src) to repo root
    const candidates = [
      join(thisDir, '..', '..', '..', 'network', 'testnet.json'),   // from dist/
      join(thisDir, '..', '..', '..', '..', 'network', 'testnet.json'), // from src/ during dev
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
  return join(homedir(), '.dkg');
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
