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

const FINALIZED_PUBLISH_OPTION_KEYS = new Set([
  'clearAfter',
  'publishEpochs',
  'publisherNodeIdentityIdOverride',
]);

const MAX_PUBLISH_EPOCHS = 0xffffffff;

export function finalizedPublishOptionsPayload(
  options?: KnowledgeAssetFinalizedPublishOptions,
  allowedExtraKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const unsupportedKeys = Object.keys(options).filter(
    (key) => !FINALIZED_PUBLISH_OPTION_KEYS.has(key) && !allowedExtraKeys.includes(key),
  );
  if (unsupportedKeys.length > 0) {
    throw new Error(`Unsupported finalized publish option(s): ${unsupportedKeys.join(', ')}`);
  }
  const normalized = normalizeFinalizedPublishOptions(options);
  if (!normalized.ok) {
    throw new Error(formatFinalizedPublishOptionError(normalized.error));
  }
  const payload: Record<string, unknown> = {};
  if (normalized.options.clearSharedMemoryAfter !== undefined) {
    payload.clearSharedMemoryAfter = normalized.options.clearSharedMemoryAfter;
  }
  if (normalized.options.publishEpochs !== undefined) {
    payload.publishEpochs = normalized.options.publishEpochs;
  }
  if (normalized.options.publisherNodeIdentityIdOverride !== undefined) {
    payload.publisherNodeIdentityIdOverride = normalized.options.publisherNodeIdentityIdOverride.toString();
  }
  return Object.keys(payload).length > 0 ? payload : undefined;
}

export function normalizeFinalizedPublishOptions(raw: unknown): FinalizedPublishOptionParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, options: {} };
  const source = raw as Record<string, unknown>;
  const { clearAfter, clearSharedMemoryAfter, publisherNodeIdentityIdOverride } = source;
  const rawPublishEpochs = source.publishEpochs ?? source.epochs;
  const publishEpochsField = source.publishEpochs !== undefined ? 'publishEpochs' : 'epochs';

  let resolvedPublisherIdentityOverride: bigint | undefined;
  if (publisherNodeIdentityIdOverride !== undefined && publisherNodeIdentityIdOverride !== null) {
    const parsed = parsePublishUint72IdentityId(publisherNodeIdentityIdOverride, 'publisherNodeIdentityIdOverride');
    if (!parsed.ok) return parsed;
    resolvedPublisherIdentityOverride = parsed.value;
  }

  let resolvedPublishEpochs: number | undefined;
  if (rawPublishEpochs !== undefined && rawPublishEpochs !== null) {
    const v = publishIntegerString(rawPublishEpochs, publishEpochsField, true);
    if (!v.ok) return v;
    const n = Number(v.value);
    if (!Number.isSafeInteger(n)) {
      return { ok: false, error: { kind: 'number-too-large', field: publishEpochsField } };
    }
    if (n > MAX_PUBLISH_EPOCHS) {
      return { ok: false, error: { kind: 'max', field: publishEpochsField, max: MAX_PUBLISH_EPOCHS } };
    }
    resolvedPublishEpochs = n;
  }

  if (clearAfter !== undefined && typeof clearAfter !== 'boolean') {
    return { ok: false, error: { kind: 'boolean', field: 'clearAfter' } };
  }
  if (clearSharedMemoryAfter !== undefined && typeof clearSharedMemoryAfter !== 'boolean') {
    return { ok: false, error: { kind: 'boolean', field: 'clearSharedMemoryAfter' } };
  }

  const clearValue = clearAfter !== undefined ? clearAfter : clearSharedMemoryAfter;
  return {
    ok: true,
    options: {
      ...(clearValue !== undefined ? { clearSharedMemoryAfter: clearValue } : {}),
      ...(resolvedPublishEpochs !== undefined ? { publishEpochs: resolvedPublishEpochs } : {}),
      ...(resolvedPublisherIdentityOverride !== undefined
        ? { publisherNodeIdentityIdOverride: resolvedPublisherIdentityOverride }
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

function parsePublishUint72IdentityId(
  value: unknown,
  field: string,
): { ok: true; value: bigint } | { ok: false; error: FinalizedPublishOptionParseError } {
  const v = publishIntegerString(value, field, false);
  if (!v.ok) return v;
  const parsed = parseUint72Decimal(v.value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { kind: parsed.reason === 'range' ? 'uint72' : 'integer', field, positive: false },
    };
  }
  return { ok: true, value: parsed.value };
}
