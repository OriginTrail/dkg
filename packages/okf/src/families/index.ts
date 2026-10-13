/**
 * OKF v0.2 frontmatter families (SPEC §5, §7, §10): the definitions
 * (`specs.ts`), the entry classification (`parse.ts`), the RDF encoding
 * (`encode.ts`) and its inverse (`decode.ts`), and the shape diagnostics
 * (`diagnostics.ts`).
 */

import { genericQuads, type PathContext } from '../terms.js';
import { encodeFamily, type FamilyResult } from './encode.js';
import { FAMILY_BY_KEY } from './specs.js';

export * from './specs.js';
export { parseList, type ParsedEntry, type ParsedList } from './parse.js';
export { encodeFamily, type FamilyResult } from './encode.js';
export { decodeFamilies } from './decode.js';
export { familyDiagnostics, sourceIds, declaresSources } from './diagnostics.js';

/** Map the frontmatter value of the family `key` onto the concept `iri`; an unknown key is a producer key. */
export function familyQuads(iri: string, key: string, value: unknown, ctx: PathContext): FamilyResult {
  const spec = FAMILY_BY_KEY.get(key);
  if (!spec) return { quads: genericQuads(iri, key, value), derivedFromConcepts: [], warnings: [] };
  return encodeFamily(iri, spec, value, ctx);
}
