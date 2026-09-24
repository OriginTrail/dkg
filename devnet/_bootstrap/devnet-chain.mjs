// Which Hardhat chain a devnet suite or script talks to, and a guard that it
// is the chain THIS checkout's devnet deployed.
//
// Several devnets can run on one machine: each checkout keeps its own
// `.devnet/`, and `scripts/devnet.sh` takes HARDHAT_PORT / API_PORT_BASE /
// LIBP2P_PORT_BASE / DEVNET_DOCKER_NAME_PREFIX overrides. Suites write to the
// chain (hardhat_setStorageAt, hardhat_setBalance, evm_increaseTime, staking
// and publish txs), so a suite pointed at another devnet's port silently
// corrupts that devnet. Two things make this easy to get wrong:
//
//   - a hard-coded `http://127.0.0.1:8545` reaches whichever devnet owns the
//     default port, and
//   - a fresh deploy puts the Hub at the SAME deterministic address on every
//     Hardhat chain, so "the Hub address has code" does not tell two devnets
//     apart.
//
// `scripts/devnet.sh start` therefore records the chain's RPC and its genesis
// block hash (the genesis timestamp is the Hardhat node's start time) under
// `.devnet/hardhat/`, and `assertDevnetChain` refuses any chain whose genesis
// differs.
//
// Plain ESM with no dependencies so the vitest suites (`import`) and the CJS
// scripts (`await import()`) share one implementation.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
export const DEVNET_DIR = join(REPO_ROOT, '.devnet');
export const DEVNET_CHAIN_ID = 31337;

const DEFAULT_RPC = 'http://127.0.0.1:8545';

function readTrimmed(path) {
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * The devnet's Hardhat RPC, in precedence order:
 *   1. DEVNET_RPC,
 *   2. http://127.0.0.1:$HARDHAT_PORT,
 *   3. `.devnet/hardhat/rpc_url`, written by `scripts/devnet.sh start`,
 *   4. node1's `chain.rpcUrl` (a devnet started before rpc_url was recorded),
 *   5. the default port 8545.
 * Whatever it picks, `assertDevnetChain` still has to accept the chain.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [devnetDir]
 * @returns {string}
 */
export function resolveDevnetRpc(env = process.env, devnetDir = DEVNET_DIR) {
  const explicit = env.DEVNET_RPC?.trim();
  if (explicit) return explicit;
  const port = env.HARDHAT_PORT?.trim();
  if (port) {
    if (!/^\d+$/.test(port)) throw new Error(`HARDHAT_PORT must be a port number, got "${port}"`);
    return `http://127.0.0.1:${port}`;
  }
  const recorded = readTrimmed(join(devnetDir, 'hardhat', 'rpc_url'));
  if (recorded) return recorded;
  try {
    const cfg = JSON.parse(readFileSync(join(devnetDir, 'node1', 'config.json'), 'utf8'));
    const url = cfg?.chain?.rpcUrl;
    if (typeof url === 'string' && url.trim()) return url.trim();
  } catch {
    // no node1 config yet
  }
  return DEFAULT_RPC;
}

export const DEVNET_RPC = resolveDevnetRpc();

async function jsonRpc(rpc, method, params) {
  let res;
  try {
    res = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(`devnet chain guard: ${method} to ${rpc} failed: ${err?.message ?? err}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    throw new Error(
      `devnet chain guard: ${method} to ${rpc} failed: `
      + `${body?.error?.message ?? `HTTP ${res.status}`}`,
    );
  }
  return body.result;
}

const verified = new Map();

/**
 * Throw unless the chain at `rpc` is the one `devnetDir` deployed: chain id
 * 31337, the recorded Hub address has code, and the genesis block hash equals
 * `.devnet/hardhat/genesis_hash`. Memoised per (rpc, devnetDir).
 *
 * @param {string} [rpc]
 * @param {{ devnetDir?: string }} [options]
 * @returns {Promise<{ rpc: string, hubAddress: string, genesisHash: string }>}
 */
export function assertDevnetChain(rpc = DEVNET_RPC, { devnetDir = DEVNET_DIR } = {}) {
  const key = `${rpc}\n${devnetDir}`;
  let pending = verified.get(key);
  if (!pending) {
    pending = verifyDevnetChain(rpc, devnetDir);
    verified.set(key, pending);
    pending.catch(() => verified.delete(key));
  }
  return pending;
}

async function verifyDevnetChain(rpc, devnetDir) {
  const hardhatDir = join(devnetDir, 'hardhat');
  const restart = 'start it with ./scripts/devnet.sh start 6 (same port overrides as this run)';
  const hubAddress = readTrimmed(join(hardhatDir, 'hub_address'));
  if (!/^0x[0-9a-fA-F]{40}$/.test(hubAddress)) {
    throw new Error(`devnet chain guard: ${hardhatDir}/hub_address is missing or invalid; ${restart}`);
  }
  const expectedGenesis = readTrimmed(join(hardhatDir, 'genesis_hash'));
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedGenesis)) {
    throw new Error(
      `devnet chain guard: ${hardhatDir}/genesis_hash is missing, so the chain at ${rpc} cannot be `
      + `proven to be this devnet's (a devnet started by an older scripts/devnet.sh records none); ${restart}`,
    );
  }

  const chainIdHex = await jsonRpc(rpc, 'eth_chainId', []);
  const chainId = Number(BigInt(chainIdHex));
  if (chainId !== DEVNET_CHAIN_ID) {
    throw new Error(`devnet chain guard: ${rpc} is chain ${chainId}, not the devnet chain ${DEVNET_CHAIN_ID}`);
  }
  const genesis = await jsonRpc(rpc, 'eth_getBlockByNumber', ['0x0', false]);
  const genesisHash = typeof genesis?.hash === 'string' ? genesis.hash : '';
  if (genesisHash.toLowerCase() !== expectedGenesis.toLowerCase()) {
    throw new Error(
      `devnet chain guard: the chain at ${rpc} is not the one ${devnetDir} deployed `
      + `(genesis ${genesisHash || 'unknown'}, expected ${expectedGenesis}). Another devnet probably `
      + `owns that port: point DEVNET_RPC (or HARDHAT_PORT) at this devnet's Hardhat node.`,
    );
  }
  const code = await jsonRpc(rpc, 'eth_getCode', [hubAddress, 'latest']);
  if (typeof code !== 'string' || code === '0x' || code === '') {
    throw new Error(`devnet chain guard: no Hub contract at ${hubAddress} on ${rpc}; ${restart}`);
  }
  return { rpc, hubAddress, genesisHash };
}
