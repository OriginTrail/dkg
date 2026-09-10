// SPDX-License-Identifier: Apache-2.0

import type {
  GraphKnowledgeAssetAccessEnvelope,
} from '@origintrail-official/dkg-core';

/** Content commitment shared by the publisher and recovery comparison policies. */
export interface WorkspaceOperationCommitment {
  readonly publicQuadsDigest: string;
  readonly publicTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly privateTripleCount: number;
}

/**
 * Effective access plus the durable provenance that established it. Legacy
 * operations omitted the policy row, so that state must remain distinct from
 * an explicitly persisted default even though the two compare equivalently.
 */
export type WorkspaceOperationAccessEnvelope =
  | Readonly<GraphKnowledgeAssetAccessEnvelope & {
      kind: 'persisted';
    }>
  | Readonly<GraphKnowledgeAssetAccessEnvelope & {
      kind: 'legacy-default';
      accessPolicy: 'public' | 'ownerOnly';
      allowedPeers: readonly [];
    }>;

/** Publisher-owned facts that make two decoded operations one logical share. */
export interface PublisherWorkspaceOperationSemantics
  extends WorkspaceOperationCommitment {
  readonly publisherIdentity: string;
  readonly access: WorkspaceOperationAccessEnvelope;
}

/** Canonical publisher-owned semantic record, reusable by recovery extensions. */
export function canonicalPublisherWorkspaceOperationSemantics(
  semantics: PublisherWorkspaceOperationSemantics,
): Readonly<Record<string, unknown>> {
  const normalizeSet = (values: readonly string[]) => [...new Set(values)].sort();
  return Object.freeze({
    publicQuadsDigest: semantics.publicQuadsDigest,
    publicTripleCount: semantics.publicTripleCount,
    ...(semantics.privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: semantics.privateMerkleRoot }),
    privateTripleCount: semantics.privateTripleCount,
    publisherIdentity: semantics.publisherIdentity,
    // Equivalence is intentionally effective-policy based. The discriminant
    // survives on the decoded model for precedence decisions but an omitted
    // legacy default remains the same access semantics as an explicit default.
    accessPolicy: semantics.access.accessPolicy,
    allowedPeers: normalizeSet(semantics.access.allowedPeers),
  });
}

/** Persistence facts that may legitimately differ between equivalent aliases. */
export interface WorkspaceOperationProvenance {
  readonly shareOperationId: string;
  readonly publishedAtMs?: number;
}

export interface WorkspaceOperationModel<TSemantics> {
  readonly semantics: TSemantics;
  readonly provenance: WorkspaceOperationProvenance;
}

export type EquivalentWorkspaceOperationClass<T> = readonly [T, ...T[]];

/**
 * Publisher-local equality for decoded workspace operations. RDF lexical
 * normalization belongs to the recovery policy that compares wire and stored
 * rows; this boundary receives validated publisher values only.
 */
export function publisherWorkspaceOperationSemanticsKey(
  semantics: PublisherWorkspaceOperationSemantics,
): string {
  return JSON.stringify(canonicalPublisherWorkspaceOperationSemantics(semantics));
}

/** Validate one equivalence class and select its deterministic display alias. */
export function selectEquivalentWorkspaceOperation<
  TSemantics,
  T extends WorkspaceOperationModel<TSemantics>,
>(
  candidates: readonly T[],
  equivalenceKey: (semantics: TSemantics) => string,
  options: Readonly<{
    ambiguityError?: () => Error;
  }> = {},
): EquivalentWorkspaceOperationClass<T> {
  if (candidates.length === 0) throw new Error('Workspace operation candidates are empty');
  const keys = new Set(candidates.map((candidate) => equivalenceKey(candidate.semantics)));
  if (keys.size !== 1) {
    throw options.ambiguityError?.() ?? new Error('ambiguous shareOperationId');
  }
  const ordered = [...candidates].sort((left, right) => (
    (right.provenance.publishedAtMs ?? Number.NEGATIVE_INFINITY)
      - (left.provenance.publishedAtMs ?? Number.NEGATIVE_INFINITY)
    || right.provenance.shareOperationId.localeCompare(left.provenance.shareOperationId)
  ));
  return Object.freeze([ordered[0]!, ...ordered.slice(1)]);
}

/** Exact-intent consumers accept any alias in the resolver-validated class. */
export function workspaceHeadIncludesShareOperationId(
  head: Readonly<{
    operationAliases: readonly [
      Readonly<{ shareOperationId: string }>,
      ...Readonly<{ shareOperationId: string }>[],
    ];
  }>,
  shareOperationId: string,
): boolean {
  const expected = shareOperationId.trim();
  return head.operationAliases.some((alias) => alias.shareOperationId === expected);
}
