// Shared Publishing Conviction Account (PCA) sub-components — mocked once and
// reused across S1–S7 (UX proposal §4). See the per-file docs for the invariant
// each one carries.
export { CopyButton, useCopy } from './CopyButton.js';
export {
  truncateAddress,
  formatPcaTrac,
  formatWeiToTrac,
  formatRelativeExpiry,
  nativeGasSymbol,
  isTestnetChain,
} from './format.js';
export { HealthChip, HEALTH_CHIP_META } from './HealthChip.js';
// #1355 V2 — health derivation (healthForSnapshot / PcaHealthState / the threshold
// constants) is imported DIRECTLY from the domain module `pca/health.js` by every
// consumer, so the barrel no longer re-exports it.
export { WalletRow, type WalletRowTone } from './WalletRow.js';
export { PcaAgentList, type PcaAgentListProps } from './PcaAgentList.js';
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
export { PrimaryNodePicker, type PrimaryNodeOption } from './PrimaryNodePicker.js';
export { WalletConnectControl } from './WalletConnectControl.js';
export { WalletPill } from './WalletPill.js';
export {
  DeviceConfirmProgress,
  type DeviceConfirmStep,
  type DeviceConfirmStepState,
} from './DeviceConfirmProgress.js';
