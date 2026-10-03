import {
  AMBIGUOUS_ASSERTION_AUTHOR_CODE,
  ASSERTION_AUTHOR_NOT_RESIDENT_CODE,
  ASSERTION_SEAL_PREDICATES,
  assertSafeIri,
  contextGraphAssertionQueryBounds,
  contextGraphMetaUri,
  escapeSparqlLiteral,
  knowledgeAssetAgentAddressesEqual,
  parseGraphScopedAssertionSealCandidate,
  validateAssertionName,
} from '@origintrail-official/dkg-core';
type SealQuad = { subject: string; predicate: string; object: string };

/**
 * Distinct authors, case-insensitive (guards the known mixed-case `_meta` hazard),
 * preserving first-seen STORED case. Shared by the ambiguity and the
 * not-resident throws so both report the candidate list identically.
 */
function distinctAuthors(candidates: readonly string[]): string[] {
  const distinct: string[] = [];
  for (const author of candidates) {
    if (!distinct.some((a) => knowledgeAssetAgentAddressesEqual(a, author))) distinct.push(author);
  }
  return distinct;
}

/** Minimal structural view of the store this resolver needs. */
export interface AssertionAuthorQueryStore {
  query(sparql: string): Promise<{
    type: string;
    bindings?: ReadonlyArray<Record<string, string>>;
    quads?: ReadonlyArray<SealQuad>;
  }>;
}

export interface AssertionAuthorCoordinate {
  readonly contextGraphId: string;
  readonly name: string;
  readonly subGraphName?: string;
}

export type ResidentAuthorBoundarySelection =
  | { readonly kind: 'address'; readonly agentAddress: string }
  | { readonly kind: 'invalid'; readonly displayValue: string };

export type ResidentAssertionAuthorSelection =
  | { readonly kind: 'callerHint'; readonly callerAgentAddress?: string }
  | { readonly kind: 'residentAuthor'; readonly selectedAuthor: ResidentAuthorBoundarySelection };

export interface FinalizedAssertionAuthorLookupParams extends AssertionAuthorCoordinate {
  readonly selection: ResidentAssertionAuthorSelection;
}

/** Snapshot malformed input for the candidate diagnostic without retaining unknown state. */
export function readResidentAuthorBoundarySelection(value: unknown): ResidentAuthorBoundarySelection {
  return typeof value === 'string'
    ? { kind: 'address', agentAddress: value }
    : { kind: 'invalid', displayValue: String(value) };
}

async function findResidentFinalizedAssertionAuthors(
  store: AssertionAuthorQueryStore,
  { contextGraphId, name, subGraphName }: AssertionAuthorCoordinate,
): Promise<string[] | undefined> {
  if (!validateAssertionName(name).valid) return undefined;
  const metaGraph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  // Bound the query by the canonical assertion-coordinate grammar (the core
  // helper owns the URI layout; `name` cannot contain `/`, so the suffix cannot
  // cross a segment, and the prefix carries a slash-containing cg id verbatim).
  const { scope: expectedScope, prefix, suffix } = contextGraphAssertionQueryBounds(
    contextGraphId, name, subGraphName,
  );
  // Phase 1 — find the candidate seal subject(s) at this name coordinate. This
  // is a bound-predicate lookup fenced by the exact coordinate prefix/suffix.
  const subjectsResult = await store.query(
    `SELECT DISTINCT ?s WHERE {
      GRAPH <${metaGraph}> {
        ?s <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root .
        FILTER(STRSTARTS(STR(?s), "${escapeSparqlLiteral(prefix)}"))
        FILTER(STRENDS(STR(?s), "${escapeSparqlLiteral(suffix)}"))
      }
    }`,
  );
  const subjects = subjectsResult.type === 'bindings'
    ? (subjectsResult.bindings ?? []).map((b) => b.s)
      .filter((subject): subject is string => typeof subject === 'string' && subject.length > 0)
    : [];

  // Phase 2 — admit only complete, self-consistent graph-scoped seals.
  const candidates: string[] = [];
  for (const subject of subjects) {
    let safeSubject: string;
    try {
      safeSubject = assertSafeIri(subject);
    } catch {
      continue;
    }
    const rowsResult = await store.query(
      `CONSTRUCT { <${safeSubject}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${safeSubject}> ?p ?o } }`,
    );
    const rows = rowsResult.type === 'quads' ? (rowsResult.quads ?? []) : [];
    const candidate = parseGraphScopedAssertionSealCandidate(rows, subject);
    if (!candidate
      || candidate.coordinate.scope !== expectedScope
      || candidate.coordinate.name !== name) continue;
    candidates.push(candidate.coordinate.agentAddress);
  }
  return candidates;
}

function authorNotResidentError(
  contextGraphId: string,
  name: string,
  displayValue: string,
  candidates: readonly string[],
): Error {
  return Object.assign(
    new Error(
      `Cannot publish "${name}" in context graph "${contextGraphId}": selected author ` +
        `${displayValue} has no finalized knowledge asset with this name.`,
    ),
    {
      code: ASSERTION_AUTHOR_NOT_RESIDENT_CODE,
      candidates: distinctAuthors(candidates),
    },
  );
}

/**
 * GH#1778 — resolve the AUTHOR of a named, finalized assertion from the local
 * `_meta` graph, for a VM publish where the caller may not be the author (a
 * curator publishing a member-shared rootless KA). Kept in a focused module,
 * not the large publish mixin, so the store/URI/EVM lookup lives beside the
 * coordinate helpers it depends on.
 *
 * Resolution order:
 *   0. if `selectedAuthor` names a resident candidate → that candidate
 *      (GH#1786); if it names none → throw `ASSERTION_AUTHOR_NOT_RESIDENT`. An
 *      explicit selection is never silently ignored, and it outranks rule 1;
 *   1. if the caller authored a KA of this name → the caller's own (stored-case)
 *      address, so self-publish is byte-identical to before;
 *   2. else if exactly one other author has it → that author;
 *   3. else if several other authors have it → throw `AMBIGUOUS_ASSERTION_AUTHOR`
 *      with the candidate list;
 *   4. else (none finalized) → `undefined`, so the caller falls back to its own
 *      address and the existing "is not finalized" error stands.
 *
 * The returned address is the EXACT case stored on the seal subject, so a
 * downstream `contextGraphAssertionUri(...)` re-read hits the same subject
 * (`contextGraphAssertionUri` does not canonicalise address case).
 */
export async function resolveResidentFinalizedAssertionAuthor(
  store: AssertionAuthorQueryStore,
  { contextGraphId, name, subGraphName, selection }: FinalizedAssertionAuthorLookupParams,
): Promise<string | undefined> {
  const candidates = await findResidentFinalizedAssertionAuthors(
    store,
    { contextGraphId, name, subGraphName },
  );
  if (candidates === undefined) return undefined;
  switch (selection.kind) {
    case 'residentAuthor': {
      const selected = selection.selectedAuthor;
      if (selected.kind === 'invalid') {
        throw authorNotResidentError(contextGraphId, name, selected.displayValue, candidates);
      }
      const author = candidates.find(candidate => knowledgeAssetAgentAddressesEqual(
        candidate, selected.agentAddress,
      ));
      if (author) return author;
      throw authorNotResidentError(contextGraphId, name, selected.agentAddress, candidates);
    }
    case 'callerHint': {
      if (candidates.length === 0) return undefined;
      const callerAgentAddress = selection.callerAgentAddress;
      if (callerAgentAddress) {
        const own = candidates.find(author => knowledgeAssetAgentAddressesEqual(
          author, callerAgentAddress,
        ));
        if (own) return own;
      }
      const distinct = distinctAuthors(candidates);
      if (distinct.length === 1) return distinct[0];
      throw Object.assign(
        new Error(
          `Cannot publish "${name}" in context graph "${contextGraphId}": ` +
            `${distinct.length} authors have a knowledge asset with this name. ` +
            `Publish is unambiguous only for a single author.`,
        ),
        { code: AMBIGUOUS_ASSERTION_AUTHOR_CODE, candidates: distinct },
      );
    }
    default: {
      const unreachable: never = selection;
      throw new Error(`Unsupported resident-author selection: ${unreachable}`);
    }
  }
}
