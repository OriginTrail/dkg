// OT-RFC-27 seller chat-connector config: the STRUCTURAL parse of the JSON an
// operator writes for a `chat-connector` offering (config file or the
// node-admin offerings route) into the agent's typed shapes. Structure only —
// types, absolute paths, URL syntax, enum values and the literal
// `acknowledgeSubscriptionScope: true`; the agent validates semantics at
// mount (loopback-only llama.cpp, tokenizer/connector pairing, secret file
// presence and mode, codex scope) and reports them as
// `MarketplaceConnectorMountError` codes.
//
// Secrets never pass through here: a connector names a FILE (`secretEnvFile`,
// `authFile`) and the agent reads it at call time. Unknown connector keys are
// rejected by name (never echoing their value), so a credential pasted into
// config.json by mistake fails loudly instead of being silently kept.

import { isAbsolute } from 'node:path';
import { ethers } from 'ethers';
import type {
  MarketplaceConnectorConfig,
  MarketplaceOfferingConfig,
} from '@origintrail-official/dkg-agent';
import { TOKENIZER_KINDS } from '@origintrail-official/dkg-agent/dist/marketplace/gateway-domain.js';

type TokenizerKindName = (typeof TOKENIZER_KINDS)[number];

const CONNECTOR_KINDS = ['openai-compatible', 'llamacpp', 'codex-oauth'] as const;
const TOOL_TRANSPORTS = ['native', 'prompt', 'none'] as const;
const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens'] as const;
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DECIMAL_TEMPERATURE = /^(0|[1-9]\d?)(\.\d{1,6})?$/;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_ALLOWED_BUYERS = 256;
const MAX_LABEL_CHARS = 128;
const MAX_UPSTREAM_MODEL_CHARS = 256;
/** uint64: the published `mkt:contextLength` column width. */
const UINT64_LIMIT = 1n << 64n;

const ALLOWED_KEYS: Record<(typeof CONNECTOR_KINDS)[number], readonly string[]> = {
  'openai-compatible': [
    'kind', 'baseUrl', 'upstreamModel', 'secretEnvFile', 'secretEnvKey',
    'toolTransport', 'maxTokensField', 'contextLength', 'timeoutMs',
  ],
  llamacpp: ['kind', 'baseUrl', 'ggufPath', 'settings', 'timeoutMs'],
  'codex-oauth': [
    'kind', 'upstreamModel', 'authFile', 'baseUrl', 'reasoningEffort',
    'acknowledgeSubscriptionScope', 'timeoutMs',
  ],
};

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function boundedString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxChars) {
    throw new Error(`${field} must be a non-empty string of at most ${maxChars} characters`);
  }
  return value;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${field} must be an absolute file path`);
  }
  return value;
}

/**
 * URL syntax shared by every connector: http(s) only, no userinfo, no query,
 * no fragment. The connector applies its own stricter rule at mount
 * (loopback-only for llama.cpp, https-or-loopback for codex). The value is
 * kept verbatim: the agent normalizes the trailing slash.
 */
function upstreamUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error(`${field} must be a non-empty URL string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${field} must be an http or https URL`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} must not carry credentials, a query or a fragment`);
  }
  return value;
}

function timeoutMs(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`${field} must be an integer ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}`);
  }
  return value;
}

/** A positive uint64 written as a decimal string (or a safe-integer number). */
export function parsePositiveUint64(value: unknown, field: string): bigint {
  let parsed: bigint;
  if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim());
  else throw new Error(`${field} must be a positive decimal integer string`);
  if (parsed <= 0n || parsed >= UINT64_LIMIT) throw new Error(`${field} must be a positive integer below 2^64`);
  return parsed;
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      throw new Error(`${field}.${key} is not a recognised connector field (credentials belong in a secret file, never in config)`);
    }
  }
}

/** Parse one `connector` object into the agent's `MarketplaceConnectorConfig`. */
export function parseMarketplaceConnector(raw: unknown, field: string): MarketplaceConnectorConfig {
  const connector = asObject(raw, field);
  const kind = oneOf(connector.kind, CONNECTOR_KINDS, `${field}.kind`);
  rejectUnknownKeys(connector, ALLOWED_KEYS[kind], field);
  const timeout = timeoutMs(connector.timeoutMs, `${field}.timeoutMs`);
  if (kind === 'openai-compatible') {
    const secretEnvKey = connector.secretEnvKey;
    if (secretEnvKey !== undefined && (typeof secretEnvKey !== 'string' || !ENV_KEY_PATTERN.test(secretEnvKey))) {
      throw new Error(`${field}.secretEnvKey must be an environment-variable name ([A-Za-z_][A-Za-z0-9_]*)`);
    }
    if (secretEnvKey !== undefined && connector.secretEnvFile === undefined) {
      throw new Error(`${field}.secretEnvKey needs ${field}.secretEnvFile`);
    }
    return {
      kind,
      baseUrl: upstreamUrl(connector.baseUrl, `${field}.baseUrl`),
      upstreamModel: boundedString(connector.upstreamModel, `${field}.upstreamModel`, MAX_UPSTREAM_MODEL_CHARS),
      ...(connector.secretEnvFile !== undefined
        ? { secretEnvFile: absolutePath(connector.secretEnvFile, `${field}.secretEnvFile`) }
        : {}),
      ...(secretEnvKey !== undefined ? { secretEnvKey } : {}),
      ...(connector.toolTransport !== undefined
        ? { toolTransport: oneOf(connector.toolTransport, TOOL_TRANSPORTS, `${field}.toolTransport`) }
        : {}),
      ...(connector.maxTokensField !== undefined
        ? { maxTokensField: oneOf(connector.maxTokensField, MAX_TOKENS_FIELDS, `${field}.maxTokensField`) }
        : {}),
      ...(connector.contextLength !== undefined
        ? { contextLength: parsePositiveUint64(connector.contextLength, `${field}.contextLength`) }
        : {}),
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    };
  }
  if (kind === 'llamacpp') {
    const settings = asObject(connector.settings, `${field}.settings`);
    rejectUnknownKeys(settings, ['seed', 'temperature', 'ctx'], `${field}.settings`);
    if (typeof settings.seed !== 'number' || !Number.isSafeInteger(settings.seed) || settings.seed < 0) {
      throw new Error(`${field}.settings.seed must be a non-negative integer`);
    }
    if (typeof settings.temperature !== 'string' || !DECIMAL_TEMPERATURE.test(settings.temperature)
      || Number(settings.temperature) > 2) {
      throw new Error(`${field}.settings.temperature must be a decimal string 0..2 (e.g. "0" or "0.7")`);
    }
    if (typeof settings.ctx !== 'number' || !Number.isSafeInteger(settings.ctx) || settings.ctx < 1) {
      throw new Error(`${field}.settings.ctx must be a positive integer`);
    }
    return {
      kind,
      baseUrl: upstreamUrl(connector.baseUrl, `${field}.baseUrl`),
      ggufPath: absolutePath(connector.ggufPath, `${field}.ggufPath`),
      settings: { seed: settings.seed, temperature: settings.temperature, ctx: settings.ctx },
      ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    };
  }
  if (connector.acknowledgeSubscriptionScope !== true) {
    throw new Error(
      `${field}.acknowledgeSubscriptionScope must be the literal true: reselling a personal Codex `
      + 'subscription to third parties breaches upstream terms, so a codex-oauth offering is restricted to allowedBuyers',
    );
  }
  return {
    kind,
    upstreamModel: boundedString(connector.upstreamModel, `${field}.upstreamModel`, MAX_UPSTREAM_MODEL_CHARS),
    ...(connector.authFile !== undefined ? { authFile: absolutePath(connector.authFile, `${field}.authFile`) } : {}),
    ...(connector.baseUrl !== undefined ? { baseUrl: upstreamUrl(connector.baseUrl, `${field}.baseUrl`) } : {}),
    ...(connector.reasoningEffort !== undefined
      ? { reasoningEffort: oneOf(connector.reasoningEffort, REASONING_EFFORTS, `${field}.reasoningEffort`) }
      : {}),
    acknowledgeSubscriptionScope: true,
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
  };
}

/** `{ kind, path? }`: a file kind needs an absolute path; `stub-words-v1` takes none. */
export function parseTokenizerFileRef(raw: unknown, field: string): { kind: TokenizerKindName; path?: string } {
  const tokenizer = asObject(raw, field);
  rejectUnknownKeys(tokenizer, ['kind', 'path'], field);
  const kind = oneOf(tokenizer.kind, TOKENIZER_KINDS, `${field}.kind`);
  if (kind === 'stub-words-v1') {
    if (tokenizer.path !== undefined) throw new Error(`${field}.path must be omitted for stub-words-v1 (it loads no file)`);
    return { kind };
  }
  return { kind, path: absolutePath(tokenizer.path, `${field}.path`) };
}

function parseMetering(raw: unknown, field: string): NonNullable<MarketplaceOfferingConfig['metering']> {
  const metering = asObject(raw, field);
  rejectUnknownKeys(metering, ['tokenizer'], field);
  return metering.tokenizer === undefined ? {} : { tokenizer: parseTokenizerFileRef(metering.tokenizer, `${field}.tokenizer`) };
}

function parseAllowedBuyers(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw) || raw.length > MAX_ALLOWED_BUYERS) {
    throw new Error(`${field} must be an array of at most ${MAX_ALLOWED_BUYERS} EVM addresses`);
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || !ethers.isAddress(entry.toLowerCase())) {
      throw new Error(`${field}[${index}] must be a 0x-prefixed EVM address`);
    }
    return ethers.getAddress(entry.toLowerCase());
  });
}

function parseModelFacts(raw: unknown, field: string): NonNullable<MarketplaceOfferingConfig['model']> {
  const model = asObject(raw, field);
  rejectUnknownKeys(model, ['displayName', 'family', 'contextLength', 'quantization'], field);
  return {
    ...(model.displayName !== undefined
      ? { displayName: boundedString(model.displayName, `${field}.displayName`, MAX_LABEL_CHARS) }
      : {}),
    ...(model.family !== undefined ? { family: boundedString(model.family, `${field}.family`, 64) } : {}),
    ...(model.contextLength !== undefined
      ? { contextLength: parsePositiveUint64(model.contextLength, `${field}.contextLength`) }
      : {}),
    ...(model.quantization !== undefined
      ? { quantization: boundedString(model.quantization, `${field}.quantization`, 64) }
      : {}),
  };
}

/**
 * The OT-RFC-27 offering extensions (connector, metering pin, buyer
 * allowlist, model facts) of one offering object. `connector` present ⇔
 * executor `chat-connector` (the default when a connector is present).
 */
export function parseMarketplaceOfferingExtensions(
  offering: Record<string, unknown>,
  field: string,
): Pick<MarketplaceOfferingConfig, 'connector' | 'metering' | 'allowedBuyers' | 'model'> {
  const hasConnector = offering.connector !== undefined;
  if (offering.executor === 'chat-connector' && !hasConnector) {
    throw new Error(`${field}.connector is required for executor chat-connector`);
  }
  if (hasConnector && offering.executor !== undefined && offering.executor !== 'chat-connector') {
    throw new Error(`${field}.connector requires executor chat-connector (or no executor)`);
  }
  if (offering.metering !== undefined && !hasConnector) {
    throw new Error(`${field}.metering applies only to chat-connector offerings`);
  }
  return {
    ...(hasConnector ? { connector: parseMarketplaceConnector(offering.connector, `${field}.connector`) } : {}),
    ...(offering.metering !== undefined ? { metering: parseMetering(offering.metering, `${field}.metering`) } : {}),
    ...(offering.allowedBuyers !== undefined
      ? { allowedBuyers: parseAllowedBuyers(offering.allowedBuyers, `${field}.allowedBuyers`) }
      : {}),
    ...(offering.model !== undefined ? { model: parseModelFacts(offering.model, `${field}.model`) } : {}),
  };
}
