// Pure PCA snapshot predicates — the acyclic LEAF that both the health taxonomy
// (`health.ts`) and the coverage decisions (`coverage.ts`) build on. This module
// imports ONLY types, so it sits at the bottom of the pca DAG and nothing here can
// form an import cycle (#1349 extraction — previously `isPcaExpired` lived in
// health.ts and the budget predicates in coverage.ts, and #1349 briefly made them
// reference each other).
import type { PcaSnapshot } from '../api.js';

/** True when a wei decimal-string is a positive amount (> 0). Tolerant of
 *  undefined / non-numeric (→ false). */
export function bigGt0(wei: string | undefined): boolean {
  if (!wei) return false;
  try {
    return BigInt(wei) > 0n;
  } catch {
    return false;
  }
}

/**
 * The SINGLE expiry (liveness) source — the one check `healthForSnapshot`'s
 * `'expired'` state and coverage's `isPcaDead` both consume, so coverage liveness
 * doesn't have to drag in the whole health taxonomy. `expiresAtTimestamp` 0 / absent
 * means "no lock period" → never expired.
 */
export function isPcaExpired(
  snap: Pick<PcaSnapshot, 'expiresAtTimestamp'>,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  const { expiresAtTimestamp } = snap;
  return typeof expiresAtTimestamp === 'number' && expiresAtTimestamp > 0 && nowSec >= expiresAtTimestamp;
}

/**
 * The account can't cover a publish because it's expired or fully swept. Built from
 * the shared `isPcaExpired` liveness primitive (NOT the full health taxonomy) so
 * spendability doesn't depend on cap-near/expiring/agentCount. Byte-identical to the
 * old `healthForSnapshot`-derived form: `health==='expired' ⟺ isPcaExpired`, and
 * `health==='swept' ⟺ !isPcaExpired && fullySwept` (swept is checked after expired),
 * so `expired || swept = isPcaExpired || fullySwept`.
 */
export function isPcaDead(
  snap: Pick<PcaSnapshot, 'expiresAtTimestamp' | 'fullySwept'>,
  nowSec?: number,
): boolean {
  return isPcaExpired(snap, nowSec) || !!snap.fullySwept;
}

/**
 * Account budget state. Non-extended reads use the coarse `baseEpochAllowance`
 * proxy. Extended reads use precise `remainingAllowance` when top-up is empty;
 * if the daemon fail-softed the extended read and omitted it, the budget is
 * unknown and callers must not claim coverage.
 */
export function pcaBudgetState(
  snap: Pick<PcaSnapshot, 'topUpBuffer' | 'baseEpochAllowance' | 'remainingAllowance' | 'extendedRequested'>,
): boolean | null {
  if (bigGt0(snap.topUpBuffer)) return true;
  if (snap.remainingAllowance !== undefined) return bigGt0(snap.remainingAllowance);
  if (snap.extendedRequested) return null;
  return bigGt0(snap.baseEpochAllowance);
}

/** The account has confirmed budget capacity. Unknown extended-read budget -> false. */
export function hasPcaBudget(
  snap: Pick<PcaSnapshot, 'topUpBuffer' | 'baseEpochAllowance' | 'remainingAllowance' | 'extendedRequested'>,
): boolean {
  return pcaBudgetState(snap) === true;
}
