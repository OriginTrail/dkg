import type {
  ActiveLiftJobClaim,
  AsyncLiftPublisher,
  LiftJobAccepted,
  LiftJobClaimed,
} from '../../src/index.js';

declare const publisher: AsyncLiftPublisher;
declare const accepted: LiftJobAccepted;
declare const legacyClaimedWithoutFence: LiftJobClaimed;
declare const activeClaim: ActiveLiftJobClaim;

publisher.openClaimSession(activeClaim);
// @ts-expect-error An accepted record cannot manufacture live worker authority.
publisher.openClaimSession(accepted);
// @ts-expect-error A legacy claimed record without a required token/lease is not active authority.
publisher.openClaimSession(legacyClaimedWithoutFence);
