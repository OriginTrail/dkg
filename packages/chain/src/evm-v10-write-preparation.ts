// SPDX-License-Identifier: Apache-2.0

/**
 * Preparation of a V10 write (publish or update) with the #888 one-shot
 * recovery for a stale-RPC `TooLowAllowance` revert. It returns the prepared,
 * unsigned transaction of the attempt that succeeded; the adapter signs it once
 * afterwards, inside the same per-wallet serializer window (#953), and then
 * checkpoints and broadcasts it. No signature is part of a retry here, so a
 * signer failure is never read as a revert or an endpoint failure.
 */
import { errorCode, enrichEvmError, isTooLowAllowanceError } from './evm-adapter-errors.js';
import { classifyRpcRetryDisposition, sleep } from './evm-adapter-rpc.js';
import {
  RPC_PREPARATION_ENDPOINT_SET_RETRIES,
  RPC_PREPARATION_ENDPOINT_SET_RETRY_BACKOFF_MS,
  RPC_PREPARATION_ENDPOINT_SET_RETRY_BACKOFF_MAX_MS,
} from './evm-adapter-constants.js';
import type { PreparedTransaction } from './rpc-failover-client.js';

/** The two adapter steps a V10 write preparation drives. */
export interface V10WritePreparationSteps {
  /** One preparation over the endpoints (nonce, gas and fees), failing over between them itself. */
  readonly prepare: () => Promise<PreparedTransaction>;
  /** The one forced TRAC re-approve after a `TooLowAllowance` revert, confirmed visible before it returns. */
  readonly forceReapprove: () => Promise<void>;
}

/**
 * Prepare a V10 write with `steps.prepare`. A whole endpoint set that is
 * exhausted, or answers with a failover error, is tried again with backoff, up
 * to `RPC_PREPARATION_ENDPOINT_SET_RETRIES` times. Gas estimation can read a
 * stale TRAC allowance and revert `TooLowAllowance` even though the approve
 * succeeded; this is strictly pre-broadcast, so on that ONE revert a fresh
 * approve is forced and the preparation runs again exactly once. Any other
 * error, or a second `TooLowAllowance`, propagates.
 */
export async function prepareV10WriteWithAllowanceRecovery(
  method: 'publish' | 'update',
  signerAddress: string,
  steps: V10WritePreparationSteps,
): Promise<PreparedTransaction> {
  // OUTER (this loop) owns the SINGLE `forcedReapprove` latch + the lone forced
  // approve; INNER retries the endpoint set. `TooLowAllowance` is a
  // CALL_EXCEPTION (non-retryable), so the inner loop does NOT fail over on it —
  // it propagates up here. The latch is never reset per endpoint, so at most
  // ONE forced approve fires per write regardless of endpoints tried.
  let forcedReapprove = false;
  for (;;) {
    try {
      for (let preparationPass = 0; ; preparationPass += 1) {
        try {
          return await steps.prepare();
        } catch (err) {
          enrichEvmError(err);
          const retryDisposition = classifyRpcRetryDisposition(err);
          if ((errorCode(err) !== 'RPC_ENDPOINTS_EXHAUSTED'
              && retryDisposition !== 'failover')
            || preparationPass >= RPC_PREPARATION_ENDPOINT_SET_RETRIES) {
            throw err;
          }
          const baseDelay = Math.min(
            RPC_PREPARATION_ENDPOINT_SET_RETRY_BACKOFF_MAX_MS,
            RPC_PREPARATION_ENDPOINT_SET_RETRY_BACKOFF_MS * 2 ** preparationPass,
          );
          const jitter = Math.floor(Math.random() * Math.max(1, baseDelay / 2));
          await sleep(baseDelay + jitter);
        }
      }
    } catch (err) {
      enrichEvmError(err);
      if (!forcedReapprove && isTooLowAllowanceError(err)) {
        forcedReapprove = true;
        console.warn(
          `[chain] V10 ${method} gas-estimation reverted TooLowAllowance for ` +
          `signer=${signerAddress} — forcing a fresh TRAC approve and ` +
          `retrying once (likely a stale RPC allowance read, #888).`,
        );
        await steps.forceReapprove();
        continue; // re-run the WHOLE inner preparation loop, allowance now in place
      }
      throw err; // any other error, or a SECOND TooLowAllowance, propagates
    }
  }
}
