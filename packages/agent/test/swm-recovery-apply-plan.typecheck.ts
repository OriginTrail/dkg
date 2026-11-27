import {
  createVerifiedSwmRecoveryApplyPlan,
  type VerifiedSwmRecoveryApplyPlan,
} from '../src/sync/requester/swm-recovery-apply.js';

const primaryInputs = {
  contextGraphId: 'typecheck-cg',
  rootData: [],
  roots: [],
  graphAssets: [],
  verifiedMeta: [],
} as const;

const canonical = createVerifiedSwmRecoveryApplyPlan(primaryInputs);
void canonical;

// @ts-expect-error Only the canonical builder can mint a verified apply plan.
const forged: VerifiedSwmRecoveryApplyPlan = primaryInputs;
void forged;

createVerifiedSwmRecoveryApplyPlan({
  ...primaryInputs,
  // @ts-expect-error Metadata graph projections are derived from verifiedMeta.
  rootMetaGraphs: ['did:dkg:context-graph:typecheck-cg/_shared_memory_meta'],
});

createVerifiedSwmRecoveryApplyPlan({
  ...primaryInputs,
  // @ts-expect-error Ownership updates are derived from the verified roots.
  ownershipUpdates: [],
});
