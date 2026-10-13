/** Compatibility exports for the former selected-only metadata module. */
export {
  createSwmMetaRetentionBudget as createSelectedSwmMetaRetentionBudget,
  SwmMetaRetentionBudgetError as SelectedSwmMetaRetentionBudgetError,
} from './swm-meta-budget.js';
export type {
  SwmMetaRetentionLimits as SelectedSwmMetaRetentionLimits,
  SwmMetaRetentionExhaustionV1 as SelectedSwmMetaRetentionExhaustionV1,
  SwmMetaRetentionReservation as SelectedSwmMetaRetentionReservation,
  SwmMetaRetentionLease as SelectedSwmMetaRetentionLease,
} from './swm-meta-budget.js';
