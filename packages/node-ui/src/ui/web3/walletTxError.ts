// Step-aware classification of in-browser wallet/transaction errors into UI states.
//
// NOTE: lives under web3/ (NOT api.ts) on purpose — it statically imports viem, and api.ts is in
// the always-loaded bundle; keeping all viem imports under the lazy-loaded web3/ layer honors the
// "don't ship viem to non-PCA users" constraint. The conviction surface imports this lazily.

import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

/** Which signature in the approve→action chain failed (drives the post-approve-landed copy). */
export type WalletTxStep = 'approve' | 'action';

export type WalletTxErrorKind =
  | 'rejected'
  | 'revert'
  | 'reverted_receipt'
  | 'insufficient_funds'
  | 'rpc_timeout'
  | 'unknown';

export interface WalletTxErrorInfo {
  kind: WalletTxErrorKind;
  /** The user can recover without re-approving (re-pick a node, retry the action). */
  recoverable: boolean;
  /** Decoded custom-error / revert name when available (e.g. `PrimaryNodeNotInShardingTable`). */
  revertName?: string;
  /** User-facing copy. */
  message: string;
}

/**
 * Thrown by the wallet submitter when `waitForTransactionReceipt` resolves with
 * `status === 'reverted'` — the tx mined but the contract reverted. Distinct from a pre-send revert
 * (ContractFunctionRevertedError) so the UI never reads a reverted mine as success.
 */
export class WalletReceiptRevertedError extends Error {
  readonly txHash?: string;
  constructor(txHash?: string) {
    super('Transaction reverted on-chain');
    this.name = 'WalletReceiptRevertedError';
    this.txHash = txHash;
  }
}

function walk<T>(err: unknown, pred: (e: unknown) => e is T): T | undefined {
  if (err instanceof BaseError) {
    const found = err.walk((e) => pred(e));
    return (found as T) ?? undefined;
  }
  return pred(err) ? err : undefined;
}

function looksLike(err: unknown, needles: string[]): boolean {
  const hay = (
    (err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ''}` : String(err)) ?? ''
  ).toLowerCase();
  return needles.some((n) => hay.includes(n));
}

/**
 * Map a thrown wallet/tx error to a UI state. `step` distinguishes the approval sig from the action
 * sig so a reject AFTER a landed approve reads as "allowance set, action not done — retry, no new
 * approval" (§8g) rather than "nothing changed".
 */
export function describeWalletTxError(err: unknown, step: WalletTxStep): WalletTxErrorInfo {
  // Reverted receipt (mined-but-reverted) — never a success.
  if (err instanceof WalletReceiptRevertedError) {
    return {
      kind: 'reverted_receipt',
      recoverable: false,
      message: 'The transaction was mined but reverted on-chain. Nothing was committed; check the explorer.',
    };
  }

  // User rejected in the wallet (EIP-1193 code 4001 / viem UserRejectedRequestError).
  const rejected =
    walk(err, (e): e is UserRejectedRequestError => e instanceof UserRejectedRequestError) ??
    ((err as { code?: number })?.code === 4001 ? (err as UserRejectedRequestError) : undefined);
  if (rejected) {
    return step === 'approve'
      ? { kind: 'rejected', recoverable: true, message: 'You rejected the TRAC approval in your wallet. Nothing was committed.' }
      : {
          kind: 'rejected',
          recoverable: true,
          message:
            'The TRAC allowance is set, but you rejected the next step in your wallet — retry to finish (no new approval needed).',
        };
  }

  // Contract revert decoded pre-send (or on a simulated call).
  const reverted = walk(
    err,
    (e): e is ContractFunctionRevertedError => e instanceof ContractFunctionRevertedError,
  );
  if (reverted) {
    const revertName = reverted.data?.errorName ?? reverted.reason ?? undefined;
    if (revertName === 'PrimaryNodeNotInShardingTable') {
      return {
        kind: 'revert',
        recoverable: true,
        revertName,
        message: 'The node you picked is no longer staked — pick another and try again.',
      };
    }
    return {
      kind: 'revert',
      recoverable: false,
      revertName,
      message: revertName
        ? `The transaction would revert (${revertName}).`
        : 'The transaction would revert on-chain.',
    };
  }

  // Insufficient native gas to send.
  if (looksLike(err, ['insufficient funds', 'insufficient balance for gas'])) {
    return {
      kind: 'insufficient_funds',
      recoverable: true,
      message: 'This wallet has no native gas to send the transaction — fund it and retry.',
    };
  }

  // RPC / confirmation timeout — the tx MAY have broadcast → reconcile, don't claim failure.
  if (looksLike(err, ['timed out', 'timeout', 'took too long', 'request timed out'])) {
    return {
      kind: 'rpc_timeout',
      recoverable: true,
      message: 'The network didn’t confirm in time — the transaction may still be processing. Re-check before retrying.',
    };
  }

  return {
    kind: 'unknown',
    recoverable: false,
    message: err instanceof Error && err.message ? err.message : 'The transaction could not be completed.',
  };
}
