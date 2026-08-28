import type {
  ActiveLiftJobClaim,
  ClaimSessionAsyncLiftPublisher,
  AsyncLiftPublisher,
  LiftJobAccepted,
  LiftJobClaimed,
} from '../../src/index.js';

declare const publisher: ClaimSessionAsyncLiftPublisher;
declare const accepted: LiftJobAccepted;
declare const legacyClaimedWithoutFence: LiftJobClaimed;
declare const activeClaim: ActiveLiftJobClaim;

publisher.openClaimSession(activeClaim);
// @ts-expect-error An accepted record cannot manufacture live worker authority.
publisher.openClaimSession(accepted);
// @ts-expect-error A legacy claimed record without a required token/lease is not active authority.
publisher.openClaimSession(legacyClaimedWithoutFence);

// The capability is additive: an implementation of the pre-session structural shape remains
// assignable to the public base interface.
declare const legacyPublisher: Omit<AsyncLiftPublisher, 'openClaimSession' | 'administrative'>;
const compatiblePublisher: AsyncLiftPublisher = legacyPublisher;
void compatiblePublisher;
