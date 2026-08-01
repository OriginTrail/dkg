/** Sync-owned catch-up policy; generic worker-pool mechanics live separately. */
export const CATCHUP_MAX_CONCURRENT_PEER_SYNCS: number = (() => {
  const raw = Number(process.env.DKG_CATCHUP_MAX_CONCURRENT_PEERS);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
})();

/** The spellings `DKG_CATCHUP_STOP_ON_PROOF` accepts as "off"; documented verbatim. */
const CATCHUP_STOP_ON_PROOF_OFF_VALUES = ['0', 'false', 'no', 'off'] as const;

/**
 * Parse the progressive-walk kill-switch.
 *
 * Exported as a pure function because the constant below resolves once at
 * module load, which makes the operator contract untestable in place — and the
 * contract is four documented spellings plus trimming and case-folding, any one
 * of which could be dropped without a single test noticing. Default is ON:
 * anything unrecognised (including unset) leaves the walk enabled, so a typo
 * cannot silently restore the pre-#2006 fan-out.
 */
export function resolveCatchupStopOnProof(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return !CATCHUP_STOP_ON_PROOF_OFF_VALUES.some((value) => value === normalized);
}

/**
 * Operator kill-switch for the progressive catch-up walk (issue #2006).
 *
 * With it off, foreground catch-up reverts to contacting every sync-capable
 * peer in one bounded pass — the pre-fix behaviour, kept reachable because the
 * walk trades breadth for cost: a peer's `complete` flag only proves it served
 * its own manifest, so stopping early can land one peer's snapshot instead of
 * the union of every peer's.
 */
export const CATCHUP_STOP_ON_PROOF: boolean =
  resolveCatchupStopOnProof(process.env.DKG_CATCHUP_STOP_ON_PROOF);

/**
 * Escalating wave sizes for the progressive peer walk: `startWidth`, ×2, ×2, …
 * capped by `maxConcurrency` and truncated to `peerCount`.
 *
 * With `startWidth = 1` the first wave is a single peer, which is what makes an
 * authoritative first peer cost exactly one payload; doubling afterwards keeps
 * the fallback tail short, because a flat wave of `maxConcurrency` would pull
 * that many concurrent full payloads before any of them could prove the plane.
 *
 * A single-peer first wave is only justified when there IS an authority to try
 * first. With no resolvable curator the head of the ranked list has no special
 * claim, so callers pass `startWidth = maxConcurrency` and the walk keeps the
 * previous first-round latency while still stopping early on proof.
 */
export function catchupWaveSizes(
  peerCount: number,
  maxConcurrency: number,
  startWidth = 1,
): number[] {
  const cap = Number.isInteger(maxConcurrency) && maxConcurrency > 0 ? maxConcurrency : 1;
  const sizes: number[] = [];
  let remaining = Math.max(0, Math.trunc(peerCount));
  let size = Number.isInteger(startWidth) && startWidth > 0 ? Math.min(cap, startWidth) : 1;
  while (remaining > 0) {
    const take = Math.min(size, remaining);
    sizes.push(take);
    remaining -= take;
    size = Math.min(cap, size * 2);
  }
  return sizes;
}
