import type { JsonRpcProvider, TransactionReceipt } from 'ethers';
import { sendCliRawTransactionWithFailover } from '../cli-rpc.js';

type NodeOpsChainReceiptConfig = {
  receiptTimeoutMs?: number;
};

type RawTransactionSender = (
  providers: JsonRpcProvider[],
  signedTx: string,
  txHash: string,
  urls?: string[],
  options?: { receiptTimeoutMs?: number },
) => Promise<TransactionReceipt>;

/**
 * Keep the set-ask command's user-facing chain config wired to the shared CLI
 * transaction sender through a small, directly testable boundary.
 */
function sendNodeOpsRawTransactionWithFailover(
  providers: JsonRpcProvider[],
  signedTx: string,
  txHash: string,
  urls: string[] | undefined,
  chainConfig: NodeOpsChainReceiptConfig,
  send: RawTransactionSender = sendCliRawTransactionWithFailover,
): Promise<TransactionReceipt> {
  return send(providers, signedTx, txHash, urls, {
    receiptTimeoutMs: chainConfig.receiptTimeoutMs,
  });
}

export { sendNodeOpsRawTransactionWithFailover };
export type { NodeOpsChainReceiptConfig, RawTransactionSender };
