import { assertSafeIri, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';

/** Preserve the low-level metadata generators' existing raw-formatting contract. */
export function formatUncheckedWorkspaceOperationSubject(contextGraphId: string, shareOperationId: string): string {
  return `urn:dkg:share:${contextGraphId}:${shareOperationId}`;
}

/** Canonical checked constructor: trim identifiers, require safe non-empty parts. */
export function workspaceOperationSubject(contextGraphId: string, shareOperationId: string): string {
  const subject = formatUncheckedWorkspaceOperationSubject(
    safeWorkspaceIdPart(contextGraphId, 'contextGraphId'),
    safeWorkspaceIdPart(shareOperationId, 'shareOperationId'),
  );
  assertSafeIri(subject);
  return subject;
}

export function workspaceOperationPublicSliceSubject(
  contextGraphId: string,
  shareOperationId: string,
  rootEntity: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId, rootEntity].map(part => encodeURIComponent(part));
  const subject = `urn:dkg:public-stage:${parts.join(':')}`;
  assertSafeIri(subject);
  return subject;
}

const WORKSPACE_KA_HEAD_SUFFIX = '#dkg-swm-head';

export function workspaceKnowledgeAssetHeadSubject(kaUal: string): string {
  const scope = createGraphKnowledgeAssetScope(kaUal, 1);
  const subject = `${scope.ual}${WORKSPACE_KA_HEAD_SUFFIX}`;
  assertSafeIri(subject);
  return subject;
}

/** Malformed heads still claim operations and must not disappear during recovery. */
export function isWorkspaceKnowledgeAssetHeadSubject(subject: string): boolean {
  return subject.endsWith(WORKSPACE_KA_HEAD_SUFFIX);
}

function safeWorkspaceIdPart(value: string, fieldName: 'contextGraphId' | 'shareOperationId'): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Shared-memory resolution requires a non-empty ${fieldName}`);
  }

  if (/[\s<>"{}|^`\\]/.test(normalized)) {
    throw new Error(`Shared-memory resolution rejected unsafe ${fieldName}: ${value}`);
  }

  return normalized;
}
