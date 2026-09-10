import { describe, expect, it, vi } from 'vitest';
import { getAddress, zeroAddress, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { PcaContracts } from '../src/ui/api.js';
import type { Eip1193Provider } from '../src/ui/web3/eip6963.js';
import {
  ADMIN_KEY_PURPOSE,
  ECDSA_KEY_TYPE,
  IdentityWalletActionError,
  OPERATIONAL_KEY_PURPOSE,
  identityWalletActionSubmitter,
  identityWalletKey,
  identityStorageWalletAbi,
  readIdentityWalletSummary,
  type IdentityWalletPublicClient,
  type IdentityWalletClient,
  type IdentityWalletProgressEvent,
} from '../src/ui/web3/identityWalletActions.js';

const ADMIN = getAddress(`0x${'11'.repeat(20)}`) as Address;
const PRIMARY = getAddress(`0x${'22'.repeat(20)}`) as Address;
const TARGET = getAddress(`0x${'33'.repeat(20)}`) as Address;
const PROFILE = getAddress(`0x${'44'.repeat(20)}`) as Address;
const IDENTITY = getAddress(`0x${'55'.repeat(20)}`) as Address;
const IDENTITY_STORAGE = getAddress(`0x${'66'.repeat(20)}`) as Address;
const NFT = getAddress(`0x${'77'.repeat(20)}`) as Address;
const TOKEN = getAddress(`0x${'88'.repeat(20)}`) as Address;
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;

const CONTRACTS: PcaContracts = {
  nft: NFT,
  token: TOKEN,
  identityWallets: {
    profile: PROFILE,
    identity: IDENTITY,
    storage: IDENTITY_STORAGE,
  },
  chainId: 'base:84532',
  rpcUrls: ['/api/pca/rpc'],
};

class FakeProvider implements Eip1193Provider {
  accounts: Address[] = [ADMIN];
  chainId = 84532;

  async request({ method }: { method: string }): Promise<unknown> {
    if (method === 'eth_accounts') return this.accounts;
    if (method === 'eth_chainId') return `0x${this.chainId.toString(16)}`;
    throw new Error(`Unexpected provider method ${method}`);
  }
}

function receipt(status: TransactionReceipt['status'] = 'success'): TransactionReceipt {
  return {
    transactionHash: TX_HASH,
    blockHash: `0x${'01'.repeat(32)}`,
    blockNumber: 9n,
    contractAddress: null,
    cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n,
    from: ADMIN,
    gasUsed: 1n,
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status,
    to: IDENTITY,
    transactionIndex: 0,
    type: 'eip1559',
  } as TransactionReceipt;
}

function makeHarness(options: {
  adminAddresses?: Address[];
  operationalAddresses?: Address[];
  stateAddress?: Address;
  stateChainId?: number;
} = {}) {
  const provider = new FakeProvider();
  const adminAddresses = options.adminAddresses ?? [ADMIN];
  const operationalAddresses = options.operationalAddresses ?? [PRIMARY, TARGET];
  const byPurpose = new Map<bigint, Address[]>([
    [ADMIN_KEY_PURPOSE, adminAddresses],
    [OPERATIONAL_KEY_PURPOSE, operationalAddresses],
  ]);
  const readContract = vi.fn(async (args: {
    address: Address;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }) => {
    if (args.address !== IDENTITY_STORAGE) throw new Error(`Unexpected read target ${args.address}`);
    if (args.abi !== identityStorageWalletAbi) throw new Error('Unexpected read ABI');
    if (args.functionName === 'keyHasPurpose') {
      const [, key, purpose] = args.args as [bigint, Hex, bigint];
      return (byPurpose.get(purpose) ?? []).some((address) => identityWalletKey(address) === key);
    }
    if (args.functionName === 'getKeysByPurpose') {
      const [, purpose] = args.args as [bigint, bigint];
      return (byPurpose.get(purpose) ?? []).map(identityWalletKey);
    }
    throw new Error(`Unexpected read ${args.functionName}`);
  });
  const waitForTransactionReceipt = vi.fn(async () => receipt());
  const writeContract = vi.fn(async (_args: unknown) => TX_HASH);
  const publicClient = { readContract, waitForTransactionReceipt } as unknown as IdentityWalletPublicClient;
  const walletClient = { writeContract } as unknown as IdentityWalletClient;
  const state = {
    provider,
    address: options.stateAddress ?? ADMIN,
    chainId: options.stateChainId ?? 84532,
    expectedChainId: 84532,
    bootstrap: CONTRACTS,
  };
  const progress: IdentityWalletProgressEvent[] = [];
  const submitter = identityWalletActionSubmitter({
    getWalletState: () => state,
    publicClientFor: () => publicClient,
    walletClientFromProvider: () => walletClient,
    onProgress: (event) => progress.push(event),
  });
  return { provider, state, submitter, readContract, writeContract, waitForTransactionReceipt, publicClient, progress };
}

describe('identity wallet key reads', () => {
  it('hashes the packed EVM address into the bytes32 key stored on-chain', () => {
    expect(identityWalletKey(ADMIN)).toBe('0xe2c07404b8c1df4c46226425cac68c28d27a766bbddce62309f36724839b22c0');
  });

  it('returns counts and roles for unique known addresses', async () => {
    const h = makeHarness();
    const summary = await readIdentityWalletSummary(
      CONTRACTS,
      h.publicClient,
      '61',
      [ADMIN, PRIMARY, ADMIN.toLowerCase()],
    );
    expect(summary.adminCount).toBe(1);
    expect(summary.operationalCount).toBe(2);
    expect(summary.addresses).toEqual([
      { address: ADMIN, admin: true, operational: false },
      { address: PRIMARY, admin: false, operational: true },
    ]);
  });

  it('fails if the bootstrap routes identity reads to any other contract', async () => {
    const h = makeHarness();
    const wrongContracts: PcaContracts = {
      ...CONTRACTS,
      identityWallets: { ...CONTRACTS.identityWallets!, storage: PROFILE },
    };
    await expect(readIdentityWalletSummary(wrongContracts, h.publicClient, '61', [ADMIN]))
      .rejects.toThrow(/Unexpected read target/);
  });
});

describe('identity wallet hardware-signed writes', () => {
  it('registers an operational wallet through Profile after verifying the signer is admin', async () => {
    const h = makeHarness({ operationalAddresses: [PRIMARY] });
    const result = await h.submitter.addOperational('61', TARGET);
    expect(h.writeContract).toHaveBeenCalledOnce();
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({
      account: ADMIN,
      address: PROFILE,
      functionName: 'addOperationalWallets',
      args: [61n, [TARGET]],
    });
    expect(result).toMatchObject({ action: 'add-operational', address: TARGET, txHash: TX_HASH, blockNumber: 9 });
    expect(h.progress).toEqual([
      { action: 'add-operational', state: 'signing' },
      { action: 'add-operational', state: 'submitted', txHash: TX_HASH },
      { action: 'add-operational', state: 'confirmed', txHash: TX_HASH },
    ]);
  });

  it('refuses every write when the connected wallet is not an admin key', async () => {
    const h = makeHarness({ adminAddresses: [] });
    await expect(h.submitter.addOperational('61', TARGET)).rejects.toThrow(/not an admin key/);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('refuses removal of the node primary before prompting the wallet', async () => {
    const h = makeHarness();
    await expect(h.submitter.removeOperational('61', PRIMARY, PRIMARY)).rejects.toThrow(/primary operational wallet/);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('removes a non-primary operational wallet through Identity.removeKey', async () => {
    const h = makeHarness();
    await h.submitter.removeOperational('61', TARGET, PRIMARY);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({
      account: ADMIN,
      address: IDENTITY,
      functionName: 'removeKey',
      args: [61n, identityWalletKey(TARGET)],
    });
  });

  it('registers a new admin key through Identity.addKey with purpose/type 1', async () => {
    const h = makeHarness({ operationalAddresses: [PRIMARY] });
    await h.submitter.addAdmin('61', TARGET);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({
      account: ADMIN,
      address: IDENTITY,
      functionName: 'addKey',
      args: [61n, identityWalletKey(TARGET), ADMIN_KEY_PURPOSE, ECDSA_KEY_TYPE],
    });
  });

  it('rejects the zero admin address before any chain read or wallet prompt', async () => {
    const h = makeHarness({ operationalAddresses: [PRIMARY] });
    await expect(h.submitter.addAdmin('61', zeroAddress)).rejects.toThrow(/zero address/);
    expect(h.readContract).not.toHaveBeenCalled();
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('requires a replacement before removing the final operational key', async () => {
    const h = makeHarness({ operationalAddresses: [TARGET] });
    await expect(h.submitter.removeOperational('61', TARGET)).rejects.toThrow(/final operational key/);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('requires a replacement before removing the final admin key', async () => {
    const h = makeHarness({ adminAddresses: [ADMIN] });
    await expect(h.submitter.removeAdmin('61', ADMIN)).rejects.toThrow(/final admin key/);
    expect(h.writeContract).not.toHaveBeenCalled();
  });

  it('removes an old admin by its hashed address when another admin remains', async () => {
    const h = makeHarness({ adminAddresses: [ADMIN, TARGET] });
    await h.submitter.removeAdmin('61', TARGET);
    expect(h.writeContract.mock.calls[0]![0]).toMatchObject({
      account: ADMIN,
      address: IDENTITY,
      functionName: 'removeKey',
      args: [61n, identityWalletKey(TARGET)],
    });
  });

  it('re-checks the provider account immediately before the signature prompt', async () => {
    const h = makeHarness({ operationalAddresses: [PRIMARY] });
    h.provider.accounts = [TARGET];
    await expect(h.submitter.addOperational('61', TARGET)).rejects.toBeInstanceOf(IdentityWalletActionError);
    expect(h.writeContract).not.toHaveBeenCalled();
  });
});
