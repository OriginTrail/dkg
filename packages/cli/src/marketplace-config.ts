// OT-RFC-27 marketplace config boundary: the JSON shape operators write in
// `config.json` (wei amounts as decimal strings — JSON numbers round above
// 2^53) and its mapping into `DKGAgentConfig.marketplace` (bigint wei). The
// daemon lifecycle calls `resolveMarketplaceAgentConfig` once at boot; the
// offerings route reuses `parseMarketplaceOffering` so config-file and
// API-set offerings parse under exactly one rule. Chat-connector fields parse
// in `marketplace-connector-config.ts`; the daemon-only buyer gateway block
// resolves through `resolveMarketplaceGatewayConfig`.

import type {
  DKGAgentMarketplaceConfig,
  MarketplaceOfferingConfig,
} from '@origintrail-official/dkg-agent';
import { resolveBooleanEnvOverride } from './boolean-env-override.js';
import {
  parseMarketplaceOfferingExtensions,
  parseTokenizerFileRef,
} from './marketplace-connector-config.js';

export const MARKETPLACE_ENABLED_ENV = 'DKG_MARKETPLACE_ENABLED';
/** Overrides `marketplace.buyer.gateway.enabled` (same 1/0/true/false rule). */
export const MARKETPLACE_GATEWAY_ENABLED_ENV = 'DKG_MARKETPLACE_GATEWAY_ENABLED';

export const MARKETPLACE_SERVICE_TYPES = ['inference', 'query', 'reasoning', 'graph-ml'] as const;
const MARKETPLACE_UNITS = ['token', 'query-unit'] as const;
const MARKETPLACE_EXECUTORS = ['stub-inference', 'local-query', 'chat-connector'] as const;

/** Buyer gateway defaults (§9.2): `max_tokens` when the caller sends none, body cap, in-flight cap. */
export const MARKETPLACE_GATEWAY_DEFAULTS = {
  defaultMaxTokens: 256,
  maxBodyBytes: 4 * 1024 * 1024,
  maxConcurrent: 16,
} as const;
const GATEWAY_MAX_BODY_BYTES_LIMIT = 16 * 1024 * 1024;
const GATEWAY_MAX_CONCURRENT_LIMIT = 1024;
const CHAT_MAX_TOKENS_LIMIT = 1_000_000;

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
  executor?: 'stub-inference' | 'local-query' | 'chat-connector';
  /** Chat connector (see `marketplace-connector-config.ts`); secrets are file PATHS only. */
  connector?: Record<string, unknown>;
  metering?: { tokenizer?: { kind: string; path?: string } };
  /** EVM addresses; non-empty ⇒ the offer is published `restricted`. */
  allowedBuyers?: string[];
  /** `contextLength` as a decimal string. */
  model?: { displayName?: string; family?: string; contextLength?: string | number; quantization?: string };
}

/** `marketplace.buyer.gateway` — daemon-only (never passed to the agent). */
interface DkgMarketplaceGatewayConfig {
  /** Default true when the marketplace is enabled; `DKG_MARKETPLACE_GATEWAY_ENABLED` overrides. */
  enabled?: boolean;
  /** `max_tokens` used when a chat request names none. Default 256. */
  defaultMaxTokens?: number;
  /** Request body cap (bytes). Default 4 MiB. */
  maxBodyBytes?: number;
  /** In-flight gateway requests. Default 16. */
  maxConcurrent?: number;
}

/** The resolved gateway settings the daemon dispatch runs with. */
export interface ResolvedMarketplaceGatewayConfig {
  defaultMaxTokens: number;
  maxBodyBytes: number;
  maxConcurrent: number;
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
    /** `local-query` execution guards. Default { timeoutMs: 10000, maxRows: 10000 }. */
    queryGuards?: { timeoutMs?: number; maxRows?: number };
  };
  buyer?: {
    /** Authorization validity window (s). Default 600. */
    authTtlSeconds?: number;
    quoteTimeoutMs?: number;
    serveTimeoutMs?: number;
    /** Per-request cap on live quote probes. Default 8. */
    maxQuoteProbes?: number;
    /**
     * Chat serve timeout (ms). Default 200000 — above every default connector
     * timeout; a seller connector `timeoutMs` above ~190 s risks DELIVERY_UNKNOWN.
     */
    chatServeTimeoutMs?: number;
    /** Tokenizer files the buyer recounts pinned deliveries with (absolute paths). */
    tokenizers?: Array<{ kind: string; path: string }>;
    recountPolicy?: { window?: number; deprioritizeAt?: number; denyAt?: number; denyCooldownSeconds?: number };
    gateway?: DkgMarketplaceGatewayConfig;
  };
}

/**
 * Parse a non-negative integer wei/unit/epoch value into bigint. Strings must
 * be plain decimal integers; numbers must be non-negative safe integers (a
 * JSON number above 2^53 is already rounded by the parser, so it is rejected
 * rather than silently read as a different amount — same rule as the PCA
 * route's `primaryNode`). An optional `maxBits` width-bounds the value at the
 * boundary (uint96 for wei amounts/asks, uint64 for units/epochs, uint72 for
 * identity ids — the contract's own column widths, mirroring the domain
 * package's digest asserts). Throws naming `field` so a config typo fails
 * boot and a bad request body maps to a 400 with the offending key.
 */
export function parseMarketplaceUint(value: unknown, field: string, maxBits?: 64 | 72 | 96): bigint {
  let parsed: bigint;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer (pass values above 2^53 as a decimal string)`);
    }
    parsed = BigInt(value);
  } else {
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
      throw new Error(`${field} must be a non-negative decimal integer string`);
    }
    parsed = BigInt(value.trim());
  }
  if (maxBits !== undefined && parsed >= 1n << BigInt(maxBits)) {
    throw new Error(`${field} must fit in uint${maxBits}, got: ${parsed}`);
  }
  return parsed;
}

function parseOptionalMarketplaceUint(value: unknown, field: string, maxBits?: 64 | 72 | 96): bigint | undefined {
  return value === undefined ? undefined : parseMarketplaceUint(value, field, maxBits);
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
  const capacity = parseOptionalMarketplaceUint(offering.capacityUnitsPerMin, `${field}.capacityUnitsPerMin`, 64);
  if (offering.expiresAt !== undefined
    && (typeof offering.expiresAt !== 'number' || !Number.isSafeInteger(offering.expiresAt) || offering.expiresAt <= 0)) {
    throw new Error(`${field}.expiresAt must be a positive integer (unix seconds)`);
  }
  return {
    offeringLocalId: requireString(offering.offeringLocalId, `${field}.offeringLocalId`),
    serviceType: requireOneOf(offering.serviceType, MARKETPLACE_SERVICE_TYPES, `${field}.serviceType`),
    ...(offering.modelId !== undefined ? { modelId: requireString(offering.modelId, `${field}.modelId`) } : {}),
    unit: requireOneOf(offering.unit, MARKETPLACE_UNITS, `${field}.unit`),
    askPerUnitWei: parseMarketplaceUint(offering.askPerUnitWei, `${field}.askPerUnitWei`, 96),
    ...(capacity !== undefined ? { capacityUnitsPerMin: capacity } : {}),
    ...(offering.expiresAt !== undefined ? { expiresAt: offering.expiresAt } : {}),
    ...(offering.executor !== undefined
      ? { executor: requireOneOf(offering.executor, MARKETPLACE_EXECUTORS, `${field}.executor`) }
      : {}),
    ...parseMarketplaceOfferingExtensions(offering, field),
  };
}

function requireOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireOptionalIntInRange(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer ${min}..${max}`);
  }
  return value;
}

function requireOptionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

/** `{ timeoutMs?, maxRows? }` — positive guards the seller's `local-query` executor enforces. */
function parseQueryGuards(raw: unknown, field: string): { timeoutMs?: number; maxRows?: number } | undefined {
  const guards = requireOptionalObject(raw, field);
  if (guards === undefined) return undefined;
  const timeoutMs = requireOptionalIntInRange(guards.timeoutMs, `${field}.timeoutMs`, 1, 600_000);
  const maxRows = requireOptionalIntInRange(guards.maxRows, `${field}.maxRows`, 1, 10_000_000);
  return { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(maxRows !== undefined ? { maxRows } : {}) };
}

type AgentBuyerConfig = NonNullable<DKGAgentMarketplaceConfig['buyer']>;

/** Buyer recount engines: file kinds only (stub-words-v1 is built in), absolute paths. */
function parseBuyerTokenizers(raw: unknown, field: string): AgentBuyerConfig['tokenizers'] {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 32) throw new Error(`${field} must be an array of at most 32 { kind, path } entries`);
  return raw.map((entry, index) => {
    const ref = parseTokenizerFileRef(entry, `${field}[${index}]`);
    if (ref.path === undefined) throw new Error(`${field}[${index}]: stub-words-v1 is built in and needs no entry`);
    return { kind: ref.kind, path: ref.path };
  });
}

/** Mirrors the standing book's rule: window/deprioritizeAt/denyAt ≥ 1, cooldown ≥ 0. */
function parseRecountPolicy(raw: unknown, field: string): AgentBuyerConfig['recountPolicy'] {
  const policy = requireOptionalObject(raw, field);
  if (policy === undefined) return undefined;
  const out: NonNullable<AgentBuyerConfig['recountPolicy']> = {};
  for (const key of ['window', 'deprioritizeAt', 'denyAt'] as const) {
    const value = requireOptionalIntInRange(policy[key], `${field}.${key}`, 1, 1_000_000);
    if (value !== undefined) out[key] = value;
  }
  const cooldown = requireOptionalIntInRange(policy.denyCooldownSeconds, `${field}.denyCooldownSeconds`, 0, 10 * 365 * 86_400);
  if (cooldown !== undefined) out.denyCooldownSeconds = cooldown;
  return out;
}

/** Structural parse of `marketplace.buyer.gateway` (validated at boot even when disabled). */
function parseGatewayBlock(raw: unknown): ResolvedMarketplaceGatewayConfig & { enabled: unknown } {
  const field = 'marketplace.buyer.gateway';
  const gateway = requireOptionalObject(raw, field) ?? {};
  if (gateway.enabled !== undefined && typeof gateway.enabled !== 'boolean') {
    throw new Error(`${field}.enabled must be a boolean`);
  }
  return {
    enabled: gateway.enabled,
    defaultMaxTokens: requireOptionalIntInRange(gateway.defaultMaxTokens, `${field}.defaultMaxTokens`, 1, CHAT_MAX_TOKENS_LIMIT)
      ?? MARKETPLACE_GATEWAY_DEFAULTS.defaultMaxTokens,
    maxBodyBytes: requireOptionalIntInRange(gateway.maxBodyBytes, `${field}.maxBodyBytes`, 1024, GATEWAY_MAX_BODY_BYTES_LIMIT)
      ?? MARKETPLACE_GATEWAY_DEFAULTS.maxBodyBytes,
    maxConcurrent: requireOptionalIntInRange(gateway.maxConcurrent, `${field}.maxConcurrent`, 1, GATEWAY_MAX_CONCURRENT_LIMIT)
      ?? MARKETPLACE_GATEWAY_DEFAULTS.maxConcurrent,
  };
}

/**
 * The daemon-only buyer gateway (`/api/marketplace/gateway/v1`). `undefined`
 * ⇔ disabled: the marketplace is off (`marketplace.enabled` /
 * `DKG_MARKETPLACE_ENABLED`), or `marketplace.buyer.gateway.enabled === false`
 * / `DKG_MARKETPLACE_GATEWAY_ENABLED=0`. On by default with the marketplace;
 * inert without keys (every call is 401 until a node admin mints one).
 */
export function resolveMarketplaceGatewayConfig(
  configValue: DkgMarketplaceConfig | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedMarketplaceGatewayConfig | undefined {
  const marketplaceEnabled = resolveBooleanEnvOverride({
    envName: MARKETPLACE_ENABLED_ENV,
    configName: 'marketplace.enabled',
    envValue: env[MARKETPLACE_ENABLED_ENV],
    configValue: configValue?.enabled,
    defaultValue: false,
  });
  const buyer = configValue?.buyer;
  if (buyer !== undefined && (!buyer || typeof buyer !== 'object' || Array.isArray(buyer))) {
    throw new Error('marketplace.buyer must be an object');
  }
  const { enabled: gatewayEnabledConfig, ...resolved } = parseGatewayBlock(buyer?.gateway);
  const gatewayEnabled = resolveBooleanEnvOverride({
    envName: MARKETPLACE_GATEWAY_ENABLED_ENV,
    configName: 'marketplace.buyer.gateway.enabled',
    envValue: env[MARKETPLACE_GATEWAY_ENABLED_ENV],
    configValue: gatewayEnabledConfig,
    defaultValue: true,
  });
  return marketplaceEnabled && gatewayEnabled ? resolved : undefined;
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
    const queryGuards = parseQueryGuards(seller.queryGuards, 'marketplace.seller.queryGuards');
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
      ...(queryGuards !== undefined ? { queryGuards } : {}),
    };
  }
  if (buyer !== undefined) {
    if (!buyer || typeof buyer !== 'object' || Array.isArray(buyer)) {
      throw new Error('marketplace.buyer must be an object');
    }
    const chatServeTimeoutMs = requireOptionalIntInRange(
      buyer.chatServeTimeoutMs, 'marketplace.buyer.chatServeTimeoutMs', 1_000, 900_000,
    );
    const tokenizers = parseBuyerTokenizers(buyer.tokenizers, 'marketplace.buyer.tokenizers');
    const recountPolicy = parseRecountPolicy(buyer.recountPolicy, 'marketplace.buyer.recountPolicy');
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
      ...(chatServeTimeoutMs !== undefined ? { chatServeTimeoutMs } : {}),
      ...(tokenizers !== undefined ? { tokenizers } : {}),
      ...(recountPolicy !== undefined ? { recountPolicy } : {}),
    };
    // Daemon-only: validated here so a typo fails boot; resolved by resolveMarketplaceGatewayConfig.
    parseGatewayBlock(buyer.gateway);
  }
  return resolved;
}
