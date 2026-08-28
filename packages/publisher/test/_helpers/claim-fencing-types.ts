import type {
  ActiveLiftJobClaim,
  ClaimSessionAsyncLiftPublisher,
  AsyncLiftPublisher,
  LiftJob,
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

// Freeze the changed part of the pre-session contract independently of the current interface.
// In particular, old structural implementations returned the broad persisted LiftJob shape;
// deriving this member from AsyncLiftPublisher would make the compatibility check tautological.
type LegacyAsyncLiftPublisher =
  Omit<AsyncLiftPublisher, 'claimNext' | 'openClaimSession' | 'administrative'>
  & { claimNext(walletId: string): Promise<LiftJob | null> };
declare const legacyPublisher: LegacyAsyncLiftPublisher;
const compatiblePublisher: AsyncLiftPublisher = legacyPublisher;
void compatiblePublisher;
