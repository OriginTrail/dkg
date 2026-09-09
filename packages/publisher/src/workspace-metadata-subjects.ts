import { assertSafeIri, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';

/** Shared by metadata generation, immutable-slice storage and recovery readers. */
export function workspaceOperationSubject(contextGraphId: string, shareOperationId: string): string {
  return `urn:dkg:share:${contextGraphId}:${shareOperationId}`;
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
