// SPDX-License-Identifier: Apache-2.0

/**
 * Authority refresh failures that the post-commit settlement window of a
 * durable SWM promotion cannot outlast.
 *
 * That window (about sixteen seconds of backoff) exists for a freshly created
 * private graph whose membership-derived responsibility and accepted authority
 * converge moments after its first share. The conditions below clear on a
 * different clock: chain finality lags a registration by minutes, a binding
 * mismatch or an adapter without a finalized reader does not clear by waiting,
 * and an open authority circuit stays open for its cooldown. Retrying them from
 * the detached observer only repeats the authority read while the observer
 * holds the asset's serialized tail, where a confirmed publish of the same
 * asset then waits. The periodic authority refresh owns these retries.
 */
const RFC64_SETTLEMENT_OUTLASTING_AUTHORITY_FAILURES_V1: ReadonlySet<string> = new Set([
  'registered-authority-unfinalized',
  'registered-authority-binding-mismatch',
  'registered-authority-adapter-unsupported',
  'authority-rpc-circuit-open',
]);

/**
 * Whether the bounded settlement retries of a dormant promotion can still
 * select a catalog lane, given the reason the last authority refresh of the
 * graph recorded. No recorded reason, and every reason that is local lifecycle
 * state still arriving (roster, owner seed, access policy), keeps the retries.
 */
export function rfc64SwmInventorySettlementCanConvergeV1(
  lastAuthorityRefreshFailureReason: string | null,
): boolean {
  return lastAuthorityRefreshFailureReason === null
    || !RFC64_SETTLEMENT_OUTLASTING_AUTHORITY_FAILURES_V1.has(lastAuthorityRefreshFailureReason);
}
