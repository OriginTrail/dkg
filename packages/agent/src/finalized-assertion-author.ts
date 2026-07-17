import {
  ASSERTION_SEAL_PREDICATES,
  assertSafeIri,
  contextGraphMetaUri,
  escapeSparqlLiteral,
  knowledgeAssetAgentAddressesEqual,
  parseContextGraphAssertionUri,
  validateAssertionName,
} from '@origintrail-official/dkg-core';

/** Minimal structural view of the store this resolver needs. */
export interface AssertionAuthorQueryStore {
  query(sparql: string): Promise<{ type: string; bindings?: ReadonlyArray<Record<string, string>> }>;
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
  // The seal subject is the author's own assertion coordinate. Bracket the
  // author segment with an exact prefix + `/<name>` suffix; `name` cannot
  // contain `/` (validateAssertionName), so STRENDS cannot cross a segment. The
  // prefix carries the full contextGraphId verbatim, so a slash-containing cg id
  // is matched correctly server-side.
  const prefix = subGraphName
    ? `did:dkg:context-graph:${contextGraphId}/${subGraphName}/assertion/`
    : `did:dkg:context-graph:${contextGraphId}/assertion/`;
  const suffix = `/${name}`;
  const result = await store.query(
    `SELECT DISTINCT ?s WHERE {
      GRAPH <${metaGraph}> {
        ?s <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root .
        FILTER(STRSTARTS(STR(?s), "${escapeSparqlLiteral(prefix)}"))
        FILTER(STRENDS(STR(?s), "${escapeSparqlLiteral(suffix)}"))
      }
    }`,
  );
  const subjects = result.type === 'bindings'
    ? (result.bindings ?? []).map((b) => b.s).filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  // Map each seal subject back to its exact-case author segment via the shared
  // core parser, re-validating scope/name. `scope` is compared as a whole so a
  // slash-containing contextGraphId is preserved (the parser cannot split cg
  // from subGraph, and must not try).
  const expectedScope = subGraphName ? `${contextGraphId}/${subGraphName}` : contextGraphId;
  const candidates: string[] = [];
  for (const subject of subjects) {
    const coord = parseContextGraphAssertionUri(subject);
    if (!coord || coord.scope !== expectedScope || coord.name !== name) continue;
    candidates.push(coord.agentAddress);
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
