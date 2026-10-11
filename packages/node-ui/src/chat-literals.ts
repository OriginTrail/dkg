// SPDX-License-Identifier: Apache-2.0
/**
 * Value parsing for chat-history rows: RDF literals, the persistence status a
 * turn or transition reports, and the JSON literals that carry a message's
 * attachment refs and tool calls. Pure functions over the strings a SPARQL row
 * holds, shared by `ChatMemoryManager` (which also validates the same shapes
 * before writing them) and the history-row assembly in `chat-history-rows.ts`.
 */

/** What a history reader shows for a turn: the persistence status of its latest report. */
export type ChatTurnPersistenceDisplayState = 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';

const PERSISTENCE_STATUS_RANK: Record<ChatTurnPersistenceDisplayState, number> = {
  skipped: 1,
  pending: 2,
  in_progress: 3,
  failed: 4,
  stored: 5,
};

export interface ChatAttachmentRef {
  id?: string;
  fileName: string;
  contextGraphId: string;
  assertionName?: string;
  assertionUri: string;
  fileHash: string;
  detectedContentType?: string;
  extractionStatus?: 'completed' | 'skipped' | 'failed';
  tripleCount?: number;
  rootEntity?: string;
}

export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export function stripRdfLiteral(value: string): string {
  if (!value) return '';
  const typed = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  if (typed) return typed[1];
  return value;
}

export function normalizePersistenceStatus(value: string): ChatTurnPersistenceDisplayState | undefined {
  const status = stripRdfLiteral(value).trim();
  if (status === 'pending' || status === 'in_progress' || status === 'stored' || status === 'failed' || status === 'skipped') {
    return status;
  }
  return undefined;
}

export function choosePersistenceStatus(
  current: ChatTurnPersistenceDisplayState | undefined,
  candidate: ChatTurnPersistenceDisplayState | undefined,
): ChatTurnPersistenceDisplayState | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return PERSISTENCE_STATUS_RANK[candidate] > PERSISTENCE_STATUS_RANK[current] ? candidate : current;
}

function normalizeChatAttachmentRef(raw: unknown): ChatAttachmentRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
  const contextGraphId = typeof record.contextGraphId === 'string' ? record.contextGraphId.trim() : '';
  const assertionUri = typeof record.assertionUri === 'string' ? record.assertionUri.trim() : '';
  const fileHash = typeof record.fileHash === 'string' ? record.fileHash.trim() : '';
  if (!fileName || !contextGraphId || !assertionUri || !fileHash) return null;

  const normalized: ChatAttachmentRef = {
    fileName,
    contextGraphId,
    assertionUri,
    fileHash,
  };
  if (typeof record.id === 'string' && record.id.trim()) normalized.id = record.id.trim();
  if (typeof record.assertionName === 'string' && record.assertionName.trim()) normalized.assertionName = record.assertionName.trim();
  if (typeof record.detectedContentType === 'string' && record.detectedContentType.trim()) {
    normalized.detectedContentType = record.detectedContentType.trim();
  }
  if (record.extractionStatus === 'completed' || record.extractionStatus === 'skipped' || record.extractionStatus === 'failed') {
    normalized.extractionStatus = record.extractionStatus;
  }
  if (typeof record.tripleCount === 'number' && Number.isFinite(record.tripleCount) && record.tripleCount >= 0) {
    normalized.tripleCount = record.tripleCount;
  }
  if (typeof record.rootEntity === 'string' && record.rootEntity.trim()) normalized.rootEntity = record.rootEntity.trim();
  return normalized;
}

export function normalizeChatAttachmentRefs(raw: unknown): ChatAttachmentRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs = raw
    .map((entry) => normalizeChatAttachmentRef(entry))
    .filter((entry): entry is ChatAttachmentRef => entry != null);
  return refs.length > 0 ? refs : undefined;
}

function normalizeChatToolCall(raw: unknown): ChatToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'unknown';
  return {
    name,
    args: record.args && typeof record.args === 'object' && !Array.isArray(record.args)
      ? record.args as Record<string, unknown>
      : {},
    result: record.result,
  };
}

export function normalizeChatToolCalls(raw: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls = raw
    .map((entry) => normalizeChatToolCall(entry))
    .filter((entry): entry is ChatToolCall => entry != null);
  return calls.length > 0 ? calls : undefined;
}

function parseNestedJsonLiteral(value: string): unknown {
  let current: unknown = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'string') return current;
    const trimmed = current.trim();
    if (!trimmed) return undefined;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return current;
}

export function parseAttachmentRefsLiteral(value: string): ChatAttachmentRef[] | undefined {
  const candidates = [value, stripRdfLiteral(value)]
    .map((candidate) => candidate.trim())
    .filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const parsed = parseNestedJsonLiteral(candidate) ?? parseNestedJsonLiteral(JSON.stringify(candidate));
    const normalized = normalizeChatAttachmentRefs(parsed);
    if (normalized?.length) return normalized;
  }
  return undefined;
}

export function parseToolCallsLiteral(value: string): ChatToolCall[] | undefined {
  const candidates = [value, stripRdfLiteral(value)]
    .map((candidate) => candidate.trim())
    .filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const parsed = parseNestedJsonLiteral(candidate) ?? parseNestedJsonLiteral(JSON.stringify(candidate));
    const normalized = normalizeChatToolCalls(parsed);
    if (normalized?.length) return normalized;
  }
  return undefined;
}
