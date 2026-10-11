// SPDX-License-Identifier: Apache-2.0

import { errorCode, PcaFundingUnknownError } from './evm-adapter-errors.js';
import { isRetryableRpcError } from './evm-adapter-rpc.js';
import type { PublisherConvictionPlanReader } from './publisher-plan.js';

/** The verdict retains its candidate, observed balances, and owner-bound fresh eligibility. */
interface PublisherSettledFundingEvidence<T> {
  candidate: T;
  funding: PublisherCandidateBalances;
  /** Refresh at the decision point using this candidate's assessed funding mode. */
  refreshPcaEligibility: () => Promise<boolean>;
}

export type PublisherUnfundedCandidateFundingAssessment<T> = PublisherSettledFundingEvidence<T> & { kind: 'unfunded' };

export type PublisherCandidateFundingAssessment<T> =
  | (PublisherSettledFundingEvidence<T> & { kind: 'funded' })
  | PublisherUnfundedCandidateFundingAssessment<T>
  | { kind: 'unavailable'; candidate: T; funding: PublisherCandidateBalances; error: unknown };

export interface PublisherCandidateBalances {
  native: bigint | null;
  trac: bigint | null;
}

/** Funding selection is settled evidence, not an exception-driven policy branch. */
export type PublisherFundingSelection<T> =
  | { kind: 'funded'; candidate: T }
  | { kind: 'unfunded'; assessments: readonly PublisherUnfundedCandidateFundingAssessment<T>[];
      error: import('./evm-adapter-errors.js').InsufficientPublisherFundsError }
  | { kind: 'unavailable'; assessments: readonly PublisherCandidateFundingAssessment<T>[];
      error: import('./evm-adapter-errors.js').PcaFundingUnknownError };

export type PublisherPcaPricingEvidence =
  | { kind: 'available' }
  | { kind: 'unavailable'; error: unknown };

/** Candidate ownership is retained across pricing, funding and fresh reconciliation. */
export async function reconcilePublisherCandidateFunding<T extends {
  address: string;
  publishEpochs: number;
  tokenAmount: bigint;
  pcaPricing: PublisherPcaPricingEvidence;
}>(input: {
  candidates: readonly T[];
  assess: (candidates: readonly T[]) => Promise<PublisherFundingSelection<T>>;
  reprice: (candidate: T) => Promise<T>;
  conviction: () => PublisherConvictionPlanReader | undefined;
}): Promise<T> {
  let selection = await input.assess([...input.candidates]);
  if (selection.kind === 'funded') return selection.candidate;
  if (selection.kind === 'unavailable') throw selection.error;
  if (!selection.assessments.some(({ candidate }) => candidate.pcaPricing.kind === 'unavailable')) throw selection.error;

  // A failed lock/coverage lookup can leave a direct-spend lifetime that is
  // wrong for a real PCA. Re-price only candidates that can still use PCA.
  const repricedCandidates: T[] = [];
  for (const assessment of selection.assessments) {
    const candidate = assessment.candidate;
    repricedCandidates.push(candidate.pcaPricing.kind === 'available' || !await assessment.refreshPcaEligibility()
      ? candidate : await input.reprice(candidate));
  }

  selection = await input.assess(repricedCandidates);
  if (selection.kind === 'funded') return selection.candidate;
  if (selection.kind === 'unavailable') throw selection.error;
  // A strict false can be only a lifetime mismatch against direct-spend
  // fallback pricing. It did not probe coverage at the PCA's real lock.
  for (const assessment of selection.assessments) {
    const candidate = assessment.candidate;
    if (candidate.pcaPricing.kind === 'available' || !await assessment.refreshPcaEligibility()) continue;
    const reader = input.conviction();
    if (!reader) continue;
    let accountId: bigint;
    let lockEpochs: number;
    try {
      accountId = await reader.getAccountId(candidate.address);
      if (accountId <= 0n) continue;
      lockEpochs = await reader.getLockDurationEpochs(accountId);
    } catch (readError) {
      if (isRetryableRpcError(readError) || errorCode(readError) === 'CALL_EXCEPTION') {
        throw new PcaFundingUnknownError(errorCode(readError));
      }
      throw readError;
    }
    if (lockEpochs > 0 && lockEpochs !== candidate.publishEpochs) {
      throw new PcaFundingUnknownError(errorCode(candidate.pcaPricing.error));
    }
  }
  throw selection.error;
}
