/**
 * Browser identity-wallet actions against the deployed V10 contracts.
 *
 * This crosses the node-UI viem ABI/transaction boundary with a real admin
 * signer, waits for real receipts, and verifies IdentityStorage after every
 * add/remove operation. Unit mocks cannot catch ABI/address integration drift.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ADMIN_KEY_PURPOSE,
  OPERATIONAL_KEY_PURPOSE,
  identityStorageWalletAbi,
  identityWalletActionSubmitter,
  identityWalletKey,
  type IdentityWalletActionDeps,
} from '../src/ui/web3/identityWalletActions.js';
import type { Eip1193Provider } from '../src/ui/web3/eip6963.js';
import { EVMChainAdapter } from '../../chain/src/evm-adapter.js';
import {
  HARDHAT_KEYS,
  killHardhat,
  makeAdapterConfig,
  spawnHardhatEnv,
  type HardhatContext,
} from '../../chain/test/hardhat-harness.js';

let hardhat: HardhatContext;

describe('V10 identity-wallet browser transaction integration', () => {
  beforeAll(async () => { hardhat = await spawnHardhatEnv(); }, 120_000);
  afterAll(async () => { await killHardhat(hardhat); });

  it('adds and removes operational and admin keys through real viem clients', async () => {
    const { rpcUrl, hubAddress, coreProfileId } = hardhat;
    const adapter = new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.CORE_OP));
    const discovered = await adapter.getIdentityWalletContracts();
    expect(discovered).not.toBeNull();
    const bootstrap = { ...discovered!, rpcUrls: [rpcUrl] };
    const admin = privateKeyToAccount(HARDHAT_KEYS.CORE_ADMIN as Hex);
    const operationalTarget = privateKeyToAccount(HARDHAT_KEYS.EXTRA1 as Hex).address;
    const adminTarget = privateKeyToAccount(HARDHAT_KEYS.EXTRA2 as Hex).address;
    const chain = defineChain({
      id: 31337,
      name: 'hardhat',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account: admin, chain, transport: http(rpcUrl) });
    const provider: Eip1193Provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_accounts') return [admin.address];
        if (method === 'eth_chainId') return '0x7a69';
        throw new Error(`Unexpected injected-provider request: ${method} ${JSON.stringify(params ?? [])}`);
      },
    };
    const deps: IdentityWalletActionDeps = {
      bootstrap,
      getWalletState: () => ({
        provider,
        address: admin.address,
        chainId: 31337,
        expectedChainId: 31337,
        bootstrap: null,
      }),
      publicClientFor: () => publicClient,
      walletClientFromProvider: () => walletClient,
    };
    const actions = identityWalletActionSubmitter(deps);
    const identityId = BigInt(coreProfileId);
    const keyHasPurpose = (address: Address, purpose: bigint) => publicClient.readContract({
      address: bootstrap.storage as Address,
      abi: identityStorageWalletAbi,
      functionName: 'keyHasPurpose',
      args: [identityId, identityWalletKey(address), purpose],
    });

    await expect(keyHasPurpose(operationalTarget, OPERATIONAL_KEY_PURPOSE)).resolves.toBe(false);
    const addedOperational = await actions.addOperational(identityId, operationalTarget);
    expect(addedOperational.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(addedOperational.blockNumber).toBeGreaterThan(0);
    await expect(keyHasPurpose(operationalTarget, OPERATIONAL_KEY_PURPOSE)).resolves.toBe(true);

    await expect(keyHasPurpose(adminTarget, ADMIN_KEY_PURPOSE)).resolves.toBe(false);
    const addedAdmin = await actions.addAdmin(identityId, adminTarget);
    expect(addedAdmin.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    await expect(keyHasPurpose(adminTarget, ADMIN_KEY_PURPOSE)).resolves.toBe(true);

    const removedOperational = await actions.removeOperational(
      identityId,
      operationalTarget,
      privateKeyToAccount(HARDHAT_KEYS.CORE_OP as Hex).address,
    );
    expect(removedOperational.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    await expect(keyHasPurpose(operationalTarget, OPERATIONAL_KEY_PURPOSE)).resolves.toBe(false);

    const removedAdmin = await actions.removeAdmin(identityId, adminTarget);
    expect(removedAdmin.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    await expect(keyHasPurpose(adminTarget, ADMIN_KEY_PURPOSE)).resolves.toBe(false);
  });
});
