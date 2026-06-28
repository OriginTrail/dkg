// Shared PCA coverage primitives (#1344 — ends the coverage-drift class that
// recurred across C1/O4/Q2/S2/U2/V3). PURE leaf rules consumed by every surface
// (usePublishEligibility / usePcaOverview / GetSponsoredPanel); each surface keeps
// its own iteration / aggregation / verdict logic. Behavior is byte-identical to
// the previously-inlined copies. NOT the precise mid-epoch `remainingAllowance`
// check — that's the P2 extended snapshot (#1349).

import { healthForSnapshot } from './health.js';
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

/** The account can't cover a publish because it's expired or fully swept. */
export function isPcaDead(
  snap: Pick<PcaSnapshot, 'expiresAtTimestamp' | 'fullySwept' | 'agentCount'>,
  nowSec?: number,
): boolean {
  const h = healthForSnapshot(snap, nowSec);
  return h === 'expired' || h === 'swept';
}

/** The account has budget capacity (top-up buffer OR per-epoch allowance). The coarse
 *  P0 proxy — NOT the precise mid-epoch `remainingAllowance` (that's P2/#1349). */
export function hasPcaBudget(snap: Pick<PcaSnapshot, 'topUpBuffer' | 'baseEpochAllowance'>): boolean {
  return bigGt0(snap.topUpBuffer) || bigGt0(snap.baseEpochAllowance);
}

/**
 * The coarse P0 spendability proxy: a PCA can cover a publish only if it is NOT dead
 * (expired/swept) AND has budget. Composed from the two predicates above so the
 * eligibility breakdown (dead vs out-of-budget) reuses the SAME rules.
 */
export function isPcaSpendable(
  snap: Pick<PcaSnapshot, 'expiresAtTimestamp' | 'fullySwept' | 'agentCount' | 'topUpBuffer' | 'baseEpochAllowance'>,
  nowSec?: number,
): boolean {
  return !isPcaDead(snap, nowSec) && hasPcaBudget(snap);
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
 * The canonical coverage decision for a probed snapshot — the discriminant every
 * surface switches on, so none has to recombine the bool soup itself:
 *  - `inconclusive` — the probe couldn't be read → neutral, never DANGER (#9).
 *  - `unregistered` — confirmed NOT an approved publishing wallet here.
 *  - `covers`       — registered HERE AND the account is spendable (not dead, has budget).
 *  - `uncovered`    — registered HERE but the account can't cover (dead and/or no budget).
 */
export type PcaCoverageOutcome = 'inconclusive' | 'unregistered' | 'covers' | 'uncovered';

/**
 * The single canonical coverage classification. Every surface (S5
 * `usePublishEligibility`, S6 `GetSponsoredPanel`, `usePcaOverview`) runs THIS one
 * call and switches on `outcome` instead of bundling the leaf predicates itself —
 * so coverage can't re-diverge across screens. The probe is read from
 * `snap.probedKey` (no separate param — a split snapshot/probe pair can't be
 * mismatched). `dead`/`hasBudget` are the reason facets behind `'uncovered'` (S5's
 * breakdown sets sawExpired/sawInsolvent from them INDEPENDENTLY). Composed from
 * the building blocks above, which stay exported: `usePcaOverview` still needs
 * `isPcaSpendable` for its account-level `bestCoveringDiscountBps` filter (no probe).
 */
export interface PcaCoverageResult {
  /** The canonical coverage decision. */
  outcome: PcaCoverageOutcome;
  /** Normalized registration (the S2 rule). `null` = couldn't determine. Overview's
   *  approvedCount counts `registered === true` (registered wallets, not covering ones). */
  registered: boolean | null;
  /** Reason facet — the account is expired or fully swept (`isPcaDead`). */
  dead: boolean;
  /** Reason facet — the account has budget capacity (`hasPcaBudget`). */
  hasBudget: boolean;
}

export function classifyCoverage(snap: PcaSnapshot, nowSec?: number): PcaCoverageResult {
  const registered = normalizeProbeRegistered(snap.probedKey);
  const dead = isPcaDead(snap, nowSec);
  const hasBudget = hasPcaBudget(snap);
  const outcome: PcaCoverageOutcome =
    registered === null
      ? 'inconclusive'
      : registered === false
        ? 'unregistered'
        : !dead && hasBudget
          ? 'covers'
          : 'uncovered';
  return { outcome, registered, dead, hasBudget };
}
