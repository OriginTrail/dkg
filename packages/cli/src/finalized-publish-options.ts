import { MAX_UINT72_DECIMAL, parseUint72Decimal } from '@origintrail-official/dkg-core';
import {
  formatPublicationPricingPolicyRequirement,
  parsePublicationPricingPolicy,
  type PublicationPricingPolicy,
} from '@origintrail-official/dkg-publisher';

export interface KnowledgeAssetFinalizedPublishOptions {
  clearAfter?: boolean;
  publishEpochs?: number;
  pricingPolicy?: PublicationPricingPolicy;
  publisherNodeIdentityIdOverride?: bigint;
}

export interface NormalizedFinalizedPublishOptions {
  clearSharedMemoryAfter?: boolean;
  publishEpochs?: number;
  pricingPolicy?: PublicationPricingPolicy;
  publisherNodeIdentityIdOverride?: bigint;
}

export type FinalizedPublishOptionParseError =
  | { kind: 'integer'; field: string; positive: boolean }
  | { kind: 'safe-integer'; field: string; positive: boolean }
  | { kind: 'number-too-large'; field: string }
  | { kind: 'max'; field: string; max: number }
  | { kind: 'uint72'; field: string }
  | { kind: 'boolean'; field: string }
  | { kind: 'pricing-policy'; field: string };

export type FinalizedPublishOptionParseResult<TOptions> =
  | { ok: true; options: TOptions }
  | { ok: false; error: FinalizedPublishOptionParseError };

const MAX_PUBLISH_EPOCHS = 0xffffffff;
export interface CliFinalizedPublishInput {
  publishEpochs?: unknown;
  pricingPolicy?: unknown;
  publisherNodeIdentityId?: unknown;
}

export function parseCliFinalizedPublishOptions(
  raw: CliFinalizedPublishInput,
): FinalizedPublishOptionParseResult<KnowledgeAssetFinalizedPublishOptions> {
  const epochs = parsePublishEpochs(raw.publishEpochs, 'publishEpochs');
  if (!epochs.ok) return epochs;
  const pricing = parseFinalizedPublishPricingPolicy(raw.pricingPolicy, 'pricingPolicy');
  if (!pricing.ok) return pricing;
  const identity = parsePublishUint72IdentityId(raw.publisherNodeIdentityId, 'publisherNodeIdentityIdOverride');
  if (!identity.ok) return identity;
  return { ok: true, options: {
    ...(epochs.value === undefined ? {} : { publishEpochs: epochs.value }),
    ...(pricing.value === undefined ? {} : { pricingPolicy: pricing.value }),
    ...(identity.value === undefined ? {} : { publisherNodeIdentityIdOverride: identity.value }),
  } };
}

export function parseHttpFinalizedPublishOptions(
  raw: unknown,
): FinalizedPublishOptionParseResult<NormalizedFinalizedPublishOptions> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, options: {} };
  const input = raw as Record<string, unknown>;
  // Validate both clear-memory aliases even when clearAfter takes precedence.
  const clear = parseClearSharedMemoryAfter(input.clearAfter, 'clearAfter');
  if (!clear.ok) return clear;
  const legacyClear = parseClearSharedMemoryAfter(input.clearSharedMemoryAfter, 'clearSharedMemoryAfter');
  if (!legacyClear.ok) return legacyClear;
  const epochs = parsePublishEpochs(input.publishEpochs ?? input.epochs,
    input.publishEpochs === undefined && input.epochs !== undefined ? 'epochs' : 'publishEpochs');
  if (!epochs.ok) return epochs;
  const pricing = parseFinalizedPublishPricingPolicy(input.pricingPolicy, 'pricingPolicy');
  if (!pricing.ok) return pricing;
  const identity = parsePublishUint72IdentityId(input.publisherNodeIdentityIdOverride, 'publisherNodeIdentityIdOverride');
  if (!identity.ok) return identity;
  const clearSharedMemoryAfter = clear.value ?? legacyClear.value;
  return { ok: true, options: {
    ...(clearSharedMemoryAfter === undefined ? {} : { clearSharedMemoryAfter }),
    ...(epochs.value === undefined ? {} : { publishEpochs: epochs.value }),
    ...(pricing.value === undefined ? {} : { pricingPolicy: pricing.value }),
    ...(identity.value === undefined ? {} : { publisherNodeIdentityIdOverride: identity.value }),
  } };
}

const SDK_FINALIZED_PUBLISH_OPTION_KEYS = new Set<string>([
  'clearAfter', 'publishEpochs', 'pricingPolicy', 'publisherNodeIdentityIdOverride',
] satisfies Array<keyof KnowledgeAssetFinalizedPublishOptions>);

function sdkOptionValue<T>(parsed: FinalizedPublishParsedOption<T>): T | undefined {
  if (!parsed.ok) throw new Error(formatFinalizedPublishOptionError(parsed.error));
  return parsed.value;
}

export function finalizedPublishOptionsPayload(
  options?: KnowledgeAssetFinalizedPublishOptions,
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const unsupportedKeys = Object.keys(options).filter((key) => !SDK_FINALIZED_PUBLISH_OPTION_KEYS.has(key));
  if (unsupportedKeys.length > 0) {
    throw new Error(`Unsupported finalized publish option(s): ${unsupportedKeys.join(', ')}`);
  }
  const clear = sdkOptionValue(parseClearSharedMemoryAfter(options.clearAfter, 'clearAfter'));
  const epochs = sdkOptionValue(parsePublishEpochs(options.publishEpochs, 'publishEpochs'));
  const pricing = sdkOptionValue(parseFinalizedPublishPricingPolicy(options.pricingPolicy, 'pricingPolicy'));
  const identity = sdkOptionValue(parsePublishUint72IdentityId(options.publisherNodeIdentityIdOverride, 'publisherNodeIdentityIdOverride'));
  const payload = {
    ...(clear === undefined ? {} : { clearSharedMemoryAfter: clear }),
    ...(epochs === undefined ? {} : { publishEpochs: epochs }),
    ...(pricing === undefined ? {} : { pricingPolicy: pricing }),
    ...(identity === undefined ? {} : { publisherNodeIdentityIdOverride: identity.toString() }),
  };
  return Object.keys(payload).length > 0 ? payload : undefined;
}

export function formatFinalizedPublishOptionError(
  error: FinalizedPublishOptionParseError,
  labels: Partial<Record<string, string>> = {},
  opts: { quoteField?: boolean } = {},
): string {
  const label = labels[error.field] ?? error.field;
  const field = opts.quoteField === false ? label : `"${label}"`;
  switch (error.kind) {
    case 'integer':
      return `${field} must be a ${error.positive ? 'positive ' : 'non-negative '}integer (string or number)`;
    case 'safe-integer':
      return `${field} must be a ${error.positive ? 'positive ' : 'non-negative '}safe integer (string or number)`;
    case 'number-too-large':
      return `${field} is too large to safely represent as a JavaScript integer`;
    case 'max':
      return `${field} must be less than or equal to ${error.max}`;
    case 'uint72':
      return `${field} must be between 0 and ${MAX_UINT72_DECIMAL} (uint72)`;
    case 'boolean':
      return `${field} must be a boolean when supplied`;
    case 'pricing-policy':
      return formatPublicationPricingPolicyRequirement(field);
  }
}

function parseFinalizedPublishPricingPolicy(
  value: unknown,
  field: string,
): { ok: true; value?: PublicationPricingPolicy } | { ok: false; error: FinalizedPublishOptionParseError } {
  const parsed = parsePublicationPricingPolicy(value);
  if (!parsed.ok) return { ok: false, error: { kind: 'pricing-policy', field } };
  return parsed;
}

function publishIntegerString(
  value: unknown,
  field: string,
  positive: boolean,
): { ok: true; value: string } | { ok: false; error: FinalizedPublishOptionParseError } {
  if (typeof value === 'bigint') {
    if (positive ? value <= 0n : value < 0n) {
      return { ok: false, error: { kind: 'integer', field, positive } };
    }
    return { ok: true, value: value.toString() };
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return { ok: false, error: { kind: 'integer', field, positive } };
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0))) {
    return { ok: false, error: { kind: 'safe-integer', field, positive } };
  }
  const v = typeof value === 'string' ? value.trim() : String(value);
  const pattern = positive ? /^[1-9]\d*$/ : /^\d+$/;
  if (!pattern.test(v)) {
    return { ok: false, error: { kind: 'integer', field, positive } };
  }
  return { ok: true, value: v };
}

type FinalizedPublishParsedOption<T> =
  | { ok: true; value?: T }
  | { ok: false; error: FinalizedPublishOptionParseError };

function okValue<T>(value: T | undefined): FinalizedPublishParsedOption<T> {
  return { ok: true, value };
}

function parseClearSharedMemoryAfter(
  value: unknown,
  field: string,
): FinalizedPublishParsedOption<boolean> {
  if (value === undefined) return okValue(undefined);
  if (typeof value !== 'boolean') {
    return { ok: false, error: { kind: 'boolean', field } };
  }
  return okValue(value);
}

function parsePublishEpochs(
  value: unknown,
  field: string,
): FinalizedPublishParsedOption<number> {
  if (value === undefined || value === null) return okValue(undefined);
  const v = publishIntegerString(value, field, true);
  if (!v.ok) return v;
  const n = Number(v.value);
  if (!Number.isSafeInteger(n)) {
    return { ok: false, error: { kind: 'number-too-large', field } };
  }
  if (n > MAX_PUBLISH_EPOCHS) {
    return { ok: false, error: { kind: 'max', field, max: MAX_PUBLISH_EPOCHS } };
  }
  return okValue(n);
}

function parsePublishUint72IdentityId(
  value: unknown,
  field: string,
): FinalizedPublishParsedOption<bigint> {
  if (value === undefined || value === null) return okValue(undefined);
  const v = publishIntegerString(value, field, false);
  if (!v.ok) return v;
  const parsed = parseUint72Decimal(v.value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { kind: parsed.reason === 'range' ? 'uint72' : 'integer', field, positive: false },
    };
  }
  return okValue(parsed.value);
}
