import {
  encodePacked,
  keccak256,
  zeroAddress,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
} from 'viem';
import type { PcaContracts } from '../api.js';
import { eqAddress } from '../pca/address.js';
import {
  browserWalletAddress,
  loadBrowserWalletRuntime,
  submitBrowserWalletTransaction,
  type BrowserWalletClient,
  type BrowserWalletConnectionPolicy,
  type BrowserWalletPublicClient,
  type BrowserWalletRuntimeContext,
  type BrowserWalletRuntimeDeps,
} from './browserWalletTransaction.js';

export const ADMIN_KEY_PURPOSE = 1n;
export const OPERATIONAL_KEY_PURPOSE = 2n;
export const ECDSA_KEY_TYPE = 1n;

export const profileIdentityWalletAbi = [
  {
    type: 'function',
    name: 'addOperationalWallets',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'identityId', type: 'uint72' },
      { name: 'operationalWallets', type: 'address[]' },
    ],
    outputs: [],
  },
] as const;

export const identityWalletAbi = [
  {
    type: 'function',
    name: 'addKey',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'identityId', type: 'uint72' },
      { name: 'key', type: 'bytes32' },
      { name: 'keyPurpose', type: 'uint256' },
      { name: 'keyType', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'removeKey',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'identityId', type: 'uint72' },
      { name: 'key', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

export const identityStorageWalletAbi = [
  {
    type: 'function',
    name: 'keyHasPurpose',
    stateMutability: 'view',
    inputs: [
      { name: 'identityId', type: 'uint72' },
      { name: 'key', type: 'bytes32' },
      { name: 'purpose', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getKeysByPurpose',
    stateMutability: 'view',
    inputs: [
      { name: 'identityId', type: 'uint72' },
      { name: 'purpose', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
] as const;

const MAX_UINT72 = (1n << 72n) - 1n;

export type IdentityWalletPublicClient = BrowserWalletPublicClient;
export type IdentityWalletClient = BrowserWalletClient;

export interface IdentityWalletActionDeps extends BrowserWalletRuntimeDeps {
  onProgress?: (event: IdentityWalletProgressEvent) => void;
}

export type IdentityWalletAction =
  | 'add-operational'
  | 'remove-operational'
  | 'add-admin'
  | 'remove-admin';

export interface IdentityWalletProgressEvent {
  action: IdentityWalletAction;
  state: 'signing' | 'submitted' | 'confirmed' | 'failed';
  txHash?: Hex;
  error?: unknown;
}

export interface IdentityWalletTxResult {
  action: IdentityWalletAction;
  address: Address;
  txHash: Hex;
  blockNumber?: number;
}

export interface IdentityWalletRoleState {
  address: Address;
  admin: boolean;
  operational: boolean;
}

export interface IdentityWalletSummary {
  adminCount: number;
  operationalCount: number;
  addresses: IdentityWalletRoleState[];
}

interface IdentityWalletContext extends BrowserWalletRuntimeContext {
  signer: Address;
  profile: Address;
  identity: Address;
  identityStorage: Address;
}

export class IdentityWalletActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityWalletActionError';
  }
}

function normalizedAddress(value: string, field: string): Address {
  return browserWalletAddress(value, field, (message) => new IdentityWalletActionError(message));
}

function parsedIdentityId(value: string | bigint): bigint {
  const raw = typeof value === 'bigint' ? value.toString() : value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new IdentityWalletActionError('Node identityId must be a non-negative integer.');
  }
  const identityId = BigInt(raw);
  if (identityId <= 0n || identityId > MAX_UINT72) {
    throw new IdentityWalletActionError('Node identityId must be between 1 and the uint72 maximum.');
  }
  return identityId;
}

export function identityWalletKey(address: string): Hex {
  const normalized = normalizedAddress(address, 'Wallet address');
  return keccak256(encodePacked(['address'], [normalized]));
}

function requiredIdentityContracts(contracts: PcaContracts): {
  profile: Address;
  identity: Address;
  storage: Address;
} {
  if (!contracts.identityWallets) {
    throw new IdentityWalletActionError(
      'This node does not expose identity-wallet contracts yet. Upgrade the daemon and reload the page.',
    );
  }
  return {
    profile: normalizedAddress(contracts.identityWallets.profile, 'profile contract'),
    identity: normalizedAddress(contracts.identityWallets.identity, 'identity contract'),
    storage: normalizedAddress(contracts.identityWallets.storage, 'identityStorage contract'),
  };
}

const connectionPolicy: BrowserWalletConnectionPolicy = {
  error: (message) => new IdentityWalletActionError(message),
  unavailableError: (message) => new IdentityWalletActionError(message),
  abortedError: (message) => new IdentityWalletActionError(message),
  messages: {
    disconnected: 'Connect an existing admin wallet before signing.',
    bootstrapUnavailable: 'Wallet contract addresses are not bootstrapped yet.',
    wrongNetwork: "Switch the connected wallet to this node's network.",
    providerChanged: 'Wallet provider changed before the signature prompt. Reconnect and retry.',
    addressChanged: 'Connected wallet changed before the signature prompt. Reconnect the admin wallet.',
    networkChanged: 'Wallet network changed before the signature prompt. Switch back and retry.',
    accountChanged: 'Wallet account changed before the signature prompt. Reconnect the admin wallet.',
  },
};

function loadContext(deps: IdentityWalletActionDeps): IdentityWalletContext {
  const runtime = loadBrowserWalletRuntime(deps, connectionPolicy);
  const contracts = requiredIdentityContracts(runtime.bootstrap);
  return {
    ...runtime,
    signer: runtime.account,
    profile: contracts.profile,
    identity: contracts.identity,
    identityStorage: contracts.storage,
  };
}

async function hasPurpose(
  client: IdentityWalletPublicClient,
  identityStorage: Address,
  identityId: bigint,
  address: Address,
  purpose: bigint,
): Promise<boolean> {
  return Boolean(await client.readContract({
    address: identityStorage,
    abi: identityStorageWalletAbi,
    functionName: 'keyHasPurpose',
    args: [identityId, identityWalletKey(address), purpose],
  }));
}

async function keysForPurpose(
  client: IdentityWalletPublicClient,
  identityStorage: Address,
  identityId: bigint,
  purpose: bigint,
): Promise<readonly Hex[]> {
  return (await client.readContract({
    address: identityStorage,
    abi: identityStorageWalletAbi,
    functionName: 'getKeysByPurpose',
    args: [identityId, purpose],
  })) as readonly Hex[];
}

export async function readIdentityWalletSummary(
  contracts: PcaContracts,
  client: IdentityWalletPublicClient,
  identityIdValue: string | bigint,
  addresses: string[],
): Promise<IdentityWalletSummary> {
  const identityId = parsedIdentityId(identityIdValue);
  const identityStorage = requiredIdentityContracts(contracts).storage;
  const normalized = [...new Map(addresses.map((address) => {
    const item = normalizedAddress(address, 'Wallet address');
    return [item.toLowerCase(), item] as const;
  })).values()];
  const [adminKeys, operationalKeys, states] = await Promise.all([
    keysForPurpose(client, identityStorage, identityId, ADMIN_KEY_PURPOSE),
    keysForPurpose(client, identityStorage, identityId, OPERATIONAL_KEY_PURPOSE),
    Promise.all(normalized.map(async (address) => {
      const [admin, operational] = await Promise.all([
        hasPurpose(client, identityStorage, identityId, address, ADMIN_KEY_PURPOSE),
        hasPurpose(client, identityStorage, identityId, address, OPERATIONAL_KEY_PURPOSE),
      ]);
      return { address, admin, operational };
    })),
  ]);
  return {
    adminCount: adminKeys.length,
    operationalCount: operationalKeys.length,
    addresses: states,
  };
}

async function assertAdmin(ctx: IdentityWalletContext, identityId: bigint): Promise<void> {
  if (!(await hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, ctx.signer, ADMIN_KEY_PURPOSE))) {
    throw new IdentityWalletActionError(
      `Connected wallet ${ctx.signer} is not an admin key for identity ${identityId}. Connect an existing admin wallet.`,
    );
  }
}

function blockNumberOf(receipt: { blockNumber: bigint | null }): number | undefined {
  return receipt.blockNumber == null ? undefined : Number(receipt.blockNumber);
}

async function write<
  const TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, 'nonpayable' | 'payable'>,
>(
  ctx: IdentityWalletContext,
  deps: IdentityWalletActionDeps,
  action: IdentityWalletAction,
  address: Address,
  request: {
    address: Address;
    abi: TAbi;
    functionName: TFunctionName;
    args: ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>;
  },
): Promise<IdentityWalletTxResult> {
  const { hash, receipt } = await submitBrowserWalletTransaction(
    ctx,
    deps,
    connectionPolicy,
    request,
    'action',
    {
      signing: () => deps.onProgress?.({ action, state: 'signing' }),
      submitted: (txHash) => deps.onProgress?.({ action, state: 'submitted', txHash }),
      confirmed: (txHash) => deps.onProgress?.({ action, state: 'confirmed', txHash }),
      failed: (error, txHash) => deps.onProgress?.({ action, state: 'failed', txHash, error }),
    },
  );
  return { action, address, txHash: receipt.transactionHash ?? hash, blockNumber: blockNumberOf(receipt) };
}

/** Hardware/browser-wallet submitter for node identity key rotation. */
export function identityWalletActionSubmitter(deps: IdentityWalletActionDeps = {}) {
  return {
    async addOperational(identityIdValue: string | bigint, addressValue: string): Promise<IdentityWalletTxResult> {
      const identityId = parsedIdentityId(identityIdValue);
      const address = normalizedAddress(addressValue, 'Operational wallet');
      if (eqAddress(address, zeroAddress)) {
        throw new IdentityWalletActionError('Operational wallet cannot be the zero address.');
      }
      const ctx = loadContext(deps);
      await assertAdmin(ctx, identityId);
      const [alreadyOperational, isAdmin] = await Promise.all([
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, OPERATIONAL_KEY_PURPOSE),
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, ADMIN_KEY_PURPOSE),
      ]);
      if (alreadyOperational) throw new IdentityWalletActionError(`${address} is already an operational key.`);
      if (isAdmin) throw new IdentityWalletActionError(`${address} is already an admin key and cannot also be operational.`);
      return write(ctx, deps, 'add-operational', address, {
        address: ctx.profile,
        abi: profileIdentityWalletAbi,
        functionName: 'addOperationalWallets',
        args: [identityId, [address]],
      });
    },

    async removeOperational(
      identityIdValue: string | bigint,
      addressValue: string,
      primaryAddress?: string | null,
    ): Promise<IdentityWalletTxResult> {
      const identityId = parsedIdentityId(identityIdValue);
      const address = normalizedAddress(addressValue, 'Operational wallet');
      if (primaryAddress && eqAddress(address, primaryAddress)) {
        throw new IdentityWalletActionError(
          'The primary operational wallet cannot be removed because it anchors this node\'s on-chain identity.',
        );
      }
      const ctx = loadContext(deps);
      await assertAdmin(ctx, identityId);
      const [attached, operationalKeys] = await Promise.all([
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, OPERATIONAL_KEY_PURPOSE),
        keysForPurpose(ctx.publicClient, ctx.identityStorage, identityId, OPERATIONAL_KEY_PURPOSE),
      ]);
      if (!attached) throw new IdentityWalletActionError(`${address} is not an operational key for identity ${identityId}.`);
      if (operationalKeys.length <= 1) {
        throw new IdentityWalletActionError('The final operational key cannot be removed.');
      }
      return write(ctx, deps, 'remove-operational', address, {
        address: ctx.identity,
        abi: identityWalletAbi,
        functionName: 'removeKey',
        args: [identityId, identityWalletKey(address)],
      });
    },

    async addAdmin(identityIdValue: string | bigint, addressValue: string): Promise<IdentityWalletTxResult> {
      const identityId = parsedIdentityId(identityIdValue);
      const address = normalizedAddress(addressValue, 'Admin wallet');
      if (eqAddress(address, zeroAddress)) {
        throw new IdentityWalletActionError('Admin wallet cannot be the zero address.');
      }
      const ctx = loadContext(deps);
      await assertAdmin(ctx, identityId);
      const [alreadyAdmin, isOperational] = await Promise.all([
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, ADMIN_KEY_PURPOSE),
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, OPERATIONAL_KEY_PURPOSE),
      ]);
      if (alreadyAdmin) throw new IdentityWalletActionError(`${address} is already an admin key.`);
      if (isOperational) throw new IdentityWalletActionError(`${address} is already an operational key and cannot also be an admin.`);
      return write(ctx, deps, 'add-admin', address, {
        address: ctx.identity,
        abi: identityWalletAbi,
        functionName: 'addKey',
        args: [identityId, identityWalletKey(address), ADMIN_KEY_PURPOSE, ECDSA_KEY_TYPE],
      });
    },

    async removeAdmin(identityIdValue: string | bigint, addressValue: string): Promise<IdentityWalletTxResult> {
      const identityId = parsedIdentityId(identityIdValue);
      const address = normalizedAddress(addressValue, 'Admin wallet');
      const ctx = loadContext(deps);
      await assertAdmin(ctx, identityId);
      const [attached, adminKeys] = await Promise.all([
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, ADMIN_KEY_PURPOSE),
        keysForPurpose(ctx.publicClient, ctx.identityStorage, identityId, ADMIN_KEY_PURPOSE),
      ]);
      if (!attached) throw new IdentityWalletActionError(`${address} is not an admin key for identity ${identityId}.`);
      if (adminKeys.length <= 1) {
        throw new IdentityWalletActionError('The final admin key cannot be removed. Add its replacement first.');
      }
      return write(ctx, deps, 'remove-admin', address, {
        address: ctx.identity,
        abi: identityWalletAbi,
        functionName: 'removeKey',
        args: [identityId, identityWalletKey(address)],
      });
    },
  };
}
