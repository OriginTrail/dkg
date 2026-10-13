/**
 * OKF v0.2 frontmatter families (SPEC §5, §7, §10): the definitions
 * (`specs.ts`), the entry classification (`parse.ts`), the RDF encoding
 * (`encode.ts`) and its inverse (`decode.ts`), and the shape diagnostics
 * (`diagnostics.ts`).
 */

import { genericQuads, type PathContext } from '../terms.js';
import { prepareFamily, resolveReferences, type FamilyResult, type PreparedQuad } from './encode.js';
import { FAMILY_BY_KEY } from './specs.js';

export * from './specs.js';
export { parseList, type ParsedEntry, type ParsedList } from './parse.js';
export { prepareFamily, resolveReferences, type FamilyResult, type PathReference, type PreparedQuad } from './encode.js';
export { decodeFamilies } from './decode.js';
export { familyDiagnostics, sourceIds, declaresSources } from './diagnostics.js';

/**
 * The frontmatter value of the family `key` as quads on the concept `iri`,
 * path-valued fields left as references for `resolveReferences`; an unknown
 * key is a producer key.
 */
export function prepareFamilyQuads(iri: string, conceptId: string, key: string, value: unknown): PreparedQuad[] {
  const spec = FAMILY_BY_KEY.get(key);
  return spec ? prepareFamily(iri, conceptId, spec, value) : genericQuads(iri, key, value);
}

/** Map the frontmatter value of the family `key` onto the concept `iri`; an unknown key is a producer key. */
export function familyQuads(iri: string, key: string, value: unknown, ctx: PathContext): FamilyResult {
  return resolveReferences(iri, prepareFamilyQuads(iri, ctx.conceptId, key, value), ctx);
}
