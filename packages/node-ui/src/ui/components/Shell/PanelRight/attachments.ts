import type {
  LocalAgentChatAttachmentImportResult,
  LocalAgentChatAttachmentRef,
} from '../../../api.js';
import type { LocalAgentAttachmentDraft } from './types.js';
import { formatAttachmentImportContextValue } from './format.js';

export function buildAttachmentSummary(attachments: LocalAgentChatAttachmentRef[]): string {
  if (attachments.length === 0) return '';
  const names = attachments.map((attachment) => attachment.fileName);
  if (names.length <= 2) {
    return `Attached ${names.join(' and ')}.`;
  }
  return `Attached ${names[0]} and ${names.length - 1} more files.`;
}

export function isSendableAttachmentDraft(draft: LocalAgentAttachmentDraft): boolean {
  return draft.status === 'queued' || draft.status === 'completed' || draft.status === 'skipped';
}

export function normalizeAttachmentFileName(file: File): string {
  return file.name.trim();
}

export function draftToAttachmentRef(draft: LocalAgentAttachmentDraft): LocalAgentChatAttachmentRef | null {
  if (draft.status !== 'completed' || !draft.result) return null;
  const mdIntermediateHash = draft.result.extraction.mdIntermediateHash;
  const markdownHash = mdIntermediateHash
    ?? (draft.result.detectedContentType === 'text/markdown' ? draft.result.fileHash : undefined);
  return {
    id: draft.id,
    fileName: normalizeAttachmentFileName(draft.file),
    contextGraphId: draft.contextGraphId,
    assertionName: draft.assertionName,
    assertionUri: draft.result.assertionUri,
    fileHash: draft.result.fileHash,
    detectedContentType: draft.result.detectedContentType,
    rootEntity: draft.result.rootEntity,
    extractionStatus: 'completed',
    tripleCount: draft.result.extraction.tripleCount ?? draft.result.extraction.triplesWritten,
    ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    ...(markdownHash ? { markdownHash, markdownForm: `urn:dkg:file:${markdownHash}` } : {}),
  };
}

export function buildAttachmentImportResultRefs(
  drafts: LocalAgentAttachmentDraft[],
): { results: LocalAgentChatAttachmentImportResult[]; deliveredDraftIds: string[] } {
  const deliveredDraftIds: string[] = [];
  const results = drafts.flatMap((draft): LocalAgentChatAttachmentImportResult[] => {
    if (draft.status !== 'skipped' || !draft.result) return [];
    deliveredDraftIds.push(draft.id);
    const result = draft.result;
    const extraction = result.extraction;
    return [{
      id: draft.id,
      fileName: normalizeAttachmentFileName(draft.file),
      contextGraphId: draft.contextGraphId,
      assertionName: draft.assertionName,
      assertionUri: result.assertionUri,
      fileHash: result.fileHash,
      detectedContentType: result.detectedContentType,
      extractionStatus: 'skipped',
      pipelineUsed: extraction.pipelineUsed ?? null,
      tripleCount: extraction.tripleCount ?? extraction.triplesWritten ?? 0,
      ...(result.rootEntity ? { rootEntity: result.rootEntity } : {}),
      ...(extraction.mdIntermediateHash ? { mdIntermediateHash: extraction.mdIntermediateHash } : {}),
      ...(extraction.error ? { error: extraction.error } : {}),
    }];
  });

  return { results, deliveredDraftIds };
}

export function buildAttachmentImportSummary(importResults: LocalAgentChatAttachmentImportResult[]): string {
  if (importResults.length === 0) return '';
  if (importResults.length === 1) {
    return `Attachment import result: ${formatAttachmentImportContextValue(importResults[0].fileName)}.`;
  }
  return `Attached ${importResults.length} document import results.`;
}

export function buildAttachmentTurnSummary(
  attachments: LocalAgentChatAttachmentRef[],
  importResults: LocalAgentChatAttachmentImportResult[],
): string {
  const parts = [
    buildAttachmentSummary(attachments),
    buildAttachmentImportSummary(importResults),
  ]
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/\.$/, ''));
  return parts.length ? `${parts.join('; ')}.` : '';
}
