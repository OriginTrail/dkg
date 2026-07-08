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

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

function makeAdapter(opts: {
  admin?: boolean;
  identityId?: bigint;
  adminPurposeWallets?: string[];
  operationalPurposeWallets?: string[];
  identityLookupValues?: bigint[];
} = {}) {
  const cfg = minimalConfig(opts.admin === false ? {} : { adminPrivateKey: ADMIN_PK });
  const a = new EVMChainAdapter(cfg);
  (a as any).init = async () => undefined;
  (a as any).getIdentityStorage = async () => ({ __isIdentityStorage: true });
  (a as any).resolveContract = async (name: string) => ({ __name: name });
  let identityLookupIndex = 0;
  const readContract = recorder(async (_contract: any, _label: string, method: string) => {
    if (method === 'getIdentityId') {
      const values = opts.identityLookupValues ?? [0n];
      const value = values[Math.min(identityLookupIndex, values.length - 1)];
      identityLookupIndex++;
      return value;
    }
    return 0n;
  });
  (a as any).readContract = readContract;
  // Purpose-aware: the configured admin key (plus any extras the test marks)
  // reads back as an on-chain ADMIN_KEY; everything else does not. The default
  // lets removing an ordinary external op wallet proceed while still exercising
  // the admin-key check on the admin signer — and lets a test mark the REMOVE
  // TARGET as an admin key to assert the de-admin guard fires.
  const adminPurposeSet = new Set(
    [new ethers.Wallet(ADMIN_PK).address, ...(opts.adminPurposeWallets ?? [])].map((w) => w.toLowerCase()),
  );
  (a as any).hasAdminPurpose = async (_s: any, _id: bigint, addr: string) =>
    adminPurposeSet.has(String(addr).toLowerCase());
  // Purpose-aware operational check (mirrors hasAdminPurpose): by default the
  // ordinary external op wallet reads back as an OPERATIONAL_KEY so removal
  // proceeds; a test can pass an empty/explicit set to exercise the positive
  // operational-key guard.
  const operationalPurposeSet = new Set(
    (opts.operationalPurposeWallets ?? [EXTERNAL]).map((w) => w.toLowerCase()),
  );
  (a as any).hasOperationalPurpose = async (_s: any, _id: bigint, addr: string) =>
    operationalPurposeSet.has(String(addr).toLowerCase());
  (a as any).getIdentityId = async () => opts.identityId ?? 5n;
  const calls: Array<{ contract: string; method: string; args: any[]; signer: string }> = [];
  (a as any).sendContractTransaction = async (contract: any, method: string, args: any[], signer: any) => {
    calls.push({ contract: contract?.__name ?? 'unknown', method, args, signer: signer?.address });
    return { hash: '0xtx', blockNumber: 1, index: 0, status: 1 };
  };
  (a as any).contracts.profile = { __name: 'profile', getAddress: async () => '0xprofile' };
  (a as any).contracts.identity = { __name: 'identity', getAddress: async () => '0xidentity' };
  return { a, calls, readContract };
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

  it('seeds the identity lookup cache after a successful public add', async () => {
    const { a, readContract } = makeAdapter({ identityId: 5n, identityLookupValues: [0n, 99n] });

    await expect(a.getIdentityIdForAddress(EXTERNAL)).resolves.toBe(0n);
    expect(readContract.calls).toHaveLength(1);

    await a.addOperationalWallet(EXTERNAL);

    await expect(a.getIdentityIdForAddress(EXTERNAL)).resolves.toBe(5n);
    expect(readContract.calls).toHaveLength(1);
  });

  it('marks the wallet RS-eligible on a successful add (positive registration path)', async () => {
    // The inverse of the remove-prune test below: without this set-add a
    // just-registered wallet would silently stay out of RS rotation until
    // the next daemon restart.
    const { a } = makeAdapter();
    expect((a as any).registeredOperationalAddresses.has(EXTERNAL.toLowerCase())).toBe(false);
    await a.addOperationalWallet(EXTERNAL);
    expect((a as any).registeredOperationalAddresses.has(EXTERNAL.toLowerCase())).toBe(true);
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

  it('clears the identity lookup cache after a successful public removal', async () => {
    const { a, readContract } = makeAdapter({ identityId: 5n, identityLookupValues: [5n, 0n] });

    await expect(a.getIdentityIdForAddress(EXTERNAL)).resolves.toBe(5n);
    expect(readContract.calls).toHaveLength(1);

    await a.removeOperationalWallet(EXTERNAL);

    await expect(a.getIdentityIdForAddress(EXTERNAL)).resolves.toBe(0n);
    expect(readContract.calls).toHaveLength(2);
  });

  it('prunes the removed wallet from the RS eligibility set (no longer selectable for random sampling)', async () => {
    const { a } = makeAdapter({ identityId: 5n });
    // Simulate the wallet having been confirmed-registered earlier.
    (a as any).registeredOperationalAddresses.add(EXTERNAL.toLowerCase());
    expect((a as any).registeredOperationalAddresses.has(EXTERNAL.toLowerCase())).toBe(true);

    await a.removeOperationalWallet(EXTERNAL);

    // Pruned → rotatable-free (RS) eligibility can no longer select it, so a
    // just-decommissioned wallet can't be signed with and revert on-chain.
    expect((a as any).registeredOperationalAddresses.has(EXTERNAL.toLowerCase())).toBe(false);
  });

  it('REFUSES to remove the bound primary operational wallet, before any tx', async () => {
    const { a, calls } = makeAdapter();
    const primary = (a as any).signer.address as string;
    await expect(a.removeOperationalWallet(primary)).rejects.toThrow(/refusing to remove the node's primary/);
    expect(calls).toHaveLength(0);
  });

  it('REFUSES to remove a wallet that is itself an on-chain ADMIN key (de-admin guard), before any tx', async () => {
    // `removeKey` deletes by hash regardless of purpose, so removing a target
    // that holds ADMIN_KEY purpose would strip admin control. Guard must fire.
    const { a, calls } = makeAdapter({ adminPurposeWallets: [EXTERNAL] });
    await expect(a.removeOperationalWallet(EXTERNAL)).rejects.toThrow(/ADMIN key/);
    expect(calls).toHaveLength(0);
  });

  it('REFUSES to remove an address not registered as an OPERATIONAL key (positive guard), before any tx', async () => {
    // `removeKey` deletes by hash regardless of purpose; without a positive
    // operational-key check a key attached with some other (non-admin,
    // non-operational) purpose could be silently deleted via this endpoint.
    const NON_OP = '0x' + 'a'.repeat(40);
    const { a, calls } = makeAdapter({ operationalPurposeWallets: [] }); // nothing is an operational key
    await expect(a.removeOperationalWallet(NON_OP)).rejects.toThrow(/not registered on-chain as an operational key/);
    expect(calls).toHaveLength(0);
  });

  it('throws when no admin key is configured', async () => {
    const { a, calls } = makeAdapter({ admin: false });
    await expect(a.removeOperationalWallet(EXTERNAL)).rejects.toThrow(/adminPrivateKey is not configured/);
    expect(calls).toHaveLength(0);
  });
});

describe('EVMChainAdapter.ensureOperationalWalletsRegistered — RS eligibility set', () => {
  const EXTERNAL2 = '0x' + 'd'.repeat(40);

  it('marks already-registered and newly-confirmed wallets eligible; unconfirmed stay out', async () => {
    const { a } = makeAdapter({
      identityId: 5n,
      // Per-address getIdentityId reads, in candidate order:
      //   pool[0] (primary) → 5n (already registered under this identity)
      //   EXTERNAL          → 0n (missing → registered by the batch tx)
      //   EXTERNAL2         → 0n (missing → tx sent, but never confirms)
      identityLookupValues: [5n, 0n, 0n],
      operationalPurposeWallets: [EXTERNAL], // post-tx confirm: EXTERNAL yes, EXTERNAL2 no
    });
    const set = (a as any).registeredOperationalAddresses as Set<string>;
    const primary = (a as any).signer.address as string;
    // Drop the constructor seed so the alreadyRegistered branch is observable.
    set.clear();

    const result = await a.ensureOperationalWalletsRegistered({
      additionalAddresses: [EXTERNAL, EXTERNAL2],
    });

    expect(result.alreadyRegistered).toEqual([primary]);
    expect(result.registered).toEqual([ethers.getAddress(EXTERNAL)]);
    // Eligibility mirrors on-chain confirmation exactly (fail-closed):
    expect(set.has(primary.toLowerCase())).toBe(true);       // already-registered path
    expect(set.has(EXTERNAL.toLowerCase())).toBe(true);      // newly-confirmed path
    expect(set.has(EXTERNAL2.toLowerCase())).toBe(false);    // unconfirmed → NOT eligible
  });
});
