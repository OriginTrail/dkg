import { describe, expect, it } from 'vitest';
import { ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

import {
  describeWalletTxError,
  WalletReceiptRevertedError,
} from '../src/ui/web3/walletTxError.js';

function revert(errorName: string): ContractFunctionRevertedError {
  const e = new ContractFunctionRevertedError({
    abi: [],
    functionName: 'createAccount',
    message: `reverted: ${errorName}`,
  });
  (e as unknown as { data: { errorName: string; args: unknown[] } }).data = { errorName, args: [] };
  return e;
}

describe('describeWalletTxError', () => {
  it('reverted receipt → reverted_receipt, never a success', () => {
    const info = describeWalletTxError(new WalletReceiptRevertedError('0xabc'), 'action');
    expect(info.kind).toBe('reverted_receipt');
    expect(info.recoverable).toBe(false);
  });

  it('user rejection on the approve step → rejected, nothing committed', () => {
    const info = describeWalletTxError(new UserRejectedRequestError(new Error('rejected')), 'approve');
    expect(info.kind).toBe('rejected');
    expect(info.recoverable).toBe(true);
    expect(info.message.toLowerCase()).toContain('approval');
  });

  it('user rejection on the action step (code 4001) → post-approve-landed copy (retry, no new approval)', () => {
    const info = describeWalletTxError({ code: 4001, message: 'user rejected' }, 'action');
    expect(info.kind).toBe('rejected');
    expect(info.message.toLowerCase()).toContain('allowance');
    expect(info.message.toLowerCase()).toContain('retry');
  });

  it('PrimaryNodeNotInShardingTable revert → recoverable (re-pick a node)', () => {
    const info = describeWalletTxError(revert('PrimaryNodeNotInShardingTable'), 'action');
    expect(info.kind).toBe('revert');
    expect(info.recoverable).toBe(true);
    expect(info.revertName).toBe('PrimaryNodeNotInShardingTable');
  });

  it('any other contract revert → not recoverable, names the revert', () => {
    const info = describeWalletTxError(revert('NotAccountOwner'), 'action');
    expect(info.kind).toBe('revert');
    expect(info.recoverable).toBe(false);
    expect(info.revertName).toBe('NotAccountOwner');
  });

  it('insufficient native gas → insufficient_funds', () => {
    const info = describeWalletTxError(new Error('insufficient funds for gas * price + value'), 'action');
    expect(info.kind).toBe('insufficient_funds');
  });

  it('RPC/confirmation timeout → rpc_timeout, recoverable (may still be processing)', () => {
    const info = describeWalletTxError(new Error('The request timed out.'), 'action');
    expect(info.kind).toBe('rpc_timeout');
    expect(info.recoverable).toBe(true);
  });

  it('anything else → unknown', () => {
    const info = describeWalletTxError(new Error('weird boom'), 'action');
    expect(info.kind).toBe('unknown');
    expect(info.recoverable).toBe(false);
  });
});
