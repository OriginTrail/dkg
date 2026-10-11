import { preferredFundableCandidate } from '../src/signer-selection.js';
import type { PublisherFundingSelection, PublisherPcaPricingEvidence } from '../src/evm-publisher-funding.js';

const candidate = { address: 'wallet' };
// @ts-expect-error A funded verdict must identify its wallet.
const missingCandidate: PublisherFundingSelection<typeof candidate> = { kind: 'funded' };
// @ts-expect-error Unavailable PCA pricing must preserve the failed read evidence.
const missingEvidence: PublisherPcaPricingEvidence = { kind: 'unavailable' };
// @ts-expect-error Available PCA pricing cannot carry a failed read.
const contradictoryEvidence: PublisherPcaPricingEvidence = { kind: 'available', error: new Error() };
void [missingCandidate, missingEvidence, contradictoryEvidence];

const policy = { preferIdle: false, idleAwareSelectionDisabled: false, laneState: () => 'idle' as const };
const assessed = [{ candidate, funding: { native: 1n, trac: 0n } }];
const selected = preferredFundableCandidate(assessed, policy);
const selectedAddress: string = selected.address;
// @ts-expect-error Selection owns candidate-bearing records, not a separate index array.
preferredFundableCandidate([candidate], [0], policy);
// @ts-expect-error A balance snapshot without its candidate cannot be selected.
preferredFundableCandidate([{ funding: { native: 1n, trac: 0n } }], policy);
void selectedAddress;
