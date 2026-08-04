/**
 * Endpoint policy for strict finalized reads: two slots, distinct provider
 * origins preferred.
 *
 * Before this existed, a runtime RPC pool larger than the attempt ceiling was
 * fatal rather than merely inconvenient: `resolveRpcUrls(chain.rpcUrl,
 * chain.rpcUrls)` yields **three** URLs on testnet, mainnet-base and
 * mainnet-gnosis, while `snapshotNormalizedEndpoints` rejected more than
 * `CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1 = 2` distinct endpoints — so
 * RFC64's finalized-VM precommit could not construct a snapshot scope on any
 * shipped EVM network.
 *
 * This module is POLICY ONLY. Validation, parsing, origin derivation and
 * deduplication all belong to the endpoint boundary in
 * `strict-current-finalized-evm-config.ts`, which hands over an already-valid
 * `{ href, origin }` model. That is why there is no input validation here: the
 * states a second validator would defend against cannot reach it.
 *
 * **Why prefer a distinct origin over configuration order.** The selected array
 * is consumed as an ordered failover list, so preferring a distinct origin can
 * skip an earlier same-origin URL: `[KEY_A, KEY_B, backup]` selects
 * `[KEY_A, backup]` and never attempts `KEY_B`. That is a deliberate trade and
 * not a free one. Two credentials behind one load balancer share a provider, so
 * the dominant failure mode — that provider down, or rate-limiting the account —
 * takes both out together and leaves a same-origin pair with no working endpoint
 * at all. A distinct origin is the only selection that survives it. The case the
 * trade loses is narrower: KEY_A degraded, KEY_B healthy, AND the distinct
 * origin also down. With two slots and three endpoints some configured URL is
 * skipped under every possible policy; this picks the one that keeps failover
 * across providers.
 *
 * **Backfill preserves base behaviour.** When no second origin exists, the
 * second configured URL is used anyway. At base a two-URL same-origin pool
 * constructed as two dialable endpoints, and collapsing it to one would halve
 * failover for a deliberate operator config.
 *
 * Order is always the caller's configuration order — both slots are taken from
 * the pool front-to-back, so no ordering repair is needed or performed.
 */
import {
  CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1,
} from './current-finalized-evm-read-profile.js';

/**
 * The number of slots this policy fills, as a LITERAL rather than an alias of
 * the attempt ceiling.
 *
 * The algorithm is genuinely fixed at two — first URL, then the first later URL
 * with a different origin — so aliasing the ceiling would export a value that
 * can change while the behaviour does not. Raising the ceiling to 3 would have
 * made this constant read 3 while selection still returned two endpoints.
 */
const SLOTS = 2;

// COMPILE-TIME assertion that the ceiling this policy is written against has not
// moved. `CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1` is declared as `= 2`, so
// its inferred type is the literal `2`; raising it makes this line a type error
// and `tsc` fails the build.
//
// Deliberately a type, not a runtime check. An earlier revision threw at module
// load, which enforced the same invariant but made a constant change surface as
// a package that will not import, and forced the test for it to mock module
// loading. This costs nothing at runtime, cannot be skipped the way a test can,
// and reports at the place the mistake is made.
// The assigned value must be `true`, NOT a cast. An earlier revision wrote
// `undefined as never`, which type-checks against `never` and made the whole
// assertion decorative — it could not fail. Verified by flipping the ceiling to
// 3 and confirming `tsc` errors here.
type AssertPolicyMatchesCeiling =
  [typeof CURRENT_FINALIZED_EVM_READ_MAX_ATTEMPTS_V1] extends [typeof SLOTS] ? true : never;
const _assertPolicyMatchesCeiling: AssertPolicyMatchesCeiling = true;
void _assertPolicyMatchesCeiling;

/** One validated endpoint: what to dial, and which provider it belongs to. */
export interface StrictFinalizedEndpointV1 {
  /** Normalized absolute URL, as produced by the config's endpoint boundary. */
  readonly href: string;
  /** Provider identity — core's origin rule, NOT the URL. */
  readonly origin: string;
}

/**
 * Pick the endpoints one strict finalized session may dial, in configuration
 * order: the first endpoint, then the first later endpoint with a DIFFERENT
 * provider origin, falling back to the second when the pool offers only one
 * origin.
 *
 * Expects a non-empty, already-validated, already-deduplicated pool.
 */
export function selectStrictFinalizedEndpointSessionV1(
  endpoints: readonly StrictFinalizedEndpointV1[],
): readonly string[] {
  const first = endpoints[0];
  if (first === undefined) {
    // Not reachable from the config, whose `snapshotDenseDataArray(..., {
    // minLength: 1 })` rejects an empty pool first. Kept because an empty
    // selection returned as a valid session would dial nothing, and a caller
    // could read a zero-attempt result as a successful one.
    throw new TypeError('Strict finalized endpoint selection requires at least one endpoint');
  }

  const distinctOrigin = endpoints
    .slice(1)
    .find((endpoint) => endpoint.origin !== first.origin);
  const second = distinctOrigin ?? endpoints[1];

  return Object.freeze(second === undefined ? [first.href] : [first.href, second.href]);
}
