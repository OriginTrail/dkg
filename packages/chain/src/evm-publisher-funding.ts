// SPDX-License-Identifier: Apache-2.0

import { errorCode, PcaFundingUnknownError } from './evm-adapter-errors.js';
import { isRetryableRpcError } from './evm-adapter-rpc.js';
import type { PublisherConvictionPlanReader } from './publisher-plan.js';

/** The verdict retains its candidate, observed balances, and owner-bound fresh eligibility. */
export type PublisherCandidateFundingAssessment<T> =
  | { kind: 'funded' | 'unfunded'; candidate: T; funding: PublisherCandidateBalances;
      /** Refresh at the decision point using this candidate's assessed funding mode. */
      refreshPcaEligibility: () => Promise<boolean> }
  | { kind: 'unavailable'; candidate: T; funding: PublisherCandidateBalances; error: unknown };

export interface PublisherCandidateBalances {
  native: bigint | null;
  trac: bigint | null;
}

/** Funding selection is settled evidence, not an exception-driven policy branch. */
export type PublisherFundingSelection<T> =
  | { kind: 'funded'; candidate: T }
  | { kind: 'unfunded'; assessments: readonly PublisherCandidateFundingAssessment<T>[];
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
  const candidates = [...input.candidates];
  let selection = await input.assess(candidates.slice());
  if (selection.kind === 'funded') return selection.candidate;
  if (selection.kind === 'unavailable') throw selection.error;
  if (!candidates.some((candidate) => candidate.pcaPricing.kind === 'unavailable')) throw selection.error;
  const canStillUsePca = async (candidate: T, assessments: readonly PublisherCandidateFundingAssessment<T>[]): Promise<boolean> => {
    const assessment = assessments.find((value) => value.candidate === candidate);
    return assessment?.kind === 'unfunded' && await assessment.refreshPcaEligibility();
  };

  // A failed lock/coverage lookup can leave a direct-spend lifetime that is
  // wrong for a real PCA. Re-price only candidates that can still use PCA.
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate.pcaPricing.kind === 'available' || !await canStillUsePca(candidate, selection.assessments)) continue;
    candidates[index] = await input.reprice(candidate);
  }

  selection = await input.assess(candidates.slice());
  if (selection.kind === 'funded') return selection.candidate;
  if (selection.kind === 'unavailable') throw selection.error;
  // A strict false can be only a lifetime mismatch against direct-spend
  // fallback pricing. It did not probe coverage at the PCA's real lock.
  for (const candidate of candidates) {
    if (candidate.pcaPricing.kind === 'available' || !await canStillUsePca(candidate, selection.assessments)) continue;
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
