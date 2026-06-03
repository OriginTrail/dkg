// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time chain-RPC helpers extracted from `dkg-agent.ts` as part of
 * a mechanical file-size reduction. Both functions are pure (take their
 * inputs explicitly, hold no `DKGAgent` state) so they are safely
 * callable from anywhere. Behaviour is unchanged — this is a 1:1 move.
 */

import { isRetryableRpcError } from '@origintrail-official/dkg-chain';

/**
 * Resolve `op` but reject with a `BOOT_CHAIN_TIMEOUT`-coded error if it does
 * not settle within `ms`. The timer is `unref`'d so it never keeps the
 * process alive on its own. Used to bound boot-time chain calls so daemon
 * readiness stays independent of chain-RPC reachability.
 *
 * When the timeout wins, `op` is still pending — the multi-RPC failover loop
 * keeps retrying and will eventually reject (e.g. `RPC_ENDPOINTS_EXHAUSTED`).
 * That late rejection has no awaiter once the race has settled, so we attach a
 * no-op `.catch()` to the original promise to keep it from surfacing as an
 * `unhandledRejection` and crashing the booted daemon.
 */
export async function raceWithBootTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  op.catch(() => {
    /* swallow a late rejection from the abandoned op after the race settles */
  });
  try {
    return await Promise.race<T>([
      op,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${ms}ms`);
          (err as Error & { code?: string }).code = 'BOOT_CHAIN_TIMEOUT';
          reject(err);
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Is a boot-time chain-identity failure TRANSIENT (RPC unreachable / slow /
 * rate-limited — recoverable by retrying once the chain is back) versus
 * PERMANENT/deterministic (missing admin key, insufficient funds, a contract
 * revert)? Only transient failures should arm the StorageACK retry loop;
 * arming it for a permanent failure would re-call `ensureProfile()` every 30s
 * forever (Codex PR #901 round-3 :1714 / round-4 :1838).
 *
 * Delegates the RPC-shape recognition to the chain package's exported
 * `isRetryableRpcError` (Codex PR #901 round-4 :459) so we reuse its full
 * extraction — top-level AND nested `error.code` / `statusCode` /
 * `response.status` — instead of a narrower top-level-only copy that would
 * misclassify a 429/5xx buried in a nested field as permanent. On top we add
 * the boot path's own `BOOT_CHAIN_TIMEOUT` (`isRetryableRpcError` doesn't know
 * it) and an explicit permanent-exclusion guard for `admin` provisioning
 * failures (`isRetryableRpcError` already excludes revert/insufficient-funds/
 * nonce). Anything else — ordinary `Error`s with no RPC signature — stays
 * permanent and disabled.
 */
export function isTransientBootChainError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === 'BOOT_CHAIN_TIMEOUT') return true;
  // A missing/invalid profile admin key is a deterministic config error, not a
  // transient RPC failure — surface it once, never retry. (The chain classifier
  // already treats revert / insufficient-funds / nonce as non-retryable.)
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (msg.includes('admin')) return false;
  return isRetryableRpcError(err);
}
