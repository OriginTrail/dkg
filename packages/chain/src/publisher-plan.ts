// SPDX-License-Identifier: Apache-2.0

/**
 * The narrow PCA capability needed to price one publisher candidate. EVM
 * adapters provide it from their conviction mixin; legacy adapters can expose
 * the same three reads through the public ChainAdapter compatibility surface.
 */
export interface PublisherConvictionPlanReader {
  getAccountId(publisherAddress: string): Promise<bigint>;
  getLockDurationEpochs(accountId: bigint): Promise<number>;
  canCover(accountId: bigint, baseCost: bigint): Promise<boolean>;
}

export interface PublisherCandidatePricingRequest {
  publisherAddress: string;
  explicitPublishEpochs?: number;
  defaultPublishEpochs: number;
  quote?: (epochs: number) => Promise<bigint>;
  conviction?: PublisherConvictionPlanReader;
}

export interface PublisherCandidatePricing {
  publishEpochs: number;
  tokenAmount: bigint;
  pcaAccountId?: bigint;
  pcaLockDurationEpochs?: number;
  pcaApplied: boolean;
  pcaProbeError?: unknown;
  quoteError?: unknown;
}

function protocolMinimum(epochs: number): bigint {
  return BigInt(epochs);
}

function clampQuote(quoted: bigint, epochs: number): bigint {
  const minimum = protocolMinimum(epochs);
  return quoted > minimum ? quoted : minimum;
}

/**
 * Canonical signer-specific lifetime and pricing policy shared by the EVM
 * adapter-owned planner and the legacy publisher compatibility path.
 *
 * A PCA lock is selected only when its exact lock-priced publish is confirmed
 * coverable. Probe/quote failures fail safely to direct-spend pricing.
 */
export async function resolvePublisherCandidatePricing(
  request: PublisherCandidatePricingRequest,
): Promise<PublisherCandidatePricing> {
  let publishEpochs = request.explicitPublishEpochs ?? request.defaultPublishEpochs;
  let tokenAmount: bigint | undefined;
  let pcaAccountId: bigint | undefined;
  let pcaLockDurationEpochs: number | undefined;
  let pcaApplied = false;
  let pcaProbeError: unknown;

  if (
    request.explicitPublishEpochs === undefined
    && request.conviction
    && request.quote
  ) {
    try {
      const accountId = await request.conviction.getAccountId(request.publisherAddress);
      if (accountId > 0n) {
        pcaAccountId = accountId;
        const lockEpochs = await request.conviction.getLockDurationEpochs(accountId);
        if (lockEpochs > 0) {
          pcaLockDurationEpochs = lockEpochs;
          const quoted = await request.quote(lockEpochs);
          const lockTokenAmount = clampQuote(quoted, lockEpochs);
          if (await request.conviction.canCover(accountId, lockTokenAmount)) {
            publishEpochs = lockEpochs;
            tokenAmount = lockTokenAmount;
            pcaApplied = true;
          }
        }
      }
    } catch (error) {
      pcaProbeError = error;
    }
  }

  let quoteError: unknown;
  if (tokenAmount === undefined) {
    if (request.quote) {
      try {
        tokenAmount = clampQuote(await request.quote(publishEpochs), publishEpochs);
      } catch (error) {
        quoteError = error;
      }
    }
    tokenAmount ??= protocolMinimum(publishEpochs);
  }

  return {
    publishEpochs,
    tokenAmount,
    pcaAccountId,
    pcaLockDurationEpochs,
    pcaApplied,
    pcaProbeError,
    quoteError,
  };
}
