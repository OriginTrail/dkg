import { failSystemRecordObjectV1 as fail } from './system-record-codec-primitives-v1.js';
import type { AgentProfileActiveHeadObjectV1 } from './system-record-agent-profile-head-codec-v1-internal.js';
import type { AgentProfileAppliedTransitionV1 } from './system-record-authority-types-v1-internal.js';
import type { Digest32V1 } from './sync-wire-scalars.js';

const MINT_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARY_V1 = Symbol(
  'mint-agent-profile-verified-authority-summary-v1',
);
const MINTED_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARIES_V1 = new WeakSet<object>();

class AgentProfileVerifiedAuthoritySummaryValueV1 {
  declare private readonly __opaqueAgentProfileVerifiedAuthoritySummaryV1: void;

  constructor(
    token: typeof MINT_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARY_V1,
    public readonly candidateHeadDigest: Digest32V1,
    public readonly transitionLineage: readonly AgentProfileAppliedTransitionV1[],
    public readonly historicalRoots: readonly string[],
    public readonly lastAuthorityTransitionPriorHeadDigest?: Digest32V1,
    public readonly tombstonePredecessor?: AgentProfileActiveHeadObjectV1,
    public readonly deletionTableDigest?: Digest32V1,
  ) {
    if (token !== MINT_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARY_V1) {
      fail('system-record-closure', 'verified authority summary is factory-only');
    }
    MINTED_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARIES_V1.add(this);
    Object.freeze(this);
  }
}

/**
 * Process- and module-instance-local authority capability. Serialization,
 * structured cloning, worker transfer, reconstruction, or verification by a
 * duplicate loaded module instance does not preserve authority.
 */
export type AgentProfileVerifiedAuthoritySummaryV1 = AgentProfileVerifiedAuthoritySummaryValueV1;

export function assertAgentProfileVerifiedAuthoritySummaryV1(
  value: unknown,
): asserts value is AgentProfileVerifiedAuthoritySummaryV1 {
  if (!isAgentProfileVerifiedAuthoritySummaryV1(value)) {
    fail(
      'system-record-closure',
      'verified authority summary was not minted by closure verification',
    );
  }
}

export function isAgentProfileVerifiedAuthoritySummaryV1(
  value: unknown,
): value is AgentProfileVerifiedAuthoritySummaryV1 {
  return (
    value !== null &&
    typeof value === 'object' &&
    MINTED_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARIES_V1.has(value) &&
    value instanceof AgentProfileVerifiedAuthoritySummaryValueV1
  );
}

export function mintAgentProfileVerifiedAuthoritySummaryV1(
  input: Readonly<{
    candidateHeadDigest: Digest32V1;
    transitionLineage: readonly AgentProfileAppliedTransitionV1[];
    historicalRoots: readonly string[];
    lastAuthorityTransitionPriorHeadDigest?: Digest32V1;
    tombstonePredecessor?: AgentProfileActiveHeadObjectV1;
    deletionTableDigest?: Digest32V1;
  }>,
): AgentProfileVerifiedAuthoritySummaryV1 {
  return new AgentProfileVerifiedAuthoritySummaryValueV1(
    MINT_AGENT_PROFILE_VERIFIED_AUTHORITY_SUMMARY_V1,
    input.candidateHeadDigest,
    input.transitionLineage,
    input.historicalRoots,
    input.lastAuthorityTransitionPriorHeadDigest,
    input.tombstonePredecessor,
    input.deletionTableDigest,
  );
}
