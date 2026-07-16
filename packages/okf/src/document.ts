/**
 * OKF concept document parsing — the frontmatter/body split.
 *
 * This mirrors the reference agent's `OKFDocument.parse`
 * (`okf/src/reference_agent/bundle/document.py`) byte-for-byte in behaviour so
 * our IRIs, triples and round-trips agree with the canonical producer:
 *
 *   - frontmatter is delimited by `---` on its own line at the very start and a
 *     closing `---` on its own line; matching is on the *stripped* line, so a
 *     `---` with trailing whitespace still closes the block;
 *   - a file with no leading `---` is treated as all-body (this is how
 *     `index.md` / `log.md` parse cleanly — they carry no frontmatter, §6/§7);
 *   - exactly one leading newline is stripped from the body.
 *
 * NOTE on requiredness: the reference *producer* enforces four keys
 * (`REQUIRED_FRONTMATTER_KEYS = ("type","title","description","timestamp")`),
 * but SPEC §9 binds *consumers* to require only a non-empty `type`. We are a
 * consumer: parsing never enforces the producer's four keys. `validation.ts`
 * applies the §9 consumer rule.
 */

import { load as loadYaml } from 'js-yaml';
import type { OkfDocument } from './types.js';
import { pathToConceptId } from './paths.js';

const DELIM = '---';

export class OkfDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OkfDocumentError';
  }
}

/** Python `str.splitlines()` semantics: split on \r\n, \r, or \n. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * Parse a concept file's raw text into `{ conceptId, segments, frontmatter, body }`.
 * `bundlePath` is the bundle-relative POSIX path (e.g. `tables/blocks.md`).
 */
export function parseDocument(bundlePath: string, text: string): OkfDocument {
  const conceptId = pathToConceptId(bundlePath);
  const segments = conceptId.split('/');

  const lines = splitLines(text);
  if (lines.length === 0 || lines[0].trim() !== DELIM) {
    // No frontmatter block — entire file is body.
    return { conceptId, segments, frontmatter: {}, body: text };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new OkfDocumentError(`Unterminated YAML frontmatter block in ${bundlePath}`);
  }

  const fmText = lines.slice(1, endIdx).join('\n');
  let parsed: unknown;
  try {
    parsed = loadYaml(fmText) ?? {};
  } catch (err) {
    throw new OkfDocumentError(
      `Invalid YAML frontmatter in ${bundlePath}: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OkfDocumentError(`Frontmatter must be a YAML mapping in ${bundlePath}`);
  }

  let body = lines.slice(endIdx + 1).join('\n');
  if (body.startsWith('\n')) body = body.slice(1);

  return { conceptId, segments, frontmatter: parsed as Record<string, unknown>, body };
}
