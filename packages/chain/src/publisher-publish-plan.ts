/** Inputs for one adapter-owned, cost-aware publisher planning decision. */
export interface PublisherPublishPlanRequest {
  contextGraphId: bigint;
  /**
   * @deprecated Prefer billableByteSize in new code. Kept required so callers
   * and adapters compiled against the previous planning shape remain valid.
   */
  effectiveByteSize: bigint;
  /**
   * Exact byte quantity used for token quoting and fundability checks.
   * Publisher calls supply both names while the deprecated alias is supported.
   */
  billableByteSize?: bigint;
  /** Caller override. When omitted, a covering PCA may select its own lock. */
  explicitPublishEpochs?: number;
  /** Direct-spend lifetime used when no covering PCA-specific plan applies. */
  defaultPublishEpochs: number;
  /** Exact signer pin for an explicit publisher address/private key. */
  publisherAddress?: string;
}

/** Normalize the current and deprecated planning names to one exact quantity. */
export function publisherPublishPlanByteSize(
  request: PublisherPublishPlanRequest,
): bigint {
  if (
    request.billableByteSize !== undefined &&
    request.billableByteSize !== request.effectiveByteSize
  ) {
    throw new Error(
      'Publisher publish plan byte-size aliases must carry the same value: ' +
      `billableByteSize=${request.billableByteSize.toString()}, ` +
      `effectiveByteSize=${request.effectiveByteSize.toString()}`,
    );
  }
  return request.billableByteSize ?? request.effectiveByteSize;
}

/** Final signer-dependent values that must be fixed before publish side effects. */
export interface PublisherPublishPlan {
  publisherAddress: string;
  publishEpochs: number;
  tokenAmount: bigint;
}
