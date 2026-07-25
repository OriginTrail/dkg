import {
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

export interface ResolveFinalizedAssertionAuthorParams {
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  /**
   * The effective caller identity (VM publish routes pass the token holder;
   * direct callers may omit it). NOT an author selector — see
   * `resolveFinalizedAssertionPublishAuthor` for the selector-vs-hint split.
   */
  callerAgentAddress?: string;
  /**
   * GH#1786 — an explicit choice among the authors who ALREADY have a finalized
   * assertion at this coordinate, so a curator can act on an
   * `AMBIGUOUS_ASSERTION_AUTHOR` response. It selects; it never confers
   * authorship (an address that is not resident fails closed) and it never
   * changes the caller identity used for CG registration / curator stamping.
   */
  selectedAuthorAgentAddress?: string;
}

/**
 * GH#1778 — resolve the AUTHOR of a named, finalized assertion from the local
 * `_meta` graph, for a VM publish where the caller may not be the author (a
 * curator publishing a member-shared rootless KA). Kept in a focused module,
 * not the large publish mixin, so the store/URI/EVM lookup lives beside the
 * coordinate helpers it depends on.
 *
 * Resolution order:
 *   0. if `selectedAuthorAgentAddress` names a resident candidate → that candidate
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
export async function resolveFinalizedAssertionAuthor(
  store: AssertionAuthorQueryStore,
  {
    contextGraphId,
    name,
    subGraphName,
    callerAgentAddress,
    selectedAuthorAgentAddress,
  }: ResolveFinalizedAssertionAuthorParams,
): Promise<string | undefined> {
  if (!validateAssertionName(name).valid) return undefined;
  const metaGraph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  // Bound the query by the canonical assertion-coordinate grammar (the core
  // helper owns the URI layout; `name` cannot contain `/`, so the suffix cannot
  // cross a segment, and the prefix carries a slash-containing cg id verbatim).
  const { scope: expectedScope, prefix, suffix } = contextGraphAssertionQueryBounds(
    contextGraphId, name, subGraphName,
  );
  // Phase 1 — find the candidate seal subject(s) at this name coordinate. This
  // is a bound-predicate lookup fenced by the exact coordinate prefix/suffix
  // (NOT an all-variable `?s ?p ?o` scan of the growing `_meta` graph), and the
  // result is the ~1 subject finalized under this name.
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
    ? (subjectsResult.bindings ?? []).map((b) => b.s).filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];

  // Phase 2 — read each candidate's rows by EXACT subject (a bounded per-subject
  // read, not a graph scan) and admit only a complete, self-consistent
  // graph-scoped seal — the SAME canonical definition durable-sync uses
  // (`parseGraphScopedAssertionSealCandidate`). `assertionMerkleRoot` alone is
  // NOT proof of a publishable assertion: a partial/corrupt subject, or a
  // complete seal whose `authorAddress`/`kaUal` disagree with its
  // `/assertion/<addr>/…` coordinate, is treated as not-finalized (GH#1778 review).
  const candidates: string[] = [];
  for (const subject of subjects) {
    let safeSubject: string;
    try {
      safeSubject = assertSafeIri(subject);
    } catch {
      continue; // unsafe/corrupt subject IRI — cannot be a valid candidate
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
  // 0. GH#1786 — an explicit resident-candidate selection is authoritative. It is
  // evaluated BEFORE both the zero-candidate return and the caller-preference rule
  // below, for two reasons: it is what lets a curator who ALSO owns a same-named KA
  // publish the member's instead of silently self-publishing, and it guarantees a
  // supplied selector can never be silently ignored — a dropped selector spends real
  // TRAC/gas on the wrong author. Matching is case-insensitive but the STORED case is
  // returned, because `contextGraphAssertionUri` does not canonicalise address case.
  // Presence, NOT truthiness: a caller supplying `''` — or `null` from untyped JS — has
  // still SUPPLIED a selector, and silently falling back to normal resolution is the exact
  // silent-drop this option exists to prevent. Only `undefined` is absent, matching the
  // HTTP boundary, which 400s every other malformed value. Anything present that names no
  // resident candidate fails closed below.
  if (selectedAuthorAgentAddress !== undefined) {
    const selected = candidates.find(
      (a) => knowledgeAssetAgentAddressesEqual(a, selectedAuthorAgentAddress),
    );
    if (selected) return selected;
    throw Object.assign(
      new Error(
        `Cannot publish "${name}" in context graph "${contextGraphId}": selected author ` +
          `${selectedAuthorAgentAddress} has no finalized knowledge asset with this name.`,
      ),
      {
        code: 'ASSERTION_AUTHOR_NOT_RESIDENT',
        candidates: distinctAuthors(candidates),
      },
    );
  }
  if (candidates.length === 0) return undefined;
  // 1. Prefer the caller's own KA (preserves today's self-publish exactly).
  if (callerAgentAddress) {
    const own = candidates.find((a) => knowledgeAssetAgentAddressesEqual(a, callerAgentAddress));
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
    { code: 'AMBIGUOUS_ASSERTION_AUTHOR', candidates: distinct },
  );
}
