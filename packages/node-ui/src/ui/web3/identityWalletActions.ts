import {
  encodePacked,
  getAddress,
  keccak256,
  type Address,
  type Chain,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import type { PcaContracts } from '../api.js';
import { eqAddress } from '../pca/address.js';
import { useWalletStore, type WalletState } from '../stores/wallet.js';
import {
  publicClientFor as defaultPublicClientFor,
  synthesizeChain,
  walletClientFromProvider as defaultWalletClientFromProvider,
} from './clients.js';
import { numericChainId } from './chainId.js';
import type { Eip1193Provider } from './eip6963.js';
import { WalletReceiptRevertedError, WalletReceiptWaitError, WalletTxStepError } from './walletTxError.js';

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

type WalletRuntimeState = Pick<
  WalletState,
  'provider' | 'address' | 'chainId' | 'expectedChainId' | 'bootstrap'
>;

export interface IdentityWalletPublicClient {
  readContract: (args: any) => Promise<unknown>;
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<TransactionReceipt>;
}

export interface IdentityWalletClient {
  writeContract: (args: any) => Promise<Hex>;
}

export interface IdentityWalletActionDeps {
  getWalletState?: () => WalletRuntimeState;
  publicClientFor?: (chainId: string | number, rpcUrls: string[]) => IdentityWalletPublicClient;
  walletClientFromProvider?: (chain: Chain, provider: Eip1193Provider) => IdentityWalletClient;
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

interface IdentityWalletContext {
  provider: Eip1193Provider;
  signer: Address;
  expectedChainId: number;
  chain: Chain;
  publicClient: IdentityWalletPublicClient;
  walletClient: IdentityWalletClient;
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

function currentState(deps: IdentityWalletActionDeps): WalletRuntimeState {
  return deps.getWalletState?.() ?? useWalletStore.getState();
}

function normalizedAddress(value: string, field: string): Address {
  try {
    return getAddress(value.trim()) as Address;
  } catch {
    throw new IdentityWalletActionError(`${field} must be a valid EVM address.`);
  }
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

function requiredContract(contracts: PcaContracts, field: 'profile' | 'identity' | 'identityStorage'): Address {
  const value = contracts[field];
  if (!value) {
    throw new IdentityWalletActionError(
      'This node does not expose identity-wallet contracts yet. Upgrade the daemon and reload the page.',
    );
  }
  return normalizedAddress(value, `${field} contract`);
}

function loadContext(deps: IdentityWalletActionDeps): IdentityWalletContext {
  const state = currentState(deps);
  if (!state.provider || !state.address) {
    throw new IdentityWalletActionError('Connect an existing admin wallet before signing.');
  }
  if (!state.bootstrap) {
    throw new IdentityWalletActionError('Wallet contract addresses are not bootstrapped yet.');
  }
  const expectedChainId = numericChainId(state.bootstrap.chainId);
  if (state.chainId !== expectedChainId) {
    throw new IdentityWalletActionError("Switch the connected wallet to this node's network.");
  }
  const chain = synthesizeChain(state.bootstrap.chainId, state.bootstrap.rpcUrls);
  return {
    provider: state.provider,
    signer: normalizedAddress(state.address, 'Connected wallet'),
    expectedChainId,
    chain,
    publicClient:
      deps.publicClientFor?.(state.bootstrap.chainId, state.bootstrap.rpcUrls) ??
      defaultPublicClientFor(state.bootstrap.chainId, state.bootstrap.rpcUrls),
    walletClient:
      deps.walletClientFromProvider?.(chain, state.provider) ??
      defaultWalletClientFromProvider(chain, state.provider),
    profile: requiredContract(state.bootstrap, 'profile'),
    identity: requiredContract(state.bootstrap, 'identity'),
    identityStorage: requiredContract(state.bootstrap, 'identityStorage'),
  };
}

async function assertStillConnected(ctx: IdentityWalletContext, deps: IdentityWalletActionDeps): Promise<void> {
  const state = currentState(deps);
  if (state.provider !== ctx.provider) {
    throw new IdentityWalletActionError('Wallet provider changed before the signature prompt. Reconnect and retry.');
  }
  if (!eqAddress(state.address, ctx.signer)) {
    throw new IdentityWalletActionError('Connected wallet changed before the signature prompt. Reconnect the admin wallet.');
  }
  if (state.chainId !== ctx.expectedChainId) {
    throw new IdentityWalletActionError('Wallet network changed before the signature prompt. Switch back and retry.');
  }
  const accounts = (await ctx.provider.request({ method: 'eth_accounts' })) as string[];
  if (!eqAddress(accounts?.[0], ctx.signer)) {
    throw new IdentityWalletActionError('Wallet account changed before the signature prompt. Reconnect the admin wallet.');
  }
  const chainHex = (await ctx.provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(chainHex, 16) !== ctx.expectedChainId) {
    throw new IdentityWalletActionError('Wallet network changed before the signature prompt. Switch back and retry.');
  }
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
  const identityStorage = requiredContract(contracts, 'identityStorage');
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

async function waitForSuccess(
  ctx: IdentityWalletContext,
  hash: Hex,
): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  } catch (cause) {
    throw new WalletReceiptWaitError(hash, cause, 'action');
  }
  if (receipt.status !== 'success') throw new WalletReceiptRevertedError(hash);
  return receipt;
}

function blockNumberOf(receipt: Pick<TransactionReceipt, 'blockNumber'>): number | undefined {
  return receipt.blockNumber == null ? undefined : Number(receipt.blockNumber);
}

async function write(
  ctx: IdentityWalletContext,
  deps: IdentityWalletActionDeps,
  action: IdentityWalletAction,
  address: Address,
  target: Address,
  abi: typeof profileIdentityWalletAbi | typeof identityWalletAbi,
  functionName: 'addOperationalWallets' | 'addKey' | 'removeKey',
  args: readonly unknown[],
): Promise<IdentityWalletTxResult> {
  await assertStillConnected(ctx, deps);
  deps.onProgress?.({ action, state: 'signing' });
  let hash: Hex;
  try {
    hash = await ctx.walletClient.writeContract({
      account: ctx.signer,
      chain: ctx.chain,
      address: target,
      abi,
      functionName,
      args,
    });
  } catch (cause) {
    deps.onProgress?.({ action, state: 'failed', error: cause });
    throw new WalletTxStepError('action', cause);
  }
  deps.onProgress?.({ action, state: 'submitted', txHash: hash });
  try {
    const receipt = await waitForSuccess(ctx, hash);
    deps.onProgress?.({ action, state: 'confirmed', txHash: hash });
    return { action, address, txHash: receipt.transactionHash ?? hash, blockNumber: blockNumberOf(receipt) };
  } catch (cause) {
    deps.onProgress?.({ action, state: 'failed', txHash: hash, error: cause });
    throw cause;
  }
}

/** Hardware/browser-wallet submitter for node identity key rotation. */
export function identityWalletActionSubmitter(deps: IdentityWalletActionDeps = {}) {
  return {
    async addOperational(identityIdValue: string | bigint, addressValue: string): Promise<IdentityWalletTxResult> {
      const identityId = parsedIdentityId(identityIdValue);
      const address = normalizedAddress(addressValue, 'Operational wallet');
      const ctx = loadContext(deps);
      await assertAdmin(ctx, identityId);
      const [alreadyOperational, isAdmin] = await Promise.all([
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, OPERATIONAL_KEY_PURPOSE),
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, ADMIN_KEY_PURPOSE),
      ]);
      if (alreadyOperational) throw new IdentityWalletActionError(`${address} is already an operational key.`);
      if (isAdmin) throw new IdentityWalletActionError(`${address} is already an admin key and cannot also be operational.`);
      return write(ctx, deps, 'add-operational', address, ctx.profile, profileIdentityWalletAbi, 'addOperationalWallets', [identityId, [address]]);
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
      return write(ctx, deps, 'remove-operational', address, ctx.identity, identityWalletAbi, 'removeKey', [identityId, identityWalletKey(address)]);
    },

    async addAdmin(identityIdValue: string | bigint, addressValue: string): Promise<IdentityWalletTxResult> {
      const identityId = parsedIdentityId(identityIdValue);
      const address = normalizedAddress(addressValue, 'Admin wallet');
      const ctx = loadContext(deps);
      await assertAdmin(ctx, identityId);
      const [alreadyAdmin, isOperational] = await Promise.all([
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, ADMIN_KEY_PURPOSE),
        hasPurpose(ctx.publicClient, ctx.identityStorage, identityId, address, OPERATIONAL_KEY_PURPOSE),
      ]);
      if (alreadyAdmin) throw new IdentityWalletActionError(`${address} is already an admin key.`);
      if (isOperational) throw new IdentityWalletActionError(`${address} is already an operational key and cannot also be an admin.`);
      return write(ctx, deps, 'add-admin', address, ctx.identity, identityWalletAbi, 'addKey', [
        identityId,
        identityWalletKey(address),
        ADMIN_KEY_PURPOSE,
        ECDSA_KEY_TYPE,
      ]);
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
      return write(ctx, deps, 'remove-admin', address, ctx.identity, identityWalletAbi, 'removeKey', [identityId, identityWalletKey(address)]);
    },
  };
}
