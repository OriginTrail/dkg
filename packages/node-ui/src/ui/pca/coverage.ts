// Shared PCA coverage primitives (a step toward the full coverage-resolver
// consolidation tracked in #1344). Pure helpers — no behavior change vs the
// previously-inlined copies in usePublishEligibility / GetSponsoredPanel /
// usePcaOverview.

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
