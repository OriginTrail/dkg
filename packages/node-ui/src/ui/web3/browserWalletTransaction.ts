import {
  getAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { eqAddress } from './address.js';
import type { WalletState } from '../stores/wallet.js';
import {
  publicClientFor as defaultPublicClientFor,
  synthesizeChain,
  walletClientFromProvider as defaultWalletClientFromProvider,
} from './clients.js';
import { numericChainId } from './chainId.js';
import type { Eip1193Provider } from './eip6963.js';
import { WalletReceiptRevertedError, WalletReceiptWaitError, WalletTxStepError } from './walletTxError.js';

export type BrowserWalletRuntimeState = Pick<
  WalletState,
  'provider' | 'address' | 'chainId'
>;

export interface BrowserWalletBootstrap {
  chainId: string | number;
  rpcUrls: string[];
}

export type BrowserWalletPublicClient = Pick<PublicClient, 'readContract' | 'waitForTransactionReceipt'>;
export type BrowserWalletClient = Pick<WalletClient, 'writeContract'>;

export interface BrowserWalletRuntimeDeps<
  Bootstrap extends BrowserWalletBootstrap,
> {
  /** Feature-owned chain and contract bootstrap. */
  bootstrap: Bootstrap;
  /** Feature adapter for the currently connected wallet mechanics. */
  getWalletState: () => BrowserWalletRuntimeState;
  publicClientFor?: (chainId: string | number, rpcUrls: string[]) => BrowserWalletPublicClient;
  walletClientFromProvider?: (chain: Chain, provider: Eip1193Provider) => BrowserWalletClient;
}

export interface BrowserWalletRuntimeContext<
  Bootstrap extends BrowserWalletBootstrap,
> {
  provider: Eip1193Provider;
  account: Address;
  expectedChainId: number;
  chain: Chain;
  publicClient: BrowserWalletPublicClient;
  walletClient: BrowserWalletClient;
  bootstrap: Bootstrap;
}

export interface BrowserWalletConnectionPolicy {
  error: (message: string) => Error;
  unavailableError: (message: string) => Error;
  abortedError: (message: string) => Error;
  messages: {
    disconnected: string;
    wrongNetwork: string;
    providerChanged: string;
    addressChanged: string;
    networkChanged: string;
    accountChanged: string;
  };
}

export function browserWalletAddress(
  value: string,
  field: string,
  error: (message: string) => Error,
): Address {
  try {
    return getAddress(value.trim()) as Address;
  } catch {
    throw error(`${field} must be a valid EVM address.`);
  }
}

export function loadBrowserWalletRuntime<Bootstrap extends BrowserWalletBootstrap>(
  deps: BrowserWalletRuntimeDeps<Bootstrap>,
  policy: BrowserWalletConnectionPolicy,
): BrowserWalletRuntimeContext<Bootstrap> {
  const state = deps.getWalletState();
  if (!state.provider || !state.address) {
    throw policy.unavailableError(policy.messages.disconnected);
  }
  const bootstrap = deps.bootstrap;
  const expectedChainId = numericChainId(bootstrap.chainId);
  if (state.chainId !== expectedChainId) {
    throw policy.unavailableError(policy.messages.wrongNetwork);
  }
  const chain = synthesizeChain(bootstrap.chainId, bootstrap.rpcUrls);
  return {
    provider: state.provider,
    account: browserWalletAddress(state.address, 'Connected wallet', policy.error),
    expectedChainId,
    chain,
    publicClient:
      deps.publicClientFor?.(bootstrap.chainId, bootstrap.rpcUrls) ??
      defaultPublicClientFor(bootstrap.chainId, bootstrap.rpcUrls),
    walletClient:
      deps.walletClientFromProvider?.(chain, state.provider) ??
      defaultWalletClientFromProvider(chain, state.provider),
    bootstrap,
  };
}

export async function assertBrowserWalletStillConnected<Bootstrap extends BrowserWalletBootstrap>(
  ctx: BrowserWalletRuntimeContext<Bootstrap>,
  deps: BrowserWalletRuntimeDeps<Bootstrap>,
  policy: BrowserWalletConnectionPolicy,
): Promise<void> {
  const state = deps.getWalletState();
  if (state.provider !== ctx.provider) {
    throw policy.abortedError(policy.messages.providerChanged);
  }
  if (!eqAddress(state.address, ctx.account)) {
    throw policy.abortedError(policy.messages.addressChanged);
  }
  if (state.chainId !== ctx.expectedChainId) {
    throw policy.abortedError(policy.messages.networkChanged);
  }

  const accounts = (await ctx.provider.request({ method: 'eth_accounts' })) as string[];
  if (!eqAddress(accounts?.[0], ctx.account)) {
    throw policy.abortedError(policy.messages.accountChanged);
  }
  const chainHex = (await ctx.provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(chainHex, 16) !== ctx.expectedChainId) {
    throw policy.abortedError(policy.messages.networkChanged);
  }
}

export interface BrowserWalletTransactionProgress {
  signing: () => void;
  submitted: (hash: Hex) => void;
  confirmed: (hash: Hex) => void;
  failed: (cause: unknown, hash?: Hex) => void;
}

export async function submitBrowserWalletTransaction<
  Bootstrap extends BrowserWalletBootstrap,
>(
  ctx: BrowserWalletRuntimeContext<Bootstrap>,
  deps: BrowserWalletRuntimeDeps<Bootstrap>,
  policy: BrowserWalletConnectionPolicy,
  write: (walletClient: BrowserWalletClient) => Promise<Hex>,
  step: 'approve' | 'action',
  progress: BrowserWalletTransactionProgress,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  await assertBrowserWalletStillConnected(ctx, deps, policy);
  progress.signing();
  let hash: Hex;
  try {
    hash = await write(ctx.walletClient);
  } catch (cause) {
    progress.failed(cause);
    throw new WalletTxStepError(step, cause);
  }
  progress.submitted(hash);
  try {
    let receipt: TransactionReceipt;
    try {
      receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    } catch (cause) {
      throw new WalletReceiptWaitError(hash, cause, step);
    }
    if (receipt.status !== 'success') throw new WalletReceiptRevertedError(hash);
    progress.confirmed(hash);
    return { hash, receipt };
  } catch (cause) {
    progress.failed(cause, hash);
    throw cause;
  }
}
