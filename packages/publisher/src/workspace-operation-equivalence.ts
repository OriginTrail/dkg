// SPDX-License-Identifier: Apache-2.0

/** Content and access facts that make a workspace operation one logical share. */
export interface WorkspaceOperationSemantics {
  readonly publicQuadsDigest: string;
  readonly publicTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly privateTripleCount: number;
  readonly publisherIdentity?: string;
  readonly accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  readonly allowedPeers: readonly string[];
  /** Recovery-only identity facts, absent from publisher-local head selection. */
  readonly recoveryIdentity?: WorkspaceOperationRecoveryIdentity;
}

/** Finite recovery profile shared by decoded and cross-store comparisons. */
export interface WorkspaceOperationRecoveryIdentity {
  readonly contextGraphId: string;
  readonly contentScopeVersion: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly subGraphName?: string;
  readonly authorIdentities: readonly string[];
}

/** Persistence facts that may legitimately differ between equivalent aliases. */
export interface WorkspaceOperationProvenance {
  readonly shareOperationId: string;
  readonly publishedAtMs?: number;
}

export interface WorkspaceOperationModel {
  readonly semantics: WorkspaceOperationSemantics;
  readonly provenance: WorkspaceOperationProvenance;
}

export type WorkspaceOperationEquivalenceMode = 'decoded' | 'cross-store';

/**
 * The canonical equality boundary for workspace-operation aliases. Provenance
 * is deliberately absent. Both modes share the same semantic field list;
 * cross-store mode additionally normalizes values that RDF stores commonly
 * canonicalize while decoded mode preserves already-validated values.
 */
export function workspaceOperationSemanticsKey(
  semantics: WorkspaceOperationSemantics,
  mode: WorkspaceOperationEquivalenceMode = 'decoded',
): string {
  const normalizeSet = (values: readonly string[]) => [...new Set(values)].sort();
  const normalized = {
    publicQuadsDigest: mode === 'cross-store'
      ? semantics.publicQuadsDigest.trim().toLowerCase()
      : semantics.publicQuadsDigest,
    publicTripleCount: semantics.publicTripleCount,
    ...(semantics.privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: semantics.privateMerkleRoot.toLowerCase() }),
    privateTripleCount: semantics.privateTripleCount,
    ...(semantics.publisherIdentity === undefined
      ? {}
      : { publisherIdentity: semantics.publisherIdentity.trim() }),
    accessPolicy: semantics.accessPolicy
      ?? (semantics.privateTripleCount > 0 ? 'ownerOnly' : 'public'),
    allowedPeers: normalizeSet(semantics.allowedPeers.map((peer) => peer.trim())),
    ...(semantics.recoveryIdentity === undefined ? {} : {
      recoveryIdentity: {
        contextGraphId: semantics.recoveryIdentity.contextGraphId,
        contentScopeVersion: semantics.recoveryIdentity.contentScopeVersion,
        kaUal: semantics.recoveryIdentity.kaUal,
        assertionVersion: semantics.recoveryIdentity.assertionVersion,
        ...(semantics.recoveryIdentity.subGraphName === undefined
          ? {}
          : { subGraphName: semantics.recoveryIdentity.subGraphName }),
        authorIdentities: normalizeSet(semantics.recoveryIdentity.authorIdentities),
      },
    }),
  };
  return JSON.stringify(normalized);
}

/** Validate one equivalence class and select its deterministic display alias. */
export function selectEquivalentWorkspaceOperation<T extends WorkspaceOperationModel>(
  candidates: readonly T[],
  options: Readonly<{
    mode?: WorkspaceOperationEquivalenceMode;
    ambiguityError?: () => Error;
  }> = {},
): Readonly<{ selected: T; shareOperationIds: readonly string[] }> {
  if (candidates.length === 0) throw new Error('Workspace operation candidates are empty');
  const keys = new Set(candidates.map((candidate) => (
    workspaceOperationSemanticsKey(candidate.semantics, options.mode)
  )));
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
