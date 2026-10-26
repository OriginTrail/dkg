// Shared devnet plumbing for the OT-RFC-27 marketplace test console
// (server.mjs) and its seeder (seed.mjs). Devnet test tooling only: reads the
// `.devnet/nodeN` homes that scripts/devnet.sh writes, talks to the node APIs
// with each node's bearer token, and reads/writes the local Hardhat chain with
// ethers (contract addresses resolved through the Hub, like the e2e suite).
//
// Money is bigint wei end to end. Nothing in here ever hands a private key or
// a bearer token to a caller that could forward it to a browser.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

export const CONSOLE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(CONSOLE_DIR, '../../..');
export const DEVNET_DIR = process.env.DEVNET_DIR ?? join(REPO_ROOT, '.devnet');
export const RPC = process.env.DEVNET_RPC ?? 'http://127.0.0.1:8545';
export const NODE_NUMS = [1, 2, 3, 4, 5, 6];
export const SCALE18 = 10n ** 18n;
export const WEI_PER_TRAC = 10n ** 18n;

/** Console roles (fixed by the devnet suite convention: A = node1, buyer = node2, B = node3). */
export const ROLES = {
  1: { key: 'seller-a', label: 'Seller A' },
  2: { key: 'buyer', label: 'Buyer' },
  3: { key: 'seller-b', label: 'Seller B' },
};

export function roleLabel(num, nodeRole) {
  const role = ROLES[num];
  const tier = nodeRole ?? (num <= 4 ? 'core' : 'edge');
  return role ? `${role.label} · node${num} (${tier})` : `node${num} (${tier})`;
}

// ───────────────────────────── node homes ─────────────────────────────

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function nodeHome(num) {
  return join(DEVNET_DIR, `node${num}`);
}

/** Public node facts (no keys): ports, tier, op wallet addresses, peer id. */
export function readNode(num) {
  const home = nodeHome(num);
  const config = readJsonFile(join(home, 'config.json')) ?? {};
  const wallets = readJsonFile(join(home, 'wallets.json')) ?? {};
  let peerId;
  try {
    const multiaddr = readFileSync(join(home, 'multiaddr'), 'utf8').trim();
    peerId = /\/p2p\/([^/\s]+)$/.exec(multiaddr)?.[1];
  } catch {
    /* node not started yet */
  }
  const opWallets = (Array.isArray(wallets.wallets) ? wallets.wallets : [])
    .map((w) => w?.address)
    .filter((a) => typeof a === 'string' && ethers.isAddress(a))
    .map((a) => ethers.getAddress(a));
  return {
    num,
    home,
    exists: existsSync(home),
    apiPort: Number.isInteger(config.apiPort) ? config.apiPort : 9200 + num,
    name: typeof config.name === 'string' ? config.name : `devnet-node-${num}`,
    nodeRole: config.nodeRole === 'core' || config.nodeRole === 'edge' ? config.nodeRole : (num <= 4 ? 'core' : 'edge'),
    marketplaceEnabled: config.marketplace?.enabled === true,
    peerId,
    opWallets,
    adminWallet: typeof wallets.adminWallet?.address === 'string' ? wallets.adminWallet.address : undefined,
  };
}

/**
 * The node's bearer token: the LAST non-empty, non-comment line of
 * `.devnet/nodeN/auth.token`. Re-read on every call so a devnet restart
 * (which may rotate the token) needs no console restart.
 */
export function readToken(num) {
  try {
    const lines = readFileSync(join(nodeHome(num), 'auth.token'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    return lines.at(-1) ?? '';
  } catch {
    return '';
  }
}

/** JSON call to a node API with its token injected. Never throws on HTTP status. */
export async function nodeFetch(num, path, { method = 'GET', body, timeoutMs = 30_000, auth = true } = {}) {
  const node = readNode(num);
  const headers = { Accept: 'application/json' };
  const token = auth ? readToken(num) : '';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${node.apiPort}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

// ───────────────────────────── console memory ─────────────────────────────
// The node APIs do not echo back the plan policy (bucket labels, caps) or the
// seller's offering set, so the console remembers what it last sent. Lives in
// the devnet dir: `devnet.sh clean` wipes it together with the chain.

export const STATE_FILE = join(DEVNET_DIR, 'marketplace-console.json');

export function readConsoleState() {
  const state = readJsonFile(STATE_FILE);
  return state && typeof state === 'object' ? { plans: {}, offerings: {}, ...state } : { plans: {}, offerings: {} };
}

export function updateConsoleState(mutator) {
  const state = readConsoleState();
  mutator(state);
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
  return state;
}

// ───────────────────────────── chain ─────────────────────────────

const CHRONOS_ABI = [
  'function startTime() view returns (uint256)',
  'function epochLength() view returns (uint256)',
  'function getCurrentEpoch() view returns (uint256)',
  'function timestampForEpoch(uint256) view returns (uint256)',
];
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
];
const IDENTITY_STORAGE_ABI = ['function getIdentityId(address) view returns (uint72)'];
const HUB_ABI = ['function getContractAddress(string) view returns (address)'];

export function readHubAddress() {
  const contracts = readJsonFile(join(REPO_ROOT, 'packages/evm-module/deployments/localhost_contracts.json'));
  const hub = contracts?.contracts?.Hub?.evmAddress ?? contracts?.Hub;
  if (typeof hub !== 'string' || !ethers.isAddress(hub)) {
    throw new Error('Hub address not found in packages/evm-module/deployments/localhost_contracts.json — is the devnet deployed?');
  }
  return ethers.getAddress(hub);
}

let chainCache;
/** Monotonic chain-clock offset estimate (see `chainNow`). */
const clock = { maxOffset: undefined, lastBlock: -1, genesis: undefined };

async function rawRpc(method, params = []) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

/**
 * Lazily-built chain context: provider + Hub-resolved contracts. Rebuilt when
 * the Hub address in the deployments file changes (devnet redeployed).
 */
export async function getChain() {
  const hubAddress = readHubAddress();
  if (chainCache && chainCache.hubAddress === hubAddress) return chainCache;
  const chainIdHex = await rawRpc('eth_chainId');
  const network = ethers.Network.from(Number(BigInt(chainIdHex)));
  // cacheTimeout -1: ethers dedupes identical requests for 250 ms by default,
  // so a block read right after evm_increaseTime + evm_mine would return the
  // cached pre-warp block. The console needs every read to be fresh.
  const provider = new ethers.JsonRpcProvider(RPC, network, { staticNetwork: network, cacheTimeout: -1 });
  const hub = new ethers.Contract(hubAddress, HUB_ABI, provider);
  const resolveName = async (name, required = true) => {
    let addr = ethers.ZeroAddress;
    try {
      addr = await hub.getContractAddress(name);
    } catch {
      /* unregistered name */
    }
    if (addr === ethers.ZeroAddress && required) {
      throw new Error(`${name} is not registered in the devnet Hub (${hubAddress}) — redeploy the devnet from this branch`);
    }
    return addr;
  };
  const [marketplaceAddr, storageAddr, chronosAddr, tokenAddr, identityAddr] = await Promise.all([
    resolveName('Marketplace'),
    resolveName('MarketplaceStorage'),
    resolveName('Chronos'),
    resolveName('Token'),
    resolveName('IdentityStorage'),
  ]);
  const abi = (name) => JSON.parse(readFileSync(join(REPO_ROOT, `packages/chain/abi/${name}.json`), 'utf8'));
  chainCache = {
    hubAddress,
    chainId: network.chainId,
    provider,
    addrs: {
      Hub: hubAddress,
      Marketplace: marketplaceAddr,
      MarketplaceStorage: storageAddr,
      Chronos: chronosAddr,
      Token: tokenAddr,
      IdentityStorage: identityAddr,
    },
    marketplace: new ethers.Contract(marketplaceAddr, abi('Marketplace'), provider),
    storage: new ethers.Contract(storageAddr, abi('MarketplaceStorage'), provider),
    chronos: new ethers.Contract(chronosAddr, CHRONOS_ABI, provider),
    token: new ethers.Contract(tokenAddr, TOKEN_ABI, provider),
    identityStorage: new ethers.Contract(identityAddr, IDENTITY_STORAGE_ABI, provider),
    chronosParams: undefined,
  };
  clock.maxOffset = undefined;
  clock.lastBlock = -1;
  return chainCache;
}

/** Drop the cached chain context (after an RPC/contract failure). */
export function resetChain() {
  chainCache = undefined;
}

export async function chronosParams(chain) {
  if (!chain.chronosParams) {
    const [startTime, epochLength] = await Promise.all([chain.chronos.startTime(), chain.chronos.epochLength()]);
    chain.chronosParams = { startTime, epochLength };
  }
  return chain.chronosParams;
}

/** Chronos epoch math mirrored in bigint (getCurrentEpoch at timestamp `t`). */
export function epochAt(params, t) {
  if (t < params.startTime) return 1n;
  return (t - params.startTime) / params.epochLength + 1n;
}

export function epochStart(params, epoch) {
  return epoch === 0n ? 0n : params.startTime + (epoch - 1n) * params.epochLength;
}

/**
 * Chain "now" — the timestamp the NEXT block will carry. Hardhat automines,
 * so the latest block can be stale while wall time moves on; the next block
 * is stamped `wall + offset` (offset grows with evm_increaseTime). Every
 * observation `latest.timestamp − wall` is a lower bound of that offset, so
 * the running maximum converges on it. Never below the latest block time.
 */
export async function chainNow(chain) {
  const block = await chain.provider.getBlock('latest');
  const wall = BigInt(Math.floor(Date.now() / 1000));
  const ts = BigInt(block.timestamp);
  const offset = ts - wall;
  if (clock.maxOffset === undefined || block.number < clock.lastBlock || offset > clock.maxOffset) {
    clock.maxOffset = offset;
  }
  clock.lastBlock = block.number;
  const estimate = wall + clock.maxOffset;
  return {
    now: estimate > ts ? estimate : ts,
    latestBlockTimestamp: ts,
    blockNumber: block.number,
    wall,
  };
}

/** Mine one block so the latest block timestamp is exact (devnet-only). */
export async function mineBlock(chain) {
  await chain.provider.send('evm_mine', []);
}

export async function timeWarp(chain, seconds) {
  await chain.provider.send('evm_increaseTime', [Number(seconds)]);
  await chain.provider.send('evm_mine', []);
}

/**
 * TOP UP `address` by `addWei` TRAC via a direct ERC-20 balance-slot write
 * (Token = Ownable, ERC20, AccessControl → `_balances` at slot 1, the same
 * approach as devnet/_bootstrap/harness.ts `fundTrac`). Read-modify-write so
 * the wallet's existing balance (real node capital) is preserved.
 */
export async function topUpTrac(chain, address, addWei) {
  const before = BigInt(await chain.token.balanceOf(address));
  const target = before + addWei;
  const slotKey = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [address, 1n]));
  await chain.provider.send('hardhat_setStorageAt', [
    chain.addrs.Token,
    slotKey,
    ethers.zeroPadValue(ethers.toBeHex(target), 32),
  ]);
  const after = BigInt(await chain.token.balanceOf(address));
  if (after !== target) {
    throw new Error(`TRAC top-up mismatch for ${address}: expected ${target}, got ${after} (ERC20 _balances slot moved?)`);
  }
  return { before, after, added: addWei };
}

// ───────────────────────────── amounts ─────────────────────────────

/** Exact decimal TRAC string → wei (no floats). */
export function parseTracToWei(value) {
  const s = String(value ?? '').trim();
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s);
  if (!m) throw new Error(`not a decimal TRAC amount with at most 18 decimals: "${s}"`);
  return BigInt(m[1]) * WEI_PER_TRAC + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}

/** wei → exact decimal TRAC string. */
export function formatTrac(wei) {
  const v = BigInt(wei);
  if (v < 0n) return `-${formatTrac(-v)}`;
  const whole = v / WEI_PER_TRAC;
  const frac = (v % WEI_PER_TRAC).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** wei → exact decimal µTRAC string (1 µTRAC = 1e12 wei). */
export function formatMicroTrac(wei) {
  const v = BigInt(wei);
  if (v < 0n) return `-${formatMicroTrac(-v)}`;
  const whole = v / 10n ** 12n;
  const frac = (v % 10n ** 12n).toString().padStart(12, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** JSON replacer: bigint → decimal string (the node APIs' wire convention). */
export function bigintReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
