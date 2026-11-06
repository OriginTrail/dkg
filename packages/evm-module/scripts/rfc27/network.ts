// OT-RFC-27 script support: the chain guard. A script runs on Base Sepolia, or
// on a local anvil fork of it on 127.0.0.1, which web3_clientVersion and
// anvil_nodeInfo identify; every other chain is refused, mainnets by name.

import type { HardhatRuntimeEnvironment } from 'hardhat/types';

import { Redactor } from './report';

export const BASE_SEPOLIA_CHAIN_ID = 84532n;
export const LOCAL_HOST = '127.0.0.1';
export const MAINNETS: Readonly<Record<string, string>> = {
  '1': 'Ethereum mainnet',
  '8453': 'Base mainnet',
  '100': 'Gnosis mainnet',
  '2043': 'NeuroWeb mainnet',
};

/** The chain a script runs on: Base Sepolia, or the local fork of it. */
export type Net = { chainId: bigint; client: string; local: boolean; name: string; forkBlock?: bigint };

export async function rpc(hre: HardhatRuntimeEnvironment, method: string, params: unknown[] = []): Promise<unknown> {
  const result: unknown = await hre.network.provider.send(method, params);
  return result;
}

/** `o[key]` when `o` is an object, else undefined. */
export function field(o: unknown, key: string): unknown {
  return typeof o === 'object' && o !== null && key in o ? (o as Record<string, unknown>)[key] : undefined;
}

/**
 * Refuses every chain but Base Sepolia and a local anvil fork of it. The RPC
 * URL joins the redactor first: it may carry an API key, and is never printed.
 */
export async function guardNetwork(hre: HardhatRuntimeEnvironment, redactor: Redactor): Promise<Net> {
  const config = hre.network.config;
  const url = 'url' in config ? config.url : '';
  redactor.add(url);
  let host = '';
  try {
    host = url ? new URL(url).hostname : '';
  } catch {
    host = '';
  }
  const chainId = BigInt(String(await rpc(hre, 'eth_chainId')));
  const mainnet = MAINNETS[chainId.toString()];
  if (mainnet) throw new Error(`refusing to run: chain id ${chainId} is ${mainnet}; this script runs on Base Sepolia only`);
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) throw new Error(`refusing to run: chain id ${chainId} is not Base Sepolia's ${BASE_SEPOLIA_CHAIN_ID}`);
  const client = String(await rpc(hre, 'web3_clientVersion'));
  if (client.startsWith('anvil/')) {
    if (host !== LOCAL_HOST) throw new Error(`refusing to run: anvil answers on ${host || 'an in-process network'}, not on ${LOCAL_HOST}`);
    let forkBlock: unknown;
    try {
      forkBlock = field(field(await rpc(hre, 'anvil_nodeInfo'), 'forkConfig'), 'forkBlockNumber');
    } catch {
      forkBlock = undefined;
    }
    if (typeof forkBlock !== 'number' && typeof forkBlock !== 'string' && typeof forkBlock !== 'bigint') {
      throw new Error(`refusing to run: the anvil on ${LOCAL_HOST} is not a fork of Base Sepolia`);
    }
    return { chainId, client, local: true, name: `local anvil fork of Base Sepolia at block ${forkBlock}`, forkBlock: BigInt(forkBlock) };
  }
  if (['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', ''].includes(host)) {
    throw new Error(`refusing to run: a local node that is not anvil (${client}) cannot stand in for Base Sepolia`);
  }
  if (/hardhat|ganache|testrpc/i.test(client)) throw new Error(`refusing to run: ${client} is a local simulator`);
  return { chainId, client, local: false, name: 'Base Sepolia' };
}

/** The latest block's time, the chain's clock. */
export async function chainNow(hre: HardhatRuntimeEnvironment): Promise<bigint> {
  const block = await hre.ethers.provider.getBlock('latest');
  if (!block) throw new Error('no latest block');
  return BigInt(block.timestamp);
}
