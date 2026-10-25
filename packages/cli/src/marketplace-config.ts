// OT-RFC-27 marketplace config boundary: the JSON shape operators write in
// `config.json` (wei amounts as decimal strings — JSON numbers round above
// 2^53) and its mapping into `DKGAgentConfig.marketplace` (bigint wei). The
// daemon lifecycle calls `resolveMarketplaceAgentConfig` once at boot; the
// offerings route reuses `parseMarketplaceOffering` so config-file and
// API-set offerings parse under exactly one rule.

import type {
  DKGAgentMarketplaceConfig,
  MarketplaceOfferingConfig,
} from '@origintrail-official/dkg-agent';
import { resolveBooleanEnvOverride } from './boolean-env-override.js';

export const MARKETPLACE_ENABLED_ENV = 'DKG_MARKETPLACE_ENABLED';

export const MARKETPLACE_SERVICE_TYPES = ['inference', 'query', 'reasoning', 'graph-ml'] as const;
const MARKETPLACE_UNITS = ['token', 'query-unit'] as const;
const MARKETPLACE_EXECUTORS = ['stub-inference', 'local-query'] as const;

type MarketplaceServiceTypeName = (typeof MARKETPLACE_SERVICE_TYPES)[number];
type MarketplaceUnitName = (typeof MARKETPLACE_UNITS)[number];

/** One seller offering as written in `config.json` (wei fields are strings). */
interface DkgMarketplaceOfferingConfig {
  offeringLocalId: string;
  serviceType: MarketplaceServiceTypeName;
  modelId?: string;
  unit: MarketplaceUnitName;
  /** Wei per unit — decimal integer string (or a safe-integer number). */
  askPerUnitWei: string | number;
  capacityUnitsPerMin?: string | number;
  /** Unix seconds after which the published offer is stale. */
  expiresAt?: number;
  executor?: 'stub-inference' | 'local-query';
}

/**
 * The optional `marketplace` block of `config.json`. `enabled` is overridden
 * by the `DKG_MARKETPLACE_ENABLED` environment variable (1/0/true/false, same
 * rule as every other env-overrides-config flag). Serving still requires
 * configured offerings, so `enabled: true` alone is inert on the seller side.
 */
export interface DkgMarketplaceConfig {
  enabled?: boolean;
  seller?: {
    offerings?: DkgMarketplaceOfferingConfig[];
    /** Receipt-batch flush timer cadence (ms). Default 5000. */
    flushIntervalMs?: number;
    batching?: {
      maxBatchSize?: number;
      maxDelayMs?: number;
      /** Wei — decimal integer string (or a safe-integer number). */
      maxBuyerExposureWei?: string | number;
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

/**
 * Parse a non-negative integer wei/unit/epoch value into bigint. Strings must
 * be plain decimal integers; numbers must be non-negative safe integers (a
 * JSON number above 2^53 is already rounded by the parser, so it is rejected
 * rather than silently read as a different amount — same rule as the PCA
 * route's `primaryNode`). Throws naming `field` so a config typo fails boot
 * and a bad request body maps to a 400 with the offending key.
 */
export function parseMarketplaceUint(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer (pass values above 2^53 as a decimal string)`);
    }
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new Error(`${field} must be a non-negative decimal integer string`);
  }
  return BigInt(value.trim());
}

function parseOptionalMarketplaceUint(value: unknown, field: string): bigint | undefined {
  return value === undefined ? undefined : parseMarketplaceUint(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/**
 * Parse one JSON offering (config file or the seller/offerings route body)
 * into the agent's bigint-typed `MarketplaceOfferingConfig`. Throws with the
 * offending key path on any malformed field.
 */
export function parseMarketplaceOffering(raw: unknown, field: string): MarketplaceOfferingConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${field} must be an offering object`);
  }
  const offering = raw as Record<string, unknown>;
  const capacity = parseOptionalMarketplaceUint(offering.capacityUnitsPerMin, `${field}.capacityUnitsPerMin`);
  if (offering.expiresAt !== undefined
    && (typeof offering.expiresAt !== 'number' || !Number.isSafeInteger(offering.expiresAt) || offering.expiresAt <= 0)) {
    throw new Error(`${field}.expiresAt must be a positive integer (unix seconds)`);
  }
  return {
    offeringLocalId: requireString(offering.offeringLocalId, `${field}.offeringLocalId`),
    serviceType: requireOneOf(offering.serviceType, MARKETPLACE_SERVICE_TYPES, `${field}.serviceType`),
    ...(offering.modelId !== undefined ? { modelId: requireString(offering.modelId, `${field}.modelId`) } : {}),
    unit: requireOneOf(offering.unit, MARKETPLACE_UNITS, `${field}.unit`),
    askPerUnitWei: parseMarketplaceUint(offering.askPerUnitWei, `${field}.askPerUnitWei`),
    ...(capacity !== undefined ? { capacityUnitsPerMin: capacity } : {}),
    ...(offering.expiresAt !== undefined ? { expiresAt: offering.expiresAt } : {}),
    ...(offering.executor !== undefined
      ? { executor: requireOneOf(offering.executor, MARKETPLACE_EXECUTORS, `${field}.executor`) }
      : {}),
  };
}

function requireOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Resolve the operator `marketplace` block (plus the `DKG_MARKETPLACE_ENABLED`
 * override) into `DKGAgentConfig.marketplace`. Returns `undefined` — runtime
 * stays off — when nothing enables it and no block exists; a present-but-
 * disabled block is still parsed so a typo fails startup instead of surfacing
 * on the first enable. Throws on any malformed field, naming the config key.
 */
export function resolveMarketplaceAgentConfig(
  configValue: DkgMarketplaceConfig | undefined,
  envValue: string | undefined = process.env[MARKETPLACE_ENABLED_ENV],
): DKGAgentMarketplaceConfig | undefined {
  const enabled = resolveBooleanEnvOverride({
    envName: MARKETPLACE_ENABLED_ENV,
    configName: 'marketplace.enabled',
    envValue,
    configValue: configValue?.enabled,
    defaultValue: false,
  });
  if (configValue === undefined) {
    return enabled ? { enabled } : undefined;
  }
  if (typeof configValue !== 'object' || Array.isArray(configValue)) {
    throw new Error('marketplace must be an object');
  }
  const resolved: DKGAgentMarketplaceConfig = { enabled };
  const { seller, buyer } = configValue;
  if (seller !== undefined) {
    if (!seller || typeof seller !== 'object' || Array.isArray(seller)) {
      throw new Error('marketplace.seller must be an object');
    }
    if (seller.offerings !== undefined && !Array.isArray(seller.offerings)) {
      throw new Error('marketplace.seller.offerings must be an array');
    }
    const batchingExposure = parseOptionalMarketplaceUint(
      seller.batching?.maxBuyerExposureWei,
      'marketplace.seller.batching.maxBuyerExposureWei',
    );
    resolved.seller = {
      ...(seller.offerings !== undefined
        ? {
            offerings: seller.offerings.map((offering, index) =>
              parseMarketplaceOffering(offering, `marketplace.seller.offerings[${index}]`)),
          }
        : {}),
      ...(requireOptionalNumber(seller.flushIntervalMs, 'marketplace.seller.flushIntervalMs') !== undefined
        ? { flushIntervalMs: seller.flushIntervalMs }
        : {}),
      ...(seller.batching !== undefined
        ? {
            batching: {
              ...(requireOptionalNumber(seller.batching.maxBatchSize, 'marketplace.seller.batching.maxBatchSize') !== undefined
                ? { maxBatchSize: seller.batching.maxBatchSize }
                : {}),
              ...(requireOptionalNumber(seller.batching.maxDelayMs, 'marketplace.seller.batching.maxDelayMs') !== undefined
                ? { maxDelayMs: seller.batching.maxDelayMs }
                : {}),
              ...(batchingExposure !== undefined ? { maxBuyerExposureWei: batchingExposure } : {}),
            },
          }
        : {}),
    };
  }
  if (buyer !== undefined) {
    if (!buyer || typeof buyer !== 'object' || Array.isArray(buyer)) {
      throw new Error('marketplace.buyer must be an object');
    }
    resolved.buyer = {
      ...(requireOptionalNumber(buyer.authTtlSeconds, 'marketplace.buyer.authTtlSeconds') !== undefined
        ? { authTtlSeconds: buyer.authTtlSeconds }
        : {}),
      ...(requireOptionalNumber(buyer.quoteTimeoutMs, 'marketplace.buyer.quoteTimeoutMs') !== undefined
        ? { quoteTimeoutMs: buyer.quoteTimeoutMs }
        : {}),
      ...(requireOptionalNumber(buyer.serveTimeoutMs, 'marketplace.buyer.serveTimeoutMs') !== undefined
        ? { serveTimeoutMs: buyer.serveTimeoutMs }
        : {}),
      ...(requireOptionalNumber(buyer.maxQuoteProbes, 'marketplace.buyer.maxQuoteProbes') !== undefined
        ? { maxQuoteProbes: buyer.maxQuoteProbes }
        : {}),
    };
  }
  return resolved;
}
