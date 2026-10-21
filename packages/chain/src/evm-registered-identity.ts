// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import type { VerifyACKIdentityResult } from './chain-adapter.js';
import { OPERATIONAL_KEY_PURPOSE } from './evm-adapter-constants.js';

/** The ACK and chain-cache trust boundary uses the same operational-key and active membership gate. */
export async function verifyEvmRegisteredIdentity<Contract>(ports: {
  resolve(name: 'IdentityStorage' | 'ShardingTableStorage'): Promise<Contract | null | undefined>;
  keyHasPurpose(contract: Contract, id: bigint, key: string, purpose: number): Promise<boolean>;
  nodeExists(contract: Contract, id: bigint): Promise<boolean>;
}, signer: string, identityId: bigint, signal?: AbortSignal): Promise<VerifyACKIdentityResult> {
  signal?.throwIfAborted();
  const identity = await ports.resolve('IdentityStorage');
  signal?.throwIfAborted();
  if (!identity) return { valid: false, reason: 'rpc-error' };
  const key = ethers.keccak256(ethers.solidityPacked(['address'], [signer]));
  const registered = await ports.keyHasPurpose(identity, identityId, key, OPERATIONAL_KEY_PURPOSE);
  signal?.throwIfAborted();
  if (!registered) return { valid: false, reason: 'key-not-registered' };
  const table = await ports.resolve('ShardingTableStorage');
  signal?.throwIfAborted();
  if (!table) return { valid: false, reason: 'rpc-error' };
  const active = await ports.nodeExists(table, identityId);
  signal?.throwIfAborted();
  return active ? { valid: true } : { valid: false, reason: 'not-in-sharding-table' };
}
