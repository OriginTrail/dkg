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

/** Minimal structural view of the store this resolver needs. */
export interface AssertionAuthorQueryStore {
  query(sparql: string): Promise<{ type: string; quads?: ReadonlyArray<SealQuad> }>;
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
}

/**
 * GH#1778 — resolve the AUTHOR of a named, finalized assertion from the local
 * `_meta` graph, for a VM publish where the caller may not be the author (a
 * curator publishing a member-shared rootless KA). Kept in a focused module,
 * not the large publish mixin, so the store/URI/EVM lookup lives beside the
 * coordinate helpers it depends on.
 *
 * Resolution order:
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
  { contextGraphId, name, subGraphName, callerAgentAddress }: ResolveFinalizedAssertionAuthorParams,
): Promise<string | undefined> {
  if (!validateAssertionName(name).valid) return undefined;
  const metaGraph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  // Bound the query by the canonical assertion-coordinate grammar (the core
  // helper owns the URI layout; `name` cannot contain `/`, so the suffix cannot
  // cross a segment, and the prefix carries a slash-containing cg id verbatim).
  const { scope: expectedScope, prefix, suffix } = contextGraphAssertionQueryBounds(
    contextGraphId, name, subGraphName,
  );
  // Fetch the FULL `_meta` rows of every subject at this name coordinate that
  // carries a Merkle root, so each candidate can be validated against a complete
  // seal before it influences selection. `assertionMerkleRoot` alone is NOT
  // proof of a publishable assertion — durable `_meta` may hold stale/partial
  // rows or unauthenticated fragments, and counting those would either false-409
  // a legitimate publish or select an unusable author (GH#1778 review).
  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE {
      GRAPH <${metaGraph}> {
        ?s <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root .
        ?s ?p ?o .
        FILTER(STRSTARTS(STR(?s), "${escapeSparqlLiteral(prefix)}"))
        FILTER(STRENDS(STR(?s), "${escapeSparqlLiteral(suffix)}"))
      }
    }`,
  );
  const rowsBySubject = new Map<string, SealQuad[]>();
  if (result.type === 'quads') {
    for (const quad of result.quads ?? []) {
      const rows = rowsBySubject.get(quad.subject);
      if (rows) rows.push(quad);
      else rowsBySubject.set(quad.subject, [quad]);
    }
  }
  // Admit only subjects that are a complete, self-consistent graph-scoped seal —
  // the SAME canonical definition durable-sync uses (`parseGraphScopedAssertionSealCandidate`):
  // a partial/corrupt subject, or a complete seal whose `authorAddress`/`kaUal`
  // disagree with its `/assertion/<addr>/…` coordinate, is NOT a publish
  // candidate (it is treated as not-finalized rather than silently trusted).
  const candidates: string[] = [];
  for (const [subject, rows] of rowsBySubject) {
    const candidate = parseGraphScopedAssertionSealCandidate(rows, subject);
    if (!candidate
      || candidate.coordinate.scope !== expectedScope
      || candidate.coordinate.name !== name) continue;
    candidates.push(candidate.coordinate.agentAddress);
  }
  if (candidates.length === 0) return undefined;
  // 1. Prefer the caller's own KA (preserves today's self-publish exactly).
  if (callerAgentAddress) {
    const own = candidates.find((a) => knowledgeAssetAgentAddressesEqual(a, callerAgentAddress));
    if (own) return own;
  }
  // Distinct authors, case-insensitive (guards the known mixed-case _meta hazard).
  const distinct: string[] = [];
  for (const author of candidates) {
    if (!distinct.some((a) => knowledgeAssetAgentAddressesEqual(a, author))) distinct.push(author);
  }
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
