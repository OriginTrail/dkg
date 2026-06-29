// PCA health derivation — DOMAIN module (#1355 V2). Lifted out of the presentation
// HealthChip.tsx so domain code (coverage.ts, the hooks) doesn't import a React
// component file (layer inversion). HealthChip.tsx re-imports these for its pill.
import type { PcaSnapshot } from '../api.js';

/**
 * The health states a PCA can be in (S1/S3 `HealthChip`). Each maps to a DISTINCT
 * glyph (not colour-only) and a text label that is NEVER dropped — the label is the
 * accessible name, the glyph is decorative (`aria-hidden`).
 */
export type PcaHealthState =
  | 'healthy'
  | 'expiring'
  | 'expired'
  | 'insolvent'
  | 'swept'
  | 'cap-near';

/** Approved-wallet count at which a PCA is flagged "Cap near 100". */
export const PCA_CAP_NEAR_THRESHOLD = 90;
/** Window (seconds) before expiry at which a PCA is flagged "Expiring soon" (7 days). */
export const PCA_EXPIRING_SOON_SECONDS = 7 * 24 * 60 * 60;

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
 * The SINGLE source of truth for deriving a PCA's `HealthChip` state from its
 * snapshot — used by S1/S3/S5 so the derivation can't drift across screens.
 * Precedence (highest first), per the lead's contract:
 *   expired → swept → cap-near → expiring → healthy.
 *
 * `insolvent` is intentionally NOT derived in P0: accurate insolvency needs the
 * current-epoch `remainingAllowance` (GAP-4/5 extended snapshot), which the P0
 * snapshot doesn't carry — asserting it from P0 data would be a false claim
 * (invariant #9). The `insolvent` STATE still exists for the P2 budget widget.
 */
export function healthForSnapshot(
  snapshot: Pick<PcaSnapshot, 'expiresAtTimestamp' | 'fullySwept' | 'agentCount'>,
  nowSec: number = Math.floor(Date.now() / 1000),
): PcaHealthState {
  const { expiresAtTimestamp, fullySwept, agentCount } = snapshot;
  const hasExpiry = typeof expiresAtTimestamp === 'number' && expiresAtTimestamp > 0;
  if (isPcaExpired(snapshot, nowSec)) return 'expired';
  if (fullySwept) return 'swept';
  if (typeof agentCount === 'number' && agentCount >= PCA_CAP_NEAR_THRESHOLD) return 'cap-near';
  if (hasExpiry && expiresAtTimestamp - nowSec <= PCA_EXPIRING_SOON_SECONDS) return 'expiring';
  return 'healthy';
}
