import {
  getAddress,
  type Abi,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WriteContractParameters,
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

export type BrowserWalletRuntimeState = Pick<
  WalletState,
  'provider' | 'address' | 'chainId' | 'expectedChainId' | 'bootstrap'
>;

export type BrowserWalletPublicClient = Pick<PublicClient, 'readContract' | 'waitForTransactionReceipt'>;
export interface BrowserWalletClient {
  writeContract<
    const TAbi extends Abi,
    TFunctionName extends ContractFunctionName<TAbi, 'nonpayable' | 'payable'>,
    TArgs extends ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>,
  >(
    parameters: WriteContractParameters<TAbi, TFunctionName, TArgs, Chain, undefined, Chain>,
  ): Promise<Hex>;
}

export interface BrowserWalletRuntimeDeps {
  getWalletState?: () => BrowserWalletRuntimeState;
  publicClientFor?: (chainId: string | number, rpcUrls: string[]) => BrowserWalletPublicClient;
  walletClientFromProvider?: (chain: Chain, provider: Eip1193Provider) => BrowserWalletClient;
}

export interface BrowserWalletRuntimeContext {
  provider: Eip1193Provider;
  account: Address;
  expectedChainId: number;
  chain: Chain;
  publicClient: BrowserWalletPublicClient;
  walletClient: BrowserWalletClient;
  bootstrap: PcaContracts;
}

export interface BrowserWalletConnectionPolicy {
  error: (message: string) => Error;
  unavailableError: (message: string) => Error;
  abortedError: (message: string) => Error;
  messages: {
    disconnected: string;
    bootstrapUnavailable: string;
    wrongNetwork: string;
    providerChanged: string;
    addressChanged: string;
    networkChanged: string;
    accountChanged: string;
  };
}

function currentState(deps: BrowserWalletRuntimeDeps): BrowserWalletRuntimeState {
  return deps.getWalletState?.() ?? useWalletStore.getState();
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

export function loadBrowserWalletRuntime(
  deps: BrowserWalletRuntimeDeps,
  policy: BrowserWalletConnectionPolicy,
): BrowserWalletRuntimeContext {
  const state = currentState(deps);
  if (!state.provider || !state.address) {
    throw policy.unavailableError(policy.messages.disconnected);
  }
  if (!state.bootstrap) {
    throw policy.unavailableError(policy.messages.bootstrapUnavailable);
  }
  const expectedChainId = numericChainId(state.bootstrap.chainId);
  if (state.chainId !== expectedChainId) {
    throw policy.unavailableError(policy.messages.wrongNetwork);
  }
  const chain = synthesizeChain(state.bootstrap.chainId, state.bootstrap.rpcUrls);
  return {
    provider: state.provider,
    account: browserWalletAddress(state.address, 'Connected wallet', policy.error),
    expectedChainId,
    chain,
    publicClient:
      deps.publicClientFor?.(state.bootstrap.chainId, state.bootstrap.rpcUrls) ??
      defaultPublicClientFor(state.bootstrap.chainId, state.bootstrap.rpcUrls),
    walletClient:
      deps.walletClientFromProvider?.(chain, state.provider) ??
      defaultWalletClientFromProvider(chain, state.provider) as BrowserWalletClient,
    bootstrap: state.bootstrap,
  };
}

export async function assertBrowserWalletStillConnected(
  ctx: BrowserWalletRuntimeContext,
  deps: BrowserWalletRuntimeDeps,
  policy: BrowserWalletConnectionPolicy,
): Promise<void> {
  const state = currentState(deps);
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

export interface BrowserWalletWriteRequest<
  TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, 'nonpayable' | 'payable'>,
> {
  address: Address;
  abi: TAbi;
  functionName: TFunctionName;
  args: ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>;
}

export async function submitBrowserWalletTransaction<
  const TAbi extends Abi,
  TFunctionName extends ContractFunctionName<TAbi, 'nonpayable' | 'payable'>,
>(
  ctx: BrowserWalletRuntimeContext,
  deps: BrowserWalletRuntimeDeps,
  policy: BrowserWalletConnectionPolicy,
  request: BrowserWalletWriteRequest<TAbi, TFunctionName>,
  step: 'approve' | 'action',
  progress: BrowserWalletTransactionProgress,
): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  await assertBrowserWalletStillConnected(ctx, deps, policy);
  progress.signing();
  let hash: Hex;
  try {
    // viem's ExactRequired/GetMutabilityAwareValue machinery cannot prove a
    // generic object spread, even though the public request type above has
    // already coupled ABI, function name, and args. Keep the cast at this one
    // transport seam; callers retain the strict contract-specific boundary.
    const parameters = {
      account: ctx.account,
      chain: ctx.chain,
      ...request,
    } as unknown as WriteContractParameters<
      TAbi,
      TFunctionName,
      ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>,
      Chain,
      undefined,
      Chain
    >;
    hash = await ctx.walletClient.writeContract<
      TAbi,
      TFunctionName,
      ContractFunctionArgs<TAbi, 'nonpayable' | 'payable', TFunctionName>
    >(parameters);
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
