/**
 * A concept's Markdown body, stored verbatim, so export writes back the prose
 * as it was written instead of regenerating a body from the graph.
 *
 * The body is stored in ordered parts, the node's own pattern for long text
 * (`docs/use-dkg/large-content.md`): each part is an `okf:BodyPart` node
 * (`<concept>/.well-known/genid/okfbody_<id>_<n>`, linked from the concept by
 * `okf:bodyPart`) holding its slice of the body on `schema:text` and its index,
 * from 0, on `schema:position`, and the concept holds the number of parts on
 * `okf:bodyPartCount` (0 for an empty body), so a reader can tell a complete
 * body from a partial one. The node refuses any literal over 60,000 bytes,
 * measured on the serialized term in Java modified UTF-8; a part's term stays
 * within half that, leaving room for serialization as the guide advises, and
 * a part never ends inside a surrogate pair, so the parts, concatenated in
 * position order, are the body exactly. The split depends on the body alone:
 * the same body always mints the same parts.
 *
 * The body is the text `parseDocument` reads: line endings normalised to
 * `\n`, the one newline after the frontmatter dropped.
 */

import {
  GENID_TAGS,
  OKF_BODY_PART,
  OKF_BODY_PART_COUNT,
  OKF_CLASS_BODY_PART,
  RDF_TYPE,
  SCHEMA_POSITION,
  SCHEMA_TEXT,
  SECTION_GENID_INFIX,
  XSD_INTEGER,
} from './constants.js';
import { literalDatatype, literalValue } from './decode-terms.js';
import { literalTerm, sanitizeForBlank, typedLiteralTerm } from './utils.js';
import type { Quad } from './types.js';

/** The largest serialized term a part is written as: half the node's 60,000-byte literal limit. */
export const BODY_PART_MAX_BYTES = 30_000;

/** Bytes the two quotes of a plain literal term add. */
const QUOTE_BYTES = 2;

/**
 * Java modified UTF-8 length, by UTF-16 code unit, as the node measures a
 * literal term (`javaModifiedUtf8ByteLength` in `dkg-core`, which this package
 * does not import): U+0000 is 2 bytes, U+0001–U+007F 1, U+0080–U+07FF 2, and
 * every other code unit, a surrogate included, 3.
 */
export function modifiedUtf8Length(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    bytes += code === 0 ? 2 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}

/** The node's measure of `text` written as a plain literal term, escapes and quotes included. */
function termBytes(text: string): number {
  return modifiedUtf8Length(literalTerm(text));
}

/**
 * The body in parts, each written as a term of at most `maxBytes` (a
 * character the term of which alone is larger takes a part of its own), split
 * on code points, so a surrogate pair is never divided. An empty body has no
 * parts. The escaping is per character, so a part's term is the quotes plus
 * what each of its characters adds.
 */
export function splitBody(body: string, maxBytes: number = BODY_PART_MAX_BYTES): string[] {
  if (body === '') return [];
  if (termBytes(body) <= maxBytes) return [body];
  const parts: string[] = [];
  let start = 0;
  let bytes = QUOTE_BYTES;
  for (let i = 0; i < body.length; ) {
    const width = body.codePointAt(i)! > 0xffff ? 2 : 1;
    const added = termBytes(body.slice(i, i + width)) - QUOTE_BYTES;
    if (bytes + added > maxBytes && i > start) {
      parts.push(body.slice(start, i));
      start = i;
      bytes = QUOTE_BYTES;
    }
    bytes += added;
    i += width;
  }
  parts.push(body.slice(start));
  return parts;
}

function integerTerm(value: number): string {
  return typedLiteralTerm(String(value), XSD_INTEGER);
}

/** The quads that store a concept's body: its part count, and each part's node. */
export function bodyQuads(iri: string, conceptId: string, body: string): Quad[] {
  const parts = splitBody(body);
  const quads: Quad[] = [{ subject: iri, predicate: OKF_BODY_PART_COUNT, object: integerTerm(parts.length) }];
  parts.forEach((text, n) => {
    const node = `${iri}${SECTION_GENID_INFIX}${GENID_TAGS.body}${sanitizeForBlank(conceptId)}_${n}`;
    quads.push(
      { subject: iri, predicate: OKF_BODY_PART, object: node },
      { subject: node, predicate: RDF_TYPE, object: OKF_CLASS_BODY_PART },
      { subject: node, predicate: SCHEMA_POSITION, object: integerTerm(n) },
      { subject: node, predicate: SCHEMA_TEXT, object: literalTerm(text) },
    );
  });
  return quads;
}

/** A non-negative `xsd:integer` of at most 15 digits (a safe integer), or `null` for any other term. */
function indexOf(term: string): number | null {
  const lexical = literalDatatype(term) === XSD_INTEGER ? literalValue(term) : null;
  return lexical !== null && /^\+?[0-9]{1,15}$/.test(lexical) ? Number(lexical) : null;
}

/**
 * The body a concept's quads store, or `null` when they hold no complete
 * body: no part count (a graph imported before bodies were stored), or parts
 * that do not add up to it — not one count, a part without exactly one
 * position and one text, positions that are not each of 0 to count − 1 once
 * (a part missing or repeated, or the parts of two different bodies).
 * `conceptQuads` are the concept's distinct triples; `nodeQuads` returns a
 * part node's.
 */
export function storedBody(conceptQuads: readonly Quad[], nodeQuads: (node: string) => readonly Quad[]): string | null {
  const counts = conceptQuads.filter((q) => q.predicate === OKF_BODY_PART_COUNT);
  const count = counts.length === 1 ? indexOf(counts[0].object) : null;
  const nodes = conceptQuads.filter((q) => q.predicate === OKF_BODY_PART).map((q) => q.object);
  if (count === null || nodes.length !== count) return null;
  const parts: Array<[number, string]> = [];
  for (const node of nodes) {
    const quads = nodeQuads(node);
    const positions = quads.filter((q) => q.predicate === SCHEMA_POSITION);
    const slices = quads.filter((q) => q.predicate === SCHEMA_TEXT);
    if (positions.length !== 1 || slices.length !== 1) return null;
    const position = indexOf(positions[0].object);
    const text = literalValue(slices[0].object);
    if (position === null || text === null) return null;
    parts.push([position, text]);
  }
  parts.sort(([a], [b]) => a - b);
  return parts.every(([position], n) => position === n) ? parts.map(([, text]) => text).join('') : null;
}
