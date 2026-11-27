import { Logger, type OperationContext } from './logger.js';

import type { LogLevel } from './logger.js';

export type KaLifecycleLogLevel = LogLevel;
export type KaLifecycleLogDetail = 'summary' | 'debug';

export const KA_LIFECYCLE_STAGES = [
  'identity',
  'wm',
  'swm_share',
  'sender_key',
  'storage_ack',
  'chain',
  'vm',
  'finalization',
] as const;

export type KaLifecycleStage = typeof KA_LIFECYCLE_STAGES[number];

export const KA_LIFECYCLE_ROLES = ['publisher', 'receiver'] as const;

export type KaLifecycleRole = typeof KA_LIFECYCLE_ROLES[number];

export type KaLifecycleMetadataValue = string | number | boolean | null | undefined;

export interface KaLifecycleLogEvent {
  level?: KaLifecycleLogLevel;
  detail?: KaLifecycleLogDetail;
  assetUal: string;
  stage: KaLifecycleStage;
  event: string;
  role: KaLifecycleRole;
  localPeerId: string;
  localNodeIdentityId: string;
  peer?: string;
  peerNodeIdentityId?: string;
  metadata?: Record<string, KaLifecycleMetadataValue>;
}

const KA_LIFECYCLE_REDACTED = '[REDACTED]';
const KA_LIFECYCLE_METADATA_MAX_CHARS = 160;
const KA_LIFECYCLE_UNSAFE_METADATA_KEY = /(?:ciphertext|nquads?|quads?|triples?|payload|plaintext|private|secret|raw)/i;
const KA_LIFECYCLE_VALUE_REQUIRES_QUOTE = /[\s"\\\u0000-\u001f\u007f\u2028\u2029]/;
const KA_PUBLISH_LIFECYCLE_DEBUG_ENV_KEYS = [
  'DKG_DEBUG_KA_PUBLISH_LIFECYCLE',
] as const;
let configuredKaPublishLifecycleDebugLogging: boolean | undefined;
const KA_LIFECYCLE_TRUE_ENV = /^(1|true|yes|on)$/i;
const KA_LIFECYCLE_SUMMARY_EVENTS = new Set<string>([
  'identity:asset_ual_allocated',
  'wm:write',
  'swm_share:prepared',
  'swm_share:swm_update_applied',
  'swm_share:swm_update_rejected',
  'swm_share:swm_state_changed',
  'storage_ack:request',
  'storage_ack:quorum',
  'storage_ack:failure',
  'storage_ack:storage_ack_declined',
  'chain:submit',
  'chain:confirm',
  'chain:failure',
  'vm:promote',
  'finalization:complete',
  'finalization:finalization_applied',
  'finalization:finalization_failed',
]);
const KA_LIFECYCLE_SENSITIVE_METADATA_VALUE = [
  /<[^>\s]+>\s+<[^>\s]+>\s+(?:"[^"]*"|<[^>]+>|_:[^\s]+|[^\s]+)\s*\./,
  /\bciphertext\b(?=.*(?:0x)?[0-9a-fA-F]{64,})/i,
  /\b(?:private|secret|customer secret)\s+payload\b/i,
  /\b(?:private key|secret key|mnemonic|seed phrase)\b/i,
];

export function logKaLifecycleEvent(log: Logger, ctx: OperationContext, input: KaLifecycleLogEvent): void {
  const detail = resolveKaLifecycleLogDetail(input);
  if (detail === 'debug' && !isKaPublishLifecycleDebugLoggingEnabled()) return;
  const level = input.level ?? 'info';
  log[level](ctx, formatKaLifecycleEvent(input));
}

export function isKaPublishLifecycleDebugLoggingEnabled(): boolean {
  if (configuredKaPublishLifecycleDebugLogging !== undefined) return configuredKaPublishLifecycleDebugLogging;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (!env) return false;
  return KA_PUBLISH_LIFECYCLE_DEBUG_ENV_KEYS.some((key) => KA_LIFECYCLE_TRUE_ENV.test(env[key] ?? ''));
}

export function setKaPublishLifecycleDebugLoggingEnabled(enabled: boolean | undefined): void {
  configuredKaPublishLifecycleDebugLogging = enabled;
}

export function resolveKaLifecycleLogDetail(input: KaLifecycleLogEvent): KaLifecycleLogDetail {
  if (input.detail) return input.detail;
  if (input.level === 'warn' || input.level === 'error') return 'summary';
  if (KA_LIFECYCLE_SUMMARY_EVENTS.has(`${input.stage}:${input.event}`)) return 'summary';
  return 'debug';
}

function formatKaLifecycleEvent(input: KaLifecycleLogEvent): string {
  const fields: Array<[string, KaLifecycleMetadataValue, boolean]> = [
    ['assetUal', input.assetUal, true],
    ['stage', input.stage, true],
    ['event', input.event, true],
    ['role', input.role, true],
    ['localPeerId', input.localPeerId, true],
    ['localNodeIdentityId', input.localNodeIdentityId, true],
    ['peer', input.peer, true],
    ['peerNodeIdentityId', input.peerNodeIdentityId, true],
  ];
  if (input.metadata) {
    for (const [key, value] of Object.entries(input.metadata)) fields.push([key, value, false]);
  }
  return `ka_publish_lifecycle ${fields
    .filter(([, value]) => value !== undefined)
    .map(([key, value, keepFull]) => `${key}=${formatKaLifecycleValue(key, value, keepFull)}`)
    .join(' ')}`;
}

function formatKaLifecycleValue(key: string, value: KaLifecycleMetadataValue, keepFull: boolean): string {
  if (KA_LIFECYCLE_UNSAFE_METADATA_KEY.test(key)) return KA_LIFECYCLE_REDACTED;
  const raw = String(value);
  if (!keepFull && isSensitiveKaLifecycleValue(raw)) return KA_LIFECYCLE_REDACTED;
  if (keepFull) return encodeKaLifecycleValue(raw);
  if (typeof value !== 'string') return encodeKaLifecycleValue(raw);
  if (raw.length <= KA_LIFECYCLE_METADATA_MAX_CHARS) return encodeKaLifecycleValue(raw);
  return encodeKaLifecycleValue(`${raw.slice(0, KA_LIFECYCLE_METADATA_MAX_CHARS)}...[truncated:${raw.length}]`);
}

function isSensitiveKaLifecycleValue(value: string): boolean {
  return KA_LIFECYCLE_SENSITIVE_METADATA_VALUE.some((pattern) => pattern.test(value));
}

function encodeKaLifecycleValue(value: string): string {
  if (!KA_LIFECYCLE_VALUE_REQUIRES_QUOTE.test(value) && value.length > 0) return value;
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
