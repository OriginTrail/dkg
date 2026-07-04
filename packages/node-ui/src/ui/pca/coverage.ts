// Shared PCA coverage DECISIONS (#1344 — ends the coverage-drift class that recurred
// across C1/O4/Q2/S2/U2/V3). Built on the pure snapshot predicates in
// `pca-primitives.ts` (the acyclic leaf this module and the health taxonomy share);
// here we add the spendability composite + the canonical probe classification that
// every surface (usePublishEligibility / usePcaOverview / GetSponsoredPanel) consumes,
// each keeping its own iteration / aggregation / verdict logic.

import { isPcaDead, hasPcaBudget, pcaBudgetState } from './pca-primitives.js';
import type { PcaSnapshot, PcaProbedKey } from '../api.js';

/**
 * The coarse P0 spendability proxy: a PCA can cover a publish only if it is NOT dead
 * (expired/swept) AND has budget. Composed from the shared `pca-primitives` predicates
 * so the eligibility breakdown (dead vs out-of-budget) reuses the SAME rules.
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
 *                     `adapterUnsupported` (#1356) is ALWAYS set (true iff the chain
 *                     adapter can't answer PCA queries here — a CAPABILITY GAP where
 *                     retrying is futile; false for a transient RPC failure / fail-soft
 *                     where retry may resolve it). Required, not optional, so callers
 *                     never disambiguate true/false/undefined truthiness.
 *  - `unregistered` — confirmed NOT an approved publishing wallet here.
 *  - `covers`       — registered HERE AND the account is spendable (not dead, has budget).
 *  - `uncovered`    — registered HERE but the account can't cover; `dead`/`hasBudget`
 *                     are the reason facets, carried ONLY on this variant.
 */
export type PcaCoverageResult =
  | { outcome: 'inconclusive'; registered: null; adapterUnsupported: boolean }
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
 * from the shared `pca-primitives` predicates; `usePcaOverview` still needs the exported
 * `isPcaSpendable` for its account-level `bestCoveringDiscountBps` filter (no probe).
 */
export function classifyCoverage(snap: PcaSnapshot, nowSec?: number): PcaCoverageResult {
  const registered = normalizeProbeRegistered(snap.probedKey);
  if (registered === null) {
    // #1356 — carry WHY it was inconclusive: `adapterSupported === false` is the
    // chain-adapter capability gap (retrying won't help); any other null (a probe
    // error / undefined registered) is transient. Only the gap sets the flag true.
    return { outcome: 'inconclusive', registered: null, adapterUnsupported: snap.probedKey?.adapterSupported === false };
  }
  if (registered === false) return { outcome: 'unregistered', registered: false };
  const dead = isPcaDead(snap, nowSec);
  const budget = pcaBudgetState(snap);
  // A fail-softed/unknown extended budget read is inconclusive but NOT a capability gap
  // (the wallet is registered here; retrying the read may resolve it) → adapterUnsupported false.
  if (budget === null) return { outcome: 'inconclusive', registered: null, adapterUnsupported: false };
  const hasBudget = budget;
  if (!dead && hasBudget) return { outcome: 'covers', registered: true };
  return { outcome: 'uncovered', registered: true, dead, hasBudget };
}
