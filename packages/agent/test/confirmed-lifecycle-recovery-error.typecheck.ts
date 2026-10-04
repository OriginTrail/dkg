import { ConfirmedNamedKaVmLifecycleRecoveryError, isConfirmedNamedKaVmLifecycleRecoveryError,
  type ConfirmedNamedKaVmPublication, type ConfirmedNamedKaVmLifecycleRecovery,
  type ConfirmedNamedKaVmPublicationView, type ConfirmedNamedKaVmLifecycleRecoveryView } from '../src/index.js';
import type { ConfirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-repair.js';
declare const publication: ConfirmedNamedKaVmPublication;
declare const input: ConfirmedNamedKaVmLifecycleInput;
new ConfirmedNamedKaVmLifecycleRecoveryError(publication, input, new Error('journal unavailable'));
const completeProducerRecovery: ConfirmedNamedKaVmLifecycleRecovery = new ConfirmedNamedKaVmLifecycleRecoveryError(publication, input, undefined).lifecycleRecovery;
void completeProducerRecovery;
// @ts-expect-error A tentative publication is not confirmed recovery evidence.
new ConfirmedNamedKaVmLifecycleRecoveryError({ ...publication, status: 'tentative' }, input, undefined);
const { assertionUri, ...unsealedPublication } = publication;
// @ts-expect-error The confirmed assertion coordinate is required at the package boundary.
new ConfirmedNamedKaVmLifecycleRecoveryError(unsealedPublication, input, undefined);
const { assertionVersion, ...incompleteRecovery } = input;
// @ts-expect-error Recovery must carry the confirmed assertion version.
new ConfirmedNamedKaVmLifecycleRecoveryError(publication, incompleteRecovery, undefined);
declare const failure: unknown;
if (isConfirmedNamedKaVmLifecycleRecoveryError(failure)) {
  const recovery: ConfirmedNamedKaVmLifecycleRecoveryView = failure.lifecycleRecovery;
  const receipt: ConfirmedNamedKaVmPublicationView = failure.confirmedPublication;
  // @ts-expect-error Structural recognition does not certify concrete producer class aliases.
  void failure.publishedUal;
  // @ts-expect-error A structural author view does not certify the complete attestation seal.
  void receipt.seal.authorAttestationR;
  // @ts-expect-error Opaque receipt extras are not certified by the HTTP projection contract.
  void receipt.onChainResult?.batchId;
  // @ts-expect-error Structural recovery does not certify optional internal deployment evidence.
  void recovery.publicationDeployment;
  // @ts-expect-error Confirmed recovery never authorizes publication retry.
  const resend: true = recovery.publicationRetrySafe;
  void receipt; void resend;
}
void assertionUri; void assertionVersion;

import type { PublishResult } from '@origintrail-official/dkg-publisher';
declare const genericPublication: PublishResult;
// @ts-expect-error Generic publishing does not own the agent's lifecycle repair worker.
void genericPublication.lifecycleRepairPending;

import type { DKGAgent, NamedKaVmPublishResult } from '../src/index.js';
declare const namedPublication: NamedKaVmPublishResult;
const pendingRepair: boolean | undefined = namedPublication.lifecycleRepairPending;
declare const queuedResult: Awaited<ReturnType<DKGAgent['publishQueuedKnowledgeAssetVmPublish']>>;
declare const finalizedResult: Awaited<ReturnType<DKGAgent['publishFromFinalizedAssertion']>>;
const queuedPublication: NamedKaVmPublishResult = queuedResult;
const finalizedPublication: NamedKaVmPublishResult = finalizedResult;
const queuedPending: boolean | undefined = queuedResult.lifecycleRepairPending;
const finalizedPending: boolean | undefined = finalizedResult.lifecycleRepairPending;
const confirmedPending: boolean | undefined = publication.lifecycleRepairPending;
const confirmedResult: NamedKaVmPublishResult = publication;
void pendingRepair; void queuedPublication; void finalizedPublication; void confirmedResult;
void queuedPending; void finalizedPending; void confirmedPending;
