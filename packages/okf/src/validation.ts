/**
 * OKF §9 conformance validation — deliberately permissive.
 *
 * A bundle is conformant iff:
 *   1. every non-reserved `.md` has a parseable YAML frontmatter block;
 *   2. every frontmatter has a non-empty `type`;
 *   3. reserved files (`index.md`/`log.md`) follow §6/§7 when present.
 *
 * Consumers MUST NOT reject a bundle for: missing optional fields, unknown
 * `type` values, unknown extra keys, broken cross-links, or missing `index.md`.
 * Those are surfaced as `warnings`, never `errors`. Only rules 1 and 2 produce
 * hard errors; reserved-file structure issues are reported as warnings to keep
 * the consumer lenient (see ADR 0005 / CONTEXT.md).
 */

import { parseDocument, OkfDocumentError } from './document.js';
import { isConceptFile, isReservedFile, basename, pathToConceptId } from './paths.js';
import type { BundleFile, ConformanceReport } from './types.js';

export function validateBundle(files: BundleFile[]): ConformanceReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let conceptCount = 0;
  let hasRootIndex = false;

  for (const f of ordered) {
    if (isReservedFile(f.path)) {
      const name = basename(f.path);
      const isRootIndex = f.path === 'index.md';
      if (isRootIndex) hasRootIndex = true;
      // Reserved files carry no frontmatter, except the bundle-root index.md may
      // declare only `okf_version` (§6, §11).
      try {
        const parsed = parseDocument(f.path, f.content);
        const keys = Object.keys(parsed.frontmatter);
        if (keys.length > 0) {
          if (name === 'index.md' && isRootIndex) {
            const extra = keys.filter((k) => k !== 'okf_version');
            if (extra.length > 0) {
              warnings.push(
                `root index.md declares frontmatter keys other than okf_version: ${extra.join(', ')} (§11)`,
              );
            }
          } else {
            warnings.push(`reserved file ${f.path} carries frontmatter (§6/§7 expect none)`);
          }
        }
      } catch (err) {
        warnings.push(
          `reserved file ${f.path} did not parse: ${err instanceof OkfDocumentError ? err.message : String(err)}`,
        );
      }
      continue;
    }

    if (!isConceptFile(f.path)) continue; // non-.md assets (viz.html, etc.) are out of scope
    conceptCount += 1;

    const conceptId = pathToConceptId(f.path);
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseDocument(f.path, f.content).frontmatter;
    } catch (err) {
      errors.push(
        `${conceptId}: ${err instanceof OkfDocumentError ? err.message : String(err)} (§9 rule 1)`,
      );
      continue;
    }
    const type = frontmatter.type;
    if (type === undefined || type === null || String(type).trim() === '') {
      errors.push(`${conceptId}: frontmatter has no non-empty \`type\` (§9 rule 2)`);
    }
  }

  if (conceptCount === 0) warnings.push('bundle contains no concept documents');
  if (!hasRootIndex) warnings.push('bundle has no root index.md (permitted — §9)');

  return { conformant: errors.length === 0, errors, warnings };
}
