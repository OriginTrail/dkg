import type { DecimalU64V1, Digest32V1 } from './sync-wire-scalars.js';

/** Durable authority-lineage row shared by policy and applied-state codecs. */
export interface AgentProfileAppliedTransitionV1 {
  readonly priorAuthoritySequence: DecimalU64V1;
  readonly nextAuthoritySequence: DecimalU64V1;
  readonly transitionDigest: Digest32V1;
}

export type SystemRecordAuthorityDecisionV1 =
  | { readonly decision: 'accept' }
  | { readonly decision: 'stale' }
  | {
      readonly decision: 'quarantine';
      readonly reason: 'head-fork' | 'transition-equivocation';
    }
  | { readonly decision: 'reject'; readonly reason: string };
