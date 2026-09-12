// Adapted from OriginTrail/staking-ui-v10 (Apache-2.0, (c) OriginTrail).
//
// Browser-signed PCA owner actions. This is intentionally a call-time factory:
// every action re-reads the wallet store, rebuilds clients from the current
// provider/chain bootstrap, and re-verifies address + provider + chain before
// each wallet prompt.

import {
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
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
import { extractAccountId, publishingConvictionNftAbi } from './pcaContract.js';
import { WalletReceiptWaitError } from './walletTxError.js';
import type { OwnerActionSubmitter } from '../pca/ownerActions.js';

const MAX_UINT72 = (1n << 72n) - 1n;
const MAX_UINT96 = (1n << 96n) - 1n;

export type MinimalPublicClient = BrowserWalletPublicClient;
export type MinimalWalletClient = BrowserWalletClient;

export type WalletTxProgressState = 'skipped' | 'active' | 'submitted' | 'confirmed' | 'failed';

export interface WalletTxProgressEvent {
  step: 'approve' | 'action';
  state: WalletTxProgressState;
  txHash?: Hex;
  error?: unknown;
}

export interface WalletOwnerActionSubmitterDeps extends BrowserWalletRuntimeDeps {
  onProgress?: (event: WalletTxProgressEvent) => void;
}

interface WalletTxContext extends BrowserWalletRuntimeContext {
  owner: Address;
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

function normalizeAddress(value: string, field: string): Address {
  return browserWalletAddress(value, field, (message) => new WalletOwnerActionSubmitterError(message));
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

const connectionPolicy: BrowserWalletConnectionPolicy = {
  error: (message) => new WalletOwnerActionSubmitterError(message),
  unavailableError: (message) => new WalletOwnerActionUnavailableError(message),
  abortedError: (message) => new WalletOwnerActionAbortError(message),
  messages: {
    disconnected: 'Connect the PCA owner wallet before signing.',
    bootstrapUnavailable: 'PCA contract addresses are not bootstrapped yet.',
    wrongNetwork: "Switch the connected wallet to this node's PCA network.",
    providerChanged: 'Wallet provider changed before the signature prompt. Reconnect and retry.',
    addressChanged: 'Connected wallet changed before the signature prompt. Reconnect the owner wallet.',
    networkChanged: 'Wallet network changed before the signature prompt. Switch back and retry.',
    accountChanged: 'Wallet account changed before the signature prompt. Reconnect the owner wallet.',
  },
};

function loadContext(deps: WalletOwnerActionSubmitterDeps): WalletTxContext {
  const runtime = loadBrowserWalletRuntime(deps, connectionPolicy);
  return {
    ...runtime,
    owner: runtime.account,
    nft: normalizeAddress(runtime.bootstrap.nft, 'PCA NFT contract'),
    token: normalizeAddress(runtime.bootstrap.token, 'TRAC token contract'),
  };
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
  await submitBrowserWalletTransaction(
    ctx,
    deps,
    connectionPolicy,
    {
      address: ctx.token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [ctx.nft, amount],
    },
    'approve',
    {
      signing: () => deps.onProgress?.({ step: 'approve', state: 'active' }),
      submitted: (txHash) => deps.onProgress?.({ step: 'approve', state: 'submitted', txHash }),
      confirmed: (txHash) => deps.onProgress?.({ step: 'approve', state: 'confirmed', txHash }),
      failed: (error, txHash) => deps.onProgress?.({ step: 'approve', state: 'failed', txHash, error }),
    },
  );
  if ((await allowance(ctx)) < amount) {
    throw new WalletOwnerActionSubmitterError('TRAC approval confirmed but allowance is still too low.');
  }
}

async function writePcaContract(
  ctx: WalletTxContext,
  deps: WalletOwnerActionSubmitterDeps,
  request:
    | { functionName: 'createAccount'; args: readonly [bigint, bigint] }
    | { functionName: 'topUp'; args: readonly [bigint, bigint] }
    | { functionName: 'registerAgent'; args: readonly [bigint, Address] }
    | { functionName: 'deregisterAgent'; args: readonly [bigint, Address] },
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  return submitBrowserWalletTransaction(
    ctx,
    deps,
    connectionPolicy,
    {
      address: ctx.nft,
      abi: publishingConvictionNftAbi,
      ...request,
    },
    'action',
    {
      signing: () => deps.onProgress?.({ step: 'action', state: 'active' }),
      submitted: (txHash) => deps.onProgress?.({ step: 'action', state: 'submitted', txHash }),
      confirmed: (txHash) => deps.onProgress?.({ step: 'action', state: 'confirmed', txHash }),
      failed: (error, txHash) => deps.onProgress?.({ step: 'action', state: 'failed', txHash, error }),
    },
  );
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
      const { hash, receipt } = await writePcaContract(ctx, deps, {
        functionName: 'createAccount',
        args: [amount, primaryNode],
      });
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
      const { hash, receipt } = await writePcaContract(ctx, deps, {
        functionName: 'registerAgent',
        args: [id, agent],
      });
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
      const { hash, receipt } = await writePcaContract(ctx, deps, {
        functionName: 'deregisterAgent',
        args: [id, agent],
      });
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
      const { hash, receipt } = await writePcaContract(ctx, deps, {
        functionName: 'topUp',
        args: [id, amount],
      });
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
