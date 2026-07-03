// Shared PCA coverage primitives (#1344 — ends the coverage-drift class that
// recurred across C1/O4/Q2/S2/U2/V3). PURE leaf rules consumed by every surface
// (usePublishEligibility / usePcaOverview / GetSponsoredPanel); each surface keeps
// its own iteration / aggregation / verdict logic.

import { isPcaExpired } from './health.js';
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

/**
 * The coarse P0 spendability proxy: a PCA can cover a publish only if it is NOT dead
 * (expired/swept) AND has budget. Composed from the two predicates above so the
 * eligibility breakdown (dead vs out-of-budget) reuses the SAME rules.
 */
export function isPcaSpendable(
  snap: Pick<PcaSnapshot, 'expiresAtTimestamp' | 'fullySwept' | 'topUpBuffer' | 'baseEpochAllowance' | 'remainingAllowance' | 'extendedRequested'>,
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
 * The canonical coverage decision for a probed snapshot — a DISCRIMINATED UNION on
 * `outcome`, so each surface switches on ONE field and TS enforces which facets are
 * meaningful (a caller can't read `dead`/`hasBudget` on a probe that never resolved):
 *  - `inconclusive` — the probe couldn't be read → neutral, never DANGER (#9).
 *  - `unregistered` — confirmed NOT an approved publishing wallet here.
 *  - `covers`       — registered HERE AND the account is spendable (not dead, has budget).
 *  - `uncovered`    — registered HERE but the account can't cover; `dead`/`hasBudget`
 *                     are the reason facets, carried ONLY on this variant.
 */
export type PcaCoverageResult =
  | { outcome: 'inconclusive'; registered: null }
  | { outcome: 'unregistered'; registered: false }
  | { outcome: 'covers'; registered: true }
  | { outcome: 'uncovered'; registered: true; dead: boolean; hasBudget: boolean };

/** The discriminant of {@link PcaCoverageResult}. */
export type PcaCoverageOutcome = PcaCoverageResult['outcome'];

/**
 * The single canonical coverage classification. Every surface (S5
 * `usePublishEligibility`, S6 `GetSponsoredPanel`, `usePcaOverview`) runs THIS one
 * call and switches on `outcome` instead of bundling the leaf predicates itself —
 * so coverage can't re-diverge across screens. The probe is read from
 * `snap.probedKey` (no separate param — a split snapshot/probe pair can't be
 * mismatched). The `dead`/`hasBudget` reason facets are carried ONLY on `'uncovered'`,
 * where S5's breakdown sets sawExpired/sawInsolvent from them INDEPENDENTLY. Composed
 * from the building blocks above, which stay exported: `usePcaOverview` still needs
 * `isPcaSpendable` for its account-level `bestCoveringDiscountBps` filter (no probe).
 */
export function classifyCoverage(snap: PcaSnapshot, nowSec?: number): PcaCoverageResult {
  const registered = normalizeProbeRegistered(snap.probedKey);
  if (registered === null) return { outcome: 'inconclusive', registered: null };
  if (registered === false) return { outcome: 'unregistered', registered: false };
  const dead = isPcaDead(snap, nowSec);
  const budget = pcaBudgetState(snap);
  if (budget === null) return { outcome: 'inconclusive', registered: null };
  const hasBudget = budget;
  if (!dead && hasBudget) return { outcome: 'covers', registered: true };
  return { outcome: 'uncovered', registered: true, dead, hasBudget };
}
