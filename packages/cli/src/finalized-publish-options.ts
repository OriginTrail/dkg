import { MAX_UINT72_DECIMAL, parseUint72Decimal } from './protocol-limits.js';

export interface KnowledgeAssetFinalizedPublishOptions {
  clearAfter?: boolean;
  publishEpochs?: number;
  publisherNodeIdentityIdOverride?: bigint;
}

export interface NormalizedFinalizedPublishOptions {
  clearSharedMemoryAfter?: boolean;
  publishEpochs?: number;
  publisherNodeIdentityIdOverride?: bigint;
}

export type FinalizedPublishOptionParseError =
  | { kind: 'integer'; field: string; positive: boolean }
  | { kind: 'safe-integer'; field: string; positive: boolean }
  | { kind: 'number-too-large'; field: string }
  | { kind: 'max'; field: string; max: number }
  | { kind: 'uint72'; field: string }
  | { kind: 'boolean'; field: string };

export type FinalizedPublishOptionParseResult =
  | { ok: true; options: NormalizedFinalizedPublishOptions }
  | { ok: false; error: FinalizedPublishOptionParseError };

const SDK_FINALIZED_PUBLISH_OPTION_KEYS = new Set([
  'clearAfter',
  'publishEpochs',
  'publisherNodeIdentityIdOverride',
]);

const MAX_PUBLISH_EPOCHS = 0xffffffff;

export function parseCliFinalizedPublishOptions(raw: {
  publishEpochs?: unknown;
  publisherNodeIdentityId?: unknown;
}): FinalizedPublishOptionParseResult {
  return parseFinalizedPublishDomainOptions({
    publishEpochs: parsePublishEpochs(raw.publishEpochs, 'publishEpochs'),
    publisherNodeIdentityIdOverride: parsePublishUint72IdentityId(
      raw.publisherNodeIdentityId,
      'publisherNodeIdentityIdOverride',
    ),
  });
}

export function parseHttpFinalizedPublishOptions(raw: unknown): FinalizedPublishOptionParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, options: {} };
  const source = raw as Record<string, unknown>;
  const hasClearAfter = source.clearAfter !== undefined;
  const hasPublishEpochs = source.publishEpochs !== undefined;
  const clearAfter = parseClearSharedMemoryAfter(source.clearAfter, 'clearAfter');
  const clearSharedMemoryAfter = parseClearSharedMemoryAfter(
    source.clearSharedMemoryAfter,
    'clearSharedMemoryAfter',
  );
  if (!clearAfter.ok) return clearAfter;
  if (!clearSharedMemoryAfter.ok) return clearSharedMemoryAfter;

  return parseFinalizedPublishDomainOptions({
    clearSharedMemoryAfter: hasClearAfter ? clearAfter : clearSharedMemoryAfter,
    publishEpochs: parsePublishEpochs(
      source.publishEpochs ?? source.epochs,
      hasPublishEpochs ? 'publishEpochs' : 'epochs',
    ),
    publisherNodeIdentityIdOverride: parsePublishUint72IdentityId(
      source.publisherNodeIdentityIdOverride,
      'publisherNodeIdentityIdOverride',
    ),
  });
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
  const normalized = parseSdkFinalizedPublishOptions(options);
  if (!normalized.ok) {
    throw new Error(formatFinalizedPublishOptionError(normalized.error));
  }
  return finalizedPublishDomainPayload(normalized.options);
}

function parseSdkFinalizedPublishOptions(
  options: KnowledgeAssetFinalizedPublishOptions,
): FinalizedPublishOptionParseResult {
  return parseFinalizedPublishDomainOptions({
    clearSharedMemoryAfter: parseClearSharedMemoryAfter(options.clearAfter, 'clearAfter'),
    publishEpochs: parsePublishEpochs(options.publishEpochs, 'publishEpochs'),
    publisherNodeIdentityIdOverride: parsePublishUint72IdentityId(
      options.publisherNodeIdentityIdOverride,
      'publisherNodeIdentityIdOverride',
    ),
  });
}

function finalizedPublishDomainPayload(
  options: NormalizedFinalizedPublishOptions,
): Record<string, unknown> | undefined {
  const payload: Record<string, unknown> = {};
  if (options.clearSharedMemoryAfter !== undefined) {
    payload.clearSharedMemoryAfter = options.clearSharedMemoryAfter;
  }
  if (options.publishEpochs !== undefined) {
    payload.publishEpochs = options.publishEpochs;
  }
  if (options.publisherNodeIdentityIdOverride !== undefined) {
    payload.publisherNodeIdentityIdOverride = options.publisherNodeIdentityIdOverride.toString();
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

function parseFinalizedPublishDomainOptions(input: {
  clearSharedMemoryAfter?: FinalizedPublishParsedOption<boolean>;
  publishEpochs?: FinalizedPublishParsedOption<number>;
  publisherNodeIdentityIdOverride?: FinalizedPublishParsedOption<bigint>;
}): FinalizedPublishOptionParseResult {
  const clearSharedMemoryAfter = input.clearSharedMemoryAfter ?? okValue(undefined);
  if (!clearSharedMemoryAfter.ok) return clearSharedMemoryAfter;
  const publishEpochs = input.publishEpochs ?? okValue(undefined);
  if (!publishEpochs.ok) return publishEpochs;
  const publisherNodeIdentityIdOverride = input.publisherNodeIdentityIdOverride ?? okValue(undefined);
  if (!publisherNodeIdentityIdOverride.ok) return publisherNodeIdentityIdOverride;

  return {
    ok: true,
    options: {
      ...(clearSharedMemoryAfter.value !== undefined ? { clearSharedMemoryAfter: clearSharedMemoryAfter.value } : {}),
      ...(publishEpochs.value !== undefined ? { publishEpochs: publishEpochs.value } : {}),
      ...(publisherNodeIdentityIdOverride.value !== undefined
        ? { publisherNodeIdentityIdOverride: publisherNodeIdentityIdOverride.value }
        : {}),
    },
  };
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
  }
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
  | { ok: true; value: T | undefined }
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
