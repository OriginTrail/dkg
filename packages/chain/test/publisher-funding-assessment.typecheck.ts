import { preferredFundableCandidate } from '../src/signer-selection.js';
import { reconcilePublisherCandidateFunding, type PublisherCandidateFundingAssessment, type PublisherFundingSelection, type PublisherPcaPricingEvidence } from '../src/evm-publisher-funding.js';
import { InsufficientPublisherFundsError } from '../src/evm-adapter-errors.js';

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
const selectedAddress: string | undefined = selected?.address;
// @ts-expect-error A possibly empty assessment list cannot guarantee a candidate.
const guaranteedCandidate: typeof candidate = selected;
// @ts-expect-error Selection owns candidate-bearing records, not a separate index array.
preferredFundableCandidate([candidate], [0], policy);
// @ts-expect-error A balance snapshot without its candidate cannot be selected.
preferredFundableCandidate([{ funding: { native: 1n, trac: 0n } }], policy);
void [selectedAddress, guaranteedCandidate];

// @ts-expect-error Settled candidate evidence must own its refreshed PCA eligibility.
const missingEligibility: PublisherCandidateFundingAssessment<typeof candidate> = { kind: 'unfunded', candidate, funding: { native: 1n, trac: 0n } };
const independentPolicy: Parameters<typeof reconcilePublisherCandidateFunding>[0] = {
  candidates: [], assess: async () => { throw new Error('type-only port'); },
  reprice: async (value) => value, conviction: () => undefined,
  // @ts-expect-error Reconciliation cannot configure a second balance/floor policy.
  readFunding: async () => ({ native: 1n, trac: 0n }), nativeFloorWei: 0n, tracFloorWei: 0n,
};
void [missingEligibility, independentPolicy];

type UnfundedSelection = Extract<PublisherFundingSelection<typeof candidate>, { kind: 'unfunded' }>;
const unfundedError = new InsufficientPublisherFundsError('type-only', []);
const settledEvidence = { candidate, funding: { native: 1n, trac: 0n }, refreshPcaEligibility: async () => true };
// @ts-expect-error An unfunded selection cannot contain a funded assessment.
const contradictoryUnfunded: UnfundedSelection = { kind: 'unfunded', assessments: [{ ...settledEvidence, kind: 'funded' }], error: unfundedError };
// @ts-expect-error Unavailable evidence belongs to the unavailable selection.
const unavailableUnfunded: UnfundedSelection = { kind: 'unfunded', assessments: [{ candidate, funding: settledEvidence.funding, kind: 'unavailable', error: new Error() }], error: unfundedError };
void [contradictoryUnfunded, unavailableUnfunded];
