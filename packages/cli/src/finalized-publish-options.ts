import { MAX_UINT72_DECIMAL, parseUint72Decimal } from '@origintrail-official/dkg-core';
import {
  PUBLICATION_PRICING_POLICIES,
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
type PublishBoundary = 'cli' | 'http' | 'sdk';
interface ParsedPublishOptions {
  sdk: KnowledgeAssetFinalizedPublishOptions;
  normalized: NormalizedFinalizedPublishOptions;
  payload: Record<string, unknown>;
}

/** Capture each option's value type before collecting heterogeneous definitions. */
function definePublishOption<
  SdkKey extends keyof KnowledgeAssetFinalizedPublishOptions,
  OutputKey extends keyof NormalizedFinalizedPublishOptions,
>(definition: {
  sdkKey: SdkKey;
  outputKey: OutputKey;
  parse: (value: unknown, field: string) => FinalizedPublishParsedOption<
    KnowledgeAssetFinalizedPublishOptions[SdkKey] & NormalizedFinalizedPublishOptions[OutputKey]
  >;
  http?: { aliases: readonly string[]; nullishFallback?: boolean; validateAllAliases?: boolean };
  cli?: { inputKey: string; flags: string; description: string };
}) {
  return {
    sdkKey: definition.sdkKey,
    cli: definition.cli,
    parseInto(
      source: Record<string, unknown>,
      boundary: PublishBoundary,
      target: ParsedPublishOptions,
    ): FinalizedPublishOptionParseError | undefined {
      if (boundary === 'cli' && !definition.cli) return;
      const keys = boundary === 'http'
        ? [definition.sdkKey, ...(definition.http?.aliases ?? [])]
        : [boundary === 'cli' ? definition.cli!.inputKey : definition.sdkKey];
      // HTTP clear-memory aliases are both validated, even when the preferred
      // alias wins. Epochs use nullish fallback but keep the first defined label.
      if (boundary === 'http' && definition.http?.validateAllAliases) {
        for (const key of keys) {
          const checked = definition.parse(source[key], key);
          if (!checked.ok) return checked.error;
        }
      }
      const valueKey = keys.find((key) => boundary === 'http' && definition.http?.nullishFallback
        ? source[key] != null
        : source[key] !== undefined);
      const field = boundary === 'http'
        ? keys.find((key) => source[key] !== undefined) ?? definition.sdkKey
        : definition.sdkKey;
      const parsed = definition.parse(valueKey === undefined ? undefined : source[valueKey], field);
      if (!parsed.ok) return parsed.error;
      if (parsed.value !== undefined) {
        target.sdk[definition.sdkKey] = parsed.value;
        target.normalized[definition.outputKey] = parsed.value;
        target.payload[definition.outputKey] = typeof parsed.value === 'bigint'
          ? parsed.value.toString()
          : parsed.value;
      }
    },
  };
}

const FINALIZED_PUBLISH_OPTIONS = [
  definePublishOption({
    sdkKey: 'clearAfter', outputKey: 'clearSharedMemoryAfter', parse: parseClearSharedMemoryAfter,
    http: { aliases: ['clearSharedMemoryAfter'], validateAllAliases: true },
  }),
  definePublishOption({
    sdkKey: 'publishEpochs', outputKey: 'publishEpochs', parse: parsePublishEpochs,
    http: { aliases: ['epochs'], nullishFallback: true },
    cli: {
      inputKey: 'publishEpochs', flags: '--publish-epochs <count>',
      description: 'On-chain publish lifetime in epochs (default: 12; PCA-funded publishes may coerce to PCA lock duration)',
    },
  }),
  definePublishOption({
    sdkKey: 'pricingPolicy', outputKey: 'pricingPolicy', parse: parseFinalizedPublishPricingPolicy,
    cli: {
      inputKey: 'pricingPolicy', flags: '--pricing-policy <policy>',
      description: `Token pricing basis (supported: ${PUBLICATION_PRICING_POLICIES.join(', ')})`,
    },
  }),
  definePublishOption({
    sdkKey: 'publisherNodeIdentityIdOverride', outputKey: 'publisherNodeIdentityIdOverride',
    parse: parsePublishUint72IdentityId,
    cli: {
      inputKey: 'publisherNodeIdentityId', flags: '--publisher-node-identity-id <id>',
      description: 'Publisher node identity id override; use 0 for no-attribution',
    },
  }),
];

export const FINALIZED_PUBLISH_CLI_OPTIONS = FINALIZED_PUBLISH_OPTIONS.flatMap((option) =>
  option.cli ? [{ ...option.cli, errorField: option.sdkKey }] : [],
);
const SDK_FINALIZED_PUBLISH_OPTION_KEYS = new Set<string>(
  FINALIZED_PUBLISH_OPTIONS.map((option) => option.sdkKey),
);

function normalizeFinalizedPublishOptions(
  source: Record<string, unknown>,
  boundary: PublishBoundary,
): FinalizedPublishOptionParseResult<ParsedPublishOptions> {
  const options: ParsedPublishOptions = { sdk: {}, normalized: {}, payload: {} };
  for (const definition of FINALIZED_PUBLISH_OPTIONS) {
    const error = definition.parseInto(source, boundary, options);
    if (error) return { ok: false, error };
  }
  return { ok: true, options };
}

export function parseCliFinalizedPublishOptions(
  raw: Record<string, unknown>,
): FinalizedPublishOptionParseResult<KnowledgeAssetFinalizedPublishOptions> {
  const parsed = normalizeFinalizedPublishOptions(raw, 'cli');
  return parsed.ok ? { ok: true, options: parsed.options.sdk } : parsed;
}

export function parseHttpFinalizedPublishOptions(
  raw: unknown,
): FinalizedPublishOptionParseResult<NormalizedFinalizedPublishOptions> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, options: {} };
  const parsed = normalizeFinalizedPublishOptions(raw as Record<string, unknown>, 'http');
  return parsed.ok ? { ok: true, options: parsed.options.normalized } : parsed;
}

export function finalizedPublishOptionsPayload(
  options?: KnowledgeAssetFinalizedPublishOptions,
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const unsupportedKeys = Object.keys(options).filter(
    (key) => !SDK_FINALIZED_PUBLISH_OPTION_KEYS.has(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new Error(`Unsupported finalized publish option(s): ${unsupportedKeys.join(', ')}`);
  }
  const parsed = normalizeFinalizedPublishOptions(options as Record<string, unknown>, 'sdk');
  if (!parsed.ok) throw new Error(formatFinalizedPublishOptionError(parsed.error));
  const { payload } = parsed.options;
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
