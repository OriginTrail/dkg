// SPDX-License-Identifier: Apache-2.0

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
