import { ConfirmedNamedKaVmLifecycleRecoveryError, isConfirmedNamedKaVmLifecycleRecoveryError,
  type ConfirmedNamedKaVmPublication, type ConfirmedNamedKaVmLifecycleRecovery } from '../src/index.js';
import type { ConfirmedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle-repair.js';
declare const publication: ConfirmedNamedKaVmPublication;
declare const input: ConfirmedNamedKaVmLifecycleInput;
new ConfirmedNamedKaVmLifecycleRecoveryError(publication, input, new Error('journal unavailable'));
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
  const recovery: ConfirmedNamedKaVmLifecycleRecovery = failure.lifecycleRecovery;
  const receipt: ConfirmedNamedKaVmPublication = failure.confirmedPublication;
  // @ts-expect-error Confirmed recovery never authorizes publication retry.
  const resend: true = recovery.publicationRetrySafe;
  void receipt; void resend;
}
void assertionUri; void assertionVersion;
