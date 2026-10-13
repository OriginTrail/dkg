/**
 * OKF §11 conformance validation — deliberately permissive.
 *
 * A bundle is conformant iff:
 *   1. every non-reserved `.md` has a parseable YAML frontmatter block;
 *   2. every frontmatter has a non-empty `type`;
 *   3. reserved files (`index.md`/`log.md`) follow §8/§9 when present.
 *
 * Consumers MUST NOT reject a bundle for: missing optional fields, unknown
 * `type` values, unknown extra keys, broken cross-links, or missing `index.md`.
 * Those are surfaced as `warnings`, never `errors`. Only rules 1 and 2 produce
 * hard errors; reserved-file structure issues are reported as warnings to keep
 * the consumer lenient (see ADR 0005 / CONTEXT.md).
 *
 * The v0.2 provenance / trust / lifecycle / attestation families (§5, §10) are
 * SHOULD-level producer rules: a malformed family is reported as a warning
 * (what was wrong, and that it was kept or skipped), never as an error (§11).
 */

import { parseDocument, OkfDocumentError } from './document.js';
import { familyDiagnostics } from './families.js';
import { isConceptFile, isReservedFile, isValidSegment, basename, pathToConceptId } from './paths.js';
import { OKF_KNOWN_VERSIONS, OKF_TARGET_VERSION } from './constants.js';
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
      // declare only `okf_version` (§8, §12).
      try {
        const parsed = parseDocument(f.path, f.content);
        const keys = Object.keys(parsed.frontmatter);
        if (keys.length > 0) {
          if (name === 'index.md' && isRootIndex) {
            const extra = keys.filter((k) => k !== 'okf_version');
            if (extra.length > 0) {
              warnings.push(
                `root index.md declares frontmatter keys other than okf_version: ${extra.join(', ')} (§12)`,
              );
            }
            const v = parsed.frontmatter.okf_version;
            if (v !== undefined && v !== null && !(OKF_KNOWN_VERSIONS as readonly string[]).includes(String(v))) {
              warnings.push(
                `root index.md declares okf_version "${String(v)}"; this consumer targets OKF ${OKF_TARGET_VERSION} and consumes the bundle best-effort (§12)`,
              );
            }
          } else {
            warnings.push(`reserved file ${f.path} carries frontmatter (§8/§9 expect none)`);
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
    // Every concept path segment must be a valid OKF segment, or the derived subject
    // IRI (`${iriBase}${conceptId}`) is malformed (e.g. `urn:okf:bad name`). The
    // mapper already enforces this for link targets; enforce it for concept files too.
    if (!conceptId.split('/').every(isValidSegment)) {
      errors.push(`${conceptId}: invalid concept path segment(s) — must match [A-Za-z0-9_][A-Za-z0-9_.-]* (§2)`);
    }
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = parseDocument(f.path, f.content).frontmatter;
    } catch (err) {
      errors.push(
        `${conceptId}: ${err instanceof OkfDocumentError ? err.message : String(err)} (§11 rule 1)`,
      );
      continue;
    }
    const type = frontmatter.type;
    if (type === undefined || type === null || String(type).trim() === '') {
      errors.push(`${conceptId}: frontmatter has no non-empty \`type\` (§11 rule 2)`);
    }
    for (const d of familyDiagnostics(frontmatter)) warnings.push(`${conceptId}: ${d.message}`);
  }

  if (conceptCount === 0) warnings.push('bundle contains no concept documents');
  if (!hasRootIndex) warnings.push('bundle has no root index.md (permitted — §11)');

  return { conformant: errors.length === 0, errors, warnings };
}
