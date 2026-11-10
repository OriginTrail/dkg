/**
 * The marketplace lane's reach into its devnet, outside the browser: each
 * node's HTTP API (as the default suite reaches it, through the node's
 * `api.port` and the devnet's shared token), the Hardhat chain's JSON-RPC,
 * and the deployed contracts' addresses. The specs drive the UI; these are
 * for setup, for waiting on the chain, and for reading what the UI should
 * show.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { devnetApiFetch, readDevnetNode } from '../helpers/devnet.js';
import { DOCKER_NAME_PREFIX, PORTS } from './topology.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * The devnet's directory: the default suite's, so its bootstrap, teardown and
 * Vite config find it. So one checkout runs one devnet suite at a time. This
 * lane's setup refuses to start while any node answers here; the default
 * suite, started while this lane runs, would reuse this lane's nodes and its
 * teardown would stop them.
 */
export const DEVNET_DIR = resolve(REPO_ROOT, '.devnet');
const CONTRACTS_FILE = resolve(REPO_ROOT, 'packages/evm-module/deployments/localhost_contracts.json');
export const RPC_URL = `http://127.0.0.1:${PORTS.hardhat}`;

/** The environment `scripts/devnet.sh` reads, for this lane's ports and container names. */
export function devnetEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEVNET_DIR,
    HARDHAT_PORT: String(PORTS.hardhat),
    API_PORT_BASE: String(PORTS.apiBase),
    LIBP2P_PORT_BASE: String(PORTS.libp2pBase),
    DEVNET_OXIGRAPH_BASE: String(PORTS.oxigraphBase),
    DEVNET_BLAZEGRAPH_PORT: String(PORTS.blazegraph),
    DEVNET_DOCKER_NAME_PREFIX: DOCKER_NAME_PREFIX,
  };
}

/** What the setup built, written by `bootstrap.ts` once the lane is ready: for the specs, and for whoever reads a failed run. */
export const SETUP_FILE = resolve(DEVNET_DIR, 'marketplace-e2e.json');

export interface MarketplaceSetup {
  contextGraphId: string;
  onChainId: string;
  seller: { node: number; identityId: number; peerId: string };
  buyer: { node: number; wallet: string };
  plain: { node: number };
}

export function readSetup(): MarketplaceSetup {
  if (!existsSync(SETUP_FILE)) throw new Error(`${SETUP_FILE} is missing: the marketplace setup did not finish`);
  return JSON.parse(readFileSync(SETUP_FILE, 'utf8')) as MarketplaceSetup;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a value, or throw `what` after `timeoutMs`; the last error, if any, goes with it. */
export async function waitFor<T>(what: string, probe: () => Promise<T | undefined | null | false>, timeoutMs: number, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      const detail = last instanceof Error ? `: ${last.message}` : last !== undefined ? `: ${String(last)}` : '';
      throw new Error(`${what} did not happen within ${Math.round(timeoutMs / 1000)} s${detail}`);
    }
    await sleep(intervalMs);
  }
}

export interface NodeAnswer<T> { status: number; body: T }

/** One call to a node's API, as its operator (the devnet's token), with the JSON answer. */
export async function nodeCall<T = unknown>(nodeNum: number, method: string, path: string, body?: unknown): Promise<NodeAnswer<T>> {
  const res = await devnetApiFetch(path, {
    nodeNum,
    devnetDir: DEVNET_DIR,
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: kept as text for the error message.
  }
  return { status: res.status, body: parsed as T };
}

/** `nodeCall`, which throws unless the node answers 2xx. */
export async function nodeOk<T = unknown>(nodeNum: number, method: string, path: string, body?: unknown): Promise<T> {
  const answer = await nodeCall<T>(nodeNum, method, path, body);
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`node${nodeNum} ${method} ${path} answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  }
  return answer.body;
}

/** Whether node `nodeNum` has an `api.port` and answers `/api/status`. */
export async function nodeUp(nodeNum: number): Promise<boolean> {
  if (!readDevnetNode(nodeNum, DEVNET_DIR)) return false;
  try {
    return (await nodeCall(nodeNum, 'GET', '/api/status')).status === 200;
  } catch {
    return false;
  }
}

export interface NodeStatus { identityId?: string; peerId?: string; connectedPeers?: number; nodeRole?: string }
export const statusOf = (nodeNum: number) => nodeOk<NodeStatus>(nodeNum, 'GET', '/api/status');

// ── the chain ───────────────────────────────────────────────────────────────

let rpcId = 0;

/** One JSON-RPC call to the devnet's Hardhat node. */
export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = (await res.json()) as { result?: T; error?: { message?: string } };
  if (answer.error) throw new Error(`${method}: ${answer.error.message ?? JSON.stringify(answer.error)}`);
  return answer.result as T;
}

/** Whether something answers JSON-RPC on the lane's Hardhat port. */
export async function chainUp(): Promise<boolean> {
  try {
    await rpc('eth_chainId');
    return true;
  } catch {
    return false;
  }
}

/** A deployed contract's address, from the deployment the devnet wrote. */
export function contractAddress(name: string): Address {
  if (!existsSync(CONTRACTS_FILE)) throw new Error(`${CONTRACTS_FILE} is missing: the devnet has not deployed its contracts`);
  const deployed = JSON.parse(readFileSync(CONTRACTS_FILE, 'utf8')) as { contracts?: Record<string, { evmAddress?: string }> };
  const address = deployed.contracts?.[name]?.evmAddress;
  if (!address) throw new Error(`no ${name} in ${CONTRACTS_FILE}`);
  return address as Address;
}

/** A read of a deployed contract, through `eth_call`. */
export async function readContract<T>(contract: string, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const raw = await rpc<Hex>('eth_call', [{ to: contractAddress(contract), data }, 'latest']);
  return decodeFunctionResult({ abi, functionName, data: raw } as Parameters<typeof decodeFunctionResult>[0]) as T;
}

/** The deployer: Hardhat's first unlocked account, which holds the Token's mint rights on the devnet. */
async function deployer(): Promise<Address> {
  const [first] = await rpc<Address[]>('eth_accounts');
  if (!first) throw new Error('the Hardhat node lists no unlocked account');
  return first;
}

/** Send a transaction from the deployer and wait for it to be mined. */
async function sendFromDeployer(to: Address, data: Hex): Promise<void> {
  const hash = await rpc<Hex>('eth_sendTransaction', [{ from: await deployer(), to, data }]);
  const receipt = await waitFor('the transaction to be mined', () => rpc<{ status?: Hex } | null>('eth_getTransactionReceipt', [hash]), 60_000, 500);
  if (receipt.status !== '0x1') throw new Error(`transaction ${hash} reverted`);
}

const TOKEN_ABI = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address owner) view returns (uint256)']);

/** Fund `address` as `scripts/devnet.sh` funds a node's operational wallets: its ETH set with `hardhat_setBalance`, TRAC minted by the deployer. */
export async function fundWallet(address: Address, { ethWei, tracWei }: { ethWei?: bigint; tracWei?: bigint }): Promise<void> {
  if (ethWei !== undefined) await rpc('hardhat_setBalance', [address, `0x${ethWei.toString(16)}`]);
  if (tracWei !== undefined && tracWei > 0n) {
    await sendFromDeployer(contractAddress('Token'), encodeFunctionData({ abi: TOKEN_ABI, functionName: 'mint', args: [address, tracWei] }));
  }
}

export const tracBalanceOf = (address: Address) => readContract<bigint>('Token', TOKEN_ABI, 'balanceOf', [address]);
export const ethBalanceOf = async (address: Address) => BigInt(await rpc<Hex>('eth_getBalance', [address, 'latest']));

const CHRONOS_ABI = parseAbi([
  'function epochAtTimestamp(uint256 timestamp) view returns (uint256)',
  'function timestampForEpoch(uint256 epoch) view returns (uint256)',
]);

export interface EpochTimes { epoch: number; startsAt: number; endsAt: number; now: number }

/** The chain's epoch now, as the node reads it: from the latest block's time. */
export async function epochTimes(): Promise<EpochTimes> {
  const block = await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false]);
  const now = Number(BigInt(block.timestamp));
  const epoch = await readContract<bigint>('Chronos', CHRONOS_ABI, 'epochAtTimestamp', [BigInt(now)]);
  const [startsAt, endsAt] = await Promise.all([
    readContract<bigint>('Chronos', CHRONOS_ABI, 'timestampForEpoch', [epoch]),
    readContract<bigint>('Chronos', CHRONOS_ABI, 'timestampForEpoch', [epoch + 1n]),
  ]);
  return { epoch: Number(epoch), startsAt: Number(startsAt), endsAt: Number(endsAt), now };
}

/** Move the chain's clock `seconds` ahead and mine a block at the new time. */
export async function advanceChainTime(seconds: number): Promise<void> {
  await rpc('evm_increaseTime', [seconds]);
  await rpc('evm_mine');
}

const CONTEXT_GRAPH_STORAGE_ABI = parseAbi([
  'function isContextGraphActive(uint256 contextGraphId) view returns (bool)',
  'function getAccessPolicy(uint256 contextGraphId) view returns (uint8)',
  'function getPublishPolicy(uint256 contextGraphId) view returns (uint8 publishPolicy, address publishAuthority)',
]);

/** A context graph's registration as `ContextGraphStorage` holds it. */
export async function contextGraphOnChain(onChainId: bigint): Promise<{ active: boolean; accessPolicy: number; publishPolicy: number }> {
  const [active, accessPolicy, publish] = await Promise.all([
    readContract<boolean>('ContextGraphStorage', CONTEXT_GRAPH_STORAGE_ABI, 'isContextGraphActive', [onChainId]),
    readContract<number>('ContextGraphStorage', CONTEXT_GRAPH_STORAGE_ABI, 'getAccessPolicy', [onChainId]),
    readContract<readonly [number, Address]>('ContextGraphStorage', CONTEXT_GRAPH_STORAGE_ABI, 'getPublishPolicy', [onChainId]),
  ]);
  return { active, accessPolicy: Number(accessPolicy), publishPolicy: Number(publish[0]) };
}
