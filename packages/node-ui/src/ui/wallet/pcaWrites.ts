import { erc20Abi, parseEventLogs, type Account, type Address, type Chain, type PublicClient, type WalletClient } from 'viem';

/**
 * Client-side (wallet-signed) PCA owner actions. These are the on-chain analog
 * of the daemon's server-signed routes, but signed by the CONNECTED wallet so a
 * PCA owned by an external wallet can be managed from the browser.
 *
 * DESIGN: every function takes an injected `walletClient` + `publicClient` +
 * `account` rather than reaching into a wallet context. That keeps them pure
 * and — critically — testable headlessly: a devnet test supplies a
 * `privateKeyToAccount` walletClient over an http transport and exercises the
 * SAME code path against the live local chain (no browser needed). The browser
 * passes a `custom(window.ethereum)` walletClient + the connected address.
 */

// Minimal ABI for the owner-gated DKGPublishingConvictionNFT entry points the
// UI calls, plus the AccountCreated event (emitted by the PublishingConviction
// logic contract — parsed across all receipt logs, not by emitter address).
export const PCA_NFT_ABI = [
  { type: 'function', name: 'createAccount', stateMutability: 'nonpayable', inputs: [{ name: 'committedTRAC', type: 'uint96' }, { name: 'primaryNode', type: 'uint72' }], outputs: [{ name: 'accountId', type: 'uint256' }] },
  { type: 'function', name: 'topUp', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }, { name: 'amount', type: 'uint96' }], outputs: [] },
  { type: 'function', name: 'registerAgent', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }, { name: 'agent', type: 'address' }], outputs: [] },
  { type: 'function', name: 'deregisterAgent', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }, { name: 'agent', type: 'address' }], outputs: [] },
  { type: 'function', name: 'setPrimaryNode', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }, { name: 'newNode', type: 'uint72' }], outputs: [] },
  { type: 'event', name: 'AccountCreated', inputs: [{ name: 'accountId', type: 'uint256', indexed: true }, { name: 'owner', type: 'address', indexed: true }, { name: 'committedTRAC', type: 'uint96', indexed: false }, { name: 'discountBps', type: 'uint16', indexed: false }, { name: 'createdAtEpoch', type: 'uint40', indexed: false }, { name: 'expiresAtEpoch', type: 'uint40', indexed: false }] },
] as const;

// `clearAgents` lives on the PublishingConviction LOGIC contract (owner-gated via
// `ownerOf`), NOT the NFT wrapper — so it is signed against
// `publishingConvictionAddress`, not `nftAddress`.
export const PCA_LOGIC_ABI = [
  { type: 'function', name: 'clearAgents', stateMutability: 'nonpayable', inputs: [{ name: 'accountId', type: 'uint256' }], outputs: [] },
] as const;

export interface WalletCtx {
  walletClient: WalletClient;
  publicClient: PublicClient;
  account: Address | Account;
  chain: Chain;
  nftAddress: Address;
  tokenAddress: Address;
  publishingConvictionAddress: Address;
}

/** Phases surfaced to the UI for fine-grained progress. */
export type WritePhase =
  | 'checking-allowance'
  | 'signing-approve'
  | 'mining-approve'
  | 'signing'
  | 'mining';

export interface TxResult {
  hash: `0x${string}`;
  blockNumber: bigint;
}

type OnPhase = (p: WritePhase) => void;

function accountAddress(account: Address | Account): Address {
  return typeof account === 'string' ? account : account.address;
}

async function send(
  ctx: WalletCtx,
  functionName: 'registerAgent' | 'deregisterAgent' | 'setPrimaryNode' | 'topUp' | 'createAccount',
  args: readonly unknown[],
  onPhase?: OnPhase,
): Promise<{ hash: `0x${string}`; receipt: Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>> }> {
  onPhase?.('signing');
  const hash = await ctx.walletClient.writeContract({
    account: ctx.account,
    chain: ctx.chain,
    address: ctx.nftAddress,
    abi: PCA_NFT_ABI,
    functionName,
    args: args as never,
  });
  onPhase?.('mining');
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  // viem does NOT throw on revert — surface it explicitly.
  if (receipt.status === 'reverted') {
    throw new Error(`Transaction reverted on-chain (${hash.slice(0, 10)}…). Nothing changed.`);
  }
  return { hash, receipt };
}

/**
 * Ensure the NFT can pull `amount` TRAC from the signer. Approves the EXACT
 * amount (not unlimited) when the current allowance is short, mirroring
 * staking-ui. Skips entirely when allowance already suffices.
 */
async function ensureAllowance(ctx: WalletCtx, amount: bigint, onPhase?: OnPhase): Promise<void> {
  onPhase?.('checking-allowance');
  const owner = accountAddress(ctx.account);
  const current = (await ctx.publicClient.readContract({
    address: ctx.tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, ctx.nftAddress],
  })) as bigint;
  if (current >= amount) return;
  onPhase?.('signing-approve');
  const hash = await ctx.walletClient.writeContract({
    account: ctx.account,
    chain: ctx.chain,
    address: ctx.tokenAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [ctx.nftAddress, amount],
  });
  onPhase?.('mining-approve');
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(`Approve reverted (${hash.slice(0, 10)}…). No TRAC approved; nothing changed.`);
  }
}

export async function walletRegisterAgent(ctx: WalletCtx, accountId: bigint, agent: Address, onPhase?: OnPhase): Promise<TxResult> {
  const { hash, receipt } = await send(ctx, 'registerAgent', [accountId, agent], onPhase);
  return { hash, blockNumber: receipt.blockNumber };
}

export async function walletDeregisterAgent(ctx: WalletCtx, accountId: bigint, agent: Address, onPhase?: OnPhase): Promise<TxResult> {
  const { hash, receipt } = await send(ctx, 'deregisterAgent', [accountId, agent], onPhase);
  return { hash, blockNumber: receipt.blockNumber };
}

/**
 * Bulk-clear EVERY registered agent of a PCA (owner-gated). Targets the
 * PublishingConviction LOGIC contract (not the NFT wrapper). PCA transfers
 * PRESERVE the allow-list, so this is the explicit reset a new owner uses to
 * drop inherited agents.
 */
export async function walletClearAgents(ctx: WalletCtx, accountId: bigint, onPhase?: OnPhase): Promise<TxResult> {
  onPhase?.('signing');
  const hash = await ctx.walletClient.writeContract({
    account: ctx.account,
    chain: ctx.chain,
    address: ctx.publishingConvictionAddress,
    abi: PCA_LOGIC_ABI,
    functionName: 'clearAgents',
    args: [accountId],
  });
  onPhase?.('mining');
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === 'reverted') {
    throw new Error(`Transaction reverted on-chain (${hash.slice(0, 10)}…). Nothing changed.`);
  }
  return { hash, blockNumber: receipt.blockNumber };
}

export async function walletSetPrimaryNode(ctx: WalletCtx, accountId: bigint, node: bigint, onPhase?: OnPhase): Promise<TxResult> {
  const { hash, receipt } = await send(ctx, 'setPrimaryNode', [accountId, node], onPhase);
  return { hash, blockNumber: receipt.blockNumber };
}

export async function walletTopUp(ctx: WalletCtx, accountId: bigint, amountWei: bigint, onPhase?: OnPhase): Promise<TxResult> {
  await ensureAllowance(ctx, amountWei, onPhase);
  const { hash, receipt } = await send(ctx, 'topUp', [accountId, amountWei], onPhase);
  return { hash, blockNumber: receipt.blockNumber };
}

export async function walletCreatePca(ctx: WalletCtx, committedWei: bigint, primaryNode: bigint, onPhase?: OnPhase): Promise<TxResult & { accountId: bigint }> {
  await ensureAllowance(ctx, committedWei, onPhase);
  const { hash, receipt } = await send(ctx, 'createAccount', [committedWei, primaryNode], onPhase);
  // AccountCreated is emitted by the logic contract; parse across all logs.
  const events = parseEventLogs({ abi: PCA_NFT_ABI, eventName: 'AccountCreated', logs: receipt.logs });
  const accountId = events.length > 0 ? (events[0].args as { accountId: bigint }).accountId : undefined;
  if (accountId === undefined) {
    throw new Error('PCA created but no AccountCreated event found in the receipt.');
  }
  return { hash, blockNumber: receipt.blockNumber, accountId };
}
