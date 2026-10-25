/**
 * OT-RFC-27 marketplace configuration types for `DKGAgentConfig.marketplace`
 * (own module: `dkg-agent-types.ts` sits at its ratcheted file-size budget).
 */
import type { MarketplaceServiceType, MarketplaceUnit } from '@origintrail-official/dkg-marketplace';

/**
 * One seller offering (OT-RFC-27 marketplace). `askPerUnitWei` is wei per
 * unit as bigint (uint96 — the CLI config layer parses operator strings).
 * `executor` selects the serving implementation; omitted it defaults by
 * service type ('query' → 'local-query' against this node's SPARQL entry
 * point, everything else → the deterministic 'stub-inference' echo).
 */
export interface MarketplaceOfferingConfig {
  offeringLocalId: string;
  serviceType: MarketplaceServiceType;
  modelId?: string;
  unit: MarketplaceUnit;
  askPerUnitWei: bigint;
  capacityUnitsPerMin?: bigint;
  /** Unix seconds after which the published offer is stale. */
  expiresAt?: number;
  executor?: 'stub-inference' | 'local-query';
}

/**
 * OT-RFC-27 marketplace runtime switch + role configuration. The runtime is
 * wired at start only when `enabled` AND the chain adapter supports
 * marketplace settlement; configured offerings are served immediately but
 * published as offer KAs only through `marketplacePublishOfferings()` (the
 * daemon's offerings route calls it).
 */
export interface DKGAgentMarketplaceConfig {
  enabled: boolean;
  seller?: {
    offerings?: MarketplaceOfferingConfig[];
    /** Receipt-batch flush timer cadence (ms). Default 5000. */
    flushIntervalMs?: number;
    batching?: {
      maxBatchSize?: number;
      maxDelayMs?: number;
      maxBuyerExposureWei?: bigint;
    };
  };
  buyer?: {
    /** Authorization validity window (s). Default 600. */
    authTtlSeconds?: number;
    quoteTimeoutMs?: number;
    serveTimeoutMs?: number;
    /** Per-request cap on live quote probes. Default 8. */
    maxQuoteProbes?: number;
  };
}
