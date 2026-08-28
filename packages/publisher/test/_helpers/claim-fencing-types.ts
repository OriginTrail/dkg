import type {
  ActiveLiftJobClaim,
  ClaimSessionAsyncLiftPublisher,
  AsyncLiftPublisher,
  LiftJob,
  LiftJobAccepted,
  LiftJobClaimed,
  TripleStoreAsyncLiftPublisher,
} from '../../src/index.js';
import {
  isKnownLiftJobPayload,
  type StructurallyValidLiftJobPayload,
} from '../../src/async-lift-publisher-utils.js';

declare const publisher: TripleStoreAsyncLiftPublisher;
declare const accepted: LiftJobAccepted;
declare const legacyClaimedWithoutFence: LiftJobClaimed;
declare const activeClaim: ActiveLiftJobClaim;

const concreteCapability: ClaimSessionAsyncLiftPublisher = publisher;
void concreteCapability;
publisher.openClaimSession(activeClaim);
const narrowedClaim: Promise<ActiveLiftJobClaim | null> = publisher.claimNext('wallet-1');
void narrowedClaim;
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

declare const structurallyDecoded: StructurallyValidLiftJobPayload;
// @ts-expect-error An unchecked status:string cannot enter lifecycle code as a LiftJob.
const uncheckedJob: LiftJob = structurallyDecoded;
void uncheckedJob;
if (isKnownLiftJobPayload(structurallyDecoded)) {
  const checkedJob: LiftJob = structurallyDecoded;
  void checkedJob;
}
