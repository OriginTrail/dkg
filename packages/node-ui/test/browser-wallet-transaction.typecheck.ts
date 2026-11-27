import type { Address } from 'viem';
import type { IdentityWalletContracts, PcaContracts } from '../src/ui/api.js';
import type {
  BrowserWalletConnectionPolicy,
  BrowserWalletRuntimeContext,
  BrowserWalletRuntimeDeps,
  BrowserWalletTransactionProgress,
} from '../src/ui/web3/browserWalletTransaction.js';
import { submitBrowserWalletTransaction } from '../src/ui/web3/browserWalletTransaction.js';
import { profileIdentityWalletAbi } from '../src/ui/web3/identityWalletActions.js';

declare const context: BrowserWalletRuntimeContext<PcaContracts>;
declare const deps: BrowserWalletRuntimeDeps<PcaContracts>;
declare const identityContext: BrowserWalletRuntimeContext<IdentityWalletContracts>;
declare const policy: BrowserWalletConnectionPolicy;
declare const progress: BrowserWalletTransactionProgress;
declare const profile: Address;
declare const operational: Address;

// The shared runtime retains every feature-owned bootstrap field without a
// cast while preventing one feature from reading another feature's contracts.
context.bootstrap.nft satisfies string;
context.bootstrap.token satisfies string;
identityContext.bootstrap.profile satisfies string;
identityContext.bootstrap.identity satisfies string;
identityContext.bootstrap.storage satisfies string;
// @ts-expect-error Identity wallet bootstraps do not expose PCA contracts.
void identityContext.bootstrap.nft;
// @ts-expect-error PCA bootstraps do not expose Identity contracts.
void context.bootstrap.profile;

void submitBrowserWalletTransaction(
  context,
  deps,
  policy,
  walletClient => walletClient.writeContract({
    account: context.account,
    chain: context.chain,
    address: profile,
    abi: profileIdentityWalletAbi,
    functionName: 'addOperationalWallets',
    args: [61n, [operational]],
  }),
  'action',
  progress,
);

void submitBrowserWalletTransaction(
  context,
  deps,
  policy,
  walletClient => walletClient.writeContract({
    account: context.account,
    chain: context.chain,
    address: profile,
    abi: profileIdentityWalletAbi,
    // @ts-expect-error addKey belongs to the Identity ABI, not the Profile ABI.
    functionName: 'addKey',
    args: [61n, [operational]],
  }),
  'action',
  progress,
);
