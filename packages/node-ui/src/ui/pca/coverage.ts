// Shared PCA coverage primitives (#1344 — ends the coverage-drift class that
// recurred across C1/O4/Q2/S2/U2/V3). PURE leaf rules consumed by every surface
// (usePublishEligibility / usePcaOverview / GetSponsoredPanel); each surface keeps
// its own iteration / aggregation / verdict logic. Behavior is byte-identical to
// the previously-inlined copies. NOT the precise mid-epoch `remainingAllowance`
// check — that's the P2 extended snapshot (#1349).

import { healthForSnapshot } from '../components/Pca/HealthChip.js';
import type { PcaSnapshot, PcaProbedKey } from '../api.js';

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
 * The coarse P0 spendability proxy: a PCA can cover a publish only if it is NOT
 * expired/swept AND has budget capacity (top-up buffer OR per-epoch allowance).
 * Mirrors usePublishEligibility's cover check exactly. (Precise mid-epoch remaining
 * is P2/#1349 — do NOT use `remainingAllowance` here.)
 */
export function isPcaSpendable(
  snap: Pick<PcaSnapshot, 'expiresAtTimestamp' | 'fullySwept' | 'agentCount' | 'topUpBuffer' | 'baseEpochAllowance'>,
  nowSec?: number,
): boolean {
  const h = healthForSnapshot(snap, nowSec);
  return h !== 'expired' && h !== 'swept' && (bigGt0(snap.topUpBuffer) || bigGt0(snap.baseEpochAllowance));
}

/**
 * Normalize a probe's registration (the S2 rule): `adapterSupported === false` (the
 * chain adapter couldn't answer) is "couldn't determine" → `null`, NOT a confirmed
 * not-registered. Otherwise `registered ?? null`.
 */
export function normalizeProbeRegistered(probedKey: PcaProbedKey | undefined): boolean | null {
  if (probedKey?.adapterSupported === false) return null;
  return probedKey?.registered ?? null;
}

/**
 * Per-(snapshot, probe) coverage classification:
 *  - `registered` — normalized (null = couldn't determine).
 *  - `inconclusive` — the probe couldn't be read (registered === null).
 *  - `covers` — the wallet is registered HERE AND the account is spendable.
 */
export function coverageForProbe(
  snap: PcaSnapshot,
  probedKey: PcaProbedKey | undefined,
  nowSec?: number,
): { registered: boolean | null; inconclusive: boolean; covers: boolean } {
  const registered = normalizeProbeRegistered(probedKey);
  return {
    registered,
    inconclusive: registered === null,
    covers: registered === true && isPcaSpendable(snap, nowSec),
  };
}
