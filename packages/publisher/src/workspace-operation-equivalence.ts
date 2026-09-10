// SPDX-License-Identifier: Apache-2.0

/** Content commitment shared by the publisher and recovery comparison policies. */
export interface WorkspaceOperationCommitment {
  readonly publicQuadsDigest: string;
  readonly publicTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly privateTripleCount: number;
}

/** Publisher-owned facts that make two decoded operations one logical share. */
export interface PublisherWorkspaceOperationSemantics
  extends WorkspaceOperationCommitment {
  readonly publisherIdentity: string;
  readonly accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  readonly allowedPeers: readonly string[];
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

/**
 * Publisher-local equality for decoded workspace operations. RDF lexical
 * normalization belongs to the recovery policy that compares wire and stored
 * rows; this boundary receives validated publisher values only.
 */
export function publisherWorkspaceOperationSemanticsKey(
  semantics: PublisherWorkspaceOperationSemantics,
): string {
  const normalizeSet = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify({
    publicQuadsDigest: semantics.publicQuadsDigest,
    publicTripleCount: semantics.publicTripleCount,
    ...(semantics.privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: semantics.privateMerkleRoot }),
    privateTripleCount: semantics.privateTripleCount,
    publisherIdentity: semantics.publisherIdentity,
    accessPolicy: semantics.accessPolicy,
    allowedPeers: normalizeSet(semantics.allowedPeers),
  });
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
): Readonly<{ selected: T; shareOperationIds: readonly string[] }> {
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
  return Object.freeze({
    selected: ordered[0]!,
    shareOperationIds: Object.freeze(
      [...new Set(candidates.map(({ provenance }) => provenance.shareOperationId))].sort(),
    ),
  });
}

/** Exact-intent consumers accept any alias in the resolver-validated class. */
export function workspaceHeadIncludesShareOperationId(
  head: Readonly<{ shareOperationId: string; shareOperationIds?: readonly string[] }>,
  shareOperationId: string,
): boolean {
  const expected = shareOperationId.trim();
  return (head.shareOperationIds ?? [head.shareOperationId]).includes(expected);
}
