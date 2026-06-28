// Shared Publishing Conviction Account (PCA) sub-components — mocked once and
// reused across S1–S7 (UX proposal §4). See the per-file docs for the invariant
// each one carries.
export { CopyButton, useCopy } from './CopyButton.js';
export { truncateAddress } from './format.js';
export { HealthChip, HEALTH_CHIP_META, type PcaHealthState } from './HealthChip.js';
export { WalletRow, type WalletRowTone } from './WalletRow.js';
export { AddressCrux, DEFAULT_ADDRESS_CRUX_NOTE } from './AddressCrux.js';
export {
  DiscountTierLadder,
  discountTierForTrac,
  PCA_DISCOUNT_TIERS,
  type PcaDiscountTier,
} from './DiscountTierLadder.js';
export {
  DiscountAppliedBadge,
  convictionDiscountBps,
  type ConvictionCostCovered,
} from './DiscountAppliedBadge.js';
export {
  EligibilityVerdictBanner,
  type PcaVerdict,
} from './EligibilityVerdictBanner.js';
export { SponsorshipHandshake } from './SponsorshipHandshake.js';
