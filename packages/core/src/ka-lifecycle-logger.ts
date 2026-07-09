import { Logger, type OperationContext } from './logger.js';

export type KaLifecycleLogLevel = 'info' | 'warn' | 'error';

export const KA_LIFECYCLE_STAGES = [
  'identity',
  'wm',
  'swm_share',
  'sender_key',
  'storage_ack',
  'chain',
  'vm',
  'finalization',
  'sync',
  'reconcile',
] as const;

export type KaLifecycleStage = typeof KA_LIFECYCLE_STAGES[number];

export const KA_LIFECYCLE_ROLES = ['publisher', 'receiver', 'sync'] as const;

export type KaLifecycleRole = typeof KA_LIFECYCLE_ROLES[number];

export type KaLifecycleMetadataValue = string | number | boolean | null | undefined;

export interface KaLifecycleLogEvent {
  level?: KaLifecycleLogLevel;
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
const KA_LIFECYCLE_SENSITIVE_METADATA_VALUE = [
  /<[^>\s]+>\s+<[^>\s]+>\s+(?:"[^"]*"|<[^>]+>|_:[^\s]+|[^\s]+)\s*\./,
  /\bciphertext\b(?=.*(?:0x)?[0-9a-fA-F]{64,})/i,
  /\b(?:private|secret|customer secret)\s+payload\b/i,
  /\b(?:private key|secret key|mnemonic|seed phrase)\b/i,
];

export function logKaLifecycleEvent(log: Logger, ctx: OperationContext, input: KaLifecycleLogEvent): void {
  const level = input.level ?? 'info';
  log[level](ctx, formatKaLifecycleEvent(input));
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
  return `ka_lifecycle ${fields
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

export function parseKaLifecycleFields(message: string): Record<string, string> | undefined {
  const marker = 'ka_lifecycle';
  const markerIndex = message.indexOf(marker);
  if (markerIndex < 0) return undefined;

  const fields: Record<string, string> = {};
  let offset = markerIndex + marker.length;
  while (offset < message.length) {
    offset = skipKaLifecycleWhitespace(message, offset);
    if (offset >= message.length) break;

    const keyStart = offset;
    while (offset < message.length && !/[\s=]/.test(message[offset])) offset += 1;
    const key = message.slice(keyStart, offset);
    if (!key || message[offset] !== '=') {
      offset = skipKaLifecycleToken(message, offset);
      continue;
    }
    offset += 1;

    if (message[offset] === '"') {
      const parsed = parseQuotedKaLifecycleValue(message, offset);
      if (!parsed) {
        offset = skipKaLifecycleToken(message, offset);
        continue;
      }
      fields[key] = parsed.value;
      offset = parsed.nextOffset;
    } else {
      const valueStart = offset;
      offset = skipKaLifecycleToken(message, offset);
      fields[key] = message.slice(valueStart, offset);
    }
  }

  return fields;
}

function skipKaLifecycleWhitespace(input: string, offset: number): number {
  while (offset < input.length && /\s/.test(input[offset])) offset += 1;
  return offset;
}

function skipKaLifecycleToken(input: string, offset: number): number {
  while (offset < input.length && !/\s/.test(input[offset])) offset += 1;
  return offset;
}

function parseQuotedKaLifecycleValue(
  input: string,
  offset: number,
): { value: string; nextOffset: number } | undefined {
  let cursor = offset + 1;
  let escaped = false;
  while (cursor < input.length) {
    const char = input[cursor];
    if (escaped) {
      escaped = false;
      cursor += 1;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      cursor += 1;
      continue;
    }
    if (char === '"') {
      const encoded = input.slice(offset, cursor + 1);
      try {
        const decoded = JSON.parse(encoded);
        return { value: String(decoded), nextOffset: cursor + 1 };
      } catch {
        return undefined;
      }
    }
    cursor += 1;
  }
  return undefined;
}
