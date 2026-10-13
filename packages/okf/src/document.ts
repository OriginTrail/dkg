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

import * as jsYaml from 'js-yaml';
import type { OkfDocument } from './types.js';
import { pathToConceptId } from './paths.js';
import { dateTimeLexical, isXsdDate, isXsdDateTime } from './timestamps.js';
import { withYamlLexical, yamlLexicalOf } from './yaml-lexical.js';

/** js-yaml's built-in timestamp type (exported at runtime, absent from its type declarations). */
const BUILTIN_TIMESTAMP = (jsYaml as unknown as {
  types: { timestamp: { resolve(data: string): boolean; construct(data: string): Date } };
}).types.timestamp;

/**
 * The YAML timestamp type, validated before conversion. js-yaml's own type
 * builds a `Date` through `Date.UTC`, which rolls an impossible `2026-02-30`
 * over to March 2 and reads an offset-less value as UTC, before any check can
 * see the producer's text. Here an unquoted timestamp whose text is not a
 * valid xsd:dateTime / xsd:date stays the string it was — exactly what the
 * quoted form gives — and a valid one becomes a `Date` that carries its
 * original text (`yaml-lexical.ts`), so offset-less and date-only values are
 * diagnosed and typed the same quoted or not. Valid values with an offset keep
 * their usual UTC canonical form.
 */
function constructTimestamp(data: string): Date | string {
  return isXsdDateTime(data) || isXsdDate(data) ? withYamlLexical(BUILTIN_TIMESTAMP.construct(data), data) : data;
}

const OKF_TIMESTAMP = new jsYaml.Type('tag:yaml.org,2002:timestamp', {
  kind: 'scalar',
  resolve: (data: string) => BUILTIN_TIMESTAMP.resolve(data),
  construct: constructTimestamp,
  instanceOf: Date,
  // Written unquoted, as the text it carries (a value read from RDF carries
  // its stored lexical), else in canonical form.
  represent: (date: object) => yamlLexicalOf(date) ?? dateTimeLexical(date) ?? (date as Date).toISOString(),
});

/**
 * js-yaml's default schema with the validated timestamp type in place of the
 * built-in one, for reading frontmatter and for writing it on export.
 */
export const OKF_YAML_SCHEMA = jsYaml.DEFAULT_SCHEMA.extend({ implicit: [OKF_TIMESTAMP] });

/**
 * What the unquoted YAML scalar `text` reads as when it is a timestamp: a
 * `Date` carrying `text`, as `parseDocument` builds it, or `null` when YAML
 * would read it as anything else.
 */
export function yamlTimestamp(text: string): Date | null {
  if (!BUILTIN_TIMESTAMP.resolve(text)) return null;
  const value = constructTimestamp(text);
  return value instanceof Date ? value : null;
}

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
    parsed = jsYaml.load(fmText, { schema: OKF_YAML_SCHEMA }) ?? {};
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
