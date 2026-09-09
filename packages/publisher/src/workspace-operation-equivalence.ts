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
  /** Feature-owned semantic fields that are not part of the base publisher shape. */
  readonly extensions?: Readonly<Record<string, string | readonly string[] | undefined>>;
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

function canonicalRecord(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (Array.isArray(value)) return [key, [...new Set(value)].sort()];
      if (value !== null && typeof value === 'object') {
        return [key, canonicalRecord(value as Readonly<Record<string, unknown>>)]
      }
      return [key, value];
    }));
}

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
  const normalized: WorkspaceOperationSemantics = {
    ...semantics,
    publicQuadsDigest: mode === 'cross-store'
      ? semantics.publicQuadsDigest.trim().toLowerCase()
      : semantics.publicQuadsDigest,
    ...(semantics.privateMerkleRoot === undefined
      ? {}
      : { privateMerkleRoot: semantics.privateMerkleRoot.toLowerCase() }),
    ...(semantics.publisherIdentity === undefined
      ? {}
      : { publisherIdentity: semantics.publisherIdentity.trim() }),
    allowedPeers: [...new Set(semantics.allowedPeers.map((peer) => peer.trim()))].sort(),
  };
  return JSON.stringify(canonicalRecord(normalized as unknown as Readonly<Record<string, unknown>>));
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
