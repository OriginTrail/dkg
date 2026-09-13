// SPDX-License-Identifier: Apache-2.0

import type { JsonRpcProvider, TransactionReceipt } from 'ethers';

import { assertSuccessfulReceipt } from './evm-adapter-rpc.js';
import {
  RPC_RECEIPT_POLL_INTERVAL_MS,
  resolveReceiptTimeoutMs,
} from './evm-adapter-constants.js';
import { RpcFailoverClient, type RpcEndpoint } from './rpc-failover-client.js';
import { waitForReceiptWithDeadline } from './receipt-wait.js';

export interface TransactionReceiptWaitOptions {
  /** Overall submitted-transaction receipt deadline (default 10 minutes). */
  receiptTimeoutMs?: number;
  /** Low-cardinality transport label. Defaults to `direct transaction`. */
  logLabel?: string;
}

/** One direct receipt endpoint with optional telemetry metadata kept in-band. */
export interface TransactionReceiptEndpoint {
  provider: JsonRpcProvider;
  rpcUrl?: string;
}

/**
 * Stable direct-write receipt boundary used by CLI commands after broadcast.
 * It constructs the same concrete `RpcFailoverClient` the adapter uses, leaving
 * `receipt-wait.ts` responsible only for operation-level polling/deadline logic.
 */
export async function waitForTransactionReceiptWithFailover(
  endpoints: readonly TransactionReceiptEndpoint[],
  txHash: string,
  options: TransactionReceiptWaitOptions = {},
): Promise<TransactionReceipt> {
  const receiptTimeoutMs = resolveReceiptTimeoutMs(options.receiptTimeoutMs);
  const logLabel = options.logLabel ?? 'direct transaction';
  const rpcEndpoints: RpcEndpoint[] = endpoints.map((endpoint, index) => ({
    provider: endpoint.provider,
    // URL is telemetry/stickiness metadata only. Keep URL-less endpoints in the
    // pass with a non-secret stable label rather than filtering them out.
    rpcUrl: endpoint.rpcUrl ?? `dkg-direct-rpc://endpoint-${index + 1}`,
  }));
  const receiptTransport = new RpcFailoverClient(
    () => rpcEndpoints,
    async () => { throw new Error('receipt-only RPC transport cannot sign'); },
    () => 'direct',
    { stickiness: { enabled: false } },
  );

  return waitForReceiptWithDeadline({
    txHash,
    receiptTimeoutMs,
    pollIntervalMs: RPC_RECEIPT_POLL_INTERVAL_MS,
    getReceipt: (hash, { deadlineMs }) => receiptTransport.getReceipt(hash, {
      deadlineMs,
      logLabel: `${logLabel} receipt lookup`,
    }),
    assertSuccessfulReceipt: receipt => assertSuccessfulReceipt(receipt, logLabel),
    formatTimeoutMessage: () =>
      `Transaction ${txHash} was broadcast but no receipt was found within ${receiptTimeoutMs}ms`,
  });
}
