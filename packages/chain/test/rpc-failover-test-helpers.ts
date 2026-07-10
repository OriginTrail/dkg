// SPDX-License-Identifier: Apache-2.0
/**
 * Shared harness for the two direct-`RpcFailoverClient` unit suites —
 * `rpc-failover-client.unit.test.ts` (write transport + resolveCapMs matrix) and
 * `endpoint-stickiness.acceptance.unit.test.ts` (Mechanism-B AC scenarios). Both
 * build the module over the same bare-double transport contract, so the
 * construction + call-recording helpers live here as one source of truth (#1548
 * review). Scenario-specific doubles — `readSeq`, signer/contract builders, and
 * per-suite URL sets — stay local to each suite.
 */
import {
  RpcFailoverClient,
  type SignPopulatedFn,
  type StickinessOptions,
} from '../src/rpc-failover-client.js';

/** A call-recording wrapper: `fn.calls` is the array of argument tuples seen. */
export function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

/** A RETRYABLE transport error (HTTP 429) — the canonical failover trigger. */
export const retryable429 = () => { const e = new Error('429 too many requests'); (e as any).status = 429; return e; };

// A `signPopulated` stub the read/broadcast/receipt families never reach — wired
// to fail loudly if a non-signing path ever tried to sign.
export const NEVER_SIGN: SignPopulatedFn = async () => {
  throw new Error('signPopulated must not be reached by this path');
};

/** Construct the module under test over bare doubles (PLAN §0 D1 thunks).
 *  `stickiness` (Mechanism B) is optional — omitted, the client uses production
 *  defaults (stickiness on unless `DKG_DISABLE_RPC_STICKINESS=1`, `Date.now`
 *  clock, 30s TTL); the stickiness suite injects `{ enabled, now, ttlMs }`. */
export function makeClient(
  providers: unknown[],
  rpcUrls: string[],
  signPopulated: SignPopulatedFn = NEVER_SIGN,
  stickiness?: StickinessOptions,
): RpcFailoverClient {
  return new RpcFailoverClient(
    () => providers.map((p, i) => ({ provider: p as any, rpcUrl: rpcUrls[i] })),
    signPopulated,
    () => 'evm:31337',
    { stickiness },
  );
}
