/**
 * EVMChainAdapter node operational-wallet management — add/remove WIRING +
 * the primary-wallet safety guard. No live RPC / Hardhat: construct the
 * adapter, stub init()/identity reads, and override sendContractTransaction
 * to capture which contract+method+signer the write would target.
 *
 * The security-critical assertions here:
 *   - add → Profile.addOperationalWallets signed by the ADMIN key (not the op signer)
 *   - remove → Identity.removeKey with the keccak key-hash, signed by the ADMIN key
 *   - remove REFUSES the bound primary operational wallet before any tx
 *   - both throw cleanly when no admin key is configured
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // hardhat #0
const ADMIN_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // hardhat #1
const EXTERNAL = '0x' + 'e'.repeat(40);

function minimalConfig(overrides: Partial<EVMAdapterConfig> = {}): EVMAdapterConfig {
  return {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    ...overrides,
  };
}

function makeAdapter(opts: { admin?: boolean; identityId?: bigint } = {}) {
  const cfg = minimalConfig(opts.admin === false ? {} : { adminPrivateKey: ADMIN_PK });
  const a = new EVMChainAdapter(cfg);
  (a as any).init = async () => undefined;
  (a as any).getIdentityStorage = async () => ({ __isIdentityStorage: true });
  (a as any).hasAdminPurpose = async () => true;
  (a as any).getIdentityId = async () => opts.identityId ?? 5n;
  const calls: Array<{ contract: string; method: string; args: any[]; signer: string }> = [];
  (a as any).sendContractTransaction = async (contract: any, method: string, args: any[], signer: any) => {
    calls.push({ contract: contract?.__name ?? 'unknown', method, args, signer: signer?.address });
    return { hash: '0xtx', blockNumber: 1, index: 0, status: 1 };
  };
  (a as any).contracts.profile = { __name: 'profile', getAddress: async () => '0xprofile' };
  (a as any).contracts.identity = { __name: 'identity', getAddress: async () => '0xidentity' };
  return { a, calls };
}

describe('EVMChainAdapter.addOperationalWallet', () => {
  it('authorizes via Profile.addOperationalWallets signed by the admin key', async () => {
    const { a, calls } = makeAdapter();
    const r = await a.addOperationalWallet(EXTERNAL);
    expect(r.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].contract).toBe('profile');
    expect(calls[0].method).toBe('addOperationalWallets');
    expect(calls[0].args[0]).toBe(5n);
    expect(calls[0].args[1]).toEqual([ethers.getAddress(EXTERNAL)]);
    // MUST be signed by the admin key (onlyAdmin), not the primary op signer.
    expect(calls[0].signer).toBe(new ethers.Wallet(ADMIN_PK).address);
    expect(calls[0].signer).not.toBe((a as any).signer.address);
  });

  it('throws when no admin key is configured', async () => {
    const { a, calls } = makeAdapter({ admin: false });
    await expect(a.addOperationalWallet(EXTERNAL)).rejects.toThrow(/adminPrivateKey is not configured/);
    expect(calls).toHaveLength(0);
  });

  it('rejects a malformed address', async () => {
    const { a } = makeAdapter();
    await expect(a.addOperationalWallet('not-an-address')).rejects.toThrow(/invalid address/);
  });

  it('throws when the node has no on-chain profile', async () => {
    const { a } = makeAdapter({ identityId: 0n });
    await expect(a.addOperationalWallet(EXTERNAL)).rejects.toThrow(/no on-chain profile/);
  });
});

describe('EVMChainAdapter.removeOperationalWallet', () => {
  it('de-authorizes via Identity.removeKey with the keccak key-hash, signed by the admin key', async () => {
    const { a, calls } = makeAdapter();
    await a.removeOperationalWallet(EXTERNAL);
    expect(calls).toHaveLength(1);
    expect(calls[0].contract).toBe('identity');
    expect(calls[0].method).toBe('removeKey');
    expect(calls[0].args[0]).toBe(5n);
    const expectedHash = ethers.keccak256(ethers.solidityPacked(['address'], [ethers.getAddress(EXTERNAL)]));
    expect(calls[0].args[1]).toBe(expectedHash);
    expect(calls[0].signer).toBe(new ethers.Wallet(ADMIN_PK).address);
  });

  it('REFUSES to remove the bound primary operational wallet, before any tx', async () => {
    const { a, calls } = makeAdapter();
    const primary = (a as any).signer.address as string;
    await expect(a.removeOperationalWallet(primary)).rejects.toThrow(/refusing to remove the node's primary/);
    expect(calls).toHaveLength(0);
  });

  it('throws when no admin key is configured', async () => {
    const { a, calls } = makeAdapter({ admin: false });
    await expect(a.removeOperationalWallet(EXTERNAL)).rejects.toThrow(/adminPrivateKey is not configured/);
    expect(calls).toHaveLength(0);
  });
});
