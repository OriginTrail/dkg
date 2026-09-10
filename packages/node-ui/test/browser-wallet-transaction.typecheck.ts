import type { Address } from 'viem';
import type {
  BrowserWalletConnectionPolicy,
  BrowserWalletRuntimeContext,
  BrowserWalletRuntimeDeps,
  BrowserWalletTransactionProgress,
  BrowserWalletWriteRequest,
} from '../src/ui/web3/browserWalletTransaction.js';
import { submitBrowserWalletTransaction } from '../src/ui/web3/browserWalletTransaction.js';
import { profileIdentityWalletAbi } from '../src/ui/web3/identityWalletActions.js';

declare const context: BrowserWalletRuntimeContext;
declare const deps: BrowserWalletRuntimeDeps;
declare const policy: BrowserWalletConnectionPolicy;
declare const progress: BrowserWalletTransactionProgress;
declare const profile: Address;
declare const operational: Address;

// @ts-expect-error addKey belongs to the Identity ABI, not the Profile ABI.
type InvalidProfileFunction = BrowserWalletWriteRequest<typeof profileIdentityWalletAbi, 'addKey'>;

void submitBrowserWalletTransaction(
  context,
  deps,
  policy,
  {
    address: profile,
    abi: profileIdentityWalletAbi,
    functionName: 'addOperationalWallets',
    args: [61n, [operational]],
  },
  'action',
  progress,
);

void (null as InvalidProfileFunction | null);
