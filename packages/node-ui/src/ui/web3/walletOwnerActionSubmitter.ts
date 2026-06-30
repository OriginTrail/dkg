// Adapted from OriginTrail/staking-ui-v10 (Apache-2.0, (c) OriginTrail).
//
// Browser-signed PCA owner actions. This is intentionally a call-time factory:
// every action re-reads the wallet store, rebuilds clients from the current
// provider/chain bootstrap, and re-verifies address + provider + chain before
// each wallet prompt.

import {
  erc20Abi,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {
  pcaSettle,
  type CreatePcaResult,
  type PcaAddAgentResult,
  type PcaContracts,
  type PcaRemoveAgentResult,
  type PcaTopUpResult,
} from '../api.js';
import { useWalletStore, type WalletState } from '../stores/wallet.js';
import {
  publicClientFor as defaultPublicClientFor,
  synthesizeChain,
  walletClientFromProvider as defaultWalletClientFromProvider,
} from './clients.js';
import { numericChainId } from './chainId.js';
import type { Eip1193Provider } from './eip6963.js';
import { extractAccountId, publishingConvictionNftAbi } from './pcaContract.js';
import { WalletReceiptRevertedError, WalletReceiptWaitError, WalletTxStepError } from './walletTxError.js';
import type { OwnerActionSubmitter } from '../pca/ownerActions.js';

const MAX_UINT72 = (1n << 72n) - 1n;
const MAX_UINT96 = (1n << 96n) - 1n;

type WalletRuntimeState = Pick<
  WalletState,
  'provider' | 'address' | 'chainId' | 'expectedChainId' | 'bootstrap'
>;

export interface MinimalPublicClient {
  readContract: (args: any) => Promise<unknown>;
  waitForTransactionReceipt: (args: { hash: Hex }) => Promise<TransactionReceipt>;
}

export interface MinimalWalletClient {
  writeContract: (args: any) => Promise<Hex>;
}

export type WalletTxProgressState = 'skipped' | 'active' | 'submitted' | 'confirmed' | 'failed';

export interface WalletTxProgressEvent {
  step: 'approve' | 'action';
  state: WalletTxProgressState;
  txHash?: Hex;
  error?: unknown;
}

export interface WalletOwnerActionSubmitterDeps {
  getWalletState?: () => WalletRuntimeState;
  publicClientFor?: (chainId: string | number, rpcUrls: string[]) => MinimalPublicClient;
  walletClientFromProvider?: (chain: Chain, provider: Eip1193Provider) => MinimalWalletClient;
  onProgress?: (event: WalletTxProgressEvent) => void;
}

interface WalletTxContext {
  provider: Eip1193Provider;
  owner: Address;
  expectedChainId: number;
  chain: Chain;
  publicClient: MinimalPublicClient;
  walletClient: MinimalWalletClient;
  nft: Address;
  token: Address;
}

export class WalletOwnerActionSubmitterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletOwnerActionSubmitterError';
  }
}

export class WalletOwnerActionUnavailableError extends WalletOwnerActionSubmitterError {
  constructor(message: string) {
    super(message);
    this.name = 'WalletOwnerActionUnavailableError';
  }
}

export class WalletOwnerActionAbortError extends WalletOwnerActionSubmitterError {
  constructor(message: string) {
    super(message);
    this.name = 'WalletOwnerActionAbortError';
  }
}

function currentState(deps: WalletOwnerActionSubmitterDeps): WalletRuntimeState {
  return deps.getWalletState?.() ?? useWalletStore.getState();
}

function eqAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function normalizeAddress(value: string, field: string): Address {
  try {
    return getAddress(value) as Address;
  } catch {
    throw new WalletOwnerActionSubmitterError(`${field} must be a valid EVM address.`);
  }
}

function parseAccountId(accountId: string): bigint {
  const trimmed = accountId.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new WalletOwnerActionSubmitterError('accountId must be a non-negative integer string.');
  }
  return BigInt(trimmed);
}

function parsePositiveTokenAmount(raw: string, field: string): bigint {
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new WalletOwnerActionSubmitterError(`${field} must be a positive decimal number of TRAC tokens.`);
  }
  let amount: bigint;
  try {
    amount = parseUnits(s, 18);
  } catch (e) {
    const message = e instanceof Error && e.message ? e.message : String(e);
    throw new WalletOwnerActionSubmitterError(`${field} parse error: ${message}`);
  }
  if (amount <= 0n) {
    throw new WalletOwnerActionSubmitterError(`${field} must be > 0.`);
  }
  if (amount > MAX_UINT96) {
    throw new WalletOwnerActionSubmitterError(`${field} exceeds the uint96 TRAC amount range.`);
  }
  return amount;
}

function parsePositivePrimaryNode(raw: unknown): bigint {
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new WalletOwnerActionSubmitterError('primaryNode must be a positive integer node identityId.');
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    throw new WalletOwnerActionSubmitterError('primaryNode must be a positive integer node identityId.');
  }
  const primaryNode = BigInt(s);
  if (primaryNode <= 0n) {
    throw new WalletOwnerActionSubmitterError(
      'primaryNode must be > 0 before signing; choose a staked node for this PCA.',
    );
  }
  if (primaryNode > MAX_UINT72) {
    throw new WalletOwnerActionSubmitterError('primaryNode exceeds the uint72 node identityId range.');
  }
  return primaryNode;
}

function formatTracAmount(amount: bigint): string {
  const s = formatUnits(amount, 18);
  return s.includes('.') ? s : `${s}.0`;
}

function blockNumberOf(receipt: Pick<TransactionReceipt, 'blockNumber'>): number | undefined {
  return receipt.blockNumber == null ? undefined : Number(receipt.blockNumber);
}

function loadContext(deps: WalletOwnerActionSubmitterDeps): WalletTxContext {
  const state = currentState(deps);
  if (!state.provider || !state.address) {
    throw new WalletOwnerActionUnavailableError('Connect the PCA owner wallet before signing.');
  }
  if (!state.bootstrap) {
    throw new WalletOwnerActionUnavailableError('PCA contract addresses are not bootstrapped yet.');
  }
  const expectedChainId = numericChainId(state.bootstrap.chainId);
  if (state.chainId !== expectedChainId) {
    throw new WalletOwnerActionUnavailableError("Switch the connected wallet to this node's PCA network.");
  }
  const owner = normalizeAddress(state.address, 'Connected wallet');
  const nft = normalizeAddress(state.bootstrap.nft, 'PCA NFT contract');
  const token = normalizeAddress(state.bootstrap.token, 'TRAC token contract');
  const chain = synthesizeChain(state.bootstrap.chainId, state.bootstrap.rpcUrls);
  const publicClient = deps.publicClientFor?.(state.bootstrap.chainId, state.bootstrap.rpcUrls)
    ?? defaultPublicClientFor(state.bootstrap.chainId, state.bootstrap.rpcUrls);
  const walletClient = deps.walletClientFromProvider?.(chain, state.provider)
    ?? defaultWalletClientFromProvider(chain, state.provider);
  return {
    provider: state.provider,
    owner,
    expectedChainId,
    chain,
    publicClient,
    walletClient,
    nft,
    token,
  };
}

async function assertStillConnected(ctx: WalletTxContext, deps: WalletOwnerActionSubmitterDeps): Promise<void> {
  const state = currentState(deps);
  if (state.provider !== ctx.provider) {
    throw new WalletOwnerActionAbortError('Wallet provider changed before the signature prompt. Reconnect and retry.');
  }
  if (!eqAddress(state.address, ctx.owner)) {
    throw new WalletOwnerActionAbortError('Connected wallet changed before the signature prompt. Reconnect the owner wallet.');
  }
  if (state.chainId !== ctx.expectedChainId) {
    throw new WalletOwnerActionAbortError('Wallet network changed before the signature prompt. Switch back and retry.');
  }

  const accounts = (await ctx.provider.request({ method: 'eth_accounts' })) as string[];
  if (!eqAddress(accounts?.[0], ctx.owner)) {
    throw new WalletOwnerActionAbortError('Wallet account changed before the signature prompt. Reconnect the owner wallet.');
  }
  const chainHex = (await ctx.provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(chainHex, 16) !== ctx.expectedChainId) {
    throw new WalletOwnerActionAbortError('Wallet network changed before the signature prompt. Switch back and retry.');
  }
}

async function waitForSuccess(
  ctx: WalletTxContext,
  hash: Hex,
  step: 'approve' | 'action',
): Promise<TransactionReceipt> {
  let receipt: TransactionReceipt;
  try {
    receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  } catch (cause) {
    throw new WalletReceiptWaitError(hash, cause, step);
  }
  if (receipt.status !== 'success') {
    throw new WalletReceiptRevertedError(hash);
  }
  return receipt;
}

async function allowance(ctx: WalletTxContext): Promise<bigint> {
  return (await ctx.publicClient.readContract({
    address: ctx.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [ctx.owner, ctx.nft],
  })) as bigint;
}

async function approveExactIfNeeded(
  ctx: WalletTxContext,
  deps: WalletOwnerActionSubmitterDeps,
  amount: bigint,
): Promise<void> {
  if ((await allowance(ctx)) >= amount) {
    deps.onProgress?.({ step: 'approve', state: 'skipped' });
    return;
  }
  await assertStillConnected(ctx, deps);
  deps.onProgress?.({ step: 'approve', state: 'active' });
  let hash: Hex;
  try {
    hash = await ctx.walletClient.writeContract({
      account: ctx.owner,
      chain: ctx.chain,
      address: ctx.token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [ctx.nft, amount],
    });
  } catch (cause) {
    deps.onProgress?.({ step: 'approve', state: 'failed', error: cause });
    throw new WalletTxStepError('approve', cause);
  }
  deps.onProgress?.({ step: 'approve', state: 'submitted', txHash: hash });
  try {
    await waitForSuccess(ctx, hash, 'approve');
  } catch (cause) {
    deps.onProgress?.({ step: 'approve', state: 'failed', txHash: hash, error: cause });
    throw cause;
  }
  deps.onProgress?.({ step: 'approve', state: 'confirmed', txHash: hash });
  if ((await allowance(ctx)) < amount) {
    throw new WalletOwnerActionSubmitterError('TRAC approval confirmed but allowance is still too low.');
  }
}

async function writePcaContract(
  ctx: WalletTxContext,
  deps: WalletOwnerActionSubmitterDeps,
  functionName: 'createAccount' | 'topUp' | 'registerAgent' | 'deregisterAgent',
  args: readonly unknown[],
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  await assertStillConnected(ctx, deps);
  deps.onProgress?.({ step: 'action', state: 'active' });
  let hash: Hex;
  try {
    hash = await ctx.walletClient.writeContract({
      account: ctx.owner,
      chain: ctx.chain,
      address: ctx.nft,
      abi: publishingConvictionNftAbi,
      functionName,
      args,
    });
  } catch (cause) {
    deps.onProgress?.({ step: 'action', state: 'failed', error: cause });
    throw new WalletTxStepError('action', cause);
  }
  deps.onProgress?.({ step: 'action', state: 'submitted', txHash: hash });
  try {
    const receipt = await waitForSuccess(ctx, hash, 'action');
    deps.onProgress?.({ step: 'action', state: 'confirmed', txHash: hash });
    return { hash, receipt };
  } catch (cause) {
    deps.onProgress?.({ step: 'action', state: 'failed', txHash: hash, error: cause });
    throw cause;
  }
}

/**
 * Browser-signed PCA owner action submitter. `settle` intentionally delegates
 * to the daemon API because settlement is permissionless and should never
 * prompt a cold/device owner.
 */
export function walletOwnerActionSubmitter(
  deps: WalletOwnerActionSubmitterDeps = {},
): OwnerActionSubmitter {
  return {
    async create(args): Promise<CreatePcaResult> {
      const primaryNode = parsePositivePrimaryNode(args.primaryNode);
      const amount = parsePositiveTokenAmount(args.tokens, 'tokens');
      const ctx = loadContext(deps);
      await approveExactIfNeeded(ctx, deps, amount);
      const { hash, receipt } = await writePcaContract(ctx, deps, 'createAccount', [amount, primaryNode]);
      let accountId: string;
      try {
        accountId = extractAccountId(receipt, ctx.nft, ctx.owner).toString();
      } catch (cause) {
        // The create tx already has an action hash/receipt at this point. Treat
        // decode/readback failures as post-broadcast so callers keep the
        // double-mint guard and reconcile before allowing another create.
        throw new WalletReceiptWaitError(receipt.transactionHash ?? hash, cause, 'action');
      }
      return {
        accountId,
        txHash: receipt.transactionHash ?? hash,
        blockNumber: blockNumberOf(receipt),
        committedTokens: formatTracAmount(amount),
      };
    },

    async registerAgent(accountId, address): Promise<PcaAddAgentResult> {
      const id = parseAccountId(accountId);
      const agent = normalizeAddress(address, 'Publishing wallet');
      const ctx = loadContext(deps);
      const { hash, receipt } = await writePcaContract(ctx, deps, 'registerAgent', [id, agent]);
      return {
        accountId,
        agent,
        registered: true,
        adapterSupported: true,
        txHash: receipt.transactionHash ?? hash,
        blockNumber: blockNumberOf(receipt),
      };
    },

    async deregisterAgent(accountId, address): Promise<PcaRemoveAgentResult> {
      const id = parseAccountId(accountId);
      const agent = normalizeAddress(address, 'Publishing wallet');
      const ctx = loadContext(deps);
      const { hash, receipt } = await writePcaContract(ctx, deps, 'deregisterAgent', [id, agent]);
      return {
        accountId,
        agent,
        deregistered: true,
        txHash: receipt.transactionHash ?? hash,
        blockNumber: blockNumberOf(receipt),
      };
    },

    async topUp(accountId, tokens): Promise<PcaTopUpResult> {
      const id = parseAccountId(accountId);
      const amount = parsePositiveTokenAmount(tokens, 'tokens');
      const ctx = loadContext(deps);
      await approveExactIfNeeded(ctx, deps, amount);
      const { hash, receipt } = await writePcaContract(ctx, deps, 'topUp', [id, amount]);
      // H-D must persist/reconcile by this top-up txHash. Unlike create, topUp
      // mints no NFT and has no accountId extraction path.
      return {
        accountId,
        addedTokens: formatTracAmount(amount),
        txHash: receipt.transactionHash ?? hash,
        blockNumber: blockNumberOf(receipt),
      };
    },

    settle: pcaSettle,
  };
}
