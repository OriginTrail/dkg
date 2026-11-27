// What a purchase holds between Continue and Confirm, shared by the flow that
// sends it and the confirmation that shows it.
import type { FundingRequest, PlanRequest, Preview } from '../api/types.js';

/**
 * What the confirmation shows and what Confirm sends, fixed when Continue is
 * pressed: a funding of the epoch the node's dry run answered for, named by
 * its number so that an epoch boundary cannot move it, with that answer and
 * the plan it saves; or the plan alone.
 */
export type Confirming =
  | { kind: 'fund'; request: FundingRequest & { epoch: number }; preview: Preview; plan: PlanRequest }
  | { kind: 'plan'; plan: PlanRequest };

export type FundConfirming = Extract<Confirming, { kind: 'fund' }>;
