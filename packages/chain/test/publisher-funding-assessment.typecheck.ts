import type { PublisherFundingSelection, PublisherPcaPricingEvidence } from '../src/publisher-plan.js';

const candidate = { address: 'wallet' };
// @ts-expect-error A funded verdict must identify its wallet.
const missingCandidate: PublisherFundingSelection<typeof candidate> = { kind: 'funded' };
// @ts-expect-error Unavailable PCA pricing must preserve the failed read evidence.
const missingEvidence: PublisherPcaPricingEvidence = { kind: 'unavailable' };
// @ts-expect-error Available PCA pricing cannot carry a failed read.
const contradictoryEvidence: PublisherPcaPricingEvidence = { kind: 'available', error: new Error() };
void [missingCandidate, missingEvidence, contradictoryEvidence];
