import type {
  ActiveLiftJobClaim,
  ClaimSessionAsyncLiftPublisher,
  AsyncLiftPublisher,
  LiftJob,
  LiftJobAccepted,
  LiftJobClaimed,
  LiftJobBroadcast,
  LiftJobFailedFromBroadcast,
  LiftJobLegacyEvidenceFreeBroadcast,
  LiftJobPersistedFailure,
  PersistedLiftJob,
  PendingTransactionClearOverride,
  TripleStoreAsyncLiftPublisher,
} from '../../src/index.js';
import type { LiftJobTransaction } from '../../src/async-lift-claim-session.js';
import {
  canonicalLiftJobPayload,
  type LiftJobPayloadDecodeResult,
  type StructurallyValidLiftJobPayload,
} from '../../src/lift-job-payload-codec.js';

declare const publisher: TripleStoreAsyncLiftPublisher;
declare const accepted: LiftJobAccepted;
declare const legacyClaimedWithoutFence: LiftJobClaimed;
declare const activeClaim: ActiveLiftJobClaim;

const agentClearAuthority: PendingTransactionClearOverride = {
  kind: 'agent',
  requestedBy: 'did:dkg:agent:owner',
};
const nodeOperatorClearAuthority: PendingTransactionClearOverride = { kind: 'nodeOperator' };
void agentClearAuthority;
void nodeOperatorClearAuthority;
// @ts-expect-error A pending-transaction override must name an authority variant.
const emptyClearAuthority: PendingTransactionClearOverride = {};
const contradictoryClearAuthority: PendingTransactionClearOverride = {
  kind: 'agent',
  requestedBy: 'did:dkg:agent:owner',
  // @ts-expect-error Agent and node-operator authority cannot coexist in one request.
  requestedByNodeOperator: true,
};
void emptyClearAuthority;
void contradictoryClearAuthority;

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
declare const decoded: LiftJobPayloadDecodeResult;
if (decoded.kind === 'canonical') {
  const writableJob: LiftJob = decoded.job;
  void writableJob;
}
if (decoded.kind === 'compatibility') {
  const checkedJob: PersistedLiftJob = decoded.job;
  // @ts-expect-error A compatibility classification cannot receive canonical write authority.
  const writableJob: LiftJob = decoded.job;
  void checkedJob;
  void writableJob;
}
const canonicalJob = canonicalLiftJobPayload(structurallyDecoded);
if (canonicalJob) {
  const writableJob: LiftJob = canonicalJob;
  void writableJob;
}

declare const canonicalBroadcast: LiftJobBroadcast;
declare const canonicalBroadcastFailure: LiftJobFailedFromBroadcast;
declare const legacyBroadcast: LiftJobLegacyEvidenceFreeBroadcast;
declare const irregularFailure: LiftJobPersistedFailure;
const broadcastHash: `0x${string}` = canonicalBroadcast.broadcast.txHash;
const failedBroadcastHash: `0x${string}` = canonicalBroadcastFailure.broadcast.txHash;
void broadcastHash;
void failedBroadcastHash;
// @ts-expect-error A compatibility broadcast cannot enter the writable lifecycle union.
const writableLegacyBroadcast: LiftJob = legacyBroadcast;
// @ts-expect-error A broad historical failure cannot erase canonical failed-state guarantees.
const writableIrregularFailure: LiftJob = irregularFailure;
void writableLegacyBroadcast;
void writableIrregularFailure;

declare const persistedRead: PersistedLiftJob;
if (persistedRead.status === 'broadcast') {
  // @ts-expect-error A persisted compatibility broadcast must be migrated before evidence is assumed.
  const uncheckedBroadcastHash: `0x${string}` = persistedRead.broadcast.txHash;
  void uncheckedBroadcastHash;
}

declare const transaction: LiftJobTransaction;
if (transaction.kind === 'compatibility') {
  transaction.scope.commitRemoval();
  // @ts-expect-error Compatibility rows are never given ordinary lifecycle transition authority.
  transaction.scope.commit(transaction.current, 'broadcast');
  // @ts-expect-error Compatibility rows cannot manufacture proof-inclusion authority.
  transaction.scope.commitProofInclusion(transaction.current);
}
