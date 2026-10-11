// SPDX-License-Identifier: Apache-2.0

import { errorCode, PcaFundingUnknownError } from './evm-adapter-errors.js';
import { isRetryableRpcError } from './evm-adapter-rpc.js';

/** The complete PCA capability required by strict adapter-owned planning. */
export interface PublisherConvictionPlanReader {
  getAccountId(publisherAddress: string): Promise<bigint>;
  getLockDurationEpochs(accountId: bigint): Promise<number>;
  canCover(accountId: bigint, baseCost: bigint): Promise<boolean>;
}

/**
 * Older ChainAdapter implementations predate the coverage probe. They still
 * expose enough information to preserve the historical PCA lock coercion.
 */
export interface LegacyPublisherConvictionPlanReader {
  getAccountId(publisherAddress: string): Promise<bigint>;
  getLockDurationEpochs(accountId: bigint): Promise<number>;
  canCover?: (accountId: bigint, baseCost: bigint) => Promise<boolean>;
}

interface PublisherCandidatePricingRequestBase {
  publisherAddress: string;
  explicitPublishEpochs?: number;
  defaultPublishEpochs: number;
}

/** Strict EVM planning always has a real AskStorage quote boundary. */
export interface QuotedPublisherCandidatePricingRequest
  extends PublisherCandidatePricingRequestBase {
  quote: (epochs: number, purpose: 'pca' | 'direct') => Promise<bigint>;
  conviction?: PublisherConvictionPlanReader;
}

/**
 * Compatibility planning deliberately permits old adapters without a quote or
 * coverage probe. Its result records when the protocol minimum was substituted.
 */
export interface LegacyPublisherCandidatePricingRequest
  extends PublisherCandidatePricingRequestBase {
  quote?: (epochs: number) => Promise<bigint>;
  conviction?: LegacyPublisherConvictionPlanReader;
}

interface PublisherCandidatePricingBase {
  publishEpochs: number;
  tokenAmount: bigint;
}

export type QuotedPublisherCandidatePricing =
  | (PublisherCandidatePricingBase & {
    source: 'pca';
    pricingMode: 'strict-quoted';
    quoteSource: 'chain';
    pca: {
      accountId: bigint;
      lockDurationEpochs: number;
      coverage: 'verified';
    };
    diagnostics: {
      pcaProbeError?: never;
    };
  })
  | (PublisherCandidatePricingBase & {
    source: 'direct';
    pricingMode: 'strict-quoted';
    quoteSource: 'chain';
    diagnostics: {
      pcaCandidate?: {
        accountId: bigint;
        lockDurationEpochs?: number;
      };
      pcaProbeError?: unknown;
    };
  });

export type LegacyPublisherCandidatePricing =
  | (PublisherCandidatePricingBase & {
    source: 'pca';
    pricingMode: 'legacy-compatibility';
    quoteSource: 'chain' | 'protocol-minimum';
    pca: {
      accountId: bigint;
      lockDurationEpochs: number;
      coverage: 'verified' | 'legacy-unchecked';
    };
    diagnostics: {
      quoteError?: unknown;
    };
  })
  | (PublisherCandidatePricingBase & {
    source: 'direct';
    pricingMode: 'legacy-compatibility';
    quoteSource: 'chain' | 'protocol-minimum';
    diagnostics: {
      pcaCandidate?: {
        accountId: bigint;
        lockDurationEpochs?: number;
      };
      pcaProbeError?: unknown;
      quoteError?: unknown;
    };
  });

function protocolMinimum(epochs: number): bigint {
  return BigInt(epochs);
}

function clampQuote(quoted: bigint, epochs: number): bigint {
  const minimum = protocolMinimum(epochs);
  return quoted > minimum ? quoted : minimum;
}

/**
 * Strict signer-specific pricing for adapter-owned planning. The direct-spend
 * quote is required and quote failure propagates: strict fundability must never
 * be decided from a manufactured protocol-minimum amount.
 */
export async function resolveQuotedPublisherCandidatePricing(
  request: QuotedPublisherCandidatePricingRequest,
): Promise<QuotedPublisherCandidatePricing> {
  const publishEpochs = request.explicitPublishEpochs ?? request.defaultPublishEpochs;
  let pcaAccountId: bigint | undefined;
  let pcaLockDurationEpochs: number | undefined;
  let pcaProbeError: unknown;

  if (request.explicitPublishEpochs === undefined && request.conviction) {
    try {
      const accountId = await request.conviction.getAccountId(request.publisherAddress);
      if (accountId > 0n) {
        pcaAccountId = accountId;
        const lockEpochs = await request.conviction.getLockDurationEpochs(accountId);
        if (lockEpochs > 0) {
          pcaLockDurationEpochs = lockEpochs;
          const lockTokenAmount = clampQuote(
            await request.quote(lockEpochs, 'pca'),
            lockEpochs,
          );
          if (await request.conviction.canCover(accountId, lockTokenAmount)) {
            return {
              source: 'pca',
              pricingMode: 'strict-quoted',
              quoteSource: 'chain',
              publishEpochs: lockEpochs,
              tokenAmount: lockTokenAmount,
              pca: {
                accountId,
                lockDurationEpochs: lockEpochs,
                coverage: 'verified',
              },
              diagnostics: {},
            };
          }
        }
      }
    } catch (error) {
      pcaProbeError = error;
    }
  }

  return {
    source: 'direct',
    pricingMode: 'strict-quoted',
    quoteSource: 'chain',
    publishEpochs,
    tokenAmount: clampQuote(
      await request.quote(publishEpochs, 'direct'),
      publishEpochs,
    ),
    diagnostics: {
      ...(pcaAccountId !== undefined
        ? {
          pcaCandidate: {
            accountId: pcaAccountId,
            ...(pcaLockDurationEpochs !== undefined
              ? { lockDurationEpochs: pcaLockDurationEpochs }
              : {}),
          },
        }
        : {}),
      ...(pcaProbeError !== undefined ? { pcaProbeError } : {}),
    },
  };
}

/**
 * Explicit legacy policy. Missing coverage preserves pre-probe PCA lock
 * coercion; missing/failed quotes deliberately substitute the protocol minimum
 * and expose that choice through quoteSource and diagnostics.
 */
export async function resolveLegacyPublisherCandidatePricing(
  request: LegacyPublisherCandidatePricingRequest,
): Promise<LegacyPublisherCandidatePricing> {
  let publishEpochs = request.explicitPublishEpochs ?? request.defaultPublishEpochs;
  let pcaAccountId: bigint | undefined;
  let pcaLockDurationEpochs: number | undefined;
  let pcaProbeError: unknown;
  let pcaCoverage: 'verified' | 'legacy-unchecked' | undefined;
  let verifiedPcaTokenAmount: bigint | undefined;

  if (request.explicitPublishEpochs === undefined && request.conviction) {
    try {
      const accountId = await request.conviction.getAccountId(request.publisherAddress);
      if (accountId > 0n) {
        pcaAccountId = accountId;
        const lockEpochs = await request.conviction.getLockDurationEpochs(accountId);
        if (lockEpochs > 0) {
          pcaLockDurationEpochs = lockEpochs;
          if (!request.conviction.canCover) {
            // Historical adapters coerced an omitted lifetime as soon as the
            // registered account and positive lock were observable.
            publishEpochs = lockEpochs;
            pcaCoverage = 'legacy-unchecked';
          } else if (request.quote) {
            const lockTokenAmount = clampQuote(await request.quote(lockEpochs), lockEpochs);
            if (await request.conviction.canCover(accountId, lockTokenAmount)) {
              publishEpochs = lockEpochs;
              pcaCoverage = 'verified';
              verifiedPcaTokenAmount = lockTokenAmount;
            }
          }
        }
      }
    } catch (error) {
      pcaProbeError = error;
    }
  }

  let tokenAmount = verifiedPcaTokenAmount;
  let quoteError: unknown;
  let quoteSource: 'chain' | 'protocol-minimum' = tokenAmount === undefined
    ? 'protocol-minimum'
    : 'chain';
  if (tokenAmount === undefined && request.quote) {
    try {
      tokenAmount = clampQuote(await request.quote(publishEpochs), publishEpochs);
      quoteSource = 'chain';
    } catch (error) {
      quoteError = error;
    }
  }
  tokenAmount ??= protocolMinimum(publishEpochs);

  if (pcaCoverage && pcaAccountId !== undefined && pcaLockDurationEpochs !== undefined) {
    return {
      source: 'pca',
      pricingMode: 'legacy-compatibility',
      quoteSource,
      publishEpochs,
      tokenAmount,
      pca: {
        accountId: pcaAccountId,
        lockDurationEpochs: pcaLockDurationEpochs,
        coverage: pcaCoverage,
      },
      diagnostics: {
        ...(quoteError !== undefined ? { quoteError } : {}),
      },
    };
  }

  return {
    source: 'direct',
    pricingMode: 'legacy-compatibility',
    quoteSource,
    publishEpochs,
    tokenAmount,
    diagnostics: {
      ...(pcaAccountId !== undefined
        ? {
          pcaCandidate: {
            accountId: pcaAccountId,
            ...(pcaLockDurationEpochs !== undefined
              ? { lockDurationEpochs: pcaLockDurationEpochs }
              : {}),
          },
        }
        : {}),
      ...(pcaProbeError !== undefined ? { pcaProbeError } : {}),
      ...(quoteError !== undefined ? { quoteError } : {}),
    },
  };
}

/** The funding verdict retains the exact candidate and its observed balances. */
export type PublisherCandidateFundingAssessment<T> =
  | { kind: 'funded' | 'unfunded'; candidate: T; funding: PublisherCandidateBalances }
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

export function preferredFundableCandidate<T extends { address: string }>(
  candidates: T[],
  fundableIdx: number[],
  policy: { preferIdle: boolean; idleAwareSelectionDisabled: boolean; laneState: (address: string) => 'idle' | 'busy' | 'stalled' },
): T {
  if (policy.preferIdle && !policy.idleAwareSelectionDisabled) {
    // GH#953 — soft-prefer a wallet with no in-flight or queued write.
    // GH#1574 — a lane whose holder is wedged is NOT idle, but it is not
    // healthy either: routing new work behind it inherits the wedge
    // invisibly, which is the failure that issue reports. Rank the
    // serializer's OWN health verdict rather than reading raw timings and
    // re-deriving the threshold here — two copies of that policy would
    // drift, and diagnostics could call a lane stalled while selection
    // still called it healthy.
    const laneRank: Record<'idle' | 'busy' | 'stalled', number> = {
      idle: 0,
      busy: 1,
      stalled: 2,
    };
    const rank = (address: string): number =>
      laneRank[policy.laneState(address)];
    let best: number | undefined;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const index of fundableIdx) {
      const r = rank(candidates[index].address);
      if (r < bestRank) { bestRank = r; best = index; }
      if (bestRank === 0) break;
    }
    if (best !== undefined) return candidates[best];
  }
  return candidates[fundableIdx[0]];
}

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
  candidates: T[];
  assess: () => Promise<PublisherFundingSelection<T>>;
  reprice: (candidate: T) => Promise<T>;
  readFunding: (address: string) => Promise<PublisherCandidateBalances>;
  conviction: () => PublisherConvictionPlanReader | undefined;
  nativeFloorWei: bigint;
  tracFloorWei: bigint;
}): Promise<T> {
  let selection = await input.assess();
  if (selection.kind === 'funded') return selection.candidate;
  if (selection.kind === 'unavailable') throw selection.error;
  if (!input.candidates.some((candidate) => candidate.pcaPricing.kind === 'unavailable')) throw selection.error;
  const canStillUsePca = async (candidate: T): Promise<boolean> => {
    const funds = await input.readFunding(candidate.address);
    if (funds.native !== null && funds.native <= input.nativeFloorWei) return false;
    return funds.trac !== null && !(funds.trac > input.tracFloorWei && funds.trac >= candidate.tokenAmount);
  };

  // A failed lock/coverage lookup can leave a direct-spend lifetime that is
  // wrong for a real PCA. Re-price only candidates that can still use PCA.
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index];
    if (candidate.pcaPricing.kind === 'available' || !await canStillUsePca(candidate)) continue;
    input.candidates[index] = await input.reprice(candidate);
  }

  selection = await input.assess();
  if (selection.kind === 'funded') return selection.candidate;
  if (selection.kind === 'unavailable') throw selection.error;
  // A strict false can be only a lifetime mismatch against direct-spend
  // fallback pricing. It did not probe coverage at the PCA's real lock.
  for (const candidate of input.candidates) {
    if (candidate.pcaPricing.kind === 'available' || !await canStillUsePca(candidate)) continue;
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
