import { type KaLifecycleStage, type LogRecord } from '@origintrail-official/dkg-core';

export const KA_LIFECYCLE_PROOF_SOURCE_DOCS = [
  'CONTEXT.md',
  'docs/adr/0001-log-ka-publish-lifecycle-by-asset-ual.md',
] as const;

export const KA_LIFECYCLE_PROOF_REQUIRED_STAGES = [
  'identity',
  'wm',
  'swm_share',
  'storage_ack',
  'chain',
  'vm',
  'finalization',
  'sync',
  'reconcile',
] as const satisfies readonly KaLifecycleStage[];

export interface KaLifecycleProofRecord extends Pick<LogRecord, 'level' | 'module' | 'message'> {
  source?: string;
  node?: string;
}

export interface KaLifecycleProofEntry {
  source: string;
  level: string;
  module: string;
  message: string;
  fields: Record<string, string>;
}

export interface KaLifecycleLogProof {
  assetUal: string;
  entries: KaLifecycleProofEntry[];
  grep: string;
  grepLines: string[];
  stageTrail: string[];
  eventTrail: string[];
  roleTrail: string[];
  sourceTrail: string[];
  missingRequiredStages: string[];
  hasAckLog: boolean;
  hasStateChangeLog: boolean;
  hasFailureOrDeclineLog: boolean;
  hasPayloadLeak: boolean;
  sourceDocuments: typeof KA_LIFECYCLE_PROOF_SOURCE_DOCS;
}

const PAYLOAD_LEAK_PATTERNS = [
  /<[^>\s]+>\s+<[^>\s]+>\s+(?:"[^"]*"|<[^>]+>|_:[^\s]+|[^\s]+)\s*\./,
  /\bciphertext=(?!\[REDACTED\])(?:0x)?[0-9a-fA-F]{32,}/i,
  /\b(?:rawTriples|triples|nquads|payload|plaintext|privatePayloadSnippet)=(?!\[REDACTED\])/i,
  /private payload/i,
];

const STATE_CHANGE_EVENTS = new Set([
  'write',
  'swm_state_changed',
  'promote',
  'finalization_applied',
  'sync_apply',
  'reconcile_promote',
  'reconcile_core_fill',
]);

export function buildKaLifecycleLogProof(
  records: readonly KaLifecycleProofRecord[],
  assetUal: string,
): KaLifecycleLogProof {
  const entries = records
    .map((record) => toProofEntry(record))
    .filter((entry): entry is KaLifecycleProofEntry => entry?.fields.assetUal === assetUal);
  const stageTrail = unique(entries.map((entry) => entry.fields.stage).filter(Boolean));
  const eventTrail = entries.map((entry) => entry.fields.event).filter(Boolean);
  const roleTrail = unique(entries.map((entry) => entry.fields.role).filter(Boolean));
  const sourceTrail = unique(entries.map((entry) => entry.source).filter(Boolean));
  return {
    assetUal,
    entries,
    grepLines: entries.map((entry) => `${entry.source}: ${entry.message}`),
    get grep() {
      return this.grepLines.join('\n');
    },
    stageTrail,
    eventTrail,
    roleTrail,
    sourceTrail,
    missingRequiredStages: KA_LIFECYCLE_PROOF_REQUIRED_STAGES.filter((stage) => !stageTrail.includes(stage)),
    hasAckLog: entries.some((entry) => entry.fields.stage === 'storage_ack' || /ack/i.test(entry.fields.event ?? '')),
    hasStateChangeLog: entries.some((entry) => STATE_CHANGE_EVENTS.has(entry.fields.event ?? '')),
    hasFailureOrDeclineLog: entries.some((entry) => {
      const event = entry.fields.event ?? '';
      const outcome = entry.fields.outcome ?? '';
      return entry.level === 'warn' ||
        entry.level === 'error' ||
        /(decline|fail|reject|timeout)/i.test(event) ||
        /(decline|fail|reject|timeout|deferred)/i.test(outcome);
    }),
    hasPayloadLeak: entries.some((entry) =>
      PAYLOAD_LEAK_PATTERNS.some((pattern) => pattern.test(entry.message)),
    ),
    sourceDocuments: KA_LIFECYCLE_PROOF_SOURCE_DOCS,
  };
}

function toProofEntry(record: KaLifecycleProofRecord): KaLifecycleProofEntry | undefined {
  const fields = parseKaLifecycleFields(record.message);
  if (!fields) return undefined;
  return {
    source: record.source ?? record.node ?? fields.localPeerId ?? record.module,
    level: record.level,
    module: record.module,
    message: record.message,
    fields,
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseKaLifecycleFields(message: string): Record<string, string> | undefined {
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
